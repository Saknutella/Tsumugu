//! Error type shared by the core, host and HTTP layers.
//!
//! The Node host communicates failures as `{code, message}` and maps `code` to an
//! HTTP status in `host-server.mjs::errorStatus()`. Preserving the code strings is
//! therefore part of the wire contract, not an implementation detail: the
//! frontend only reads `error.message`, but the harness diffs `code` as well.
//!
//! Deviation (see docs/18-server.md D1): Node returns 500 for `ENOTFOUND`
//! because `errorStatus()` never lists it. Rust maps it to 404. The status mapping
//! lives in `storage-http`; this crate only carries the code.

use std::fmt;

/// Machine-readable error code plus a human message.
///
/// `code` mirrors the `error.code` strings Node throws (`EBADREQUEST`,
/// `EPATHDENIED`, `ENOTFOUND`, …). `None` means the Node side never set a code on
/// that error path and the HTTP layer falls back to `EINTERNAL`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: Option<&'static str>,
    pub message: String,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into() }
    }

    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self { code: Some(code), message: message.into() }
    }

    /// `EBADREQUEST` — malformed input that the caller can fix.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::coded("EBADREQUEST", message)
    }

    /// `EBADJSON` — body present but not valid JSON.
    pub fn bad_json(message: impl Into<String>) -> Self {
        Self::coded("EBADJSON", message)
    }

    /// `EPATHDENIED` — a path escaped its allowed root or violated policy.
    pub fn path_denied(message: impl Into<String>) -> Self {
        Self::coded("EPATHDENIED", message)
    }

    /// `ENOTFOUND` — the addressed row/file does not exist.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::coded("ENOTFOUND", message)
    }

    /// `ECONFLICT` — state conflict, rendered as 409.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::coded("ECONFLICT", message)
    }

    /// `EOUTSIDE` — outside the experiment root and not authorized.
    pub fn outside(message: impl Into<String>) -> Self {
        Self::coded("EOUTSIDE", message)
    }

    /// `EOUTSIDEROOT` — library root outside the experiment root.
    pub fn outside_root(message: impl Into<String>) -> Self {
        Self::coded("EOUTSIDEROOT", message)
    }

    pub fn code_or_internal(&self) -> &'static str {
        self.code.unwrap_or("EINTERNAL")
    }

    /// True when the error came from an aborted import (`EABORTED`).
    pub fn is_aborted(&self) -> bool {
        self.code == Some("EABORTED")
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

/// Convert any `Display` error into an uncoded [`Error`].
///
/// Un-coded errors become HTTP 500, matching Node's `EINTERNAL` fallback. Call
/// sites that know the semantic code must construct it explicitly.
impl From<std::io::Error> for Error {
    /// Keep Node's errno code for "not found": `errorStatus` maps `ENOENT` to 400,
    /// and a code-less error would surface as a 500 instead.
    fn from(value: std::io::Error) -> Self {
        if value.kind() == std::io::ErrorKind::NotFound {
            return Self::coded("ENOENT", format!("ENOENT: no such file or directory ({value})"));
        }
        Self::new(value.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::new(value.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::new(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Aborted-import error, matching `hash.mjs::abortError()`.
pub fn abort_error() -> Error {
    Error::coded("EABORTED", "import cancelled before commit")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_map_to_wire_strings() {
        assert_eq!(Error::not_found("x").code_or_internal(), "ENOTFOUND");
        assert_eq!(Error::conflict("x").code_or_internal(), "ECONFLICT");
        assert_eq!(Error::new("x").code_or_internal(), "EINTERNAL");
        assert!(abort_error().is_aborted());
    }
}
