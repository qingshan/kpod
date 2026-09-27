//! OPML subscription file parsing. The user drops an OPML export (from any
//! podcast app) at `/mnt/us/kpod/var/subscriptions.opml`; the daemon
//! re-reads it on every sync. Any `<outline>` with an `xmlUrl` attribute is a
//! subscription (nested outlines are walked recursively — that's how
//! Apple/Google podcast exports group feeds), and duplicates are dropped
//! keeping the first occurrence. `httpUsername`/`httpPassword` attributes are
//! ignored (v1 has no feed auth).

use roxmltree::Node;

#[derive(Debug, Clone, PartialEq)]
pub struct FeedSpec {
    /// Display title: the outline's `text`/`title` attribute, else the host
    /// of the feed URL.
    pub title: String,
    pub url: String,
}

/// Parse an OPML document into the subscription list (in document order,
/// de-duplicated by URL). `Err` on malformed XML.
pub fn parse_opml(body: &str) -> Result<Vec<FeedSpec>, String> {
    let doc = roxmltree::Document::parse(body).map_err(|e| e.to_string())?;
    let root = doc.root_element();
    if root.tag_name().name() != "opml" {
        return Err("not an OPML document".to_string());
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect_outlines(root, &mut out, &mut seen);
    Ok(out)
}

fn collect_outlines(
    node: Node<'_, '_>,
    out: &mut Vec<FeedSpec>,
    seen: &mut std::collections::HashSet<String>,
) {
    for child in node.children().filter(|c| c.is_element()) {
        if child.tag_name().name() == "outline" {
            if let Some(url) = child.attribute("xmlUrl") {
                let url = url.trim().to_string();
                if !url.is_empty() && seen.insert(url.clone()) {
                    let title = child
                        .attribute("text")
                        .or_else(|| child.attribute("title"))
                        .filter(|t| !t.trim().is_empty())
                        .map(|t| t.trim().to_string())
                        .unwrap_or_else(|| host_of(&url));
                    out.push(FeedSpec { title, url });
                }
            }
        }
        collect_outlines(child, out, seen);
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "podcast".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeResult {
    Added,
    AlreadySubscribed,
}

/// Append one feed to the OPML file, creating it when missing. Existing
/// outlines are left in place. A URL already in the file is not written twice.
pub fn add_subscription(
    path: &std::path::Path,
    title: &str,
    url: &str,
) -> Result<SubscribeResult, String> {
    let url = url.trim();
    if !crate::library::is_feed_url(url) {
        return Err("feed URL must be an http(s) address".to_string());
    }
    let title = {
        let title = title.trim();
        if title.is_empty() {
            host_of(url)
        } else {
            title.chars().take(200).collect()
        }
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    if !path.exists() {
        write_atomic(
            path,
            &render_opml(&[FeedSpec {
                title,
                url: url.to_string(),
            }]),
        )?;
        return Ok(SubscribeResult::Added);
    }
    let body =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let existing =
        parse_opml(&body).map_err(|e| format!("could not parse {}: {}", path.display(), e))?;
    if existing.iter().any(|f| f.url == url) {
        return Ok(SubscribeResult::AlreadySubscribed);
    }
    let outline = outline_xml(&title, url);
    let updated = if let Some(at) = body.rfind("</body>") {
        let mut next = String::with_capacity(body.len() + outline.len() + 8);
        next.push_str(&body[..at]);
        if !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str("    ");
        next.push_str(&outline);
        next.push('\n');
        next.push_str(&body[at..]);
        next
    } else {
        let mut feeds = existing;
        feeds.push(FeedSpec {
            title,
            url: url.to_string(),
        });
        render_opml(&feeds)
    };
    write_atomic(path, &updated)?;
    Ok(SubscribeResult::Added)
}

fn outline_xml(title: &str, url: &str) -> String {
    format!(
        r#"<outline type="rss" text="{}" title="{}" xmlUrl="{}"/>"#,
        xml_escape(title),
        xml_escape(title),
        xml_escape(url)
    )
}

fn render_opml(feeds: &[FeedSpec]) -> String {
    let mut body = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head><title>kpod</title></head>\n  <body>\n",
    );
    for feed in feeds {
        body.push_str("    ");
        body.push_str(&outline_xml(&feed.title, &feed.url));
        body.push('\n');
    }
    body.push_str("  </body>\n</opml>\n");
    body
}

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn write_atomic(path: &std::path::Path, body: &str) -> Result<(), String> {
    let tmp = path.with_extension("opml.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPML_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Subscriptions</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Radio Lab" xmlUrl="https://feeds.radiolab.org/radiolab"/>
      <outline type="rss" text="The Daily" xmlUrl="https://feeds.nytimes.com/daily.xml"/>
    </outline>
    <outline type="rss" text="Duplicate" xmlUrl="https://feeds.radiolab.org/radiolab"/>
    <outline type="rss" xmlUrl="https://feeds.example.org/no-title.xml"/>
    <outline text="Just a folder" />
  </body>
</opml>"#;

    #[test]
    fn parses_nested_opml_and_dedupes() {
        let feeds = parse_opml(OPML_FIXTURE).expect("parse");
        assert_eq!(feeds.len(), 3);
        assert_eq!(feeds[0].title, "Radio Lab");
        assert_eq!(feeds[0].url, "https://feeds.radiolab.org/radiolab");
        assert_eq!(feeds[1].title, "The Daily");
        // Duplicate URL is dropped, keeping the first occurrence.
        assert_eq!(feeds[2].title, "feeds.example.org");
        assert_eq!(feeds[2].url, "https://feeds.example.org/no-title.xml");
        assert!(!feeds.iter().any(|f| f.title == "Duplicate"));
    }

    #[test]
    fn empty_opml_is_empty() {
        let feeds =
            parse_opml(r#"<opml version="2.0"><head></head><body></body></opml>"#).expect("parse");
        assert!(feeds.is_empty());
    }

    #[test]
    fn malformed_opml_is_an_error() {
        assert!(parse_opml("<opml><body>").is_err());
        assert!(parse_opml("<html></html>").is_err());
    }

    #[test]
    fn add_subscription_creates_appends_and_dedupes() {
        let path =
            std::env::temp_dir().join(format!("kpod-opml-{}-{}.opml", std::process::id(), "add"));
        let _ = std::fs::remove_file(&path);
        let added = add_subscription(&path, "Radio & Lab", "https://feeds.example.org/a.xml")
            .expect("create");
        assert_eq!(added, SubscribeResult::Added);
        let again =
            add_subscription(&path, "Other", "https://feeds.example.org/a.xml").expect("dup");
        assert_eq!(again, SubscribeResult::AlreadySubscribed);
        let second =
            add_subscription(&path, "", "https://feeds.example.org/b.xml").expect("append");
        assert_eq!(second, SubscribeResult::Added);
        let feeds = parse_opml(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(feeds.len(), 2);
        assert_eq!(feeds[0].title, "Radio & Lab");
        assert_eq!(feeds[1].title, "feeds.example.org");
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("Radio &amp; Lab"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn add_subscription_refuses_to_overwrite_a_broken_file() {
        let path =
            std::env::temp_dir().join(format!("kpod-opml-{}-{}.opml", std::process::id(), "bad"));
        std::fs::write(&path, "<not-opml>").unwrap();
        assert!(add_subscription(&path, "Show", "https://feeds.example.org/a.xml").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<not-opml>");
        assert!(add_subscription(&path, "Show", "notaurl").is_err());
        let _ = std::fs::remove_file(&path);
    }
}
