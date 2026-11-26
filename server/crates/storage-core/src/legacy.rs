//! Staged legacy migration (`legacy.mjs`, S4b).
//!
//! Preserves the immutable legacy bundle, maps old voice/track IDs to new rows
//! and records remote URLs as `legacy_media_ref` placeholders. It never
//! downloads media, fabricates CAS assets, deletes the old bundle or touches any
//! file: the bundle is a JSON value the caller already read.
//!
//! The bundle hash must equal Node's (`sha256(JSON.stringify(canonicalize(b)))`)
//! because `legacy_import.bundle_hash` is the cross-backend idempotency key: a
//! library migrated by one backend must report "idempotent" on the other. That
//! is why [`js_stringify`] reproduces JSON.stringify's key and number rules
//! instead of using `serde_json::to_string` directly.
//!
//! Deviation D17 (docs/18-server.md): Node counted every *attempted*
//! media-ref insert and re-inserted cover refs on resume (`entry_id IS NULL`
//! never collides in a UNIQUE index). Rust counts rows actually inserted and
//! skips an existing cover ref.

use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::hash::sha256_text;
use crate::jsonutil::now_iso;
use crate::library::Library;

const OLD_VOICE_KIND: &str = "voice";
const OLD_TRACK_KIND: &str = "track";

/// Options for [`Library::migrate_legacy_bundle`].
#[derive(Debug, Clone, Default)]
pub struct LegacyOptions {
    /// Defaults to `legacy:bundle:<hash>`.
    pub idempotency_key: Option<String>,
    /// Test hook (Node `fault: 'after-voice:N'`): commit N voices, then stop as
    /// partial without writing staged payloads. A retry with the same key resumes.
    pub after_voice: Option<usize>,
}

/// Result of a migration. `summary` is Node's enumerable `summaryOf` object;
/// the flags are its non-enumerable properties.
#[derive(Debug, Clone)]
pub struct LegacyOutcome {
    pub summary: Value,
    pub idempotent: bool,
    pub resumed: bool,
    pub faulted: bool,
}

#[derive(Debug, Clone, Default)]
struct Counts {
    voices: i64,
    works_created: i64,
    works_mapped: i64,
    entries_created: i64,
    entries_mapped: i64,
    media_refs_created: i64,
}

impl Counts {
    fn to_json(&self) -> Value {
        json!({
            "voices": self.voices,
            "worksCreated": self.works_created,
            "worksMapped": self.works_mapped,
            "entriesCreated": self.entries_created,
            "entriesMapped": self.entries_mapped,
            "mediaRefsCreated": self.media_refs_created,
        })
    }

    /// `Number(x) || 0` per field, `voices` falling back to the bundle length.
    fn from_json(value: &Value, voices: usize) -> Self {
        let number = |key: &str| value.get(key).and_then(js_number).filter(|n| *n != 0.0 && !n.is_nan()).map(|n| n as i64).unwrap_or(0);
        let parsed_voices = number("voices");
        Self {
            voices: if parsed_voices != 0 { parsed_voices } else { voices as i64 },
            works_created: number("worksCreated"),
            works_mapped: number("worksMapped"),
            entries_created: number("entriesCreated"),
            entries_mapped: number("entriesMapped"),
            media_refs_created: number("mediaRefsCreated"),
        }
    }
}

struct ImportRow {
    import_id: String,
    library_id: String,
    idempotency_key: String,
    bundle_hash: String,
    status: String,
    counts_json: String,
    errors_json: String,
}

// ---------------------------------------------------------------- JS semantics

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|n| n != 0.0 && !n.is_nan()).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a || b || c`: the first truthy value.
fn first_truthy<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| truthy(*value)).flatten()
}

/// `typeof value === 'string' ? value : fallback`.
fn text(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => fallback.to_string(),
    }
}

fn list(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn is_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// `Number(value)` for the shapes a JSON bundle can hold.
fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if text.trim().is_empty() => Some(0.0),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// An array-index key (`"0"`..`"4294967294"`), which JS objects enumerate first
/// in numeric order regardless of insertion order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// `Object.keys(value).sort()`: default sort compares UTF-16 code units.
fn sorted_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    keys
}

/// JSON.stringify for parsed-JSON values: object keys in JS enumeration order
/// (array indices ascending, then insertion order) and integral numbers
/// without a fraction (`3.0` prints as `3`).
fn js_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_js(value, &mut out);
    out
}

fn write_js(value: &Value, out: &mut String) {
    match value {
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                out.push_str(&number.to_string());
            } else {
                let float = number.as_f64().unwrap_or(0.0);
                if float.is_finite() && float.fract() == 0.0 && float.abs() < 1e21 {
                    out.push_str(&format!("{}", float as i128));
                } else {
                    out.push_str(&number.to_string());
                }
            }
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_js(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut indices: Vec<(u32, &String)> = map.keys().filter_map(|key| array_index(key).map(|index| (index, key))).collect();
            indices.sort();
            let keys = indices.into_iter().map(|(_, key)| key).chain(map.keys().filter(|key| array_index(key).is_none()));
            out.push('{');
            for (index, key) in keys.enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_js(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// `canonicalize`: recursively rebuild objects with sorted keys.
fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for key in sorted_keys(map) {
                out.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `new URL(value)` restricted to http(s); returns the serialized `href`.
fn remote_url_of(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str().filter(|text| !text.is_empty())?;
    let url = url::Url::parse(text).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.as_str().to_string())
}

/// `extname(url.split('?')[0])` against the table in legacy.mjs.
fn mime_for_url(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or("");
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    let extension = match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(index) => base[index..].to_lowercase(),
    };
    match extension.as_str() {
        ".mp3" => "audio/mpeg",
        ".wav" => "audio/wav",
        ".flac" => "audio/flac",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".ogg" => "audio/ogg",
        ".opus" => "audio/opus",
        ".srt" => "application/x-subrip",
        ".vtt" => "text/vtt",
        ".ass" => "text/x-ssa",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------- bundle

/// `normalizeBundle`: validated top-level fields; voices are kept raw.
fn normalize_bundle(bundle: &Value) -> Result<Value> {
    let Value::Object(object) = bundle else {
        return Err(Error::new("legacy bundle must be an object"));
    };
    if object.get("schema").and_then(js_number) != Some(1.0) {
        return Err(Error::new("only legacy bundle schema 1 is supported"));
    }
    if !matches!(object.get("voices"), Some(Value::Array(_))) {
        return Err(Error::new("legacy bundle.voices must be an array"));
    }
    let keep_object = |key: &str| if is_object(object.get(key)) { object[key].clone() } else { json!({}) };
    Ok(json!({
        "schema": 1,
        "exportedAt": text(object.get("exportedAt"), ""),
        "source": text(object.get("source"), "monochrome-legacy-export"),
        "voices": object["voices"],
        "favorites": keep_object("favorites"),
        "history": list(object.get("history")),
        "playlists": list(object.get("playlists")),
        "settings": keep_object("settings"),
    }))
}

fn bundle_hash_of(normalized: &Value) -> String {
    sha256_text(&js_stringify(&canonicalize(normalized)))
}

fn voice_key(voice: &Value, index: usize) -> String {
    let candidate = first_truthy(&[voice.get("id"), voice.get("workId"), voice.get("uuid"), voice.get("sourceCode"), voice.get("code")]);
    text(candidate, &format!("voice-{index}"))
}

/// One flattened `tracks` node: a leaf to import, or a folder whose ID maps to
/// the work (`{ folderId }` in Node).
enum Leaf {
    Track { track: Value, title: String, logical_path: String, url: Option<String>, urls: Vec<String>, kind: String },
    Folder(String),
}

fn flatten_tracks(tracks: &[Value], parent_path: &str) -> Vec<Leaf> {
    let mut result = Vec::new();
    for track in tracks {
        if !track.is_object() {
            continue;
        }
        let title = text(first_truthy(&[track.get("title"), track.get("name")]), "Untitled track");
        let logical_path = if parent_path.is_empty() { title.clone() } else { format!("{parent_path}/{title}") };
        let children = flatten_tracks(&list(track.get("tracks")), &logical_path);
        if !children.is_empty() {
            result.extend(children);
            if truthy(track.get("id")) {
                result.push(Leaf::Folder(super_string(&track["id"])));
            }
            continue;
        }
        let urls: Vec<String> = ["mediaStreamUrl", "mediaDownloadUrl", "url", "streamUrl"]
            .iter()
            .filter_map(|key| remote_url_of(track.get(*key)))
            .collect();
        let kind = text(track.get("type"), if urls.is_empty() { "file" } else { "audio" });
        if !urls.is_empty() || kind != "folder" {
            result.push(Leaf::Track { track: track.clone(), title, logical_path, url: urls.first().cloned(), urls, kind });
        }
    }
    result
}

/// `String(value)` for an ID that may be a number in old bundles.
fn super_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => js_stringify(other),
    }
}

fn track_key(track: &Value, voice_key: &str, logical_path: &str, index: usize) -> String {
    let candidate = first_truthy(&[track.get("id"), track.get("entryId"), track.get("trackId"), track.get("uuid")]);
    text(candidate, &format!("{voice_key}:{logical_path}:{index}"))
}

fn staged_payload_rows(bundle: &Value) -> Vec<(&'static str, Value, usize)> {
    let keys = |key: &str| bundle[key].as_object().map(Map::len).unwrap_or(0);
    let length = |key: &str| bundle[key].as_array().map(Vec::len).unwrap_or(0);
    vec![
        ("favorites", bundle["favorites"].clone(), keys("favorites")),
        ("history", bundle["history"].clone(), length("history")),
        ("playlists", bundle["playlists"].clone(), length("playlists")),
        ("settings", bundle["settings"].clone(), keys("settings")),
    ]
}

// ---------------------------------------------------------------- library

impl Library {
    /// Migrate a normalized legacy export bundle (`migrateLegacyBundle`).
    ///
    /// Voices become work/source_ref/entry/user_state rows, remote URLs only
    /// `legacy_media_ref` rows, old IDs `legacy_id_map` rows; favorites,
    /// history, playlists and settings are staged verbatim. Each voice commits
    /// on its own, so a crash leaves a resumable `partial`/`processing` import.
    pub fn migrate_legacy_bundle(&self, bundle: &Value, options: &LegacyOptions) -> Result<LegacyOutcome> {
        self.assert_open()?;
        let normalized = normalize_bundle(bundle)?;
        let hash = bundle_hash_of(&normalized);
        let key = options.idempotency_key.clone().filter(|key| !key.is_empty()).unwrap_or_else(|| format!("legacy:bundle:{hash}"));
        if let Some(existing) = self.legacy_import_where("idempotency_key", &key)? {
            if existing.bundle_hash != hash {
                return Err(Error::coded(
                    "ELEGACYCONFLICT",
                    format!("legacy idempotency key reused with a changed bundle/plan: {} != {hash}", existing.bundle_hash),
                ));
            }
            if existing.status == "completed" {
                return Ok(outcome(&existing, true, false, false));
            }
            return self.resume_legacy_import(existing, &normalized, options);
        }
        if let Some(existing) = self.legacy_import_where("bundle_hash", &hash)? {
            // Same immutable bundle under another key is the same migration,
            // not a second set of works.
            return Ok(outcome(&existing, true, false, false));
        }
        let row = self.tx(|| self.create_legacy_import(&key, bundle, &normalized, &hash))?;
        self.run_legacy_import(row, &normalized, options, None)
    }

    fn legacy_import_where(&self, column: &str, value: &str) -> Result<Option<ImportRow>> {
        let sql = format!(
            "SELECT import_id, library_id, idempotency_key, bundle_hash, status, counts_json, errors_json
             FROM legacy_import WHERE library_id = ? AND {column} = ?"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(rusqlite::params![self.library_id, value])?;
        Ok(match rows.next()? {
            Some(row) => Some(import_row(row)?),
            None => None,
        })
    }

    fn legacy_import_by_id(&self, import_id: &str) -> Result<ImportRow> {
        Ok(self.connection.query_row(
            "SELECT import_id, library_id, idempotency_key, bundle_hash, status, counts_json, errors_json
             FROM legacy_import WHERE import_id = ?",
            [import_id],
            import_row,
        )?)
    }

    fn create_legacy_import(&self, key: &str, raw: &Value, normalized: &Value, hash: &str) -> Result<ImportRow> {
        let timestamp = now_iso();
        let import_id = uuid::Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO legacy_import(
                import_id, library_id, idempotency_key, bundle_hash, bundle_json,
                schema_version, source, status, counts_json, errors_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', '{}', '[]', ?, ?)",
            rusqlite::params![
                import_id,
                self.library_id,
                key,
                hash,
                // The caller's raw shape is the immutable payload, not the normalized one.
                js_stringify(raw),
                raw.get("schema").and_then(js_number).unwrap_or(1.0) as i64,
                text(raw.get("source"), ""),
                timestamp,
                timestamp,
            ],
        )?;
        self.insert_staged_payloads(&import_id, normalized)?;
        self.legacy_import_by_id(&import_id)
    }

    fn insert_staged_payloads(&self, import_id: &str, bundle: &Value) -> Result<()> {
        let timestamp = now_iso();
        for (domain, payload, count) in staged_payload_rows(bundle) {
            self.connection.execute(
                "INSERT OR IGNORE INTO legacy_staged_payload(import_id, domain, payload_json, item_count, created_at)
                 VALUES (?, ?, ?, ?, ?)",
                rusqlite::params![import_id, domain, js_stringify(&payload), count as i64, timestamp],
            )?;
        }
        Ok(())
    }

    fn resume_legacy_import(&self, row: ImportRow, bundle: &Value, options: &LegacyOptions) -> Result<LegacyOutcome> {
        let voices = bundle["voices"].as_array().map(Vec::len).unwrap_or(0);
        let parsed: Value = serde_json::from_str(&row.counts_json).unwrap_or_else(|_| json!({}));
        let counts = Counts::from_json(&parsed, voices);
        // Mark processing but keep the immutable bundle untouched.
        self.connection.execute(
            "UPDATE legacy_import SET status = 'processing', updated_at = ? WHERE import_id = ?",
            rusqlite::params![now_iso(), row.import_id],
        )?;
        self.run_legacy_import(row, bundle, options, Some(counts))
    }

    fn run_legacy_import(&self, row: ImportRow, bundle: &Value, options: &LegacyOptions, prior: Option<Counts>) -> Result<LegacyOutcome> {
        let voices = bundle["voices"].as_array().cloned().unwrap_or_default();
        let resumed = prior.is_some();
        let mut counts = prior.unwrap_or(Counts { voices: voices.len() as i64, ..Counts::default() });
        let mut errors: Vec<Value> = Vec::new();
        let fault = options.after_voice.filter(|n| *n > 0);
        let mut faulted = false;
        for (index, voice) in voices.iter().enumerate() {
            if faulted {
                break;
            }
            // Count changes only once the voice's transaction commits.
            let mut voice_counts = counts.clone();
            match self.tx(|| self.process_voice(&row.import_id, voice, index, &mut voice_counts)) {
                Ok(()) => counts = voice_counts,
                Err(error) => errors.push(json!({ "voiceId": voice_key(voice, index), "error": error.message })),
            }
            if let Some(limit) = fault {
                if index + 1 >= limit {
                    faulted = true;
                    errors.push(json!({ "fault": format!("after-voice:{limit}"), "error": "injected migration fault" }));
                }
            }
        }
        if !faulted {
            // Refresh staged payloads only if absent; the raw bundle is immutable.
            if let Err(error) = self.tx(|| self.insert_staged_payloads(&row.import_id, bundle)) {
                errors.push(json!({ "stage": "staged-payload", "error": error.message }));
            }
        }
        let completed = errors.is_empty();
        let timestamp = now_iso();
        self.connection.execute(
            "UPDATE legacy_import SET
                status = ?, counts_json = ?, errors_json = ?, updated_at = ?,
                completed_at = CASE WHEN ? THEN ? ELSE completed_at END
             WHERE import_id = ?",
            rusqlite::params![
                if completed { "completed" } else { "partial" },
                js_stringify(&counts.to_json()),
                js_stringify(&Value::Array(errors)),
                timestamp,
                completed as i64,
                timestamp,
                row.import_id,
            ],
        )?;
        let updated = self.legacy_import_by_id(&row.import_id)?;
        Ok(outcome(&updated, false, resumed, faulted))
    }

    fn legacy_map(&self, old_kind: &str, old_id: &str) -> Result<Option<(String, String)>> {
        let mut statement = self.connection.prepare("SELECT new_kind, new_id FROM legacy_id_map WHERE old_kind = ? AND old_id = ?")?;
        let mut rows = statement.query([old_kind, old_id])?;
        Ok(match rows.next()? {
            Some(row) => Some((row.get(0)?, row.get(1)?)),
            None => None,
        })
    }

    fn insert_legacy_map(&self, old_kind: &str, old_id: &str, new_kind: &str, new_id: &str) -> Result<()> {
        self.connection.execute(
            "INSERT OR IGNORE INTO legacy_id_map(old_kind, old_id, new_kind, new_id, created_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![old_kind, old_id, new_kind, new_id, now_iso()],
        )?;
        Ok(())
    }

    /// Insert one remote reference; `true` only when a row was actually added
    /// (D17). A work-level ref (`entry_id` NULL) is never unique in SQLite, so
    /// it is checked explicitly instead of relying on `OR IGNORE`.
    fn insert_media_ref(&self, import_id: &str, work_id: &str, entry_id: Option<&str>, kind: &str, legacy_id: &str, url: Option<&Value>) -> Result<bool> {
        let Some(normalized) = remote_url_of(url) else {
            return Ok(false);
        };
        if entry_id.is_none() {
            let exists: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM legacy_media_ref WHERE work_id = ? AND entry_id IS NULL AND legacy_kind = ? AND url = ?",
                rusqlite::params![work_id, kind, normalized],
                |row| row.get(0),
            )?;
            if exists > 0 {
                return Ok(false);
            }
        }
        let legacy_id = (!legacy_id.is_empty()).then_some(legacy_id);
        let inserted = self.connection.execute(
            "INSERT OR IGNORE INTO legacy_media_ref(
                media_ref_id, import_id, work_id, entry_id, legacy_kind, legacy_id, old_id, url, mime, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                import_id,
                work_id,
                entry_id,
                kind,
                legacy_id,
                legacy_id,
                normalized,
                mime_for_url(&normalized),
                now_iso(),
            ],
        )?;
        Ok(inserted == 1)
    }

    fn insert_legacy_work(&self, work_id: &str, family_id: Option<&str>, voice: &Value, old_id: &str, timestamp: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO work(work_id, family_id, title, circle, cv_json, language, role, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
            rusqlite::params![
                work_id,
                family_id,
                text(voice.get("title"), old_id),
                text(voice.get("circle"), ""),
                js_stringify(&Value::Array(list(voice.get("cvs")))),
                text(voice.get("language"), ""),
                text(voice.get("role"), ""),
                timestamp,
                timestamp,
            ],
        )?;
        Ok(())
    }

    fn process_voice(&self, import_id: &str, voice: &Value, index: usize, counts: &mut Counts) -> Result<()> {
        let old_id = voice_key(voice, index);
        let timestamp = now_iso();
        let mapped_work = self.legacy_map(OLD_VOICE_KIND, &old_id)?.filter(|(kind, _)| kind == "work");
        let work_id;
        let mut created_work = false;
        if let Some((_, existing_id)) = mapped_work {
            work_id = existing_id;
            let exists: i64 = self.connection.query_row("SELECT COUNT(*) FROM work WHERE work_id = ?", [&work_id], |row| row.get(0))?;
            if exists == 0 {
                self.insert_legacy_work(&work_id, None, voice, &old_id, &timestamp)?;
                created_work = true;
            }
        } else {
            work_id = uuid::Uuid::new_v4().to_string();
            let family_id = uuid::Uuid::new_v4().to_string();
            self.connection.execute("INSERT INTO family(family_id, created_at) VALUES (?, ?)", rusqlite::params![family_id, timestamp])?;
            self.insert_legacy_work(&work_id, Some(&family_id), voice, &old_id, &timestamp)?;
            self.insert_legacy_map(OLD_VOICE_KIND, &old_id, "work", &work_id)?;
            counts.works_created += 1;
            created_work = true;
        }
        if !created_work {
            counts.works_mapped += 1;
        }

        let provider = text(voice.get("provider"), "legacy");
        let source_code = text(first_truthy(&[voice.get("sourceCode"), voice.get("code")]), &old_id);
        self.connection.execute(
            "INSERT OR IGNORE INTO source_ref(source_ref_id, work_id, provider, source_code, source_url, snapshot_json, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                work_id,
                provider,
                source_code,
                text(voice.get("sourceUrl"), ""),
                js_stringify(&json!({ "legacyVoice": voice, "oldVoiceId": old_id })),
                now_iso(),
            ],
        )?;
        self.connection.execute(
            "INSERT OR IGNORE INTO user_state(work_id, notes, favorite, playback_position, updated_at) VALUES (?, ?, ?, NULL, ?)",
            rusqlite::params![work_id, text(voice.get("notes"), ""), truthy(voice.get("favorite")) as i64, timestamp],
        )?;

        // Remote cover URLs are references only, never CAS assets.
        let mut covers: Vec<Option<&Value>> = vec![voice.get("coverUrl"), voice.get("cover")];
        if let Some(Value::Array(items)) = voice.get("covers") {
            covers.extend(items.iter().map(Some));
        }
        for cover in covers {
            if self.insert_media_ref(import_id, &work_id, None, "cover", &old_id, cover)? {
                counts.media_refs_created += 1;
            }
        }

        let tracks = list(first_truthy(&[voice.get("tracks"), voice.get("entries"), voice.get("files")]));
        for (track_index, leaf) in flatten_tracks(&tracks, "").into_iter().enumerate() {
            let (track, title, logical_path, url, urls, kind) = match leaf {
                Leaf::Folder(folder_id) => {
                    if self.legacy_map(OLD_TRACK_KIND, &folder_id)?.is_none() {
                        self.insert_legacy_map(OLD_TRACK_KIND, &folder_id, "work", &work_id)?;
                    }
                    continue;
                }
                Leaf::Track { track, title, logical_path, url, urls, kind } => (track, title, logical_path, url, urls, kind),
            };
            let old_track_id = track_key(&track, &old_id, &logical_path, track_index);
            if matches!(self.legacy_map(OLD_TRACK_KIND, &old_track_id)?, Some((kind, _)) if kind == "entry") {
                counts.entries_mapped += 1;
                continue;
            }
            let entry_id = uuid::Uuid::new_v4().to_string();
            let kind = if kind.is_empty() { "audio".to_string() } else { kind };
            self.connection.execute(
                "INSERT INTO entry(entry_id, work_id, stable_entry_id, logical_path, kind, mime, display_title, original_path, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    entry_id,
                    work_id,
                    old_track_id,
                    logical_path,
                    kind,
                    url.as_deref().map(mime_for_url).unwrap_or("application/octet-stream"),
                    title,
                    text(first_truthy(&[track.get("path"), track.get("originalPath")]), ""),
                    track_index as i64,
                ],
            )?;
            self.insert_legacy_map(OLD_TRACK_KIND, &old_track_id, "entry", &entry_id)?;
            counts.entries_created += 1;
            for media_url in &urls {
                if self.insert_media_ref(import_id, &work_id, Some(&entry_id), "media", &old_track_id, Some(&Value::String(media_url.clone())))? {
                    counts.media_refs_created += 1;
                }
            }
            for subtitle in list(track.get("subtitles")) {
                let subtitle_url = match &subtitle {
                    Value::String(_) => Some(&subtitle),
                    other => other.get("url"),
                };
                if self.insert_media_ref(import_id, &work_id, Some(&entry_id), "subtitle", &old_track_id, subtitle_url)? {
                    counts.media_refs_created += 1;
                }
            }
        }
        Ok(())
    }
}

fn import_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportRow> {
    Ok(ImportRow {
        import_id: row.get(0)?,
        library_id: row.get(1)?,
        idempotency_key: row.get(2)?,
        bundle_hash: row.get(3)?,
        status: row.get(4)?,
        counts_json: row.get(5)?,
        errors_json: row.get(6)?,
    })
}

/// `summaryOf`: the enumerable summary plus the non-enumerable flags.
fn outcome(row: &ImportRow, idempotent: bool, resumed: bool, faulted: bool) -> LegacyOutcome {
    let counts: Value = serde_json::from_str(&row.counts_json).unwrap_or_else(|_| json!({}));
    let errors: Value = serde_json::from_str(&row.errors_json).unwrap_or_else(|_| json!([]));
    let count = |key: &str| counts.get(key).cloned().unwrap_or(json!(0));
    LegacyOutcome {
        summary: json!({
            "importId": row.import_id,
            "legacyImportId": row.import_id,
            "libraryId": row.library_id,
            "idempotencyKey": row.idempotency_key,
            "bundleHash": row.bundle_hash,
            "status": row.status,
            "counts": counts,
            "worksCreated": count("worksCreated"),
            "worksMapped": count("worksMapped"),
            "entriesCreated": count("entriesCreated"),
            "mediaRefsCreated": count("mediaRefsCreated"),
            "errors": errors,
        }),
        idempotent,
        resumed,
        faulted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::OpenOptions;

    // The fixture lives inside the crate, not under `verify/`: that directory is
    // not published, so `include_str!` pointing into it made the test module
    // uncompilable in the standalone repository. A test's data belongs with the
    // test.
    const FIXTURE: &str = include_str!("../tests/fixtures/legacy-bundle.json");

    fn open(tag: &str) -> (Library, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("mono-legacy-{tag}-{}", uuid::Uuid::new_v4()));
        let library = Library::open(base.join("lib"), OpenOptions { create: true, allow_outside_root: true, ..Default::default() }).unwrap();
        (library, base)
    }

    fn count(library: &Library, sql: &str) -> i64 {
        library.connection.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn bundle_hash_matches_node() {
        // Node: sha256(JSON.stringify(canonicalize(normalizeBundle(fixture)))).
        let bundle: Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(bundle_hash_of(&normalize_bundle(&bundle).unwrap()), "52a67d29dc915854e79c5f688d29461c9eda3ad0c16c333f05300ae0f34b21cb");
    }

    #[test]
    fn js_stringify_follows_object_and_number_rules() {
        let value: Value = serde_json::from_str(r#"{"b":1,"10":2,"9":3,"a":3.0,"c":[1.5,"\u001f"]}"#).unwrap();
        assert_eq!(js_stringify(&value), r#"{"9":3,"10":2,"b":1,"a":3,"c":[1.5,"\u001f"]}"#);
    }

    #[test]
    fn fixture_migrates_without_cas_and_is_idempotent() {
        let (library, base) = open("fixture");
        let bundle: Value = serde_json::from_str(FIXTURE).unwrap();
        let options = LegacyOptions { idempotency_key: Some("s4b-01-bundle".to_string()), after_voice: None };
        let result = library.migrate_legacy_bundle(&bundle, &options).unwrap();
        assert_eq!(result.summary["status"], "completed");
        assert!(!result.idempotent);
        assert_eq!(count(&library, "SELECT COUNT(*) FROM work"), 2);
        assert_eq!(count(&library, "SELECT COUNT(*) FROM entry"), 3);
        assert_eq!(count(&library, "SELECT COUNT(*) FROM asset"), 0);
        assert_eq!(count(&library, "SELECT COUNT(*) FROM asset_ref"), 0);
        // voice x2, track x3, nested folder x1.
        assert_eq!(count(&library, "SELECT COUNT(*) FROM legacy_id_map"), 6);
        // track1's stream and download URL are the same: one row (D17).
        assert_eq!(count(&library, "SELECT COUNT(*) FROM legacy_media_ref"), 3);
        assert_eq!(result.summary["mediaRefsCreated"], 3);
        assert_eq!(count(&library, "SELECT COUNT(*) FROM legacy_staged_payload"), 4);
        let stored: String = library.connection.query_row("SELECT bundle_json FROM legacy_import", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), bundle, "the raw bundle is kept verbatim");
        let nested: String = library.connection.query_row("SELECT logical_path FROM entry WHERE stable_entry_id = 'old-track-2'", [], |row| row.get(0)).unwrap();
        assert_eq!(nested, "Nested folder/Track 2");
        assert_eq!(library.verify_library().unwrap()["ok"], true);

        let again = library.migrate_legacy_bundle(&bundle, &options).unwrap();
        assert!(again.idempotent);
        let other_key = library.migrate_legacy_bundle(&bundle, &LegacyOptions { idempotency_key: Some("another".to_string()), after_voice: None }).unwrap();
        assert!(other_key.idempotent, "same bundle under another key is the same migration");
        assert_eq!(count(&library, "SELECT COUNT(*) FROM work"), 2);

        let mut changed = bundle.clone();
        changed["voices"][0]["title"] = json!("changed");
        assert_eq!(library.migrate_legacy_bundle(&changed, &options).unwrap_err().code, Some("ELEGACYCONFLICT"));
        drop(library);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn fault_then_resume_completes_without_duplicates() {
        let (library, base) = open("resume");
        let mut bundle: Value = serde_json::from_str(FIXTURE).unwrap();
        bundle["voices"][0]["coverUrl"] = json!("https://legacy.invalid/voice1/cover.jpg");
        let key = Some("f6".to_string());
        let partial = library.migrate_legacy_bundle(&bundle, &LegacyOptions { idempotency_key: key.clone(), after_voice: Some(1) }).unwrap();
        assert!(partial.faulted);
        assert_eq!(partial.summary["status"], "partial");
        assert_eq!(count(&library, "SELECT COUNT(*) FROM work"), 1);
        let resumed = library.migrate_legacy_bundle(&bundle, &LegacyOptions { idempotency_key: key.clone(), after_voice: None }).unwrap();
        assert!(resumed.resumed);
        assert_eq!(resumed.summary["status"], "completed");
        assert_eq!(count(&library, "SELECT COUNT(*) FROM work"), 2);
        assert_eq!(count(&library, "SELECT COUNT(*) FROM legacy_import"), 1);
        // D17: the cover ref of the voice committed before the fault is not duplicated.
        assert_eq!(count(&library, "SELECT COUNT(*) FROM legacy_media_ref WHERE legacy_kind = 'cover'"), 1);
        assert_eq!(resumed.summary["counts"]["worksMapped"], 1);
        assert_eq!(resumed.summary["counts"]["entriesMapped"], 2);
        assert_eq!(library.verify_library().unwrap()["ok"], true);
        assert!(library.migrate_legacy_bundle(&bundle, &LegacyOptions { idempotency_key: key, after_voice: None }).unwrap().idempotent);
        drop(library);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn bad_bundles_are_rejected() {
        let (library, base) = open("bad");
        for (bundle, message) in [
            (json!([]), "legacy bundle must be an object"),
            (json!({ "schema": 2, "voices": [] }), "only legacy bundle schema 1 is supported"),
            (json!({ "schema": 1 }), "legacy bundle.voices must be an array"),
        ] {
            assert_eq!(library.migrate_legacy_bundle(&bundle, &LegacyOptions::default()).unwrap_err().message, message);
        }
        drop(library);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn mime_and_url_helpers_match_node() {
        assert_eq!(mime_for_url("https://x/a/track.MP3?sig=1"), "audio/mpeg");
        assert_eq!(mime_for_url("https://x/a/.hidden"), "application/octet-stream");
        assert_eq!(remote_url_of(Some(&json!("HTTPS://Example.com/a b.mp3"))).as_deref(), Some("https://example.com/a%20b.mp3"));
        assert_eq!(remote_url_of(Some(&json!("file:///c:/x.mp3"))), None);
        assert_eq!(remote_url_of(Some(&json!("not a url"))), None);
    }
}
