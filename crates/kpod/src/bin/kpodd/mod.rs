use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, OnceLock};

use kpodd::catalog::{self, CatalogEpisode};
use kpodd::config::{self, Config};
use kpodd::index::{self, IndexedEpisode};
use kpodd::playlist::{self, Playlist};
use kpodd::status::Status;
use kpodd::sync::{self, log_line};
use kpodd::{
    lock_status, mutate_status, CATALOG_PATH, CONFIG_PATH, INDEX_PATH, LOG_PATH, PLAYLIST_PATH,
    STATUS_DIR, STATUS_PATH,
};

mod bluetooth;
mod buttons;
mod dispatcher;
mod worker;

pub(super) use dispatcher::dispatch;

pub(super) fn spawn_buttons() {
    buttons::spawn();
}

pub(super) fn spawn_bluetooth() {
    bluetooth::spawn();
}

static WORKER_RUNNING: AtomicBool = AtomicBool::new(false);
static PLAYING_JOB: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static PLAY_STOP: AtomicBool = AtomicBool::new(false);
static PLAY_SKIP: Mutex<Option<String>> = Mutex::new(None);
static STATUS: OnceLock<Mutex<Status>> = OnceLock::new();
static INDEX: OnceLock<Mutex<Vec<IndexedEpisode>>> = OnceLock::new();
static CATALOG: OnceLock<Mutex<Vec<CatalogEpisode>>> = OnceLock::new();
static PLAYLIST: OnceLock<Mutex<Playlist>> = OnceLock::new();

fn status_mutex() -> &'static Mutex<Status> {
    STATUS.get_or_init(|| Mutex::new(Status::default()))
}

fn index_mutex() -> &'static Mutex<Vec<IndexedEpisode>> {
    INDEX.get_or_init(|| Mutex::new(index::load(Path::new(INDEX_PATH))))
}

fn catalog_mutex() -> &'static Mutex<Vec<CatalogEpisode>> {
    CATALOG.get_or_init(|| Mutex::new(catalog::load(Path::new(CATALOG_PATH))))
}

fn playlist_mutex() -> &'static Mutex<Playlist> {
    PLAYLIST.get_or_init(|| Mutex::new(playlist::load(Path::new(PLAYLIST_PATH))))
}

fn play_skip() -> std::sync::MutexGuard<'static, Option<String>> {
    PLAY_SKIP.lock().unwrap_or_else(|p| p.into_inner())
}

// --- status.json writer ----------------------------------------------------

fn write_status_file() {
    let json = lock_status(status_mutex()).to_json();
    let _ = std::fs::create_dir_all(STATUS_DIR);
    let tmp = format!("{}.tmp", STATUS_PATH);
    if std::fs::write(&tmp, &json).is_ok() {
        let _ = std::fs::rename(&tmp, STATUS_PATH);
    }
}

pub(super) fn set_status(f: impl FnOnce(&mut Status)) {
    let on_update = || write_status_file();
    mutate_status(status_mutex(), &on_update, f);
}

fn current_config() -> Config {
    config::load(Path::new(CONFIG_PATH))
}

/// Ask the transcript API to prepare an episode that has no feed transcript.
/// A miss only starts the remote job; it does not change the open transcript.
fn prefetch_transcript(id: &str) {
    let Some((audio, transcript_url)) = ({
        let cat = catalog_mutex().lock().unwrap_or_else(|p| p.into_inner());
        cat.iter()
            .find(|e| e.id == id)
            .map(|e| (e.url.clone(), e.transcript_url.clone()))
    }) else {
        return;
    };
    let api = current_config().transcript_api;
    if !kpodd::transcript::needs_api_transcript(&api, transcript_url.as_deref(), &audio) {
        return;
    }
    let url = match kpodd::transcript::api_request_url(api.trim(), &audio, id) {
        Ok(url) => url,
        Err(error) => {
            log_line(Path::new(LOG_PATH), &format!("transcript {id}: {error}"));
            return;
        }
    };
    let id = id.to_string();
    std::thread::spawn(move || {
        let note = match kpodd::http::fetch_transcript(&url, kpodd::transcript::MAX_BYTES) {
            Ok(kpodd::http::TranscriptFetch::Ready(_)) => format!("transcript ready {id}"),
            Ok(kpodd::http::TranscriptFetch::Pending(message)) => {
                format!("transcript {id}: {message}")
            }
            Err(error) => format!("transcript {id}: {error}"),
        };
        log_line(Path::new(LOG_PATH), &note);
    });
}

fn persist_playlist_locked() {
    let pl = playlist_mutex()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let _ = playlist::save(Path::new(PLAYLIST_PATH), &pl);
}

fn publish() {
    let feeds = lock_status(status_mutex()).feeds.clone();
    let dummy_feeds: Vec<sync::FeedRun> = feeds
        .into_iter()
        .map(|f| sync::FeedRun {
            spec: kpodd::opml::FeedSpec {
                title: f.title.clone(),
                url: f.url.clone(),
            },
            feed_id: f.id,
            title: f.title,
            last_sync_at: f.last_sync_at,
            last_error: f.last_error,
        })
        .collect();
    let cat = catalog_mutex()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let pl = playlist_mutex()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let idx = index_mutex()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let on_update = || write_status_file();
    if dummy_feeds.is_empty() {
        // Fall back to a full refresh so OPML feeds appear on first mutation
        // before any sync has run.
        drop(cat);
        drop(pl);
        drop(idx);
        sync::run_refresh(
            index_mutex(),
            catalog_mutex(),
            playlist_mutex(),
            &current_config(),
            status_mutex(),
            Path::new(LOG_PATH),
            &on_update,
        );
        return;
    }
    sync::publish_views(status_mutex(), &on_update, &dummy_feeds, &cat, &pl, &idx);
}

fn resolve_play_id(requested: &str) -> Option<String> {
    let pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
    if !requested.is_empty() {
        // Explore rows are queued by the caller before playback.
        return Some(requested.to_string());
    }
    pl.current_id.clone().or_else(|| pl.items.first().cloned())
}

fn set_current_id(id: &str) {
    {
        let mut pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
        if pl.contains(id) {
            pl.current_id = Some(id.to_string());
            pl.move_to_front(id);
        }
    }
    persist_playlist_locked();
}

fn neighbor_id(dir: i32) -> Option<String> {
    let pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
    let cur = pl
        .current_id
        .clone()
        .or_else(|| pl.items.first().cloned())?;
    pl.neighbor(&cur, dir)
}

pub(super) fn status_json() -> String {
    lock_status(status_mutex()).to_json()
}

pub(super) fn initialize() {
    status_mutex();
    index_mutex();
    catalog_mutex();
    playlist_mutex();
    set_status(|s| {
        let cfg = current_config();
        s.max_episodes = cfg.max_episodes;
        s.compact = cfg.compact;
        s.transcript_api = !cfg.transcript_api.trim().is_empty();
    });
    let on_update = || write_status_file();
    sync::run_refresh(
        index_mutex(),
        catalog_mutex(),
        playlist_mutex(),
        &current_config(),
        status_mutex(),
        Path::new(LOG_PATH),
        &on_update,
    );
    let saved = {
        let pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
        pl.current_id
            .as_ref()
            .map(|id| pl.progress_of(id))
            .unwrap_or(0)
    };
    if saved > 0 {
        set_status(|s| {
            s.play_position = saved;
        });
        write_status_file();
    }
    log_line(Path::new(LOG_PATH), "daemon start");
}

/// Store the current episode's position. While audio is running, skip writes
/// until the position has moved at least 10 seconds.
pub(super) fn remember_progress(force: bool) {
    let (id, pos, playing) = {
        let st = lock_status(status_mutex());
        (st.current_id.clone(), st.play_position, st.playing)
    };
    if id.is_empty() {
        return;
    }
    let changed = {
        let mut pl = playlist_mutex().lock().unwrap_or_else(|p| p.into_inner());
        let prev = pl.progress_of(&id);
        if pos == prev || (!force && playing && pos.abs_diff(prev) < 10) {
            false
        } else {
            pl.set_progress(&id, pos)
        }
    };
    if changed {
        persist_playlist_locked();
    }
}
