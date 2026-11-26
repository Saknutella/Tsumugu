//! Versioned work snapshots (`snapshot.mjs`).
//!
//! Snapshot JSON is derived from committed rows and is allowed to lag the DB; it
//! may never roll the DB back. A pair counts as published only when *both* files
//! validate at the same revision — a crash between the two renames leaves a
//! half-written pair, and treating that as published would make a later reader
//! believe a stale revision is current.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::fsutil::{atomic_write_json, read_json};
use crate::jsonutil::now_iso;

/// Snapshot payload schema version (`SNAPSHOT_SCHEMA_VERSION`).
pub const SNAPSHOT_SCHEMA_VERSION: i64 = 1;

/// Paths of the two snapshot files for one work.
pub struct SnapshotPaths {
    pub directory: PathBuf,
    pub work_json: PathBuf,
    pub manifest_json: PathBuf,
}

pub fn snapshot_paths(data_root: &Path, work_id: &str) -> SnapshotPaths {
    let directory = crate::layout::snapshots_root(data_root).join(work_id);
    SnapshotPaths {
        work_json: directory.join("work.json"),
        manifest_json: directory.join("manifest.json"),
        directory,
    }
}

/// The derived model a snapshot is built from (`_snapshotModel`).
pub struct SnapshotModel {
    pub work: Value,
    pub source_refs: Value,
    pub entries: Value,
    pub assets: Value,
    pub user_state: Value,
    pub entry_count: usize,
}

/// Fault injection points kept for parity with the Node tests.
///
/// These are not used by production paths; they exist so the C79-03 crash cases
/// can be reproduced against the Rust implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotFault {
    AfterWorkJson,
    AfterManifest,
    BeforeMark,
}

/// Write both snapshot files and validate the pair.
pub fn write_snapshot_pair(
    data_root: &Path,
    library_id: &str,
    work_id: &str,
    target_revision: i64,
    model: &SnapshotModel,
    fault: Option<SnapshotFault>,
) -> Result<(PathBuf, PathBuf)> {
    let paths = snapshot_paths(data_root, work_id);
    if target_revision < 1 {
        return Err(Error::new("invalid target revision"));
    }
    let created_at = now_iso();
    let work_json = json!({
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "libraryId": library_id,
        "workId": work_id,
        "revision": target_revision,
        "snapshotCreatedAt": created_at,
        "work": model.work,
        "sourceRefs": model.source_refs,
        "entries": model.entries,
        "userState": model.user_state,
    });
    let manifest_json = json!({
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "libraryId": library_id,
        "workId": work_id,
        "revision": target_revision,
        "snapshotCreatedAt": created_at,
        "entries": model.entry_count,
        "assets": model.assets,
    });

    atomic_write_json(&paths.work_json, &work_json)?;
    if fault == Some(SnapshotFault::AfterWorkJson) {
        return Err(Error::coded("ESNAPSHOTFAULT", "injected snapshot fault after work.json"));
    }
    atomic_write_json(&paths.manifest_json, &manifest_json)?;
    if fault == Some(SnapshotFault::AfterManifest) {
        return Err(Error::coded("ESNAPSHOTFAULT", "injected snapshot fault after manifest.json"));
    }

    let work_back = read_json(&paths.work_json, None);
    let manifest_back = read_json(&paths.manifest_json, None);
    let (Some(work_back), Some(manifest_back)) = (work_back, manifest_back) else {
        return Err(Error::new("snapshot pair missing after write"));
    };
    let valid = work_back.get("schemaVersion").and_then(Value::as_i64) == Some(SNAPSHOT_SCHEMA_VERSION)
        && manifest_back.get("schemaVersion").and_then(Value::as_i64) == Some(SNAPSHOT_SCHEMA_VERSION)
        && work_back.get("libraryId").and_then(Value::as_str) == Some(library_id)
        && manifest_back.get("libraryId").and_then(Value::as_str) == Some(library_id)
        && work_back.get("workId").and_then(Value::as_str) == Some(work_id)
        && manifest_back.get("workId").and_then(Value::as_str) == Some(work_id)
        && work_back.get("revision").and_then(Value::as_i64) == Some(target_revision)
        && manifest_back.get("revision").and_then(Value::as_i64) == Some(target_revision);
    if !valid {
        return Err(Error::new(format!("snapshot pair validation failed for {work_id}")));
    }
    if fault == Some(SnapshotFault::BeforeMark) {
        return Err(Error::coded(
            "ESNAPSHOTFAULT",
            "injected snapshot fault before published_revision update",
        ));
    }
    Ok((paths.work_json, paths.manifest_json))
}

/// Validation result for an on-disk pair (`readSnapshotPair`).
pub struct SnapshotPairCheck {
    pub ok: bool,
    pub problems: Vec<String>,
}

/// Read both files and report whether they form a valid pair at `expected_revision`.
pub fn read_snapshot_pair(
    data_root: &Path,
    work_id: &str,
    library_id: Option<&str>,
    expected_revision: Option<i64>,
) -> SnapshotPairCheck {
    let paths = snapshot_paths(data_root, work_id);
    let work_json = read_json(&paths.work_json, None);
    let manifest_json = read_json(&paths.manifest_json, None);
    let mut problems = Vec::new();
    if work_json.is_none() {
        problems.push("work.json missing or unparsable".to_string());
    }
    if manifest_json.is_none() {
        problems.push("manifest.json missing or unparsable".to_string());
    }
    if let (Some(work), Some(manifest)) = (&work_json, &manifest_json) {
        let work_revision = work.get("revision").and_then(Value::as_i64);
        let manifest_revision = manifest.get("revision").and_then(Value::as_i64);
        if work_revision != manifest_revision {
            problems.push("revision pair mismatch".to_string());
        }
        if work.get("workId").and_then(Value::as_str) != Some(work_id)
            || manifest.get("workId").and_then(Value::as_str) != Some(work_id)
        {
            problems.push("workId mismatch".to_string());
        }
        if let Some(expected) = library_id {
            if work.get("libraryId").and_then(Value::as_str) != Some(expected)
                || manifest.get("libraryId").and_then(Value::as_str) != Some(expected)
            {
                problems.push("libraryId mismatch".to_string());
            }
        }
        if let Some(expected) = expected_revision {
            if work_revision != Some(expected) {
                problems.push(format!(
                    "expected revision {expected}, got {}",
                    work_revision.map(|value| value.to_string()).unwrap_or_default()
                ));
            }
        }
    }
    SnapshotPairCheck { ok: problems.is_empty(), problems }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> SnapshotModel {
        SnapshotModel {
            work: json!({"workId": "w1", "revision": 2}),
            source_refs: json!([]),
            entries: json!([]),
            assets: json!([]),
            user_state: Value::Null,
            entry_count: 0,
        }
    }

    #[test]
    fn pair_round_trips_at_same_revision() {
        let root = std::env::temp_dir().join(format!("mono-snap-{}", uuid::Uuid::new_v4()));
        write_snapshot_pair(&root, "lib", "w1", 3, &model(), None).unwrap();
        let check = read_snapshot_pair(&root, "w1", Some("lib"), Some(3));
        assert!(check.ok, "{:?}", check.problems);
        // A different expected revision must be reported, not silently accepted.
        let stale = read_snapshot_pair(&root, "w1", Some("lib"), Some(2));
        assert!(!stale.ok);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn fault_after_work_json_leaves_invalid_pair() {
        let root = std::env::temp_dir().join(format!("mono-snapfault-{}", uuid::Uuid::new_v4()));
        let error = write_snapshot_pair(&root, "lib", "w1", 1, &model(), Some(SnapshotFault::AfterWorkJson));
        assert_eq!(error.unwrap_err().code, Some("ESNAPSHOTFAULT"));
        let check = read_snapshot_pair(&root, "w1", Some("lib"), Some(1));
        assert!(!check.ok);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
