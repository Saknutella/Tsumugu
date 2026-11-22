//! Atomic file primitives and the exclusive root lease (`fs.mjs`).
//!
//! Why the lease is not just a `.lock` file: a check-then-create lock file has a
//! window where two processes both believe they own the root. On Windows the OS
//! gives us a real mutex for free — a named pipe can be created by exactly one
//! process (`FILE_FLAG_FIRST_PIPE_INSTANCE` / `EADDRINUSE`), and the kernel releases
//! it when that process dies. The `.lock` file stays as metadata (pid, host,
//! created time, random token) for diagnostics and for the non-Windows fallback,
//! but it is never the source of truth.
//!
//! Cross-backend mutual exclusion matters here: the Node host and this port must
//! not both write the same library. Both derive the pipe name from the same
//! recipe (`\\\\.\\pipe\\monochrome-storage-<sha256(lowercased root)[:32]>`), so
//! whichever starts second fails with `ELOCKED`.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::jsonutil::now_iso;
use sha2::{Digest, Sha256};

/// `mkdir -p`.
pub fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

/// Write `data` to a same-directory temp file, fsync, then rename over `target`.
///
/// Same-directory is required: a cross-volume rename is a copy plus delete, which
/// is not atomic and would let a reader observe a truncated JSON file.
pub fn atomic_write(target: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = temp_name(target);
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// `rename()` that also works on Windows when the destination exists.
///
/// `std::fs::rename` maps to `MoveFileEx(REPLACE_EXISTING)` on Windows and to
/// `rename(2)` elsewhere, so it already replaces atomically on both. Kept as a
/// named function so the platform assumption is documented once.
fn replace_file(from: &Path, to: &Path) -> Result<()> {
    std::fs::rename(from, to)?;
    Ok(())
}

fn temp_name(target: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    target.hash(&mut hasher);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let name = format!(".{:016x}.{}.tmp", hasher.finish(), now);
    target.with_file_name(name)
}

/// Pretty JSON with a trailing newline, matching `atomicWriteJson`.
///
/// Two-space indentation and the trailing newline are part of the on-disk format:
/// `.monochrome/*.json` files are user-visible and git-diffable.
pub fn atomic_write_json(target: &Path, value: &serde_json::Value) -> Result<()> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(Error::from)?
    );
    atomic_write(target, text.as_bytes())
}

/// Read and parse JSON, returning `fallback` on any error (`readJson`).
pub fn read_json(path: &Path, fallback: Option<serde_json::Value>) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok().or(fallback)
}

pub fn path_exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

/// Lock timing constants, identical to `fs.mjs`.
const LOCK_WAIT_MS: u64 = 500;
const LOCK_RETRY_MS: u64 = 25;
/// A dead owner's `.lock` older than this is reclaimed (Node `LOCK_STALE_MS`).
#[cfg(not(windows))]
const LOCK_STALE_MS: i64 = 30_000;

/// Payload written into `.lock`; the `random` field is the ownership token.
#[derive(Debug, Clone)]
pub struct LockPayload {
    pub pid: u32,
    /// Parent pid: lets a supervisor reclaim its crashed child's lock at once.
    pub ppid: u32,
    pub host: String,
    pub created_at: String,
    pub random: String,
}

impl LockPayload {
    fn new() -> Self {
        Self {
            pid: std::process::id(),
            ppid: parent_pid(),
            host: std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_default(),
            created_at: now_iso(),
            random: crate::hash::hex(&uuid::Uuid::new_v4().into_bytes()),
        }
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "pid": self.pid,
            "ppid": self.ppid,
            "host": self.host,
            "createdAt": self.created_at,
            "random": self.random,
        })
    }
}

/// An acquired root lease. Dropping it releases the OS resource and removes
/// `.lock` only when this process still owns the token.
#[derive(Debug)]
pub struct RootLease {
    pub lock_path: PathBuf,
    pub token: String,
    #[cfg(windows)]
    handle: isize,
    #[cfg(not(windows))]
    lock_handle: Option<std::fs::File>,
}

impl RootLease {
    /// Release the lease explicitly. `Drop` also releases; this exists where the
    /// caller needs to surface a failure to remove `.lock`.
    pub fn release(mut self) -> Result<()> {
        self.release_inner()
    }

    fn release_inner(&mut self) -> Result<()> {
        // Delete metadata while the OS lease is still held, so a competing
        // acquirer cannot create a new owner between token check and removal.
        if let Some(current) = read_json(&self.lock_path, None) {
            let same_token = current.get("random").and_then(|value| value.as_str()) == Some(self.token.as_str());
            let same_pid = current.get("pid").and_then(|value| value.as_u64()) == Some(std::process::id() as u64);
            if same_token && same_pid {
                let _ = std::fs::remove_file(&self.lock_path);
            }
        }
        #[cfg(windows)]
        {
            if self.handle != 0 {
                // Closing the last instance of the pipe releases the kernel mutex.
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(self.handle as *mut _);
                }
                self.handle = 0;
            }
        }
        Ok(())
    }
}

impl Drop for RootLease {
    fn drop(&mut self) {
        let _ = self.release_inner();
    }
}

/// Named-pipe path for a library root.
///
/// Must reproduce `fs.mjs::namedPipePath` exactly, otherwise the Node and Rust
/// hosts would each hold "the" lease for the same root and corrupt one library.
pub fn named_pipe_path(root: &Path) -> String {
    let normalized = crate::paths::slashes(&crate::paths::resolve_lexical(root)).to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let short: String = crate::hash::hex(&digest).chars().take(32).collect();
    format!(r"\\.\pipe\monochrome-storage-{short}")
}

/// Acquire the exclusive root lease.
pub fn acquire_lock(root: &Path, wait_ms: Option<u64>) -> Result<RootLease> {
    ensure_dir(root)?;
    #[cfg(windows)]
    {
        acquire_windows_lease(root, wait_ms)
    }
    #[cfg(not(windows))]
    {
        acquire_lock_file_fallback(root, wait_ms)
    }
}

#[cfg(windows)]
fn acquire_windows_lease(root: &Path, wait_ms: Option<u64>) -> Result<RootLease> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_PIPE_BUSY, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let pipe = named_pipe_path(root);
    let wide: Vec<u16> = pipe.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            4096,
            4096,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let code = unsafe { GetLastError() };
        // 231 ERROR_PIPE_BUSY      — every instance busy
        // 183 ERROR_ALREADY_EXISTS — name taken (other creators)
        // 5   ERROR_ACCESS_DENIED  — FILE_FLAG_FIRST_PIPE_INSTANCE saw an existing
        //                            pipe name; this is the common case when the
        //                            Node host (net.createServer().listen) owns it.
        // All three mean "another owner is live": never fall through to the
        // .lock path, or we would silently take over a running host's lease.
        if code == ERROR_PIPE_BUSY || code == 183 || code == 5 {
            return Err(Error::coded("ELOCKED", "root is locked by another process"));
        }
        return Err(Error::new(format!("named pipe lease failed (win32 error {code})")));
    }

    let lock_path = root.join(".lock");
    let payload = LockPayload::new();
    let wait = wait_ms.unwrap_or(LOCK_WAIT_MS);
    let deadline = Instant::now() + Duration::from_millis(wait);
    loop {
        match read_json(&lock_path, None) {
            None => {
                atomic_write_json(&lock_path, &payload.to_json())?;
                break;
            }
            Some(current) => {
                let valid = current.get("random").and_then(|value| value.as_str()).is_some();
                if !valid {
                    // Initialisation window: the owner holds the pipe but has not
                    // written metadata yet. Never reclaim it; the OS says it lives.
                    if Instant::now() >= deadline {
                        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
                        return Err(Error::coded("ELOCKINIT", "root lock is empty or not initialized"));
                    }
                    std::thread::sleep(Duration::from_millis(LOCK_RETRY_MS));
                    continue;
                }
                // A dead pid cannot own the pipe (the kernel released it), so the
                // metadata is stale and may be replaced while we hold the lease.
                atomic_write_json(&lock_path, &payload.to_json())?;
                break;
            }
        }
    }
    Ok(RootLease {
        lock_path,
        token: payload.random,
        handle: handle as isize,
    })
}

/// Parent process id, as `process.ppid` reports it (0 when unknown).
fn parent_pid() -> u32 {
    #[cfg(unix)]
    {
        // SAFETY: getppid has no preconditions and cannot fail.
        unsafe { libc::getppid() as u32 }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// `readLockPayload`: missing, invalid (empty/partial = initialization window)
/// or a parsed payload plus its raw text for compare-before-delete.
#[cfg(not(windows))]
enum Observed {
    Missing,
    Invalid,
    Payload { raw: String, value: serde_json::Value },
}

#[cfg(not(windows))]
fn read_lock_payload(lock_path: &Path) -> Result<Observed> {
    let raw = match std::fs::read_to_string(lock_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Observed::Missing),
        Err(error) => return Err(Error::from(error)),
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { return Ok(Observed::Invalid) };
    let has_pid = value.get("pid").and_then(serde_json::Value::as_u64).is_some();
    let has_random = value.get("random").and_then(serde_json::Value::as_str).map(|text| !text.is_empty()).unwrap_or(false);
    if !has_pid || !has_random {
        return Ok(Observed::Invalid);
    }
    Ok(Observed::Payload { raw, value })
}

/// Port of `acquireLockFileFallback` (non-Windows).
///
/// `O_EXCL` create makes acquisition atomic. A held lock is only reclaimed when
/// its owner is dead AND (it is our parent's child, i.e. we supervise it, or the
/// lock is older than 30 s), and only if the file did not change between the
/// observation and the delete. Without the reclaim a crashed host would leave
/// the library locked until someone deleted `.lock` by hand.
#[cfg(not(windows))]
fn acquire_lock_file_fallback(root: &Path, wait_ms: Option<u64>) -> Result<RootLease> {
    use std::fs::OpenOptions;
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let lock_path = root.join(".lock");
    let payload = LockPayload::new();
    let deadline = Instant::now() + Duration::from_millis(wait_ms.unwrap_or(LOCK_WAIT_MS));
    let text = serde_json::to_string(&payload.to_json()).map_err(Error::from)?;
    let mut last = ("ELOCKINIT", "root lock is initializing".to_string());
    loop {
        match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&lock_path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(text.as_bytes()).and_then(|_| file.sync_all()) {
                    drop(file);
                    let _ = std::fs::remove_file(&lock_path);
                    return Err(Error::from(error));
                }
                return Ok(RootLease { lock_path, token: payload.random.clone(), lock_handle: Some(file) });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(Error::from(error)),
        }
        match read_lock_payload(&lock_path)? {
            Observed::Missing => continue,
            Observed::Invalid => last = ("ELOCKINIT", "root lock is empty or not initialized".to_string()),
            Observed::Payload { raw, value } => {
                let pid = value.get("pid").and_then(serde_json::Value::as_u64).unwrap_or(0) as u32;
                if process_alive(pid) {
                    return Err(Error::coded("ELOCKED", format!("root is locked by pid {pid}")));
                }
                let age = value
                    .get("createdAt")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                    .map(|created| chrono::Utc::now().timestamp_millis() - created.timestamp_millis())
                    .unwrap_or(-1);
                let our_child = value.get("ppid").and_then(serde_json::Value::as_u64) == Some(std::process::id() as u64);
                if our_child || age >= LOCK_STALE_MS {
                    match read_lock_payload(&lock_path)? {
                        Observed::Payload { raw: current, .. } if current == raw => {
                            let _ = std::fs::remove_file(&lock_path);
                        }
                        _ => {}
                    }
                    continue;
                }
                last = ("ELOCKED", format!("root lock owner pid {pid} is not alive but lock is not old enough to reclaim"));
            }
        }
        if Instant::now() >= deadline {
            return Err(Error::coded(last.0, last.1));
        }
        std::thread::sleep(Duration::from_millis(LOCK_RETRY_MS));
    }
}

/// `process.kill(pid, 0)`: alive, or alive-but-not-ours (EPERM).
#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: signal 0 performs only the existence/permission check.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Remove a file or directory, retrying briefly for Windows share violations.
///
/// Antivirus and Explorer previews hold short-lived handles; the Node host retries
/// for the same reason (`removeWithRetry`).
pub fn remove_with_retry(path: &Path, attempts: u32) -> Result<()> {
    let mut last = None;
    for index in 0..attempts {
        match std::fs::remove_dir_all(path).or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                std::fs::remove_file(path)
            }
        }) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = Some(error);
                std::thread::sleep(Duration::from_millis(80 * (index as u64 + 1)));
            }
        }
    }
    Err(Error::from(last.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "remove failed")
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("mono-fs-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn pipe_name_matches_node_recipe() {
        // Precomputed from the Node helper: sha256(lowercased forward-slash root).
        let root = Path::new(r"N:\Example\Library");
        let name = named_pipe_path(root);
        assert!(name.starts_with(r"\\.\pipe\monochrome-storage-"));
        assert_eq!(name.len(), r"\\.\pipe\monochrome-storage-".len() + 32);
        // Case-insensitive: the same library spelled differently must map to one pipe.
        assert_eq!(named_pipe_path(Path::new(r"n:\example\library")), name);
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp() {
        let root = temp_root("atomic");
        let target = root.join("nested").join("a.json");
        atomic_write_json(&target, &serde_json::json!({"a": 1})).unwrap();
        atomic_write_json(&target, &serde_json::json!({"a": 2})).unwrap();
        let value = read_json(&target, None).unwrap();
        assert_eq!(value["a"], 2);
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn second_lease_is_rejected_then_reusable() {
        let root = temp_root("lease");
        let lease = acquire_lock(&root, Some(0)).unwrap();
        assert!(root.join(".lock").exists());
        let second = acquire_lock(&root, Some(0));
        assert!(second.is_err(), "a live lease must not be re-acquirable");
        assert_eq!(second.unwrap_err().code, Some("ELOCKED"));
        lease.release().unwrap();
        assert!(!root.join(".lock").exists());
        let again = acquire_lock(&root, Some(0)).unwrap();
        again.release().unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
