//! Resumable download core (port of `download.mjs`, E11).
//!
//! Bytes are staged in a task-owned `.part` file, hashed incrementally, and
//! only published to CAS after commit validates size and SHA-256. No final
//! asset/ref exists on cancel, early EOF or network failure.
//!
//! The `.part` file plus its `.meta.json` sidecar are the resume state: the
//! SQLite row says *which* task, the sidecar remembers the validator
//! (`ETag`/`Last-Modified`) a `Range` resume must match. Both formats are the
//! Node ones, so a task started by one backend resumes in the other.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use storage_core::error::{Error, Result};
use storage_core::hash::{hash_file, hex};
use storage_core::jsonutil::now_iso;
use storage_core::library::Library;
use storage_core::paths;

use crate::net;

/// Strip a weak prefix and surrounding quotes (`normalizeVersion`).
pub fn normalize_version(value: &str) -> String {
    let value = value.strip_prefix("W/").unwrap_or(value);
    let value = value.strip_prefix('"').unwrap_or(value);
    value.strip_suffix('"').unwrap_or(value).to_string()
}

/// Loopback-only download sources (`isLoopbackDownloadUrl`).
///
/// The download route exists for tests and the local Kikoeru bridge; letting it
/// fetch arbitrary hosts would turn the storage host into an open proxy.
pub fn is_loopback_download_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        // `[::1]:port`
        match stripped.split_once(']') {
            Some((inner, _)) => format!("[{inner}]"),
            None => return false,
        }
    } else {
        host_port.split(':').next().unwrap_or("").to_string()
    };
    matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]")
}

#[derive(Debug, Clone)]
struct EntryRow {
    entry_id: String,
    work_id: String,
    mime: Option<String>,
}

/// Internal id first, then a unique stable id (`resolveEntry`).
fn resolve_entry(library: &Library, entry_id: &str) -> Result<Option<EntryRow>> {
    let map = |row: &rusqlite::Row| {
        Ok(EntryRow { entry_id: row.get(0)?, work_id: row.get(1)?, mime: row.get(2)? })
    };
    if let Some(row) = library
        .connection
        .query_row("SELECT entry_id, work_id, mime FROM entry WHERE entry_id = ?", [entry_id], map)
        .optional()?
    {
        return Ok(Some(row));
    }
    let mut statement = library
        .connection
        .prepare("SELECT entry_id, work_id, mime FROM entry WHERE stable_entry_id = ? LIMIT 2")?;
    let rows = statement.query_map([entry_id], map)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(if rows.len() == 1 { rows.into_iter().next() } else { None })
}

fn sidecar_path(part_path: &Path) -> PathBuf {
    let mut name = part_path.as_os_str().to_os_string();
    name.push(".meta.json");
    PathBuf::from(name)
}

fn read_meta(part_path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(sidecar_path(part_path)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Download state machine. Field names mirror `DownloadTask` in Node.
pub struct DownloadTask {
    pub task_id: String,
    pub entry_id: String,
    pub source_url: String,
    pub source_version: String,
    pub etag: String,
    pub last_modified: String,
    pub expected_bytes: Option<u64>,
    pub progress: u64,
    pub part_path: PathBuf,
    pub status: String,
    pub final_sha: Option<String>,
    pub restarted: bool,
    pub restart_reason: Option<String>,
    pub incomplete: bool,
    hash: Sha256,
}

impl DownloadTask {
    fn write_meta(&self) -> Result<()> {
        let meta = json!({
            "taskId": self.task_id,
            "entryId": self.entry_id,
            "sourceUrl": self.source_url,
            "sourceVersion": self.source_version,
            "etag": self.etag,
            "lastModified": self.last_modified,
            "expectedBytes": self.expected_bytes,
            "updatedAt": now_iso(),
        });
        let mut text = serde_json::to_string_pretty(&meta)?;
        text.push('\n');
        std::fs::write(sidecar_path(&self.part_path), text)?;
        Ok(())
    }

    fn update(&self, library: &Library) -> Result<()> {
        library.connection.execute(
            "UPDATE download_task SET
                status = ?, source_version = ?, part_path = ?, progress = ?,
                expected_bytes = ?, final_sha256 = ?, updated_at = ?
             WHERE task_id = ?",
            rusqlite::params![
                self.status,
                if self.source_version.is_empty() { None } else { Some(&self.source_version) },
                self.part_path.to_string_lossy(),
                self.progress as i64,
                self.expected_bytes.map(|value| value as i64),
                self.final_sha,
                now_iso(),
                self.task_id
            ],
        )?;
        Ok(())
    }

    fn set_status(&mut self, library: &Library, status: &str) -> Result<()> {
        self.status = status.to_string();
        self.update(library)
    }

    fn fail(&mut self, library: &Library, status: &str, code: &'static str, message: String) -> Error {
        let _ = self.set_status(library, status);
        if status == "incomplete" {
            self.incomplete = true;
        }
        Error::coded(code, message)
    }

    fn reset_part(&mut self, library: &Library) -> Result<()> {
        let _ = std::fs::remove_file(&self.part_path);
        if let Some(parent) = self.part_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        File::create(&self.part_path)?;
        self.progress = 0;
        self.hash = Sha256::new();
        self.final_sha = None;
        self.set_status(library, "in_progress")
    }

    fn resume_headers(&self) -> Vec<(&'static str, String)> {
        let mut headers = vec![("Accept-Encoding", "identity".to_string())];
        if self.progress > 0 {
            headers.push(("Range", format!("bytes={}-", self.progress)));
            if !self.etag.is_empty() {
                headers.push(("If-Range", self.etag.clone()));
            } else if !self.last_modified.is_empty() {
                headers.push(("If-Range", self.last_modified.clone()));
            }
        }
        headers
    }

    fn write_chunk(&mut self, file: &mut File, chunk: &[u8]) -> Result<()> {
        if chunk.is_empty() {
            return Ok(());
        }
        if let Some(expected) = self.expected_bytes {
            if self.progress + chunk.len() as u64 > expected {
                return Err(Error::coded(
                    "ESIZE",
                    format!("download exceeds expectedBytes ({}+{}>{expected})", self.progress, chunk.len()),
                ));
            }
        }
        file.seek(SeekFrom::Start(self.progress))?;
        file.write_all(chunk)?;
        self.hash.update(chunk);
        self.progress += chunk.len() as u64;
        Ok(())
    }

    /// Re-read an existing `.part` so progress and the running hash match disk.
    fn rehash_part(&mut self) -> Result<()> {
        self.hash = Sha256::new();
        self.progress = 0;
        let Ok(mut file) = File::open(&self.part_path) else { return Ok(()) };
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            self.hash.update(&buffer[..read]);
            self.progress += read as u64;
        }
        Ok(())
    }

    fn fetch_from(&mut self, library: &Library, mut start: u64, retried: bool) -> Result<()> {
        let response = match net::get_streaming(&self.source_url, &self.resume_headers()) {
            Ok(response) => response,
            Err(error) => {
                let _ = self.set_status(library, "error");
                return Err(error);
            }
        };
        let total_match = parse_content_range(&response.content_range);
        let response_total = if response.status == 206 {
            total_match.map(|(_, _, total)| total)
        } else if response.status == 200 {
            response.content_length
        } else {
            None
        };
        if !(200..300).contains(&response.status) {
            let code = if response.status == 416 { "ERANGE" } else { "EHTTP" };
            return Err(self.fail(library, "error", code, format!("download HTTP {}", response.status)));
        }

        let incoming = {
            let etag = normalize_version(&response.etag);
            if etag.is_empty() { normalize_version(&response.last_modified) } else { etag }
        };
        let expected_version = normalize_version(&self.source_version);
        let previous = {
            let etag = normalize_version(&self.etag);
            if etag.is_empty() { normalize_version(&self.last_modified) } else { etag }
        };
        let restart = |task: &mut Self, reason: &str, response: &net::Streaming| -> Result<()> {
            task.restarted = true;
            task.restart_reason = Some(reason.to_string());
            task.reset_part(library)?;
            if !response.etag.is_empty() {
                task.etag = response.etag.clone();
            }
            if !response.last_modified.is_empty() {
                task.last_modified = response.last_modified.clone();
            }
            if let Some(total) = response_total {
                task.expected_bytes = Some(total);
            }
            Ok(())
        };
        if start > 0 && !previous.is_empty() && !incoming.is_empty() && previous != incoming {
            if !retried {
                restart(self, "version-changed", &response)?;
                if !incoming.is_empty() {
                    self.source_version = incoming;
                }
                drop(response);
                return self.fetch_from(library, 0, true);
            }
            return Err(self.fail(library, "error", "ESOURCE_CHANGED", "source version changed during resume".to_string()));
        }
        if !expected_version.is_empty() && !incoming.is_empty() && expected_version != incoming {
            if start > 0 && !retried {
                restart(self, "version-changed", &response)?;
                self.source_version = incoming;
                drop(response);
                return self.fetch_from(library, 0, true);
            }
            return Err(self.fail(
                library,
                "error",
                "ESOURCE_CHANGED",
                format!("source version mismatch: expected {}, got {incoming}", self.source_version),
            ));
        }
        if let (Some(expected), Some(total)) = (self.expected_bytes, response_total) {
            if expected != total {
                return Err(self.fail(
                    library,
                    "error",
                    "ESOURCE_CHANGED",
                    format!("source size changed: expected {expected}, server {total}"),
                ));
            }
        }
        if start > 0 && response.status == 206 {
            let valid = total_match.map(|(first, _, _)| first == start).unwrap_or(false);
            if !valid {
                if !retried {
                    self.restarted = true;
                    self.restart_reason = Some("invalid-resume-range".to_string());
                    self.reset_part(library)?;
                    drop(response);
                    return self.fetch_from(library, 0, true);
                }
                return Err(self.fail(library, "error", "ERANGE", "server returned an invalid resume range".to_string()));
            }
        }
        if start > 0 && response.status == 200 {
            // Ignored Range: restart safely from zero, never append a full body.
            self.restarted = true;
            self.restart_reason = Some("server-ignored-range".to_string());
            self.reset_part(library)?;
            start = 0;
        }
        let _ = start;
        if !response.etag.is_empty() {
            self.etag = response.etag.clone();
        }
        if !response.last_modified.is_empty() {
            self.last_modified = response.last_modified.clone();
        }
        if self.expected_bytes.is_none() {
            self.expected_bytes = response_total;
        }
        self.write_meta()?;

        let mut file = OpenOptions::new().create(true).read(true).write(true).open(&self.part_path)?;
        let mut body = response.body;
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            let read = match body.read(&mut buffer) {
                Ok(read) => read,
                Err(error) => {
                    let _ = file.sync_all();
                    if self.expected_bytes.map(|expected| self.progress < expected).unwrap_or(false) {
                        return Err(self.fail(library, "incomplete", "EEARLYEOF", error.to_string()));
                    }
                    return Err(self.fail(library, "error", "EHTTP", error.to_string()));
                }
            };
            if read == 0 {
                break;
            }
            if let Err(error) = self.write_chunk(&mut file, &buffer[..read]) {
                let _ = file.sync_all();
                let _ = self.set_status(library, "error");
                return Err(error);
            }
            // Node updates the row per chunk; per 64 KiB read is the same contract
            // (progress is monotonic and resumable) with far fewer fsyncs.
            self.status = "in_progress".to_string();
            self.update(library)?;
        }
        file.sync_all()?;
        if let Some(expected) = self.expected_bytes {
            if self.progress < expected {
                return Err(self.fail(
                    library,
                    "incomplete",
                    "EEARLYEOF",
                    format!("early EOF: {}/{expected} bytes", self.progress),
                ));
            }
        }
        self.set_status(library, "ready")
    }

    /// Resume (or start) the transfer from the bytes already on disk.
    pub fn resume(&mut self, library: &Library) -> Result<()> {
        if self.status == "completed" {
            return Ok(());
        }
        if self.status == "cancelled" {
            return Err(Error::new("task was cancelled"));
        }
        if let Some(parent) = self.part_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        self.rehash_part()?;
        let start = self.progress;
        self.fetch_from(library, start, false)
    }

    /// Validate size + hash, publish to CAS, and attach the asset in one tx.
    pub fn commit(&mut self, library: &Library) -> Result<()> {
        if self.status == "completed" {
            return Ok(());
        }
        if self.status == "cancelled" {
            return Err(Error::new("task was cancelled"));
        }
        if !self.part_path.is_file() {
            return Err(Error::new("download part is missing"));
        }
        let bytes = std::fs::metadata(&self.part_path)?.len();
        if let Some(expected) = self.expected_bytes {
            if bytes != expected {
                return Err(Error::coded("ESIZE", format!("download size mismatch: {bytes} != {expected}")));
            }
        }
        let (sha256, _) = hash_file(&self.part_path)?;
        let entry = resolve_entry(library, &self.entry_id)?
            .ok_or_else(|| Error::new("entry not found for download commit"))?;
        let rel_path = format!("assets/sha256/{}/{sha256}", &sha256[..2]);
        let destination = library.data_root.join("assets").join("sha256").join(&sha256[..2]).join(&sha256);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if destination.exists() {
            let (existing, existing_bytes) = hash_file(&destination)?;
            if existing != sha256 || existing_bytes != bytes {
                return Err(Error::new("CAS collision/corruption"));
            }
            let _ = std::fs::remove_file(&self.part_path);
        } else {
            // Windows: FlushFileBuffers needs a writable handle; a read-only
            // `File::open` fails with ERROR_ACCESS_DENIED. Drop it before rename.
            OpenOptions::new().write(true).open(&self.part_path)?.sync_all()?;
            std::fs::rename(&self.part_path, &destination)?;
        }
        let timestamp = now_iso();
        library.tx(|| {
            library.connection.execute(
                "INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    sha256,
                    sha256,
                    bytes as i64,
                    entry.mime.clone().filter(|mime| !mime.is_empty()).unwrap_or_else(|| "application/octet-stream".to_string()),
                    rel_path,
                    timestamp
                ],
            )?;
            library.connection.execute(
                "INSERT OR IGNORE INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                 VALUES (?, ?, ?, ?, 'primary')",
                rusqlite::params![format!("{}:ref", self.task_id), entry.work_id, entry.entry_id, sha256],
            )?;
            library.connection.execute(
                "UPDATE download_task SET
                    status = 'completed', progress = ?, expected_bytes = ?, final_sha256 = ?,
                    part_path = ?, updated_at = ?
                 WHERE task_id = ?",
                rusqlite::params![
                    bytes as i64,
                    self.expected_bytes.map(|value| value as i64),
                    sha256,
                    self.part_path.to_string_lossy(),
                    timestamp,
                    self.task_id
                ],
            )?;
            Ok(())
        })?;
        self.status = "completed".to_string();
        self.progress = bytes;
        self.final_sha = Some(sha256);
        let _ = std::fs::remove_file(sidecar_path(&self.part_path));
        Ok(())
    }

    /// Cancel: drop staged bytes; never touches CAS.
    pub fn cancel(&mut self, library: &Library) -> Result<()> {
        if self.status == "completed" {
            return Err(Error::new("completed task cannot be cancelled"));
        }
        self.set_status(library, "cancelled")?;
        let _ = std::fs::remove_file(&self.part_path);
        let _ = std::fs::remove_file(sidecar_path(&self.part_path));
        Ok(())
    }

    /// Hash of the bytes written so far (diagnostics/tests).
    pub fn running_sha256(&self) -> String {
        hex(&self.hash.clone().finalize())
    }
}

/// `bytes <first>-<last>/<total>` (case-insensitive, Node's regex).
fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower.strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let (first, last) = range.split_once('-')?;
    Some((first.trim().parse().ok()?, last.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// Options for [`begin_download`].
#[derive(Debug, Default, Clone)]
pub struct BeginOptions {
    pub source_url: String,
    pub expected_bytes: Option<u64>,
    pub source_version: Option<String>,
    pub task_id: Option<String>,
}

/// Create a task row and an empty `.part` (`beginDownload`).
pub fn begin_download(library: &Library, entry_id: &str, options: &BeginOptions) -> Result<DownloadTask> {
    if options.source_url.is_empty() {
        return Err(Error::new("sourceUrl is required"));
    }
    let entry = resolve_entry(library, entry_id)?.ok_or_else(|| Error::new("entry not found"))?;
    let task_id = options.task_id.clone().unwrap_or_else(|| {
        format!(
            "download-{}-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        )
    });
    let tmp = library.data_root.join("tmp");
    let part_path = tmp.join(format!("{task_id}.part"));
    if !paths::is_inside(&tmp, &part_path) {
        return Err(Error::new("invalid download temp path"));
    }
    std::fs::create_dir_all(&tmp)?;
    let _ = std::fs::remove_file(&part_path);
    let timestamp = now_iso();
    library.connection.execute(
        "INSERT INTO download_task(
            task_id, entry_id, source_version, part_path, progress,
            expected_bytes, final_sha256, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, NULL, 'pending', ?, ?)",
        rusqlite::params![
            task_id,
            entry.entry_id,
            options.source_version,
            part_path.to_string_lossy(),
            options.expected_bytes.map(|value| value as i64),
            timestamp,
            timestamp
        ],
    )?;
    let task = DownloadTask {
        task_id,
        entry_id: entry.entry_id,
        source_url: options.source_url.clone(),
        source_version: options.source_version.clone().unwrap_or_default(),
        etag: String::new(),
        last_modified: String::new(),
        expected_bytes: options.expected_bytes,
        progress: 0,
        part_path,
        status: "pending".to_string(),
        final_sha: None,
        restarted: false,
        restart_reason: None,
        incomplete: false,
        hash: Sha256::new(),
    };
    task.write_meta()?;
    Ok(task)
}

/// Load a task by id, restoring resume state from its sidecar (`loadDownload`).
pub fn load_download(library: &Library, task_id: &str) -> Result<Option<DownloadTask>> {
    let row = library
        .connection
        .query_row(
            "SELECT task_id, entry_id, source_version, part_path, progress, expected_bytes, final_sha256, status
             FROM download_task WHERE task_id = ?",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((task_id, entry_id, source_version, part_path, progress, expected, final_sha, status)) = row else {
        return Ok(None);
    };
    let part_path = part_path
        .map(PathBuf::from)
        .unwrap_or_else(|| library.data_root.join("tmp").join(format!("download-{task_id}.part")));
    let meta = read_meta(&part_path).unwrap_or(Value::Null);
    let text = |key: &str| meta.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let mut task = DownloadTask {
        task_id,
        entry_id: entry_id.unwrap_or_default(),
        source_url: text("sourceUrl"),
        source_version: source_version.filter(|value| !value.is_empty()).unwrap_or_else(|| text("sourceVersion")),
        etag: text("etag"),
        last_modified: text("lastModified"),
        expected_bytes: expected
            .filter(|value| *value > 0)
            .map(|value| value as u64)
            .or_else(|| meta.get("expectedBytes").and_then(Value::as_u64).filter(|value| *value > 0)),
        progress: progress.max(0) as u64,
        part_path,
        status,
        final_sha,
        restarted: false,
        restart_reason: None,
        incomplete: false,
        hash: Sha256::new(),
    };
    if task.part_path.is_file() {
        task.rehash_part()?;
    }
    Ok(Some(task))
}

/// One-shot `beginDownload → resume → commit`, the `/api/download` route.
pub fn download_entry(library: &Library, entry_id: &str, options: &BeginOptions) -> Result<Value> {
    if options.source_url.is_empty() {
        return Err(Error::new("sourceUrl is required"));
    }
    if !is_loopback_download_url(&options.source_url) {
        return Err(Error::coded("ELOOPBACK", "download sourceUrl must be a loopback HTTP(S) URL"));
    }
    let mut task = begin_download(library, entry_id, options)?;
    task.resume(library)?;
    task.commit(library)?;
    Ok(json!({
        "taskId": task.task_id,
        "entryId": task.entry_id,
        "status": task.status,
        "assetId": task.final_sha,
        "sha256": task.final_sha,
        "bytes": task.progress,
        "expectedBytes": task.expected_bytes,
        "sourceVersion": task.source_version,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_normalize_like_node() {
        assert_eq!(normalize_version("W/\"abc\""), "abc");
        assert_eq!(normalize_version("\"abc\""), "abc");
        assert_eq!(normalize_version("abc"), "abc");
    }

    #[test]
    fn only_loopback_sources_are_allowed() {
        assert!(is_loopback_download_url("http://127.0.0.1:8080/a"));
        assert!(is_loopback_download_url("https://localhost/a"));
        assert!(is_loopback_download_url("http://[::1]:9/a"));
        assert!(!is_loopback_download_url("http://127.0.0.1.evil.invalid/a"));
        assert!(!is_loopback_download_url("http://user@evil.invalid/a"));
        assert!(!is_loopback_download_url("http://evil.invalid/?h=127.0.0.1"));
        assert!(!is_loopback_download_url("file:///etc/passwd"));
        // `user@127.0.0.1` still targets loopback; userinfo is not the host.
        assert!(is_loopback_download_url("http://user@127.0.0.1/a"));
    }

    #[test]
    fn content_range_parses_node_shape() {
        assert_eq!(parse_content_range("bytes 10-19/20"), Some((10, 19, 20)));
        assert_eq!(parse_content_range("BYTES 0-0/1"), Some((0, 0, 1)));
        assert_eq!(parse_content_range("bytes */20"), None);
    }

    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use storage_core::library::{OpenOptions, SourceRecord};

    /// Loopback server with Range + ETag. `state` = (body, etag, ignore_range).
    fn serve(state: Arc<Mutex<(Vec<u8>, String, bool)>>, requests: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file.bin", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for _ in 0..requests {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut range_start: Option<usize> = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("range: bytes=") {
                        range_start = value.trim().trim_end_matches('-').parse().ok();
                    }
                }
                let (body, etag, ignore_range) = state.lock().unwrap().clone();
                let etag_line = if etag.is_empty() { String::new() } else { format!("ETag: {etag}\r\n") };
                let reply = match range_start.filter(|_| !ignore_range) {
                    Some(start) => {
                        let part = &body[start.min(body.len())..];
                        let mut head = format!(
                            "HTTP/1.1 206 Partial Content\r\n{etag_line}Content-Range: bytes {start}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len() - 1,
                            body.len(),
                            part.len()
                        )
                        .into_bytes();
                        head.extend_from_slice(part);
                        head
                    }
                    None => {
                        let mut head = format!(
                            "HTTP/1.1 200 OK\r\n{etag_line}Content-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .into_bytes();
                        head.extend_from_slice(&body);
                        head
                    }
                };
                let _ = stream.write_all(&reply);
            }
        });
        url
    }

    fn library_with_entry(tag: &str) -> (Library, PathBuf, String) {
        let root = std::env::temp_dir().join(format!("mono-dl-{tag}-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("01.mp3"), b"placeholder").unwrap();
        let mut library = Library::open(
            root.join("library"),
            OpenOptions { create: true, allow_outside_root: true, ..Default::default() },
        )
        .unwrap();
        let record = SourceRecord::from_json(&json!({
            "provider": "dlsite", "sourceCode": "RJ00000009", "title": "Download fixture",
            "entries": [{ "entryId": "dl-1", "logicalPath": "01.mp3", "kind": "audio", "mime": "audio/mpeg",
                          "sourcePath": source.join("01.mp3").to_string_lossy() }]
        }))
        .unwrap();
        library.import_work(record, "dl-key").unwrap();
        (library, root, "dl-1".to_string())
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    #[test]
    fn full_download_publishes_to_cas_and_refs_the_entry() {
        let (library, root, entry) = library_with_entry("full");
        let body: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let url = serve(Arc::new(Mutex::new((body.clone(), "\"v1\"".to_string(), false))), 1);
        let options = BeginOptions { source_url: url, expected_bytes: Some(5000), ..Default::default() };
        let result = download_entry(&library, &entry, &options).unwrap();
        assert_eq!(result["status"], "completed");
        assert_eq!(result["sha256"], sha(&body));
        let digest = sha(&body);
        let cas = library.data_root.join("assets").join("sha256").join(&digest[..2]).join(&digest);
        assert_eq!(std::fs::read(&cas).unwrap(), body);
        let refs: i64 = library
            .connection
            .query_row(
                "SELECT COUNT(*) FROM asset_ref r JOIN entry e ON e.entry_id = r.entry_id
                 WHERE e.stable_entry_id = 'dl-1' AND r.asset_id = ?",
                [&digest],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(refs, 1);
        drop(library);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resume_continues_from_the_part_file_with_range() {
        let (library, root, entry) = library_with_entry("resume");
        let body: Vec<u8> = (0..4096u32).map(|i| (i * 7 % 256) as u8).collect();
        let url = serve(Arc::new(Mutex::new((body.clone(), "\"v1\"".to_string(), false))), 1);
        let options = BeginOptions { source_url: url, expected_bytes: Some(4096), ..Default::default() };
        let mut task = begin_download(&library, &entry, &options).unwrap();
        // An interrupted first attempt: 1000 bytes staged and the validator known.
        std::fs::write(&task.part_path, &body[..1000]).unwrap();
        task.etag = "\"v1\"".to_string();
        task.write_meta().unwrap();
        let mut reloaded = load_download(&library, &task.task_id).unwrap().unwrap();
        assert_eq!(reloaded.progress, 1000);
        assert_eq!(reloaded.etag, "\"v1\"");
        reloaded.resume(&library).unwrap();
        assert!(!reloaded.restarted, "a matching validator must resume, not restart");
        reloaded.commit(&library).unwrap();
        assert_eq!(reloaded.final_sha.as_deref(), Some(sha(&body).as_str()));
        drop(library);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn changed_validator_restarts_from_zero_instead_of_splicing() {
        let (library, root, entry) = library_with_entry("version");
        let fresh: Vec<u8> = vec![b'n'; 3000];
        let url = serve(Arc::new(Mutex::new((fresh.clone(), "\"v2\"".to_string(), false))), 2);
        let task = begin_download(&library, &entry, &BeginOptions { source_url: url, ..Default::default() }).unwrap();
        std::fs::write(&task.part_path, vec![b'o'; 1200]).unwrap();
        let mut stale = load_download(&library, &task.task_id).unwrap().unwrap();
        stale.etag = "\"v1\"".to_string();
        stale.resume(&library).unwrap();
        assert!(stale.restarted);
        assert_eq!(stale.restart_reason.as_deref(), Some("version-changed"));
        stale.commit(&library).unwrap();
        assert_eq!(stale.final_sha.as_deref(), Some(sha(&fresh).as_str()));
        drop(library);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ignored_range_restarts_and_short_body_is_never_published() {
        let (library, root, entry) = library_with_entry("ignored");
        let body: Vec<u8> = vec![b'z'; 2000];
        let url = serve(Arc::new(Mutex::new((body, String::new(), true))), 1);
        let options = BeginOptions { source_url: url, expected_bytes: Some(2000), ..Default::default() };
        let task = begin_download(&library, &entry, &options).unwrap();
        std::fs::write(&task.part_path, vec![b'z'; 500]).unwrap();
        let mut reloaded = load_download(&library, &task.task_id).unwrap().unwrap();
        reloaded.resume(&library).unwrap();
        assert_eq!(reloaded.restart_reason.as_deref(), Some("server-ignored-range"));
        assert_eq!(reloaded.progress, 2000);

        // The server reports 10 bytes while 20 are expected: refused, nothing published.
        let short = serve(Arc::new(Mutex::new((vec![b'q'; 10], String::new(), false))), 1);
        let options = BeginOptions { source_url: short, expected_bytes: Some(20), ..Default::default() };
        let mut partial = begin_download(&library, &entry, &options).unwrap();
        let error = partial.resume(&library).err().unwrap();
        assert!(matches!(error.code, Some("EEARLYEOF") | Some("ESOURCE_CHANGED")), "{error:?}");
        assert!(partial.commit(&library).is_err());
        drop(library);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn non_loopback_sources_are_refused_before_any_row() {
        let (library, root, entry) = library_with_entry("refuse");
        let options = BeginOptions { source_url: "https://example.invalid/x".to_string(), ..Default::default() };
        let error = download_entry(&library, &entry, &options).err().unwrap();
        assert_eq!(error.code, Some("ELOOPBACK"));
        let rows: i64 = library
            .connection
            .query_row("SELECT COUNT(*) FROM download_task", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        drop(library);
        let _ = std::fs::remove_dir_all(root);
    }
}
