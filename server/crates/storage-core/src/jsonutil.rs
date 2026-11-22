//! Small JSON helpers that reproduce the Node host's ad-hoc coercion rules.
//!
//! The Node code parses JSON columns with `try { JSON.parse(x) } catch { [] }` in
//! dozens of places. Keeping one helper per shape means the Rust port cannot drift
//! per call site, and makes the "malformed column degrades to empty" contract
//! explicit and testable.

use serde_json::{Map, Value};

/// Parse a JSON column, returning `fallback` when it is empty or malformed.
pub fn parse_or(value: Option<&str>, fallback: Value) -> Value {
    match value {
        Some(text) if !text.is_empty() => serde_json::from_str::<Value>(text).unwrap_or(fallback),
        _ => fallback,
    }
}

/// Parse a JSON column expected to hold an object (`user_meta_json`).
pub fn parse_object(value: Option<&str>) -> Map<String, Value> {
    match parse_or(value, Value::Object(Map::new())) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Parse a JSON column expected to hold a string array (`cv_json`).
///
/// Non-string items are coerced with `String(item)`, matching the Node code that
/// runs `cv_json` through `JSON.parse` and then treats entries as strings.
pub fn parse_string_array(value: Option<&str>) -> Vec<String> {
    match parse_or(value, Value::Array(Vec::new())) {
        Value::Array(items) => items.iter().map(string_of).collect(),
        _ => Vec::new(),
    }
}

/// `String(value)` for a JSON scalar, used where Node relies on implicit coercion.
pub fn string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Trim a string value, matching `typeof x === 'string' ? x.trim() : fallback`.
pub fn trimmed(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => fallback.to_string(),
    }
}

/// Coerce a JSON value to a number the way `Number(x)` does for finite inputs.
///
/// Returns `None` for null/bool/objects, which Node would turn into `NaN` and the
/// storage code then treats as "unset".
pub fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// `{ ...a, ...b }` for JSON objects, with `b` winning; non-objects are ignored.
pub fn merge_objects(base: &Map<String, Value>, overlay: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = base.clone();
    for (key, value) in overlay {
        merged.insert(key.clone(), value.clone());
    }
    merged
}

/// Deduplicate trimmed, non-empty strings preserving first-seen order.
///
/// Mirrors `[...new Set(values.map(v => String(v).trim()).filter(Boolean))]` from
/// `updateWorkMetadata()`.
pub fn unique_trimmed(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if !seen.contains(&trimmed) {
            seen.push(trimmed);
        }
    }
    seen
}

/// Parse `{ version, entries }` / `entries` / array forms into a manifest entry list.
///
/// The Node code accepts all three shapes (`manifestEntries()` in file-storage.js
/// and the `Array.isArray(meta.manifest) ? meta.manifest : meta.manifest.entries`
/// idiom in host.mjs). Keeping one parser prevents the port from only handling the
/// shape the author happened to test.
pub fn manifest_entries(meta: &Map<String, Value>) -> Option<Vec<Value>> {
    match meta.get("manifest") {
        Some(Value::Array(items)) => Some(items.clone()),
        Some(Value::Object(object)) => match object.get("entries") {
            Some(Value::Array(items)) => Some(items.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Current UTC timestamp in the ISO-8601 form Node produces (`toISOString()`).
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_shapes_are_all_accepted() {
        let array = serde_json::json!({ "manifest": [{ "logicalPath": "a.mp3" }] });
        let object = serde_json::json!({ "manifest": { "version": 2, "entries": [{ "logicalPath": "b.mp3" }] } });
        let missing = serde_json::json!({});
        assert_eq!(manifest_entries(array.as_object().unwrap()).unwrap().len(), 1);
        assert_eq!(manifest_entries(object.as_object().unwrap()).unwrap().len(), 1);
        assert!(manifest_entries(missing.as_object().unwrap()).is_none());
    }

    #[test]
    fn malformed_json_degrades_to_empty() {
        assert!(parse_object(Some("{not json")).is_empty());
        assert!(parse_string_array(Some("[1,2")).is_empty());
        assert_eq!(parse_string_array(Some(r#"["a","b"]"#)), vec!["a", "b"]);
    }

    #[test]
    fn unique_trimmed_matches_set_semantics() {
        let values = vec![" a ".to_string(), "a".to_string(), "".to_string(), "b".to_string()];
        assert_eq!(unique_trimmed(values), vec!["a", "b"]);
    }
}
