//! Client for the private server-owned queue and episode catalog.

use crate::config::Config;
use crate::http;
use crate::status::{ExploreView, QueueShow};

pub fn endpoint(feed_url: &str, path: &str) -> Result<String, String> {
    let mut url = url::Url::parse(feed_url).map_err(|_| "queue URL is invalid")?;
    if url.scheme() != "https" || !url.path().ends_with("/queue.xml") {
        return Err("queue URL must end in /queue.xml over HTTPS".into());
    }
    let base = url.path().trim_end_matches("queue.xml");
    url.set_path(&format!("{base}queue/{path}"));
    url.set_query(None);
    Ok(url.into())
}

pub fn search(config: &Config, query: &str, feed: &str) -> Result<ExploreView, String> {
    let mut url = url::Url::parse(&endpoint(&config.queue_url, "search")?)
        .map_err(|_| "queue search URL is invalid")?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("show", feed);
    let body = http::fetch(url.as_str(), Some("application/json"))
        .map_err(|_| "could not fetch queue search".to_string())?;
    serde_json::from_slice(&body).map_err(|e| format!("invalid queue search: {e}"))
}

pub fn shows(config: &Config) -> Result<Vec<QueueShow>, String> {
    let body = http::fetch(
        &endpoint(&config.queue_url, "shows")?,
        Some("application/json"),
    )
    .map_err(|_| "could not fetch subscribed shows".to_string())?;
    serde_json::from_slice(&body).map_err(|e| format!("invalid queue shows: {e}"))
}

pub fn change(config: &Config, action: &str, body: serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    http::post_json(
        &endpoint(&config.queue_url, action)?,
        &config.queue_token,
        &body,
    )
    .map_err(|_| format!("could not update queue ({action})"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_endpoints_keep_private_key() {
        assert_eq!(
            endpoint("https://kpod.example/youtube/private/queue.xml", "search").unwrap(),
            "https://kpod.example/youtube/private/queue/search"
        );
        assert!(endpoint("http://kpod.example/private/queue.xml", "search").is_err());
    }
}
