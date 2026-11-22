//! Outbound HTTP for the host: cover images and resumable downloads.
//!
//! Node uses the global `fetch`. Here it is `reqwest` (blocking) over rustls
//! with the `ring` provider: pure Rust plus a small C/asm core that every
//! target already builds, no OpenSSL, no system TLS library and no CMake/NASM
//! (rustls' default `aws-lc-rs` provider needs those). Trust roots come from
//! the platform verifier, so a corporate proxy CA installed in the OS works the
//! same as it does for Node's `fetch`.
//!
//! Every call is synchronous on purpose: host operations already run on a
//! blocking worker thread (`spawn_blocking` in the HTTP crate), so an async
//! client would only add a nested runtime.

use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use storage_core::error::{Error, Result};

/// Same 15 s budget as Node's `AbortSignal.timeout(15000)` for cover fetches.
pub const COVER_TIMEOUT: Duration = Duration::from_secs(15);

/// Install the ring provider once per process. `install_default` fails if a
/// provider is already set, which is fine: any installed provider works.
fn ensure_provider() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn client(timeout: Option<Duration>) -> Result<reqwest::blocking::Client> {
    ensure_provider();
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(concat!("monochrome-storage-host/", env!("CARGO_PKG_VERSION")))
        // Never let the client transparently decompress: downloads hash the
        // exact bytes on the wire, and covers are binary images anyway.
        .no_gzip()
        .no_brotli()
        .no_deflate();
    builder = match timeout {
        Some(limit) => builder.timeout(limit),
        None => builder.timeout(None::<Duration>),
    };
    builder
        .build()
        .map_err(|error| Error::new(format!("http client init failed: {error}")))
}

/// `http:`/`https:` only, like Node's `['http:', 'https:'].includes(url.protocol)`.
pub fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Result of a bounded GET.
pub struct Fetched {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// GET `url` with a timeout and a hard size cap.
///
/// The cap is enforced while reading, not after: a hostile or broken server
/// that streams forever must not exhaust memory before the size check.
pub fn get_bounded(url: &str, max_bytes: usize, timeout: Duration) -> Result<Fetched> {
    if !is_http_url(url) {
        return Err(Error::bad_request("URL must be http(s)"));
    }
    let response = client(Some(timeout))?
        .get(url)
        .send()
        .map_err(|error| Error::new(format!("request failed: {error}")))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut body = Vec::new();
    response
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|error| Error::new(format!("response read failed: {error}")))?;
    if body.len() > max_bytes {
        return Err(Error::coded("ETOOLARGE", format!("response exceeds {max_bytes} bytes")));
    }
    Ok(Fetched { status, content_type, body })
}

//// Hops followed by [`get_bounded_public`] before giving up.
const MAX_PUBLIC_REDIRECTS: usize = 5;

/// Whether an address is reachable on the public internet.
///
/// `IpAddr::is_global` is still unstable, so the reserved ranges are listed
/// here. The list is about what a *client-supplied* URL must never reach from
/// the host machine: loopback (the host's own API and every other local
/// service), RFC 1918 / ULA (the LAN, the router admin page), link-local
/// (cloud metadata at 169.254.169.254), CGNAT, multicast and the
/// unspecified/broadcast addresses.
pub fn is_public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (18..=19).contains(&b))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let segments = v6.segments();
            // NAT64 (64:ff9b::/96) embeds an IPv4 address; judge that one.
            if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let embedded = std::net::Ipv4Addr::new(
                    (segments[6] >> 8) as u8,
                    segments[6] as u8,
                    (segments[7] >> 8) as u8,
                    segments[7] as u8,
                );
                return is_public_ip(IpAddr::V4(embedded));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

/// Addresses a public fetch is pinned to: `(domain, addrs)` for a name.
type Pinned = Option<(String, Vec<std::net::SocketAddr>)>;

/// Parse a URL and resolve its host to the public addresses it may be fetched from.
///
/// Parsing goes through the WHATWG parser (`reqwest::Url`), so `127.1`,
/// `0x7f000001` and `2130706433` are all normalised to `127.0.0.1` before the
/// check; string matching on the raw URL would miss every one of them. A host
/// that resolves to *any* non-public address is refused, not just filtered: a
/// name that mixes both is exactly what a DNS-rebinding attempt looks like.
pub fn public_target(url: &str) -> Result<(reqwest::Url, Pinned)> {
    use std::net::ToSocketAddrs;
    if !is_http_url(url) {
        return Err(Error::bad_request("URL must be http(s)"));
    }
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| Error::bad_request("URL is not valid"))?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let blocked = || Error::coded("EBLOCKEDURL", "URL points at a loopback, private or link-local address");
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => {
            if !is_public_ip(ip.into()) {
                return Err(blocked());
            }
            Ok((parsed, None))
        }
        Some(url::Host::Ipv6(ip)) => {
            if !is_public_ip(ip.into()) {
                return Err(blocked());
            }
            Ok((parsed, None))
        }
        Some(url::Host::Domain(domain)) => {
            let domain = domain.to_string();
            let lower = domain.trim_end_matches('.').to_ascii_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") {
                return Err(blocked());
            }
            let addrs: Vec<std::net::SocketAddr> = (lower.as_str(), port)
                .to_socket_addrs()
                .map_err(|error| Error::new(format!("cannot resolve {lower}: {error}")))?
                .collect();
            if addrs.is_empty() {
                return Err(Error::new(format!("cannot resolve {lower}")));
            }
            if addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
                return Err(blocked());
            }
            Ok((parsed, Some((domain, addrs))))
        }
        None => Err(Error::bad_request("URL has no host")),
    }
}

/// [`get_bounded`] restricted to public addresses (post assets from a URL).
///
/// Used where the URL comes from a request body: without it, `cache-remote`
/// lets any caller make the host GET `127.0.0.1:<port>` (its own API), the LAN
/// or a cloud metadata endpoint, and store the answer as a "thumbnail" the
/// client can read back.
///
/// Two gaps the address check alone would leave are closed here:
/// - **DNS rebinding**: the addresses that passed the check are pinned into the
///   client (`resolve_to_addrs`), so the connection cannot go to a second,
///   different answer for the same name.
/// - **Redirects**: automatic redirects are off; each `Location` is re-checked
///   and pinned the same way, at most [`MAX_PUBLIC_REDIRECTS`] times.
///
/// Not covered: an HTTP(S) proxy configured through the environment resolves
/// names itself, so with a proxy the pinning is the proxy's job.
pub fn get_bounded_public(url: &str, max_bytes: usize, timeout: Duration) -> Result<Fetched> {
    let mut current = url.trim().to_string();
    for _ in 0..=MAX_PUBLIC_REDIRECTS {
        let (parsed, pinned) = public_target(&current)?;
        ensure_provider();
        let mut builder = reqwest::blocking::Client::builder()
            .user_agent(concat!("monochrome-storage-host/", env!("CARGO_PKG_VERSION")))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout);
        if let Some((domain, addrs)) = &pinned {
            builder = builder.resolve_to_addrs(domain, addrs);
        }
        let client = builder
            .build()
            .map_err(|error| Error::new(format!("http client init failed: {error}")))?;
        let response = client
            .get(parsed.clone())
            .send()
            .map_err(|error| Error::new(format!("request failed: {error}")))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| Error::new(format!("redirect {status} without a Location")))?;
            current = parsed
                .join(location)
                .map_err(|_| Error::new("redirect Location is not a valid URL"))?
                .to_string();
            continue;
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let mut body = Vec::new();
        response
            .take(max_bytes as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|error| Error::new(format!("response read failed: {error}")))?;
        if body.len() > max_bytes {
            return Err(Error::coded("ETOOLARGE", format!("response exceeds {max_bytes} bytes")));
        }
        return Ok(Fetched { status, content_type, body });
    }
    Err(Error::new(format!("more than {MAX_PUBLIC_REDIRECTS} redirects")))
}

// Response head + streaming body for the download pipeline.
pub struct Streaming {
    pub status: u16,
    pub etag: String,
    pub last_modified: String,
    pub content_range: String,
    pub content_length: Option<u64>,
    pub body: reqwest::blocking::Response,
}

/// GET with explicit request headers and no overall timeout (downloads can be
/// large; the caller bounds them by `expectedBytes` instead).
pub fn get_streaming(url: &str, headers: &[(&str, String)]) -> Result<Streaming> {
    let mut request = client(None)?.get(url);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    let response = request
        .send()
        .map_err(|error| Error::coded("EHTTP", format!("download request failed: {error}")))?;
    let header = |name: reqwest::header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let etag = header(reqwest::header::ETAG);
    let last_modified = header(reqwest::header::LAST_MODIFIED);
    let content_range = header(reqwest::header::CONTENT_RANGE);
    let content_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    Ok(Streaming {
        status: response.status().as_u16(),
        etag,
        last_modified,
        content_range,
        content_length,
        body: response,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// One-shot loopback HTTP server: answers the first request with `reply`.
    fn serve_once(reply: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 2048];
                let _ = std::io::Read::read(&mut stream, &mut buffer);
                let _ = stream.write_all(&reply);
            }
        });
        format!("http://{address}/x")
    }

    #[test]
    fn only_http_schemes_are_accepted() {
        assert!(is_http_url("https://example.invalid/a.jpg"));
        assert!(is_http_url("HTTP://example.invalid/a.jpg"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(get_bounded("file:///x", 10, COVER_TIMEOUT).is_err());
    }

    #[test]
    fn bounded_get_reads_body_and_type() {
        let url = serve_once(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd".to_vec());
        let fetched = get_bounded(&url, 1024, COVER_TIMEOUT).unwrap();
        assert_eq!(fetched.status, 200);
        assert_eq!(fetched.content_type, "image/png");
        assert_eq!(fetched.body, b"abcd");
    }

    #[test]
    fn bounded_get_enforces_the_cap_while_reading() {
        let url = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n0123456789".to_vec());
        let error = get_bounded(&url, 4, COVER_TIMEOUT).err().unwrap();
        assert_eq!(error.code, Some("ETOOLARGE"));
    }

    #[test]
    fn public_fetch_refuses_loopback_private_and_link_local() {
        // A live loopback server proves the refusal happens before connecting:
        // with the check missing, the request would succeed and return "abcd".
        let url = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd".to_vec());
        let error = get_bounded_public(&url, 1024, COVER_TIMEOUT).err().unwrap();
        assert_eq!(error.code, Some("EBLOCKEDURL"), "{error:?}");
        for blocked in [
            "http://localhost/x",
            "http://LOCALHOST./x",
            "http://api.localhost/x",
            "http://127.1/x",
            "http://0x7f000001/x",
            "http://2130706433/x",
            "http://0.0.0.0/x",
            "http://10.1.2.3/x",
            "http://172.16.0.1/x",
            "http://192.168.1.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/x",
            "http://[::1]/x",
            "http://[fe80::1]/x",
            "http://[fd00::1]/x",
            "http://[::ffff:127.0.0.1]/x",
            "http://[64:ff9b::a9fe:a9fe]/x",
        ] {
            let error = get_bounded_public(blocked, 1024, COVER_TIMEOUT).err().unwrap();
            assert_eq!(error.code, Some("EBLOCKEDURL"), "{blocked}: {error:?}");
        }
        assert!(get_bounded_public("file:///etc/passwd", 10, COVER_TIMEOUT).is_err());
    }

    #[test]
    fn public_ip_classification() {
        use std::net::IpAddr;
        let public: IpAddr = "93.184.216.34".parse().unwrap();
        assert!(is_public_ip(public));
        let public6: IpAddr = "2606:4700::1111".parse().unwrap();
        assert!(is_public_ip(public6));
        for private in ["127.0.0.1", "10.0.0.1", "192.168.0.1", "169.254.1.1", "::1", "fc00::1", "fe80::1", "224.0.0.1"] {
            assert!(!is_public_ip(private.parse().unwrap()), "{private}");
        }
    }
}
