//! SQLite + filesystem storage core for the Monochrome storage host.
//!
//! This is a line-by-line port of `verify/storage-lab/lib/*.mjs`. The Node host
//! remains the reference implementation and the fallback; every behavioural
//! decision here is traceable to a Node function, except where
//! `docs/18-server.md` lists a deliberate deviation.
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
//!
//! [`naming`] has no Node counterpart: it was lifted out of the host's post
//! module when creation attachments started sharing the `<source>/creations/`
//! tree with video posts, and both writers must name folders by one rule.

pub mod backup;
pub mod creations;
pub mod document;
pub mod error;
pub mod export;
pub mod fsutil;
pub mod hash;
pub mod jsonutil;
pub mod layout;
pub mod legacy;
pub mod library;
pub mod naming;
pub mod paths;
pub mod playback;
pub mod posts;
pub mod schema;
pub mod sidecar;
pub mod snapshot;
pub mod tracks;
pub mod trash;

pub use error::{Error, Result};
pub use library::{open_library, Library, OpenOptions};
pub use schema::SCHEMA_VERSION;
