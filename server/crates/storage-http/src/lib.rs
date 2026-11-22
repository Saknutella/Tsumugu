//! HTTP storage host (port of `host-server.mjs` + `media.mjs`).
//!
//! Modules:
//! - [`auth`] — bearer token and HMAC media signatures, both constant-time.
//! - [`media`] — `entry → asset_ref → file` resolution and byte ranges.
//! - [`posts_routes`] — category-scoped `/api/videos*` handlers.
//! - [`redact`] — strip machine paths from responses and errors.
//! - [`server`] — routing, CORS, error/status mapping.
//!
//! The binaries in `src/bin/` mirror `host-server-start.mjs` (environment-driven
//! host) and the `host.mjs` CLI.

pub mod auth;
pub mod media;
pub mod posts_routes;
pub mod redact;
pub mod server;

pub use server::{host_options_from_env, server_options_from_env, start, RunningServer, ServerOptions};

/// Library id of a host, used by `/health`.
pub fn library_id(host: &storage_host::host::Host) -> String {
    host.library_id().to_string()
}
