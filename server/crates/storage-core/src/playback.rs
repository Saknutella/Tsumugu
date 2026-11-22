//! Playback queue and per-work position (`playback.mjs`, E09).
//!
//! Queue and position are *business state* in SQLite, not cache: no cache/GC path
//! may delete them. Only stable IDs are stored — never blob URLs, absolute media
//! URLs or machine paths — so a queue survives a host restart on a different port
//! and a library move to another machine.
//!
//! Reads tolerate deleted/missing work/entry/track and surface explicit missing
//! markers instead of silently dropping rows: a queue that quietly shrinks is
//! indistinguishable from data loss.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::jsonutil::now_iso;

/// Single library-wide queue id (`QUEUE_ID`).
pub const QUEUE_ID: &str = "current";
/// Stored precision, in milliseconds (`POSITION_PRECISION_MS`).
pub const POSITION_PRECISION_MS: i64 = 1;
/// Largest allowed backwards jump without an explicit override.
pub const DEFAULT_MAX_ROLLBACK_SECONDS: f64 = 5.0;

/// Validate a stable identifier.
///
/// Rejecting URLs and absolute paths here is what keeps the queue portable: a
/// `blob:` URL is only valid in the tab that created it, and an absolute path only
/// on the machine that created it.
fn stable_id(value: &Value, label: &str) -> Result<String> {
    let text = match value {
        Value::String(text) if !text.trim().is_empty() => text.trim().to_string(),
        _ => {
            return Err(Error::coded("EQUEUEINVALID", format!("{label} must be a non-empty stable ID")));
        }
    };
    let lower = text.to_lowercase();
    let looks_like_url = lower.starts_with("blob:")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("file:")
        || text.starts_with('/')
        || (text.len() >= 3
            && text.as_bytes()[1] == b':'
            && (text.as_bytes()[2] == b'\\' || text.as_bytes()[2] == b'/'));
    if looks_like_url || text.contains('\\') {
        return Err(Error::coded("EQUEUEINVALID", format!("{label} must not be a URL or absolute path")));
    }
    Ok(text)
}

/// Round to millisecond precision, rejecting non-finite/negative input.
fn round_seconds(seconds: f64) -> Result<f64> {
    if !seconds.is_finite() {
        return Err(Error::coded("EPOSITIONINVALID", "playback seconds must be finite"));
    }
    if seconds < 0.0 {
        return Err(Error::coded("EPOSITIONINVALID", "playback seconds must be >= 0"));
    }
    Ok((seconds * 1000.0).round() / 1000.0)
}

/// One queue item as stored.
struct StoredItem {
    position: i64,
    work_id: String,
    track_id: String,
    entry_id: String,
}

/// Replace the single library queue.
///
/// Input order is preserved unless *every* item carries a numeric
/// `position`/`sortOrder`, in which case that order wins. All-or-nothing avoids a
/// half-sorted queue when only some callers supply positions.
pub fn save_queue(connection: &Connection, items: &[Value], current_index: Option<i64>) -> Result<Value> {
    let positions_present = items.iter().all(|item| {
        item.get("position").and_then(Value::as_i64).is_some()
            || item.get("sortOrder").and_then(Value::as_i64).is_some()
    });
    let mut ordered: Vec<&Value> = items.iter().collect();
    if positions_present {
        ordered.sort_by_key(|item| {
            item.get("position")
                .and_then(Value::as_i64)
                .or_else(|| item.get("sortOrder").and_then(Value::as_i64))
                .unwrap_or(0)
        });
    }

    let mut prepared = Vec::with_capacity(ordered.len());
    for (index, item) in ordered.iter().enumerate() {
        if !item.is_object() {
            return Err(Error::coded("EQUEUEINVALID", format!("queue item {index} must be an object")));
        }
        let work_id = stable_id(item.get("workId").unwrap_or(&Value::Null), "workId")?;
        let track_id = stable_id(item.get("trackId").unwrap_or(&Value::Null), "trackId")?;
        let entry_id = stable_id(item.get("entryId").unwrap_or(&Value::Null), "entryId")?;
        prepared.push(StoredItem { position: index as i64, work_id, track_id, entry_id });
    }

    let previous_index: Option<i64> = connection
        .query_row(
            "SELECT current_index FROM queue_state WHERE queue_id = ?",
            rusqlite::params![QUEUE_ID],
            |row| row.get(0),
        )
        .optional()?;
    let requested_index = current_index.or(previous_index).unwrap_or(0);
    let resolved_index = if prepared.is_empty() {
        0
    } else {
        requested_index.clamp(0, prepared.len() as i64 - 1)
    };
    let timestamp = now_iso();

    connection.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> Result<()> {
        connection.execute("DELETE FROM queue_item WHERE queue_id = ?", rusqlite::params![QUEUE_ID])?;
        connection.execute(
            "INSERT INTO queue_state(queue_id, current_index, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(queue_id) DO UPDATE SET
                current_index = excluded.current_index, updated_at = excluded.updated_at",
            rusqlite::params![QUEUE_ID, resolved_index, timestamp],
        )?;
        for item in &prepared {
            connection.execute(
                "INSERT INTO queue_item(queue_id, position, work_id, track_id, entry_id) VALUES (?, ?, ?, ?, ?)",
                rusqlite::params![QUEUE_ID, item.position, item.work_id, item.track_id, item.entry_id],
            )?;
        }
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
    get_queue(connection)
}

/// Missing-reference report for one queue item.
fn missing_for(connection: &Connection, item: &StoredItem) -> Result<Value> {
    let mut missing: Vec<&str> = Vec::new();
    let work: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT work_id, deleted_at FROM work WHERE work_id = ?",
            rusqlite::params![item.work_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if work.is_none() {
        missing.push("work");
    }
    let track: Option<(String, String)> = connection
        .query_row(
            "SELECT track_id, work_id FROM track WHERE track_id = ?",
            rusqlite::params![item.track_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if track.is_none() {
        missing.push("track");
    } else if let Some((_, track_work)) = &track {
        if work.is_some() && track_work != &item.work_id {
            missing.push("track-work");
        }
    }
    let mut entry_statement = connection
        .prepare("SELECT entry_id, work_id FROM entry WHERE stable_entry_id = ? OR entry_id = ?")?;
    let entries: Vec<(String, String)> = entry_statement
        .query_map(rusqlite::params![item.entry_id, item.entry_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let matched = entries
        .iter()
        .find(|(_, work_id)| work_id == &item.work_id)
        .or_else(|| entries.first());
    if matched.is_none() {
        missing.push("entry");
    } else if let Some((_, entry_work)) = matched {
        if work.is_some() && entry_work != &item.work_id {
            missing.push("entry-work");
        }
    }
    Ok(json!({
        "missing": missing,
        "workDeleted": work.as_ref().map(|(_, deleted)| deleted.is_some()).unwrap_or(false),
        "workExists": work.is_some(),
        "trackExists": track.is_some(),
        "entryExists": matched.is_some(),
    }))
}

/// Read the queue with per-item integrity markers.
///
/// Also returns `currentIndex`, `updatedAt` and a flattened `missing` list, which
/// the caller merges into the array's JSON object form when needed.
pub fn get_queue(connection: &Connection) -> Result<Value> {
    let state: Option<(i64, String)> = connection
        .query_row(
            "SELECT current_index, updated_at FROM queue_state WHERE queue_id = ?",
            rusqlite::params![QUEUE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let mut statement =
        connection.prepare("SELECT * FROM queue_item WHERE queue_id = ? ORDER BY position")?;
    let stored: Vec<StoredItem> = statement
        .query_map(rusqlite::params![QUEUE_ID], |row| {
            Ok(StoredItem {
                position: row.get("position")?,
                work_id: row.get("work_id")?,
                track_id: row.get("track_id")?,
                entry_id: row.get("entry_id")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut items = Vec::with_capacity(stored.len());
    let mut missing_list = Vec::new();
    for item in &stored {
        let missing = missing_for(connection, item)?;
        for field in missing["missing"].as_array().cloned().unwrap_or_default() {
            missing_list.push(json!({
                "position": item.position,
                "field": field,
                "workId": item.work_id,
            }));
        }
        let mut object = json!({
            "position": item.position,
            "sortOrder": item.position,
            "workId": item.work_id,
            "trackId": item.track_id,
            "entryId": item.entry_id,
        });
        if let (Some(target), Some(source)) = (object.as_object_mut(), missing.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        items.push(object);
    }
    // The Node function returns an array with `currentIndex`/`updatedAt`/`missing`
    // hung off it; JSON.stringify drops those, so the wire form is wrapped here
    // where the caller can actually see them.
    Ok(json!({
        "items": items,
        "currentIndex": state.as_ref().map(|(index, _)| *index).unwrap_or(0),
        "updatedAt": state.map(|(_, updated)| updated),
        "missing": missing_list,
    }))
}

/// `getPlaybackPosition`.
pub fn get_playback_position(connection: &Connection, work_id: &str) -> Result<Option<Value>> {
    if work_id.is_empty() {
        return Ok(None);
    }
    let row: Option<(String, Option<String>, f64, Option<i64>, String)> = connection
        .query_row(
            "SELECT work_id, entry_id, seconds, precision_ms, updated_at
             FROM playback_position WHERE work_id = ?",
            rusqlite::params![work_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((work_id_row, entry_id, seconds, precision_ms, updated_at)) = row else {
        return Ok(None);
    };
    let work: Option<Option<String>> = connection
        .query_row(
            "SELECT deleted_at FROM work WHERE work_id = ?",
            rusqlite::params![work_id],
            |row| row.get(0),
        )
        .optional()?;
    let mut entry_missing = false;
    if let Some(current_entry) = &entry_id {
        let mut statement =
            connection.prepare("SELECT entry_id, work_id FROM entry WHERE stable_entry_id = ? OR entry_id = ?")?;
        let matches: Vec<(String, String)> = statement
            .query_map(rusqlite::params![current_entry, current_entry], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        entry_missing = !matches.iter().any(|(_, owner)| owner == &work_id);
    }
    Ok(Some(json!({
        "workId": work_id_row,
        "entryId": entry_id,
        "seconds": seconds,
        "precisionMs": precision_ms.unwrap_or(POSITION_PRECISION_MS),
        "precisionSeconds": 0.001,
        "updatedAt": updated_at,
        "workExists": work.is_some(),
        "workDeleted": work.flatten().is_some(),
        "entryMissing": entry_missing,
        "ignored": false,
    })))
}

/// Options for [`save_playback_position`].
#[derive(Debug, Clone, Default)]
pub struct PositionOptions {
    pub max_rollback_seconds: Option<f64>,
    pub allow_rollback: bool,
}

/// Save a work's playback position.
///
/// A backwards jump larger than `max_rollback_seconds`, or a timestamp older than
/// the stored one, is ignored unless the caller explicitly allows rollback. This
/// prevents a late `timeupdate` from a previous session from rewinding the user.
pub fn save_playback_position(
    connection: &Connection,
    work_id: &Value,
    payload: &Value,
    options: PositionOptions,
) -> Result<Value> {
    let work = stable_id(work_id, "workId")?;
    let seconds_value = payload.get("seconds").cloned().unwrap_or(Value::Null);
    let seconds = match &seconds_value {
        Value::Null => {
            return Err(Error::coded("EPOSITIONINVALID", "playback seconds must be finite"));
        }
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    let seconds = round_seconds(seconds)?;
    let entry_id = match payload.get("entryId") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(stable_id(value, "entryId")?),
    };
    let updated_at = match payload.get("updatedAt") {
        Some(Value::String(text)) if !text.is_empty() => match chrono::DateTime::parse_from_rfc3339(text) {
            Ok(parsed) => parsed.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            Err(_) => now_iso(),
        },
        _ => now_iso(),
    };

    let max_rollback = options.max_rollback_seconds.unwrap_or(DEFAULT_MAX_ROLLBACK_SECONDS);
    if !options.allow_rollback {
        if let Some(existing) = get_playback_position(connection, &work)? {
            let existing_seconds = existing["seconds"].as_f64().unwrap_or(0.0);
            let existing_updated = existing["updatedAt"].as_str().unwrap_or("").to_string();
            let too_old = !existing_updated.is_empty() && updated_at < existing_updated;
            let too_far_back = max_rollback.is_finite() && seconds < existing_seconds - max_rollback;
            if too_old || too_far_back {
                let mut ignored = existing;
                ignored["ignored"] = json!(true);
                ignored["reason"] = json!(if too_old { "stale-timestamp" } else { "rollback-exceeds-max" });
                ignored["requestedSeconds"] = json!(seconds);
                return Ok(ignored);
            }
        }
    }

    connection.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = connection.execute(
        "INSERT INTO playback_position(work_id, entry_id, seconds, precision_ms, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET
            entry_id = excluded.entry_id,
            seconds = excluded.seconds,
            precision_ms = excluded.precision_ms,
            updated_at = excluded.updated_at",
        rusqlite::params![work, entry_id, seconds, POSITION_PRECISION_MS, updated_at],
    );
    match outcome {
        Ok(_) => {
            connection.execute_batch("COMMIT")?;
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(Error::from(error));
        }
    }
    get_playback_position(connection, &work)?.ok_or_else(|| Error::new("position vanished after save"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        schema::enable_pragmas(&connection).unwrap();
        schema::apply_schema(&connection, "lib").unwrap();
        connection
    }

    #[test]
    fn queue_rejects_urls_and_paths() {
        let connection = db();
        let error = save_queue(
            &connection,
            &[serde_json::json!({
                "workId": "blob:http://x", "trackId": "t", "entryId": "e"
            })],
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, Some("EQUEUEINVALID"));

        let abs = save_queue(
            &connection,
            &[serde_json::json!({
                "workId": "w", "trackId": "t", "entryId": "C:\\x"
            })],
            None,
        )
        .unwrap_err();
        assert_eq!(abs.code, Some("EQUEUEINVALID"));
    }

    #[test]
    fn queue_order_and_missing_markers() {
        let connection = db();
        let saved = save_queue(
            &connection,
            &[
                serde_json::json!({ "workId": "w1", "trackId": "t1", "entryId": "e1", "position": 1 }),
                serde_json::json!({ "workId": "w2", "trackId": "t2", "entryId": "e2", "position": 0 }),
            ],
            Some(1),
        )
        .unwrap();
        let items = saved["items"].as_array().unwrap();
        assert_eq!(items[0]["workId"], "w2");
        assert_eq!(saved["currentIndex"], 1);
        // Nothing exists in the library yet, so every item reports its misses.
        assert_eq!(items[0]["missing"], serde_json::json!(["work", "track", "entry"]));
        assert_eq!(items[0]["workExists"], false);
    }

    #[test]
    fn position_rounds_and_blocks_rollback() {
        let connection = db();
        let first = save_playback_position(
            &connection,
            &serde_json::json!("w"),
            &serde_json::json!({"seconds": 10.00049, "entryId": "e"}),
            PositionOptions::default(),
        )
        .unwrap();
        assert_eq!(first["seconds"], 10.0);
        assert_eq!(first["precisionMs"], 1);
        assert_eq!(first["precisionSeconds"], 0.001);

        let rolled = save_playback_position(
            &connection,
            &serde_json::json!("w"),
            &serde_json::json!({"seconds": 1.0}),
            PositionOptions::default(),
        )
        .unwrap();
        assert_eq!(rolled["ignored"], true);
        assert_eq!(rolled["reason"], "rollback-exceeds-max");
        assert_eq!(rolled["seconds"], 10.0);

        let allowed = save_playback_position(
            &connection,
            &serde_json::json!("w"),
            &serde_json::json!({"seconds": 1.0}),
            PositionOptions { allow_rollback: true, max_rollback_seconds: None },
        )
        .unwrap();
        assert_eq!(allowed["seconds"], 1.0);

        let negative = save_playback_position(
            &connection,
            &serde_json::json!("w"),
            &serde_json::json!({"seconds": -1}),
            PositionOptions::default(),
        )
        .unwrap_err();
        assert_eq!(negative.code, Some("EPOSITIONINVALID"));
    }
}
