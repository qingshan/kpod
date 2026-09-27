//! Persistent episode catalog at `/mnt/us/kpod/var/catalog.json`: every
//! episode discovered from subscribed OPML feeds (metadata only). The WAF
//! Explore view searches this; downloads happen only for playlist items.

use crate::index::episode_id_for;
use crate::rss;
use crate::slugify;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::fs;
use std::path::Path;

/// Newest episodes kept per feed in the on-disk catalog (RSS itself is usually
/// much smaller).
pub const MAX_PER_FEED: usize = 200;

/// Rows the Explore page asks for at a time (Mesquite does not scroll).
pub const EXPLORE_PAGE_SIZE: u64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEpisode {
    pub id: String,
    pub feed_id: String,
    pub feed: String,
    pub title: String,
    /// Enclosure URL used to download; empty for index-only upgrade rows.
    pub url: String,
    /// Path relative to the episodes root (`<feed-id>/<file>`).
    pub file: String,
    #[serde(default)]
    pub content_type: String,
    pub size: Option<u64>,
    pub duration: Option<u64>,
    pub pub_date: Option<u64>,
    #[serde(default)]
    pub transcript_url: Option<String>,
    #[serde(default)]
    pub transcript_type: Option<String>,
}

impl CatalogEpisode {
    pub fn playable(&self) -> bool {
        self.file.to_ascii_lowercase().ends_with(".mp3")
            || self.id.to_ascii_lowercase().ends_with(".mp3")
    }

    /// Build a catalog row from one RSS/Atom episode.
    pub fn from_rss(feed_id: &str, feed_title: &str, feed_url: &str, ep: &rss::Episode) -> Self {
        let url = rss::urljoin(feed_url, &ep.url);
        let ext = rss::guess_ext(&ep.content_type, &url);
        // Titles are commonly reused ("Trailer", "Episode 1", ...). Keep a
        // stable identifier from the feed in the filename so such entries do
        // not overwrite one another.
        let identity = ep.guid.as_deref().unwrap_or(&url);
        let file_name = format!(
            "{}-{:016x}{}",
            slugify(&ep.title),
            stable_hash(identity),
            ext
        );
        CatalogEpisode {
            id: episode_id_for(feed_id, &file_name),
            feed_id: feed_id.to_string(),
            feed: feed_title.to_string(),
            title: ep.title.clone(),
            url,
            file: format!("{}/{}", feed_id, file_name),
            content_type: ep.content_type.clone(),
            size: ep.length,
            duration: ep.duration,
            pub_date: ep.pub_date,
            transcript_url: ep
                .transcript
                .as_ref()
                .map(|t| rss::urljoin(feed_url, &t.url)),
            transcript_type: ep.transcript.as_ref().map(|t| t.content_type.clone()),
        }
    }
}

/// Stable FNV-1a hash for filename disambiguation. This is intentionally not
/// `DefaultHasher`: its algorithm is not a persistence contract.
fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Stable per-feed directory id (slugified title, `-2`, `-3`, ... when taken).
pub fn feed_id_for(title: &str, existing: &[String]) -> String {
    let base = slugify(title);
    if !existing.iter().any(|e| e == &base) {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{}-{}", base, n);
        if !existing.iter().any(|e| e == &candidate) {
            return candidate;
        }
        n += 1;
    }
}

pub fn load(path: &Path) -> Vec<CatalogEpisode> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_else(|_| Vec::new())
}

pub fn save(path: &Path, entries: &[CatalogEpisode]) -> Result<(), String> {
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

/// Replace one feed's rows and keep the newest [`MAX_PER_FEED`].
pub fn replace_feed(
    catalog: &mut Vec<CatalogEpisode>,
    feed_id: &str,
    mut eps: Vec<CatalogEpisode>,
) {
    catalog.retain(|e| e.feed_id != feed_id);
    eps.sort_by_cached_key(|e| Reverse((e.pub_date.unwrap_or(0), e.title.clone())));
    eps.truncate(MAX_PER_FEED);
    catalog.extend(eps);
}

/// Newest episode of each feed, newest feed-latest first.
pub fn latest_per_feed(catalog: &[CatalogEpisode]) -> Vec<CatalogEpisode> {
    let mut best: Vec<CatalogEpisode> = Vec::new();
    for e in catalog {
        match best.iter_mut().find(|b| b.feed_id == e.feed_id) {
            Some(b) => {
                if (e.pub_date.unwrap_or(0), &e.id) > (b.pub_date.unwrap_or(0), &b.id) {
                    *b = e.clone();
                }
            }
            None => best.push(e.clone()),
        }
    }
    best.sort_by_cached_key(|e| Reverse((e.pub_date.unwrap_or(0), e.id.clone())));
    best
}

/// Case-insensitive substring match on title and feed name, newest first.
pub fn search<'a>(
    catalog: &'a [CatalogEpisode],
    query: &str,
    feed_filter: &str,
    offset: usize,
    limit: usize,
) -> (Vec<&'a CatalogEpisode>, usize) {
    let q = query.trim().to_ascii_lowercase();
    let feed_f = feed_filter.trim();
    let mut hits: Vec<&CatalogEpisode> = catalog
        .iter()
        .filter(|e| {
            if !feed_f.is_empty() && e.feed != feed_f && e.feed_id != feed_f {
                return false;
            }
            if q.is_empty() {
                return true;
            }
            e.title.to_ascii_lowercase().contains(&q) || e.feed.to_ascii_lowercase().contains(&q)
        })
        .collect();
    hits.sort_by_cached_key(|e| Reverse((e.pub_date.unwrap_or(0), e.id.clone())));
    let total = hits.len();
    let page = hits.into_iter().skip(offset).take(limit).collect();
    (page, total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(id: &str, feed_id: &str, feed: &str, title: &str, pub_date: u64) -> CatalogEpisode {
        CatalogEpisode {
            id: id.to_string(),
            feed_id: feed_id.to_string(),
            feed: feed.to_string(),
            title: title.to_string(),
            url: format!("https://x/{id}.mp3"),
            file: format!("{feed_id}/{id}.mp3"),
            content_type: "audio/mpeg".into(),
            size: Some(1),
            duration: Some(60),
            pub_date: Some(pub_date),
            transcript_url: None,
            transcript_type: None,
        }
    }

    #[test]
    fn feed_id_dedup() {
        let mut used = Vec::new();
        let a = feed_id_for("Radio Lab", &used);
        used.push(a.clone());
        let b = feed_id_for("Radio Lab", &used);
        assert_eq!(a, "Radio Lab");
        assert_eq!(b, "Radio Lab-2");
        assert_eq!(feed_id_for("Dune: Part 2!", &[]), "Dune_ Part 2_");
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("kpod-cat-{}", crate::now_epoch()));
        let path = dir.join("catalog.json");
        fs::create_dir_all(&dir).unwrap();
        let entries = vec![ep("a", "f", "Feed", "A", 10)];
        save(&path, &entries).unwrap();
        assert_eq!(load(&path), entries);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_catalog_is_empty() {
        assert!(load(Path::new("/nonexistent/kpod/catalog.json")).is_empty());
    }

    #[test]
    fn replace_feed_swaps_only_that_feed() {
        let mut cat = vec![
            ep("old", "a", "A", "old", 1),
            ep("keep", "b", "B", "keep", 2),
        ];
        replace_feed(
            &mut cat,
            "a",
            vec![ep("new", "a", "A", "new", 9), ep("mid", "a", "A", "mid", 5)],
        );
        let ids: Vec<&str> = cat.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["keep", "new", "mid"]);
    }

    #[test]
    fn latest_per_feed_picks_newest() {
        let cat = vec![
            ep("a-old", "a", "A", "old", 1),
            ep("a-new", "a", "A", "new", 9),
            ep("b-only", "b", "B", "only", 4),
        ];
        let latest = latest_per_feed(&cat);
        let ids: Vec<&str> = latest.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["a-new", "b-only"]);
    }

    #[test]
    fn search_filters_and_pages() {
        let cat = vec![
            ep("1", "a", "Radio Lab", "Birds", 3),
            ep("2", "a", "Radio Lab", "Space", 2),
            ep("3", "b", "The Daily", "Birds of NY", 1),
        ];
        let (page, total) = search(&cat, "bird", "", 0, 10);
        assert_eq!(total, 2);
        assert_eq!(page[0].id, "1");
        let (page, total) = search(&cat, "", "The Daily", 0, 10);
        assert_eq!(total, 1);
        assert_eq!(page[0].id, "3");
        let (page, total) = search(&cat, "", "", 1, 1);
        assert_eq!(total, 3);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, "2");
    }

    #[test]
    fn from_rss_uses_stable_disambiguated_file_name() {
        let rss_ep = rss::Episode {
            title: "Ep 1: Part".into(),
            guid: Some("g".into()),
            url: "https://cdn.x/1.mp3".into(),
            content_type: "audio/mpeg".into(),
            length: Some(10),
            pub_date: Some(1),
            duration: Some(2),
            transcript: None,
        };
        let c = CatalogEpisode::from_rss(
            "Radio Lab",
            "Radio Lab",
            "https://feeds.x/show.xml",
            &rss_ep,
        );
        assert_eq!(
            c.id,
            episode_id_for("Radio Lab", "Ep 1_ Part-af63da4c8601e926.mp3")
        );
        assert_eq!(c.file, "Radio Lab/Ep 1_ Part-af63da4c8601e926.mp3");
        assert!(c.playable());
        assert_eq!(c.transcript_url, None);
    }

    #[test]
    fn transcript_link_is_resolved_and_old_catalog_rows_load() {
        let ep = rss::Episode {
            title: "One".into(),
            guid: None,
            url: "audio.mp3".into(),
            content_type: "audio/mpeg".into(),
            length: None,
            pub_date: None,
            duration: None,
            transcript: Some(rss::TranscriptLink {
                url: "text/one.vtt".into(),
                content_type: "text/vtt".into(),
            }),
        };
        let row = CatalogEpisode::from_rss("feed", "Feed", "https://example.com/show.xml", &ep);
        assert_eq!(
            row.transcript_url.as_deref(),
            Some("https://example.com/text/one.vtt")
        );
        let mut value = serde_json::to_value(&row).unwrap();
        value.as_object_mut().unwrap().remove("transcriptUrl");
        value.as_object_mut().unwrap().remove("transcriptType");
        let old: CatalogEpisode = serde_json::from_value(value).unwrap();
        assert_eq!(old.transcript_url, None);
    }

    #[test]
    fn same_title_episodes_get_distinct_files() {
        let mut first = rss::Episode {
            title: "Trailer".into(),
            guid: Some("first".into()),
            url: "https://cdn.x/first.mp3".into(),
            content_type: "audio/mpeg".into(),
            length: None,
            pub_date: None,
            duration: None,
            transcript: None,
        };
        let second = rss::Episode {
            guid: Some("second".into()),
            ..first.clone()
        };
        let a = CatalogEpisode::from_rss("feed", "Feed", "https://feeds.x/show.xml", &first);
        let b = CatalogEpisode::from_rss("feed", "Feed", "https://feeds.x/show.xml", &second);
        assert_ne!(a.id, b.id);
        assert_ne!(a.file, b.file);
        first.guid = None;
        let url_based =
            CatalogEpisode::from_rss("feed", "Feed", "https://feeds.x/show.xml", &first);
        assert_ne!(a.file, url_based.file);
    }
}
