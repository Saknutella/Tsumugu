//! SQLite + filesystem storage core for the Monochrome storage host.
//!
//! This is a line-by-line port of `verify/storage-lab/lib/*.mjs`. The Node host
//! remains the reference implementation and the fallback; every behavioural
//! decision here is traceable to a Node function, except where
//! `docs/18-rust-backend.md` lists a deliberate deviation.
//!
//! Modules map 1:1 onto the Node files so a reader can diff them:
//!
//! | Rust module      | Node module        |
//! | ---------------- | ------------------ |
//! | [`schema`]       | `schema.mjs`       |
//! | [`paths`]        | `paths.mjs`        |
//! | [`fsutil`]       | `fs.mjs`           |
//! | [`hash`]         | `hash.mjs`         |
//! | [`snapshot`]     | `snapshot.mjs`     |
//! | [`library`]      | `library.mjs`      |
//! | [`tracks`]       | `tracks.mjs`       |
//! | [`playback`]     | `playback.mjs`     |
//! | [`document`]     | `document.mjs`     |
//! | [`creations`]    | `creations.mjs`    |

pub mod backup;
pub mod creations;
pub mod document;
pub mod error;
pub mod export;
pub mod fsutil;
pub mod hash;
pub mod jsonutil;
pub mod legacy;
pub mod library;
pub mod paths;
pub mod playback;
pub mod posts;
pub mod schema;
pub mod snapshot;
pub mod tracks;

pub use error::{Error, Result};
pub use library::{open_library, Library, OpenOptions};
pub use schema::SCHEMA_VERSION;
