//! Auth and media signatures (`host-server.mjs` signing block).
//!
//! Why signed URLs at all: `<audio src>` and `<img src>` cannot attach an
//! `Authorization` header, so media needs its own credential. A short-lived HMAC
//! over `(entryId, expires)` keeps the long-lived bearer token out of browser
//! history, logs and the media element's URL.
//!
//! Both bounds matter. Rejecting only `expires < now` would accept a URL signed
//! for a decade, making the "short-lived" claim false; `expires > now + ttl + 5s`
//! is what actually bounds it. The 5 s slack absorbs clock skew between the
//! signing call and the fetch.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use storage_core::hash::hex;

type HmacSha256 = Hmac<Sha256>;

/// Default media URL lifetime: 10 minutes.
pub const DEFAULT_MEDIA_TTL_MS: i64 = 10 * 60 * 1000;

/// Signature over `entryId + "\n" + expires`, hex-encoded.
///
/// The newline separator is load-bearing: without it `("ab", 12)` and `("a", 112)`
/// would produce the same message.
pub fn sign_entry(token: &str, entry_id: &str, expires: i64) -> String {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(entry_id.as_bytes());
    mac.update(b"\n");
    mac.update(expires.to_string().as_bytes());
    hex(&mac.finalize().into_bytes())
}

/// Extract the entry id from a `/media/<id>` path.
///
/// Rejects a raw `/` or `\` and NUL: a media URL is a single opaque segment, and
/// allowing separators would let the id address a nested resource.
pub fn media_entry_from_path(path: &str) -> Option<String> {
    let raw = path.strip_prefix("/media/")?;
    if raw.is_empty() || raw.contains('/') || raw.contains('\\') {
        return None;
    }
    let decoded = percent_decode(raw)?;
    if decoded.is_empty() || decoded.contains('/') || decoded.contains('\\') || decoded.contains('\0') {
        return None;
    }
    Some(decoded)
}

/// Build a signed media path, or return the unsigned path when auth is disabled.
pub fn sign_media_path(token: Option<&str>, media_path: &str, ttl_ms: i64, now_ms: i64) -> String {
    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return media_path.to_string();
    };
    let Some(entry_id) = media_entry_from_path(media_path) else {
        return media_path.to_string();
    };
    let expires = now_ms + ttl_ms;
    let signature = sign_entry(token, &entry_id, expires);
    format!(
        "/media/{}?expires={expires}&sig={signature}",
        percent_encode(&entry_id)
    )
}

/// Validate a signed media URL.
///
/// Returns `false` when auth is disabled: media routes then rely on the
/// loopback-only bind, and treating "no token" as "any signature is valid" would
/// be a fail-open.
pub fn valid_media_signature(token: Option<&str>, entry_id: &str, expires: i64, signature: &str, ttl_ms: i64, now_ms: i64) -> bool {
    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return false;
    };
    if expires < now_ms || expires > now_ms + ttl_ms + 5000 {
        return false;
    }
    let expected = sign_entry(token, entry_id, expires);
    let expected_bytes = expected.as_bytes();
    let actual_bytes = signature.as_bytes();
    // `ConstantTimeEq` needs equal lengths; the length check leaks only the
    // signature length, which is fixed for a given encoding.
    actual_bytes.len() == expected_bytes.len() && expected_bytes.ct_eq(actual_bytes).into()
}

/// Bearer token comparison in constant time.
pub fn bearer_authorized(header: Option<&str>, token: Option<&str>) -> bool {
    let Some(expected) = token.filter(|value| !value.is_empty()) else {
        // No token configured: everything is authorized (local compatibility).
        return true;
    };
    let Some(header) = header else { return false };
    let Some(supplied) = header.strip_prefix("Bearer ") else { return false };
    supplied.as_bytes().len() == expected.as_bytes().len()
        && expected.as_bytes().ct_eq(supplied.as_bytes()).into()
}

/// Percent-decode a path segment; `None` on malformed escapes.
pub fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                if index + 2 >= bytes.len() {
                    return None;
                }
                let high = hex_value(bytes[index + 1])?;
                let low = hex_value(bytes[index + 2])?;
                out.push(high * 16 + low);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Percent-encode a path segment (ID characters only).
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

/// Current wall clock in milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_is_stable_and_separator_matters() {
        let a = sign_entry("token", "entry-1", 1_700_000_000_000);
        assert_eq!(a, sign_entry("token", "entry-1", 1_700_000_000_000));
        assert_ne!(a, sign_entry("token", "entry-2", 1_700_000_000_000));
        assert_ne!(a, sign_entry("token", "entry-1", 1_700_000_000_001));
        // Without the \n separator these two pairs would collide.
        assert_ne!(sign_entry("t", "ab", 12), sign_entry("t", "a", 112));
    }

    #[test]
    fn path_signing_and_validation_round_trip() {
        let now = 1_700_000_000_000;
        let signed = sign_media_path(Some("secret"), "/media/abc", DEFAULT_MEDIA_TTL_MS, now);
        assert!(signed.starts_with("/media/abc?expires="));
        // The server passes the pathname without its query, like Node's `url.pathname`.
        let pathname = signed.split('?').next().unwrap();
        let entry = media_entry_from_path(pathname).unwrap();
        assert_eq!(entry, "abc");
        let expires: i64 = signed
            .split("expires=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let sig = signed.split("sig=").nth(1).unwrap();
        assert!(valid_media_signature(Some("secret"), "abc", expires, sig, DEFAULT_MEDIA_TTL_MS, now));
        // Expired.
        assert!(!valid_media_signature(Some("secret"), "abc", expires, sig, DEFAULT_MEDIA_TTL_MS, now + 11 * 60 * 1000));
        // Future beyond ttl + skew: rejected even though it is not expired.
        assert!(!valid_media_signature(Some("secret"), "abc", expires, sig, DEFAULT_MEDIA_TTL_MS, now - 60 * 1000));
        // Wrong token.
        assert!(!valid_media_signature(Some("other"), "abc", expires, sig, DEFAULT_MEDIA_TTL_MS, now));
        // Wrong entry.
        assert!(!valid_media_signature(Some("secret"), "abcd", expires, sig, DEFAULT_MEDIA_TTL_MS, now));
    }

    #[test]
    fn no_token_means_unsigned_path_and_no_signature_acceptance() {
        assert_eq!(sign_media_path(None, "/media/abc", DEFAULT_MEDIA_TTL_MS, 0), "/media/abc");
        // Signatures are never valid without a token: fail closed.
        assert!(!valid_media_signature(None, "abc", 0, "deadbeef", DEFAULT_MEDIA_TTL_MS, 0));
        // But bearer auth is open, matching Node's local default.
        assert!(bearer_authorized(None, None));
    }

    #[test]
    fn bearer_is_constant_time_and_exact() {
        assert!(bearer_authorized(Some("Bearer abc"), Some("abc")));
        assert!(!bearer_authorized(Some("Bearer abd"), Some("abc")));
        assert!(!bearer_authorized(Some("abc"), Some("abc")));
        assert!(!bearer_authorized(None, Some("abc")));
    }

    #[test]
    fn media_ids_reject_separators() {
        assert_eq!(media_entry_from_path("/media/a%20b").as_deref(), Some("a b"));
        assert!(media_entry_from_path("/media/a/b").is_none());
        assert!(media_entry_from_path("/media/a%2Fb").is_none());
        assert!(media_entry_from_path("/media/").is_none());
        assert!(media_entry_from_path("/media/a%zz").is_none());
    }
}
