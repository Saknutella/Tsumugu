//! Readable post folders and their `.monochrome/` sidecar.
//!
//! The folder is the truth and the database is an index: a user can copy a post
//! folder to another machine and still see the same title, body and files. Every
//! write therefore updates the sidecar in the same operation as the row.
//!
//! The naming helpers and the sidecar stay pure (a naming decision plus two small
//! files) so they can be tested and repaired without a library open; only the
//! `Host` methods in this module touch SQLite, and they do so through
//! `storage_core::posts`.
//!
//! Every folder a request can address goes through one gate. A post folder is
//! always `<source>/<Category>/<Provider>/<Creator>/<Folder>`; anything that is
//! not exactly that shape is refused before a byte is read, written or deleted.
//! The reason is not tidiness: `delete_post` calls `remove_dir_all`, so a stored
//! `root_path` of `''` or `'.'` — shapes the trusted-looking database can hold —
//! used to mean "the whole source root".

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use storage_core::error::{Error, Result};
use storage_core::naming::{category_root, segment, CATEGORY_CREATION, CATEGORY_VIDEO};
// The naming rule has one implementation (storage-core) because creations now
// share the same `<type>/<provider>/<creator>/<date title [id]>` tree and must
// not drift from videos; the re-exports keep this module's public surface.
pub use storage_core::naming::{post_folder, validated_post_root};
use storage_core::{jsonutil::now_iso, paths};

use crate::host::Host;

/// Validate a post row's folder and resolve it under the source root.
///
/// The single entry point for every host operation that addresses a post folder;
/// see [`validated_post_root`] for why the row is not trusted.
pub fn post_folder_of(host: &Host, post: &Value) -> Result<PathBuf> {
    let category = post.get("category").and_then(Value::as_str).unwrap_or("");
    let root_path = post.get("rootPath").and_then(Value::as_str).unwrap_or("");
    let validated = validated_post_root(category, root_path)?;
    let folder = host.path_in_root(&validated)?;
    // Belt and braces on top of the shape check: the lexical join must land
    // strictly below `<source>/<Category>/`, never on the category root itself.
    let category_dir = host.path_in_root(category_root(category)?)?;
    if folder == category_dir || !paths::is_inside(&category_dir, &folder) {
        return Err(Error::path_denied("post folder is not inside its category root"));
    }
    Ok(folder)
}

/// Where a new post's folder must live, and the folder to reuse when it exists.
///
/// A post folder is named after its metadata, so a re-import with a corrected
/// title or creator would otherwise compute a *new* folder and strand the files
/// attached to the old one behind a 404. The first row wins for the lifetime of
/// the post; only a row whose stored folder fails validation (pre-C1 data) is
/// renamed, and then under the folder it was actually stored as.
fn import_folder(host: &Host, input: &Value, category: &str, category_dir: &str) -> Result<String> {
    let provider = input.get("provider").and_then(Value::as_str).unwrap_or("");
    let source_id = input.get("sourceId").and_then(Value::as_str).unwrap_or("");
    let creator_name = input
        .get("creator")
        .and_then(|creator| creator.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Unknown");
    let date = input.get("publishedAt").and_then(Value::as_str).unwrap_or("");
    let title = input.get("title").and_then(Value::as_str).unwrap_or("");

    // `rootPath` in the request body is deliberately ignored. It used to be
    // trusted verbatim, which let a client choose any folder under (or equal
    // to) the source root as the target of a later `delete_post`. The folder
    // is the server's naming decision; the client only supplies metadata.
    // Same trim as `upsert_post`, so the lookup finds the row the upsert hits.
    let stored = storage_core::posts::stored_root_path(&host.library.connection, category, provider.trim(), source_id.trim())?;
    match stored {
        Some(previous) if validated_post_root(category, &previous).is_ok() => Ok(previous),
        // A stored folder that fails validation (written before the C1 fix:
        // `''`, `'.'`, another post's folder) is never reused — reusing it is
        // exactly the bug. The post gets a freshly named folder instead; any
        // files left at the old location stay where they are, untouched.
        _ => Ok(post_folder(category_dir, provider, creator_name, date, title, source_id)),
    }
}

pub struct Sidecar {
    pub body: String,
    pub meta: Value,
}

/// Write `.monochrome/post.html` and `.monochrome/info.json`.
///
/// The body is stored sanitized by the caller (see [`crate::html`]); this
/// function deliberately does not re-clean it, so the file on disk is exactly
/// what the renderer was given.
///
/// Both files go through `fsutil::atomic_write` (temp file + rename): a reader
/// (a second host, the user's editor, a backup job) must never see a half-written
/// `info.json`, and a crash mid-write must not leave the post with an empty
/// body file that a later `read_sidecar` would happily return.
///
/// `info.json` is write-once. It is the folder's own claim about what it is, and
/// a re-import must not replace a human's correction; `metadata.json` was
/// rewritten on every import, which is the second write path that made it
/// untrustworthy and got it removed from voice works (docs/16 §2.6). The body is
/// still rewritten because it is derived from the request, not hand-edited.
pub fn write_sidecar(folder: &Path, body_html: &str, meta: &Value) -> Result<()> {
    let sidecar = folder.join(".monochrome");
    std::fs::create_dir_all(&sidecar)?;
    storage_core::fsutil::atomic_write(&sidecar.join("post.html"), body_html.as_bytes())?;
    storage_core::sidecar::write_if_absent(folder, meta)?;
    Ok(())
}

/// Read the sidecar back; empty body/meta when the folder has none.
///
/// A missing or unparsable sidecar is not an error: it is a rebuildable cache of
/// the database row, and failing here would make a half-copied post folder
/// unreadable instead of merely stale. `metadata.json` is the pre-info.json name
/// and is still read so a folder imported before the rename stays readable.
pub fn read_sidecar(folder: &Path) -> Result<Sidecar> {
    let sidecar = folder.join(".monochrome");
    let body = std::fs::read_to_string(sidecar.join("post.html")).unwrap_or_default();
    let meta = storage_core::sidecar::read(folder)
        .or_else(|| {
            std::fs::read_to_string(sidecar.join("metadata.json"))
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
        })
        .unwrap_or_else(|| serde_json::json!({}));
    Ok(Sidecar { body, meta })
}

/// The sidecar directory's name; a file may not live in it.
const SIDECAR_DIR: &str = ".monochrome";

/// `metadata.json` for a freshly imported post: a mirror of its row.
///
/// The design (§1.2) makes the folder the truth and the database an index that
/// can be rebuilt from `metadata.json`. The first version wrote only the
/// caller's free-form `meta` plus `rootPath`, so a real Patreon import produced
/// a sidecar with no title, provider, source id, date, creator or tags: the one
/// file meant to survive a lost database could not say which post it was.
///
/// Built from the stored row (not the request) so it holds exactly what was
/// saved — trimmed provider/source id, the host-chosen `rootPath`, the revision.
/// The creator comes from the request because the row only keeps its id.
/// Files are left out on purpose: `attach`/`delete-asset` change them without
/// rewriting the sidecar, and the bytes themselves are in the folder.
fn sidecar_metadata(row: &Value, input: &Value) -> Value {
    let creator = input.get("creator").filter(|value| value.is_object()).map(|creator| {
        json!({
            "creatorId": row.get("creatorId").cloned().unwrap_or(Value::Null),
            "sourceId": creator.get("sourceId").and_then(Value::as_str).unwrap_or("").trim(),
            "name": creator.get("name").and_then(Value::as_str).unwrap_or(""),
            "url": creator.get("url").and_then(Value::as_str).unwrap_or(""),
        })
    });
    let field = |name: &str| row.get(name).cloned().unwrap_or(Value::Null);
    json!({
        "schema": "monochrome-post/1",
        // Machine-written, and says so: `true` means a human edited the file and
        // it must outrank the next import request.
        "manual": false,
        "postId": field("postId"),
        "category": field("category"),
        "provider": field("provider"),
        "sourceId": field("sourceId"),
        "title": field("title"),
        "publishedAt": field("publishedAt"),
        "sourceUrl": field("sourceUrl"),
        "rootPath": field("rootPath"),
        "bodySha256": field("bodySha256"),
        "revision": field("revision"),
        "updatedAt": field("updatedAt"),
        "tags": row.get("tags").cloned().unwrap_or_else(|| json!([])),
        "creator": creator.unwrap_or(Value::Null),
        "meta": row.get("meta").cloned().unwrap_or_else(|| json!({})),
    })
}

/// Fill a post import from the folder's own `info.json`.
///
/// `manual: true` means a human corrected the file, so it wins over values in the
/// request. Without it the sidecar only fills gaps — a re-import from a live API
/// carries fresher data than a file written months ago, and letting the older
/// copy win would make every import look like it ignored the source.
///
/// Only fields the post table actually has are adopted; `rootPath` is the host's
/// naming decision and is never taken from a file.
fn seed_post_input(input: &mut Value, seed: &Value) {
    let manual = storage_core::sidecar::is_manual(seed);
    let Some(object) = input.as_object_mut() else { return };
    let mut apply = |key: &str, value: Value| {
        let empty = match object.get(key) {
            None | Some(Value::Null) => true,
            Some(Value::String(text)) => text.trim().is_empty(),
            Some(Value::Array(items)) => items.is_empty(),
            _ => false,
        };
        if manual || empty {
            object.insert(key.to_string(), value);
        }
    };
    let title = storage_core::sidecar::text(seed, "title");
    if !title.is_empty() {
        apply("title", json!(title));
    }
    for key in ["publishedAt", "sourceUrl", "provider", "sourceId"] {
        let value = storage_core::sidecar::text(seed, key);
        if !value.is_empty() {
            apply(key, json!(value));
        }
    }
    let tags = storage_core::sidecar::strings(seed, "tags");
    if !tags.is_empty() {
        apply("tags", json!(tags));
    }
}

/// Resolve a post-relative path, refusing anything that leaves the folder.
///
/// `rel_path` comes from an attachment/file record, i.e. from data that may have
/// been written by an imported JSON or a client request, so it is treated as
/// untrusted. Every segment goes through `paths::validate_component` — a bare
/// `..` check is not enough on Windows: `folder.join("C:victim.txt")` does not
/// stay inside `folder`, it *replaces* it with `C:victim.txt` (an alternate data
/// stream or a drive-relative path). Reserved device names, ADS colons, and
/// trailing dots/spaces are refused there too. `.monochrome` is refused because
/// the sidecar is the post's own metadata: `POST /api/videos/delete-asset` with
/// `relPath: ".monochrome/post.html"` would otherwise let a client delete the
/// body it is not allowed to write.
pub fn resolve_in(folder: &Path, rel_path: &str) -> Result<PathBuf> {
    let normalized = paths::normalize_slashes(rel_path);
    if normalized.starts_with('/') || Path::new(&normalized).is_absolute() {
        return Err(Error::path_denied("post file path escapes the post folder"));
    }
    let mut path = folder.to_path_buf();
    // `.` and empty segments are no-ops, dropped so the sidecar check below
    // sees the real first segment (`./.monochrome/x` is still the sidecar).
    let mut parts = normalized.split('/').filter(|part| !part.is_empty() && *part != ".");
    let Some(first) = parts.next() else {
        return Err(Error::path_denied("post file path is empty"));
    };
    // Case-insensitive: on Windows `.MONOCHROME/post.html` *is* the sidecar.
    if first.eq_ignore_ascii_case(SIDECAR_DIR) {
        return Err(Error::path_denied("post file path may not address the sidecar"));
    }
    for part in std::iter::once(first).chain(parts) {
        let validated = paths::validate_component(part).map_err(|error| Error::path_denied(error.message))?;
        path.push(validated);
    }
    // Defence in depth: the per-segment check already makes an escape
    // impossible, but containment is what the callers actually rely on, so it is
    // asserted here rather than inferred.
    if !paths::is_inside(folder, &path) || paths::resolve_lexical(folder) == path {
        return Err(Error::path_denied("post file path escapes the post folder"));
    }
    Ok(path)
}

/// Timestamp helper kept next to the sidecar code so callers have one import.
pub fn timestamp() -> String {
    now_iso()
}

/// Roles the `post_file.role` CHECK constraint accepts.
///
/// Checked before the bytes are written so a bad role fails as a 400 with a
/// message, instead of as a 500 from a SQLite CHECK violation after the file is
/// already on disk.
const POST_FILE_ROLES: &[&str] = &["attachment", "inline", "thumbnail", "cover", "video", "subtitle"];

fn validated_role(role: &str) -> Result<&str> {
    POST_FILE_ROLES
        .iter()
        .find(|allowed| **allowed == role)
        .copied()
        .ok_or_else(|| Error::bad_request(format!("role must be one of {}", POST_FILE_ROLES.join(", "))))
}

impl Host {
    /// Create or update one post and its readable folder
    /// (`POST /api/creations/import`, `POST /api/videos/import`).
    ///
    /// Validation, then the folder, then the row, then the sidecar: a rejected
    /// request must not leave an empty directory behind, and a failure must
    /// leave a rebuildable folder rather than an index entry pointing at
    /// nothing. Both body shapes (HTML from Patreon, plain text from YouTube)
    /// go through this one entry point so there is exactly one place that
    /// decides what a stored body may contain.
    pub fn import_post(&mut self, input: &Value) -> Result<Value> {
        let category = input.get("category").and_then(Value::as_str).unwrap_or("");
        let category_dir = category_root(category)?;
        let provider = input.get("provider").and_then(Value::as_str).unwrap_or("").trim();
        let source_id = input.get("sourceId").and_then(Value::as_str).unwrap_or("").trim();
        if provider.is_empty() || source_id.is_empty() {
            return Err(Error::bad_request("provider and sourceId are required"));
        }
        // Same rule `upsert_creator` applies, checked here so a missing creator
        // id fails before the folder exists rather than after.
        if let Some(creator) = input.get("creator").filter(|value| value.is_object()) {
            if creator.get("sourceId").and_then(Value::as_str).map(str::trim).unwrap_or("").is_empty() {
                return Err(Error::bad_request("creator.sourceId is required"));
            }
        }
        // First import of a folder that already carries `.monochrome/info.json`
        // (a backup restored without the database, a folder copied between
        // machines): adopt its metadata. Once a row exists the database wins and
        // the file is not consulted at all — that is what keeps one authority.
        let existing = storage_core::posts::stored_root_path(&self.library.connection, category, provider, source_id)?;
        let mut input = input.clone();
        let mut seeded_body: Option<String> = None;
        let root_path = if existing.is_none() {
            let prospective = import_folder(self, &input, category, category_dir)?;
            let candidate = self.path_in_root(&validated_post_root(category, &prospective)?)?;
            let sidecar = read_sidecar(&candidate)?;
            // A folder without a title in its sidecar has nothing worth adopting;
            // an empty `metadata.json`-era file must not pin the path either.
            if sidecar.meta.as_object().map(|object| object.contains_key("title")).unwrap_or(false) {
                seed_post_input(&mut input, &sidecar.meta);
                if !sidecar.body.trim().is_empty() {
                    seeded_body = Some(sidecar.body);
                }
                prospective
            } else {
                import_folder(self, &input, category, category_dir)?
            }
        } else {
            import_folder(self, &input, category, category_dir)?
        };
        let folder = self.path_in_root(&validated_post_root(category, &root_path)?)?;
        std::fs::create_dir_all(&folder)?;

        let mut body = match input.get("bodyHtml").and_then(Value::as_str) {
            Some(html) => crate::html::sanitize_body(html),
            None => crate::html::plain_text_to_html(input.get("bodyText").and_then(Value::as_str).unwrap_or("")),
        };
        // A hand-edited `post.html` is still untrusted: re-clean it through the
        // same sanitizer instead of serving whatever bytes are on disk.
        if body.trim().is_empty() {
            if let Some(seed) = seeded_body {
                body = crate::html::sanitize_body(&seed);
            }
        }

        let body_sha256 = storage_core::hash::sha256_text(&body);
        let timestamp = timestamp();
        // The row stores the folder we actually created. `rootPath` is computed
        // here (never taken from the payload) and every later call — attach,
        // delete, sidecar, media — addresses the post through it.
        let mut stored = input.clone();
        if let Some(object) = stored.as_object_mut() {
            object.insert("rootPath".to_string(), serde_json::json!(root_path));
        }
        let saved = storage_core::posts::upsert_post(&self.library.connection, &stored, &body_sha256, &timestamp)?;
        // `upsert_post` resurrects a soft-deleted row and returns its id on
        // purpose; minting a new id here would address a row that does not exist.
        let post_id = saved.get("postId").and_then(Value::as_str).unwrap_or("").to_string();
        let row = storage_core::posts::get_post(&self.library.connection, &post_id)?
            .ok_or_else(|| Error::new("imported post row is missing"))?;
        write_sidecar(&folder, &body, &sidecar_metadata(&row, &input))?;
        Ok(serde_json::json!({
            "postId": post_id,
            "category": category,
            "rootPath": root_path,
            "created": saved.get("created").cloned().unwrap_or(Value::Bool(false)),
            "revision": saved.get("revision").cloned().unwrap_or(Value::Null),
        }))
    }

    /// Join a post-relative folder onto the source root, refusing escapes.
    ///
    /// `relative` may come from a stored `root_path`, so it is untrusted: the
    /// lexical join must still land inside the source root before anything is
    /// created there. This is the *source-root* gate; post folders additionally
    /// go through [`post_folder_of`], which requires the four-segment shape.
    pub fn path_in_root(&self, relative: &str) -> Result<PathBuf> {
        let root = self
            .source_root
            .as_ref()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        let path = paths::resolve_lexical(&root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)));
        if path != *root && !paths::is_inside(root, &path) {
            return Err(Error::path_denied("post folder escapes the source root"));
        }
        Ok(path)
    }

    /// Copy one already-staged file into the post folder and record it
    /// (`POST /api/creations/:id/files`, `POST /api/videos/attach`).
    ///
    /// A post holds one physical copy per sha256, the same rule the audio side
    /// uses: the same zipped release attached again under another name must not
    /// double the folder and the backup. `name` is a display name chosen by the
    /// client, so it is sanitized into a single segment and then re-checked by
    /// [`resolve_in`] before anything is created on disk.
    pub fn attach_post_file(&mut self, input: &Value) -> Result<Value> {
        let post_id = input.get("postId").and_then(Value::as_str).unwrap_or("");
        // A client-chosen name is flattened to one segment: a client has no
        // business creating subdirectories in a post folder.
        let name = segment(input.get("name").and_then(Value::as_str).unwrap_or(""), "file");
        self.attach_at(post_id, &name, input)
    }

    /// Shared body of [`attach_post_file`] and [`finish_fetch`].
    ///
    /// `rel_path` may have several segments (a downloader's `sub/v.mp4`); it is
    /// re-checked by [`resolve_in`] either way, and the role is checked before
    /// any byte is copied, so a CHECK-constraint failure can never leave an
    /// orphan file behind a 500.
    fn attach_at(&mut self, post_id: &str, rel_path: &str, input: &Value) -> Result<Value> {
        let post = storage_core::posts::get_post(&self.library.connection, post_id)?
            .ok_or_else(|| Error::not_found("post not found"))?;
        let folder = post_folder_of(self, &post)?;
        let role = validated_role(input.get("role").and_then(Value::as_str).unwrap_or("attachment"))?;
        let target = resolve_in(&folder, rel_path)?;
        let rel_path = paths::relative_slash(&folder, &target);
        // The staged file normally lives in the experiment root (a download
        // scratch dir); a caller that already staged inside the library source
        // root is accepted too. Anything else is refused rather than read, since
        // `sourcePath` comes from the request body.
        let source_path = input.get("sourcePath").and_then(Value::as_str).unwrap_or("");
        let source = self
            .confine_to_experiment(Path::new(source_path))
            .or_else(|_| self.path_in_root(source_path))?;
        let (sha256, bytes) = storage_core::hash::hash_file(&source)?;
        // Dedup only against bytes that are really there. A row left `missing`
        // or `remote` by a delete used to match here, and the attach answered
        // `duplicateOf` without writing anything — the same file could never be
        // attached again after the user deleted it.
        let existing = storage_core::posts::files_of(&self.library.connection, post_id)?;
        if let Some(same) = existing.iter().find(|file| {
            file["sha256"].as_str() == Some(sha256.as_str())
                && file["status"].as_str() == Some("local")
                && file["relPath"]
                    .as_str()
                    .and_then(|rel| resolve_in(&folder, rel).ok())
                    .map(|path| path.is_file())
                    .unwrap_or(false)
        }) {
            return Ok(json!({
                "postId": post_id,
                "duplicateOf": same["relPath"],
                "sha256": sha256,
                "bytes": bytes,
            }));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // An external fetcher writes straight into the post folder, so the
        // "staged" file can already be the target. Copying a file onto itself
        // fails on Windows (os error 32) and would truncate it elsewhere, so
        // only the row is recorded in that case.
        if !same_file(&source, &target) {
            std::fs::copy(&source, &target)?;
        }
        // `upsert_file` replaces the row for `(post_id, rel_path)`, so a row a
        // delete had marked missing/remote becomes `local` again here.
        storage_core::posts::upsert_file(
            &self.library.connection,
            post_id,
            &json!({
                "role": role,
                "relPath": rel_path,
                "sha256": sha256,
                "bytes": bytes,
                "mime": input.get("mime").and_then(Value::as_str).unwrap_or("application/octet-stream"),
                "remoteUrl": input.get("remoteUrl").and_then(Value::as_str).unwrap_or(""),
                "status": "local",
            }),
            &timestamp(),
        )?;
        Ok(json!({ "postId": post_id, "relPath": rel_path, "sha256": sha256, "bytes": bytes }))
    }

    /// Remove one file's bytes, keeping its row as `missing`/`remote`.
    ///
    /// The row survives on purpose: the file list is the post's own statement of
    /// what it contains, so shrinking it would make the detail page look like the
    /// attachment never existed. A disk failure is ignored — the row state is
    /// what the UI reads, and a partially deleted copy is repaired on rescan.
    pub fn delete_post_file(&mut self, post_id: &str, rel_path: &str) -> Result<bool> {
        let post = storage_core::posts::get_post(&self.library.connection, post_id)?
            .ok_or_else(|| Error::not_found("post not found"))?;
        let folder = post_folder_of(self, &post)?;
        // Refuse before touching disk, and only delete a file this post actually
        // registered. The old order (`remove_file`, then look up the row) meant
        // an arbitrary path was unlinked and the 200/400 answer only came after.
        let row = storage_core::posts::find_file(&self.library.connection, post_id, rel_path)?;
        if row.is_some() {
            let path = resolve_in(&folder, rel_path)?;
            let _ = std::fs::remove_file(&path);
        }
        storage_core::posts::mark_file_missing(&self.library.connection, post_id, rel_path)
    }

    /// Soft-delete a post and remove its folder (`DELETE /api/creations/:id`).
    ///
    /// A post folder is never shared between posts, so the whole tree goes; only
    /// an emptied creator directory is pruned above it, never the category root.
    /// The file rows are marked `missing` in the same transaction: a re-import
    /// revives the post, and it must not come back claiming files whose bytes
    /// went with the folder.
    pub fn delete_post(&mut self, post_id: &str) -> Result<Value> {
        let post = storage_core::posts::get_post(&self.library.connection, post_id)?
            .ok_or_else(|| Error::not_found("post not found"))?;
        let root_path = post["rootPath"].as_str().unwrap_or("").to_string();
        let category = post["category"].as_str().unwrap_or("").to_string();
        let folder = post_folder_of(self, &post)?;
        // Depth check before `remove_dir_all`: the shape check above already
        // guarantees four segments, but `remove_dir_all` on a mis-resolved path
        // is unrecoverable, so the depth is asserted where the call happens too.
        let root = self
            .source_root
            .as_ref()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        let category_dir = self.path_in_root(category_root(&category)?)?;
        let depth = folder
            .strip_prefix(root)
            .map(|relative| relative.components().count())
            .unwrap_or(0);
        if folder == *root || depth < 3 || !paths::is_inside(&category_dir, &folder) {
            return Err(Error::path_denied("post folder is not deep enough to delete"));
        }
        storage_core::posts::soft_delete_post_and_files(&self.library.connection, post_id, &timestamp())?;
        let _ = std::fs::remove_dir_all(&folder);
        prune_empty_parents(&self.source_root, &folder);
        Ok(json!({ "postId": post_id, "deleted": true, "rootPath": root_path }))
    }

    /// One live post with its tags and files.
    pub fn get_post(&self, post_id: &str) -> Result<Value> {
        storage_core::posts::get_post(&self.library.connection, post_id)?
            .ok_or_else(|| Error::not_found("post not found"))
    }

    /// Posts of one category, newest first.
    pub fn list_posts(&self, category: &str) -> Result<Value> {
        storage_core::posts::list_posts_by_category(&self.library.connection, category)
    }

    /// What a fetch needs from the host: the folder and the validated URL.
    pub fn prepare_fetch(&self, input: &Value) -> Result<FetchPlan> {
        let Some(fetcher) = VideoFetcher::from_env() else {
            return Err(Error::coded(
                "ENOTCONFIGURED",
                "no video fetcher is configured (set MONOCHROME_VIDEO_FETCHER)",
            ));
        };
        let post_id = input.get("postId").and_then(Value::as_str).unwrap_or("");
        let url = input.get("url").and_then(Value::as_str).unwrap_or("");
        if !crate::net::is_http_url(url) {
            return Err(Error::bad_request("URL must be http(s)"));
        }
        let post = storage_core::posts::get_post(&self.library.connection, post_id)?
            .ok_or_else(|| Error::not_found("post not found"))?;
        if post["category"].as_str() != Some("video") {
            return Err(Error::coded("ECATEGORY", "post is not a video"));
        }
        let folder = post_folder_of(self, &post)?;
        Ok(FetchPlan { post_id: post_id.to_string(), url: url.to_string(), folder, fetcher })
    }

    /// Run the downloader for a prepared plan, **without** the host lock.
    ///
    /// The downloader is a whole external program and can run for minutes. Held
    /// under the global host mutex, that stalled every `/api/*`, `/media/*` and
    /// even `/health` call for the duration (they all lock the same `Host`). The
    /// lock is therefore taken only to read the plan ([`prepare_fetch`]) and to
    /// register the result ([`finish_fetch`]); this phase touches the disk and
    /// the child process only.
    pub fn run_fetch(plan: &FetchPlan) -> Result<FetchOutcome> {
        std::fs::create_dir_all(&plan.folder)?;
        let output = run_with_timeout(&plan.fetcher.program, &[&plan.url, &plan.folder.to_string_lossy()], plan.fetcher.timeout)?;
        if !output.status.success() {
            // Bounded: a downloader can dump a whole progress log to stderr, and
            // this message travels back to the client as JSON.
            let stderr: String = String::from_utf8_lossy(&output.stderr).trim().chars().take(500).collect();
            return Err(Error::new(format!(
                "video fetcher exited {}: {stderr}",
                output.status.code().map_or_else(|| "without a code".to_string(), |code| code.to_string())
            )));
        }
        // Real downloaders print progress before the result, so the contract is
        // "the last non-empty line", not "the whole stdout".
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
        let parsed: Value = serde_json::from_str(line)
            .map_err(|_| Error::new("video fetcher did not print a JSON result line"))?;
        if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(Error::new("video fetcher reported failure"));
        }
        let rel_path = parsed.get("file").and_then(Value::as_str).unwrap_or("");
        if rel_path.is_empty() {
            return Err(Error::new("video fetcher result has no file"));
        }
        Ok(FetchOutcome {
            file: rel_path.to_string(),
            mime: parsed.get("mime").and_then(Value::as_str).unwrap_or("video/mp4").to_string(),
        })
    }

    /// Register a finished download; takes the lock again.
    ///
    /// The fetcher is untrusted output as far as paths go: the `file` it reports
    /// is resolved inside the post folder with [`resolve_in`], so a misbehaving
    /// tool cannot make the host register (or copy) a file from elsewhere.
    pub fn finish_fetch(&mut self, plan: &FetchPlan, outcome: &FetchOutcome) -> Result<Value> {
        let post = storage_core::posts::get_post(&self.library.connection, &plan.post_id)?
            .ok_or_else(|| Error::not_found("post not found"))?;
        let folder = post_folder_of(self, &post)?;
        let downloaded = resolve_in(&folder, &outcome.file)?;
        // Register the relative path the downloader reported instead of
        // flattening it to the folder top: a tool that writes `sub/v.mp4` used
        // to leave the file at `sub/v.mp4` and record a *copy* at `v.mp4`, so
        // every download cost the bytes twice.
        let rel_path = paths::relative_slash(&folder, &downloaded);
        if rel_path.is_empty() {
            return Err(Error::new("video fetcher result has no file"));
        }
        // The absolute path is inside the source root, which `attach_at`
        // accepts for `sourcePath`; a relative one would be joined onto the
        // source root instead of the post folder and miss the file.
        self.attach_at(
            &plan.post_id,
            &rel_path,
            &json!({
                "sourcePath": downloaded.to_string_lossy(),
                "role": "video",
                "mime": outcome.mime,
                "remoteUrl": plan.url,
            }),
        )
    }

    /// Pull one public URL (thumbnail, avatar, linked file) into a post folder.
    ///
    /// Bounded to 32 MiB in memory on purpose: this path is for small post
    /// assets, while media downloads keep their own streaming pipeline.
    ///
    /// One-call form for synchronous callers; the HTTP layer runs the three
    /// phases itself so the 15 s network budget is not spent holding the host
    /// lock (see [`Host::run_fetch`] for why that matters).
    pub fn cache_post_remote_file(&mut self, post_id: &str, url: &str, name: &str, role: &str) -> Result<Value> {
        let plan = self.prepare_remote_file(post_id, url, name, role)?;
        let fetched = Host::download_remote_file(&plan)?;
        self.finish_remote_file(&plan, &fetched)
    }

    /// Locked phase 1: check the post, folder, role and name; touch nothing.
    ///
    /// Everything that can be refused is refused here, before the request: a
    /// bad name or role must not spend a 32 MiB download first.
    pub fn prepare_remote_file(&self, post_id: &str, url: &str, name: &str, role: &str) -> Result<RemoteFilePlan> {
        let post = storage_core::posts::get_post(&self.library.connection, post_id)?
            .ok_or_else(|| Error::not_found("post not found"))?;
        let folder = post_folder_of(self, &post)?;
        let role = validated_role(role)?.to_string();
        let name = segment(name, "file");
        resolve_in(&folder, &name)?;
        if !crate::net::is_http_url(url) {
            return Err(Error::bad_request("URL must be http(s)"));
        }
        Ok(RemoteFilePlan { post_id: post_id.to_string(), url: url.to_string(), name, role })
    }

    /// Unlocked phase 2: the network request.
    ///
    /// Public addresses only: the URL is client-supplied, and the host runs next
    /// to its own API, the LAN and (in the cloud) a metadata endpoint.
    pub fn download_remote_file(plan: &RemoteFilePlan) -> Result<crate::net::Fetched> {
        let fetched = crate::net::get_bounded_public(&plan.url, 32 * 1024 * 1024, crate::net::COVER_TIMEOUT)?;
        if !(200..300).contains(&fetched.status) {
            return Err(Error::new(format!("remote file request returned HTTP {}", fetched.status)));
        }
        Ok(fetched)
    }

    /// Locked phase 3: re-validate (the post may have changed meanwhile) and write.
    pub fn finish_remote_file(&mut self, plan: &RemoteFilePlan, fetched: &crate::net::Fetched) -> Result<Value> {
        let post = storage_core::posts::get_post(&self.library.connection, &plan.post_id)?
            .ok_or_else(|| Error::not_found("post not found"))?;
        let folder = post_folder_of(self, &post)?;
        let target = resolve_in(&folder, &plan.name)?;
        std::fs::create_dir_all(&folder)?;
        storage_core::fsutil::atomic_write(&target, &fetched.body)?;
        let sha256 = {
            use sha2::{Digest, Sha256};
            storage_core::hash::hex(&Sha256::digest(&fetched.body))
        };
        let mime = fetched.content_type.split(';').next().unwrap_or("").trim().to_string();
        let mime = if mime.is_empty() { "application/octet-stream".to_string() } else { mime };
        let bytes = fetched.body.len();
        storage_core::posts::upsert_file(
            &self.library.connection,
            &plan.post_id,
            &json!({
                "role": plan.role,
                "relPath": plan.name,
                "sha256": sha256,
                "bytes": bytes,
                "mime": mime,
                "remoteUrl": plan.url,
                "status": "local",
            }),
            &timestamp(),
        )?;
        Ok(json!({ "postId": plan.post_id, "relPath": plan.name, "sha256": sha256, "bytes": bytes, "mime": mime }))
    }
}

/// What `cache_post_remote_file` carries between its locked phases.
#[derive(Debug)]
pub struct RemoteFilePlan {
    pub post_id: String,
    pub url: String,
    pub name: String,
    pub role: String,
}

/// Everything `fetch_video` needs between the two locked phases.
#[derive(Debug)]
pub struct FetchPlan {
    pub post_id: String,
    pub url: String,
    pub folder: PathBuf,
    pub fetcher: VideoFetcher,
}

/// What the downloader reported, before it is resolved against a folder.
pub struct FetchOutcome {
    pub file: String,
    pub mime: String,
}

/// `POST /api/videos/fetch`, kept as one call for callers that hold a `&mut Host`.
///
/// The HTTP layer should not use this: it calls prepare / run / finish itself so
/// the lock is released while the downloader runs. Kept so a synchronous caller
/// (tests, the CLI) still has one obvious entry point.
pub fn fetch_video(host: &mut Host, input: &Value) -> Result<Value> {
    let plan = host.prepare_fetch(input)?;
    let outcome = Host::run_fetch(&plan)?;
    host.finish_fetch(&plan, &outcome)
}

/// External video downloader contract.
///
/// The Rust side never downloads video streams itself. It runs whatever the
/// operator configured (`MONOCHROME_VIDEO_FETCHER`) as
/// `<program> <url> <postFolder>`; the program writes the file into the folder
/// and prints `{"ok":true,"file":"<relative path>",...}` as its last stdout
/// line. Shipping no downloader keeps the option open without breaking a
/// platform's terms by default.
#[derive(Debug)]
pub struct VideoFetcher {
    pub program: PathBuf,
    pub timeout: std::time::Duration,
}

/// Default budget for one download.
///
/// A large video over a slow link legitimately takes minutes, so the default is
/// generous; `MONOCHROME_VIDEO_FETCHER_TIMEOUT_MS` overrides it. A timeout, not
/// "wait forever": a hung downloader used to block the post's whole API surface.
pub const DEFAULT_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

impl VideoFetcher {
    /// The configured program, or `None` when the variable is unset or empty.
    pub fn from_env() -> Option<Self> {
        let program = std::env::var_os("MONOCHROME_VIDEO_FETCHER")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())?;
        let timeout = std::env::var("MONOCHROME_VIDEO_FETCHER_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|millis| *millis > 0)
            .map(std::time::Duration::from_millis)
            .unwrap_or(DEFAULT_FETCH_TIMEOUT);
        Some(VideoFetcher { program, timeout })
    }
}

/// Run a child process, killing it once `timeout` elapses.
///
/// `std::process::Command::output` has no timeout, so the child is spawned with
/// piped output, drained on two helper threads (a full pipe would deadlock the
/// wait), and the wait is bounded by polling `try_wait`. On timeout the process
/// tree is killed and `ETIMEOUT` returned; the caller's error message says so, so
/// the client does not retry a download that already burned its budget.
fn run_with_timeout(
    program: &Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<std::process::Output> {
    use std::io::Read;

    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Own process group, so `kill_tree` can signal the downloader's children.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| Error::new(format!("video fetcher failed to start: {error}")))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    // Readers report through a channel so the final collection can be bounded:
    // a grandchild that inherited the pipe keeps it open after the downloader
    // itself exits, and a plain `join()` would then wait on it indefinitely.
    let (sender, receiver) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    let stdout_sender = sender.clone();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        let _ = stdout_sender.send((true, buffer));
    });
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        let _ = sender.send((false, buffer));
    });
    let started = std::time::Instant::now();
    let timed_out = || {
        Error::coded("ETIMEOUT", format!("video fetcher exceeded {} ms and was killed", timeout.as_millis()))
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(timed_out());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(error) => return Err(Error::new(format!("video fetcher wait failed: {error}"))),
        }
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    for _ in 0..2 {
        let remaining = timeout.saturating_sub(started.elapsed()).max(std::time::Duration::from_millis(100));
        match receiver.recv_timeout(remaining) {
            Ok((true, bytes)) => stdout = bytes,
            Ok((false, bytes)) => stderr = bytes,
            Err(_) => {
                kill_tree(&mut child);
                return Err(timed_out());
            }
        }
    }
    Ok(std::process::Output { status, stdout, stderr })
}

/// Kill a timed-out downloader *and its children*.
///
/// A real downloader is rarely one process (yt-dlp runs ffmpeg), and killing
/// only the parent leaves the child writing into the post folder after the host
/// already answered "timed out". Windows: `taskkill /T` walks the tree. Unix:
/// the child was put in its own process group at spawn, so the whole group is
/// signalled. Both are best effort, followed by a direct kill of the parent.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{}", child.id())])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Whether two paths name the same file.
///
/// Lexical comparison first (no I/O, covers the fetcher case where both paths
/// are built from the same folder); canonical comparison second, so a
/// differently spelled path to the same file is still recognised.
fn same_file(left: &Path, right: &Path) -> bool {
    if paths::resolve_lexical(left) == paths::resolve_lexical(right) {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Remove directories left empty above a deleted post folder.
///
/// Stops before `source_root` (never remove the library root) and before
/// `creations/`/`videos/` (the category roots are the top of the readable tree
/// and must survive an emptied library). `remove_dir` rather than
/// `remove_dir_all` is what makes this safe: a directory that still holds
/// another creator's folder simply fails and ends the walk.
fn prune_empty_parents(source_root: &Option<PathBuf>, folder: &Path) {
    let Some(root) = source_root else { return };
    let mut current = folder.parent().map(|parent| parent.to_path_buf());
    while let Some(dir) = current {
        if dir == *root || !paths::is_inside(root, &dir) {
            break;
        }
        let is_category_root = dir
            .file_name()
            .map(|name| name == CATEGORY_CREATION || name == CATEGORY_VIDEO)
            .unwrap_or(false);
        if is_category_root || std::fs::remove_dir(&dir).is_err() {
            break;
        }
        current = dir.parent().map(|parent| parent.to_path_buf());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{Host, HostOptions};

    /// A host whose source root is also the library parent, so `rootPath` values
    /// can be joined back onto the same temporary directory.
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

    /// Temp root that is removed when the test ends, pass or fail.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("mono-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            TempRoot(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn import_post_cleans_body_and_writes_sidecar() {
        let root = TempRoot::new("import");
        let mut host = test_host(root.path());
        let outcome = host
            .import_post(&serde_json::json!({
                "category": "creation",
                "provider": "patreon",
                "sourceId": "150409075",
                "title": "5$",
                "publishedAt": "2026-02-10T00:00:00.000Z",
                "bodyHtml": "<p>hi<script>x()</script></p>",
                "tags": ["Patreon"],
                "creator": { "sourceId": "u1", "name": "Creator" }
            }))
            .unwrap();
        let folder = root.path().join(outcome["rootPath"].as_str().unwrap());
        assert!(folder.join(".monochrome/post.html").exists());
        let body = std::fs::read_to_string(folder.join(".monochrome/post.html")).unwrap();
        assert!(!body.contains("script"), "{body}");
        assert_eq!(outcome["category"], "creation");
    }

    /// Found by importing a real Pawchive post: `metadata.json` held only the
    /// request's free-form `meta` and `rootPath`, so the sidecar that is meant to
    /// rebuild the index could not even name its post. Synthetic data, same
    /// shape as that import (Pawchive's `YYYY-MM-DD HH:MM:SS` date, `$`/`&` in
    /// the title, padded ids).
    #[test]
    fn sidecar_metadata_mirrors_the_row() {
        let root = TempRoot::new("sidecar-meta");
        let mut host = test_host(root.path());
        let outcome = host
            .import_post(&serde_json::json!({
                "category": "creation",
                "provider": " Patreon ",
                "sourceId": " 9001 ",
                "title": "1$ (a&b)",
                "publishedAt": "2025-03-04 05:06:07",
                "sourceUrl": "https://example.invalid/p/9001",
                "bodyHtml": "<p>one</p><ul><li><strong>two</strong></li></ul>",
                "tags": ["Pawchive", " 预览 ", ""],
                "creator": { "sourceId": "u-7", "name": "Some Creator", "url": "https://example.invalid/u/7" },
                "meta": { "importedFrom": "pawchive" },
                "rootPath": "."
            }))
            .unwrap();
        let root_path = outcome["rootPath"].as_str().unwrap();
        assert_eq!(root_path, "creations/Patreon/Some Creator/2025-03-04 1$ (a&b) [9001]");
        let folder = root.path().join(root_path);
        let meta = read_sidecar(&folder).unwrap().meta;
        let row = host.get_post(outcome["postId"].as_str().unwrap()).unwrap();

        assert_eq!(meta["postId"], outcome["postId"], "{meta}");
        assert_eq!(meta["category"], "creation");
        assert_eq!(meta["provider"], "Patreon", "trimmed like the row: {meta}");
        assert_eq!(meta["sourceId"], "9001", "{meta}");
        assert_eq!(meta["title"], "1$ (a&b)");
        assert_eq!(meta["publishedAt"], "2025-03-04 05:06:07");
        assert_eq!(meta["sourceUrl"], "https://example.invalid/p/9001");
        assert_eq!(meta["rootPath"], root_path, "the host's folder, not the client's '.'");
        assert_eq!(meta["tags"], serde_json::json!(["Pawchive", "预览"]), "{meta}");
        assert_eq!(meta["creator"]["sourceId"], "u-7");
        assert_eq!(meta["creator"]["name"], "Some Creator");
        assert_eq!(meta["creator"]["creatorId"], row["creatorId"]);
        assert_eq!(meta["meta"]["importedFrom"], "pawchive");
        assert_eq!(meta["revision"], 1);
        // `bodySha256` is what lets a rebuild detect an edited post.html.
        let body = std::fs::read_to_string(folder.join(".monochrome/post.html")).unwrap();
        assert_eq!(meta["bodySha256"], storage_core::hash::sha256_text(&body));
        assert_eq!(meta["bodySha256"], row["bodySha256"]);

        // `info.json` is a seed, not a mirror: a re-import updates the row and
        // the body, and deliberately leaves the file exactly as first written.
        // Rewriting it every import is the second write path that made the old
        // `metadata.json` untrustworthy (docs/16 §2.6).
        let mut again = serde_json::json!({
            "category": "creation", "provider": "Patreon", "sourceId": "9001", "title": "1$ (a&b) v2",
            "bodyHtml": "<p>changed</p>", "creator": { "sourceId": "u-7", "name": "Some Creator" }
        });
        again["publishedAt"] = serde_json::json!("2025-03-04 05:06:07");
        host.import_post(&again).unwrap();
        let meta = read_sidecar(&folder).unwrap().meta;
        assert_eq!(meta["revision"], 1, "the seed keeps its first-import revision: {meta}");
        assert_eq!(meta["title"], "1$ (a&b)", "the seed is not rewritten: {meta}");
        let row = host.get_post(outcome["postId"].as_str().unwrap()).unwrap();
        assert_eq!(row["title"], "1$ (a&b) v2", "the row is the authority");
    }

    /// A folder restored without its database still says what it is: the first
    /// import adopts `.monochrome/info.json`. A file a human marked `manual`
    /// outranks the request, and the import never overwrites the correction.
    #[test]
    fn first_import_adopts_the_folders_own_info_json() {
        let root = TempRoot::new("sidecar-seed");
        let request = serde_json::json!({
            "category": "creation",
            "provider": "Patreon",
            "sourceId": "77",
            "title": "Seed",
            "publishedAt": "2026-01-01T00:00:00.000Z",
            "bodyText": "body",
            "creator": { "sourceId": "u1", "name": "Creator" }
        });
        let mut first = test_host(root.path());
        let outcome = first.import_post(&request).unwrap();
        let root_path = outcome["rootPath"].as_str().unwrap().to_string();
        let folder = root.path().join(&root_path);
        drop(first);

        // A second library over the same source root: no row, the folder and its
        // seed remain. A human has corrected the title and tags by hand.
        let mut info: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(folder.join(".monochrome/info.json")).unwrap()).unwrap();
        info["manual"] = serde_json::json!(true);
        info["title"] = serde_json::json!("Edited By Hand");
        info["tags"] = serde_json::json!(["restored"]);
        std::fs::write(folder.join(".monochrome/info.json"), info.to_string()).unwrap();

        let mut second = Host::open(HostOptions {
            library_root: root.path().join("lib2"),
            source_root: Some(root.path().to_path_buf()),
            allowed_source_roots: vec![root.path().to_path_buf()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = second.import_post(&request).unwrap();
        assert_eq!(imported["rootPath"], root_path, "the folder is reused, not duplicated");
        let row = second.get_post(imported["postId"].as_str().unwrap()).unwrap();
        assert_eq!(row["title"], "Edited By Hand", "a manual seed wins over the request: {row}");
        assert_eq!(row["tags"], serde_json::json!(["restored"]), "{row}");
        let after = read_sidecar(&folder).unwrap().meta;
        assert_eq!(after["title"], "Edited By Hand", "the import did not overwrite the correction");
    }

    #[test]
    fn seed_post_input_fills_gaps_unless_marked_manual() {
        let seed = serde_json::json!({ "title": "Seed", "tags": ["a"], "publishedAt": "2026-01-01" });
        let mut input = serde_json::json!({ "title": "Request", "tags": [] });
        seed_post_input(&mut input, &seed);
        assert_eq!(input["title"], "Request", "the request wins by default");
        assert_eq!(input["tags"], serde_json::json!(["a"]), "an empty value is a gap");
        assert_eq!(input["publishedAt"], "2026-01-01");

        let manual = serde_json::json!({ "manual": true, "title": "Edited" });
        seed_post_input(&mut input, &manual);
        assert_eq!(input["title"], "Edited", "manual wins even over a present value");
    }

    #[test]
    fn import_post_defaults_to_readable_folder_and_is_idempotent() {
        // The same post imported twice is one folder and one row: the readable
        // tree is the user's view of the library, so a re-import must find the
        // existing folder instead of creating `… [id] (2)` next to it.
        let root = TempRoot::new("import-twice");
        let mut host = test_host(root.path());
        let input = serde_json::json!({
            "category": "creation",
            "provider": "Patreon",
            "sourceId": "42",
            "title": "Hello",
            "publishedAt": "2026-02-10T00:00:00.000Z",
            "bodyText": "plain text",
            "creator": { "sourceId": "u1", "name": "Creator" }
        });
        let first = host.import_post(&input).unwrap();
        let second = host.import_post(&input).unwrap();

        assert_eq!(first["created"], true, "{first}");
        assert_eq!(second["created"], false, "{second}");
        assert_eq!(second["revision"], 2, "{second}");
        assert_eq!(second["postId"], first["postId"], "a re-import updates the same row");
        assert_eq!(second["rootPath"], first["rootPath"]);

        let creator_dir = root.path().join("creations/Patreon/Creator");
        let folders = std::fs::read_dir(&creator_dir)
            .unwrap()
            .filter(|entry| entry.as_ref().map(|entry| entry.path().is_dir()).unwrap_or(false))
            .count();
        assert_eq!(folders, 1, "{} has more than one post folder", creator_dir.display());
    }

    #[test]
    fn sidecar_round_trips_body_and_metadata() {
        let root = TempRoot::new("posts");
        let folder = root.path().join("creations/Patreon/c/2026-01-01 t [1]");
        std::fs::create_dir_all(&folder).unwrap();
        write_sidecar(&folder, "<p>hi</p>", &serde_json::json!({ "title": "t" })).unwrap();
        let read = read_sidecar(&folder).unwrap();
        assert_eq!(read.body, "<p>hi</p>");
        assert_eq!(read.meta["title"], "t");
        // Atomic write leaves no temp file behind: the sidecar folder is what a
        // user copies to another machine.
        let leftovers: Vec<String> = std::fs::read_dir(folder.join(".monochrome"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn attach_and_delete_files_keep_the_folder_consistent() {
        let root = TempRoot::new("attach");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "creation", "provider": "patreon", "sourceId": "p1",
                "title": "t", "bodyHtml": "<p>x</p>",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        let folder = root.path().join(created["rootPath"].as_str().unwrap());
        std::fs::write(root.path().join("source.zip"), b"PK").unwrap();
        let attached = host
            .attach_post_file(&serde_json::json!({
                "postId": post_id,
                "sourcePath": "source.zip",
                "name": "source.zip",
                "role": "attachment",
                "mime": "application/zip"
            }))
            .unwrap();
        assert_eq!(attached["bytes"], 2);
        assert!(folder.join("source.zip").exists());

        // Same bytes under another name are not stored twice.
        let duplicate = host
            .attach_post_file(&serde_json::json!({
                "postId": post_id, "sourcePath": "source.zip",
                "name": "copy.zip", "role": "attachment", "mime": "application/zip"
            }))
            .unwrap();
        assert_eq!(duplicate["duplicateOf"], "source.zip");

        host.delete_post_file(&post_id, "source.zip").unwrap();
        assert!(!folder.join("source.zip").exists());
        let post = host.get_post(&post_id).unwrap();
        assert_eq!(post["files"][0]["status"], "missing");

        host.delete_post(&post_id).unwrap();
        assert!(!folder.exists(), "post folder is removed");
    }

    #[test]
    fn attach_rejects_name_that_escapes_the_post_folder() {
        // `name` is a client-supplied display name, so a traversal attempt must
        // never create bytes next to the post instead of inside it.
        let root = TempRoot::new("attach-escape");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "creation", "provider": "patreon", "sourceId": "esc",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        let folder = root.path().join(created["rootPath"].as_str().unwrap());
        std::fs::write(root.path().join("evil-src.zip"), b"PK").unwrap();

        let outcome = host.attach_post_file(&serde_json::json!({
            "postId": post_id,
            "sourcePath": "evil-src.zip",
            "name": "../../evil.zip",
            "role": "attachment",
            "mime": "application/zip"
        }));
        // Either outcome is acceptable; escaping is not.
        let outside = folder.parent().unwrap().parent().unwrap().join("evil.zip");
        assert!(!outside.exists(), "wrote outside the post folder: {}", outside.display());
        assert!(!root.path().join("evil.zip").exists(), "wrote to the source root");
        if let Ok(attached) = outcome {
            let rel = attached["relPath"].as_str().unwrap().to_string();
            // One segment, and no `..` component: dots inside the name are fine.
            assert!(!rel.contains('/') && !rel.contains('\\'), "relPath is a single segment: {rel}");
            assert!(
                !rel.split(['/', '\\']).any(|part| part == ".."),
                "relPath keeps no traversal: {rel}"
            );
            assert!(folder.join(&rel).exists(), "file landed inside the post folder");
        }
    }

    #[test]
    fn attach_rejects_sidecar_and_invalid_role() {
        let root = TempRoot::new("attach-sidecar");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": "m1",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        std::fs::write(root.path().join("evil.html"), b"<p>x</p>").unwrap();
        let error = host
            .attach_post_file(&serde_json::json!({
                "postId": post_id, "sourcePath": "evil.html",
                "name": SIDECAR_DIR, "role": "attachment"
            }))
            .unwrap_err();
        assert_eq!(error.code_or_internal(), "EPATHDENIED", "{error:?}");
        // The role is checked before the bytes are copied, so the sheet's CHECK
        // constraint can never turn into a 500 with an orphan file on disk.
        let error = host
            .attach_post_file(&serde_json::json!({
                "postId": post_id, "sourcePath": "evil.html",
                "name": "evil.html", "role": "primary"
            }))
            .unwrap_err();
        assert_eq!(error.code_or_internal(), "EBADREQUEST", "{error:?}");
    }

    #[test]
    fn delete_post_prunes_empty_creator_directory() {
        // Deleting the last post of a creator must not leave an empty
        // `<category>/<provider>/<creator>` skeleton behind, but the category
        // root itself is the library's top level and stays.
        let root = TempRoot::new("prune");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "creation", "provider": "patreon", "sourceId": "only",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u9", "name": "OnlyCreator" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        let creator_dir = root.path().join("creations/patreon/OnlyCreator");
        assert!(creator_dir.exists());

        host.delete_post(&post_id).unwrap();
        assert!(!creator_dir.exists(), "creator directory is pruned");
        assert!(root.path().join("Creations").exists(), "the category root survives");
    }

    #[test]
    fn delete_post_refuses_a_row_whose_root_path_is_not_a_post_folder() {
        // Rows written before the C1 fix can hold `''`, `'.'`, the source root or
        // another category's folder. `delete_post` turns `root_path` into
        // `remove_dir_all`, so every one of them must be refused *and* leave the
        // tree untouched.
        let root = TempRoot::new("delete-guard");
        let mut host = test_host(root.path());
        std::fs::create_dir_all(root.path().join("RJ000001")).unwrap();
        std::fs::write(root.path().join("RJ000001/track01.mp3"), b"audio").unwrap();
        std::fs::create_dir_all(root.path().join("creations/Patreon/C/post [1]")).unwrap();
        std::fs::write(root.path().join("creations/Patreon/C/post [1]/a.jpg"), b"img").unwrap();

        for (tag, root_path) in [
            ("empty", ""),
            ("dot", "."),
            ("category", "Videos"),
            ("parent", "videos/.."),
            ("audio", "RJ000001"),
            ("other-category", "creations/Patreon/C/post [1]"),
            ("nested", "videos/../creations/Patreon/C/post [1]"),
        ] {
            let post_id = format!("legacy-{tag}");
            host.library
                .connection
                .execute(
                    "INSERT INTO post(post_id, category, provider, source_id, root_path, created_at, updated_at)
                     VALUES (?, 'video', 'youtube', ?, ?, 'now', 'now')",
                    rusqlite::params![post_id, tag, root_path],
                )
                .unwrap();
            let error = host.delete_post(&post_id).unwrap_err();
            assert_eq!(error.code_or_internal(), "EPATHDENIED", "{tag}: {error:?}");
            assert!(root.path().join("RJ000001/track01.mp3").exists(), "{tag}: audio work survived");
            assert!(
                root.path().join("creations/Patreon/C/post [1]/a.jpg").exists(),
                "{tag}: creation survived"
            );
        }
    }

    #[test]
    fn import_ignores_the_client_root_path() {
        // The payload's `rootPath` used to be written verbatim; a client choosing
        // `"."` or another category's folder turned the next delete into a wipe.
        let root = TempRoot::new("ignore-root");
        let mut host = test_host(root.path());
        for (index, supplied) in ["", ".", "Videos", "videos/..", "RJ000001", ".monochrome"].iter().enumerate() {
            let outcome = host
                .import_post(&serde_json::json!({
                    "category": "video", "provider": "youtube", "sourceId": format!("c{index}"),
                    "title": "t", "bodyText": "x", "rootPath": supplied,
                    "creator": { "sourceId": "u1", "name": "c" }
                }))
                .unwrap();
            let stored = outcome["rootPath"].as_str().unwrap();
            assert!(stored.starts_with("videos/youtube/c/"), "{supplied:?} -> {stored}");
            assert_eq!(validated_post_root("video", stored).unwrap(), stored);
        }
    }

    #[test]
    fn import_rejects_before_creating_a_folder() {
        // A refused import must not leave an empty `<Category>/<Provider>/…`
        // skeleton behind for the user to clean up.
        let root = TempRoot::new("reject-early");
        let mut host = test_host(root.path());
        for input in [
            serde_json::json!({ "category": "video", "provider": "", "sourceId": "x", "title": "t" }),
            serde_json::json!({ "category": "video", "provider": "youtube", "sourceId": "", "title": "t" }),
            serde_json::json!({ "category": "music", "provider": "youtube", "sourceId": "x", "title": "t" }),
        ] {
            assert!(host.import_post(&input).is_err(), "{input}");
        }
        let entries: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name != "lib")
            .collect();
        assert!(entries.is_empty(), "left behind: {entries:?}");
    }

    #[test]
    fn reimport_after_rename_keeps_the_folder_and_its_files() {
        // C1 + I3: the row's folder is named after the metadata, so a re-import
        // with a corrected title (or creator) must keep the folder its files
        // already live in — otherwise `/media/<fileId>` resolves to a path that
        // no longer exists.
        let root = TempRoot::new("rename");
        let mut host = test_host(root.path());
        let first = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": "same",
                "title": "Old", "publishedAt": "2026-02-10T00:00:00.000Z", "bodyText": "x",
                "creator": { "sourceId": "ch", "name": "Chan" }
            }))
            .unwrap();
        let post_id = first["postId"].as_str().unwrap().to_string();
        std::fs::write(root.path().join("v.mp4"), b"video-bytes").unwrap();
        host.attach_post_file(&serde_json::json!({
            "postId": post_id, "sourcePath": "v.mp4", "name": "v.mp4", "role": "video", "mime": "video/mp4"
        }))
        .unwrap();

        let second = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": "same",
                "title": "New", "publishedAt": "2026-02-10T00:00:00.000Z", "bodyText": "y",
                "creator": { "sourceId": "ch", "name": "Renamed Channel" }
            }))
            .unwrap();
        assert_eq!(second["rootPath"], first["rootPath"], "folder is stable across a rename");
        assert_eq!(second["postId"], post_id);
        let post = host.get_post(&post_id).unwrap();
        assert_eq!(post["title"], "New");
        // The file is still addressable through the row's own folder.
        let folder = post_folder_of(&host, &post).unwrap();
        assert!(folder.join("v.mp4").exists(), "{} lost its file", folder.display());
        let rel = post["files"][0]["relPath"].as_str().unwrap();
        assert!(folder.join(rel).exists());
    }

    #[test]
    fn reattach_after_delete_restores_the_file() {
        // I4: de-duplication matched any row with the same sha256, including one
        // a delete had marked missing, so the bytes could never come back.
        let root = TempRoot::new("reattach");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": "re",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        let folder = root.path().join(created["rootPath"].as_str().unwrap());
        std::fs::write(root.path().join("clip.mp4"), b"same-bytes").unwrap();

        host.attach_post_file(&serde_json::json!({
            "postId": post_id, "sourcePath": "clip.mp4", "name": "clip.mp4", "role": "video"
        }))
        .unwrap();
        host.delete_post_file(&post_id, "clip.mp4").unwrap();
        assert!(!folder.join("clip.mp4").exists());

        let again = host
            .attach_post_file(&serde_json::json!({
                "postId": post_id, "sourcePath": "clip.mp4", "name": "clip.mp4", "role": "video"
            }))
            .unwrap();
        assert!(again.get("duplicateOf").is_none(), "{again}");
        assert!(folder.join("clip.mp4").exists(), "the bytes are back");
        let post = host.get_post(&post_id).unwrap();
        let row = post["files"].as_array().unwrap().iter().find(|f| f["relPath"] == "clip.mp4").unwrap();
        assert_eq!(row["status"], "local");
    }

    #[test]
    fn revived_post_does_not_claim_files_that_are_gone() {
        // I5: deleting a post removes its folder, but the file rows stayed
        // `local`; a re-import then revived a post whose files 404 on click.
        let root = TempRoot::new("revive");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": "rv",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        std::fs::write(root.path().join("clip.mp4"), b"bytes").unwrap();
        host.attach_post_file(&serde_json::json!({
            "postId": post_id, "sourcePath": "clip.mp4", "name": "clip.mp4", "role": "video"
        }))
        .unwrap();

        host.delete_post(&post_id).unwrap();
        host.import_post(&serde_json::json!({
            "category": "video", "provider": "youtube", "sourceId": "rv",
            "title": "t", "bodyText": "x",
            "creator": { "sourceId": "u1", "name": "c" }
        }))
        .unwrap();
        let revived = host.get_post(&post_id).unwrap();
        let file = &revived["files"][0];
        assert_eq!(file["status"], "missing", "{revived}");
    }

    /// `MONOCHROME_VIDEO_FETCHER` is process-wide and `cargo test` runs tests on
    /// several threads, so every test that reads or writes it serializes here.
    static FETCHER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Clears the variables on drop so a failing assertion cannot leak a
    /// configured fetcher into whichever test takes the lock next.
    struct FetcherEnv;

    impl FetcherEnv {
        fn set(program: &Path, timeout_ms: Option<u64>) -> Self {
            std::env::set_var("MONOCHROME_VIDEO_FETCHER", program);
            match timeout_ms {
                Some(ms) => std::env::set_var("MONOCHROME_VIDEO_FETCHER_TIMEOUT_MS", ms.to_string()),
                None => std::env::remove_var("MONOCHROME_VIDEO_FETCHER_TIMEOUT_MS"),
            }
            FetcherEnv
        }
    }

    impl Drop for FetcherEnv {
        fn drop(&mut self) {
            std::env::remove_var("MONOCHROME_VIDEO_FETCHER");
            std::env::remove_var("MONOCHROME_VIDEO_FETCHER_TIMEOUT_MS");
        }
    }

    #[test]
    fn fetch_without_fetcher_reports_not_configured() {
        let _guard = FETCHER_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        std::env::remove_var("MONOCHROME_VIDEO_FETCHER");
        let root = TempRoot::new("fetch-none");
        let host = test_host(root.path());
        let error = host
            .prepare_fetch(&serde_json::json!({ "url": "https://example.invalid/v" }))
            .unwrap_err();
        assert_eq!(error.code, Some("ENOTCONFIGURED"));
    }

    /// Write a stand-in downloader that obeys the fetcher contract: it writes
    /// the file straight into the post folder (argument 2) and prints the JSON
    /// result as its last stdout line, after some noise a real tool would emit.
    ///
    /// `rel` is the path relative to the folder; `sleep_ms` makes it hang so a
    /// timeout test can observe the kill.
    fn write_fake_fetcher(dir: &Path, rel: &str, sleep_ms: Option<u64>) -> PathBuf {
        let body_sleep = sleep_ms.map(|ms| format!("ping -n {n} 127.0.0.1 >nul\r\n", n = ms / 1000 + 2)).unwrap_or_default();
        #[cfg(windows)]
        {
            let script = dir.join("fake-fetcher.cmd");
            std::fs::write(
                &script,
                format!(
                    "@echo off\r\necho downloading %1\r\n{body_sleep}\
                     if not exist \"%~2\\{parent}\" mkdir \"%~2\\{parent}\"\r\n\
                     echo test> \"%~2\\{rel}\"\r\n\
                     echo {{\"ok\":true,\"file\":\"{rel}\",\"bytes\":4,\"mime\":\"video/mp4\"}}\r\n",
                    parent = Path::new(rel).parent().map(|parent| parent.to_string_lossy().to_string()).unwrap_or_default(),
                ),
            )
            .unwrap();
            script
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("fake-fetcher.sh");
            let sleep_s = sleep_ms.map(|ms| format!("sleep {}\n", (ms as f64) / 1000.0)).unwrap_or_default();
            std::fs::write(
                &script,
                format!(
                    "#!/bin/sh\necho \"downloading $1\"\n{sleep_s}\
                     mkdir -p \"$2/{parent}\"\necho test > \"$2/{rel}\"\n\
                     echo '{{\"ok\":true,\"file\":\"{rel}\",\"bytes\":4,\"mime\":\"video/mp4\"}}'\n",
                    parent = Path::new(rel).parent().map(|parent| parent.to_string_lossy().to_string()).unwrap_or_default(),
                ),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        }
    }

    /// Import one video post and return its id and folder.
    fn video_post(host: &mut Host, root: &Path, source_id: &str) -> (String, PathBuf) {
        let created = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": source_id,
                "title": "clip", "bodyText": "x",
                "creator": { "sourceId": "ch1", "name": "Channel" }
            }))
            .unwrap();
        let folder = root.join(created["rootPath"].as_str().unwrap());
        (created["postId"].as_str().unwrap().to_string(), folder)
    }

    #[test]
    fn fetcher_receives_url_and_folder_and_reports_success() {
        // The fetcher writes into the post folder itself, so the attach step's
        // copy source and target are the same file. That must register the row
        // instead of failing (Windows refuses copying a file onto itself).
        let _guard = FETCHER_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let root = TempRoot::new("fetcher");
        let tools = TempRoot::new("fetcher-bin");
        let _env = FetcherEnv::set(&write_fake_fetcher(tools.path(), "video.mp4", None), None);
        let mut host = test_host(root.path());
        let (post_id, folder) = video_post(&mut host, root.path(), "v1");

        let fetched = fetch_video(&mut host, &serde_json::json!({ "postId": post_id, "url": "https://example.invalid/watch?v=1" }))
            .unwrap();
        assert_eq!(fetched["relPath"], "video.mp4", "{fetched}");
        assert!(folder.join("video.mp4").exists());
        let post = host.get_post(&post_id).unwrap();
        let video = post["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["role"] == "video")
            .cloned()
            .unwrap_or_else(|| panic!("no video row: {post}"));
        assert_eq!(video["relPath"], "video.mp4");
        assert_eq!(video["mime"], "video/mp4");
        assert_eq!(video["remoteUrl"], "https://example.invalid/watch?v=1");
        assert_eq!(video["status"], "local");
    }

    #[test]
    fn fetcher_file_in_a_subdirectory_is_registered_not_copied() {
        // M5: a downloader that writes `sub/v.mp4` must not cost the bytes
        // twice (one copy in `sub/`, one flattened at the folder top).
        let _guard = FETCHER_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let root = TempRoot::new("fetcher-sub");
        let tools = TempRoot::new("fetcher-sub-bin");
        let _env = FetcherEnv::set(&write_fake_fetcher(tools.path(), "sub/v.mp4", None), None);
        let mut host = test_host(root.path());
        let (post_id, folder) = video_post(&mut host, root.path(), "v2");

        let fetched = fetch_video(&mut host, &serde_json::json!({ "postId": post_id, "url": "https://example.invalid/v" }))
            .unwrap();
        assert_eq!(fetched["relPath"], "sub/v.mp4", "{fetched}");
        assert!(folder.join("sub").join("v.mp4").exists());
        assert!(!folder.join("v.mp4").exists(), "no flattened duplicate");
    }

    #[test]
    fn fetcher_that_hangs_is_killed_at_the_timeout() {
        // I2: without a bound, a wedged downloader held the host lock — and with
        // it every `/api/*` and `/media/*` request — forever.
        let _guard = FETCHER_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let root = TempRoot::new("fetcher-timeout");
        let tools = TempRoot::new("fetcher-timeout-bin");
        // 5 s of sleep against a 300 ms budget: the test fails fast when the fix
        // is missing, because the whole `fetch_video` would block for 5 s.
        let _env = FetcherEnv::set(&write_fake_fetcher(tools.path(), "video.mp4", Some(5000)), Some(300));
        let mut host = test_host(root.path());
        let (post_id, _folder) = video_post(&mut host, root.path(), "v3");

        let started = std::time::Instant::now();
        let error = fetch_video(&mut host, &serde_json::json!({ "postId": post_id, "url": "https://example.invalid/v" }))
            .unwrap_err();
        assert_eq!(error.code, Some("ETIMEOUT"), "{error:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(4), "killed at the deadline: {:?}", started.elapsed());
        assert!(host.get_post(&post_id).unwrap()["files"].as_array().unwrap().is_empty());
    }

    #[test]
    fn fetch_validates_the_folder_before_running_the_downloader() {
        // The downloader is an external program: a post row that fails the folder
        // check must never reach it.
        let _guard = FETCHER_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let root = TempRoot::new("fetcher-guard");
        let tools = TempRoot::new("fetcher-guard-bin");
        let marker = tools.path().join("ran.marker");
        let script = tools.path().join("marker-fetcher.cmd");
        #[cfg(windows)]
        std::fs::write(&script, format!("@echo off\r\necho ran> \"{}\"\r\n", marker.display())).unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&script, format!("#!/bin/sh\necho ran > '{}'\n", marker.display())).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _env = FetcherEnv::set(&script, None);
        let host = test_host(root.path());
        host.library
            .connection
            .execute(
                "INSERT INTO post(post_id, category, provider, source_id, root_path, created_at, updated_at)
                 VALUES ('bad', 'video', 'youtube', 'x', '', 'now', 'now')",
                [],
            )
            .unwrap();
        let error = host.prepare_fetch(&serde_json::json!({ "postId": "bad", "url": "https://example.invalid/v" })).unwrap_err();
        assert_eq!(error.code_or_internal(), "EPATHDENIED");
        assert!(!marker.exists(), "the downloader was not started");
    }

    #[test]
    fn cache_post_remote_file_rejects_non_http() {
        // Must fail before any socket or file is opened: a `file://` URL would
        // otherwise turn the importer into a local-file reader.
        let root = TempRoot::new("cache");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "creation", "provider": "patreon", "sourceId": "c1",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        let folder = root.path().join(created["rootPath"].as_str().unwrap());
        let outcome = host.cache_post_remote_file(&post_id, "file:///x", "thumb.jpg", "thumbnail");
        assert!(outcome.is_err());
        assert!(!folder.join("thumb.jpg").exists());
        assert!(host.get_post(&post_id).unwrap()["files"].as_array().unwrap().is_empty());
    }

    #[test]
    fn cache_post_remote_file_rejects_unknown_role_before_downloading() {
        let root = TempRoot::new("cache-role");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": "c2",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        let error = host
            .cache_post_remote_file(&post_id, "https://example.invalid/t.jpg", "thumb.jpg", "assets")
            .unwrap_err();
        assert_eq!(error.code_or_internal(), "EBADREQUEST", "{error:?}");
    }

    #[test]
    fn resolve_in_refuses_escaping_paths() {
        // A post file path arrives from the frontend/HTTP layer, so it is
        // untrusted: `..` segments, absolute paths and Windows drive-relative
        // paths must never resolve to a sibling post or to an arbitrary file.
        // `folder.join("C:victim.txt")` *replaces* the folder, which is why the
        // per-segment validation exists on top of the `..` check.
        let folder = std::path::Path::new("C:/lib/creations/p/c/post");
        for bad in [
            "../x",
            "/abs",
            "a/../../x",
            "C:victim.txt",
            "x:stream",
            ".monochrome/post.html",
            ".MONOCHROME/post.html",
            "./.monochrome/metadata.json",
            "con.txt",
            "trailing.",
            "",
        ] {
            let error = resolve_in(folder, bad).unwrap_err();
            assert_eq!(error.code_or_internal(), "EPATHDENIED", "{bad:?} resolved");
        }
        assert_eq!(resolve_in(folder, "sub/v.mp4").unwrap(), folder.join("sub").join("v.mp4"));
        assert_eq!(resolve_in(folder, "./v.mp4").unwrap(), folder.join("v.mp4"));
    }

    #[test]
    fn delete_post_file_refuses_drive_relative_paths_and_keeps_the_file() {
        // I1 end-to-end: `relPath: "C:victim.txt"` used to unlink a file in the
        // C: drive's working directory before the row was even looked up.
        let root = TempRoot::new("delete-asset");
        let mut host = test_host(root.path());
        let created = host
            .import_post(&serde_json::json!({
                "category": "video", "provider": "youtube", "sourceId": "da",
                "title": "t", "bodyText": "x",
                "creator": { "sourceId": "u1", "name": "c" }
            }))
            .unwrap();
        let post_id = created["postId"].as_str().unwrap().to_string();
        let folder = root.path().join(created["rootPath"].as_str().unwrap());
        std::fs::write(root.path().join("keep.txt"), b"keep").unwrap();
        std::fs::write(folder.join("v.mp4"), b"video").unwrap();
        storage_core::posts::insert_file(
            &host.library.connection,
            &post_id,
            &json!({ "role": "video", "relPath": "v.mp4" }),
            "now",
        )
        .unwrap();

        for bad in ["C:victim.txt", "x:stream", ".monochrome/post.html", "../x", "unregistered.txt"] {
            // `unregistered.txt` is refused by "only delete a registered file",
            // the rest by the path gate; both are `Ok(false)`/error, never a
            // deletion.
            let outcome = host.delete_post_file(&post_id, bad);
            match outcome {
                Ok(deleted) => assert!(!deleted, "{bad:?} was reported as deleted"),
                Err(error) => assert_eq!(error.code_or_internal(), "EPATHDENIED", "{bad:?}"),
            }
        }
        assert!(root.path().join("keep.txt").exists());
        assert!(folder.join("v.mp4").exists(), "the post's own file is untouched");
        assert!(folder.join(".monochrome/post.html").exists(), "the sidecar survives");
        // The legitimate path still works.
        assert!(host.delete_post_file(&post_id, "v.mp4").unwrap());
        assert!(!folder.join("v.mp4").exists());
    }

    #[test]
    fn validated_post_root_accepts_only_four_confined_segments() {
        let ok = "videos/YouTube/Chan/2026-01-01 clip [abc]";
        assert_eq!(validated_post_root("video", ok).unwrap(), ok);
        for bad in [
            "",
            ".",
            "..",
            "Videos",
            "videos/..",
            "videos/YouTube/Chan",
            "videos/YouTube/Chan/a/b",
            "creations/YouTube/Chan/x",
            "videos//Chan/x",
            "videos/YouTube/./x",
            "videos/YouTube/../x",
            "Videos\\YouTube\\Chan\\x",
            "videos/YouTube/C:han/x",
            "videos/YouTube/con/x",
        ] {
            assert!(validated_post_root("video", bad).is_err(), "{bad:?} was accepted");
        }
    }
}
