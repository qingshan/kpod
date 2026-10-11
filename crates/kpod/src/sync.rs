//! The sync engine. In OPML mode it refreshes local feed catalogs and queues
//! each feed's newest episode. In server queue mode it mirrors the prepared
//! feed and downloads its episodes. Both modes keep the on-disk index in sync.
//! Single-threaded; the stop flag is checked before every download and a set
//! flag flips the status to `stopping` and aborts cleanly (no `.part` files
//! left behind).
//!
//! `refresh` rebuilds WAF views without downloading; the WAF's Refresh path
//! and the daemon-start seed use it.

use crate::catalog::{self, CatalogEpisode};
use crate::config::Config;
use crate::index::{self, IndexedEpisode};
use crate::opml::{self, FeedSpec};
use crate::playlist::Playlist;
use crate::rss;
use crate::status::{self, ExploreItem, FeedSummary, PlaylistItem, Status};
use crate::{
    mutate_status, now_epoch, CATALOG_PATH, EPISODES_ROOT, PLAYLIST_PATH, SUBSCRIPTIONS_OPML,
};
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Accept header sent for podcast feeds.
pub const FEED_ACCEPT: &str = "application/rss+xml,application/atom+xml,application/xml,*/*";

/// Append a timestamped line to the sync log (created on demand).
pub fn log_line(log_path: &Path, msg: &str) {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = format!("[{}] {}\n", now_epoch(), msg);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Load the OPML subscription list (missing/corrupt file → empty).
fn load_subscriptions(opml_path: &Path) -> Vec<FeedSpec> {
    let Ok(body) = std::fs::read_to_string(opml_path) else {
        return Vec::new();
    };
    opml::parse_opml(&body).unwrap_or_else(|e| {
        log_line(
            Path::new(crate::LOG_PATH),
            &format!("warning: could not parse {}: {}", opml_path.display(), e),
        );
        Vec::new()
    })
}

pub struct FeedRun {
    pub spec: FeedSpec,
    pub feed_id: String,
    pub title: String,
    pub last_sync_at: Option<u64>,
    pub last_error: Option<String>,
}

pub fn load_feed_runs() -> Vec<FeedRun> {
    feeds_from_opml()
}

fn no_subscriptions_message() -> String {
    format!(
        "no subscriptions yet - tap Add show in Explore, or drop an OPML file at {}",
        SUBSCRIPTIONS_OPML
    )
}

fn feeds_from_opml() -> Vec<FeedRun> {
    let specs = load_subscriptions(Path::new(SUBSCRIPTIONS_OPML));
    let mut feeds = Vec::new();
    let mut used_ids: Vec<String> = Vec::new();
    for spec in specs {
        let feed_id = catalog::feed_id_for(&spec.title, &used_ids);
        used_ids.push(feed_id.clone());
        let title = spec.title.clone();
        feeds.push(FeedRun {
            spec,
            feed_id,
            title,
            last_sync_at: None,
            last_error: None,
        });
    }
    feeds
}

fn feeds_for_config(cfg: &Config) -> Vec<FeedRun> {
    if cfg.queue_url.trim().is_empty() {
        return feeds_from_opml();
    }
    vec![FeedRun {
        spec: FeedSpec {
            title: "Kpod Queue".into(),
            url: cfg.queue_url.clone(),
        },
        feed_id: "Kpod Queue".into(),
        title: "Kpod Queue".into(),
        last_sync_at: None,
        last_error: None,
    }]
}

fn merge_index_into_catalog(catalog: &mut Vec<CatalogEpisode>, index: &[IndexedEpisode]) {
    for e in index {
        if catalog.iter().any(|c| c.id == e.id) {
            continue;
        }
        let feed_id = e
            .file
            .split('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("feed")
            .to_string();
        catalog.push(CatalogEpisode {
            id: e.id.clone(),
            feed_id,
            feed: e.feed.clone(),
            title: e.title.clone(),
            url: String::new(),
            file: e.file.clone(),
            content_type: String::new(),
            size: Some(e.size),
            duration: e.duration,
            pub_date: e.pub_date,
            transcript_url: None,
            transcript_type: None,
        });
    }
}

fn playlist_item(
    id: &str,
    catalog: &[CatalogEpisode],
    index: &[IndexedEpisode],
    current_id: Option<&str>,
) -> Option<PlaylistItem> {
    let c = catalog.iter().find(|e| e.id == id);
    let idx = index.iter().find(|e| e.id == id);
    let title = c
        .map(|e| e.title.clone())
        .or_else(|| idx.map(|e| e.title.clone()))?;
    let feed = c
        .map(|e| e.feed.clone())
        .or_else(|| idx.map(|e| e.feed.clone()))
        .unwrap_or_default();
    let playable = c
        .map(|e| e.playable())
        .unwrap_or_else(|| id.to_ascii_lowercase().ends_with(".mp3"));
    Some(PlaylistItem {
        id: id.to_string(),
        feed,
        title,
        size: idx
            .map(|e| e.size)
            .or_else(|| c.and_then(|e| e.size))
            .unwrap_or(0),
        duration: c
            .and_then(|e| e.duration)
            .or_else(|| idx.and_then(|e| e.duration)),
        pub_date: c
            .and_then(|e| e.pub_date)
            .or_else(|| idx.and_then(|e| e.pub_date)),
        downloaded: idx.is_some(),
        playable,
        current: current_id == Some(id),
        has_transcript: c.and_then(|e| e.transcript_url.as_ref()).is_some(),
    })
}

/// Rebuild playlist / explore / feeds on the shared status from in-memory state.
pub fn publish_views(
    status: &Mutex<Status>,
    on_update: &dyn Fn(),
    feeds: &[FeedRun],
    catalog: &[CatalogEpisode],
    playlist: &Playlist,
    index: &[IndexedEpisode],
) {
    let current_id = playlist.current_id.as_deref();
    let playlist_items: Vec<PlaylistItem> = playlist
        .items
        .iter()
        .filter_map(|id| playlist_item(id, catalog, index, current_id))
        .collect();

    let downloaded_ids: HashSet<&str> = index.iter().map(|e| e.id.as_str()).collect();
    let in_playlist: HashSet<&str> = playlist.items.iter().map(|s| s.as_str()).collect();

    let query;
    let feed_filter;
    let offset;
    let limit;
    {
        let s = crate::lock_status(status);
        query = s.explore.query.clone();
        feed_filter = s.explore.feed.clone();
        offset = s.explore.offset as usize;
        limit = if s.explore.limit == 0 {
            catalog::EXPLORE_PAGE_SIZE as usize
        } else {
            s.explore.limit as usize
        };
    }
    let mut offset = offset;
    let (mut page, total) = catalog::search(catalog, &query, &feed_filter, offset, limit);
    if page.is_empty() && total > 0 && offset > 0 {
        offset = 0;
        let pair = catalog::search(catalog, &query, &feed_filter, 0, limit);
        page = pair.0;
    }
    let explore_items: Vec<ExploreItem> = page
        .into_iter()
        .map(|e| ExploreItem {
            id: e.id.clone(),
            feed: e.feed.clone(),
            title: e.title.clone(),
            duration: e.duration,
            pub_date: e.pub_date,
            in_playlist: in_playlist.contains(e.id.as_str()),
            downloaded: downloaded_ids.contains(e.id.as_str()),
            playable: e.playable(),
            has_transcript: e.transcript_url.is_some(),
            queue_state: String::new(),
            queue_error: String::new(),
        })
        .collect();

    let summaries: Vec<FeedSummary> = feeds
        .iter()
        .map(|f| {
            let episode_count = catalog.iter().filter(|e| e.feed_id == f.feed_id).count() as u64;
            let downloaded = index
                .iter()
                .filter(|e| {
                    catalog
                        .iter()
                        .any(|c| c.feed_id == f.feed_id && c.id == e.id)
                })
                .count() as u64;
            FeedSummary {
                id: f.feed_id.clone(),
                title: f.title.clone(),
                url: f.spec.url.clone(),
                episode_count,
                downloaded,
                last_sync_at: f.last_sync_at,
                last_error: f.last_error.clone(),
            }
        })
        .collect();

    mutate_status(status, on_update, |s| {
        s.feeds = summaries;
        s.playlist = playlist_items;
        s.current_id = playlist.current_id.clone().unwrap_or_default();
        if !s.queue_mode {
            s.explore.offset = offset as u64;
            s.explore.total = total as u64;
            s.explore.limit = limit as u64;
            s.explore.items = explore_items;
        }
    });
}

fn persist_catalog(catalog: &[CatalogEpisode], log_path: &Path) {
    if let Err(e) = catalog::save(Path::new(CATALOG_PATH), catalog) {
        log_line(log_path, &format!("warning: could not save catalog: {}", e));
    }
}

fn persist_playlist(playlist: &Playlist, log_path: &Path) {
    if let Err(e) = crate::playlist::save(Path::new(PLAYLIST_PATH), playlist) {
        log_line(
            log_path,
            &format!("warning: could not save playlist: {}", e),
        );
    }
}

/// Reconcile the index with the disk and apply the retention cap (playlist
/// ids are never evicted). Returns the surviving entries.
fn reconcile_index(
    index: &Mutex<Vec<IndexedEpisode>>,
    playlist: &Playlist,
    cfg: &Config,
    log_path: &Path,
) -> Vec<IndexedEpisode> {
    let root = Path::new(EPISODES_ROOT);
    let mut entries = {
        let guard = index.lock().unwrap_or_else(|p| p.into_inner());
        index::sync_with_disk(root, guard.clone())
    };
    let protect: HashSet<String> = playlist.items.iter().cloned().collect();
    let (kept, removed) = index::apply_cap_protecting(root, entries, cfg.max_episodes, &protect);
    entries = kept;
    if removed > 0 {
        log_line(
            log_path,
            &format!(
                "retention: removed {} episode(s) (global cap {})",
                removed, cfg.max_episodes
            ),
        );
    }
    {
        let mut guard = index.lock().unwrap_or_else(|p| p.into_inner());
        *guard = entries.clone();
    }
    if let Err(e) = index::save(Path::new(crate::INDEX_PATH), &entries) {
        log_line(log_path, &format!("warning: could not save index: {}", e));
    }
    entries
}

fn snapshot_catalog(catalog: &Mutex<Vec<CatalogEpisode>>) -> Vec<CatalogEpisode> {
    catalog.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn snapshot_playlist(playlist: &Mutex<Playlist>) -> Playlist {
    playlist.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn snapshot_index(index: &Mutex<Vec<IndexedEpisode>>) -> Vec<IndexedEpisode> {
    index.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Refresh feeds + views without downloading (WAF Refresh, daemon-start seed).
pub fn run_refresh(
    index: &Mutex<Vec<IndexedEpisode>>,
    catalog: &Mutex<Vec<CatalogEpisode>>,
    playlist: &Mutex<Playlist>,
    cfg: &Config,
    status: &Mutex<Status>,
    log_path: &Path,
    on_update: &dyn Fn(),
) {
    let feeds = feeds_for_config(cfg);
    let pl = snapshot_playlist(playlist);
    let entries = reconcile_index(index, &pl, cfg, log_path);
    {
        let mut cat = catalog.lock().unwrap_or_else(|p| p.into_inner());
        merge_index_into_catalog(&mut cat, &entries);
        persist_catalog(&cat, log_path);
    }
    mutate_status(status, on_update, |s| {
        s.phase = status::PHASE_IDLE.to_string();
        if s.state == status::STATE_RUNNING || s.state == status::STATE_STOPPING {
            s.state = status::STATE_IDLE.to_string();
        }
        if feeds.is_empty() {
            s.last_error = Some(no_subscriptions_message());
        } else {
            s.last_error = None;
        }
    });
    let cat = snapshot_catalog(catalog);
    let pl = snapshot_playlist(playlist);
    publish_views(status, on_update, &feeds, &cat, &pl, &entries);
}

/// Full sync: fetch every feed into the catalog, auto-queue latest episodes,
/// download missing playlist items, then reconcile the index.
pub struct SyncStores<'a> {
    pub index: &'a Mutex<Vec<IndexedEpisode>>,
    pub catalog: &'a Mutex<Vec<CatalogEpisode>>,
    pub playlist: &'a Mutex<Playlist>,
    pub status: &'a Mutex<Status>,
    pub log_path: &'a Path,
}

pub fn run_sync(
    stores: SyncStores<'_>,
    cfg: &Config,
    stop: &AtomicBool,
    on_update: &dyn Fn(),
    on_queued: &dyn Fn(&str),
) {
    let SyncStores {
        index,
        catalog,
        playlist,
        status,
        log_path,
    } = stores;
    mutate_status(status, on_update, |s| {
        s.phase = status::PHASE_SYNCING.to_string();
        s.downloaded = 0;
        s.skipped = 0;
        s.failed = 0;
        s.current.clear();
        s.last_error = None;
    });

    let mut feeds = feeds_for_config(cfg);
    if feeds.is_empty() {
        mutate_status(status, on_update, |s| {
            s.state = status::STATE_ERROR.to_string();
            s.last_error = Some(no_subscriptions_message());
        });
        log_line(
            log_path,
            &format!("sync aborted: no subscriptions in {}", SUBSCRIPTIONS_OPML),
        );
        return;
    }

    let mut catalog_entries = snapshot_catalog(catalog);
    let mut queue_ids = Vec::new();

    for f in feeds.iter_mut() {
        if stop.load(Ordering::SeqCst) {
            mutate_status(status, on_update, |s| {
                s.state = status::STATE_STOPPING.to_string()
            });
            break;
        }
        log_line(
            log_path,
            &format!("feed start: {} ({})", f.title, f.spec.url),
        );
        let body = match crate::http::fetch_with_stop(&f.spec.url, Some(FEED_ACCEPT), Some(stop)) {
            Ok(b) => b,
            Err(e) => {
                f.last_error = Some(format!("could not fetch feed: {}", e));
                log_line(
                    log_path,
                    &format!("warning: failed to fetch feed {}: {}", f.spec.url, e),
                );
                continue;
            }
        };
        let text = match std::str::from_utf8(&body) {
            Ok(t) => t,
            Err(e) => {
                f.last_error = Some(format!("feed is not UTF-8: {}", e));
                log_line(
                    log_path,
                    &format!("warning: feed {} is not UTF-8: {}", f.spec.url, e),
                );
                continue;
            }
        };
        let parsed = match rss::parse_feed(text) {
            Ok(p) => p,
            Err(e) => {
                f.last_error = Some(format!("could not parse feed: {}", e));
                log_line(
                    log_path,
                    &format!("warning: failed to parse feed {}: {}", f.spec.url, e),
                );
                continue;
            }
        };
        if !parsed.title.is_empty() {
            f.title = parsed.title.clone();
        }
        let mut eps: Vec<CatalogEpisode> = parsed
            .episodes
            .iter()
            .map(|ep| CatalogEpisode::from_rss(&f.feed_id, &f.title, &f.spec.url, ep))
            .collect();
        if !cfg.queue_url.is_empty() {
            let downloaded = snapshot_index(index);
            for ep in &mut eps {
                if let Some(old) = downloaded.iter().find(|old| can_reuse_download(ep, old)) {
                    ep.file = old.file.clone();
                }
            }
            queue_ids = eps.iter().map(|ep| ep.id.clone()).collect();
        }
        let n = eps.len();
        catalog::replace_feed(&mut catalog_entries, &f.feed_id, eps);
        f.last_sync_at = Some(now_epoch());
        log_line(
            log_path,
            &format!("feed catalogued: {} ({} episodes)", f.title, n),
        );
    }

    {
        let idx = snapshot_index(index);
        merge_index_into_catalog(&mut catalog_entries, &idx);
        let mut guard = catalog.lock().unwrap_or_else(|p| p.into_inner());
        *guard = catalog_entries.clone();
    }
    persist_catalog(&catalog_entries, log_path);

    let auto_added = {
        let latest = catalog::latest_per_feed(&catalog_entries);
        let mut pl = playlist.lock().unwrap_or_else(|p| p.into_inner());
        let ids = if cfg.queue_url.is_empty() {
            pl.auto_queue_latest(&latest, cfg.max_episodes)
        } else if feeds.iter().any(|f| f.last_sync_at.is_some()) {
            pl.mirror_prepared(queue_ids, &catalog_entries);
            Vec::new()
        } else {
            Vec::new()
        };
        persist_playlist(&pl, log_path);
        ids
    };
    for id in &auto_added {
        on_queued(id);
    }
    if !auto_added.is_empty() {
        log_line(
            log_path,
            &format!("auto-queued {} latest episode(s)", auto_added.len()),
        );
    }

    let pl = snapshot_playlist(playlist);
    download_playlist_items(
        index,
        &catalog_entries,
        &pl,
        stop,
        status,
        log_path,
        on_update,
    );

    let entries = reconcile_index(index, &pl, cfg, log_path);
    let cat = snapshot_catalog(catalog);
    let pl = snapshot_playlist(playlist);
    publish_views(status, on_update, &feeds, &cat, &pl, &entries);
}

/// Keep the server queue and its downloads current while the playback worker is busy.
pub fn update_queue_while_playing(
    index: &Mutex<Vec<IndexedEpisode>>,
    catalog: &Mutex<Vec<CatalogEpisode>>,
    playlist: &Mutex<Playlist>,
    cfg: &Config,
    status: &Mutex<Status>,
    log_path: &Path,
    on_update: &dyn Fn(),
) -> Result<(), String> {
    if cfg.queue_url.is_empty() {
        return Ok(());
    }
    let body = crate::http::fetch_with_stop(&cfg.queue_url, Some(FEED_ACCEPT), None)?;
    let text = std::str::from_utf8(&body).map_err(|e| format!("queue feed is not UTF-8: {e}"))?;
    let parsed = rss::parse_feed(text).map_err(|e| format!("could not parse queue feed: {e}"))?;
    let downloaded = snapshot_index(index);
    let feed_id = "Kpod Queue";
    let mut episodes: Vec<CatalogEpisode> = parsed
        .episodes
        .iter()
        .map(|ep| CatalogEpisode::from_rss(feed_id, &parsed.title, &cfg.queue_url, ep))
        .collect();
    for ep in &mut episodes {
        if let Some(old) = downloaded.iter().find(|old| can_reuse_download(ep, old)) {
            ep.file = old.file.clone();
        }
    }
    let ids = episodes.iter().map(|ep| ep.id.clone()).collect();
    {
        let mut cat = catalog.lock().unwrap_or_else(|p| p.into_inner());
        catalog::replace_feed(&mut cat, feed_id, episodes);
        merge_index_into_catalog(&mut cat, &downloaded);
        persist_catalog(&cat, log_path);
    }
    {
        let playing_id = {
            let s = status.lock().unwrap_or_else(|p| p.into_inner());
            s.playing.then(|| s.current_id.clone())
        };
        let cat = snapshot_catalog(catalog);
        let mut pl = playlist.lock().unwrap_or_else(|p| p.into_inner());
        pl.mirror_prepared(ids, &cat);
        if let Some(id) = playing_id.as_ref().filter(|id| pl.contains(id)) {
            pl.move_to_front(id);
        }
        if let Some(id) = playing_id.filter(|id| !id.is_empty() && !pl.contains(id)) {
            pl.items.insert(0, id.clone());
            pl.current_id = Some(id);
        }
        persist_playlist(&pl, log_path);
    }
    let mut feeds = feeds_for_config(cfg);
    feeds[0].title = parsed.title;
    feeds[0].last_sync_at = Some(now_epoch());
    let cat = snapshot_catalog(catalog);
    let pl = snapshot_playlist(playlist);
    publish_views(status, on_update, &feeds, &cat, &pl, &downloaded);
    download_playlist_items(
        index,
        &cat,
        &pl,
        &AtomicBool::new(false),
        status,
        log_path,
        on_update,
    );
    let entries = snapshot_index(index);
    publish_views(status, on_update, &feeds, &cat, &pl, &entries);
    Ok(())
}

fn can_reuse_download(ep: &CatalogEpisode, old: &IndexedEpisode) -> bool {
    old.title == ep.title
        && old.feed == ep.feed
        && old.file.to_ascii_lowercase().ends_with(".mp3")
        && ep.size.is_none_or(|size| size == 0 || size == old.size)
}

fn download_playlist_items(
    index: &Mutex<Vec<IndexedEpisode>>,
    catalog: &[CatalogEpisode],
    playlist: &Playlist,
    stop: &AtomicBool,
    status: &Mutex<Status>,
    log_path: &Path,
    on_update: &dyn Fn(),
) {
    for id in &playlist.items {
        if stop.load(Ordering::SeqCst) {
            mutate_status(status, on_update, |s| {
                s.state = status::STATE_STOPPING.to_string()
            });
            break;
        }
        match download_one(index, catalog, id, status, log_path, on_update, Some(stop)) {
            Ok(DownloadResult::Downloaded) => {}
            Ok(DownloadResult::Skipped) => {
                mutate_status(status, on_update, |s| s.skipped += 1);
            }
            Ok(DownloadResult::Missing) => {
                log_line(log_path, &format!("warning: catalog miss for {}", id));
            }
            Err(e) => {
                mutate_status(status, on_update, |s| s.failed += 1);
                log_line(log_path, &format!("error: {}", e));
            }
        }
    }
}

pub enum DownloadResult {
    Downloaded,
    Skipped,
    Missing,
}

/// Download one catalog episode if it is not already on disk.
pub fn download_one(
    index: &Mutex<Vec<IndexedEpisode>>,
    catalog: &[CatalogEpisode],
    id: &str,
    status: &Mutex<Status>,
    log_path: &Path,
    on_update: &dyn Fn(),
    stop: Option<&AtomicBool>,
) -> Result<DownloadResult, String> {
    let Some(ep) = catalog.iter().find(|e| e.id == id).cloned() else {
        return Ok(DownloadResult::Missing);
    };
    let root = Path::new(EPISODES_ROOT);
    let dest = root.join(&ep.file);
    if dest.exists() {
        let mut guard = index.lock().unwrap_or_else(|p| p.into_inner());
        if !guard.iter().any(|e| e.id == ep.id) {
            let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            guard.push(index_entry_from_catalog(&ep, size));
            let _ = index::save(Path::new(crate::INDEX_PATH), &guard);
        }
        return Ok(DownloadResult::Skipped);
    }
    if ep.url.is_empty() {
        return Err(format!("{} has no download URL", ep.title));
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    mutate_status(status, on_update, |s| {
        if !s.playing {
            s.current = ep.title.clone();
        }
    });
    crate::http::download_with_stop(&ep.url, &dest, stop)
        .map_err(|e| format!("download {} -> {}: {}", ep.title, ep.url, e))?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    {
        let mut guard = index.lock().unwrap_or_else(|p| p.into_inner());
        if !guard.iter().any(|e| e.id == ep.id) {
            guard.push(index_entry_from_catalog(&ep, size));
        }
        let _ = index::save(Path::new(crate::INDEX_PATH), &guard);
    }
    mutate_status(status, on_update, |s| s.downloaded += 1);
    log_line(log_path, &format!("downloaded: {} ({})", ep.title, ep.url));
    Ok(DownloadResult::Downloaded)
}

fn index_entry_from_catalog(ep: &CatalogEpisode, size: u64) -> IndexedEpisode {
    IndexedEpisode {
        id: ep.id.clone(),
        feed: ep.feed.clone(),
        title: ep.title.clone(),
        file: ep.file.clone(),
        size,
        duration: ep.duration,
        pub_date: ep.pub_date,
        downloaded_at: now_epoch(),
    }
}

/// Look up a catalog (or index) episode by id for playback.
pub fn find_playable<'a>(
    catalog: &'a [CatalogEpisode],
    index: &'a [IndexedEpisode],
    id: &str,
) -> Option<(String, String, std::path::PathBuf)> {
    if let Some(c) = catalog.iter().find(|e| e.id == id) {
        return Some((
            c.title.clone(),
            c.file.clone(),
            Path::new(EPISODES_ROOT).join(&c.file),
        ));
    }
    index.iter().find(|e| e.id == id).map(|e| {
        (
            e.title.clone(),
            e.file.clone(),
            Path::new(EPISODES_ROOT).join(&e.file),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_length_enclosure_can_reuse_matching_download() {
        let ep = CatalogEpisode {
            id: "new".into(),
            feed_id: "queue".into(),
            feed: "Show".into(),
            title: "Episode".into(),
            url: "https://example.com/episode.mp3".into(),
            file: "queue/new.mp3".into(),
            content_type: "audio/mpeg".into(),
            size: Some(0),
            duration: None,
            pub_date: None,
            transcript_url: None,
            transcript_type: None,
        };
        let old = IndexedEpisode {
            id: "old".into(),
            feed: "Show".into(),
            title: "Episode".into(),
            file: "Show/episode.mp3".into(),
            size: 123,
            duration: None,
            pub_date: None,
            downloaded_at: 1,
        };
        assert!(can_reuse_download(&ep, &old));
        let mut mismatched = old.clone();
        mismatched.title = "Another Episode".into();
        assert!(!can_reuse_download(&ep, &mismatched));
        let mut known_size = ep;
        known_size.size = Some(456);
        assert!(!can_reuse_download(&known_size, &old));
    }

    #[test]
    fn load_feed_runs_is_callable() {
        let _ = load_feed_runs();
    }

    #[test]
    fn feed_id_dedup() {
        let mut used = Vec::new();
        let a = catalog::feed_id_for("Radio Lab", &used);
        used.push(a.clone());
        let b = catalog::feed_id_for("Radio Lab", &used);
        assert_eq!(a, "Radio Lab");
        assert_eq!(b, "Radio Lab-2");
        assert_eq!(catalog::feed_id_for("Dune: Part 2!", &[]), "Dune_ Part 2_");
    }

    #[test]
    fn merge_index_does_not_duplicate() {
        let mut cat = vec![CatalogEpisode {
            id: "a".into(),
            feed_id: "f".into(),
            feed: "F".into(),
            title: "A".into(),
            url: "https://x/a.mp3".into(),
            file: "f/a.mp3".into(),
            content_type: String::new(),
            size: None,
            duration: None,
            pub_date: None,
            transcript_url: None,
            transcript_type: None,
        }];
        let idx = vec![IndexedEpisode {
            id: "a".into(),
            feed: "F".into(),
            title: "A".into(),
            file: "f/a.mp3".into(),
            size: 1,
            duration: None,
            pub_date: None,
            downloaded_at: 1,
        }];
        merge_index_into_catalog(&mut cat, &idx);
        assert_eq!(cat.len(), 1);
        let idx2 = vec![IndexedEpisode {
            id: "b".into(),
            feed: "F".into(),
            title: "B".into(),
            file: "f/b.mp3".into(),
            size: 1,
            duration: None,
            pub_date: None,
            downloaded_at: 1,
        }];
        merge_index_into_catalog(&mut cat, &idx2);
        assert_eq!(cat.len(), 2);
        assert_eq!(cat[1].id, "b");
        assert!(cat[1].url.is_empty());
    }
}
