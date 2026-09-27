use super::{
    catalog_mutex, current_config, index_mutex, play_skip, playlist_mutex, publish,
    remember_progress, set_current_id, set_status, status_mutex, write_status_file, PLAYING_JOB,
    PLAY_STOP, STOP, WORKER_RUNNING,
};
use std::path::Path;
use std::sync::atomic::Ordering;

use kpodd::lock_status;
use kpodd::playback;
use kpodd::status;
use kpodd::sync::{self, log_line};
use kpodd::LOG_PATH;

pub(crate) enum Job {
    /// Fetch OPML feeds, auto-queue latest, download queued files.
    Sync,
    /// Re-read OPML + rebuild views; no downloads.
    Refresh,
    /// Stream one episode (then auto-advance) to the audio sink.
    Play(String),
    /// Download one queued episode.
    Download(String),
}

pub(super) fn start_job(job: Job) {
    if WORKER_RUNNING.swap(true, Ordering::SeqCst) {
        set_status(|s| {
            s.state = status::STATE_ERROR.to_string();
            s.last_error = Some("a sync or play is already running".to_string());
        });
        return;
    }
    STOP.store(false, Ordering::SeqCst);
    std::thread::spawn(move || run_job(job));
}

pub(super) fn request_play(id: String) {
    let same = lock_status(status_mutex()).current_id == id;
    if !same {
        let saved = playlist_mutex()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .progress_of(&id);
        set_status(|s| {
            s.play_position = saved;
        });
    }
    if PLAYING_JOB.load(Ordering::SeqCst) {
        let already = same;
        if already {
            return;
        }
        set_current_id(&id);
        publish();
        *play_skip() = Some(id);
        playback::request_stop(&PLAY_STOP);
        return;
    }
    if WORKER_RUNNING.load(Ordering::SeqCst) {
        set_status(|s| {
            s.last_error = Some("busy - stop sync before playing".to_string());
        });
        return;
    }
    set_current_id(&id);
    publish();
    start_job(Job::Play(id));
}

fn run_job(job: Job) {
    let on_update = || write_status_file();
    let log_path = Path::new(LOG_PATH);
    match job {
        Job::Sync => {
            log_line(log_path, "sync start");
            set_status(|s| {
                s.state = status::STATE_RUNNING.to_string();
                s.started_at = Some(kpodd::now_epoch());
            });
            sync::run_sync(
                index_mutex(),
                catalog_mutex(),
                playlist_mutex(),
                &current_config(),
                &STOP,
                status_mutex(),
                log_path,
                &on_update,
                &|id| super::prefetch_transcript(id),
            );
            if STOP.load(Ordering::SeqCst) {
                log_line(log_path, "sync stopped by user");
            }
        }
        Job::Refresh => {
            log_line(log_path, "refresh start");
            sync::run_refresh(
                index_mutex(),
                catalog_mutex(),
                playlist_mutex(),
                &current_config(),
                status_mutex(),
                log_path,
                &on_update,
            );
        }
        Job::Download(id) => {
            log_line(log_path, &format!("download: {}", id));
            let cat = catalog_mutex()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            match sync::download_one(
                index_mutex(),
                &cat,
                &id,
                status_mutex(),
                log_path,
                &on_update,
                None,
            ) {
                Ok(_) => {}
                Err(e) => set_status(|s| {
                    s.last_error = Some(e);
                }),
            }
            publish();
        }
        Job::Play(start_id) => {
            PLAYING_JOB.store(true, Ordering::SeqCst);
            let mut id = start_id;
            loop {
                *play_skip() = None;
                PLAY_STOP.store(false, Ordering::SeqCst);
                set_current_id(&id);
                let cat = catalog_mutex()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                let idx = index_mutex()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                let Some((title, file, path)) = sync::find_playable(&cat, &idx, &id) else {
                    set_status(|s| {
                        s.last_error = Some(format!("episode not found: {}", id));
                    });
                    break;
                };
                if !file.to_ascii_lowercase().ends_with(".mp3") {
                    set_status(|s| {
                        s.last_error = Some(format!(
                            "cannot play {}: only mp3 episodes are playable on-device",
                            title
                        ));
                    });
                    log_line(log_path, &format!("play rejected (non-mp3): {}", title));
                    break;
                }
                if !path.is_file() {
                    // Download then play (same worker).
                    log_line(log_path, &format!("play download: {} ({})", title, id));
                    match sync::download_one(
                        index_mutex(),
                        &cat,
                        &id,
                        status_mutex(),
                        log_path,
                        &on_update,
                        Some(&PLAY_STOP),
                    ) {
                        Ok(_) => {}
                        Err(e) => {
                            set_status(|s| {
                                s.last_error = Some(e);
                            });
                            break;
                        }
                    }
                    if !path.is_file() {
                        set_status(|s| {
                            s.last_error = Some(format!("could not download {}", title));
                        });
                        break;
                    }
                }
                log_line(log_path, &format!("play start: {} ({})", title, id));
                let mut start = lock_status(status_mutex()).play_position;
                loop {
                    set_status(|s| {
                        s.current = title.clone();
                        s.current_id = id.clone();
                        s.last_error = None;
                        s.play_position = start;
                        s.state = status::STATE_RUNNING.to_string();
                    });
                    publish();
                    let on_play = || {
                        write_status_file();
                        remember_progress(false);
                    };
                    match playback::play_file(
                        &path,
                        start,
                        &PLAY_STOP,
                        status_mutex(),
                        log_path,
                        &on_play,
                    ) {
                        Ok(playback::PlayEnd::Seek(at)) => {
                            start = at;
                            remember_progress(true);
                            continue;
                        }
                        Ok(playback::PlayEnd::Stopped) => {
                            remember_progress(true);
                            break;
                        }
                        Ok(playback::PlayEnd::Finished) => {
                            // Pause kills the sink, which can look like end-of-stream.
                            if PLAY_STOP.load(Ordering::SeqCst) {
                                remember_progress(true);
                                break;
                            }
                            set_status(|s| {
                                s.play_position = 0;
                            });
                            remember_progress(true);
                            break;
                        }
                        Err(err) => {
                            set_status(|s| {
                                s.last_error = Some(err.clone());
                            });
                            log_line(log_path, &format!("playback error: {}", err));
                            break;
                        }
                    }
                }
                if PLAY_STOP.load(Ordering::SeqCst) {
                    break;
                }
                if let Some(skip) = play_skip().take() {
                    id = skip;
                    let saved = playlist_mutex()
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .progress_of(&id);
                    set_status(|s| {
                        s.play_position = saved;
                    });
                    continue;
                }
                // Natural end: advance.
                let next = {
                    let pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
                    pl.neighbor(&id, 1)
                };
                match next {
                    Some(n) => {
                        id = n;
                        let saved = playlist_mutex()
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .progress_of(&id);
                        set_status(|s| {
                            s.play_position = saved;
                        });
                    }
                    None => break,
                }
            }
            PLAYING_JOB.store(false, Ordering::SeqCst);
        }
    }
    STOP.store(false, Ordering::SeqCst);
    WORKER_RUNNING.store(false, Ordering::SeqCst);
    set_status(|s| {
        s.phase = status::PHASE_DONE.to_string();
        if s.state != status::STATE_ERROR {
            s.state = status::STATE_DONE.to_string();
        }
        s.finished_at = Some(kpodd::now_epoch());
    });
    log_line(log_path, "task end");
}
