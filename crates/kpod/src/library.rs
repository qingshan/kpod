//! Search the public iTunes podcast directory and turn a pasted feed URL
//! into one subscribe row. The directory returns `feedUrl` values the OPML
//! file can store; no API key is required.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub title: String,
    pub author: String,
    pub url: String,
}

/// `true` when `text` is a single http(s) URL the user can subscribe to directly.
pub fn is_feed_url(text: &str) -> bool {
    let text = text.trim();
    (text.starts_with("https://") || text.starts_with("http://"))
        && !text.chars().any(char::is_whitespace)
        && text.len() <= 2000
}

pub fn title_from_url(url: &str) -> String {
    url::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "Podcast".to_string())
}

pub fn search_url(term: &str) -> String {
    let mut url = url::Url::parse("https://itunes.apple.com/search").expect("static itunes url");
    url.query_pairs_mut()
        .append_pair("media", "podcast")
        .append_pair("entity", "podcast")
        .append_pair("limit", "25")
        .append_pair("term", term.trim());
    url.into()
}

/// Parse an iTunes Search API body. Shows without an http(s) `feedUrl` are skipped.
pub fn parse_search(body: &str) -> Result<Vec<Hit>, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "podcast library returned invalid JSON".to_string())?;
    let results = value
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "podcast library returned an unexpected response".to_string())?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for result in results {
        let Some(url) = result.get("feedUrl").and_then(|u| u.as_str()) else {
            continue;
        };
        let url = url.trim();
        if !is_feed_url(url) || !seen.insert(url.to_string()) {
            continue;
        }
        let title = result
            .get("collectionName")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("Untitled show");
        let author = result
            .get("artistName")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .unwrap_or("");
        out.push(Hit {
            title: title.to_string(),
            author: author.to_string(),
            url: url.to_string(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_url_encodes_the_show_name() {
        let url = search_url(" npr news ");
        assert!(url.starts_with("https://itunes.apple.com/search?"));
        assert!(url.contains("media=podcast"));
        assert!(url.contains("entity=podcast"));
        assert!(url.contains("limit=25"));
        assert!(url.contains("term=npr+news"));
    }

    #[test]
    fn parses_directory_results_and_skips_shows_without_a_feed() {
        let body = r#"{
            "resultCount": 3,
            "results": [
                {"collectionName": "NPR News Now", "artistName": "NPR", "feedUrl": "https://feeds.npr.org/500005/podcast.xml"},
                {"collectionName": "No feed", "artistName": "X", "feedUrl": ""},
                {"collectionName": "Dup", "artistName": "NPR", "feedUrl": "https://feeds.npr.org/500005/podcast.xml"},
                {"wrapperType": "track"}
            ]
        }"#;
        let hits = parse_search(body).expect("parse");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "NPR News Now");
        assert_eq!(hits[0].author, "NPR");
        assert_eq!(hits[0].url, "https://feeds.npr.org/500005/podcast.xml");
    }

    #[test]
    fn empty_directory_is_ok() {
        let hits = parse_search(r#"{"resultCount":0,"results":[]}"#).expect("parse");
        assert!(hits.is_empty());
    }

    #[test]
    fn malformed_directory_is_an_error() {
        assert!(parse_search("not json").is_err());
        assert!(parse_search(r#"{"resultCount":1}"#).is_err());
    }

    #[test]
    fn feed_url_detection() {
        assert!(is_feed_url(" https://feeds.npr.org/500005/podcast.xml "));
        assert!(!is_feed_url("npr news"));
        assert!(!is_feed_url("https://example.com/a b"));
        assert_eq!(
            title_from_url("https://feeds.npr.org/500005/podcast.xml"),
            "feeds.npr.org"
        );
    }
}
