//! Streaming SHA-256 helpers (`hash.mjs`).
//!
//! The CAS key is always the SHA-256 of the actual bytes; nothing here trusts a
//! caller-supplied hash.

use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::{abort_error, Error, Result};

/// SHA-256 of a UTF-8 string, hex encoded (`sha256Text`).
///
/// Used for the import-plan hash, where the input is a canonical JSON string.
pub fn sha256_text(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex(&hasher.finalize())
}

/// Lowercase hex encoding, matching Node's `digest('hex')`.
pub fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(TABLE[(byte >> 4) as usize] as char);
        out.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Stream a file through SHA-256 and return `(hex, bytes)`.
pub fn hash_file(path: &Path) -> Result<(String, u64)> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut bytes: u64 = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok((hex(&hasher.finalize()), bytes))
}

/// Cancellation seam for imports/backups.
///
/// Node uses `throwIfAborted(signal)`. Rust keeps the same call shape so the port
/// reads the same, but there is no signal object: callers pass the current
/// cancellation flag as a `bool`. This is the smallest interface that preserves
/// "checked before every entry and before commit".
pub fn throw_if_aborted(cancelled: bool) -> Result<()> {
    if cancelled {
        return Err(abort_error());
    }
    Ok(())
}

/// Progress callback shape for streaming copies.
pub struct CopyProgress<'a> {
    pub bytes: u64,
    pub total: u64,
    pub chunk_bytes: usize,
    pub sink: Option<&'a mut dyn FnMut(u64, u64)>,
}

/// Copy `source` to `temp_path` while hashing in one pass, then fsync.
///
/// The destination is only published by the caller after this returns, so a crash
/// mid-copy leaves a `.part` the recovery path can discard. Mirrors
/// `copyToTempAndHash()`; the F1 fault hook is intentionally omitted because
/// fault injection lives in the Node test harness only (see docs/18 "not ported").
pub fn copy_to_temp_and_hash(
    source_path: &Path,
    temp_path: &Path,
    cancelled: bool,
    mut on_progress: Option<&mut dyn FnMut(u64, u64)>,
) -> Result<(String, u64)> {
    throw_if_aborted(cancelled)?;
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let total = std::fs::metadata(source_path)?.len();
    let source = File::open(source_path)?;
    let mut reader = BufReader::new(source);
    // `wx` semantics: create new, fail if it exists. A retry must not silently
    // append to a half-written temp file from a previous attempt.
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::conflict(format!("temp file already exists: {}", temp_path.display()))
            } else {
                Error::from(error)
            }
        })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut bytes: u64 = 0;
    let result = (|| -> Result<()> {
        loop {
            if cancelled {
                return Err(abort_error());
            }
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            bytes += read as u64;
            if let Some(callback) = on_progress.as_deref_mut() {
                callback(bytes, total);
            }
        }
        writer.flush()?;
        writer.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        // Only remove the temp file we created; the caller's source is untouched.
        drop(writer);
        let _ = std::fs::remove_file(temp_path);
        return Err(error);
    }
    drop(writer);
    Ok((hex(&hasher.finalize()), bytes))
}

/// File size, or `None` when missing or not a regular file (`fileSize`).
pub fn file_size(path: &Path) -> Option<u64> {
    match std::fs::metadata(path) {
        Ok(info) if info.is_file() => Some(info.len()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_hash_is_stable() {
        assert_eq!(
            sha256_text("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn file_hash_matches_text_hash_for_same_bytes() {
        let dir = std::env::temp_dir().join(format!("mono-hash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.bin");
        std::fs::write(&path, b"abc").unwrap();
        let (hash, bytes) = hash_file(&path).unwrap();
        assert_eq!(bytes, 3);
        assert_eq!(hash, sha256_text("abc"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
