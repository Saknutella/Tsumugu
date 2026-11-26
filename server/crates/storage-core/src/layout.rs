//! Canonical on-disk layout of a library (layout v2).
//!
//! WHY this exists: directory names used to be string literals scattered across
//! three crates (61 occurrences of `"assets"`, `"works"`, `"tmp"`, …). Renaming a
//! directory meant finding every one of them, and a single miss produced a silent
//! write to a directory nothing reads — the class of bug that is invisible until
//! someone asks "where did my cover go".
//!
//! Layout rule: a path either holds **user content** (the single copy, meant to be
//! read, copied and deleted by a human) or **derived state** (rebuilt on demand).
//! They never share a directory, because "can I delete this" must have one answer.
//!
//! ```text
//! <library root>            (MONOCHROME_DATA)
//! ├─ root.json              layout version + libraryId
//! ├─ .lock                  root lease
//! ├─ library.sqlite         the authority
//! ├─ derived/               rebuildable: CAS blobs, caches
//! ├─ staging/               in-flight imports; losing it costs a re-import
//! ├─ trash/                 soft-deleted folders waiting for purge
//! ├─ cache/                 download caches
//! └─ system/
//!    ├─ snapshots/          snapshot outbox (was `data/works`)
//!    └─ quarantine/         corrupt libraries set aside
//!
//! <source root>             (MONOCHROME_SOURCE)
//! ├─ voices/<RJ…> …         voice works
//! ├─ videos/…               video posts
//! └─ creations/…            creation posts
//! ```
//!
//! The legacy layout kept everything under `<library root>/data/` and left the
//! source root flat; [`migrate_if_needed`] converts one into the other exactly
//! once and records the version in `root.json`.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::Error;
use crate::fsutil;
use crate::paths;

/// Bumped whenever the on-disk shape changes. `root.json` carries it.
pub const LAYOUT_VERSION: i64 = 2;

pub const LIBRARY_SQLITE: &str = "library.sqlite";
pub const ROOT_JSON: &str = "root.json";
pub const DERIVED: &str = "derived";
pub const STAGING: &str = "staging";
pub const TRASH: &str = "trash";
pub const CACHE: &str = "cache";
pub const SYSTEM: &str = "system";
pub const SNAPSHOTS: &str = "snapshots";
pub const QUARANTINE: &str = "quarantine";
/// Legacy creation attachments (`creation_asset`) lived here, directly in the
/// library root. They are user content, so [`migrate_creation_assets`] moves them
/// into the source tree's `creations/`; only a library the migration has not run
/// on still has this directory.
pub const LEGACY_CREATIONS: &str = "creations";

/// Source-root type directories. The order also decides migration precedence.
pub const VOICES: &str = "voices";
pub const VIDEOS: &str = "videos";
pub const CREATIONS: &str = "creations";

/// Whether the source root is already split by content type (phase 1b).
///
/// The data root conversion (phase 1a) and the source-root conversion are separate
/// steps on purpose: moving works under `voices/` changes what the scanner reports
/// and what an upload targets, so it needs its own verification pass. A half-applied
/// move would break `workRoot` derivation, which is what delete and open rely on.
pub const SOURCE_LAYERED: bool = true;

/// Force a client-supplied source-relative path under its type directory.
///
/// Every write into the source root goes through here: the frontend, the Kikoeru
/// download pipeline and the probes all speak bare paths (`[RJ…] title/file.wav`),
/// and the layout is what decides where that lands. Clients stay layout-agnostic,
/// and an already-prefixed path passes through unchanged (idempotent).
pub fn normalize_source_relative(relative: &str) -> String {
    let normalized = relative.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    let first = trimmed.split('/').next().unwrap_or("");
    if [VOICES, VIDEOS, CREATIONS].contains(&first) {
        return trimmed.to_string();
    }
    format!("{VOICES}/{trimmed}")
}

/// Does this path already start with a type directory?
pub fn is_source_type_path(relative: &str) -> bool {
    let normalized = relative.replace('\\', "/");
    let first = normalized.trim_start_matches('/').split('/').next().unwrap_or("");
    [VOICES, VIDEOS, CREATIONS].contains(&first)
}

/// Store an entry path the way layout v2 does: relative to the source root when the
/// file lives there, unchanged otherwise.
///
/// WHY relative: an absolute path ties the library to one directory on one machine.
/// With relative paths the whole data folder can be copied or moved and the records
/// still resolve. A path *outside* the source root (the user moved those bytes) is
/// left absolute rather than rewritten into a path that would point at nothing.
pub fn stored_source_path(source: &Path, absolute: &Path) -> String {
    let source = paths::resolve_lexical(source);
    let path = paths::resolve_lexical(absolute);
    if paths::is_inside(&source, &path) {
        return paths::relative_slash(&source, &path);
    }
    absolute.to_string_lossy().into_owned()
}

/// Inverse of [`stored_source_path`]: turn a stored value into an absolute path.
///
/// `None` when the value is empty, or relative with no source root configured — the
/// caller must treat that as "cannot resolve", never as "use the relative path as
/// if it were absolute".
pub fn resolve_stored_path(source: Option<&Path>, stored: &str) -> Option<PathBuf> {
    if stored.is_empty() {
        return None;
    }
    let path = Path::new(stored);
    if path.is_absolute() {
        return Some(paths::resolve_lexical(path));
    }
    let source = source?;
    Some(paths::resolve_lexical(
        &source.join(stored.replace('/', std::path::MAIN_SEPARATOR_STR)),
    ))
}

/// Re-point a stored entry path after its work folder moved from `old` to `new`
/// (both absolute).
///
/// WHY: renaming a work root moves the bytes, so every entry and snapshot path
/// that pointed into the old folder has to follow. The replacement is produced by
/// [`stored_source_path`], which means a v1 absolute row rewritten here comes out
/// in the v2 relative form instead of re-pinning the machine path it was carrying.
/// `None` when the value does not resolve under `old` — that row points somewhere
/// else and rewriting it would invent a path.
pub fn relocated_stored_path(source: &Path, stored: &str, old: &Path, new: &Path) -> Option<String> {
    let resolved = resolve_stored_path(Some(source), stored)?;
    let old = paths::resolve_lexical(old);
    if !paths::is_inside(&old, &resolved) {
        return None;
    }
    let mut target = paths::resolve_lexical(new);
    for part in paths::relative_slash(&old, &resolved).split('/') {
        if !part.is_empty() {
            target.push(part);
        }
    }
    Some(stored_source_path(source, &target))
}

/// Move a v1 (flat) source root into type directories. Idempotent.
///
/// A top-level folder that is not already a type directory is a voice work — that
/// is the only kind that ever lived at the source root. `Videos` / `Creations` are
/// the v1 category directories and are only renamed to lowercase.
///
/// `keep` is the library root: a host may legitimately put it inside the source
/// root (the storage-lab tests do), and moving it would take the open database
/// with it.
pub fn migrate_source_dirs(source: &Path, keep: Option<&Path>) -> Result<bool, Error> {
    if !fsutil::path_exists(source) {
        return Ok(false);
    }
    let keep = keep.map(paths::resolve_lexical);
    let mut moved = false;
    let entries = std::fs::read_dir(source)?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        if let Some(keep) = &keep {
            let candidate = paths::resolve_lexical(&entry.path());
            if candidate == *keep {
                continue;
            }
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // `Videos/` and `Creations/` are the v1 category containers: only the
        // container itself is renamed. A voice work keeps its folder name exactly;
        // lowercasing it would rename the user's work directory.
        let target = match name.as_str() {
            VOICES | VIDEOS | CREATIONS => continue,
            "Videos" => source.join(VIDEOS),
            "Creations" => source.join(CREATIONS),
            _ => source.join(VOICES).join(&name),
        };
        if fsutil::path_exists(&target) {
            return Err(Error::new(format!(
                "source migration target already exists: {}",
                target.display()
            )));
        }
        if let Some(parent) = target.parent() {
            fsutil::ensure_dir(parent)?;
        }
        std::fs::rename(entry.path(), &target)?;
        moved = true;
    }
    Ok(moved)
}

/// Prefix of every CAS path stored in `asset.rel_path` / `document_asset_ref`.
pub const CAS_PREFIX: &str = "derived/sha256";

pub fn derived_root(root: &Path) -> PathBuf {
    root.join(DERIVED)
}
pub fn staging_root(root: &Path) -> PathBuf {
    root.join(STAGING)
}
pub fn trash_root(root: &Path) -> PathBuf {
    root.join(TRASH)
}
pub fn cache_root(root: &Path) -> PathBuf {
    root.join(CACHE)
}
pub fn system_root(root: &Path) -> PathBuf {
    root.join(SYSTEM)
}
pub fn snapshots_root(root: &Path) -> PathBuf {
    system_root(root).join(SNAPSHOTS)
}
pub fn quarantine_root(root: &Path) -> PathBuf {
    system_root(root).join(QUARANTINE)
}

/// Every directory a fresh library needs.
pub fn directories(root: &Path) -> Vec<PathBuf> {
    vec![
        derived_root(root),
        staging_root(root),
        trash_root(root),
        cache_root(root),
        snapshots_root(root),
        quarantine_root(root),
    ]
}

/// Layout version recorded in `root.json`, or 1 for a root that predates the field.
pub fn recorded_version(root_metadata: Option<&serde_json::Value>) -> i64 {
    root_metadata
        .and_then(|value| value.get("layout"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
}

/// Legacy shape: everything under `<root>/data/`.
fn legacy_data_root(root: &Path) -> PathBuf {
    root.join("data")
}

/// Convert a v1 root's **files** in place. Safe to call repeatedly.
///
/// WHY this runs before the database is opened: Windows refuses to rename a file
/// that has an open handle, and SQLite keeps one for the lifetime of the
/// connection. Moving first and rewriting rows after (see [`migrate_rows`]) also
/// makes an interruption recoverable — a root with a moved database but unmigrated
/// rows is finished by the next open, whereas a half-moved tree with an open
/// connection would simply fail.
pub fn migrate_files(root: &Path) -> Result<bool, Error> {
    let legacy = legacy_data_root(root);
    let legacy_db = legacy.join(LIBRARY_SQLITE);
    let flat_db = root.join(LIBRARY_SQLITE);
    if fsutil::path_exists(&flat_db) && !fsutil::path_exists(&legacy_db) {
        return Ok(false); // already migrated
    }
    if !fsutil::path_exists(&legacy_db) && !fsutil::path_exists(&flat_db) {
        return Ok(false); // nothing to migrate (fresh root)
    }
    if fsutil::path_exists(&flat_db) && fsutil::path_exists(&legacy_db) {
        return Err(Error::new(format!(
            "both {} and {} exist; refusing to guess which one is authoritative — \
             keep the one with your data and move the other out of the way",
            flat_db.display(),
            legacy_db.display()
        )));
    }

    let moves: Vec<(PathBuf, PathBuf)> = vec![
        (legacy.join("assets"), derived_root(root)),
        (legacy.join("works"), snapshots_root(root)),
        (legacy.join("tmp"), staging_root(root)),
        (legacy.join("cache"), cache_root(root)),
        (legacy.join("trash"), trash_root(root)),
        (root.join(QUARANTINE), quarantine_root(root)),
    ];
    for (from, to) in &moves {
        move_if_present(from, to)?;
    }
    for suffix in ["", "-wal", "-shm"] {
        let from = legacy.join(format!("{LIBRARY_SQLITE}{suffix}"));
        let to = root.join(format!("{LIBRARY_SQLITE}{suffix}"));
        move_if_present(&from, &to)?;
    }
    // The now-empty container goes away so a later `root` cannot be mistaken for
    // a v1 tree again. `remove_dir` only succeeds when empty, which is what we want.
    let _ = std::fs::remove_dir(&legacy);
    Ok(true)
}

/// Rewrite the stored paths a v1 root carries. Idempotent: every statement is a
/// prefix replacement that matches nothing once applied.
pub fn migrate_rows(conn: &Connection, source_root: Option<&Path>) -> Result<(), Error> {
    // `asset.rel_path` was `<data root>/assets/sha256/ab/hash`.
    conn.execute(
        "UPDATE asset SET rel_path = replace(rel_path, 'assets/sha256/', ?1) WHERE rel_path LIKE 'assets/sha256/%'",
        rusqlite::params![format!("{CAS_PREFIX}/")],
    )?;
    // Post folders were `<Category>/<Provider>/<Creator>/<Folder>`.
    conn.execute(
        "UPDATE post SET root_path = replace(root_path, 'Videos/', 'videos/') WHERE root_path LIKE 'Videos/%'",
        [],
    )?;
    conn.execute(
        "UPDATE post SET root_path = replace(root_path, 'Creations/', 'creations/') WHERE root_path LIKE 'Creations/%'",
        [],
    )?;
    if SOURCE_LAYERED {
        if let Some(source) = source_root {
            rewrite_source_paths(conn, source)?;
        }
    }
    Ok(())
}

/// Move creation attachments from `<library root>/creations/` into the source
/// tree's readable post folders. Idempotent.
///
/// WHY: these bytes are user content — the only copy — and layout v2 keeps user
/// content in the source root next to `voices/` and `videos/`. The old folder was
/// `<library root>/creations/<sha256(post id)>/<uuid>`, so neither the location
/// nor the name told a human which post it belonged to or let them copy it out on
/// its own. The new name comes from the post's metadata, the same four-segment
/// rule video posts use ([`crate::naming::post_folder`]).
///
/// Both the bytes and `creation_asset.rel_path` move. Every step is expressed as
/// "if the file is not already at the target, move it", so a second open on a
/// migrated library finds nothing to do. A row whose bytes are gone is left
/// alone: rewriting its path would claim a file that does not exist.
pub fn migrate_creation_assets(connection: &Connection, library_root: &Path, source_root: &Path) -> Result<bool, Error> {
    let library_root = paths::resolve_lexical(library_root);
    let source_root = paths::resolve_lexical(source_root);
    let legacy_root = library_root.join(LEGACY_CREATIONS);
    if !fsutil::path_exists(&legacy_root) {
        return Ok(false);
    }
    let post_ids: Vec<String> = {
        let mut statement = connection.prepare("SELECT post_id FROM creation_post WHERE deleted_at IS NULL ORDER BY post_id")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids
    };
    let mut moved = false;
    for post_id in post_ids {
        let folder = crate::creations::post_folder_for(connection, &post_id)?;
        let target_folder = source_root.join(&folder);
        let rows: Vec<(String, String, String, String)> = {
            let mut statement = connection.prepare(
                "SELECT asset_id, name, mime, rel_path FROM creation_asset WHERE post_id = ? ORDER BY created_at, asset_id",
            )?;
            let rows = statement
                .query_map(rusqlite::params![post_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut claimed: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        for (asset_id, name, mime, rel_path) in rows {
            let file_name = crate::creations::asset_file_name(&asset_id, &name, &mime);
            let desired_rel = format!("{folder}/{file_name}");
            let desired = source_root.join(&desired_rel);
            if let Some(current) = stored_asset_path(&library_root, &source_root, &rel_path) {
                // Remember every file a row still names, so the orphan pass below
                // cannot move a file the row deliberately left in place (the
                // conflict case).
                claimed.insert(paths::resolve_lexical(&current));
                // `is_file` as well as `exists`: a malformed row must not turn a
                // directory into an "attachment" by renaming it into the post
                // folder.
                if current != desired && current.is_file() {
                    if let Some(parent) = desired.parent() {
                        fsutil::ensure_dir(parent).map_err(|error| {
                            Error::new(format!("could not create {}: {}", parent.display(), error.message))
                        })?;
                    }
                    if fsutil::path_exists(&desired) {
                        // Both copies exist (an interrupted run). Keep the one new
                        // rows use and drop the stale copy only when it is byte
                        // identical; different bytes mean a conflict this
                        // migration must not resolve by guessing, so the row is
                        // left pointing at the file it was pointing at.
                        if same_bytes(&current, &desired) {
                            let _ = std::fs::remove_file(&current);
                            moved = true;
                        } else {
                            continue;
                        }
                    } else {
                        move_file(&current, &desired)?;
                        moved = true;
                    }
                }
            }
            // Only claim the new path once the bytes are really there.
            if rel_path != desired_rel && fsutil::path_exists(&desired) {
                connection.execute(
                    "UPDATE creation_asset SET rel_path = ?1 WHERE asset_id = ?2",
                    rusqlite::params![desired_rel, asset_id],
                )?;
                moved = true;
            }
        }
        // Files a row never mentioned (an interrupted write) still belong to the
        // post. The directory name is the post key, which is how it is found.
        let legacy_dir = legacy_root.join(crate::creations::post_key(&post_id));
        if fsutil::path_exists(&legacy_dir) {
            if let Ok(entries) = std::fs::read_dir(&legacy_dir) {
                for entry in entries.flatten() {
                    if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
                        continue;
                    }
                    if claimed.contains(&paths::resolve_lexical(&entry.path())) {
                        continue;
                    }
                    let target = target_folder.join(entry.file_name());
                    if fsutil::path_exists(&target) {
                        if same_bytes(&entry.path(), &target) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                        continue;
                    }
                    fsutil::ensure_dir(&target_folder).map_err(|error| {
                        Error::new(format!("could not create {}: {}", target_folder.display(), error.message))
                    })?;
                    move_file(&entry.path(), &target)?;
                    moved = true;
                }
            }
            let _ = std::fs::remove_dir(&legacy_dir);
        }
    }
    // Only succeeds when nothing else was left behind; anything unknown keeps the
    // directory so a later run (or the user) can still see it.
    let _ = std::fs::remove_dir(&legacy_root);
    Ok(moved)
}

/// Absolute path a stored `creation_asset.rel_path` means right now.
///
/// A relative value may still sit under the library root (written before the
/// source root was configured) or under the source root; the existing one wins.
/// When neither exists the source-root interpretation is returned and the caller
/// treats it as "bytes missing".
fn stored_asset_path(library_root: &Path, source_root: &Path, stored: &str) -> Option<PathBuf> {
    let parsed = PathBuf::from(paths::normalize_slashes(stored).as_str());
    if parsed.is_absolute() {
        return Some(paths::resolve_lexical(&parsed));
    }
    let in_source = paths::resolve_lexical(&source_root.join(&parsed));
    if fsutil::path_exists(&in_source) {
        return Some(in_source);
    }
    let in_library = paths::resolve_lexical(&library_root.join(&parsed));
    if fsutil::path_exists(&in_library) {
        return Some(in_library);
    }
    Some(in_source)
}

/// Two files carry identical bytes.
///
/// Length is checked first because it is one stat call and settles the common
/// "different file" case; the hash is what makes the delete safe.
fn same_bytes(left: &Path, right: &Path) -> bool {
    let size = |path: &Path| std::fs::metadata(path).map(|info| info.len()).ok();
    let (Some(left_size), Some(right_size)) = (size(left), size(right)) else {
        return false;
    };
    if left_size != right_size {
        return false;
    }
    match (crate::hash::hash_file(left), crate::hash::hash_file(right)) {
        (Ok((left, _)), Ok((right, _))) => left == right,
        _ => false,
    }
}

/// Rename, falling back to copy + remove when the two paths are on different
/// volumes (the source root is allowed to be another drive).
fn move_file(from: &Path, to: &Path) -> Result<(), Error> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|error| {
        Error::new(format!(
            "could not move {} to {}: {error}",
            from.display(),
            to.display()
        ))
    })?;
    std::fs::remove_file(from).map_err(|error| {
        Error::new(format!("could not remove {} after copying it: {error}", from.display()))
    })?;
    Ok(())
}

/// Move legacy source folders under their type directory and repoint every
/// absolute path stored in `entry`.
///
/// The move is per work root: a top-level folder that is not already one of
/// [`VOICES`] / [`VIDEOS`] / [`CREATIONS`] is a voice work and goes into `voices/`.
/// Category folders are only renamed (`Videos` → `videos`).
fn rewrite_source_paths(conn: &Connection, source: &Path) -> Result<(), Error> {
    let mut statement = conn.prepare("SELECT DISTINCT original_path FROM entry WHERE original_path IS NOT NULL AND original_path != ''")?;
    let rows: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for original in rows {
        let Some(new_path) = relocated_source_path(source, &original) else { continue };
        conn.execute(
            "UPDATE entry SET original_path = ?1 WHERE original_path = ?2",
            rusqlite::params![new_path, original],
        )?;
    }
    Ok(())
}

/// Compute where `original` lives after the type-directory migration, in the form
/// layout v2 stores: relative to the source root, `/` separated.
///
/// Accepts both stored shapes — relative (what the write side produces since
/// phase 2a) and absolute (rows written before it) — because the migration has to
/// finish on a library that is half converted. Returns `None` when the path is
/// outside the source root or already carries a type directory: an entry whose
/// bytes the user moved away is left alone, not silently rewritten to a path that
/// does not exist.
fn relocated_source_path(source: &Path, original: &str) -> Option<String> {
    let source = paths::resolve_lexical(source);
    let path = resolve_stored_path(Some(&source), original)?;
    if !paths::is_inside(&source, &path) {
        return None;
    }
    let relative = paths::relative_slash(&source, &path);
    if relative.is_empty() {
        return None;
    }
    let mut parts = relative.split('/');
    let first = parts.next()?;
    let rest: Vec<&str> = parts.collect();
    let (type_dir, tail): (&str, Vec<&str>) = match first {
        VOICES | VIDEOS | CREATIONS => return None, // already relocated
        "Videos" => (VIDEOS, rest),
        "Creations" => (CREATIONS, rest),
        _ => (VOICES, std::iter::once(first).chain(rest).collect()),
    };
    let mut relocated = vec![type_dir];
    relocated.extend(tail);
    Some(relocated.join("/"))
}

/// `rename`, tolerating a missing source (already moved) and an existing target.
///
/// A target may already exist for two legitimate reasons: the layout directories
/// are created eagerly on open, and an interrupted migration can leave a partial
/// tree behind. An empty target is replaced; a non-empty one is merged child by
/// child, refusing only on a real name collision.
fn move_if_present(from: &Path, to: &Path) -> Result<(), Error> {
    if !fsutil::path_exists(from) {
        return Ok(());
    }
    if !fsutil::path_exists(to) {
        if let Some(parent) = to.parent() {
            fsutil::ensure_dir(parent)?;
        }
        std::fs::rename(from, to)?;
        return Ok(());
    }
    if std::fs::remove_dir(to).is_ok() {
        std::fs::rename(from, to)?;
        return Ok(());
    }
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let child_to = to.join(entry.file_name());
        if fsutil::path_exists(&child_to) {
            return Err(Error::new(format!(
                "migration target already exists: {}",
                child_to.display()
            )));
        }
        std::fs::rename(entry.path(), &child_to)?;
    }
    let _ = std::fs::remove_dir(from);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mono-layout-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// A v1 root has everything under `data/` and no `layout` in root.json.
    pub(super) fn seed_v1(root: &Path) {
        let data = root.join("data");
        for directory in ["assets/sha256", "works", "tmp", "cache", "trash"] {
            fs::create_dir_all(data.join(directory)).unwrap();
        }
        fs::create_dir_all(root.join("quarantine")).unwrap();
        let connection = Connection::open(data.join(LIBRARY_SQLITE)).unwrap();
        crate::schema::enable_pragmas(&connection).unwrap();
        crate::schema::apply_schema(&connection, "lib-fixture").unwrap();
        connection
            .execute(
                "INSERT INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                 VALUES ('a1', 'deadbeef', 3, 'image/png', 'assets/sha256/de/deadbeef', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);
        fs::write(
            root.join(ROOT_JSON),
            r#"{"schemaVersion":8,"libraryId":"lib-fixture","createdAt":"2026-01-01T00:00:00Z","app":"monochrome-storage-lab"}"#,
        )
        .unwrap();
    }

    #[test]
    fn v1_root_is_flattened_and_stored_paths_follow() {
        let root = temp_root("flatten");
        seed_v1(&root);

        assert!(migrate_files(&root).unwrap());
        // Directories moved, the container is gone.
        assert!(!root.join("data").exists());
        for directory in [DERIVED, STAGING, TRASH, CACHE] {
            assert!(root.join(directory).is_dir(), "{directory} missing");
        }
        assert!(snapshots_root(&root).is_dir());
        assert!(quarantine_root(&root).is_dir());
        assert!(root.join(LIBRARY_SQLITE).is_file());

        // Rows follow the new names.
        let connection = Connection::open(root.join(LIBRARY_SQLITE)).unwrap();
        migrate_rows(&connection, None).unwrap();
        let rel: String = connection
            .query_row("SELECT rel_path FROM asset WHERE asset_id = 'a1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rel, "derived/sha256/de/deadbeef");
        // Running it again changes nothing (the statements no longer match).
        migrate_rows(&connection, None).unwrap();
        let rel_again: String = connection
            .query_row("SELECT rel_path FROM asset WHERE asset_id = 'a1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rel_again, rel);
        drop(connection);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_is_a_no_op_on_a_v2_root() {
        let root = temp_root("noop");
        for directory in directories(&root) {
            fs::create_dir_all(directory).unwrap();
        }
        let _connection = Connection::open(root.join(LIBRARY_SQLITE)).unwrap();
        assert!(!migrate_files(&root).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    /// Creation attachments are user content that used to sit in the library root
    /// under an opaque hash. They must end up in the readable source tree exactly
    /// once, with `rel_path` following them; a second run must not move anything.
    #[test]
    fn creation_assets_move_into_the_source_tree_once() {
        let base = temp_root("creations");
        let library = base.join("library");
        let source = base.join("source");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&source).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        crate::schema::enable_pragmas(&connection).unwrap();
        crate::schema::apply_schema(&connection, "lib-creations").unwrap();
        crate::creations::save_post(
            &connection,
            &serde_json::json!({
                "id": "p1",
                "title": "A Post",
                "provider": "Patreon",
                "creator": "Some Creator",
                "date": "2026-02-10"
            }),
        )
        .unwrap();
        let key = crate::creations::post_key("p1");
        let legacy_dir = library.join(LEGACY_CREATIONS).join(&key);
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("asset-1"), b"hello").unwrap();
        connection
            .execute(
                "INSERT INTO creation_asset(asset_id, post_id, attachment_id, role, name, mime, bytes, sha256, rel_path, created_at)
                 VALUES ('asset-1', 'p1', 'att-1', 'original', 'a.png', 'image/png', 5, 'x', ?1, '2026-01-01T00:00:00Z')",
                rusqlite::params![format!("{}/{key}/asset-1", LEGACY_CREATIONS)],
            )
            .unwrap();

        assert!(migrate_creation_assets(&connection, &library, &source).unwrap());
        let rel: String = connection
            .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = 'asset-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rel, "creations/Patreon/Some Creator/2026-02-10 A Post [p1]/asset-1.png");
        assert_eq!(fs::read(source.join(&rel)).unwrap(), b"hello");
        assert!(!legacy_dir.exists(), "the opaque folder is gone");

        // Idempotent: the row already points at bytes that are already there.
        assert!(!migrate_creation_assets(&connection, &library, &source).unwrap());
        let again: String = connection
            .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = 'asset-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(again, rel);
        let _ = fs::remove_dir_all(&base);
    }

    /// A half-migrated root can hold two different files at the same intended
    /// name. The migration must not pick one and rewrite the row over the
    /// conflict: both files stay, and the row keeps pointing where it pointed.
    #[test]
    fn a_conflicting_target_is_left_for_a_human() {
        let base = temp_root("creations-conflict");
        let library = base.join("library");
        let source = base.join("source");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&source).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        crate::schema::enable_pragmas(&connection).unwrap();
        crate::schema::apply_schema(&connection, "lib-creations-3").unwrap();
        crate::creations::save_post(&connection, &serde_json::json!({ "id": "p3", "title": "C" })).unwrap();
        let key = crate::creations::post_key("p3");
        let rel = format!("creations/{key}/asset-1");
        let legacy = library.join(&rel);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"legacy").unwrap();
        let target = source
            .join("creations/Unknown/Unknown/0000-00-00 C [p3]")
            .join("asset-1.png");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"different").unwrap();
        connection
            .execute(
                "INSERT INTO creation_asset(asset_id, post_id, attachment_id, role, name, mime, bytes, sha256, rel_path, created_at)
                 VALUES ('asset-1', 'p3', 'a', 'original', 'a.png', 'image/png', 6, 'x', ?1, '2026-01-01T00:00:00Z')",
                rusqlite::params![rel],
            )
            .unwrap();

        assert!(!migrate_creation_assets(&connection, &library, &source).unwrap());
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy");
        assert_eq!(fs::read(&target).unwrap(), b"different");
        let stored: String = connection
            .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = 'asset-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, rel);
        let _ = fs::remove_dir_all(&base);
    }

    /// A relative row written before the source root was configured lives under
    /// the library root; the migration has to find it there, not assume the
    /// source root's copy exists.
    #[test]
    fn creation_asset_written_under_the_library_root_is_moved() {
        let base = temp_root("creations-library");
        let library = base.join("library");
        let source = base.join("source");
        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&source).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        crate::schema::enable_pragmas(&connection).unwrap();
        crate::schema::apply_schema(&connection, "lib-creations-2").unwrap();
        crate::creations::save_post(&connection, &serde_json::json!({ "id": "p2", "title": "B" })).unwrap();
        let rel = "creations/Unknown/Unknown/0000-00-00 B [p2]/hash.png";
        let file = library.join(rel);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"png").unwrap();
        connection
            .execute(
                "INSERT INTO creation_asset(asset_id, post_id, attachment_id, role, name, mime, bytes, sha256, rel_path, created_at)
                 VALUES ('hash', 'p2', 'a', 'original', 'x.png', 'image/png', 3, 'x', ?1, '2026-01-01T00:00:00Z')",
                rusqlite::params![rel],
            )
            .unwrap();

        assert!(migrate_creation_assets(&connection, &library, &source).unwrap());
        assert_eq!(fs::read(source.join(rel)).unwrap(), b"png");
        assert!(!file.exists());
        let stored: String = connection
            .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = 'hash'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, rel);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn both_layouts_present_is_refused() {
        let root = temp_root("conflict");
        seed_v1(&root);
        fs::write(root.join(LIBRARY_SQLITE), b"not-a-database").unwrap();
        let error = migrate_files(&root).unwrap_err();
        assert!(error.message.contains("refusing to guess"), "{}", error.message);
        let _ = fs::remove_dir_all(&root);
    }

    /// Open creates the layout directories eagerly, so a legacy root can meet an
    /// empty `derived/` and friends. That must merge, not fail: failing here is
    /// what left a real library stranded behind an empty second database.
    #[test]
    fn existing_empty_layout_dirs_are_merged() {
        let root = temp_root("merge");
        seed_v1(&root);
        for directory in directories(&root) {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(derived_root(&root).join("sentinel"), b"keep").unwrap();
        assert!(migrate_files(&root).unwrap());
        assert!(derived_root(&root).join("sentinel").exists(), "existing content kept");
        assert!(root.join(LIBRARY_SQLITE).is_file());
        assert!(!root.join("data").exists());
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod open_tests {
    use super::tests::seed_v1;
    use super::*;
    use crate::library::{Library, OpenOptions};

    /// The host opens every root with `create: true` (it cannot know yet whether the
    /// root exists). Migration therefore must not be gated on that flag: the first
    /// version was, and a v1 root silently got a second, empty database beside the
    /// real one. This asserts the root is converted in exactly that situation.
    #[test]
    fn opening_with_create_still_migrates_a_v1_root() {
        let root = std::env::temp_dir().join(format!("mono-layout-create-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        seed_v1(&root);

        let library = Library::open(
            &root,
            OpenOptions {
                create: true,
                allow_outside_root: true,
                experiment_root: None,
                snapshot_fault: None,
            },
        )
        .unwrap();
        assert!(!root.join("data").exists(), "legacy container survived");
        assert!(root.join(LIBRARY_SQLITE).is_file());
        let works: i64 = library
            .connection
            .query_row("SELECT COUNT(*) FROM library", [], |row| row.get(0))
            .unwrap();
        assert_eq!(works, 1, "the migrated database is the one that was opened");
        drop(library);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod row_tests {
    use super::*;

    /// `entry.original_path` was absolute in layout v1; from phase 2a it is stored
    /// relative to the source root. Migration has to move a flat work under
    /// `voices/` *and* normalise the shape, while an already-moved work and a path
    /// outside the source root stay untouched (the user moved those bytes;
    /// rewriting them would point at nothing).
    #[test]
    fn source_paths_gain_the_type_directory_once() {
        let root = std::env::temp_dir().join(format!("mono-layout-rows-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();

        let connection = Connection::open_in_memory().unwrap();
        crate::schema::enable_pragmas(&connection).unwrap();
        crate::schema::apply_schema(&connection, "lib-rows").unwrap();
        connection
            .execute(
                "INSERT INTO work(work_id, title, created_at, updated_at) VALUES ('w1', 'W', 'now', 'now')",
                [],
            )
            .unwrap();
        let outside = root.join("elsewhere").join("x.mp3");
        let cases = [
            // v1 absolute, flat work: becomes relative *and* gains `voices/`.
            (source.join("[RJ1] W").join("f.mp3"), PathBuf::from("voices/[RJ1] W/f.mp3")),
            // Already under a type directory: untouched, still absolute.
            (source.join("voices").join("[RJ2] V").join("g.mp3"), source.join("voices").join("[RJ2] V").join("g.mp3")),
            // Outside the source root: untouched, still absolute.
            (outside.clone(), outside.clone()),
            // A relative row that has not been relocated yet: accepted and prefixed.
            (PathBuf::from("[RJ3] R").join("h.mp3"), PathBuf::from("voices/[RJ3] R/h.mp3")),
        ];
        for (index, (before, _)) in cases.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO entry(entry_id, work_id, stable_entry_id, logical_path, kind, original_path)
                     VALUES (?1, 'w1', ?2, ?3, 'audio', ?4)",
                    rusqlite::params![
                        format!("e{index}"),
                        format!("s{index}"),
                        format!("{index}.mp3"),
                        before.to_string_lossy()
                    ],
                )
                .unwrap();
        }

        migrate_rows(&connection, Some(&source)).unwrap();
        for (index, (_, after)) in cases.iter().enumerate() {
            let stored: String = connection
                .query_row("SELECT original_path FROM entry WHERE entry_id = ?1", [format!("e{index}")], |row| row.get(0))
                .unwrap();
            assert_eq!(std::path::Path::new(&stored), after.as_path(), "case {index}");
        }

        // Idempotent: a second pass must not add a second `voices/`.
        migrate_rows(&connection, Some(&source)).unwrap();
        for (index, (_, after)) in cases.iter().enumerate() {
            let again: String = connection
                .query_row("SELECT original_path FROM entry WHERE entry_id = ?1", [format!("e{index}")], |row| row.get(0))
                .unwrap();
            assert_eq!(std::path::Path::new(&again), after.as_path(), "case {index} second pass");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The type-directory mapping itself, stated once so the three categories can
    /// not drift apart: only the v1 containers are renamed, a flat work becomes a
    /// voice work, and a root that is only a name prefix of the path is not
    /// "inside" (`<base>/source2` must not look like `<base>/source`).
    #[test]
    fn relocated_source_path_maps_each_category_once() {
        // Absolute paths, built from a real temp dir: `Path::is_absolute()` is
        // false for a bare `/…` literal on Windows, which would turn every case
        // below into a join and hide what is being tested.
        let base = std::env::temp_dir().join(format!("mono-layout-map-{}", uuid::Uuid::new_v4()));
        let source = base.join("source");
        let slashed = |path: &Path| paths::slashes(path);
        let stored = |relative: &str| slashed(&source.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)));

        assert_eq!(
            relocated_source_path(&source, &stored("w/f.mp3")).as_deref(),
            Some("voices/w/f.mp3")
        );
        assert_eq!(
            relocated_source_path(&source, &stored("Videos/p/f.mp4")).as_deref(),
            Some("videos/p/f.mp4")
        );
        assert_eq!(
            relocated_source_path(&source, &stored("Creations/p/a.jpg")).as_deref(),
            Some("creations/p/a.jpg")
        );
        // Relative input is accepted the same way.
        assert_eq!(relocated_source_path(&source, "w/f.mp3").as_deref(), Some("voices/w/f.mp3"));
        // Already relocated: nothing to do.
        assert_eq!(relocated_source_path(&source, &stored("videos/p/f.mp4")), None);
        // `..` escapes the root and is refused rather than clamped.
        assert_eq!(relocated_source_path(&source, "../w/f.mp3"), None);
        // A sibling directory whose name starts with the root's name is outside.
        let sibling = base.join("source2").join("w").join("f.mp3");
        assert_eq!(relocated_source_path(&source, &slashed(&sibling)), None);
        assert_eq!(relocated_source_path(&source, &slashed(&base.join("elsewhere").join("w").join("f.mp3"))), None);
    }

    /// A work-root rename has to carry every stored entry path with it, and it must
    /// write back the same shape the write side uses now (relative), even when the
    /// row it started from was absolute.
    #[test]
    fn relocated_stored_path_follows_a_rename_in_the_stored_shape() {
        let base = std::env::temp_dir().join(format!("mono-layout-rename-{}", uuid::Uuid::new_v4()));
        let source = base.join("source");
        let old = source.join("voices").join("[RJ1] Old");
        let new = source.join("voices").join("[RJ1] New");
        let slashed = |path: &Path| paths::slashes(path);

        assert_eq!(
            relocated_stored_path(&source, &slashed(&old.join("mp3").join("01.mp3")), &old, &new).as_deref(),
            Some("voices/[RJ1] New/mp3/01.mp3")
        );
        assert_eq!(
            relocated_stored_path(&source, "voices/[RJ1] Old/mp3/01.mp3", &old, &new).as_deref(),
            Some("voices/[RJ1] New/mp3/01.mp3")
        );
        // Not under the old root: left alone by the caller.
        assert_eq!(
            relocated_stored_path(&source, &slashed(&source.join("elsewhere").join("01.mp3")), &old, &new),
            None
        );
        // The old prefix must end at a component, never in the middle of a name.
        let lookalike = source.join("voices").join("[RJ1] Older").join("01.mp3");
        assert_eq!(relocated_stored_path(&source, &slashed(&lookalike), &old, &new), None);
    }
}
