//! Host orchestration layer (port of `host.mjs` and its pipeline modules).
//!
//! The Node layering is preserved on purpose: this crate orchestrates the core
//! (`scan` → `ingest` → `library.importWork`), never re-implements it. Anything
//! that needs SQLite goes through `storage_core`, so there is exactly
//! one place that knows the schema.

pub mod cover;
pub mod download;
pub mod host;
pub mod html;
pub mod ingest;
pub mod net;
pub mod posts;
pub mod scan;

pub use storage_core as core;
