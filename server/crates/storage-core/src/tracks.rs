//! Logical tracks and format renditions (`tracks.mjs`, E04).
//!
//! Tracks come only from an explicit `trackKey` at import time (or a one-entry
//! fallback track) — never from title or byte heuristics. A "loseless vs lossy"
//! choice is a *rendition* choice within one track, so the player can switch
//! MP3/WAV/FLAC without the queue seeing duplicate entries.

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::error::Result;

/// Stable fallback preference when the caller does not request a format.
///
/// Order matters: it decides which rendition plays when several exist. Small
/// lossy formats come first because the UI defaults to MP3 and because a smaller
/// transfer is preferable when both decode to the same audio.
pub const DEFAULT_FORMAT_ORDER: &[&str] = &["aac", "m4a", "mp3", "opus", "ogg", "wav", "flac", "aiff", "unknown"];

/// Normalise a format token or MIME string into a short format name.
pub fn normalize_format(value: &str) -> String {
    let text = value.trim().to_lowercase();
    if text.is_empty() {
        return String::new();
    }
    if text == "lossless" {
        return "lossless".to_string();
    }
    if text.contains('/') {
        // MIME first: `audio/mpeg` must become `mp3`, not `mpeg`.
        if text.contains("mpeg") {
            return "mp3".to_string();
        }
        if text.contains("wav") {
            return "wav".to_string();
        }
        if text.contains("flac") {
            return "flac".to_string();
        }
        if text.contains("aac") {
            return "aac".to_string();
        }
        if text.contains("mp4") {
            return "m4a".to_string();
        }
        if text.contains("opus") {
            return "opus".to_string();
        }
        if text.contains("ogg") {
            return "ogg".to_string();
        }
        return text;
    }
    text.trim_start_matches('.').trim_start_matches("audio/").to_string()
}

/// Parse `preferredFormat`: a single token, a comma list, or an array.
///
/// `None` / `""` / `"auto"` mean "no preference" and fall back to
/// [`DEFAULT_FORMAT_ORDER`].
pub fn preferred_formats(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else { return Vec::new() };
    let raw: Vec<String> = match value {
        Value::Null => Vec::new(),
        Value::String(text) => {
            if text.is_empty() || text == "auto" {
                Vec::new()
            } else {
                text.split(',').map(str::to_string).collect()
            }
        }
        Value::Array(items) => items.iter().map(crate::jsonutil::string_of).collect(),
        other => vec![crate::jsonutil::string_of(other)],
    };
    raw.into_iter()
        .map(|item| normalize_format(&item))
        .filter(|item| !item.is_empty())
        .collect()
}

/// True when a rendition satisfies a requested format.
fn format_matches(format: &str, mime: Option<&str>, wanted: &str) -> bool {
    if wanted.is_empty() {
        return false;
    }
    if wanted == "lossless" {
        return matches!(format, "wav" | "flac" | "aiff");
    }
    format == wanted || normalize_format(mime.unwrap_or("")) == wanted
}

/// The renditions of one track.
#[derive(Debug, Clone)]
pub struct Rendition {
    pub rendition_id: String,
    pub entry_id: String,
    pub internal_entry_id: String,
    pub logical_path: String,
    pub kind: String,
    pub title: Option<String>,
    pub format: String,
    pub mime: String,
    pub priority: i64,
    pub asset_id: Option<String>,
    pub sha256: Option<String>,
    pub bytes: Option<i64>,
    pub rel_path: Option<String>,
}

impl Rendition {
    pub fn to_json(&self) -> Value {
        json!({
            "renditionId": self.rendition_id,
            "entryId": self.entry_id,
            "internalEntryId": self.internal_entry_id,
            "logicalPath": self.logical_path,
            "kind": self.kind,
            "title": self.title,
            "format": self.format,
            "mime": self.mime,
            "priority": self.priority,
            "assetId": self.asset_id,
            "sha256": self.sha256,
            "bytes": self.bytes,
            "relPath": self.rel_path,
        })
    }
}

/// One logical track with all its format renditions.
#[derive(Debug, Clone)]
pub struct Track {
    pub track_id: String,
    pub track_key: String,
    pub title: Option<String>,
    pub sort_order: i64,
    pub renditions: Vec<Rendition>,
}

impl Track {
    pub fn to_json(&self) -> Value {
        json!({
            "trackId": self.track_id,
            "trackKey": self.track_key,
            "title": self.title,
            "sortOrder": self.sort_order,
            "renditions": self.renditions.iter().map(Rendition::to_json).collect::<Vec<_>>(),
        })
    }

    fn audio_renditions(&self) -> Vec<&Rendition> {
        self.renditions.iter().filter(|item| item.kind == "audio").collect()
    }
}

/// Load tracks + renditions for one work, in stable order.
pub fn select_renditions(connection: &Connection, work_id: &str) -> Result<Vec<Track>> {
    let mut track_statement = connection.prepare(
        "SELECT * FROM track WHERE work_id = ? ORDER BY sort_order, track_key",
    )?;
    let track_rows: Vec<(String, String, Option<String>, i64)> = track_statement
        .query_map(rusqlite::params![work_id], |row| {
            Ok((
                row.get::<_, String>("track_id")?,
                row.get::<_, String>("track_key")?,
                row.get::<_, Option<String>>("title")?,
                row.get::<_, i64>("sort_order")?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // One asset per entry: prefer role=primary, then the lowest asset_ref_id, so
    // an entry with several refs still plays a deterministic file.
    let mut rendition_statement = connection.prepare(
        "SELECT r.*, e.stable_entry_id, e.logical_path, e.kind, e.display_title,
                e.mime AS entry_mime,
                a.asset_id, a.sha256, a.bytes, a.rel_path, a.mime AS asset_mime
         FROM track_rendition r
         JOIN entry e ON e.entry_id = r.entry_id
         LEFT JOIN asset a ON a.asset_id = (
             SELECT asset_id FROM asset_ref
             WHERE entry_id = e.entry_id
             ORDER BY CASE WHEN role = 'primary' THEN 0 ELSE 1 END, asset_ref_id
             LIMIT 1
         )
         WHERE r.track_id = ?
         ORDER BY r.priority, r.rendition_id",
    )?;

    let mut tracks = Vec::with_capacity(track_rows.len());
    for (track_id, track_key, title, sort_order) in track_rows {
        let renditions: Vec<Rendition> = rendition_statement
            .query_map(rusqlite::params![track_id], |row| {
                let entry_mime: Option<String> = row.get("entry_mime")?;
                let asset_mime: Option<String> = row.get("asset_mime")?;
                let rendition_mime: Option<String> = row.get("mime")?;
                Ok(Rendition {
                    rendition_id: row.get("rendition_id")?,
                    entry_id: row.get("stable_entry_id")?,
                    internal_entry_id: row.get("entry_id")?,
                    logical_path: row.get("logical_path")?,
                    kind: row.get("kind")?,
                    title: row.get("display_title")?,
                    format: row.get("format")?,
                    mime: asset_mime
                        .or(entry_mime)
                        .or(rendition_mime)
                        .unwrap_or_else(|| "application/octet-stream".to_string()),
                    priority: row.get("priority")?,
                    asset_id: row.get("asset_id")?,
                    sha256: row.get("sha256")?,
                    bytes: row.get("bytes")?,
                    rel_path: row.get("rel_path")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        tracks.push(Track { track_id, track_key, title, sort_order, renditions });
    }
    Ok(tracks)
}

/// Result of choosing one rendition out of a track's audio formats.
pub struct ChosenRendition<'a> {
    pub rendition: Option<&'a Rendition>,
    pub fallback: bool,
    pub requested: Vec<String>,
}

/// Pick the rendition to play.
///
/// Requested formats are honoured in order; then the stable default order; then
/// whatever exists. `fallback` records that the caller did not get what it asked
/// for, which the UI uses to explain a format substitution.
pub fn choose_rendition<'a>(renditions: &'a [&'a Rendition], requested: Option<&Value>) -> ChosenRendition<'a> {
    let preferred = preferred_formats(requested);
    for format in &preferred {
        if let Some(found) = renditions
            .iter()
            .find(|item| format_matches(&item.format, Some(&item.mime), format))
        {
            return ChosenRendition { rendition: Some(found), fallback: false, requested: preferred };
        }
    }
    for format in DEFAULT_FORMAT_ORDER {
        if let Some(found) = renditions
            .iter()
            .find(|item| format_matches(&item.format, Some(&item.mime), format))
        {
            return ChosenRendition {
                rendition: Some(found),
                fallback: !preferred.is_empty(),
                requested: preferred,
            };
        }
    }
    ChosenRendition {
        rendition: renditions.first().copied(),
        fallback: !preferred.is_empty(),
        requested: preferred,
    }
}

/// `listLogicalTracks`: every track with every rendition.
///
/// The Node version attaches `workId`/`tracks` as properties on the returned
/// array; `JSON.stringify` drops non-index properties, so the wire shape is a
/// plain array. Returning the array here keeps that shape exact.
pub fn list_logical_tracks(connection: &Connection, work_id: &str) -> Result<Value> {
    let tracks = select_renditions(connection, work_id)?;
    Ok(Value::Array(tracks.iter().map(Track::to_json).collect()))
}

/// `resolveTrackMedia`: one playback item per track, with the chosen rendition
/// spread onto the item.
pub fn resolve_track_media(connection: &Connection, work_id: &str, preferred_format: Option<&Value>) -> Result<Value> {
    let tracks = select_renditions(connection, work_id)?;
    let mut items = Vec::new();
    for track in tracks {
        let audio = track.audio_renditions();
        if audio.is_empty() {
            // Non-audio tracks are not part of the playback sequence.
            continue;
        }
        let chosen = choose_rendition(&audio, preferred_format);
        let mut item = track.to_json();
        if let Some(rendition) = chosen.rendition {
            item["rendition"] = rendition.to_json();
            item["selectedRendition"] = rendition.to_json();
            item["fallback"] = json!(chosen.fallback);
            item["requestedFormat"] = json!(chosen.requested);
            item["renditionId"] = json!(rendition.rendition_id);
            item["entryId"] = json!(rendition.entry_id);
            item["internalEntryId"] = json!(rendition.internal_entry_id);
            item["logicalPath"] = json!(rendition.logical_path);
            item["format"] = json!(rendition.format);
            item["mime"] = json!(rendition.mime);
            item["assetId"] = json!(rendition.asset_id);
            item["sha256"] = json!(rendition.sha256);
            item["bytes"] = json!(rendition.bytes);
            item["relPath"] = json!(rendition.rel_path);
        } else {
            item["rendition"] = Value::Null;
            item["selectedRendition"] = Value::Null;
            item["fallback"] = json!(chosen.fallback);
            item["requestedFormat"] = json!(chosen.requested);
        }
        items.push(item);
    }
    Ok(Value::Array(items))
}

/// `playbackSequence` is `resolveTrackMedia` under another name.
pub fn playback_sequence(connection: &Connection, work_id: &str, preferred_format: Option<&Value>) -> Result<Value> {
    resolve_track_media(connection, work_id, preferred_format)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{Library, OpenOptions};
    use std::path::PathBuf;

    fn fixture() -> (Library, PathBuf) {
        let root = std::env::temp_dir().join(format!("mono-tracks-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        for name in ["a.mp3", "a.wav", "b.mp3"] {
            std::fs::write(source.join(name), name.as_bytes()).unwrap();
        }
        let lib = Library::open(
            root.join("library"),
            OpenOptions { create: true, allow_outside_root: true, ..Default::default() },
        )
        .unwrap();
        (lib, source)
    }

    #[test]
    fn one_track_keeps_two_renditions_and_prefers_requested_format() {
        let (mut lib, source) = fixture();
        let record = crate::library::SourceRecord::from_json(&serde_json::json!({
            "provider": "dlsite",
            "sourceCode": "RJ1",
            "title": "T",
            "entries": [
                { "entryId": "e1", "logicalPath": "mp3/a.mp3", "kind": "audio", "mime": "audio/mpeg",
                  "sourcePath": source.join("a.mp3").to_string_lossy(), "trackKey": "a" },
                { "entryId": "e2", "logicalPath": "wav/a.wav", "kind": "audio", "mime": "audio/wav",
                  "sourcePath": source.join("a.wav").to_string_lossy(), "trackKey": "a" },
                { "entryId": "e3", "logicalPath": "mp3/b.mp3", "kind": "audio", "mime": "audio/mpeg",
                  "sourcePath": source.join("b.mp3").to_string_lossy(), "trackKey": "b" }
            ]
        }))
        .unwrap();
        let work_id = lib.import_work(record, "k").unwrap().work["workId"].as_str().unwrap().to_string();

        let tracks = list_logical_tracks(&lib.connection, &work_id).unwrap();
        assert_eq!(tracks.as_array().unwrap().len(), 2);
        assert_eq!(tracks[0]["renditions"].as_array().unwrap().len(), 2);

        // Default order prefers mp3.
        let sequence = resolve_track_media(&lib.connection, &work_id, None).unwrap();
        assert_eq!(sequence[0]["format"], "mp3");
        assert_eq!(sequence[0]["fallback"], false);

        // Explicit wav is honoured without a fallback flag.
        let wav = resolve_track_media(&lib.connection, &work_id, Some(&serde_json::json!("wav"))).unwrap();
        assert_eq!(wav[0]["format"], "wav");
        assert_eq!(wav[0]["fallback"], false);

        // Asking for flac (absent) falls back and records the request.
        let flac = resolve_track_media(&lib.connection, &work_id, Some(&serde_json::json!("flac"))).unwrap();
        assert_eq!(flac[0]["fallback"], true);
        assert_eq!(flac[0]["requestedFormat"], serde_json::json!(["flac"]));
    }

    #[test]
    fn mime_normalisation_maps_containers() {
        assert_eq!(normalize_format("audio/mpeg"), "mp3");
        // Node checks `opus` before `ogg` inside a MIME string, so a codecs
        // parameter naming opus wins over the container. Kept for parity.
        assert_eq!(normalize_format("audio/ogg; codecs=opus"), "opus");
        assert_eq!(normalize_format("audio/ogg"), "ogg");
        assert_eq!(normalize_format(".flac"), "flac");
        assert_eq!(normalize_format("lossless"), "lossless");
        assert_eq!(normalize_format(""), "");
    }

    #[test]
    fn lossless_keyword_matches_hires_renditions() {
        let wav = Rendition {
            rendition_id: "r".into(),
            entry_id: "e".into(),
            internal_entry_id: "i".into(),
            logical_path: "a.wav".into(),
            kind: "audio".into(),
            title: None,
            format: "wav".into(),
            mime: "audio/wav".into(),
            priority: 0,
            asset_id: None,
            sha256: None,
            bytes: None,
            rel_path: None,
        };
        let list = vec![&wav];
        let chosen = choose_rendition(&list, Some(&serde_json::json!("lossless")));
        assert_eq!(chosen.rendition.map(|item| item.format.as_str()), Some("wav"));
    }
}
