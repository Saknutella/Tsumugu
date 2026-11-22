//! Path redaction for responses (`host-server.mjs::redactText/redactValue`).
//!
//! The frontend must never receive a machine path: evidence files are committed
//! and the UI shows these strings. Redaction happens at the response boundary, so
//! an error thrown deep in the storage layer still cannot leak a root.
//!
//! Scanners work on `char`s, not bytes: a byte-wise copy (`byte as char`) turns
//! every non-ASCII title in a response into mojibake.

use serde_json::Value;

/// Replace known roots with `<root>`, then scrub any remaining absolute token.
pub fn redact_text(value: &str, roots: &[String]) -> String {
    let mut text = value.to_string();
    let mut ordered: Vec<&String> = roots.iter().filter(|root| !root.is_empty()).collect();
    ordered.sort_by_key(|root| std::cmp::Reverse(root.len()));
    for root in ordered {
        text = text.replace(root.as_str(), "<root>");
        let slashed = root.replace('\\', "/");
        if slashed != *root {
            text = text.replace(slashed.as_str(), "<root>");
        }
    }
    text = scrub_windows_paths(&text);
    scrub_posix_paths(&text)
}

/// Characters that end a path token: Node's `[^\s"'<>]`. Stopping earlier (at
/// `,` or `)`) would leak the tail of a path that contains them.
fn ends_token(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>')
}

/// Replace `C:\...` / `C:/...` tokens.
///
/// Deviation D6: Node's `/[A-Za-z]:[\\/]/` has no left boundary, so the `s:/`
/// inside `https://` matched and every URL in a POST response became
/// `http<path>`. Here a drive letter must not follow a letter or digit.
fn scrub_windows_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let is_drive = chars[index].is_ascii_alphabetic()
            && (index == 0 || !chars[index - 1].is_alphanumeric())
            && chars.get(index + 1) == Some(&':')
            && matches!(chars.get(index + 2), Some('\\') | Some('/'));
        if is_drive {
            out.push_str("<path>");
            index += 3;
            while index < chars.len() && !ends_token(chars[index]) {
                index += 1;
            }
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// Replace POSIX absolute path tokens at the start or after whitespace,
/// `(`, `"`, `'`, `=` (Node's `(^|[\s("'=])\/`). A URL path such as
/// `https://host/api/x` follows a letter or `/`, so it is left intact.
fn scrub_posix_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let boundary = index == 0
            || chars[index - 1].is_whitespace()
            || matches!(chars[index - 1], '(' | '"' | '\'' | '=');
        if ch == '/' && boundary && chars.get(index + 1) != Some(&'/') {
            out.push_str("<path>");
            index += 1;
            while index < chars.len() && !ends_token(chars[index]) {
                index += 1;
            }
            continue;
        }
        out.push(ch);
        index += 1;
    }
    out
}

/// Recursively redact every string in a JSON value.
pub fn redact_value(value: &Value, roots: &[String]) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text(text, roots)),
        Value::Array(items) => Value::Array(items.iter().map(|item| redact_value(item, roots)).collect()),
        Value::Object(object) => {
            let mut clone = serde_json::Map::new();
            for (key, item) in object {
                clone.insert(key.clone(), redact_value(item, roots));
            }
            Value::Object(clone)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_roots_are_replaced_in_both_separator_styles() {
        let roots = vec![r"N:\Data\Library".to_string()];
        let text = redact_text(r"failed at N:\Data\Library\work\a.mp3", &roots);
        assert!(text.contains("<root>"));
        assert!(!text.contains(r"N:\Data"));
        let slashed = redact_text("failed at N:/Data/Library/work/a", &roots);
        assert!(slashed.contains("<root>"));
    }

    #[test]
    fn unknown_absolute_paths_are_scrubbed() {
        let text = redact_text("cannot open C:\\Users\\someone\\secret.txt", &[]);
        assert!(!text.contains("Users"), "{text}");
        let posix = redact_text("cannot open /home/someone/secret.txt", &[]);
        assert!(!posix.contains("someone"), "{posix}");
    }

    #[test]
    fn urls_are_not_mangled() {
        // D6: Node turns this into `GET http<path> failed`.
        let text = redact_text("GET https://example.invalid/media/abc failed", &[]);
        assert!(text.contains("https://example.invalid/media/abc"), "{text}");
    }

    #[test]
    fn non_ascii_text_survives_redaction() {
        let text = redact_text("作品「夏の思い出」 at C:\\lib\\夏.mp3", &[]);
        assert_eq!(text, "作品「夏の思い出」 at <path>");
    }

    #[test]
    fn path_tail_after_comma_is_not_leaked() {
        let text = redact_text("open C:\\dir,name\\secret failed", &[]);
        assert_eq!(text, "open <path> failed");
    }

    #[test]
    fn values_are_redacted_deeply() {
        let value = serde_json::json!({
            "path": r"C:\secret\a",
            "nested": [{ "p": "/home/u/x" }],
            "number": 1
        });
        let redacted = redact_value(&value, &[]);
        assert!(!redacted.to_string().contains("secret\\a"));
        assert_eq!(redacted["number"], 1);
    }
}
