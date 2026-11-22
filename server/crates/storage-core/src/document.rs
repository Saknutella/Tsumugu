//! Work document text plus local document assets (`document.mjs`, C79-05).
//!
//! Document images live in CAS (`data/assets/sha256/<ab>/<hash>`) and are related
//! through `document_asset_ref`, not through `entry`. One failed asset records a
//! `missing` manifest item and leaves the successful assets and the text
//! committed: a 20-image post must not lose its text because one image is gone,
//! and a retry must be able to try only the missing ones.
//!
//! Local files only. There is no remote fetch here — the download pipeline is a
//! separate module, and mixing them would make this path depend on the network.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::hash::{copy_to_temp_and_hash, hash_file, sha256_text};
use crate::jsonutil::{now_iso, parse_or};
use crate::paths::{self, validate_logical_path};

/// MIME guess for document assets when the caller sends none.
fn mime_for(asset: &Map<String, Value>) -> String {
    if let Some(Value::String(mime)) = asset.get("mime") {
        if !mime.is_empty() {
            return mime.clone();
        }
    }
    let candidate = asset
        .get("sourcePath")
        .or_else(|| asset.get("logicalPath"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let extension = candidate.rsplit('.').next().unwrap_or("").to_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn resource_id_for(asset: &Map<String, Value>, index: usize) -> String {
    for key in ["resourceId", "id", "logicalPath"] {
        if let Some(Value::String(value)) = asset.get(key) {
            if !value.is_empty() {
                return value.clone();
            }
        }
    }
    format!("document-asset-{index}")
}

fn text_field(asset: &Map<String, Value>, key: &str, fallback: &str) -> String {
    match asset.get(key) {
        Some(Value::String(value)) => value.clone(),
        _ => fallback.to_string(),
    }
}

/// Canonical plan used for the document plan hash.
///
/// Must match `canonicalPlan()` key-for-key: the hash is persisted, and a
/// mismatch would make a retried save look like a changed plan.
fn canonical_plan(payload: &Map<String, Value>) -> Value {
    let assets = match payload.get("assets") {
        Some(Value::Array(items)) => Value::Array(
            items
                .iter()
                .map(|item| {
                    let object = item.as_object();
                    let pick = |key: &str| {
                        object
                            .and_then(|map| map.get(key))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    };
                    let mut map = Map::new();
                    let resource_id = {
                        let candidate = pick("resourceId");
                        if candidate.is_empty() {
                            let fallback_id = pick("id");
                            if fallback_id.is_empty() { pick("logicalPath") } else { fallback_id }
                        } else {
                            candidate
                        }
                    };
                    map.insert("resourceId".into(), json!(resource_id));
                    map.insert("logicalPath".into(), json!(pick("logicalPath")));
                    map.insert("sourcePath".into(), json!(pick("sourcePath")));
                    map.insert("mime".into(), json!(pick("mime")));
                    let role = pick("role");
                    map.insert("role".into(), json!(if role.is_empty() { "body".to_string() } else { role }));
                    Value::Object(map)
                })
                .collect(),
        ),
        _ => Value::Null,
    };
    let optional_string = |key: &str| match payload.get(key) {
        None => Value::Null,
        Some(value) => json!(crate::jsonutil::string_of(value)),
    };
    let mut map = Map::new();
    map.insert("introText".into(), optional_string("introText"));
    map.insert("bodyText".into(), optional_string("bodyText"));
    map.insert("sourceUrl".into(), optional_string("sourceUrl"));
    map.insert("sourceRevision".into(), optional_string("sourceRevision"));
    map.insert("assets".into(), assets);
    Value::Object(map)
}

/// Parse the stored asset manifest, degrading to empty on malformed JSON.
fn parse_manifest(value: Option<&str>) -> Vec<Value> {
    match parse_or(value, Value::Array(Vec::new())) {
        Value::Array(items) => items,
        _ => Vec::new(),
    }
}

/// Copy one document asset into CAS and return its manifest entry.
fn copy_document_asset(
    data_root: &Path,
    asset: &Map<String, Value>,
    index: usize,
) -> Result<Value> {
    let resource_id = resource_id_for(asset, index);
    let source_path = text_field(asset, "sourcePath", "");
    if source_path.is_empty() || !Path::new(&source_path).is_absolute() {
        return Err(Error::new("sourcePath must be an absolute path"));
    }
    let absolute = paths::resolve_lexical(Path::new(&source_path));
    if paths::assert_no_reparse(&absolute, false).is_err() {
        return Err(Error::new("sourcePath is a symlink/junction"));
    }
    let info = std::fs::metadata(&absolute)?;
    if !info.is_file() {
        return Err(Error::new("sourcePath is not a regular file"));
    }
    let logical = text_field(asset, "logicalPath", "");
    let logical = if logical.is_empty() {
        absolute
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        logical
    };
    let logical_path = validate_logical_path(&logical)?;

    let temp = data_root
        .join("tmp")
        .join(format!("document-{}-{index}.part", uuid::Uuid::new_v4()));
    if let Some(parent) = temp.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let (sha256, bytes) = copy_to_temp_and_hash(&absolute, &temp, false, None)?;
    let rel_path = format!("assets/sha256/{}/{}", &sha256[..2], sha256);
    let destination = data_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !paths::is_inside(&data_root.join("assets"), &destination) {
        let _ = std::fs::remove_file(&temp);
        return Err(Error::new("document asset escaped CAS"));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if destination.exists() {
        let (existing_hash, existing_bytes) = hash_file(&destination)?;
        if existing_hash != sha256 || existing_bytes != bytes {
            let _ = std::fs::remove_file(&temp);
            return Err(Error::new("document CAS collision/corruption"));
        }
        let _ = std::fs::remove_file(&temp);
    } else {
        // Same volume rename publishes atomically; a crash leaves the .part file
        // for the next saveWorkDocument retry to replace.
        std::fs::rename(&temp, &destination)?;
    }

    let role = {
        let value = text_field(asset, "role", "body");
        if value.is_empty() { "body".to_string() } else { value }
    };
    Ok(json!({
        "resourceId": resource_id,
        "logicalPath": logical_path,
        "sourcePath": absolute.to_string_lossy(),
        "mime": mime_for(asset),
        "role": role,
        "assetId": sha256,
        "sha256": sha256,
        "bytes": bytes,
        "relPath": rel_path,
        "status": "ready",
    }))
}

/// Row fields of `work_document` the summary needs.
struct DocumentRow {
    work_id: String,
    intro_text: String,
    body_text: String,
    source_url: String,
    source_revision: String,
    media_state: String,
    document_revision: i64,
    asset_manifest_json: String,
    last_idempotency_key: Option<String>,
    last_plan_hash: Option<String>,
}

fn read_document_row(connection: &Connection, work_id: &str) -> Result<Option<DocumentRow>> {
    let row = connection
        .query_row("SELECT * FROM work_document WHERE work_id = ?", rusqlite::params![work_id], |row| {
            Ok(DocumentRow {
                work_id: row.get("work_id")?,
                intro_text: row.get("intro_text")?,
                body_text: row.get("body_text")?,
                source_url: row.get("source_url")?,
                source_revision: row.get("source_revision")?,
                media_state: row.get("media_state")?,
                document_revision: row.get("document_revision")?,
                asset_manifest_json: row.get("asset_manifest_json")?,
                last_idempotency_key: row.get("last_idempotency_key")?,
                last_plan_hash: row.get("last_plan_hash")?,
            })
        })
        .optional()?;
    Ok(row)
}

fn summary(row: &DocumentRow, revision: i64, idempotent: bool) -> Value {
    let manifest = parse_manifest(Some(&row.asset_manifest_json));
    let missing: Vec<&Value> = manifest
        .iter()
        .filter(|entry| entry.get("status").and_then(Value::as_str) == Some("missing"))
        .collect();
    let ready = manifest
        .iter()
        .filter(|entry| entry.get("status").and_then(Value::as_str) == Some("ready"))
        .count();
    json!({
        "workId": row.work_id,
        "revision": revision,
        "documentRevision": row.document_revision,
        "mediaState": row.media_state,
        "complete": row.media_state == "complete",
        "partial": row.media_state == "partial",
        "assets": manifest,
        "missing": missing,
        "counts": { "ready": ready, "missing": missing.len() },
        "idempotent": idempotent,
        "planHash": row.last_plan_hash,
    })
}

/// Save or refresh a work document.
///
/// Text/source fields are preserved when omitted. Assets are local only; a failed
/// copy becomes a `missing` manifest item while successful assets and the text
/// are committed in the same transaction.
pub fn save_work_document(
    connection: &Connection,
    library_id: &str,
    data_root: &Path,
    work_id: &str,
    payload: &Map<String, Value>,
    idempotency_key: Option<&str>,
) -> Result<Value> {
    let work: Option<(String, i64)> = connection
        .query_row(
            "SELECT work_id, revision FROM work WHERE work_id = ?",
            rusqlite::params![work_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((work_id, work_revision)) = work else {
        return Err(Error::not_found("work not found"));
    };
    let existing = read_document_row(connection, &work_id)?;
    let idempotency_key = idempotency_key
        .map(str::to_string)
        .or_else(|| payload.get("idempotencyKey").and_then(Value::as_str).map(str::to_string));
    let plan_hash = sha256_text(&serde_json::to_string(&canonical_plan(payload)).unwrap_or_default());

    if let (Some(key), Some(row)) = (&idempotency_key, &existing) {
        if row.last_idempotency_key.as_deref() == Some(key.as_str()) && row.media_state != "partial" {
            if let Some(previous_hash) = &row.last_plan_hash {
                if previous_hash != &plan_hash {
                    return Err(Error::coded(
                        "EDOCUMENTCONFLICT",
                        "document idempotency key reused with a changed plan",
                    ));
                }
            }
            return Ok(summary(row, work_revision, true));
        }
        // A partial document with the same key is a retry: fall through even when
        // the caller passes only the missing assets.
    }

    let requested_assets: Option<Vec<Map<String, Value>>> = payload.get("assets").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_object().cloned())
            .collect()
    });

    let mut ready: Vec<Value> = Vec::new();
    let mut failures: Vec<Value> = Vec::new();
    if let Some(assets) = &requested_assets {
        for (index, asset) in assets.iter().enumerate() {
            match copy_document_asset(data_root, asset, index) {
                Ok(entry) => ready.push(entry),
                Err(error) => {
                    // Hoisted: a block expression is not valid in `json!` value
                    // position (it would parse as an object literal).
                    let fallback_role = text_field(asset, "role", "body");
                    let role = if fallback_role.is_empty() { "body".to_string() } else { fallback_role };
                    failures.push(json!({
                        "resourceId": resource_id_for(asset, index),
                        "logicalPath": text_field(asset, "logicalPath", ""),
                        "sourcePath": text_field(asset, "sourcePath", ""),
                        "mime": text_field(asset, "mime", ""),
                        "role": role,
                        "status": "missing",
                        "error": error.message,
                    }))
                }
            }
        }
    }

    let mut merged: BTreeMap<String, Value> = BTreeMap::new();
    for entry in parse_manifest(existing.as_ref().map(|row| row.asset_manifest_json.as_str())) {
        let resource_id = entry
            .get("resourceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        merged.insert(resource_id, entry);
    }
    for entry in &ready {
        let resource_id = entry["resourceId"].as_str().unwrap_or("").to_string();
        merged.insert(
            resource_id,
            json!({
                "resourceId": entry["resourceId"],
                "logicalPath": entry["logicalPath"],
                "mime": entry["mime"],
                "role": entry["role"],
                "status": "ready",
                "assetId": entry["assetId"],
                "sha256": entry["sha256"],
                "bytes": entry["bytes"],
                "relPath": entry["relPath"],
            }),
        );
    }
    for failure in failures {
        let resource_id = failure["resourceId"].as_str().unwrap_or("").to_string();
        // Never downgrade a previously ready resource that this retry did not pass.
        merged.entry(resource_id).or_insert(failure);
    }
    let manifest: Vec<Value> = merged.into_values().collect();
    let missing_count = manifest
        .iter()
        .filter(|entry| entry.get("status").and_then(Value::as_str) == Some("missing"))
        .count();
    let media_state = if requested_assets.is_none() && existing.is_none() {
        "not_requested"
    } else if missing_count > 0 {
        "partial"
    } else if !manifest.is_empty() {
        "complete"
    } else {
        "not_requested"
    };

    let timestamp = now_iso();
    let revision = work_revision + 1;
    connection.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> Result<()> {
        let pick = |key: &str, fallback: &str| -> String {
            match payload.get(key) {
                None => fallback.to_string(),
                Some(value) => crate::jsonutil::string_of(value),
            }
        };
        let intro_text = match payload.get("introText") {
            None => existing.as_ref().map(|row| row.intro_text.clone()).unwrap_or_default(),
            Some(_) => pick("introText", ""),
        };
        let body_text = match payload.get("bodyText") {
            None => existing.as_ref().map(|row| row.body_text.clone()).unwrap_or_default(),
            Some(_) => pick("bodyText", ""),
        };
        let source_url = match payload.get("sourceUrl") {
            None => existing.as_ref().map(|row| row.source_url.clone()).unwrap_or_default(),
            Some(_) => pick("sourceUrl", ""),
        };
        let source_revision = match payload.get("sourceRevision") {
            None => existing.as_ref().map(|row| row.source_revision.clone()).unwrap_or_default(),
            Some(_) => pick("sourceRevision", ""),
        };
        connection.execute(
            "INSERT INTO work_document(
                work_id, intro_text, body_text, source_url, source_revision,
                media_state, document_revision, asset_manifest_json,
                last_idempotency_key, last_plan_hash, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(work_id) DO UPDATE SET
                intro_text = excluded.intro_text,
                body_text = excluded.body_text,
                source_url = excluded.source_url,
                source_revision = excluded.source_revision,
                media_state = excluded.media_state,
                document_revision = excluded.document_revision,
                asset_manifest_json = excluded.asset_manifest_json,
                last_idempotency_key = excluded.last_idempotency_key,
                last_plan_hash = excluded.last_plan_hash,
                updated_at = excluded.updated_at",
            rusqlite::params![
                work_id,
                intro_text,
                body_text,
                source_url,
                source_revision,
                media_state,
                revision,
                serde_json::to_string(&manifest).unwrap_or_else(|_| "[]".to_string()),
                idempotency_key,
                plan_hash,
                timestamp
            ],
        )?;
        for asset in &ready {
            connection.execute(
                "INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    asset["assetId"].as_str().unwrap_or(""),
                    asset["sha256"].as_str().unwrap_or(""),
                    asset["bytes"].as_i64().unwrap_or(0),
                    asset["mime"].as_str().unwrap_or(""),
                    asset["relPath"].as_str().unwrap_or(""),
                    timestamp
                ],
            )?;
            let resource_id = asset["resourceId"].as_str().unwrap_or("");
            let current: Option<String> = connection
                .query_row(
                    "SELECT document_asset_ref_id FROM document_asset_ref WHERE work_id = ? AND resource_id = ?",
                    rusqlite::params![work_id, resource_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(reference_id) = current {
                connection.execute(
                    "UPDATE document_asset_ref SET asset_id = ?, logical_path = ?, role = ?, mime = ?, status = 'ready'
                     WHERE document_asset_ref_id = ?",
                    rusqlite::params![
                        asset["assetId"].as_str().unwrap_or(""),
                        asset["logicalPath"].as_str().unwrap_or(""),
                        asset["role"].as_str().unwrap_or("body"),
                        asset["mime"].as_str().unwrap_or(""),
                        reference_id
                    ],
                )?;
            } else {
                connection.execute(
                    "INSERT INTO document_asset_ref(
                        document_asset_ref_id, work_id, asset_id, resource_id, logical_path, role, mime, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)",
                    rusqlite::params![
                        format!("docref-{work_id}-{resource_id}"),
                        work_id,
                        asset["assetId"].as_str().unwrap_or(""),
                        resource_id,
                        asset["logicalPath"].as_str().unwrap_or(""),
                        asset["role"].as_str().unwrap_or("body"),
                        asset["mime"].as_str().unwrap_or(""),
                        timestamp
                    ],
                )?;
            }
        }
        connection.execute(
            "UPDATE work SET revision = ?, updated_at = ? WHERE work_id = ?",
            rusqlite::params![revision, timestamp, work_id],
        )?;
        connection.execute(
            "INSERT INTO snapshot_outbox(
                library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at
            ) VALUES (?, ?, ?, 0, 'pending', 0, ?)
            ON CONFLICT(library_id, work_id) DO UPDATE SET
                target_revision = MAX(target_revision, excluded.target_revision),
                status = 'pending',
                last_error = NULL,
                updated_at = excluded.updated_at",
            rusqlite::params![library_id, work_id, revision, timestamp],
        )?;
        Ok(())
    })();
    match outcome {
        Ok(()) => {
            connection.execute_batch("COMMIT")?;
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(error);
        }
    }

    let row = read_document_row(connection, &work_id)?.ok_or_else(|| Error::new("document vanished after save"))?;
    let mut result = summary(&row, revision, false);
    result["documentRevision"] = json!(revision);
    result["planHash"] = json!(plan_hash);
    Ok(result)
}

/// Read a document with its ready asset refs (`getWorkDocument`).
pub fn get_work_document(connection: &Connection, work_id: &str) -> Result<Option<Value>> {
    let row = match read_document_row(connection, work_id)? {
        Some(row) => row,
        None => return Ok(None),
    };
    let mut statement = connection.prepare(
        "SELECT d.*, a.sha256, a.bytes, a.rel_path, a.mime AS asset_mime
         FROM document_asset_ref d JOIN asset a ON a.asset_id = d.asset_id
         WHERE d.work_id = ? ORDER BY d.resource_id",
    )?;
    let refs: Vec<Value> = statement
        .query_map(rusqlite::params![work_id], |row| {
            Ok(json!({
                "documentAssetRefId": row.get::<_, String>("document_asset_ref_id")?,
                "workId": row.get::<_, String>("work_id")?,
                "assetId": row.get::<_, String>("asset_id")?,
                "resourceId": row.get::<_, String>("resource_id")?,
                "logicalPath": row.get::<_, String>("logical_path")?,
                "role": row.get::<_, String>("role")?,
                "mime": row.get::<_, Option<String>>("mime")?,
                "assetMime": row.get::<_, Option<String>>("asset_mime")?,
                "status": row.get::<_, String>("status")?,
                "sha256": row.get::<_, String>("sha256")?,
                "bytes": row.get::<_, i64>("bytes")?,
                "relPath": row.get::<_, String>("rel_path")?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(json!({
        "workId": row.work_id,
        "introText": row.intro_text,
        "bodyText": row.body_text,
        "sourceUrl": row.source_url,
        "sourceRevision": row.source_revision,
        "mediaState": row.media_state,
        "documentRevision": row.document_revision,
        "assetManifestJson": row.asset_manifest_json,
        "lastIdempotencyKey": row.last_idempotency_key,
        "lastPlanHash": row.last_plan_hash,
        "assets": parse_manifest(Some(&row.asset_manifest_json)),
        "refs": refs,
    })))
}

/// Convenience: the CAS path for a document asset rel path.
pub fn document_asset_path(data_root: &Path, rel_path: &str) -> PathBuf {
    data_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn fixture() -> (Connection, PathBuf, PathBuf, String) {
        let connection = Connection::open_in_memory().unwrap();
        schema::enable_pragmas(&connection).unwrap();
        schema::apply_schema(&connection, "lib").unwrap();
        connection
            .execute(
                "INSERT INTO work(work_id, title, circle, cv_json, revision, created_at, updated_at)
                 VALUES ('w', 'T', '', '[]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();
        let root = std::env::temp_dir().join(format!("mono-doc-{}", uuid::Uuid::new_v4()));
        let data_root = root.join("data");
        let source = root.join("source");
        std::fs::create_dir_all(&data_root).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("a.png"), b"png-bytes").unwrap();
        (connection, data_root, source, "w".to_string())
    }

    #[test]
    fn document_saves_text_and_ready_asset() {
        let (connection, data_root, source, work_id) = fixture();
        let mut payload = Map::new();
        payload.insert("introText".into(), json!("intro"));
        payload.insert("bodyText".into(), json!("body"));
        payload.insert(
            "assets".into(),
            json!([{ "resourceId": "r1", "logicalPath": "images/a.png", "sourcePath": source.join("a.png").to_string_lossy() }]),
        );
        let result = save_work_document(&connection, "lib", &data_root, &work_id, &payload, None).unwrap();
        assert_eq!(result["mediaState"], "complete");
        assert_eq!(result["counts"]["ready"], 1);
        let stored = get_work_document(&connection, &work_id).unwrap().unwrap();
        assert_eq!(stored["introText"], "intro");
        assert_eq!(stored["refs"].as_array().unwrap().len(), 1);
        // The CAS file exists at its content hash path.
        let rel = stored["assets"][0]["relPath"].as_str().unwrap();
        assert!(document_asset_path(&data_root, rel).exists());
    }

    #[test]
    fn missing_asset_records_partial_and_retry_keeps_ready() {
        let (connection, data_root, source, work_id) = fixture();
        let mut payload = Map::new();
        payload.insert(
            "assets".into(),
            json!([
                { "resourceId": "ok", "logicalPath": "a.png", "sourcePath": source.join("a.png").to_string_lossy() },
                { "resourceId": "gone", "logicalPath": "b.png", "sourcePath": source.join("missing.png").to_string_lossy() }
            ]),
        );
        let first = save_work_document(&connection, "lib", &data_root, &work_id, &payload, None).unwrap();
        assert_eq!(first["mediaState"], "partial");
        assert_eq!(first["counts"]["missing"], 1);

        // Retry with only the still-missing asset: the ready one must stay ready.
        let mut retry = Map::new();
        retry.insert(
            "assets".into(),
            json!([{ "resourceId": "gone", "logicalPath": "b.png", "sourcePath": source.join("missing.png").to_string_lossy() }]),
        );
        let second = save_work_document(&connection, "lib", &data_root, &work_id, &retry, None).unwrap();
        assert_eq!(second["counts"]["ready"], 1);
        assert_eq!(second["counts"]["missing"], 1);
    }

    #[test]
    fn text_is_preserved_when_omitted() {
        let (connection, data_root, _source, work_id) = fixture();
        let mut first_payload = Map::new();
        first_payload.insert("bodyText".into(), json!("keep me"));
        save_work_document(&connection, "lib", &data_root, &work_id, &first_payload, None).unwrap();

        let mut second_payload = Map::new();
        second_payload.insert("sourceUrl".into(), json!("https://example.invalid"));
        save_work_document(&connection, "lib", &data_root, &work_id, &second_payload, None).unwrap();
        let stored = get_work_document(&connection, &work_id).unwrap().unwrap();
        assert_eq!(stored["bodyText"], "keep me");
        assert_eq!(stored["sourceUrl"], "https://example.invalid");
    }

    #[test]
    fn idempotent_replay_and_changed_plan_conflict() {
        let (connection, data_root, source, work_id) = fixture();
        let mut payload = Map::new();
        payload.insert("bodyText".into(), json!("one"));
        payload.insert(
            "assets".into(),
            json!([{ "resourceId": "r", "logicalPath": "a.png", "sourcePath": source.join("a.png").to_string_lossy() }]),
        );
        let first = save_work_document(&connection, "lib", &data_root, &work_id, &payload, Some("key-1")).unwrap();
        assert_eq!(first["idempotent"], false);
        let replay = save_work_document(&connection, "lib", &data_root, &work_id, &payload, Some("key-1")).unwrap();
        assert_eq!(replay["idempotent"], true);

        let mut changed = payload.clone();
        changed.insert("bodyText".into(), json!("two"));
        let error = save_work_document(&connection, "lib", &data_root, &work_id, &changed, Some("key-1")).unwrap_err();
        assert_eq!(error.code, Some("EDOCUMENTCONFLICT"));
    }

    #[test]
    fn relative_source_path_is_rejected() {
        let (connection, data_root, _source, work_id) = fixture();
        let mut payload = Map::new();
        payload.insert(
            "assets".into(),
            json!([{ "resourceId": "r", "logicalPath": "a.png", "sourcePath": "relative/a.png" }]),
        );
        let result = save_work_document(&connection, "lib", &data_root, &work_id, &payload, None).unwrap();
        assert_eq!(result["mediaState"], "partial");
        assert!(result["missing"][0]["error"].as_str().unwrap().contains("absolute"));
    }
}
