//! Creation posts and their binary assets (`creations.mjs`).
//!
//! Creation posts live in their own tables and their own `data/creations/<hash>/`
//! tree, deliberately separate from the voice work model: a Pawchive/Patreon post
//! has no RJ code, no manifest and no rendition, so forcing it into `work`/`entry`
//! would make every voice query carry creation-shaped rows.
//!
//! Asset files are content-addressed by asset UUID (not by hash) because the same
//! attachment may be re-uploaded with a new role; the hash column is still
//! recorded so a future dedupe can find identical bytes.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::hash::{hex, sha256_text};
use crate::jsonutil::{now_iso, parse_object};
use crate::paths;

fn text_value(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => fallback.to_string(),
    }
}

/// Stable on-disk directory name for a post: sha256 of its id.
fn post_key(post_id: &str) -> String {
    sha256_text(post_id)
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
pub fn save_asset(
    connection: &Connection,
    library_root: &Path,
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
    let role = if role.is_empty() { "original" } else { role };
    let mime = if mime.is_empty() { DEFAULT_MIME } else { mime };
    let name = if name.is_empty() { key.clone() } else { name.to_string() };

    let previous: Option<(String, String)> = connection
        .query_row(
            "SELECT asset_id, rel_path FROM creation_asset WHERE post_id = ? AND attachment_id = ? AND role = ?",
            rusqlite::params![id, key, role],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((previous_id, previous_path)) = &previous {
        let target = PathBuf::from(crate::paths::normalize_slashes(previous_path));
        let resolved = if target.is_absolute() {
            target
        } else {
            library_root.join(target)
        };
        let _ = std::fs::remove_file(resolved);
        connection.execute(
            "DELETE FROM creation_asset WHERE asset_id = ?",
            rusqlite::params![previous_id],
        )?;
    }

    let asset_id = uuid::Uuid::new_v4().to_string();
    // Stored with forward slashes so a library created on Windows reads back the
    // same relative path on another platform.
    let relative_path = format!("data/creations/{}/{}", post_key(&id), asset_id);
    let target = library_root.join("data").join("creations").join(post_key(&id)).join(&asset_id);
    let data_root = library_root.join("data");
    if !paths::is_inside(&data_root, &target) {
        return Err(Error::path_denied("creation asset path escapes the library"));
    }
    std::fs::create_dir_all(target.parent().unwrap_or(&data_root))?;
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

/// Read an asset's bytes for `GET /api/creations/media/<id>`.
pub struct CreationAsset {
    pub asset_id: String,
    pub post_id: String,
    pub mime: String,
    pub bytes: u64,
    pub path: PathBuf,
}

pub fn read_asset(connection: &Connection, library_root: &Path, asset_id: &str) -> Result<Option<CreationAsset>> {
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
    let normalized = crate::paths::normalize_slashes(&rel_path);
    let parsed = PathBuf::from(&normalized);
    let path = if parsed.is_absolute() { parsed } else { library_root.join(parsed) };
    let data_root = library_root.join("data");
    if !paths::is_inside(&data_root, &path) {
        return Ok(None);
    }
    Ok(Some(CreationAsset { asset_id, post_id, mime, bytes: bytes as u64, path }))
}

/// Delete one asset row and its file; `false` when it never existed.
pub fn delete_asset(connection: &Connection, library_root: &Path, asset_id: &str) -> Result<bool> {
    let row: Option<String> = connection
        .query_row(
            "SELECT rel_path FROM creation_asset WHERE asset_id = ?",
            rusqlite::params![asset_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(rel_path) = row else { return Ok(false) };
    let normalized = crate::paths::normalize_slashes(&rel_path);
    let parsed = PathBuf::from(&normalized);
    let path = if parsed.is_absolute() { parsed } else { library_root.join(parsed) };
    let _ = std::fs::remove_file(path);
    connection.execute("DELETE FROM creation_asset WHERE asset_id = ?", rusqlite::params![asset_id])?;
    Ok(true)
}

/// Delete a post, its assets and their files.
pub fn delete_post(connection: &Connection, library_root: &Path, post_id: &str) -> Result<bool> {
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
    let mut statement = connection.prepare("SELECT rel_path FROM creation_asset WHERE post_id = ?")?;
    let paths_list: Vec<String> = statement
        .query_map(rusqlite::params![post_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    connection.execute("DELETE FROM creation_asset WHERE post_id = ?", rusqlite::params![post_id])?;
    connection.execute("DELETE FROM creation_post WHERE post_id = ?", rusqlite::params![post_id])?;
    for rel_path in paths_list {
        let normalized = crate::paths::normalize_slashes(&rel_path);
        let parsed = PathBuf::from(&normalized);
        let path = if parsed.is_absolute() { parsed } else { library_root.join(parsed) };
        let _ = std::fs::remove_file(path);
    }
    // Remove the per-post directory; ignore the result because a concurrent
    // upload may have recreated it, and the row deletion is the authoritative step.
    let _ = std::fs::remove_dir_all(library_root.join("data").join("creations").join(post_key(post_id)));
    Ok(true)
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

    fn fixture() -> (Connection, PathBuf) {
        let connection = Connection::open_in_memory().unwrap();
        schema::enable_pragmas(&connection).unwrap();
        schema::apply_schema(&connection, "lib").unwrap();
        let root = std::env::temp_dir().join(format!("mono-creations-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("data")).unwrap();
        (connection, root)
    }

    #[test]
    fn post_round_trips_unmodelled_fields() {
        let (connection, _root) = fixture();
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

    #[test]
    fn asset_write_read_replace_and_delete() {
        let (connection, root) = fixture();
        save_post(&connection, &json!({"id": "p"})).unwrap();
        let first = save_asset(&connection, &root, "p", "att-1", "original", b"hello", "text/plain", "a.txt").unwrap();
        assert_eq!(first.bytes, 5);
        let read = read_asset(&connection, &root, &first.asset_id).unwrap().unwrap();
        assert_eq!(std::fs::read(&read.path).unwrap(), b"hello");
        assert_eq!(read.mime, "text/plain");

        // Re-upload for the same slot replaces the row and removes the old file.
        let second = save_asset(&connection, &root, "p", "att-1", "original", b"world!", "text/plain", "a.txt").unwrap();
        assert_ne!(first.asset_id, second.asset_id);
        assert!(read_asset(&connection, &root, &first.asset_id).unwrap().is_none());
        assert!(read.path.exists() == false);

        assert!(delete_asset(&connection, &root, &second.asset_id).unwrap());
        assert!(!delete_asset(&connection, &root, &second.asset_id).unwrap());
    }

    #[test]
    fn asset_requires_existing_post() {
        let (connection, root) = fixture();
        let error = save_asset(&connection, &root, "missing", "a", "original", b"x", "text/plain", "a").unwrap_err();
        assert_eq!(error.code, Some("ENOTFOUND"));
    }

    #[test]
    fn delete_post_removes_files_and_rows() {
        let (connection, root) = fixture();
        save_post(&connection, &json!({"id": "p"})).unwrap();
        let asset = save_asset(&connection, &root, "p", "a", "original", b"x", "text/plain", "a").unwrap();
        assert!(delete_post(&connection, &root, "p").unwrap());
        assert!(read_asset(&connection, &root, &asset.asset_id).unwrap().is_none());
        assert!(list_posts(&connection).unwrap().as_array().unwrap().is_empty());
        assert!(!delete_post(&connection, &root, "p").unwrap());
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
