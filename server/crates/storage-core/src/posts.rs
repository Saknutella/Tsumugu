//! Creation posts and videos (schema v8).
//!
//! One row per post, with `category` splitting creations from videos. The audio
//! work tables stay untouched: a post has no RJ code, no manifest and no
//! rendition, and a video is not a work either. Keeping them apart is what makes
//! `/api/works` and `/api/creations` unable to leak into each other.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::hash::sha256_text;
use crate::jsonutil::{now_iso, parse_object};

fn text(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => fallback.to_string(),
    }
}

/// Insert or update one post, keyed by `(category, provider, source_id)`.
///
/// Re-importing the same post (a re-run of the same URL import) must update the
/// row in place: creating a second row would split the post's files across two
/// folders and make the readable tree lie.
///
/// The creator, post and tag statements run inside one savepoint: a failure
/// half-way (a tag insert hitting a constraint, a full disk) used to leave a
/// creator row with no post, or a post with no tags, which the next import then
/// "updated" as if it were complete. A savepoint rather than `BEGIN IMMEDIATE`
/// because a caller may already be inside a transaction.
pub fn upsert_post(
    connection: &Connection,
    input: &Value,
    body_sha256: &str,
    timestamp: &str,
) -> Result<Value> {
    let category = text(input.get("category"), "");
    if category != "creation" && category != "video" {
        return Err(Error::bad_request("category must be creation or video"));
    }
    let provider = text(input.get("provider"), "").trim().to_string();
    let source_id = text(input.get("sourceId"), "").trim().to_string();
    if provider.is_empty() || source_id.is_empty() {
        return Err(Error::bad_request("provider and sourceId are required"));
    }
    in_savepoint(connection, "upsert_post", || {
        upsert_post_rows(connection, input, &category, &provider, &source_id, body_sha256, timestamp)
    })
}

/// Run `f` inside `SAVEPOINT name`, rolling back to it on error.
fn in_savepoint<T>(connection: &Connection, name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    connection.execute_batch(&format!("SAVEPOINT {name}"))?;
    match f() {
        Ok(value) => {
            connection.execute_batch(&format!("RELEASE {name}"))?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
            Err(error)
        }
    }
}

fn upsert_post_rows(
    connection: &Connection,
    input: &Value,
    category: &str,
    provider: &str,
    source_id: &str,
    body_sha256: &str,
    timestamp: &str,
) -> Result<Value> {
    let creator_id = match input.get("creator").filter(|value| value.is_object()) {
        Some(creator) => Some(upsert_creator(connection, provider, creator, timestamp)?),
        None => None,
    };
    let meta = input.get("meta").cloned().unwrap_or_else(|| json!({}));
    // Deliberately not filtered on `deleted_at IS NULL`: `ON CONFLICT` below
    // resurrects a soft-deleted row rather than adding a second one, so the
    // surviving row's id is what the caller must get back. Callers (import, HTTP
    // routes, file tasks) key every later folder/file operation off `postId`, and
    // a freshly minted UUID would address a row that does not exist.
    let existing: Option<(String, i64)> = connection
        .query_row(
            "SELECT post_id, revision FROM post
             WHERE category = ? AND provider = ? AND source_id = ?",
            rusqlite::params![category, provider, source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (post_id, revision, created) = match existing {
        Some((post_id, revision)) => (post_id, revision + 1, false),
        None => (uuid::Uuid::new_v4().to_string(), 1i64, true),
    };
    // `root_path` keeps the stored value when the caller sends none: an empty
    // folder means "unchanged" for a host-less caller, and overwriting a real
    // folder with '' would point every later file and delete operation at the
    // source root itself.
    connection.execute(
        "INSERT INTO post(post_id, category, provider, source_id, title, published_at, source_url,
            creator_id, root_path, body_sha256, meta_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(category, provider, source_id) DO UPDATE SET
            title = excluded.title,
            published_at = excluded.published_at,
            source_url = excluded.source_url,
            creator_id = excluded.creator_id,
            root_path = CASE WHEN excluded.root_path = '' THEN post.root_path ELSE excluded.root_path END,
            body_sha256 = excluded.body_sha256,
            meta_json = excluded.meta_json,
            revision = post.revision + 1,
            deleted_at = NULL,
            updated_at = excluded.updated_at",
        rusqlite::params![
            post_id,
            category,
            provider,
            source_id,
            text(input.get("title"), ""),
            input.get("publishedAt").and_then(Value::as_str),
            text(input.get("sourceUrl"), ""),
            creator_id,
            text(input.get("rootPath"), ""),
            body_sha256,
            serde_json::to_string(&meta).unwrap_or_else(|_| "{}".to_string()),
            revision,
            timestamp,
            timestamp
        ],
    )?;
    connection.execute("DELETE FROM post_tag WHERE post_id = ?", rusqlite::params![post_id])?;
    if let Some(tags) = input.get("tags").and_then(Value::as_array) {
        for tag in tags.iter().filter_map(Value::as_str) {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            connection.execute(
                "INSERT OR IGNORE INTO post_tag(post_id, tag) VALUES (?, ?)",
                rusqlite::params![post_id, tag],
            )?;
        }
    }
    Ok(json!({ "postId": post_id, "revision": revision, "created": created }))
}

/// Stored `root_path` of the post with this identity, soft-deleted rows included.
///
/// Import needs it before touching disk: a re-import (or the revival of a
/// deleted post) must reuse the folder the files already live in, because a
/// renamed title or creator would otherwise compute a new folder and leave
/// every attached file behind a 404.
pub fn stored_root_path(
    connection: &Connection,
    category: &str,
    provider: &str,
    source_id: &str,
) -> Result<Option<String>> {
    let found = connection
        .query_row(
            "SELECT root_path FROM post WHERE category = ? AND provider = ? AND source_id = ?",
            rusqlite::params![category, provider, source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(found)
}

/// Creator/channel row shared by every post from the same source account.
pub fn upsert_creator(
    connection: &Connection,
    provider: &str,
    creator: &Value,
    timestamp: &str,
) -> Result<String> {
    let source_id = text(creator.get("sourceId"), "").trim().to_string();
    if source_id.is_empty() {
        return Err(Error::bad_request("creator.sourceId is required"));
    }
    let existing: Option<String> = connection
        .query_row(
            "SELECT creator_id FROM creator WHERE provider = ? AND source_id = ?",
            rusqlite::params![provider, source_id],
            |row| row.get(0),
        )
        .optional()?;
    let creator_id = existing.unwrap_or_else(|| sha256_text(&format!("{provider}:{source_id}")));
    connection.execute(
        "INSERT INTO creator(creator_id, provider, source_id, name, url, avatar_sha256,
            avatar_rel_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, source_id) DO UPDATE SET
            name = excluded.name,
            url = excluded.url,
            avatar_sha256 = CASE WHEN excluded.avatar_sha256 = '' THEN creator.avatar_sha256 ELSE excluded.avatar_sha256 END,
            avatar_rel_path = CASE WHEN excluded.avatar_rel_path = '' THEN creator.avatar_rel_path ELSE excluded.avatar_rel_path END,
            updated_at = excluded.updated_at",
        rusqlite::params![
            creator_id,
            provider,
            source_id,
            text(creator.get("name"), ""),
            text(creator.get("url"), ""),
            text(creator.get("avatarSha256"), ""),
            text(creator.get("avatarRelPath"), ""),
            timestamp,
            timestamp
        ],
    )?;
    Ok(creator_id)
}

fn row_to_post(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let meta_json: String = row.get("meta_json")?;
    let meta = parse_object(Some(&meta_json));
    Ok(json!({
        "postId": row.get::<_, String>("post_id")?,
        "category": row.get::<_, String>("category")?,
        "provider": row.get::<_, String>("provider")?,
        "sourceId": row.get::<_, String>("source_id")?,
        "title": row.get::<_, String>("title")?,
        "publishedAt": row.get::<_, Option<String>>("published_at")?,
        "sourceUrl": row.get::<_, String>("source_url")?,
        "creatorId": row.get::<_, Option<String>>("creator_id")?,
        "rootPath": row.get::<_, String>("root_path")?,
        "bodySha256": row.get::<_, String>("body_sha256")?,
        "meta": Value::Object(meta),
        "revision": row.get::<_, i64>("revision")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

const POST_COLUMNS: &str = "post_id, category, provider, source_id, title, published_at,
    source_url, creator_id, root_path, body_sha256, meta_json, revision, updated_at";

/// One live post with its tags and files.
pub fn get_post(connection: &Connection, post_id: &str) -> Result<Option<Value>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {POST_COLUMNS} FROM post WHERE post_id = ? AND deleted_at IS NULL"
    ))?;
    let found = statement
        .query_row(rusqlite::params![post_id], row_to_post)
        .optional()?;
    match found {
        Some(mut post) => {
            post["tags"] = json!(tags_of(connection, post_id)?);
            post["files"] = json!(files_of(connection, post_id)?);
            Ok(Some(post))
        }
        None => Ok(None),
    }
}

/// Posts of one category, newest first.
pub fn list_posts_by_category(connection: &Connection, category: &str) -> Result<Value> {
    let mut statement = connection.prepare(&format!(
        "SELECT {POST_COLUMNS} FROM post
         WHERE category = ? AND deleted_at IS NULL
         ORDER BY COALESCE(published_at, created_at) DESC, post_id"
    ))?;
    let rows: Vec<Value> = statement
        .query_map(rusqlite::params![category], row_to_post)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut posts = Vec::with_capacity(rows.len());
    for mut post in rows {
        let post_id = post["postId"].as_str().unwrap_or("").to_string();
        post["tags"] = json!(tags_of(connection, &post_id)?);
        post["files"] = json!(files_of(connection, &post_id)?);
        posts.push(post);
    }
    Ok(Value::Array(posts))
}

pub fn tags_of(connection: &Connection, post_id: &str) -> Result<Vec<String>> {
    let mut statement = connection.prepare("SELECT tag FROM post_tag WHERE post_id = ? ORDER BY tag")?;
    let tags = statement
        .query_map(rusqlite::params![post_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

pub fn files_of(connection: &Connection, post_id: &str) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT role, rel_path, sha256, bytes, mime, remote_url, status, file_id
         FROM post_file WHERE post_id = ? ORDER BY role, rel_path",
    )?;
    let files = statement
        .query_map(rusqlite::params![post_id], |row| {
            Ok(json!({
                "role": row.get::<_, String>(0)?,
                "relPath": row.get::<_, String>(1)?,
                "sha256": row.get::<_, String>(2)?,
                "bytes": row.get::<_, i64>(3)?,
                "mime": row.get::<_, String>(4)?,
                "remoteUrl": row.get::<_, String>(5)?,
                "status": row.get::<_, String>(6)?,
                "fileId": row.get::<_, String>(7)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(files)
}

/// Opaque media id of one post file.
///
/// Derived from `(post_id, rel_path)` rather than random so re-recording the same
/// file keeps its URL, and hex so it is a single path segment: `/media/<id>` and
/// `sign_media_path` deliberately refuse ids containing `/`, and a post file has
/// to fit that rule instead of widening it.
fn file_id_of(post_id: &str, rel_path: &str) -> String {
    sha256_text(&format!("{post_id}:{rel_path}"))
}

/// Record a file row. Same `(post_id, rel_path)` is replaced rather than stacked.
pub fn upsert_file(connection: &Connection, post_id: &str, file: &Value, timestamp: &str) -> Result<()> {
    insert_file(connection, post_id, file, timestamp).map(|_| ())
}

/// Insert/update a file row and return its opaque id (media URLs address it).
///
/// The conflict update leaves `file_id` alone, so a URL handed out earlier keeps
/// pointing at the same row after the file is re-attached or re-downloaded.
pub fn insert_file(connection: &Connection, post_id: &str, file: &Value, timestamp: &str) -> Result<String> {
    let rel_path = text(file.get("relPath"), "");
    let file_id = file_id_of(post_id, &rel_path);
    connection.execute(
        "INSERT INTO post_file(file_id, post_id, role, rel_path, sha256, bytes, mime, remote_url, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id, rel_path) DO UPDATE SET
            role = excluded.role,
            sha256 = excluded.sha256,
            bytes = excluded.bytes,
            mime = excluded.mime,
            remote_url = excluded.remote_url,
            status = excluded.status",
        rusqlite::params![
            file_id,
            post_id,
            text(file.get("role"), "attachment"),
            rel_path,
            text(file.get("sha256"), ""),
            file.get("bytes").and_then(Value::as_i64).unwrap_or(0),
            text(file.get("mime"), "application/octet-stream"),
            text(file.get("remoteUrl"), ""),
            text(file.get("status"), "local"),
            timestamp
        ],
    )?;
    Ok(file_id)
}

/// `(category, root_path, rel_path, mime, sha256)` for a live post's file.
///
/// Joins `post` on `deleted_at IS NULL`: a soft-deleted post keeps its file rows
/// (and possibly its bytes) until cleanup, and an old signed URL must not keep
/// serving them in the meantime. `category` is returned so the media layer can
/// validate `root_path` against the category root the same way every write does.
pub fn find_file_by_id(
    connection: &Connection,
    file_id: &str,
) -> Result<Option<(String, String, String, String, String)>> {
    let found = connection
        .query_row(
            "SELECT p.category, p.root_path, f.rel_path, f.mime, f.sha256
             FROM post_file f JOIN post p ON p.post_id = f.post_id
             WHERE f.file_id = ? AND p.deleted_at IS NULL",
            rusqlite::params![file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    Ok(found)
}

/// Find a file row by relative path inside the post folder.
pub fn find_file(connection: &Connection, post_id: &str, rel_path: &str) -> Result<Option<Value>> {
    let files = files_of(connection, post_id)?;
    Ok(files
        .into_iter()
        .find(|file| file["relPath"].as_str() == Some(rel_path)))
}

/// Soft-delete one post (files handled by the host layer).
pub fn soft_delete_post(connection: &Connection, post_id: &str, timestamp: &str) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE post SET deleted_at = ?, updated_at = ? WHERE post_id = ? AND deleted_at IS NULL",
        rusqlite::params![timestamp, timestamp, post_id],
    )?;
    Ok(changed > 0)
}

/// Drop one file row (the bytes are the host layer's job).
pub fn delete_file_row(connection: &Connection, post_id: &str, rel_path: &str) -> Result<bool> {
    let changed = connection.execute(
        "DELETE FROM post_file WHERE post_id = ? AND rel_path = ?",
        rusqlite::params![post_id, rel_path],
    )?;
    Ok(changed > 0)
}

/// Mark a file as no longer on disk, keeping the row so the UI can say "未下载".
pub fn mark_file_missing(connection: &Connection, post_id: &str, rel_path: &str) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE post_file SET status = CASE WHEN remote_url <> '' THEN 'remote' ELSE 'missing' END
         WHERE post_id = ? AND rel_path = ?",
        rusqlite::params![post_id, rel_path],
    )?;
    Ok(changed > 0)
}

/// Mark every local file of a post as no longer on disk (whole-post delete).
///
/// The rows outlive the folder because a soft-deleted post can be revived by a
/// re-import; leaving them `local` made the revived post advertise files whose
/// bytes went with the folder.
pub fn mark_post_files_missing(connection: &Connection, post_id: &str) -> Result<usize> {
    let changed = connection.execute(
        "UPDATE post_file SET status = CASE WHEN remote_url <> '' THEN 'remote' ELSE 'missing' END
         WHERE post_id = ? AND status = 'local'",
        rusqlite::params![post_id],
    )?;
    Ok(changed)
}

/// Soft-delete a post and mark its files missing as one unit.
///
/// Together so a failure between the two cannot leave a deleted post whose files
/// still claim to be local.
pub fn soft_delete_post_and_files(connection: &Connection, post_id: &str, timestamp: &str) -> Result<bool> {
    in_savepoint(connection, "soft_delete_post", || {
        mark_post_files_missing(connection, post_id)?;
        soft_delete_post(connection, post_id, timestamp)
    })
}

/// Convenience for callers that only have "now".
pub fn touch_now() -> String {
    now_iso()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;
    use rusqlite::Connection;

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        schema::enable_pragmas(&connection).unwrap();
        schema::apply_schema(&connection, "lib").unwrap();
        connection
    }

    fn input(category: &str, source: &str) -> Value {
        serde_json::json!({
            "category": category,
            "provider": "youtube",
            "sourceId": source,
            "title": "A video",
            "sourceUrl": "https://example.invalid/v/1",
            "rootPath": "Videos/YouTube/chan/2026-01-01 A video [abc]",
            "bodyHtml": "<p>hello</p>",
            "tags": ["a", "b"],
            "meta": { "views": 12 },
            "creator": { "sourceId": "chan", "name": "Chan", "url": "" }
        })
    }

    #[test]
    fn upsert_post_creates_then_updates_revision() {
        let connection = fixture();
        let first = upsert_post(&connection, &input("video", "abc"), "sha1", "now").unwrap();
        assert_eq!(first["created"], true);
        let second = upsert_post(&connection, &input("video", "abc"), "sha2", "later").unwrap();
        assert_eq!(second["created"], false);
        assert_eq!(second["revision"], 2);
        let post = get_post(&connection, second["postId"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(post["bodySha256"], "sha2");
        assert_eq!(post["tags"], serde_json::json!(["a", "b"]));
        assert_eq!(post["meta"]["views"], 12);
    }

    #[test]
    fn list_posts_filters_by_category() {
        let connection = fixture();
        upsert_post(&connection, &input("video", "v1"), "s", "now").unwrap();
        upsert_post(&connection, &input("creation", "c1"), "s", "now").unwrap();
        let videos = list_posts_by_category(&connection, "video").unwrap();
        let creations = list_posts_by_category(&connection, "creation").unwrap();
        assert_eq!(videos.as_array().unwrap().len(), 1);
        assert_eq!(creations.as_array().unwrap().len(), 1);
        assert_eq!(videos[0]["category"], "video");
    }

    #[test]
    fn soft_deleted_post_is_revived_under_its_own_id() {
        let connection = fixture();
        let first = upsert_post(&connection, &input("video", "abc"), "s", "now").unwrap();
        let original_id = first["postId"].as_str().unwrap().to_string();
        assert!(soft_delete_post(&connection, &original_id, "later").unwrap());
        assert!(get_post(&connection, &original_id).unwrap().is_none());

        // `ON CONFLICT` revives the tombstoned row instead of inserting a second
        // one, so the id handed back has to be the surviving row's id: the caller
        // stores it and every later file/folder call addresses that row.
        let again = upsert_post(&connection, &input("video", "abc"), "s", "later").unwrap();
        assert_eq!(again["postId"].as_str().unwrap(), original_id);
        assert_eq!(again["created"], false);
        assert_eq!(again["revision"], 2);
        let revived = get_post(&connection, &original_id).unwrap().unwrap();
        assert_eq!(revived["revision"], 2);
        // Exactly one row: no split between a tombstone and a new post.
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn reimport_without_root_path_keeps_the_stored_folder() {
        // A caller that sends no `rootPath` must not blank the stored folder:
        // an empty `root_path` resolves to the source root in every later file
        // or delete operation.
        let connection = fixture();
        let first = upsert_post(&connection, &input("video", "abc"), "s", "now").unwrap();
        let mut again = input("video", "abc");
        again.as_object_mut().unwrap().remove("rootPath");
        upsert_post(&connection, &again, "s", "later").unwrap();
        let post = get_post(&connection, first["postId"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(post["rootPath"], "Videos/YouTube/chan/2026-01-01 A video [abc]");
        assert_eq!(
            stored_root_path(&connection, "video", "youtube", "abc").unwrap().as_deref(),
            Some("Videos/YouTube/chan/2026-01-01 A video [abc]")
        );
    }

    #[test]
    fn failed_upsert_rolls_back_creator_and_post() {
        // The creator row is written before the post; a failure after it must
        // not leave the creator (or a half-written post) behind.
        let connection = fixture();
        connection
            .execute_batch("CREATE TRIGGER fail_tag BEFORE INSERT ON post_tag BEGIN SELECT RAISE(ABORT, 'boom'); END;")
            .unwrap();
        assert!(upsert_post(&connection, &input("video", "abc"), "s", "now").is_err());
        let posts: i64 = connection.query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0)).unwrap();
        let creators: i64 = connection.query_row("SELECT COUNT(*) FROM creator", [], |row| row.get(0)).unwrap();
        assert_eq!((posts, creators), (0, 0));
        assert!(connection.is_autocommit(), "the savepoint is released after the rollback");
    }

    #[test]
    fn soft_delete_marks_files_missing_or_remote() {
        let connection = fixture();
        let saved = upsert_post(&connection, &input("video", "abc"), "s", "now").unwrap();
        let post_id = saved["postId"].as_str().unwrap().to_string();
        upsert_file(&connection, &post_id, &json!({ "role": "video", "relPath": "v.mp4" }), "now").unwrap();
        upsert_file(
            &connection,
            &post_id,
            &json!({ "role": "thumbnail", "relPath": "t.jpg", "remoteUrl": "https://example.invalid/t.jpg" }),
            "now",
        )
        .unwrap();
        assert!(soft_delete_post_and_files(&connection, &post_id, "later").unwrap());
        upsert_post(&connection, &input("video", "abc"), "s", "again").unwrap();
        let revived = get_post(&connection, &post_id).unwrap().unwrap();
        let status = |rel: &str| {
            revived["files"].as_array().unwrap().iter().find(|file| file["relPath"] == rel).unwrap()["status"].clone()
        };
        assert_eq!(status("v.mp4"), "missing");
        assert_eq!(status("t.jpg"), "remote");
    }
}
