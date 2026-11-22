//! The storage host HTTP server (`host-server.mjs`).
//!
//! Route set, method rules, CORS headers, error envelope and status mapping are
//! the compatibility surface: the frontend only branches on `response.ok`,
//! `json.ok` for `/health`, `206` for the WAV probe, and `error.message`. Every
//! other difference is invisible to it — but the differential harness compares
//! bodies, so the JSON shapes must match too.
//!
//! Concurrency model: `Host` owns one SQLite connection; handlers that touch it
//! run under a mutex on a blocking thread. The Node host is equally serialized
//! (`DatabaseSync` on one thread), so this is behaviour-preserving rather than a
//! compromise.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{ALLOW, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, RANGE};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::net::TcpListener;
use tokio_util::io::ReaderStream;

use storage_core::error::Error as HostError;
use storage_host::host::{Host, HostOptions};

use crate::auth::{
    bearer_authorized, media_entry_from_path, now_ms, percent_decode, sign_media_path,
    valid_media_signature, DEFAULT_MEDIA_TTL_MS,
};
use crate::media::{media_cors_headers, media_error, parse_range, resolve_asset, RangeDecision};
use crate::redact::{redact_text, redact_value};

/// Maximum JSON body, matching Node's 2 MiB cap.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Maximum upload chunk stream, matching Node's 8 GiB cap.
const MAX_UPLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Maximum creation asset upload, matching Node's 1 GiB cap.
const MAX_CREATION_BYTES: u64 = 1024 * 1024 * 1024;
/// Static allow-list, identical to `STATIC_FILES`.
const STATIC_FILES: &[(&str, &str)] = &[
    ("/", "index.html"),
    ("/index.html", "index.html"),
    ("/app.js", "app.js"),
    ("/style.css", "style.css"),
];

/// Methods allowed by CORS.
const ALLOW_METHODS: &str = "GET, HEAD, POST, OPTIONS";
/// Request headers allowed by CORS; all six custom upload headers are required or
/// preflight fails for every upload.
const ALLOW_HEADERS: &str = "Content-Type, Authorization, X-Relative-Path, X-Upload-Offset, X-Creation-Post, X-Creation-Attachment, X-Creation-Role, X-Creation-Name";

/// Server options (`createHostServer` options).
#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub host: String,
    pub port: u16,
    pub allow_non_loopback: bool,
    pub token: Option<String>,
    pub media_ttl_ms: i64,
    pub ui_root: Option<PathBuf>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 0,
            allow_non_loopback: false,
            token: None,
            media_ttl_ms: DEFAULT_MEDIA_TTL_MS,
            ui_root: None,
        }
    }
}

/// Shared server state.
pub struct State {
    pub host: Mutex<Host>,
    pub token: Option<String>,
    pub media_ttl_ms: i64,
    pub ui_root: PathBuf,
    pub allow_non_loopback: bool,
}

/// A running server.
pub struct RunningServer {
    pub url: String,
    pub port: u16,
    pub shutdown: tokio::sync::oneshot::Sender<()>,
    pub join: tokio::task::JoinHandle<()>,
}

/// Start the server; resolves once the listener is bound.
pub async fn start(host: Host, options: ServerOptions) -> Result<RunningServer, String> {
    // Drop abandoned `<work>/tmp/import-*` staging trees from interrupted
    // downloads (Node: `createHostServer` → `cleanupImportTemps()`). Only
    // `import-*` children are touched; user tmp data is kept. Best-effort.
    if let Err(error) = host.cleanup_import_temps("") {
        eprintln!("host import temp cleanup skipped: {}", error.message);
    }
    let bind = if options.allow_non_loopback {
        options.host.clone()
    } else if matches!(options.host.as_str(), "127.0.0.1" | "::1" | "localhost") {
        if options.host == "localhost" { "127.0.0.1".to_string() } else { options.host.clone() }
    } else {
        return Err("host must be a loopback address".to_string());
    };
    let ui_root = options
        .ui_root
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../verify/storage-lab/ui"));
    let state = Arc::new(State {
        host: Mutex::new(host),
        token: options.token.clone().filter(|value| !value.is_empty()),
        media_ttl_ms: options.media_ttl_ms,
        ui_root,
        allow_non_loopback: options.allow_non_loopback,
    });

    let listener = TcpListener::bind((bind.as_str(), options.port))
        .await
        .map_err(|error| format!("listen failed: {error}"))?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let url = format!("http://{}:{}", address.ip(), address.port());
    let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let task_state = Arc::clone(&state);
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, peer)) = accepted else { continue };
                    let state = Arc::clone(&task_state);
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);
                        let service = service_fn(move |request| {
                            let state = Arc::clone(&state);
                            async move { Ok::<_, Infallible>(handle(state, request, peer).await) }
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .timer(TokioTimer::new())
                            .serve_connection(io, service)
                            .await;
                    });
                }
            }
        }
    });

    Ok(RunningServer { url, port: address.port(), shutdown, join })
}

type Body = BoxBody<Bytes, std::io::Error>;

fn empty_body() -> Body {
    Full::new(Bytes::new()).map_err(|never| match never {}).boxed()
}

fn full_body(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|never| match never {}).boxed()
}

fn cors_headers(builder: hyper::http::response::Builder) -> hyper::http::response::Builder {
    builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", ALLOW_METHODS)
        .header("Access-Control-Allow-Headers", ALLOW_HEADERS)
        .header("Access-Control-Max-Age", "600")
}

/// Every `/api/*` path Node routes (`API_ROUTES`). An unknown path is 404
/// before the method check, so `GET /api/nope` and `POST /api/nope` agree.
const API_ROUTES: &[&str] = &[
    "/api/scan", "/api/import", "/api/import/status", "/api/move", "/api/import/file",
    "/api/import-temp/cleanup", "/api/works/open", "/api/works/normalize-root",
    "/api/works/delete-files", "/api/works/delete", "/api/works/metadata", "/api/voices/bundle",
    "/api/voices/reconcile", "/api/works/cover", "/api/upload",
    "/api/creations/upload", "/api/creations/import", "/api/creations/delete",
    "/api/creations/delete-asset", "/api/creations", "/api/cleanup/preview", "/api/cleanup",
    "/api/works", "/api/backup", "/api/restore", "/api/export", "/api/verify", "/api/download",
    // v8 `post` storage, category `video`. `/api/creations*` above keeps the
    // legacy `creation_post` shape because the creations page depends on it.
    "/api/videos", "/api/videos/import", "/api/videos/delete", "/api/videos/delete-asset",
    "/api/videos/attach", "/api/videos/fetch", "/api/videos/cache-remote",
];

/// `/api/videos/<segment>` names that are POST routes, never a post id.
const VIDEO_RESERVED: &[&str] = &["import", "delete", "delete-asset", "attach", "fetch", "cache-remote", "media"];

fn json_response(status: StatusCode, payload: &Value) -> Response<Body> {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    let builder = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header("Content-Length", body.len().to_string())
        .header(CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    cors_headers(builder).body(full_body(body)).unwrap()
}

fn send_error(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    json_response(status, &json!({ "ok": false, "error": { "code": code, "message": message } }))
}

/// Map an error code to an HTTP status (`errorStatus`).
///
/// Deviation D1: Node leaves `ENOTFOUND` out of the list, so a missing work
/// returned 500. 404 is the documented intent and what the frontend's retry logic
/// assumes.
fn error_status(error: &HostError) -> (StatusCode, &'static str) {
    match error.code_or_internal() {
        "ECONFLICT" | "EIDEMPOTENCYCONFLICT" => (StatusCode::CONFLICT, error.code_or_internal()),
        "ENOTFOUND" | "ENOLIBRARY" => (StatusCode::NOT_FOUND, "ENOTFOUND"),
        "ENOENT" | "EOUTSIDE" | "EOUTSIDEROOT" | "EPATHDENIED" | "ELOOPBACK" | "EBADREQUEST"
        | "EBADJSON" | "EINVALIDALLOWEDROOT" | "ELOCKED" | "ELOCKINIT" | "EABORTED"
        | "EQUEUEINVALID" | "EPOSITIONINVALID" | "EDOCUMENTCONFLICT" | "ECATEGORY"
        // A client-supplied URL that resolves to loopback/private/link-local:
        // the request itself is the problem, so 400 rather than 5xx.
        | "EBLOCKEDURL" => {
            (StatusCode::BAD_REQUEST, error.code_or_internal())
        }
        // The external downloader ran past its budget and was killed. 504 says
        // "an upstream step timed out", which is accurate and tells the client
        // a blind retry is likely to time out again.
        "ETIMEOUT" => (StatusCode::GATEWAY_TIMEOUT, "ETIMEOUT"),
        // The feature exists but the operator has not configured it (e.g. no
        // `MONOCHROME_VIDEO_FETCHER`). 500 would read as a host bug and invite
        // retries; 501 tells the client to stop and show a setup hint.
        "ENOTCONFIGURED" => (StatusCode::NOT_IMPLEMENTED, "ENOTCONFIGURED"),
        other => (StatusCode::INTERNAL_SERVER_ERROR, other),
    }
}

async fn read_body(request: Request<Incoming>) -> Result<Map<String, Value>, HostError> {
    let collected = request
        .into_body()
        .collect()
        .await
        .map_err(|error| HostError::bad_request(format!("body read failed: {error}")))?;
    let bytes = collected.to_bytes();
    if bytes.len() > MAX_BODY_BYTES {
        return Err(HostError::bad_request("request body too large"));
    }
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(HostError::bad_request("JSON body must be an object")),
        Err(_) => Err(HostError::bad_json("invalid JSON request body")),
    }
}

/// JavaScript `String(value)`: `null` -> "null", `true` -> "true".
///
/// Node maps id lists with `.map(String)`; matching it keeps a client that
/// sends `[null]` getting the same per-id result from both backends.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

fn require_string(body: &Map<String, Value>, name: &str) -> Result<String, HostError> {
    match body.get(name).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.to_string()),
        _ => Err(HostError::bad_request(format!("{name} is required"))),
    }
}

/// The per-request dispatcher.
async fn handle(state: Arc<State>, request: Request<Incoming>, peer: SocketAddr) -> Response<Body> {
    if !state.allow_non_loopback && !is_loopback(peer.ip()) {
        return send_error(StatusCode::FORBIDDEN, "ELOOPBACK", "loopback clients only");
    }
    let method = request.method().clone();
    let uri = request.uri().clone();
    let raw_path = uri.path().to_string();
    let path = match percent_decode(&raw_path) {
        Some(path) => path,
        None => return send_error(StatusCode::NOT_FOUND, "ENOTFOUND", "not found"),
    };

    if method == Method::OPTIONS {
        let builder = Response::builder().status(StatusCode::NO_CONTENT);
        return cors_headers(builder).body(empty_body()).unwrap();
    }

    // `/health` is reachable before auth so the frontend probe works with no token.
    if path == "/health" || path == "/api/health" {
        if method != Method::GET && method != Method::HEAD {
            return send_error(StatusCode::METHOD_NOT_ALLOWED, "EMETHODNOTALLOWED", "method not allowed");
        }
        // Node: `libraryId: host.libraryId || null`. An unopened library is
        // reported as null, not "", so a probe that checks `libraryId === null`
        // behaves the same against both hosts.
        let library_id = state
            .host
            .lock()
            .map(|host| host.library_id().to_string())
            .unwrap_or_default();
        let library_id = if library_id.is_empty() { Value::Null } else { Value::String(library_id) };
        return json_response(
            StatusCode::OK,
            &json!({
                "ok": true,
                "service": "monochrome-storage-lab",
                "libraryId": library_id,
                // Lets the frontend hide "download video" up front instead of
                // discovering the 501 from `/api/videos/fetch`.
                "videoFetcher": storage_host::posts::VideoFetcher::from_env().is_some(),
            }),
        );
    }

    let is_media = path.starts_with("/media/");
    if (path.starts_with("/api/") || is_media) && !authorized(&state, &request, &uri, is_media) {
        return send_error(StatusCode::UNAUTHORIZED, "EUNAUTHORIZED", "missing or invalid storage token");
    }

    if is_media {
        return handle_media(state, request, &path).await;
    }

    if path == "/api/cleanup/preview" {
        if method != Method::GET {
            return send_error(StatusCode::METHOD_NOT_ALLOWED, "EMETHODNOTALLOWED", "method not allowed");
        }
        return blocking_json_raw(state, |host| host.cleanup_preview().map(payload_response)).await;
    }

    if path == "/api/import/status" {
        if method != Method::GET {
            return send_error(StatusCode::METHOD_NOT_ALLOWED, "EMETHODNOTALLOWED", "method not allowed");
        }
        let batch_id = query_param(&uri, "batchId");
        let Some(batch_id) = batch_id.filter(|value| !value.is_empty()) else {
            return send_error(StatusCode::BAD_REQUEST, "EBADREQUEST", "batchId is required");
        };
        return blocking_json_raw(state, move |host| match host.batch_progress(&batch_id)? {
            Some(progress) => Ok(payload_response(progress)),
            None => Err(HostError::not_found("import batch not found")),
        })
        .await;
    }

    if path == "/api/upload" {
        if method != Method::POST {
            return send_error(StatusCode::METHOD_NOT_ALLOWED, "EMETHODNOTALLOWED", "method not allowed");
        }
        return handle_upload(state, request).await;
    }

    if path == "/api/creations/upload" {
        if method != Method::POST {
            return send_error(StatusCode::METHOD_NOT_ALLOWED, "EMETHODNOTALLOWED", "method not allowed");
        }
        return handle_creation_upload(state, request).await;
    }

    if path == "/api/works" && method == Method::GET {
        let token = state.token.clone();
        let ttl = state.media_ttl_ms;
        return blocking_json_raw(state, move |host| {
            let now = now_ms();
            let works = host.list_works()?;
            let signed = match works {
                Value::Array(items) => Value::Array(
                    items
                        .into_iter()
                        .map(|work| {
                            let mut work = work;
                            if let Some(path) = work.get("coverMediaPath").and_then(Value::as_str) {
                                let signed_path = sign_media_path(token.as_deref(), path, ttl, now);
                                work["coverMediaPath"] = json!(signed_path);
                            }
                            if let Some(entries) = work.get_mut("entries").and_then(Value::as_array_mut) {
                                for entry in entries {
                                    if let Some(path) = entry.get("mediaPath").and_then(Value::as_str) {
                                        let signed_path = sign_media_path(token.as_deref(), path, ttl, now);
                                        entry["mediaPath"] = json!(signed_path);
                                    }
                                }
                            }
                            work
                        })
                        .collect(),
                ),
                other => other,
            };
            Ok((StatusCode::OK, json!({ "ok": true, "result": { "works": signed } })))
        })
        .await;
    }

    if path == "/api/creations" && method == Method::GET {
        return blocking_json_raw(state, |host| {
            let posts = storage_core::creations::list_posts(&host.library.connection)?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": { "posts": posts } })))
        })
        .await;
    }

    if path == "/api/videos" && method == Method::GET {
        let token = state.token.clone();
        let ttl = state.media_ttl_ms;
        return blocking_json_raw(state, move |host| {
            let now = now_ms();
            let mut videos = crate::posts_routes::list(host, "video")?;
            if let Some(items) = videos.as_array_mut() {
                for video in items {
                    crate::posts_routes::sign_media_paths(video, token.as_deref(), ttl, now);
                }
            }
            Ok((StatusCode::OK, json!({ "ok": true, "result": { "videos": videos } })))
        })
        .await;
    }

    // Detail is GET-only and single-segment, so it can never shadow the POST
    // routes: a reserved name or a non-GET method falls through to the exact
    // `API_ROUTES` match below.
    if method == Method::GET {
        if let Some(post_id) = path.strip_prefix("/api/videos/") {
            if !post_id.is_empty() && !post_id.contains('/') && !VIDEO_RESERVED.contains(&post_id) {
                let post_id = post_id.to_string();
                let token = state.token.clone();
                let ttl = state.media_ttl_ms;
                return blocking_json_raw(state, move |host| {
                    let mut post = crate::posts_routes::get(host, &post_id, "video")?;
                    crate::posts_routes::sign_media_paths(&mut post, token.as_deref(), ttl, now_ms());
                    Ok((StatusCode::OK, json!({ "ok": true, "result": post })))
                })
                .await;
            }
        }
    }

    if let Some(asset_id) = path.strip_prefix("/api/creations/media/") {
        // Node only treats this path as a route for GET. Any other method falls
        // through to the API router, finds no exact `API_ROUTES` entry and answers
        // 404 `ENOTFOUND "not found"`. Returning 405 told a probing client that
        // the endpoint exists with a different method, which Node never does.
        if method != Method::GET {
            return send_error(StatusCode::NOT_FOUND, "ENOTFOUND", "not found");
        }
        let asset_id = asset_id.to_string();
        let state_for_read = Arc::clone(&state);
        let result = tokio::task::spawn_blocking(move || {
            let host = state_for_read.host.lock().map_err(|_| HostError::new("host lock poisoned"))?;
            let asset = storage_core::creations::read_asset(&host.library.connection, &host.library.root, &asset_id)?;
            Ok::<_, HostError>(asset)
        })
        .await;
        return match result {
            // Deviation D21: Node sends this 200 without CORS headers, so a web
            // page served from another origin (Vite dev, the static UI, anything
            // that is not the Tauri shell's native fetch) can upload an asset but
            // never read it back — `putLocalFile` keeps no IndexedDB copy for a
            // host-stored file, so the "local" attachment silently falls back to
            // the remote URL. Same headers the `/media/` route already sends.
            Ok(Ok(Some(asset))) => match std::fs::read(&asset.path) {
                Ok(bytes) => {
                    let mut builder = Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, asset.mime.clone())
                        .header("Content-Length", bytes.len().to_string())
                        .header(CACHE_CONTROL, "private, max-age=300");
                    for (name, value) in media_cors_headers() {
                        builder = builder.header(name, value);
                    }
                    builder.body(full_body(bytes)).unwrap()
                }
                Err(_) => send_error(StatusCode::NOT_FOUND, "ENOTFOUND", "creation asset not found"),
            },
            Ok(Ok(None)) => send_error(StatusCode::NOT_FOUND, "ENOTFOUND", "creation asset not found"),
            _ => send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", "internal error"),
        };
    }

    if path.starts_with("/api/") {
        if !API_ROUTES.contains(&path.as_str()) {
            return send_error(StatusCode::NOT_FOUND, "ENOTFOUND", "not found");
        }
        if method != Method::POST {
            let mut response = send_error(StatusCode::METHOD_NOT_ALLOWED, "EMETHODNOTALLOWED", "method not allowed");
            response.headers_mut().insert(ALLOW, hyper::header::HeaderValue::from_static("POST"));
            return response;
        }
        return handle_api_post(state, request, &path).await;
    }

    // Static allow-list; no path is ever joined from user input.
    //
    // Node sends this through `sendError`, so the 405 carries a JSON content type
    // and the nosniff header like every other error. A hard-coded body without
    // `Content-Type` made browsers treat it as text and made header-level
    // assertions in the differential harness impossible.
    if method != Method::GET && method != Method::HEAD {
        let builder = Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(ALLOW, "GET, HEAD")
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .header(CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff");
        return cors_headers(builder).body(full_body(Bytes::from_static(br#"{"ok":false,"error":{"code":"EMETHODNOTALLOWED","message":"method not allowed"}}"#))).unwrap();
    }
    let file = STATIC_FILES.iter().find(|(route, _)| *route == path).map(|(_, file)| *file);
    let Some(file) = file else {
        return send_error(StatusCode::NOT_FOUND, "ENOTFOUND", "not found");
    };
    let content_type = match file {
        "index.html" => "text/html; charset=utf-8",
        "app.js" => "text/javascript; charset=utf-8",
        "style.css" => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    };
    let path_on_disk = state.ui_root.join(file);
    let Ok(bytes) = std::fs::read(&path_on_disk) else {
        return send_error(StatusCode::NOT_FOUND, "ENOTFOUND", "not found");
    };
    let builder = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header("Content-Length", bytes.len().to_string())
        .header(CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    let builder = cors_headers(builder);
    if method == Method::HEAD {
        builder.body(empty_body()).unwrap()
    } else {
        builder.body(full_body(bytes)).unwrap()
    }
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().map(|v4| v4.is_loopback()).unwrap_or(false),
    }
}

fn authorized(state: &State, request: &Request<Incoming>, uri: &hyper::Uri, is_media: bool) -> bool {
    if state.token.is_none() {
        return true;
    }
    let header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if bearer_authorized(header, state.token.as_deref()) {
        return true;
    }
    if !is_media {
        return false;
    }
    let path = uri.path();
    let Some(entry_id) = media_entry_from_path(path) else { return false };
    let params = query_params(uri);
    let expires = params
        .iter()
        .find(|(key, _)| key == "expires")
        .and_then(|(_, value)| value.parse::<i64>().ok());
    let signature = params
        .iter()
        .find(|(key, _)| key == "sig")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    matches!(expires, Some(expires) if valid_media_signature(
        state.token.as_deref(),
        &entry_id,
        expires,
        &signature,
        state.media_ttl_ms,
        now_ms()
    ))
}

fn query_params(uri: &hyper::Uri) -> Vec<(String, String)> {
    let Some(query) = uri.query() else { return Vec::new() };
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (
                percent_decode(key).unwrap_or_else(|| key.to_string()),
                percent_decode(value).unwrap_or_else(|| value.to_string()),
            ),
            None => (percent_decode(part).unwrap_or_else(|| part.to_string()), String::new()),
        })
        .collect()
}

fn query_param(uri: &hyper::Uri, name: &str) -> Option<String> {
    query_params(uri)
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// Run a host operation on a blocking thread and serialize its result.
/// Run a host operation off the reactor; redact the payload and any error.
async fn blocking_json<F>(state: Arc<State>, operation: F) -> Response<Body>
where
    F: FnOnce(&mut Host) -> Result<(StatusCode, Value), HostError> + Send + 'static,
{
    blocking_json_with(state, true, operation).await
}

/// Like [`blocking_json`], but the success payload is sent as-is.
///
/// Node sends the GET listings (`/api/works`, `/api/creations`,
/// `/api/cleanup/preview`, `/api/import/status`) unredacted. They hold only
/// relative paths, and the POSIX scrub would turn every `/media/<id>` into
/// `<path>`, breaking playback. Errors are still redacted.
async fn blocking_json_raw<F>(state: Arc<State>, operation: F) -> Response<Body>
where
    F: FnOnce(&mut Host) -> Result<(StatusCode, Value), HostError> + Send + 'static,
{
    blocking_json_with(state, false, operation).await
}

async fn blocking_json_with<F>(state: Arc<State>, redact_payload: bool, operation: F) -> Response<Body>
where
    F: FnOnce(&mut Host) -> Result<(StatusCode, Value), HostError> + Send + 'static,
{
    let roots = redaction_roots(&state);
    let result = tokio::task::spawn_blocking(move || {
        let mut host = state.host.lock().map_err(|_| HostError::new("host lock poisoned"))?;
        operation(&mut host)
    })
    .await;
    match result {
        Ok(Ok((status, value))) if redact_payload => json_response(status, &redact_value(&value, &roots)),
        Ok(Ok((status, value))) => json_response(status, &value),
        Ok(Err(error)) => {
            let (status, code) = error_status(&error);
            send_error(status, code, &redact_text(&error.message, &roots))
        }
        Err(_) => send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", "internal error"),
    }
}

/// Media download with Range support and signed-URL validation.
async fn handle_media(state: Arc<State>, request: Request<Incoming>, path: &str) -> Response<Body> {
    let method = request.method().clone();
    if method != Method::GET && method != Method::HEAD {
        return media_json(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            "only GET and HEAD are supported",
            vec![("Allow", "GET, HEAD".to_string()), ("Accept-Ranges", "bytes".to_string())],
        );
    }
    let Some(entry_id) = media_entry_from_path(path) else {
        return media_json_error(StatusCode::NOT_FOUND, "ENTRY_NOT_FOUND", "entry not found");
    };
    let range_header = request
        .headers()
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let state_for_read = Arc::clone(&state);
    let resolved = tokio::task::spawn_blocking(move || {
        let host = state_for_read.host.lock().map_err(|_| HostError::new("host lock poisoned"))?;
        let source_root = host.source_root.clone();
        Ok::<_, HostError>(resolve_asset(
            &host.library.connection,
            &host.library.data_root,
            source_root.as_deref(),
            &entry_id,
        ))
    })
    .await;
    let resolved = match resolved {
        Ok(Ok(Some(asset))) => asset,
        Ok(Ok(None)) => return media_json_error(StatusCode::NOT_FOUND, "ENTRY_NOT_FOUND", "entry or asset not found"),
        _ => return media_json_error(StatusCode::INTERNAL_SERVER_ERROR, "READ_ERROR", "asset read failed"),
    };

    let decision = parse_range(range_header.as_deref(), resolved.size);
    let mut headers: Vec<(&'static str, String)> = media_cors_headers();
    headers.push(("Content-Type", resolved.mime.clone()));
    headers.push(("Accept-Ranges", "bytes".to_string()));
    headers.push(("Cache-Control", "no-store".to_string()));
    if let Some(sha) = &resolved.sha256 {
        headers.push(("ETag", format!("\"{sha}\"")));
    }

    match decision {
        RangeDecision::Invalid | RangeDecision::Unsatisfiable => {
            let code = if decision == RangeDecision::Invalid { "INVALID_RANGE" } else { "RANGE_NOT_SATISFIABLE" };
            let mut extra = headers;
            extra.push(("Content-Range", format!("bytes */{}", resolved.size)));
            media_json(StatusCode::RANGE_NOT_SATISFIABLE, code, "range not satisfiable", extra)
        }
        RangeDecision::Full => {
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header("Content-Length", resolved.size.to_string());
            for (key, value) in headers {
                builder = builder.header(key, value);
            }
            if method == Method::HEAD {
                return builder.body(empty_body()).unwrap();
            }
            match stream_file(&resolved.path, 0, resolved.size).await {
                Ok(body) => builder.body(body).unwrap(),
                Err(_) => media_json_error(StatusCode::INTERNAL_SERVER_ERROR, "READ_ERROR", "asset read failed"),
            }
        }
        RangeDecision::Partial { start, end } => {
            let length = end - start + 1;
            let mut builder = Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Range", format!("bytes {start}-{end}/{}", resolved.size))
                .header("Content-Length", length.to_string());
            for (key, value) in headers {
                builder = builder.header(key, value);
            }
            if method == Method::HEAD {
                return builder.body(empty_body()).unwrap();
            }
            match stream_file(&resolved.path, start, length).await {
                Ok(body) => builder.body(body).unwrap(),
                Err(_) => media_json_error(StatusCode::INTERNAL_SERVER_ERROR, "READ_ERROR", "asset read failed"),
            }
        }
    }
}

fn media_json_error(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    media_json(status, code, message, vec![("Accept-Ranges", "bytes".to_string())])
}

/// JSON error from the media route (`media.mjs::sendJson`): body ends with a
/// newline and carries `no-store` plus the media CORS/expose headers. Extra
/// headers come after the defaults, as Node spreads them.
fn media_json(status: StatusCode, code: &str, message: &str, extra: Vec<(&'static str, String)>) -> Response<Body> {
    let mut body = serde_json::to_vec(&media_error(code, message)).unwrap();
    body.push(b'\n');
    let mut builder = Response::builder().status(status).header(CACHE_CONTROL, "no-store");
    for (key, value) in media_cors_headers() {
        builder = builder.header(key, value);
    }
    for (key, value) in extra {
        // The 416 path passes the full media header set, which already holds the
        // CORS pair; skip duplicates instead of emitting them twice.
        let duplicate = ["content-type", "cache-control", "access-control-allow-origin", "access-control-expose-headers"]
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name));
        if !duplicate {
            builder = builder.header(key, value);
        }
    }
    builder
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header("Content-Length", body.len().to_string())
        .body(full_body(body))
        .unwrap()
}

/// Stream `length` bytes starting at `offset`.
async fn stream_file(path: &std::path::Path, offset: u64, length: u64) -> Result<Body, std::io::Error> {
    let mut file = tokio::fs::File::open(path).await?;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).await?;
    }
    let reader = file.take(length);
    let stream = ReaderStream::new(reader);
    Ok(StreamBody::new(stream.map_ok(Frame::data)).boxed())
}

use futures_util::TryStreamExt;

/// `POST /api/upload`: chunked append into the source root.
async fn handle_upload(state: Arc<State>, request: Request<Incoming>) -> Response<Body> {
    let source_root = {
        let host = match state.host.lock() {
            Ok(host) => host,
            Err(_) => return send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", "internal error"),
        };
        host.source_root.clone()
    };
    let Some(source_root) = source_root else {
        return send_error(StatusCode::BAD_REQUEST, "EPATHDENIED", "source is not configured on this host");
    };
    let raw_header = request
        .headers()
        .get("x-relative-path")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let Some(relative) = percent_decode(raw_header) else {
        return send_error(StatusCode::BAD_REQUEST, "EBADREQUEST", "X-Relative-Path is not valid percent encoding");
    };
    let relative = relative.replace('\\', "/");
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.split('/').any(|part| part == "..")
        || relative.contains(':')
    {
        return send_error(StatusCode::BAD_REQUEST, "EPATHDENIED", "relative path is not allowed");
    }
    let target = storage_core::paths::resolve_lexical(
        &source_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)),
    );
    if target != source_root && !storage_core::paths::is_inside(&source_root, &target) {
        return send_error(StatusCode::BAD_REQUEST, "EPATHDENIED", "relative path escapes the source root");
    }
    let offset = match request.headers().get("x-upload-offset") {
        None => 0u64,
        Some(value) => match value.to_str().ok().and_then(|text| text.parse::<u64>().ok()) {
            Some(offset) => offset,
            None => return send_error(StatusCode::BAD_REQUEST, "EBADREQUEST", "X-Upload-Offset must be a non-negative integer"),
        },
    };
    if offset > 0 {
        match std::fs::metadata(&target) {
            Ok(info) if info.is_file() && info.len() == offset => {}
            _ => return send_error(StatusCode::CONFLICT, "ECONFLICT", "upload offset does not match the file size"),
        }
    }
    if let Some(parent) = target.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", &error.to_string());
        }
    }
    let flags = if offset > 0 {
        std::fs::OpenOptions::new().append(true).open(&target)
    } else {
        std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&target)
    };
    let mut file = match flags {
        Ok(file) => file,
        Err(error) => return send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", &error.to_string()),
    };
    let mut body = request.into_body();
    let mut written: u64 = 0;
    while let Some(next) = body.frame().await {
        let Ok(frame) = next else {
            return send_error(StatusCode::BAD_REQUEST, "EBADREQUEST", "upload stream failed");
        };
        let Ok(data) = frame.into_data() else { continue };
        written += data.len() as u64;
        if offset + written > MAX_UPLOAD_BYTES {
            if offset == 0 {
                drop(file);
                let _ = std::fs::remove_file(&target);
            }
            return send_error(StatusCode::PAYLOAD_TOO_LARGE, "ETOOLARGE", "upload exceeds the 8 GiB limit");
        }
        use std::io::Write;
        if let Err(error) = file.write_all(&data) {
            if offset == 0 {
                drop(file);
                let _ = std::fs::remove_file(&target);
            }
            return send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", &error.to_string());
        }
    }
    drop(file);
    json_response(
        StatusCode::OK,
        &json!({ "ok": true, "result": { "relativePath": relative, "bytes": written, "offset": offset } }),
    )
}

/// `POST /api/creations/upload`: buffered attachment upload.
async fn handle_creation_upload(state: Arc<State>, request: Request<Incoming>) -> Response<Body> {
    let post_id = request
        .headers()
        .get("x-creation-post")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let attachment_id = request
        .headers()
        .get("x-creation-attachment")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let role = request
        .headers()
        .get("x-creation-role")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("original")
        .to_string();
    let name = percent_decode(
        request
            .headers()
            .get("x-creation-name")
            .and_then(|value| value.to_str().ok())
            .unwrap_or(""),
    )
    .unwrap_or_default();
    let mime = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let collected = match request.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => {
            return send_error(StatusCode::BAD_REQUEST, "EBADREQUEST", &redact_text(&error.to_string(), &[]))
        }
    };
    if collected.len() as u64 > MAX_CREATION_BYTES {
        return send_error(StatusCode::PAYLOAD_TOO_LARGE, "ETOOLARGE", "creation upload exceeds the 1 GiB limit");
    }
    let bytes = collected.to_vec();
    let roots = {
        let host = match state.host.lock() {
            Ok(host) => host,
            Err(_) => return send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", "internal error"),
        };
        vec![host.library.root.to_string_lossy().to_string()]
    };
    let result = tokio::task::spawn_blocking(move || {
        let host = state.host.lock().map_err(|_| HostError::new("host lock poisoned"))?;
        storage_core::creations::save_asset(
            &host.library.connection,
            &host.library.root,
            &post_id,
            &attachment_id,
            &role,
            &bytes,
            &mime,
            &name,
        )
    })
    .await;
    match result {
        Ok(Ok(asset)) => json_response(StatusCode::OK, &json!({ "ok": true, "result": asset.to_json() })),
        Ok(Err(error)) => {
            let (status, code) = error_status(&error);
            send_error(status, code, &redact_text(&error.message, &roots))
        }
        Err(_) => send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", "internal error"),
    }
}

/// `POST /api/*` JSON routes.
async fn handle_api_post(state: Arc<State>, request: Request<Incoming>, path: &str) -> Response<Body> {
    let path = path.to_string();
    let body = match read_body(request).await {
        Ok(body) => body,
        Err(error) => {
            let (status, code) = error_status(&error);
            return send_error(status, code, &error.message);
        }
    };
    if path == "/api/import" && body.get("async").and_then(Value::as_bool) == Some(true) {
        return start_async_import(state, body).await;
    }
    if path == "/api/videos/fetch" {
        return handle_video_fetch(state, body).await;
    }
    if path == "/api/videos/cache-remote" {
        return handle_cache_remote(state, body).await;
    }
    blocking_json(state, move |host| dispatch_post(host, &path, body)).await
}

/// Lock the host, mapping a poisoned mutex to an error instead of a panic.
fn lock_host(state: &State) -> Result<std::sync::MutexGuard<'_, Host>, HostError> {
    state.host.lock().map_err(|_| HostError::new("host lock poisoned"))
}

/// `POST /api/videos/fetch` in three phases, the middle one unlocked.
///
/// The downloader is an external program that can run for minutes. Every
/// request handler shares one `Mutex<Host>`, so running it under the lock (as
/// the first version did) froze every `/api/*`, `/media/*` and `/health` call
/// until it finished — and with no timeout, possibly forever. The lock is now
/// held only to validate the post and compute its folder, and again to register
/// the file; the post is re-read in the last phase because it may have been
/// deleted while the download ran.
async fn handle_video_fetch(state: Arc<State>, body: Map<String, Value>) -> Response<Body> {
    blocking_unlocked(state, move |state| {
        let post_id = require_string(&body, "postId")?;
        let input = Value::Object(body);
        let plan = {
            let host = lock_host(state)?;
            crate::posts_routes::require_category(&host, &post_id, "video")?;
            host.prepare_fetch(&input)?
        };
        let outcome = Host::run_fetch(&plan)?;
        let mut host = lock_host(state)?;
        let payload = host.finish_fetch(&plan, &outcome)?;
        Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
    })
    .await
}

/// `POST /api/videos/cache-remote`, same three phases as the fetch.
///
/// The download is bounded (15 s, 32 MiB) but 15 s of a frozen host is still a
/// stalled player, so the request runs without the lock too.
async fn handle_cache_remote(state: Arc<State>, body: Map<String, Value>) -> Response<Body> {
    blocking_unlocked(state, move |state| {
        let post_id = require_string(&body, "postId")?;
        let url = require_string(&body, "url")?;
        let name = body.get("name").and_then(Value::as_str).unwrap_or("");
        let role = body.get("role").and_then(Value::as_str).unwrap_or("attachment");
        let plan = {
            let host = lock_host(state)?;
            crate::posts_routes::require_category(&host, &post_id, "video")?;
            host.prepare_remote_file(&post_id, &url, name, role)?
        };
        let fetched = Host::download_remote_file(&plan)?;
        let mut host = lock_host(state)?;
        let payload = host.finish_remote_file(&plan, &fetched)?;
        Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
    })
    .await
}

/// Machine roots to scrub from a response, read under a short lock.
fn redaction_roots(state: &State) -> Vec<String> {
    state
        .host
        .lock()
        .map(|host| {
            let mut roots = vec![host.library.root.to_string_lossy().to_string()];
            if let Some(source) = &host.source_root {
                roots.push(source.to_string_lossy().to_string());
            }
            roots.push(host.library.data_root.to_string_lossy().to_string());
            roots
        })
        .unwrap_or_default()
}

/// Like [`blocking_json`], but the operation takes the lock itself.
///
/// For handlers that must release the lock in the middle (external process,
/// network). Responses and errors are redacted exactly like `blocking_json`.
async fn blocking_unlocked<F>(state: Arc<State>, operation: F) -> Response<Body>
where
    F: FnOnce(&State) -> Result<(StatusCode, Value), HostError> + Send + 'static,
{
    let roots = redaction_roots(&state);
    let result = tokio::task::spawn_blocking(move || operation(&state)).await;
    match result {
        Ok(Ok((status, value))) => json_response(status, &redact_value(&value, &roots)),
        Ok(Err(error)) => {
            let (status, code) = error_status(&error);
            send_error(status, code, &redact_text(&error.message, &roots))
        }
        Err(_) => send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", "internal error"),
    }
}

fn import_options(body: &Map<String, Value>) -> storage_host::host::ImportOptions {
    let text = |key: &str| body.get(key).filter(|value| !value.is_null()).map(js_string).filter(|value| !value.is_empty());
    storage_host::host::ImportOptions { batch_id: text("batchId"), idempotency_key: text("idempotencyKey") }
}

/// `/api/import` with `async: true`: reply `{ batchId, libraryId, status:
/// "running", async: true }` at once and import on a worker thread.
///
/// The frontend polls `/api/import/status` every 500 ms. The worker holds the
/// host lock for the import, so polls queue behind it rather than fail; Node's
/// single event loop serialises them the same way. The batch rows are created
/// before replying, so the first poll never sees a 404.
async fn start_async_import(state: Arc<State>, body: Map<String, Value>) -> Response<Body> {
    let prepare_state = Arc::clone(&state);
    let prepared = tokio::task::spawn_blocking(move || {
        let host = prepare_state.host.lock().map_err(|_| HostError::new("host lock poisoned"))?;
        let preview = body
            .get("preview")
            .cloned()
            .or_else(|| host.preview.clone())
            .ok_or_else(|| HostError::bad_request("scan preview is required before import"))?;
        let candidate_ids: Vec<String> = body
            .get("candidateIds")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(js_string).collect())
            .unwrap_or_default();
        if candidate_ids.is_empty() {
            return Err(HostError::bad_request("candidateIds must be a non-empty array"));
        }
        let mut options = import_options(&body);
        let batch_id = Host::import_batch_id(&options);
        options.batch_id = Some(batch_id.clone());
        host.ensure_import_batch(&batch_id)?;
        let reply = json!({ "batchId": batch_id, "libraryId": host.library_id(), "status": "running", "async": true });
        Ok::<_, HostError>((preview, candidate_ids, options, reply))
    })
    .await;
    let (preview, candidate_ids, options, reply) = match prepared {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            let (status, code) = error_status(&error);
            return send_error(status, code, &error.message);
        }
        Err(_) => return send_error(StatusCode::INTERNAL_SERVER_ERROR, "EINTERNAL", "internal error"),
    };
    let batch_id = options.batch_id.clone().unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let Ok(mut host) = state.host.lock() else { return };
        if let Err(error) = host.import_candidates_with(&preview, &candidate_ids, &options) {
            host.fail_import_batch(&batch_id, &error.message);
        }
    });
    let (status, out) = payload_response(reply);
    json_response(status, &out)
}

/// Node's generic POST tail: `{ ok: true, result: payload, ...payload }`.
///
/// The spread is part of the contract: older frontend code reads `json.imported`
/// or `json.from` straight off the top level. Non-object payloads spread to
/// nothing, as `...` does in JavaScript.
fn payload_response(payload: Value) -> (StatusCode, Value) {
    let mut out = Map::new();
    out.insert("ok".to_string(), json!(true));
    out.insert("result".to_string(), payload.clone());
    if let Value::Object(fields) = payload {
        for (key, value) in fields {
            out.insert(key, value);
        }
    }
    (StatusCode::OK, Value::Object(out))
}

fn dispatch_post(host: &mut Host, path: &str, body: Map<String, Value>) -> Result<(StatusCode, Value), HostError> {
    match path {
        // Node listed `/api/works` in `API_ROUTES` for the GET handler only; a POST
        // fell through every branch and answered `200 {"ok":true}` with `result`
        // dropped by `JSON.stringify(undefined)`. Answering 404 would be the more
        // honest status, but any client that treats "anything but 404" as
        // "endpoint exists" would change behaviour, so this matches Node.
        "/api/works" => Ok((StatusCode::OK, json!({ "ok": true }))),
        "/api/creations/import" => {
            let post = body
                .get("post")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let payload = storage_core::creations::save_post(&host.library.connection, &post)?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
        }
        "/api/creations/delete" => {
            let post_ids: Vec<String> = body
                .get("postIds")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(js_string).collect())
                .unwrap_or_default();
            let mut deleted = Vec::new();
            for post_id in post_ids {
                let removed = storage_core::creations::delete_post(
                    &host.library.connection,
                    &host.library.root,
                    &post_id,
                )?;
                deleted.push(json!({ "postId": post_id, "deleted": removed }));
            }
            Ok((StatusCode::OK, json!({ "ok": true, "result": { "deleted": deleted } })))
        }
        "/api/creations/delete-asset" => {
            let asset_id = body.get("assetId").and_then(Value::as_str).unwrap_or("").to_string();
            let deleted = storage_core::creations::delete_asset(
                &host.library.connection,
                &host.library.root,
                &asset_id,
            )?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": { "assetId": asset_id, "deleted": deleted } })))
        }
        "/api/videos/import" => {
            let payload = crate::posts_routes::import(host, &body, "video")?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
        }
        "/api/videos/delete" => {
            let post_ids: Vec<String> = body
                .get("postIds")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(js_string).collect())
                .unwrap_or_default();
            // Per-id results instead of failing the batch: a multi-select that
            // happens to include one stale or foreign id must still delete the
            // rest, and the client needs to know which ones were refused.
            let mut deleted = Vec::new();
            for post_id in post_ids {
                let outcome = crate::posts_routes::require_category(host, &post_id, "video")
                    .and_then(|_| host.delete_post(&post_id));
                match outcome {
                    Ok(_) => deleted.push(json!({ "postId": post_id, "deleted": true })),
                    Err(error) => deleted.push(json!({
                        "postId": post_id,
                        "deleted": false,
                        "error": { "code": error.code_or_internal(), "message": error.message },
                    })),
                }
            }
            Ok((StatusCode::OK, json!({ "ok": true, "result": { "deleted": deleted } })))
        }
        "/api/videos/delete-asset" => {
            let post_id = require_string(&body, "postId")?;
            let rel_path = require_string(&body, "relPath")?;
            crate::posts_routes::require_category(host, &post_id, "video")?;
            let deleted = host.delete_post_file(&post_id, &rel_path)?;
            Ok((
                StatusCode::OK,
                json!({ "ok": true, "result": { "postId": post_id, "relPath": rel_path, "deleted": deleted } }),
            ))
        }
        "/api/videos/attach" => {
            let post_id = require_string(&body, "postId")?;
            crate::posts_routes::require_category(host, &post_id, "video")?;
            let payload = host.attach_post_file(&Value::Object(body))?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
        }
        // `/api/videos/fetch` and `/api/videos/cache-remote` never reach here:
        // `handle_api_post` runs them in phases so the network/downloader part
        // happens without the host lock (see `handle_video_fetch`).
        "/api/voices/reconcile" => {
            let work_id = require_string(&body, "workId")?;
            let payload = host.reconcile_work(&work_id)?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
        }
        "/api/voices/bundle" => {
            let input = json!({
                "rootName": body.get("rootName").and_then(Value::as_str).unwrap_or(""),
                "metadata": body.get("metadata").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})),
                "manifest": body.get("manifest").filter(|value| value.is_object()).cloned(),
                "coverUrl": body.get("coverUrl").and_then(Value::as_str).unwrap_or(""),
            });
            let payload = host.save_voice_bundle(&input)?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
        }
        "/api/works/cover" => {
            let work_id = require_string(&body, "workId")?;
            let url = require_string(&body, "url")?;
            let payload = host.cache_work_cover(&work_id, &url)?;
            Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
        }
        "/api/works/metadata" => {
            let work_id = require_string(&body, "workId")?;
            let metadata = body
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            // Deviation D19 (dynamic dedupe): a manifest write is the point where a
            // second edition's rows enter the work, so content dedupe has to run
            // here. Without it the duplicate stayed on disk until the user pressed
            // reconcile. Plain edits (no manifest in the patch) skip it, so
            // renaming a work cannot touch files, exactly like Node.
            let writes_manifest = metadata.get("manifest").is_some();
            let payload = host.library.update_work_metadata(&work_id, &metadata)?;
            if writes_manifest {
                let _ = host.dedupe_work_content(&work_id);
            }
            Ok((StatusCode::OK, json!({ "ok": true, "result": payload })))
        }
        "/api/scan" => {
            if let Some(requested) = body.get("source") {
                let source_root = host
                    .source_root
                    .clone()
                    .ok_or_else(|| HostError::path_denied("source is not configured on this host"))?;
                let requested = requested
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| HostError::bad_request("source is required"))?;
                if storage_core::paths::resolve_lexical(Path::new(requested)) != storage_core::paths::resolve_lexical(&source_root) {
                    return Err(HostError::path_denied("source is outside the host source root policy"));
                }
            }
            let mode = body.get("mode").map(js_string).unwrap_or_else(|| "single".to_string());
            if mode != "single" && mode != "batch" {
                return Err(HostError::bad_request("mode must be single or batch"));
            }
            let mut options = serde_json::Map::new();
            options.insert("mode".to_string(), json!(mode));
            if let Some(relative) = body.get("relativeRoot").filter(|value| !value.is_null() && value.as_str() != Some("")) {
                options.insert("relativeRoot".to_string(), json!(js_string(relative)));
            }
            let preview = host.scan(&Value::Object(options))?;
            host.preview = Some(preview.clone());
            let (status, mut out) = payload_response(preview.clone());
            // Node: `bodyOut.preview = safe; candidates; sourceRoot` on top of the spread.
            if let Some(object) = out.as_object_mut() {
                object.insert("preview".to_string(), preview.clone());
                object.insert("candidates".to_string(), preview.get("candidates").cloned().unwrap_or_else(|| json!([])));
                object.insert("sourceRoot".to_string(), preview.get("sourceRoot").cloned().unwrap_or_else(|| json!(".")));
            }
            Ok((status, out))
        }
        "/api/import" => {
            let preview = body.get("preview").cloned().or_else(|| host.preview.clone());
            let Some(preview) = preview else {
                return Err(HostError::bad_request("scan preview is required before import"));
            };
            let candidate_ids: Vec<String> = body
                .get("candidateIds")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(js_string).collect())
                .unwrap_or_default();
            if candidate_ids.is_empty() {
                return Err(HostError::bad_request("candidateIds must be a non-empty array"));
            }
            // `async: true` never reaches here: `handle_api_post` routes it to
            // `start_async_import`, which needs the shared state.
            Ok(payload_response(host.import_candidates_with(&preview, &candidate_ids, &import_options(&body))?))
        }
        "/api/move" => {
            let source_root = host
                .source_root
                .clone()
                .ok_or_else(|| HostError::path_denied("source is not configured on this host"))?;
            let from = storage_core::paths::resolve_lexical(
                &source_root.join(require_string(&body, "from")?.replace('/', std::path::MAIN_SEPARATOR_STR)),
            );
            let to = storage_core::paths::resolve_lexical(
                &source_root.join(require_string(&body, "to")?.replace('/', std::path::MAIN_SEPARATOR_STR)),
            );
            for target in [&from, &to] {
                if target != &source_root && !storage_core::paths::is_inside(&source_root, target) {
                    return Err(HostError::path_denied("move target is outside the source root"));
                }
            }
            if from == to {
                return Err(HostError::bad_request("move source and target are identical"));
            }
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if let Err(error) = std::fs::rename(&from, &to) {
                // Windows rename does not replace an existing file; the staging file
                // is complete, so replace the old target only at commit time.
                if error.kind() == std::io::ErrorKind::AlreadyExists || error.kind() == std::io::ErrorKind::PermissionDenied {
                    let _ = std::fs::remove_file(&to);
                    std::fs::rename(&from, &to)?;
                } else {
                    return Err(HostError::from(error));
                }
            }
            // Staging dirs live under <work>/tmp/import-*; clean them once empty.
            let mut staging_parent = from.parent().map(PathBuf::from);
            while let Some(current) = staging_parent {
                if current == source_root || !storage_core::paths::is_inside(&source_root, &current) {
                    break;
                }
                // Node: stop unless the dir is `tmp` or lies under a `tmp` component.
                let under_tmp = current
                    .strip_prefix(&source_root)
                    .map(|relative| relative.components().any(|part| part.as_os_str() == "tmp"))
                    .unwrap_or(false);
                if !under_tmp {
                    break;
                }
                if std::fs::remove_dir(&current).is_err() {
                    break;
                }
                staging_parent = current.parent().map(PathBuf::from);
            }
            Ok(payload_response(json!({ "from": body.get("from"), "to": body.get("to") })))
        }
        "/api/import-temp/cleanup" => {
            let work_root = body.get("workRoot").and_then(Value::as_str).unwrap_or("");
            let payload = host.cleanup_import_temps(work_root)?;
            Ok(payload_response(payload))
        }
        "/api/import/file" => {
            let payload = host.import_file(&Value::Object(body))?;
            Ok(payload_response(payload))
        }
        "/api/works/open" => {
            let work_id = require_string(&body, "workId")?;
            let payload = host.open_work_location(&work_id)?;
            Ok(payload_response(payload))
        }
        "/api/works/normalize-root" => {
            let work_id = require_string(&body, "workId")?;
            let root_name = require_string(&body, "rootName")?;
            let payload = host.normalize_work_root(&work_id, &root_name)?;
            Ok(payload_response(payload))
        }
        "/api/works/delete-files" => {
            let work_id = require_string(&body, "workId")?;
            let paths_list: Vec<String> = body
                .get("paths")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(js_string).collect())
                .unwrap_or_default();
            let payload = host.delete_work_files(&work_id, &paths_list)?;
            Ok(payload_response(payload))
        }
        "/api/works/delete" => {
            let work_ids: Vec<String> = body
                .get("workIds")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(js_string).collect())
                .unwrap_or_default();
            let payload = host.delete_works(&work_ids)?;
            Ok(payload_response(payload))
        }
        "/api/cleanup" => {
            let work_ids: Vec<String> = body
                .get("workIds")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(js_string).collect())
                .unwrap_or_default();
            let payload = host.cleanup_works(&work_ids)?;
            Ok(payload_response(payload))
        }
        "/api/verify" => {
            let payload = host.verify()?;
            Ok(payload_response(payload))
        }
        "/api/download" => {
            // Node: `Number(x)` must be a non-negative integer; '' / null mean unset.
            let expected_bytes = match body.get("expectedBytes") {
                None | Some(Value::Null) => None,
                Some(Value::String(text)) if text.is_empty() => None,
                Some(value) => {
                    let number = storage_core::jsonutil::number_of(value)
                        .filter(|number| number.fract() == 0.0 && *number >= 0.0)
                        .ok_or_else(|| HostError::bad_request("expectedBytes must be a non-negative integer"))?;
                    Some(number as u64)
                }
            };
            let options = storage_host::download::BeginOptions {
                source_url: require_string(&body, "sourceUrl")?,
                expected_bytes,
                source_version: body.get("sourceVersion").filter(|value| !value.is_null()).map(storage_core::jsonutil::string_of),
                task_id: None,
            };
            let entry_id = require_string(&body, "entryId")?;
            Ok(payload_response(storage_host::download::download_entry(&host.library, &entry_id, &options)?))
        }
        "/api/backup" => {
            let destination = require_string(&body, "destination")?;
            let options = storage_core::backup::BackupOptions { include_media: body.get("includeMedia") != Some(&Value::Bool(false)) };
            let destination = host.confine_to_experiment(Path::new(&destination))?;
            Ok(payload_response(host.library.backup_library(&destination, &options)?))
        }
        "/api/restore" => {
            let backup = body
                .get("backup")
                .filter(|value| value.as_str().map(|text| !text.trim().is_empty()).unwrap_or(false))
                .or_else(|| body.get("backupDir"))
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| HostError::bad_request("backup is required"))?
                .to_string();
            let destination = host.confine_to_experiment(Path::new(&require_string(&body, "destination")?))?;
            // Node's verifyBackup confines the backup dir too, but reports it as a
            // verify issue, so restore fails with EINVALIDBACKUP rather than EOUTSIDE.
            let backup = host
                .confine_to_experiment(Path::new(&backup))
                .map_err(|_| HostError::coded("EINVALIDBACKUP", "backup is not restorable: verify-error"))?;
            Ok(payload_response(storage_core::backup::restore_library(&backup, &destination)?))
        }
        "/api/export" => {
            let work_id = require_string(&body, "workId")?;
            let destination = require_string(&body, "destination")?;
            let friendly = body.get("friendlyName").filter(|value| !value.is_null()).map(js_string);
            let destination = host.confine_to_experiment(Path::new(&destination))?;
            Ok(payload_response(host.library.export_work(&work_id, &destination, friendly.as_deref())?))
        }
        _ => Err(HostError::not_found("not found")),
    }
}

/// Default UI root resolution used by tests.
pub fn default_ui_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../verify/storage-lab/ui")
}

/// Convenience: build `HostOptions` from environment variables, matching
/// `host-server-start.mjs`.
pub fn host_options_from_env() -> Result<HostOptions, String> {
    let data = std::env::var("MONOCHROME_DATA").map_err(|_| "MONOCHROME_DATA is required".to_string())?;
    let source = std::env::var("MONOCHROME_SOURCE").ok().filter(|value| !value.is_empty());
    Ok(HostOptions {
        library_root: PathBuf::from(data),
        source_root: source.as_ref().map(PathBuf::from),
        allowed_source_roots: source.as_ref().map(|value| vec![PathBuf::from(value)]).unwrap_or_default(),
        allow_outside_root: true,
        experiment_root: None,
        snapshot_fault: None,
    })
}

/// Read `MONOCHROME_TOKEN`, `MONOCHROME_PORT`, `MONOCHROME_BIND`, `MONOCHROME_MEDIA_TTL_MS`.
pub fn server_options_from_env() -> Result<ServerOptions, String> {
    let bind_explicit = std::env::var("MONOCHROME_BIND").map(|value| !value.is_empty()).unwrap_or(false);
    let host = std::env::var("MONOCHROME_BIND").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| "127.0.0.1".to_string());
    let port = match std::env::var("MONOCHROME_PORT").ok().filter(|value| !value.is_empty()) {
        None => 0,
        Some(value) => value.parse::<u16>().map_err(|_| "MONOCHROME_PORT must be 0..65535".to_string())?,
    };
    let media_ttl_ms = match std::env::var("MONOCHROME_MEDIA_TTL_MS").ok().filter(|value| !value.is_empty()) {
        None => DEFAULT_MEDIA_TTL_MS,
        Some(value) => value.parse::<i64>().map_err(|_| "MONOCHROME_MEDIA_TTL_MS must be an integer".to_string())?,
    };
    Ok(ServerOptions {
        host,
        port,
        allow_non_loopback: bind_explicit,
        token: std::env::var("MONOCHROME_TOKEN").ok().filter(|value| !value.is_empty()),
        media_ttl_ms,
        ui_root: None,
    })
}

/// Sleep helper for graceful shutdown paths.
pub async fn drain(timeout: Duration) {
    tokio::time::sleep(timeout).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_status_maps_new_codes() {
        // ECATEGORY is a caller mistake (wrong route for this id), not a server
        // fault; ENOTCONFIGURED says the feature exists but the operator has not
        // enabled it, which is what 501 means.
        let category = error_status(&HostError::coded("ECATEGORY", "x"));
        assert_eq!(category, (StatusCode::BAD_REQUEST, "ECATEGORY"));
        let unconfigured = error_status(&HostError::coded("ENOTCONFIGURED", "x"));
        assert_eq!(unconfigured, (StatusCode::NOT_IMPLEMENTED, "ENOTCONFIGURED"));
        // A refused folder or file path is the caller's fault, never a 500.
        assert_eq!(error_status(&HostError::path_denied("x")), (StatusCode::BAD_REQUEST, "EPATHDENIED"));
        assert_eq!(error_status(&HostError::coded("EBLOCKEDURL", "x")), (StatusCode::BAD_REQUEST, "EBLOCKEDURL"));
        assert_eq!(error_status(&HostError::coded("ETIMEOUT", "x")), (StatusCode::GATEWAY_TIMEOUT, "ETIMEOUT"));
    }

    /// Temp source root removed on drop, pass or fail.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("mono-http-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            TempRoot(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_host(root: &Path) -> Host {
        Host::open(HostOptions {
            library_root: root.join("lib"),
            source_root: Some(root.to_path_buf()),
            allowed_source_roots: vec![root.to_path_buf()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap()
    }

    fn body(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    /// Synthetic source root: one audio work, one creation, one other video.
    fn seed(root: &Path) {
        std::fs::create_dir_all(root.join("RJ000001/.monochrome")).unwrap();
        std::fs::write(root.join("RJ000001/track01.mp3"), b"audio").unwrap();
        std::fs::write(root.join("RJ000001/.monochrome/metadata.json"), b"{\"work\":\"RJ000001\"}").unwrap();
        std::fs::create_dir_all(root.join("Creations/Patreon/C/post [1]")).unwrap();
        std::fs::write(root.join("Creations/Patreon/C/post [1]/a.jpg"), b"img").unwrap();
        std::fs::create_dir_all(root.join("Videos/YouTube/Other/2026-01-01 keep [k]")).unwrap();
        std::fs::write(root.join("Videos/YouTube/Other/2026-01-01 keep [k]/keep.mp4"), b"keep").unwrap();
    }

    fn assert_seed_intact(root: &Path, label: &str) {
        assert!(root.join("RJ000001/track01.mp3").exists(), "{label}: audio track deleted");
        assert_eq!(
            std::fs::read(root.join("RJ000001/.monochrome/metadata.json")).unwrap(),
            b"{\"work\":\"RJ000001\"}",
            "{label}: audio sidecar overwritten"
        );
        assert!(root.join("Creations/Patreon/C/post [1]/a.jpg").exists(), "{label}: creation deleted");
        assert!(root.join("Videos/YouTube/Other/2026-01-01 keep [k]/keep.mp4").exists(), "{label}: other video deleted");
    }

    #[test]
    fn video_import_then_delete_never_touches_anything_but_its_own_folder() {
        // C1 through the real route dispatcher: `rootPath` used to be written
        // verbatim, so `"."` turned the next `/api/videos/delete` into a wipe of
        // the whole source root, `"RJ000001"` into deleting an audio work, and
        // a creation's folder into a cross-category delete.
        let temp = TempRoot::new("c1");
        let root = temp.0.clone();
        seed(&root);
        let mut host = test_host(&root);
        for (index, supplied) in [
            ".",
            "",
            "Videos",
            "Videos/..",
            "RJ000001",
            "Creations/Patreon/C/post [1]",
            "Videos/YouTube/Other/2026-01-01 keep [k]",
        ]
        .iter()
        .enumerate()
        {
            let (status, imported) = dispatch_post(
                &mut host,
                "/api/videos/import",
                body(json!({
                    "provider": "youtube", "sourceId": format!("c1-{index}"), "title": "t",
                    "bodyText": "x", "rootPath": supplied,
                    "creator": { "sourceId": "ch", "name": "Chan" }
                })),
            )
            .unwrap();
            assert_eq!(status, StatusCode::OK);
            let result = &imported["result"];
            let stored = result["rootPath"].as_str().unwrap();
            assert!(stored.starts_with("Videos/youtube/Chan/"), "{supplied:?} -> {stored}");
            assert_seed_intact(&root, &format!("import {supplied:?}"));

            let post_id = result["postId"].as_str().unwrap().to_string();
            let (_, deleted) =
                dispatch_post(&mut host, "/api/videos/delete", body(json!({ "postIds": [post_id] }))).unwrap();
            assert_eq!(deleted["result"]["deleted"][0]["deleted"], true, "{deleted}");
            assert!(!root.join(stored).exists(), "{stored} was not removed");
            assert_seed_intact(&root, &format!("delete {supplied:?}"));
        }
    }

    #[test]
    fn video_delete_of_a_legacy_row_with_an_empty_root_path_is_refused() {
        // `root_path = ''` is what an upsert without `rootPath` used to write;
        // it resolved to the source root itself.
        let temp = TempRoot::new("c1-legacy");
        let root = temp.0.clone();
        seed(&root);
        let mut host = test_host(&root);
        host.library
            .connection
            .execute(
                "INSERT INTO post(post_id, category, provider, source_id, root_path, created_at, updated_at)
                 VALUES ('legacy', 'video', 'youtube', 'legacy', '', 'now', 'now')",
                [],
            )
            .unwrap();
        let (_, deleted) =
            dispatch_post(&mut host, "/api/videos/delete", body(json!({ "postIds": ["legacy"] }))).unwrap();
        let outcome = &deleted["result"]["deleted"][0];
        assert_eq!(outcome["deleted"], false, "{deleted}");
        assert_eq!(outcome["error"]["code"], "EPATHDENIED", "{deleted}");
        assert_seed_intact(&root, "legacy delete");
        assert!(root.join("lib").exists(), "library survived");
    }

    #[test]
    fn video_delete_asset_refuses_drive_relative_and_sidecar_paths() {
        // I1: `C:victim.txt` joined onto the folder *replaces* it on Windows,
        // and the file was unlinked before the row was even looked up.
        let temp = TempRoot::new("i1");
        let root = temp.0.clone();
        let mut host = test_host(&root);
        let (_, imported) = dispatch_post(
            &mut host,
            "/api/videos/import",
            body(json!({
                "provider": "youtube", "sourceId": "i1", "title": "t", "bodyText": "x",
                "creator": { "sourceId": "ch", "name": "Chan" }
            })),
        )
        .unwrap();
        let post_id = imported["result"]["postId"].as_str().unwrap().to_string();
        let folder = root.join(imported["result"]["rootPath"].as_str().unwrap());
        for rel in ["C:victim.txt", "x:stream", ".monochrome/post.html", "../x"] {
            let outcome = dispatch_post(
                &mut host,
                "/api/videos/delete-asset",
                body(json!({ "postId": post_id, "relPath": rel })),
            );
            match outcome {
                Err(error) => assert_eq!(error_status(&error).0, StatusCode::BAD_REQUEST, "{rel}: {error:?}"),
                Ok((_, payload)) => assert_eq!(payload["result"]["deleted"], false, "{rel}: {payload}"),
            }
        }
        assert!(folder.join(".monochrome/post.html").exists(), "the sidecar survived");
    }

    /// Minimal HTTP/1.1 client: one request, `Connection: close`.
    async fn http(port: u16, method: &str, path: &str, payload: Option<Value>) -> (u16, Value) {
        use tokio::io::AsyncWriteExt;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let body = payload.map(|value| value.to_string()).unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let status: u16 = text.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
        let json = text
            .split_once("\r\n\r\n")
            .and_then(|(_, rest)| serde_json::from_str(rest).ok())
            .unwrap_or(Value::Null);
        (status, json)
    }

    /// Downloader stand-in that takes ~3 s before writing `video.mp4`.
    fn slow_fetcher(dir: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            let script = dir.join("slow-fetcher.cmd");
            std::fs::write(
                &script,
                "@echo off\r\nping -n 4 127.0.0.1 >nul\r\necho test> \"%~2\\video.mp4\"\r\necho {\"ok\":true,\"file\":\"video.mp4\",\"mime\":\"video/mp4\"}\r\n",
            )
            .unwrap();
            script
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("slow-fetcher.sh");
            std::fs::write(
                &script,
                "#!/bin/sh\nsleep 3\necho test > \"$2/video.mp4\"\necho '{\"ok\":true,\"file\":\"video.mp4\",\"mime\":\"video/mp4\"}'\n",
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn video_fetch_does_not_hold_the_host_lock_while_downloading() {
        // I2: the downloader used to run inside `blocking_json`, i.e. under the
        // one `Mutex<Host>` every handler shares, so `/health` and every
        // `/api/*` call waited for the download to finish.
        let temp = TempRoot::new("i2");
        let tools = TempRoot::new("i2-bin");
        let root = temp.0.clone();
        let mut host = test_host(&root);
        let imported = host
            .import_post(&json!({
                "category": "video", "provider": "youtube", "sourceId": "slow", "title": "t",
                "bodyText": "x", "creator": { "sourceId": "ch", "name": "Chan" }
            }))
            .unwrap();
        let post_id = imported["postId"].as_str().unwrap().to_string();
        // Only this test in the http crate sets the variable; it is removed
        // again before the assertions can fail.
        std::env::set_var("MONOCHROME_VIDEO_FETCHER", slow_fetcher(&tools.0));
        let running = start(host, ServerOptions::default()).await.unwrap();
        let port = running.port;

        let fetch = tokio::spawn(async move {
            http(port, "POST", "/api/videos/fetch", Some(json!({ "postId": post_id, "url": "https://example.invalid/v" })))
                .await
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = std::time::Instant::now();
        let (health, _) = http(port, "GET", "/health", None).await;
        let (list, listed) = http(port, "GET", "/api/videos", None).await;
        let elapsed = started.elapsed();
        let overlapped = !fetch.is_finished();
        let (fetch_status, fetched) = fetch.await.unwrap();
        std::env::remove_var("MONOCHROME_VIDEO_FETCHER");
        // Stop the accept loop and wait for it before asserting: the server task
        // owns the `Host` (and its open SQLite file), so a failed assertion
        // would otherwise leave the temp root locked and undeletable on Windows.
        let _ = running.shutdown.send(());
        let _ = running.join.await;

        assert_eq!((health, list), (200, 200), "{listed}");
        assert!(overlapped, "the fetch finished before the probes ran; the test proves nothing: {fetch_status} {fetched}");
        assert!(elapsed < Duration::from_millis(1500), "probes waited {elapsed:?} for the download");
        assert_eq!(fetch_status, 200, "{fetched}");
        assert_eq!(fetched["result"]["relPath"], "video.mp4", "{fetched}");
    }

    /// D21, found by a real web-mode import (Vite dev page → Rust host on
    /// another port): the upload succeeded, but reading the asset back was a
    /// CORS failure, so the attachment never resolved to its local copy.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn creation_media_is_readable_cross_origin() {
        use tokio::io::AsyncWriteExt;
        let temp = TempRoot::new("creation-media-cors");
        let host = test_host(&temp.0);
        storage_core::creations::save_post(&host.library.connection, &json!({ "id": "post-cors", "title": "t" })).unwrap();
        let asset = storage_core::creations::save_asset(
            &host.library.connection,
            &host.library.root,
            "post-cors",
            "att-1",
            "original",
            b"\xff\xd8synthetic-jpeg",
            "image/jpeg",
            "a.jpg",
        )
        .unwrap();
        let running = start(host, ServerOptions::default()).await.unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", running.port)).await.unwrap();
        let request = format!(
            "GET /api/creations/media/{} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://127.0.0.1:5173\r\nConnection: close\r\n\r\n",
            asset.asset_id
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let _ = running.shutdown.send(());
        let _ = running.join.await;

        let text = String::from_utf8_lossy(&raw).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let head = head.to_ascii_lowercase();
        assert!(head.starts_with("http/1.1 200"), "{head}");
        assert!(head.contains("access-control-allow-origin: *"), "{head}");
        assert!(head.contains("content-type: image/jpeg"), "{head}");
        assert!(body.ends_with("synthetic-jpeg"), "{body}");
    }
}
