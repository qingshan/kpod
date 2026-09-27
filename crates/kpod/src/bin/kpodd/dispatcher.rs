use super::worker::{request_play, start_job, Job};
use super::{
    catalog_mutex, index_mutex, neighbor_id, persist_playlist_locked, play_skip, playlist_mutex,
    publish, resolve_play_id, set_status, PLAY_STOP, STOP, WORKER_RUNNING,
};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::time::Duration;

use kpodd::command::Op;
use kpodd::config;
use kpodd::opml::{self, SubscribeResult};
use kpodd::playback;
use kpodd::status::{self, FeedSummary, LibraryShow};
use kpodd::sync::{self, log_line};
use kpodd::{http, library, transcript, CONFIG_PATH, LOG_PATH, SUBSCRIPTIONS_OPML};

/// How long to wait before asking again while the transcript service is still working.
const TRANSCRIPT_POLL: Duration = Duration::from_secs(20);
/// Bumped on every transcript open so a previous wait stops.
static TRANSCRIPT_GEN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn dispatch(rx: Receiver<Op>) {
    for op in rx {
        match op {
            Op::SyncNow => start_job(Job::Sync),
            Op::Refresh => start_job(Job::Refresh),
            Op::SyncStop => {
                STOP.store(true, Ordering::SeqCst);
                set_status(|s| {
                    s.state = status::STATE_STOPPING.to_string();
                });
                log_line(Path::new(LOG_PATH), "stop requested");
            }
            Op::ConfigSet { max_episodes } => {
                let mut cfg = config::load(Path::new(CONFIG_PATH));
                cfg.max_episodes = max_episodes.clamp(1, 1000);
                match config::save(Path::new(CONFIG_PATH), &cfg) {
                    Ok(()) => {
                        set_status(|s| {
                            s.max_episodes = cfg.max_episodes;
                        });
                        log_line(
                            Path::new(LOG_PATH),
                            &format!("max episodes set to {}", cfg.max_episodes),
                        );
                        start_job(Job::Refresh);
                    }
                    Err(e) => set_status(|s| {
                        s.last_error = Some(format!("could not save config: {}", e));
                    }),
                }
            }
            Op::ExploreQuery {
                query,
                feed,
                offset,
            } => {
                set_status(|s| {
                    s.explore.query = query;
                    s.explore.feed = feed;
                    s.explore.offset = offset;
                    s.last_error = None;
                });
                publish();
            }
            Op::PlaylistAdd { id } => {
                if id.is_empty() {
                    set_status(|s| {
                        s.last_error = Some("playlist_add needs an episode id".to_string());
                    });
                    continue;
                }
                let added = {
                    let mut pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
                    pl.add(&id)
                };
                persist_playlist_locked();
                publish();
                if added {
                    super::prefetch_transcript(&id);
                }
                let already_on_disk = {
                    let idx = index_mutex().lock().unwrap_or_else(|p| p.into_inner());
                    idx.iter().any(|e| e.id == id)
                };
                if added && !already_on_disk && !WORKER_RUNNING.load(Ordering::SeqCst) {
                    start_job(Job::Download(id));
                }
                log_line(Path::new(LOG_PATH), "playlist add");
            }
            Op::PlaylistMove { id, dir } => {
                {
                    let mut pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
                    pl.move_by(&id, dir);
                }
                persist_playlist_locked();
                publish();
                log_line(Path::new(LOG_PATH), "playlist move");
            }
            Op::PlaylistRemove { id } => {
                {
                    let mut pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
                    pl.remove(&id);
                }
                persist_playlist_locked();
                publish();
                log_line(Path::new(LOG_PATH), "playlist remove");
            }
            Op::TranscriptOpen { id } => {
                let source = {
                    let cat = catalog_mutex().lock().unwrap_or_else(|p| p.into_inner());
                    cat.iter().find(|e| e.id == id).map(|e| {
                        (
                            e.transcript_url.clone(),
                            e.transcript_type.clone(),
                            e.url.clone(),
                        )
                    })
                };
                let api = super::current_config().transcript_api;
                let request = match source {
                    Some((Some(url), Some(kind), _))
                        if url.starts_with("https://") || url.starts_with("http://") =>
                    {
                        Some((url, Some(kind)))
                    }
                    Some((_, _, audio))
                        if !api.trim().is_empty()
                            && (audio.starts_with("https://") || audio.starts_with("http://")) =>
                    {
                        match transcript::api_request_url(api.trim(), &audio, &id) {
                            Ok(url) => Some((url, None)),
                            Err(error) => {
                                set_status(|s| {
                                    s.transcript.id = id.clone();
                                    s.transcript.state = "error".into();
                                    s.transcript.error = error;
                                });
                                None
                            }
                        }
                    }
                    _ => {
                        set_status(|s| {
                            s.transcript.id = id.clone();
                            s.transcript.state = "error".into();
                            s.transcript.text.clear();
                            s.transcript.error =
                                "No text transcript is available for this episode.".into();
                        });
                        None
                    }
                };
                if let Some((url, kind)) = request {
                    set_status(|s| {
                        s.transcript.id = id.clone();
                        s.transcript.state = "loading".into();
                        s.transcript.text.clear();
                        s.transcript.cues.clear();
                        s.transcript.error.clear();
                    });
                    let gen = TRANSCRIPT_GEN.fetch_add(1, Ordering::SeqCst) + 1;
                    let wait_until_ready = kind.is_none();
                    std::thread::spawn(move || {
                        let mut waits = 0u32;
                        loop {
                            if TRANSCRIPT_GEN.load(Ordering::SeqCst) != gen {
                                break;
                            }
                            let fetched = if wait_until_ready {
                                http::fetch_transcript(&url, transcript::MAX_BYTES)
                            } else {
                                http::fetch_limited(&url, transcript::MAX_BYTES)
                                    .map(http::TranscriptFetch::Ready)
                            };
                            if let Ok(http::TranscriptFetch::Pending(_)) = fetched {
                                waits += 1;
                                let keep =
                                    set_transcript_wait(&id, "Transcript is being prepared.");
                                if !keep || waits > 360 {
                                    if waits > 360 {
                                        set_status(|s| {
                                            if s.transcript.id != id {
                                                return;
                                            }
                                            s.transcript.state = "error".into();
                                            s.transcript.error =
                                                "Transcript is still being prepared.".into();
                                        });
                                    }
                                    break;
                                }
                                std::thread::sleep(TRANSCRIPT_POLL);
                                continue;
                            }
                            let result = fetched.and_then(|body| {
                                let http::TranscriptFetch::Ready(body) = body else {
                                    return Err("transcript is still being prepared".into());
                                };
                                let kind = kind
                                    .clone()
                                    .unwrap_or_else(|| transcript::sniff_kind(&body).to_string());
                                let text = transcript::format(&body, &kind)?;
                                let cues: Vec<kpodd::status::TranscriptCue> =
                                    transcript::cues(&body, &kind)
                                        .into_iter()
                                        .map(|cue| kpodd::status::TranscriptCue {
                                            start: cue.start,
                                            end: cue.end,
                                            text: cue.text,
                                        })
                                        .collect();
                                Ok((text, cues))
                            });
                            set_status(|s| {
                                if s.transcript.id != id {
                                    return;
                                }
                                match result {
                                    Ok((text, cues)) => match write_transcript_doc(&text, &cues) {
                                        Ok(()) => {
                                            s.transcript.state = "ready".into();
                                            s.transcript.text.clear();
                                            s.transcript.cues.clear();
                                            s.transcript.error.clear();
                                        }
                                        Err(error) => {
                                            s.transcript.state = "error".into();
                                            s.transcript.error = error;
                                            s.transcript.cues.clear();
                                        }
                                    },
                                    Err(error) => {
                                        s.transcript.state = "error".into();
                                        s.transcript.error = error;
                                        s.transcript.cues.clear();
                                    }
                                }
                            });
                            break;
                        }
                    });
                }
            }
            Op::PlayStart { id } => {
                match resolve_play_id(&id) {
                    Some(pid) => {
                        // Queue it if the user hit Play on an Explore row.
                        let added = {
                            let mut pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
                            pl.add(&pid)
                        };
                        persist_playlist_locked();
                        if added {
                            super::prefetch_transcript(&pid);
                        }
                        request_play(pid);
                    }
                    None => set_status(|s| {
                        s.last_error = Some("playlist is empty".to_string());
                    }),
                }
            }
            Op::PlayStop => {
                *play_skip() = None;
                set_status(|s| {
                    s.state = status::STATE_STOPPING.to_string();
                });
                playback::request_stop(&PLAY_STOP);
                log_line(Path::new(LOG_PATH), "playback stop requested");
            }
            Op::PlayNext => {
                if let Some(id) = neighbor_id(1) {
                    request_play(id);
                }
            }
            Op::PlayPrev => {
                if let Some(id) = neighbor_id(-1) {
                    request_play(id);
                }
            }
            Op::PlaySeek { delta } => seek_by(delta),
            Op::BtToggle => super::bluetooth::toggle(),
            Op::UiSet { compact } => {
                let mut cfg = config::load(Path::new(CONFIG_PATH));
                cfg.compact = compact;
                match config::save(Path::new(CONFIG_PATH), &cfg) {
                    Ok(()) => set_status(|s| {
                        s.compact = compact;
                    }),
                    Err(error) => set_status(|s| {
                        s.last_error = Some(format!("could not save config: {}", error));
                    }),
                }
            }
            Op::LibraryQuery { query } => search_library(query),
            Op::FeedAdd { url, title } => add_feed(&url, &title),
        }
    }
}

fn seek_by(delta: i64) {
    let (pos, dur, playing) = {
        let status = super::status_mutex();
        let st = kpodd::lock_status(&status);
        let dur = st
            .playlist
            .iter()
            .find(|item| item.id == st.current_id)
            .and_then(|item| item.duration)
            .unwrap_or(0);
        (st.play_position as i64, dur, st.playing)
    };
    let mut target = pos + delta;
    if target < 0 {
        target = 0;
    }
    if dur > 0 && target > dur as i64 {
        target = dur as i64;
    }
    let target = target as u64;
    if playing {
        kpodd::playback::request_seek(target);
    }
    set_status(|s| {
        s.play_position = target;
    });
    super::remember_progress(true);
}

fn set_transcript_wait(id: &str, message: &str) -> bool {
    let mut keep = false;
    set_status(|s| {
        if s.transcript.id != id {
            return;
        }
        s.transcript.state = "loading".into();
        s.transcript.error = message.to_string();
        keep = true;
    });
    keep
}

fn write_transcript_doc(text: &str, cues: &[kpodd::status::TranscriptCue]) -> Result<(), String> {
    let dir = Path::new(kpodd::STATUS_DIR);
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir transcript: {e}"))?;
    let path = dir.join("transcript.json");
    let tmp = dir.join("transcript.json.tmp");
    let payload = serde_json::json!({ "text": text, "cues": cues });
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("write transcript: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename transcript: {e}"))?;
    Ok(())
}

fn search_library(query: String) {
    let query = query.trim().to_string();
    if query.is_empty() {
        set_status(|s| {
            s.library.query.clear();
            s.library.state = "error".into();
            s.library.error = "Enter a show name or a feed URL.".into();
            s.library.items.clear();
        });
        return;
    }
    if query.chars().count() > 200 {
        set_status(|s| {
            s.library.state = "error".into();
            s.library.error = "Search is too long.".into();
            s.library.items.clear();
        });
        return;
    }
    if library::is_feed_url(&query) {
        set_status(|s| {
            let subscribed = s.feeds.iter().any(|f| f.url == query);
            s.library.query = query.clone();
            s.library.state = "ready".into();
            s.library.error.clear();
            s.library.items = vec![LibraryShow {
                title: library::title_from_url(&query),
                author: String::new(),
                url: query.clone(),
                subscribed,
            }];
        });
        return;
    }
    set_status(|s| {
        s.library.query = query.clone();
        s.library.state = "loading".into();
        s.library.error.clear();
        s.library.items.clear();
    });
    std::thread::spawn(move || {
        let result =
            http::fetch(&library::search_url(&query), Some("application/json")).and_then(|body| {
                let text = String::from_utf8(body)
                    .map_err(|_| "podcast library response was not text".to_string())?;
                library::parse_search(&text)
            });
        set_status(|s| {
            if s.library.query != query {
                return;
            }
            match result {
                Ok(hits) => {
                    let urls: Vec<String> = s.feeds.iter().map(|feed| feed.url.clone()).collect();
                    s.library.state = "ready".into();
                    s.library.error.clear();
                    s.library.items = hits
                        .into_iter()
                        .map(|hit| LibraryShow {
                            subscribed: urls.iter().any(|url| url == &hit.url),
                            title: hit.title,
                            author: hit.author,
                            url: hit.url,
                        })
                        .collect();
                }
                Err(error) => {
                    s.library.state = "error".into();
                    s.library.error = error;
                    s.library.items.clear();
                }
            }
        });
    });
}

fn add_feed(url: &str, title: &str) {
    match opml::add_subscription(Path::new(SUBSCRIPTIONS_OPML), title, url) {
        Ok(result) => {
            let runs = sync::load_feed_runs();
            set_status(|s| {
                let old = s.feeds.clone();
                s.feeds = runs
                    .iter()
                    .map(|feed| {
                        old.iter()
                            .find(|prev| prev.url == feed.spec.url)
                            .cloned()
                            .map(|mut prev| {
                                prev.id = feed.feed_id.clone();
                                prev.title = feed.title.clone();
                                prev.url = feed.spec.url.clone();
                                prev
                            })
                            .unwrap_or_else(|| FeedSummary {
                                id: feed.feed_id.clone(),
                                title: feed.title.clone(),
                                url: feed.spec.url.clone(),
                                episode_count: 0,
                                downloaded: 0,
                                last_sync_at: None,
                                last_error: None,
                            })
                    })
                    .collect();
                for item in &mut s.library.items {
                    item.subscribed = s.feeds.iter().any(|feed| feed.url == item.url);
                }
                if !s.feeds.is_empty() {
                    if s.last_error
                        .as_deref()
                        .is_some_and(|err| err.contains("no subscriptions"))
                    {
                        s.last_error = None;
                    }
                }
            });
            log_line(
                Path::new(LOG_PATH),
                match result {
                    SubscribeResult::Added => "feed added",
                    SubscribeResult::AlreadySubscribed => "feed already subscribed",
                },
            );
        }
        Err(error) => set_status(|s| {
            s.last_error = Some(error);
        }),
    }
}
