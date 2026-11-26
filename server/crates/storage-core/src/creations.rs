//! Creation posts and their binary assets (`creations.mjs`).
//!
//! Creation posts live in their own tables and their own `<source>/creations/`
//! tree, deliberately separate from the voice work model: a Pawchive/Patreon post
//! has no RJ code, no manifest and no rendition, so forcing it into `work`/`entry`
//! would make every voice query carry creation-shaped rows.
//!
//! Attachments are user content — the only copy of those bytes — so they live in
//! the source root next to `voices/` and `videos/`, under a folder named from the
//! post's own metadata (`<platform>/<creator>/<date title [id]>`). That name is
//! shared with video posts (`storage_core::naming`): a human must be able to tell
//! two posts apart in a file manager and copy or delete one without the database.
//!
//! Files are named by asset UUID, not by hash: the same attachment may be
//! re-uploaded with a new role (original + thumbnail share one display name), and
//! the UUID is what keeps the two files distinct without consulting the directory.
//! The hash is still recorded so a future dedupe can find identical bytes.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::hash::{hex, sha256_text};
use crate::jsonutil::{now_iso, parse_object};
use crate::layout;
use crate::naming;
use crate::paths;

fn text_value(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => fallback.to_string(),
    }
}

/// Stable on-disk directory leaf for a post: sha256 of its id.
///
/// Only used for libraries written before attachments moved into the readable
/// source tree; [`crate::layout::migrate_creation_assets`] recognises those
/// folders by this key and [`delete_post`] still cleans them up on a library the
/// migration has not touched yet.
pub(crate) fn post_key(post_id: &str) -> String {
    sha256_text(post_id)
}

/// Root that holds `creations/` for this call.
///
/// A host opened with a source root stores user content there (layout v2). A host
/// without one — the storage-lab unit tests, and a library opened before the
/// source root was configured — keeps the legacy location so the bytes are still
/// found. The argument is a plain path rather than the `Host` on purpose:
/// `storage-core` must not know about host options.
fn creations_root(library_root: &Path, source_root: Option<&Path>) -> PathBuf {
    source_root.unwrap_or(library_root).join(layout::CREATIONS)
}

/// Resolve a stored `creation_asset.rel_path` to an absolute path.
///
/// Relative values are resolved under the source root (or under the library root
/// when the host has none — the write side uses the same base). Absolute values
/// are left as they are, because an old row may point outside both roots and
/// rewriting it would invent a location.
fn resolve_stored_asset(library_root: &Path, source_root: Option<&Path>, stored: &str) -> Option<PathBuf> {
    let normalized = paths::normalize_slashes(stored);
    if normalized.is_empty() {
        return None;
    }
    let parsed = PathBuf::from(&normalized);
    if parsed.is_absolute() {
        return Some(paths::resolve_lexical(&parsed));
    }
    let base = source_root.unwrap_or(library_root);
    Some(paths::resolve_lexical(&base.join(&normalized)))
}

/// Extension a human can use to open the file, from the attachment name first
/// (what the user saved it as) and the MIME type second.
///
/// Keeping the UUID as the stem is deliberate; the extension is pure reading aid.
fn asset_extension(name: &str, mime: &str) -> Option<String> {
    if let Some((_, extension)) = name.rsplit_once('.') {
        let valid = (1..=10).contains(&extension.len()) && extension.chars().all(|ch| ch.is_ascii_alphanumeric());
        if valid {
            return Some(extension.to_ascii_lowercase());
        }
    }
    let mime = mime.split(';').next().unwrap_or(mime).trim().to_ascii_lowercase();
    let extension = match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/flac" => "flac",
        "audio/ogg" => "ogg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "text/plain" => "txt",
        _ => return None,
    };
    Some(extension.to_string())
}

/// File name inside the post folder for one asset row.
pub(crate) fn asset_file_name(asset_id: &str, name: &str, mime: &str) -> String {
    match asset_extension(name, mime) {
        Some(extension) => format!("{asset_id}.{extension}"),
        None => asset_id.to_string(),
    }
}

/// First non-empty text among `keys`.
fn first_text(data: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        data.get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

/// Host name of the post's source URL, used as a last-resort platform.
///
/// `provider`/`creatorPlatform` are written by the import that calls us; a bare
/// `{id, title, sourceUrl}` post (the creation page's local import) only carries
/// the URL, and the host is the one stable, human-meaningful word in it.
fn platform_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.trim();
    if host.is_empty() {
        return None;
    }
    Some(host.strip_prefix("www.").unwrap_or(host).to_string())
}

/// Folder a post's attachments belong in, as `<creations>/<Platform>/<Creator>/<date title [id]>`.
///
/// WHY a formula and not a stored column: `creation_post` has no provider or
/// creator column — only `title`, `source_url` and the opaque `data_json` that the
/// import wrote. The JSON body holds `provider`/`creatorPlatform` and `creator`,
/// so it is read here and the same four-segment rule as videos applies. Missing
/// fields fall back to `Unknown` and the post id, which is still a stable name.
///
/// The result is validated as a logical path before it is ever joined onto a
/// filesystem root: a title is client-controlled, and `..`/`:`/separators must
/// not be able to address anything outside the creations tree. `naming::segment`
/// already replaces them; the validation is the second, independent gate. If even
/// that fails (a name the NFC pass cannot represent), the hashed folder is the
/// last resort — still inside the tree, just not readable.
fn derived_folder(post_id: &str, title: &str, data_json: &str) -> String {
    let parsed = parse_object(Some(data_json));
    let platform = first_text(&parsed, &["provider", "creatorPlatform", "sourcePlatform", "platform"])
        .or_else(|| {
            parsed
                .get("sourceUrl")
                .or_else(|| parsed.get("importedFrom"))
                .and_then(Value::as_str)
                .and_then(platform_from_url)
        })
        .unwrap_or_else(|| "Unknown".to_string());
    let creator = first_text(&parsed, &["creator", "creatorName"]).unwrap_or_else(|| "Unknown".to_string());
    let date = parsed.get("date").and_then(Value::as_str).unwrap_or("");
    let title = first_text(&parsed, &["title"]).unwrap_or_else(|| title.to_string());
    let candidate = naming::post_folder(layout::CREATIONS, &platform, &creator, date, &title, post_id);
    paths::validate_logical_path(&candidate)
        .unwrap_or_else(|_| format!("{}/{}", layout::CREATIONS, post_key(post_id)))
}

/// The post folder a row already lives in, if any.
///
/// Reusing it is what keeps the folder stable: a re-import may correct the title
/// or creator, and recomputing the name would move the post to a second folder
/// and strand the files behind the first. The first row wins for the lifetime of
/// the post, exactly like `post.root_path` does for videos.
///
/// Only the four-segment shape is accepted. A legacy `<post key>/<file>` row is
/// not a name a human chose, so it is deliberately not reused; the migration
/// gives those rows their readable folder.
fn existing_folder(connection: &Connection, post_id: &str) -> Result<Option<String>> {
    let mut statement = connection.prepare("SELECT rel_path FROM creation_asset WHERE post_id = ? ORDER BY created_at, asset_id")?;
    let rows: Vec<String> = statement
        .query_map(rusqlite::params![post_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for rel_path in rows {
        let normalized = paths::normalize_slashes(&rel_path);
        let parts: Vec<&str> = normalized.split('/').collect();
        // `<type>/<Platform>/<Creator>/<leaf>/<file>`
        if parts.len() != 5 {
            continue;
        }
        let folder = parts[..4].join("/");
        if let Ok(validated) = naming::validated_post_root("creation", &folder) {
            return Ok(Some(validated));
        }
    }
    Ok(None)
}

/// The folder for `post_id`, reusing the one already on disk when present.
///
/// Deliberately ignores `deleted_at`: this is a naming decision, and the
/// migration still has to name the folder of a soft-deleted row it is moving.
/// Callers that write check the row is live themselves.
pub fn post_folder_for(connection: &Connection, post_id: &str) -> Result<String> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT title, data_json FROM creation_post WHERE post_id = ?",
            rusqlite::params![post_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((title, data_json)) = row else {
        return Err(Error::not_found("creation post not found"));
    };
    if let Some(folder) = existing_folder(connection, post_id)? {
        return Ok(folder);
    }
    Ok(derived_folder(post_id, &title, &data_json))
}

/// Save or replace a post. Returns the deduplicated row fields.
pub fn save_post(connection: &Connection, post: &Value) -> Result<Value> {
    let post_id = text_value(post.get("id"), "").trim().to_string();
    if post_id.is_empty() {
        return Err(Error::bad_request("creation post id is required"));
    }
    let timestamp = now_iso();
    let raw_title = text_value(post.get("title"), "").trim().to_string();
    let title = if raw_title.is_empty() { post_id.clone() } else { raw_title };
    let source_url = text_value(post.get("sourceUrl").or_else(|| post.get("importedFrom")), "");
    // The whole post is stored as JSON: the frontend round-trips fields this
    // host does not model (attachments, tags, media kinds), and losing them would
    // corrupt an imported post on the next read.
    let data = serde_json::to_string(post).unwrap_or_else(|_| "{}".to_string());
    connection.execute(
        "INSERT INTO creation_post(post_id, title, source_url, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET
            title = excluded.title,
            source_url = excluded.source_url,
            data_json = excluded.data_json,
            revision = revision + 1,
            deleted_at = NULL,
            updated_at = excluded.updated_at",
        rusqlite::params![post_id, title, source_url, data, timestamp, timestamp],
    )?;
    Ok(json!({
        "postId": post_id,
        "title": title,
        "sourceUrl": source_url,
        "updatedAt": timestamp,
    }))
}

/// List live posts with their host assets.
pub fn list_posts(connection: &Connection) -> Result<Value> {
    let mut post_statement = connection.prepare(
        "SELECT post_id, title, source_url, data_json, updated_at FROM creation_post
         WHERE deleted_at IS NULL ORDER BY created_at, post_id",
    )?;
    let rows: Vec<(String, String, String, String, String)> = post_statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut asset_statement = connection.prepare(
        "SELECT * FROM creation_asset WHERE post_id = ? ORDER BY created_at, attachment_id, role",
    )?;
    let mut posts = Vec::with_capacity(rows.len());
    for (post_id, row_title, row_source_url, data_json, updated_at) in rows {
        let parsed = parse_object(Some(&data_json));
        let assets: Vec<Value> = asset_statement
            .query_map(rusqlite::params![post_id], |row| {
                let asset_id: String = row.get("asset_id")?;
                Ok(json!({
                    "assetId": asset_id,
                    "attachmentId": row.get::<_, String>("attachment_id")?,
                    "role": row.get::<_, String>("role")?,
                    "name": row.get::<_, String>("name")?,
                    "mime": row.get::<_, String>("mime")?,
                    "bytes": row.get::<_, i64>("bytes")?,
                    "sha256": row.get::<_, String>("sha256")?,
                    "mediaPath": format!(
                        "/api/creations/media/{}",
                        percent_encode(&asset_id)
                    ),
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Post fields win over the row when present, because the row's title is a
        // fallback written at import time. This mirrors `text(post.title, row.title)`.
        let mut post: Map<String, Value> = parsed;
        post.insert("id".to_string(), json!(post_id));
        let title = post
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(row_title);
        post.insert("title".to_string(), json!(title));
        let source_url = post
            .get("sourceUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(row_source_url);
        post.insert("sourceUrl".to_string(), json!(source_url));
        post.insert("hostAssets".to_string(), Value::Array(assets));
        post.insert("hostUpdatedAt".to_string(), json!(updated_at));
        posts.push(Value::Object(post));
    }
    Ok(Value::Array(posts))
}

/// Default MIME when the caller sends none.
const DEFAULT_MIME: &str = "application/octet-stream";

/// Result of storing one asset.
#[derive(Debug)]
pub struct StoredAsset {
    pub asset_id: String,
    pub attachment_id: String,
    pub role: String,
    pub name: String,
    pub mime: String,
    pub bytes: usize,
    pub sha256: String,
}

impl StoredAsset {
    pub fn to_json(&self) -> Value {
        json!({
            "assetId": self.asset_id,
            "attachmentId": self.attachment_id,
            "role": self.role,
            "name": self.name,
            "mime": self.mime,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "mediaPath": format!("/api/creations/media/{}", percent_encode(&self.asset_id)),
        })
    }
}

/// Store one attachment for a post.
///
/// A re-upload for the same `(post, attachment, role)` replaces the previous row
/// and deletes its file: the frontend uploads the original and the thumbnail
/// separately, and a retry must not leave both versions on disk.
///
/// `source_root` is `None` only for a host opened without one; the bytes then
/// stay under the library root so they are still readable there.
pub fn save_asset(
    connection: &Connection,
    library_root: &Path,
    source_root: Option<&Path>,
    post_id: &str,
    attachment_id: &str,
    role: &str,
    bytes: &[u8],
    mime: &str,
    name: &str,
) -> Result<StoredAsset> {
    let id = post_id.trim().to_string();
    let key = attachment_id.trim().to_string();
    if id.is_empty() || key.is_empty() {
        return Err(Error::bad_request("postId and attachmentId are required"));
    }
    let role = if role.is_empty() { "original" } else { role };
    let mime = if mime.is_empty() { DEFAULT_MIME } else { mime };
    let name = if name.is_empty() { key.clone() } else { name.to_string() };
    // The live-row check the old implementation did here. `post_folder_for` also
    // answers for a soft-deleted row so the migration can name it, so the write
    // path has to refuse that row itself.
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM creation_post WHERE post_id = ? AND deleted_at IS NULL",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(Error::not_found("creation post not found"));
    }
    let folder = post_folder_for(connection, &id)?;

    let previous: Option<(String, String)> = connection
        .query_row(
            "SELECT asset_id, rel_path FROM creation_asset WHERE post_id = ? AND attachment_id = ? AND role = ?",
            rusqlite::params![id, key, role],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((previous_id, previous_path)) = &previous {
        remove_asset_file(library_root, source_root, previous_path);
        connection.execute(
            "DELETE FROM creation_asset WHERE asset_id = ?",
            rusqlite::params![previous_id],
        )?;
    }

    // `folder` already carries the `creations/` type prefix, so the join is onto
    // the root that contains that prefix, not onto the creations directory.
    let asset_id = uuid::Uuid::new_v4().to_string();
    let file_name = asset_file_name(&asset_id, &name, mime);
    let base = source_root.unwrap_or(library_root);
    let relative_path = format!("{folder}/{file_name}");
    let root = creations_root(library_root, source_root);
    let target = base.join(&relative_path);
    if !paths::is_inside(&root, &target) || target == root {
        return Err(Error::path_denied("creation asset path escapes the library"));
    }
    std::fs::create_dir_all(target.parent().unwrap_or(&root))?;
    std::fs::write(&target, bytes)?;

    let sha256 = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex(&hasher.finalize())
    };
    connection.execute(
        "INSERT INTO creation_asset(asset_id, post_id, attachment_id, role, name, mime, bytes, sha256, rel_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            asset_id,
            id,
            key,
            role,
            name,
            mime,
            bytes.len() as i64,
            sha256,
            relative_path,
            now_iso()
        ],
    )?;
    connection.execute(
        "UPDATE creation_post SET updated_at = ? WHERE post_id = ?",
        rusqlite::params![now_iso(), id],
    )?;
    Ok(StoredAsset {
        asset_id,
        attachment_id: key,
        role: role.to_string(),
        name,
        mime: mime.to_string(),
        bytes: bytes.len(),
        sha256,
    })
}

/// Delete one row's file, refusing paths outside the creations tree.
///
/// The stored value is data, not a promise: a crafted `rel_path` used to be
/// joined onto the root and removed without a containment check.
fn remove_asset_file(library_root: &Path, source_root: Option<&Path>, rel_path: &str) {
    let root = creations_root(library_root, source_root);
    let Some(path) = resolve_stored_asset(library_root, source_root, rel_path) else { return };
    if !paths::is_inside(&root, &path) || path == root {
        return;
    }
    let _ = std::fs::remove_file(path);
}

/// Read an asset's bytes for `GET /api/creations/media/<id>`.
pub struct CreationAsset {
    pub asset_id: String,
    pub post_id: String,
    pub mime: String,
    pub bytes: u64,
    pub path: PathBuf,
}

pub fn read_asset(
    connection: &Connection,
    library_root: &Path,
    source_root: Option<&Path>,
    asset_id: &str,
) -> Result<Option<CreationAsset>> {
    let row: Option<(String, String, String, i64, String)> = connection
        .query_row(
            "SELECT asset_id, post_id, mime, bytes, rel_path FROM creation_asset WHERE asset_id = ?",
            rusqlite::params![asset_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((asset_id, post_id, mime, bytes, rel_path)) = row else {
        return Ok(None);
    };
    let root = creations_root(library_root, source_root);
    let Some(path) = resolve_stored_asset(library_root, source_root, &rel_path) else {
        return Ok(None);
    };
    if !paths::is_inside(&root, &path) || path == root {
        return Ok(None);
    }
    Ok(Some(CreationAsset { asset_id, post_id, mime, bytes: bytes as u64, path }))
}

/// Delete one asset row and its file; `false` when it never existed.
pub fn delete_asset(
    connection: &Connection,
    library_root: &Path,
    source_root: Option<&Path>,
    asset_id: &str,
) -> Result<bool> {
    let row: Option<String> = connection
        .query_row(
            "SELECT rel_path FROM creation_asset WHERE asset_id = ?",
            rusqlite::params![asset_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(rel_path) = row else { return Ok(false) };
    remove_asset_file(library_root, source_root, &rel_path);
    connection.execute("DELETE FROM creation_asset WHERE asset_id = ?", rusqlite::params![asset_id])?;
    Ok(true)
}

/// Delete a post, its assets and their files.
pub fn delete_post(
    connection: &Connection,
    library_root: &Path,
    source_root: Option<&Path>,
    post_id: &str,
) -> Result<bool> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM creation_post WHERE post_id = ? AND deleted_at IS NULL",
            rusqlite::params![post_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(false);
    }
    // Resolve the folder before the rows go away: afterwards `post_folder_for`
    // would fall back to the derived name, which may differ from the folder the
    // assets actually live in (a post whose title changed keeps its first name).
    let folder = post_folder_for(connection, post_id)?;
    let mut statement = connection.prepare("SELECT rel_path FROM creation_asset WHERE post_id = ?")?;
    let paths_list: Vec<String> = statement
        .query_map(rusqlite::params![post_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    connection.execute("DELETE FROM creation_asset WHERE post_id = ?", rusqlite::params![post_id])?;
    connection.execute("DELETE FROM creation_post WHERE post_id = ?", rusqlite::params![post_id])?;
    for rel_path in paths_list {
        remove_asset_file(library_root, source_root, &rel_path);
    }
    let root = creations_root(library_root, source_root);
    let base = source_root.unwrap_or(library_root);
    let target = base.join(&folder);
    if paths::is_inside(&root, &target) && target != root {
        // Remove the per-post directory; ignore the result because a concurrent
        // upload may have recreated it, and the row deletion is authoritative.
        let _ = std::fs::remove_dir_all(&target);
        prune_empty_parents(&root, &target);
    }
    // The pre-migration folder (`<root>/creations/<post key>`) may still hold
    // files on a library the startup migration has not run on yet. It lives under
    // the *library* root even when attachments are now written to the source
    // root, so both locations are checked.
    for base in [Some(library_root), source_root] {
        let Some(base) = base else { continue };
        let legacy = base.join(layout::LEGACY_CREATIONS).join(post_key(post_id));
        if legacy != target && paths::is_inside(&base.join(layout::LEGACY_CREATIONS), &legacy) {
            let _ = std::fs::remove_dir_all(&legacy);
        }
    }
    Ok(true)
}

/// Remove the now-empty `<platform>/<creator>/` folders above a deleted post.
///
/// Never climbs past the creations root and never removes a non-empty directory:
/// another post may share the creator. `remove_dir` is the atomic "only if
/// empty" check, so a concurrent upload cannot lose data to this loop.
fn prune_empty_parents(root: &Path, folder: &Path) {
    let mut current = folder.parent().map(Path::to_path_buf);
    while let Some(directory) = current {
        if directory == *root || !paths::is_inside(root, &directory) {
            break;
        }
        if std::fs::remove_dir(&directory).is_err() {
            break;
        }
        current = directory.parent().map(Path::to_path_buf);
    }
}

/// Percent-encode for a path segment, matching `encodeURIComponent` for the
/// characters that can appear in UUIDs and stable entry ids.
fn percent_encode(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn fixture() -> (Connection, PathBuf, PathBuf) {
        let connection = Connection::open_in_memory().unwrap();
        schema::enable_pragmas(&connection).unwrap();
        schema::apply_schema(&connection, "lib").unwrap();
        let base = std::env::temp_dir().join(format!("mono-creations-{}", uuid::Uuid::new_v4()));
        let library_root = base.join("library");
        let source_root = base.join("source");
        std::fs::create_dir_all(&library_root).unwrap();
        std::fs::create_dir_all(&source_root).unwrap();
        (connection, library_root, source_root)
    }

    fn post_json() -> Value {
        json!({
            "id": "p",
            "title": "A Post",
            "provider": "Patreon",
            "creator": "Some Creator",
            "date": "2026-02-10",
            "sourceUrl": "https://example.invalid/p/1"
        })
    }

    #[test]
    fn post_round_trips_unmodelled_fields() {
        let (connection, _library, _source) = fixture();
        let post = json!({
            "id": "post-1",
            "title": "A post",
            "sourceUrl": "https://example.invalid/p/1",
            "tags": ["a", "b"],
            "attachments": [{"id": "x", "kind": "image"}]
        });
        save_post(&connection, &post).unwrap();
        let posts = list_posts(&connection).unwrap();
        let first = &posts[0];
        assert_eq!(first["id"], "post-1");
        assert_eq!(first["tags"], json!(["a", "b"]));
        assert_eq!(first["attachments"][0]["kind"], "image");
        assert_eq!(first["hostAssets"], json!([]));
    }

    /// Rewritten acceptance: the bytes live in the *source* tree, in a folder a
    /// human can recognise, and `rel_path` is source-relative (no drive, no
    /// library-root prefix). The library root must stay free of attach content.
    #[test]
    fn assets_land_in_the_source_creations_tree() {
        let (connection, library_root, source_root) = fixture();
        save_post(&connection, &post_json()).unwrap();
        let asset = save_asset(
            &connection,
            &library_root,
            Some(&source_root),
            "p",
            "att-1",
            "original",
            b"hello",
            "image/png",
            "a.png",
        )
        .unwrap();

        let rel_path: String = connection
            .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = ?", [&asset.asset_id], |row| row.get(0))
            .unwrap();
        let expected_folder = "creations/Patreon/Some Creator/2026-02-10 A Post [p]";
        assert_eq!(rel_path, format!("{expected_folder}/{}.png", asset.asset_id));
        assert!(!rel_path.contains(':'), "source-relative, never absolute: {rel_path}");

        let stored = source_root.join(&rel_path);
        assert_eq!(std::fs::read(&stored).unwrap(), b"hello");
        assert!(!library_root.join("creations").exists(), "library root kept the old tree");

        let read = read_asset(&connection, &library_root, Some(&source_root), &asset.asset_id)
            .unwrap()
            .unwrap();
        assert_eq!(read.path, stored);
    }

    /// Two posts with the same title/creator/date still get distinct folders, and
    /// a hostile title/creator cannot climb out of the creations root.
    #[test]
    fn folder_is_confined_and_unique_per_post() {
        let (connection, library_root, source_root) = fixture();
        save_post(
            &connection,
            &json!({
                "id": "post/../escape",
                "title": "../../evil",
                "provider": "..",
                "creator": "../x",
                "date": "2026-02-10"
            }),
        )
        .unwrap();
        save_post(&connection, &post_json()).unwrap();
        let hostile = save_asset(&connection, &library_root, Some(&source_root), "post/../escape", "a", "original", b"x", "text/plain", "x.txt").unwrap();
        let clean = save_asset(&connection, &library_root, Some(&source_root), "p", "a", "original", b"y", "text/plain", "y.txt").unwrap();
        for asset_id in [hostile.asset_id, clean.asset_id] {
            let rel_path: String = connection
                .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = ?", [&asset_id], |row| row.get(0))
                .unwrap();
            assert!(!rel_path.split('/').any(|part| part == ".."), "{rel_path}");
            let path = source_root.join(&rel_path);
            assert!(paths::is_inside(&creations_root(&library_root, Some(&source_root)), &path));
            assert!(path.is_file(), "{rel_path}");
        }
        // The id suffix is what separates the two posts; neither folder was
        // flattened into an escape.
        let mut folders = std::collections::BTreeSet::new();
        let mut statement = connection.prepare("SELECT rel_path FROM creation_asset").unwrap();
        let rows: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for rel_path in rows {
            folders.insert(rel_path.rsplit_once('/').unwrap().0.to_string());
        }
        assert_eq!(folders.len(), 2, "{folders:?}");
    }

    /// A re-import that edits the title must not move the folder: the first row
    /// wins, so the files stay findable behind the URL the UI already handed out.
    #[test]
    fn folder_is_stable_when_the_post_is_edited() {
        let (connection, library_root, source_root) = fixture();
        save_post(&connection, &post_json()).unwrap();
        let first = save_asset(&connection, &library_root, Some(&source_root), "p", "a", "original", b"1", "text/plain", "a.txt").unwrap();

        let mut edited = post_json();
        edited["title"] = json!("A Better Title");
        save_post(&connection, &edited).unwrap();
        let second = save_asset(&connection, &library_root, Some(&source_root), "p", "b", "original", b"2", "text/plain", "b.txt").unwrap();

        for asset_id in [first.asset_id, second.asset_id] {
            let rel_path: String = connection
                .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = ?", [&asset_id], |row| row.get(0))
                .unwrap();
            assert!(rel_path.starts_with("creations/Patreon/Some Creator/2026-02-10 A Post [p]/"), "{rel_path}");
        }
    }

    #[test]
    fn asset_write_read_replace_and_delete() {
        let (connection, library_root, source_root) = fixture();
        save_post(&connection, &json!({"id": "p"})).unwrap();
        let first = save_asset(&connection, &library_root, Some(&source_root), "p", "att-1", "original", b"hello", "text/plain", "a.txt").unwrap();
        assert_eq!(first.bytes, 5);
        let read = read_asset(&connection, &library_root, Some(&source_root), &first.asset_id).unwrap().unwrap();
        assert_eq!(std::fs::read(&read.path).unwrap(), b"hello");
        assert_eq!(read.mime, "text/plain");

        // Re-upload for the same slot replaces the row and removes the old file.
        let second = save_asset(&connection, &library_root, Some(&source_root), "p", "att-1", "original", b"world!", "text/plain", "a.txt").unwrap();
        assert_ne!(first.asset_id, second.asset_id);
        assert!(read_asset(&connection, &library_root, Some(&source_root), &first.asset_id).unwrap().is_none());
        assert!(read.path.exists() == false);

        assert!(delete_asset(&connection, &library_root, Some(&source_root), &second.asset_id).unwrap());
        assert!(!delete_asset(&connection, &library_root, Some(&source_root), &second.asset_id).unwrap());
    }

    #[test]
    fn asset_requires_existing_post() {
        let (connection, library_root, source_root) = fixture();
        let error = save_asset(&connection, &library_root, Some(&source_root), "missing", "a", "original", b"x", "text/plain", "a").unwrap_err();
        assert_eq!(error.code, Some("ENOTFOUND"));
    }

    #[test]
    fn delete_post_removes_files_and_empty_folders() {
        let (connection, library_root, source_root) = fixture();
        save_post(&connection, &post_json()).unwrap();
        let asset = save_asset(&connection, &library_root, Some(&source_root), "p", "a", "original", b"x", "text/plain", "a").unwrap();
        let read = read_asset(&connection, &library_root, Some(&source_root), &asset.asset_id).unwrap().unwrap();
        let folder = read.path.parent().unwrap().to_path_buf();
        assert!(folder.is_dir());

        assert!(delete_post(&connection, &library_root, Some(&source_root), "p").unwrap());
        assert!(!folder.exists(), "post folder removed");
        assert!(
            !creations_root(&library_root, Some(&source_root)).join("Patreon").exists(),
            "emptied creator folders are pruned"
        );
        assert!(list_posts(&connection).unwrap().as_array().unwrap().is_empty());
        assert!(!delete_post(&connection, &library_root, Some(&source_root), "p").unwrap());
    }

    /// A host without a source root still stores the bytes somewhere readable —
    /// under the library root — and reads them back from there.
    #[test]
    fn a_host_without_a_source_root_still_works() {
        let (connection, library_root, _source) = fixture();
        save_post(&connection, &post_json()).unwrap();
        let asset = save_asset(&connection, &library_root, None, "p", "a", "original", b"x", "text/plain", "a.txt").unwrap();
        let read = read_asset(&connection, &library_root, None, &asset.asset_id).unwrap().unwrap();
        assert_eq!(std::fs::read(&read.path).unwrap(), b"x");
        assert!(read.path.starts_with(library_root.join("creations")), "{}", read.path.display());
    }

    /// Extension choice: the attachment name is the user's word for the file, so
    /// it wins; the MIME type is the fallback. A UUID stem keeps original and
    /// thumbnail apart even though both carry the same display name.
    #[test]
    fn file_name_is_readable_but_unique() {
        assert_eq!(asset_file_name("id", "photo.JPG", "application/octet-stream"), "id.jpg");
        assert_eq!(asset_file_name("id", "no-extension", "image/png"), "id.png");
        assert_eq!(asset_file_name("id", "EVIL.EXE", "text/plain"), "id.exe");
        assert_eq!(asset_file_name("id", "archive.7z", "application/octet-stream"), "id.7z");
        assert_eq!(asset_file_name("id", "x", "application/octet-stream"), "id");
        // A too-long or non-alphanumeric extension is not a file name, it is a
        // path trick; fall through to the MIME decision instead.
        assert_eq!(asset_file_name("id", "x.toolongextension", "image/gif"), "id.gif");
    }

    #[test]
    fn media_path_is_percent_encoded() {
        let asset = StoredAsset {
            asset_id: "a b/c".into(),
            attachment_id: "x".into(),
            role: "original".into(),
            name: "n".into(),
            mime: "text/plain".into(),
            bytes: 0,
            sha256: String::new(),
        };
        assert_eq!(asset.to_json()["mediaPath"], "/api/creations/media/a%20b%2Fc");
    }
}
