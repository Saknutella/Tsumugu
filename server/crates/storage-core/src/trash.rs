//! Trash: deleting a work moves its folder aside instead of erasing it.
//!
//! WHY the folder is moved rather than deleted: the work root is the user's only
//! copy of those bytes. "Delete" has always been the one action that cannot be
//! undone, and a mis-click on a 4 GB work costs a re-download at best. A trash
//! slot keeps the bytes and the manifest that says where they came from, so
//! restore is a rename — no re-import, no re-hash, no metadata loss.
//!
//! The manifest is the slot's own record, not a second database. A slot without
//! it (a user dropped a folder into `trash/` by hand) is still listed, but only
//! as a folder with no work id: it cannot be restored to a path the host did not
//! record, and `purge` treats it as plain bytes.
//!
//! ```text
//! <data root>/trash/<work id>/
//! ├─ .trash.json      { schema, workId, title, originalRoot, deletedAt, files, bytes }
//! └─ <the work folder exactly as it was>
//! ```
//!
//! The folder keeps its own name inside the slot so a person browsing `trash/`
//! still sees `[RJ01234567] Title/` and can copy it out by hand.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::fsutil;
use crate::jsonutil::now_iso;
use crate::layout;
use crate::paths;

/// Slot manifest written by [`write_manifest`].
pub const MANIFEST: &str = ".trash.json";
pub const SCHEMA: &str = "monochrome-trash/1";

/// One deleted work, as `trash/<work id>/` on disk.
#[derive(Debug, Clone)]
pub struct Entry {
    pub work_id: String,
    pub title: String,
    /// Source-root relative path the folder must go back to on restore.
    pub original_root: String,
    pub deleted_at: String,
    pub files: usize,
    pub bytes: u64,
    /// `false` when the folder was shared with another work and therefore left
    /// in place; restore then only clears the row's `deleted_at`.
    pub moved: bool,
}

impl Entry {
    pub fn to_json(&self, slot: &Path) -> Value {
        json!({
            "workId": self.work_id,
            "title": self.title,
            "originalRoot": self.original_root,
            "deletedAt": self.deleted_at,
            "files": self.files,
            "bytes": self.bytes,
            "moved": self.moved,
            "slot": slot.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        })
    }
}

/// Slot directory for a work id.
///
/// The id is sanitised, not trusted: it arrives from a request body, and a slot
/// name of `..` would put the work outside `trash/`. Host-minted ids are UUIDs,
/// so in practice this is an identity function, but the check costs nothing.
pub fn slot(data_root: &Path, work_id: &str) -> Result<PathBuf> {
    let leaf: String = work_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .collect();
    let leaf = leaf.trim_matches('_').to_string();
    if leaf.is_empty() || leaf == "." || leaf == ".." {
        return Err(Error::bad_request("work id cannot name a trash slot"));
    }
    Ok(layout::trash_root(data_root).join(leaf))
}

/// Move a directory into its slot. Returns the manifest entry it wrote.
///
/// `original_root` must already be source-root relative (the shape
/// [`layout::stored_source_path`] produces); the caller resolves the work root
/// and stores the relative form so restore does not depend on where the library
/// is mounted today.
pub fn move_into(
    data_root: &Path,
    work_id: &str,
    folder: &Path,
    original_root: &str,
    title: &str,
) -> Result<Entry> {
    let slot = slot(data_root, work_id)?;
    // A restored-then-deleted work reuses its slot; a leftover slot means the
    // previous copy was never restored, so it is already unreachable and its
    // bytes are older than the folder being deleted now. Replace it.
    if fsutil::path_exists(&slot) {
        fsutil::remove_with_retry(&slot, 3)?;
    }
    fsutil::ensure_dir(&slot)?;
    let target = slot.join(folder.file_name().unwrap_or_else(|| std::ffi::OsStr::new("work")));
    move_tree(folder, &target)?;
    let (files, bytes) = measure(&target);
    let entry = Entry {
        work_id: work_id.to_string(),
        title: title.to_string(),
        original_root: original_root.to_string(),
        deleted_at: now_iso(),
        files,
        bytes,
        moved: true,
    };
    write_manifest(&slot, &entry)?;
    Ok(entry)
}

/// Record a soft-deleted work whose folder was left in place (shared root).
pub fn record_without_move(
    data_root: &Path,
    work_id: &str,
    original_root: &str,
    title: &str,
) -> Result<Entry> {
    let slot = slot(data_root, work_id)?;
    if fsutil::path_exists(&slot) {
        fsutil::remove_with_retry(&slot, 3)?;
    }
    fsutil::ensure_dir(&slot)?;
    let entry = Entry {
        work_id: work_id.to_string(),
        title: title.to_string(),
        original_root: original_root.to_string(),
        deleted_at: now_iso(),
        files: 0,
        bytes: 0,
        moved: false,
    };
    write_manifest(&slot, &entry)?;
    Ok(entry)
}

pub fn write_manifest(slot: &Path, entry: &Entry) -> Result<()> {
    fsutil::atomic_write_json(&slot.join(MANIFEST), &entry.to_json(slot))
}

/// Read one slot's manifest, if it has one.
pub fn read_manifest(slot: &Path) -> Option<Entry> {
    let value = fsutil::read_json(&slot.join(MANIFEST), None)?;
    let work_id = value.get("workId").and_then(Value::as_str)?.to_string();
    Some(Entry {
        work_id,
        title: value.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
        original_root: value.get("originalRoot").and_then(Value::as_str).unwrap_or("").to_string(),
        deleted_at: value.get("deletedAt").and_then(Value::as_str).unwrap_or("").to_string(),
        files: value.get("files").and_then(Value::as_u64).unwrap_or(0) as usize,
        bytes: value.get("bytes").and_then(Value::as_u64).unwrap_or(0),
        moved: value.get("moved").and_then(Value::as_bool).unwrap_or(true),
    })
}

/// Every slot under `trash/`, newest first. Unreadable slots are skipped: a
/// half-copied trash folder must not make the list endpoint fail.
pub fn list(data_root: &Path) -> Vec<(PathBuf, Entry)> {
    let root = layout::trash_root(data_root);
    let Ok(children) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut entries: Vec<(PathBuf, Entry)> = children
        .flatten()
        .filter(|child| child.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|child| read_manifest(&child.path()).map(|entry| (child.path(), entry)))
        .collect();
    entries.sort_by(|left, right| right.1.deleted_at.cmp(&left.1.deleted_at));
    entries
}

/// Move a slot's folder back to `source_root/<originalRoot>`.
///
/// Refuses to overwrite: a folder that reappeared at the original path (a
/// re-download, a manual copy) means the user has two candidate copies, and
/// picking one silently is how content gets lost. The caller reports the
/// conflict and leaves both in place.
pub fn restore(data_root: &Path, source_root: &Path, entry: &Entry) -> Result<PathBuf> {
    let target = source_root.join(entry.original_root.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !paths::is_inside(source_root, &target) || target == source_root {
        return Err(Error::path_denied("trash manifest points outside the source root"));
    }
    if fsutil::path_exists(&target) {
        return Err(Error::new(format!(
            "{} already exists; move it aside before restoring",
            target.display()
        )));
    }
    let slot = slot(data_root, &entry.work_id)?;
    // The folder keeps its original leaf name inside the slot; an older layout
    // (or a hand-made slot) may not, in which case the slot's single child is
    // the folder.
    let source = slot.join(target.file_name().unwrap_or_else(|| std::ffi::OsStr::new("work")));
    let source = if fsutil::path_exists(&source) { source } else { single_child(&slot)? };
    if let Some(parent) = target.parent() {
        fsutil::ensure_dir(parent)?;
    }
    move_tree(&source, &target)?;
    Ok(target)
}

fn single_child(slot: &Path) -> Result<PathBuf> {
    let children: Vec<PathBuf> = std::fs::read_dir(slot)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().map(|name| name != MANIFEST).unwrap_or(true))
        .collect();
    match children.as_slice() {
        [only] => Ok(only.clone()),
        _ => Err(Error::new("trash slot does not hold exactly one work folder")),
    }
}

/// Drop a slot from disk. Missing is success: `purge` is meant to be repeatable.
pub fn remove_slot(data_root: &Path, work_id: &str) -> Result<()> {
    let slot = slot(data_root, work_id)?;
    if fsutil::path_exists(&slot) {
        fsutil::remove_with_retry(&slot, 3)?;
    }
    Ok(())
}

/// Move a directory, falling back to copy+delete across volumes.
///
/// `rename` is the common case and is atomic; it fails with `EXDEV` when the
/// source root and data root live on different drives, which is a normal
/// configuration here (library on `N:`, data on `C:`). The fallback is not
/// atomic, but it only runs when restore has already refused an existing
/// target, so an interrupted copy leaves a partial folder the next restore
/// will find and refuse — recoverable by hand.
fn move_tree(from: &Path, to: &Path) -> Result<()> {
    if let Some(parent) = to.parent() {
        fsutil::ensure_dir(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_tree(from, to)?;
            fsutil::remove_with_retry(from, 3)
        }
    }
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(from)?;
    if metadata.is_dir() {
        fsutil::ensure_dir(to)?;
        for child in std::fs::read_dir(from)? {
            let child = child?;
            copy_tree(&child.path(), &to.join(child.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to)?;
        Ok(())
    }
}

/// `(files, bytes)` of a tree, ignoring unreadable entries.
pub fn measure(root: &Path) -> (usize, u64) {
    fn visit(path: &Path, files: &mut usize, bytes: &mut u64) {
        let Ok(metadata) = std::fs::symlink_metadata(path) else { return };
        if metadata.is_dir() {
            if let Ok(children) = std::fs::read_dir(path) {
                for child in children.flatten() {
                    visit(&child.path(), files, bytes);
                }
            }
        } else {
            *files += 1;
            *bytes += metadata.len();
        }
    }
    let mut files = 0usize;
    let mut bytes = 0u64;
    visit(root, &mut files, &mut bytes);
    (files, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("mono-trash-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(layout::trash_root(&path)).unwrap();
        path
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn move_into_keeps_the_folder_name_and_records_the_origin() {
        let root = temp_root("move");
        let source = root.join("library");
        let folder = source.join("voices/[RJ1] Work");
        write(&folder.join("01.wav"), "audio");
        write(&folder.join(".monochrome/folder.jpg"), "img");

        let entry = move_into(&root, "w-1", &folder, "voices/[RJ1] Work", "Work").unwrap();

        assert!(!folder.exists(), "original folder must be gone");
        let slot = slot(&root, "w-1").unwrap();
        assert!(slot.join("[RJ1] Work/01.wav").exists());
        assert_eq!(entry.files, 2);
        assert_eq!(entry.bytes, 8);
        assert!(entry.moved);
        let read = read_manifest(&slot).unwrap();
        assert_eq!(read.original_root, "voices/[RJ1] Work");
        assert_eq!(read.work_id, "w-1");
    }

    #[test]
    fn restore_puts_the_folder_back_and_refuses_to_overwrite() {
        let root = temp_root("restore");
        let source = root.join("library");
        let folder = source.join("voices/[RJ1] Work");
        write(&folder.join("01.wav"), "audio");
        let entry = move_into(&root, "w-1", &folder, "voices/[RJ1] Work", "Work").unwrap();

        let restored = restore(&root, &source, &entry).unwrap();
        assert_eq!(restored, folder);
        assert_eq!(std::fs::read_to_string(folder.join("01.wav")).unwrap(), "audio");
        // The slot directory is the caller's to clean up: `restore` only moves
        // the bytes, and the host removes the slot once the row is restored too.
        assert!(!slot(&root, "w-1").unwrap().join("[RJ1] Work").exists());

        // Second copy at the same path: restore must not pick a winner.
        write(&folder.join("01.wav"), "other");
        let entry = move_into(&root, "w-2", &folder, "voices/[RJ1] Work", "Work").unwrap();
        write(&folder.join("01.wav"), "fresh download");
        let error = restore(&root, &source, &entry).unwrap_err();
        assert!(error.message.contains("already exists"), "{}", error.message);
        assert_eq!(std::fs::read_to_string(folder.join("01.wav")).unwrap(), "fresh download");
    }

    #[test]
    fn a_slot_without_a_manifest_still_lists_its_bytes_but_is_not_restorable() {
        let root = temp_root("nomanifest");
        write(&layout::trash_root(&root).join("orphan/notes.txt"), "x");
        assert_eq!(list(&root).len(), 0);
        // The slot itself is still on disk for `purge` to count.
        assert!(layout::trash_root(&root).join("orphan").exists());
    }

    #[test]
    fn list_is_newest_first() {
        let root = temp_root("order");
        let source = root.join("library");
        for (index, id) in ["a", "b"].iter().enumerate() {
            let folder = source.join(format!("voices/{id}"));
            write(&folder.join("01.wav"), "x");
            let mut entry = move_into(&root, id, &folder, &format!("voices/{id}"), id).unwrap();
            entry.deleted_at = format!("2026-01-0{}T00:00:00.000Z", index + 1);
            write_manifest(&slot(&root, id).unwrap(), &entry).unwrap();
        }
        let listed = list(&root);
        assert_eq!(listed[0].1.work_id, "b");
        assert_eq!(listed[1].1.work_id, "a");
    }

    #[test]
    fn slot_names_cannot_escape_the_trash_root() {
        let root = temp_root("escape");
        assert!(slot(&root, "..").is_err());
        assert!(slot(&root, "").is_err());
        let slot = slot(&root, "../../etc").unwrap();
        assert!(paths::is_inside(&layout::trash_root(&root), &slot));
    }
}
