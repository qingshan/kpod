//! Persistent episode index at `/mnt/us/kpod/var/index.json`: one entry
//! per downloaded episode, so titles/dates/sizes survive a disk re-scan (the
//! WAF renders from this, and the retention cap evicts from it). `load` is
//! lenient (missing/corrupt file => empty index, rebuilt on the next save);
//! `save` is atomic (tmp + rename).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedEpisode {
    /// URL-safe id (feed-id + "_" + file name); used in the WAF's playback
    /// URL and the `episode_delete` op.
    pub id: String,
    /// Feed display title.
    pub feed: String,
    pub title: String,
    /// File path RELATIVE to the episodes root (`<feed-id>/<file>`).
    pub file: String,
    pub size: u64,
    pub duration: Option<u64>,
    pub pub_date: Option<u64>,
    pub downloaded_at: u64,
}

impl IndexedEpisode {
    /// Absolute path of the episode file on disk.
    pub fn abs_path(&self, root: &Path) -> std::path::PathBuf {
        root.join(&self.file)
    }
}

/// Read the index; a missing or corrupt file yields an empty index.
pub fn load(path: &Path) -> Vec<IndexedEpisode> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_else(|_| Vec::new())
}

/// Write the index atomically (`path + ".tmp"`, then rename).
pub fn save(path: &Path, entries: &[IndexedEpisode]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&tmp, json).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))?;
    Ok(())
}

/// URL-safe id for a downloaded episode file.
pub fn episode_id_for(feed_id: &str, file_name: &str) -> String {
    crate::url_safe(&format!("{}_{}", feed_id, file_name))
}

/// Drop entries whose file no longer exists on disk (manual deletions, wiped
/// dirs, ...). Returns the surviving entries.
pub fn sync_with_disk(root: &Path, entries: Vec<IndexedEpisode>) -> Vec<IndexedEpisode> {
    entries
        .into_iter()
        .filter(|e| e.abs_path(root).is_file())
        .collect()
}

/// Apply the global retention cap: keep the newest `max` episodes across ALL
/// feeds (sorted by publish date desc, falling back to download time),
/// deleting the evicted files. Returns the number of episodes removed.
pub fn apply_cap(
    root: &Path,
    entries: Vec<IndexedEpisode>,
    max: u64,
) -> (Vec<IndexedEpisode>, usize) {
    apply_cap_protecting(root, entries, max, &HashSet::new())
}

/// Like [`apply_cap`], but never deletes ids in `protect` (the play queue).
pub fn apply_cap_protecting(
    root: &Path,
    entries: Vec<IndexedEpisode>,
    max: u64,
    protect: &HashSet<String>,
) -> (Vec<IndexedEpisode>, usize) {
    let mut protected = Vec::new();
    let mut rest = Vec::new();
    for e in entries {
        if protect.contains(&e.id) {
            protected.push(e);
        } else {
            rest.push(e);
        }
    }
    if protected.len() as u64 >= max {
        let kept_paths: HashSet<&str> = protected.iter().map(|e| e.file.as_str()).collect();
        let mut removed = 0;
        for e in rest {
            if !kept_paths.contains(e.file.as_str()) {
                let _ = fs::remove_file(e.abs_path(root));
            }
            removed += 1;
        }
        return (protected, removed);
    }
    let keep_rest = (max as usize).saturating_sub(protected.len());
    rest.sort_by_cached_key(|e| std::cmp::Reverse((e.pub_date.unwrap_or(0), e.downloaded_at)));
    let mut removed = 0;
    let mut evicted = Vec::new();
    while rest.len() > keep_rest {
        if let Some(entry) = rest.pop() {
            evicted.push(entry);
            removed += 1;
        }
    }
    protected.extend(rest);
    let kept_paths: HashSet<&str> = protected.iter().map(|e| e.file.as_str()).collect();
    for entry in evicted {
        if !kept_paths.contains(entry.file.as_str()) {
            let _ = fs::remove_file(entry.abs_path(root));
        }
    }
    (protected, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, pub_date: u64, downloaded_at: u64) -> IndexedEpisode {
        IndexedEpisode {
            id: id.to_string(),
            feed: "Feed".into(),
            title: id.to_string(),
            file: format!("feed/{}.mp3", id),
            size: 100,
            duration: None,
            pub_date: Some(pub_date),
            downloaded_at,
        }
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("kpod-index-test-{}", crate::now_epoch()));
        let path = dir.join("index.json");
        fs::create_dir_all(&dir).unwrap();
        let entries = vec![entry("a", 10, 20), entry("b", 5, 30)];
        save(&path, &entries).expect("save");
        assert_eq!(load(&path), entries);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_and_corrupt_index_are_empty() {
        assert!(load(Path::new("/nonexistent/kpod/index.json")).is_empty());
        let dir = std::env::temp_dir().join(format!("kpod-index-test-{}", crate::now_epoch() + 1));
        let path = dir.join("index.json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, "[not json").unwrap();
        assert!(load(&path).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cap_keeps_newest_by_pub_date_across_feeds() {
        let dir = std::env::temp_dir().join(format!("kpod-index-test-{}", crate::now_epoch() + 2));
        let root = dir.join("episodes");
        let path = dir.join("index.json");
        fs::create_dir_all(root.join("feed")).unwrap();
        let entries = vec![
            entry("old", 100, 1),
            entry("mid", 200, 2),
            entry("new", 300, 3),
        ];
        for e in &entries {
            fs::write(e.abs_path(&root), b"x").unwrap();
        }
        save(&path, &entries).unwrap();
        let (kept, removed) = apply_cap(&root, load(&path), 2);
        assert_eq!(removed, 1);
        let ids: Vec<&str> = kept.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["new", "mid"]);
        assert!(!root.join("feed/old.mp3").exists());
        assert!(root.join("feed/new.mp3").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cap_keeps_a_shared_audio_file_used_by_the_queue() {
        let dir = std::env::temp_dir().join(format!("kpod-shared-{}", crate::now_epoch()));
        let root = dir.join("episodes");
        fs::create_dir_all(root.join("feed")).unwrap();
        let old = entry("old", 1, 1);
        let mut queued = entry("queue", 2, 2);
        queued.file = old.file.clone();
        fs::write(old.abs_path(&root), b"mp3").unwrap();
        let protect = HashSet::from(["queue".to_string()]);
        let (kept, _) = apply_cap_protecting(&root, vec![old, queued], 1, &protect);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].abs_path(&root).is_file());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cap_none_when_within_limit() {
        let dir = std::env::temp_dir().join(format!("kpod-index-test-{}", crate::now_epoch() + 3));
        let root = dir.join("episodes");
        fs::create_dir_all(&root).unwrap();
        let entries = vec![entry("a", 1, 1), entry("b", 2, 2)];
        let (kept, removed) = apply_cap(&root, entries, 10);
        assert_eq!(removed, 0);
        assert_eq!(kept.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_pub_date_sorts_oldest() {
        let dir = std::env::temp_dir().join(format!("kpod-index-test-{}", crate::now_epoch() + 4));
        let root = dir.join("episodes");
        fs::create_dir_all(root.join("feed")).unwrap();
        let mut dated = entry("dated", 100, 1);
        let mut nodate = entry("nodate", 0, 99);
        nodate.pub_date = None;
        dated.downloaded_at = 1;
        nodate.downloaded_at = 99;
        for e in [&dated, &nodate] {
            fs::write(e.abs_path(&root), b"x").unwrap();
        }
        let (kept, removed) = apply_cap(&root, vec![nodate, dated], 1);
        assert_eq!(removed, 1);
        assert_eq!(kept[0].id, "dated");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn episode_id_is_url_safe() {
        assert_eq!(
            episode_id_for("Radio Lab", "Ep 1: Part.mp3"),
            "Radio_Lab_Ep_1__Part.mp3"
        );
        assert_eq!(episode_id_for("feed", "a/b.mp3"), "feed_a_b.mp3");
    }

    #[test]
    fn cap_protects_playlist_ids() {
        let dir = std::env::temp_dir().join(format!("kpod-index-test-{}", crate::now_epoch() + 6));
        let root = dir.join("episodes");
        fs::create_dir_all(root.join("feed")).unwrap();
        let old = entry("old", 100, 1);
        let queued = entry("queued", 50, 2);
        for e in [&old, &queued] {
            fs::write(e.abs_path(&root), b"x").unwrap();
        }
        let mut protect = HashSet::new();
        protect.insert("queued".to_string());
        let (kept, removed) = apply_cap_protecting(&root, vec![old, queued], 1, &protect);
        assert_eq!(removed, 1);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "queued");
        assert!(!root.join("feed/old.mp3").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_with_disk_drops_missing_files() {
        let dir = std::env::temp_dir().join(format!("kpod-index-test-{}", crate::now_epoch() + 5));
        let root = dir.join("episodes");
        fs::create_dir_all(root.join("feed")).unwrap();
        let mut present = entry("present", 1, 1);
        let mut missing = entry("missing", 2, 2);
        present.feed = "feed".into();
        missing.feed = "feed".into();
        fs::write(present.abs_path(&root), b"x").unwrap();
        let kept = sync_with_disk(&root, vec![present, missing]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "present");
        let _ = fs::remove_dir_all(&dir);
    }
}
