//! Body HTML sanitizer for creation posts and video descriptions.
//!
//! The allow-list below is a **verbatim copy** of `DESCRIPTION_ALLOWED_TAGS` /
//! `DESCRIPTION_ALLOWED_ATTRS` in `js/creations.js`. Both sides sanitize on
//! purpose: the host so stored bodies are clean on disk and in backups, the
//! page because it renders whatever the host (or an imported JSON) returns.
//! Changing one list without the other silently widens one side, so the two are
//! linked by a comment in both files.
//!
//! Parsing (rather than regex-matching) is what makes the two sides agree: the
//! tree builder is the html5ever that Chromium descended from, so anything the
//! browser would still parse gets seen here too and cannot be smuggled past the
//! allow-list by malformed markup.

use html5ever::tendril::TendrilSink;
use html5ever::tree_builder::TreeBuilderOpts;
use html5ever::{parse_document, ParseOpts};
use markup5ever_rcdom::{Handle, NodeData, RcDom};

const ALLOWED_TAGS: &[&str] = &[
    "a", "b", "strong", "em", "i", "br", "p", "div", "span", "ul", "ol", "li", "h2", "h3", "h4",
    "img", "small", "code", "pre", "blockquote", "hr",
];
const ALLOWED_ATTRS: &[&str] = &["class", "href", "src", "alt", "title", "target", "rel"];
const DROPPED_TAGS: &[&str] = &["script", "style", "iframe", "object", "embed", "form", "input"];

fn allowed_tag(name: &str) -> bool {
    ALLOWED_TAGS.contains(&name)
}

/// Rewrite one attribute value, or drop it. Returns `None` to drop.
fn clean_attr(name: &str, value: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    if !ALLOWED_ATTRS.contains(&lower.as_str()) {
        return None;
    }
    if lower == "href" || lower == "src" {
        let trimmed = value.trim();
        let acceptable = trimmed.starts_with("http://")
            || trimmed.starts_with("https://")
            || trimmed.starts_with('/')
            || trimmed.starts_with("./")
            || trimmed.starts_with('#');
        if !acceptable {
            return None;
        }
    }
    // `target` and `rel` were allow-listed for layout, but an imported body is
    // an untrusted document: `target="_blank"` without `noopener` hands the new
    // tab a `window.opener` reference back into the app. Pin both instead of
    // forwarding whatever the source page wrote.
    if lower == "target" {
        return if value.eq_ignore_ascii_case("_blank") { Some("_blank".to_string()) } else { None };
    }
    if lower == "rel" {
        let kept: Vec<&str> = value
            .split_whitespace()
            .filter(|token| !token.eq_ignore_ascii_case("opener"))
            .collect();
        if kept.is_empty() {
            return None;
        }
        return Some(kept.join(" "));
    }
    Some(value.to_string())
}

fn walk(node: &Handle, out: &mut String) {
    for child in node.children.borrow().iter() {
        match &child.data {
            NodeData::Text { contents } => {
                out.push_str(&escape_text(&contents.borrow()));
            }
            NodeData::Element { name, attrs, .. } => {
                let tag = name.local.to_string();
                if DROPPED_TAGS.contains(&tag.as_str()) {
                    continue;
                }
                if !allowed_tag(&tag) {
                    // Unknown wrapper: keep the content, drop the element.
                    walk(child, out);
                    continue;
                }
                out.push('<');
                out.push_str(&tag);
                for attr in attrs.borrow().iter() {
                    let value = attr.value.to_string();
                    if let Some(clean) = clean_attr(&attr.name.local, &value) {
                        out.push(' ');
                        out.push_str(&attr.name.local);
                        out.push_str("=\"");
                        out.push_str(&escape_attr(&clean));
                        out.push('"');
                    }
                }
                out.push('>');
                if tag == "br" || tag == "hr" || tag == "img" {
                    continue;
                }
                walk(child, out);
                out.push_str("</");
                out.push_str(&tag);
                out.push('>');
            }
            _ => walk(child, out),
        }
    }
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(text: &str) -> String {
    escape_text(text).replace('"', "&quot;")
}

/// Parser options matching the page's `DOMParser`.
///
/// html5ever defaults to `scripting_enabled: true`, which parses a
/// `<noscript>` body as one raw text node: `<noscript><p>x</p></noscript>`
/// then reached the walker as the *text* `<p>x</p>`, was escaped, and the
/// stored body showed literal markup. A `DOMParser` document has scripting
/// disabled, so the frontend sanitizer sees a real `<p>`. Parsing the same way
/// is what keeps the two sanitizers agreeing on the tree, not just on the lists.
fn parse_opts() -> ParseOpts {
    ParseOpts {
        tree_builder: TreeBuilderOpts { scripting_enabled: false, ..TreeBuilderOpts::default() },
        ..ParseOpts::default()
    }
}

/// Whitelist-sanitize a body fragment.
pub fn sanitize_body(html: &str) -> String {
    let dom = parse_document(RcDom::default(), parse_opts())
        .from_utf8()
        .read_from(&mut html.as_bytes())
        .unwrap_or_else(|_| parse_document(RcDom::default(), parse_opts()).one(html));
    let mut out = String::new();
    // The fragment parser wraps everything in <html><body>; start from body.
    if let Some(body) = find_body(&dom.document) {
        walk(&body, &mut out);
    } else {
        walk(&dom.document, &mut out);
    }
    out.trim().to_string()
}

fn find_body(node: &Handle) -> Option<Handle> {
    for child in node.children.borrow().iter() {
        if let NodeData::Element { name, .. } = &child.data {
            if name.local.as_ref() == "body" {
                return Some(child.clone());
            }
        }
        if let Some(found) = find_body(child) {
            return Some(found);
        }
    }
    None
}

/// Plain text (YouTube descriptions) → escaped paragraphs.
///
/// Videos have no markup: the description is text with blank-line paragraphs.
/// Escaping it instead of parsing it keeps a description that happens to contain
/// `<` from turning into a tag.
pub fn plain_text_to_html(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    normalized
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .map(|block| format!("<p>{}</p>", escape_text(block)))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_body_drops_script_iframe_and_event_attributes() {
        let cleaned = sanitize_body(
            r#"<p onclick="steal()">hi <script>alert(1)</script><iframe src="//evil"></iframe></p>"#,
        );
        assert!(!cleaned.contains("script"), "{cleaned}");
        assert!(!cleaned.contains("iframe"), "{cleaned}");
        assert!(!cleaned.contains("onclick"), "{cleaned}");
        assert!(cleaned.contains("hi"));
    }

    #[test]
    fn keeps_whitelisted_structure_and_unwraps_unknown_tags() {
        let cleaned = sanitize_body(r#"<div><font color="red">x</font><ul><li>y</li></ul></div>"#);
        assert!(cleaned.contains("<div>"), "{cleaned}");
        assert!(cleaned.contains("<ul>"), "{cleaned}");
        assert!(cleaned.contains("<li>"), "{cleaned}");
        assert!(!cleaned.contains("<font"), "{cleaned}");
        assert!(cleaned.contains('x'));
    }

    #[test]
    fn rejects_javascript_urls_but_keeps_http_and_relative() {
        let cleaned = sanitize_body(
            r#"<a href="javascript:alert(1)">a</a><a href="https://x.test/">b</a><img src="./inline/1.png">"#,
        );
        assert!(!cleaned.contains("javascript:"), "{cleaned}");
        assert!(cleaned.contains("https://x.test/"));
        assert!(cleaned.contains("./inline/1.png"));
    }

    #[test]
    fn plain_text_becomes_paragraphs_and_escapes_markup() {
        let html = plain_text_to_html("line one\n\nline <b>two</b>");
        assert_eq!(html, "<p>line one</p>\n<p>line &lt;b&gt;two&lt;/b&gt;</p>");
    }

    /// Found diffing against the frontend sanitizer: with html5ever's default
    /// `scripting_enabled: true` a `<noscript>` body was raw text, so the stored
    /// HTML displayed `<p>…</p>` as literal characters.
    #[test]
    fn noscript_content_is_parsed_like_the_page_parses_it() {
        let cleaned = sanitize_body("<noscript><p>shown <b>bold</b></p></noscript><p>after</p>");
        assert_eq!(cleaned, "<p>shown <b>bold</b></p><p>after</p>");
        assert!(!cleaned.contains("&lt;"), "{cleaned}");
        // Raw-text elements the page also treats as text stay escaped text.
        let textarea = sanitize_body("<textarea>a <b>x</b></textarea>");
        assert_eq!(textarea, "a &lt;b&gt;x&lt;/b&gt;");
    }

    /// An imported body is untrusted: `target="_blank"` must not keep an
    /// `opener` rel, or the opened page can reach back into the app window.
    #[test]
    fn target_and_rel_cannot_keep_opener() {
        let cleaned = sanitize_body(
            r#"<a href="https://x.test/" target="_blank" rel="noopener opener">a</a><a href="https://x.test/" target="_self">b</a>"#,
        );
        assert!(cleaned.contains("target=\"_blank\""), "{cleaned}");
        // `noopener` contains the substring "opener", so compare the exact rel
        // value rather than searching for the token.
        assert!(cleaned.contains("rel=\"noopener\""), "{cleaned}");
        assert!(!cleaned.contains("rel=\"noopener opener\""), "{cleaned}");
        assert!(!cleaned.contains("_self"), "{cleaned}");
    }
}
