//! Read-only local voice scanner / preview (port of `scan.mjs`, 79-S2).
//!
//! Never touches SQLite, never hashes bytes, never writes, renames or follows a
//! symlink/junction. It enumerates the authorized tree, identifies candidate
//! work roots and returns a preview for the UI/import layer to confirm; every
//! later I/O re-validates its own path boundary. The JSON shape and key order
//! are the Node ones (`serde_json` keeps insertion order), because the
//! frontend and `/api/import` consume this preview verbatim.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;

use storage_core::error::{Error, Result};
use storage_core::paths;

use crate::cover::locale_cmp;

const AUDIO_EXTENSIONS: &[&str] = &[".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus", ".wma", ".aiff", ".aif"];
const SUBTITLE_EXTENSIONS: &[&str] = &[".srt", ".vtt", ".ass", ".ssa", ".lrc", ".sub"];
const IMAGE_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff"];
const ARCHIVE_EXTENSIONS: &[&str] = &[".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"];
const METADATA_JSON_NAMES: &[&str] = &["metadata.json", "meta.json", "work.json", "info.json", "source.json", "release.json"];
const METADATA_TEXT_NAMES: &[&str] = &["info.txt", "metadata.txt", "readme.txt", "info.nfo"];
const STRUCTURAL_NAMES: &[&str] = &[
    "音声本体", "音声", "wav", "mp3", "flac", "aac", "ogg", "opus", "字幕", "subtitle", "subtitles", "画像", "image",
    "images", "特典", "bonus", "omake", "se", "bgm", "sound", "audio", "voice", "voices", "cover", "covers", "scan",
    "scans", "booklet", "manual", "歌词", "lyrics",
];
/// `tmp` is here on purpose: the Kikoeru pipeline stages unfinished files in
/// `<work>/tmp/`, and a scan must never offer them as entries.
const EXCLUDED_DIR_NAMES: &[&str] = &[
    "library", "assets", "tmp", "cache", "index", "trash", "exports", "quarantine", ".git", "node_modules",
    "$recycle.bin", "system volume information",
];
const SYSTEM_FILE_NAMES: &[&str] = &["thumbs.db", "desktop.ini", ".ds_store"];
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_HEAD_BYTES: usize = 256 * 1024;

fn normalized_name(value: &str) -> String {
    value.nfkc().collect::<String>().trim().to_lowercase()
}

/// `path.extname(name).toLowerCase()`: last dot, not a leading one.
fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(index) if index > 0 => name[index..].to_lowercase(),
        _ => String::new(),
    }
}

fn stem_of(name: &str) -> String {
    match name.rfind('.') {
        Some(index) if index > 0 => name[..index].to_string(),
        _ => name.to_string(),
    }
}

fn kind_of(name: &str) -> &'static str {
    let extension = extension_of(name);
    let extension = extension.as_str();
    if AUDIO_EXTENSIONS.contains(&extension) {
        "audio"
    } else if SUBTITLE_EXTENSIONS.contains(&extension) {
        "subtitle"
    } else if IMAGE_EXTENSIONS.contains(&extension) {
        "image"
    } else if ARCHIVE_EXTENSIONS.contains(&extension) {
        "archive"
    } else {
        // The preview enum is audio|subtitle|image|archive|extra; sidecars are
        // parsed by name and do not get a sixth kind.
        "extra"
    }
}

/// `RJ` + 5..8 digits, not preceded by an alphanumeric, not followed by a digit.
pub fn extract_rj(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index + 1 < chars.len() {
        let is_rj = chars[index].eq_ignore_ascii_case(&'r') && chars[index + 1].eq_ignore_ascii_case(&'j');
        let left_ok = index == 0 || !chars[index - 1].is_ascii_alphanumeric();
        if is_rj && left_ok {
            let digits: String = chars[index + 2..].iter().take_while(|ch| ch.is_ascii_digit()).collect();
            // `\d{5,8}(?![0-9])`: a longer digit run backtracks to fail, so it is
            // only a match when the whole run is 5..8 long.
            if (5..=8).contains(&digits.chars().count()) {
                return Some(format!("RJ{digits}"));
            }
        }
        index += 1;
    }
    None
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for value in values {
        let text = value.trim().to_string();
        if text.is_empty() || !seen.insert(text.to_lowercase()) {
            continue;
        }
        result.push(text);
    }
    result
}

fn split_cvs(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => unique_strings(items.iter().flat_map(split_cvs)),
        Value::Null => Vec::new(),
        Value::String(text) if text.is_empty() => Vec::new(),
        other => {
            let text = match other {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            unique_strings(text.split([',', '，', '、', ';', '/', '|']).map(str::to_string))
        }
    }
}

fn is_open(ch: char) -> bool {
    matches!(ch, '[' | '(' | '（' | '【')
}
fn is_close(ch: char) -> bool {
    matches!(ch, ']' | ')' | '）' | '】')
}

/// `^\s*[\[(（【]\s*RJ\d{5,8}\s*[\])）】]\s*` (case-insensitive).
fn strip_leading_rj_bracket(title: &str) -> String {
    let mut chars = title.char_indices().peekable();
    let Some((_, open)) = chars.next() else { return title.to_string() };
    if !is_open(open) {
        return title.to_string();
    }
    let rest = &title[open.len_utf8()..];
    let inner = rest.trim_start();
    let lower = inner.to_ascii_lowercase();
    if !lower.starts_with("rj") {
        return title.to_string();
    }
    let digits: String = inner[2..].chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if !(5..=8).contains(&digits.len()) {
        return title.to_string();
    }
    let after = inner[2 + digits.len()..].trim_start();
    let Some(close) = after.chars().next().filter(|ch| is_close(*ch)) else { return title.to_string() };
    after[close.len_utf8()..].trim_start().to_string()
}

/// `^[\[(（【][^\])）】]{1,80}[\])）】]\s*` — one leading bracket group.
fn strip_leading_bracket_group(title: &str) -> String {
    let mut iter = title.chars();
    let Some(open) = iter.next() else { return title.to_string() };
    if !is_open(open) {
        return title.to_string();
    }
    let mut length = 0usize;
    let mut offset = open.len_utf8();
    for ch in iter {
        if is_close(ch) {
            if (1..=80).contains(&length) {
                return title[offset + ch.len_utf8()..].trim_start().to_string();
            }
            return title.to_string();
        }
        length += 1;
        offset += ch.len_utf8();
        if length > 80 {
            return title.to_string();
        }
    }
    title.to_string()
}

/// `\s*[\[(（【](?:RJ\d{5,8}|\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)[\])）】]\s*$`.
fn strip_trailing_code_or_date(title: &str) -> String {
    let trimmed = title.trim_end();
    let Some(close) = trimmed.chars().next_back().filter(|ch| is_close(*ch)) else { return title.to_string() };
    let body_end = trimmed.len() - close.len_utf8();
    let Some(open_index) = trimmed[..body_end].rfind(is_open) else { return title.to_string() };
    let open_len = trimmed[open_index..].chars().next().map(char::len_utf8).unwrap_or(1);
    let inner = &trimmed[open_index + open_len..body_end];
    let is_code = {
        let lower = inner.to_ascii_lowercase();
        lower.starts_with("rj") && (5..=8).contains(&inner[2..].len()) && inner[2..].chars().all(|ch| ch.is_ascii_digit())
    };
    let is_date = {
        let parts: Vec<&str> = inner.split(['-', '/', '.']).collect();
        let separators_ok = inner.chars().filter(|ch| matches!(ch, '-' | '/' | '.')).count() == parts.len().saturating_sub(1);
        separators_ok
            && (parts.len() == 2 || parts.len() == 3)
            && parts[0].len() == 4
            && parts[0].chars().all(|ch| ch.is_ascii_digit())
            && parts[1..].iter().all(|part| (1..=2).contains(&part.len()) && part.chars().all(|ch| ch.is_ascii_digit()))
    };
    if !(is_code || is_date) {
        return title.to_string();
    }
    trimmed[..open_index].trim_end().to_string()
}

/// `\b<code>\b` removal, case-insensitive (`cleanFolderTitle`).
fn strip_word(title: &str, word: &str) -> String {
    let lower = title.to_lowercase();
    let needle = word.to_lowercase();
    let is_word = |ch: char| ch.is_ascii_alphanumeric() || ch == '_';
    let mut search = 0;
    while let Some(found) = lower[search..].find(&needle) {
        let start = search + found;
        let end = start + needle.len();
        let left_ok = !lower[..start].chars().next_back().map(is_word).unwrap_or(false);
        let right_ok = !lower[end..].chars().next().map(is_word).unwrap_or(false);
        // `\b` also needs a word char at the edge of the needle itself.
        let edges = needle.chars().next().map(is_word).unwrap_or(false) && needle.chars().next_back().map(is_word).unwrap_or(false);
        if left_ok && right_ok && edges && title.is_char_boundary(start) && title.is_char_boundary(end) {
            return format!("{}{}", &title[..start], &title[end..]);
        }
        search = start + needle.len().max(1);
        if search >= lower.len() {
            break;
        }
    }
    title.to_string()
}

pub fn clean_folder_title(name: &str, source_code: Option<&str>) -> String {
    let mut title: String = name.nfkc().collect::<String>().trim().to_string();
    if title.is_empty() {
        return "Untitled local work".to_string();
    }
    title = strip_leading_rj_bracket(&title);
    if let Some(code) = source_code.filter(|code| !code.is_empty()) {
        title = strip_word(&title, code).trim().to_string();
    }
    title = strip_leading_bracket_group(&title).trim().to_string();
    title = strip_trailing_code_or_date(&title).trim().to_string();
    if title.is_empty() { "Untitled local work".to_string() } else { title }
}

/// `^\s*[\[(（【]\s*([^\])）】]{1,80}?)\s*[\])）】]` — a leading circle group.
pub fn parse_circle_from_name(name: &str) -> String {
    let trimmed = name.trim_start();
    let mut chars = trimmed.chars();
    let Some(open) = chars.next().filter(|ch| is_open(*ch)) else { return String::new() };
    let rest = &trimmed[open.len_utf8()..];
    let Some(close_index) = rest.find(is_close) else { return String::new() };
    let candidate = rest[..close_index].trim();
    let count = rest[..close_index].trim_start().chars().count();
    if candidate.is_empty() || count == 0 || count > 80 {
        return String::new();
    }
    if extract_rj(candidate).is_some() {
        return String::new();
    }
    let digits: String = candidate.chars().take(4).collect();
    let after = candidate.chars().nth(4);
    let date_like = digits.len() == 4
        && digits.chars().all(|ch| ch.is_ascii_digit())
        && matches!(after, Some('-' | '/' | '.'))
        && candidate.chars().nth(5).map(|ch| ch.is_ascii_digit()).unwrap_or(false);
    if date_like {
        return String::new();
    }
    candidate.to_string()
}

fn read_head(path: &Path, max: usize) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let mut buffer = Vec::with_capacity(max.min(64 * 1024));
    file.by_ref().take(max as u64).read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// Best-effort dimensions from a file head (`imageSizeFromHead`). Unlike
/// `cover.rs` this does not validate the whole image: it only feeds the preview.
fn image_size_from_head(buffer: &[u8], extension: &str) -> Option<(i64, i64)> {
    let u16le = |offset: usize| buffer.get(offset..offset + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as i64);
    let u16be = |offset: usize| buffer.get(offset..offset + 2).map(|s| u16::from_be_bytes([s[0], s[1]]) as i64);
    let u32be = |offset: usize| buffer.get(offset..offset + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]) as i64);
    let i32le = |offset: usize| buffer.get(offset..offset + 4).map(|s| i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as i64);
    let u24le = |offset: usize| buffer.get(offset..offset + 3).map(|s| s[0] as i64 | (s[1] as i64) << 8 | (s[2] as i64) << 16);
    match extension {
        ".png" if buffer.len() >= 24 => {
            (u32be(0)? == 0x8950_4e47).then(|| (u32be(16).unwrap_or(0), u32be(20).unwrap_or(0)))
        }
        ".gif" if buffer.len() >= 10 => (&buffer[0..3] == b"GIF").then(|| (u16le(6).unwrap_or(0), u16le(8).unwrap_or(0))),
        ".bmp" if buffer.len() >= 26 => (&buffer[0..2] == b"BM").then(|| (i32le(18).unwrap_or(0), i32le(22).unwrap_or(0).abs())),
        ".webp" if buffer.len() >= 30 => {
            if &buffer[0..4] != b"RIFF" || &buffer[8..12] != b"WEBP" {
                return None;
            }
            match &buffer[12..16] {
                b"VP8X" => Some((1 + u24le(24)?, 1 + u24le(27)?)),
                b"VP8 " => Some((u16le(26)? & 0x3fff, u16le(28)? & 0x3fff)),
                _ => None,
            }
        }
        ".jpg" | ".jpeg" if buffer.len() >= 4 => {
            if buffer[0] != 0xff || buffer[1] != 0xd8 {
                return None;
            }
            let mut offset = 2usize;
            while offset + 9 < buffer.len() {
                if buffer[offset] != 0xff {
                    offset += 1;
                    continue;
                }
                let marker = buffer[offset + 1];
                if marker == 0xd8 || marker == 0xd9 {
                    offset += 2;
                    continue;
                }
                let length = u16be(offset + 2)? as usize;
                if length < 2 {
                    return None;
                }
                if (0xc0..=0xc3).contains(&marker) {
                    return Some((u16be(offset + 7)?, u16be(offset + 5)?));
                }
                offset += 2 + length;
            }
            None
        }
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct Metadata {
    metadata_file: String,
    title: String,
    circle: String,
    source_code: String,
    cvs: Vec<String>,
    language: String,
    role: String,
}

fn first_present<'a>(raw: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    // `a ?? b ?? c`: the first key that is present and not null.
    keys.iter().filter_map(|key| raw.get(*key)).find(|value| !value.is_null())
}

fn normalize_metadata(raw: &Value, metadata_file: &str) -> Option<Metadata> {
    let raw = raw.as_object()?;
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(|text| text.trim().to_string()).unwrap_or_default();
    let edition = raw.get("edition").and_then(Value::as_object);
    let code = first_present(raw, &["sourceCode", "rj", "productId", "product_id"]);
    let source_code = match code.and_then(Value::as_str) {
        Some(code) => extract_rj(code).unwrap_or_else(|| code.trim().to_uppercase()),
        None => String::new(),
    };
    Some(Metadata {
        metadata_file: metadata_file.to_string(),
        title: text(first_present(raw, &["title", "workTitle", "name", "album"])),
        circle: text(first_present(raw, &["circle", "circleName", "brand", "artist"])),
        source_code,
        cvs: first_present(raw, &["cvs", "cv", "voiceActors", "voice_actors", "cast"]).map(split_cvs).unwrap_or_default(),
        language: text(raw.get("language").filter(|v| !v.is_null()).or_else(|| edition.and_then(|e| e.get("language")))),
        role: text(raw.get("role").filter(|v| !v.is_null()).or_else(|| edition.and_then(|e| e.get("role")))),
    })
}

fn parse_text_metadata(text: &str, metadata_file: &str) -> Metadata {
    let mut result = Metadata {
        metadata_file: metadata_file.to_string(),
        title: String::new(),
        circle: String::new(),
        source_code: String::new(),
        cvs: Vec::new(),
        language: String::new(),
        role: String::new(),
    };
    for line in text.split('\n').take(400) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        // `^\s*([A-Za-z_ ]{2,24})\s*[:=]\s*(.+?)\s*$`
        let Some(separator) = line.find([':', '=']) else { continue };
        let key_raw = line[..separator].trim_start();
        let key_trimmed_end = key_raw.trim_end();
        if !(2..=24).contains(&key_raw.len()) && !(2..=24).contains(&key_trimmed_end.len()) {
            continue;
        }
        if !key_raw.chars().all(|ch| ch.is_ascii_alphabetic() || ch == '_' || ch == ' ') {
            continue;
        }
        let value = line[separator + 1..].trim();
        if value.is_empty() {
            continue;
        }
        let key = key_trimmed_end.to_lowercase();
        let set = |slot: &mut String| {
            if slot.is_empty() {
                *slot = value.to_string();
            }
        };
        match key.as_str() {
            "title" | "name" | "work" | "work title" => set(&mut result.title),
            "circle" | "brand" | "artist" => set(&mut result.circle),
            "cv" | "cvs" | "cast" | "voice actors" => result.cvs.extend(split_cvs(&json!(value))),
            "rj" | "code" | "sourcecode" | "product" => {
                if result.source_code.is_empty() {
                    result.source_code = extract_rj(value).unwrap_or_else(|| value.to_string());
                }
            }
            "language" | "lang" => set(&mut result.language),
            "role" | "edition" => set(&mut result.role),
            _ => {}
        }
    }
    result.cvs = unique_strings(result.cvs);
    result
}

fn read_metadata_file(file: &FileInfo) -> Option<Metadata> {
    let head = read_head(&file.absolute_path, MAX_METADATA_BYTES).ok()?;
    let name = normalized_name(&file.name);
    if METADATA_JSON_NAMES.contains(&name.as_str()) || extension_of(&file.name) == ".json" {
        let parsed: Value = serde_json::from_slice(&head).ok()?;
        return normalize_metadata(&parsed, &file.logical_path);
    }
    if METADATA_TEXT_NAMES.contains(&name.as_str()) {
        return Some(parse_text_metadata(&String::from_utf8_lossy(&head), &file.logical_path));
    }
    None
}

fn is_metadata_name(name: &str) -> bool {
    let name = normalized_name(name);
    METADATA_JSON_NAMES.contains(&name.as_str()) || METADATA_TEXT_NAMES.contains(&name.as_str())
}

fn cover_stem(name: &str) -> String {
    stem_of(name).nfkc().collect::<String>().to_lowercase()
}

fn is_cover_name(name: &str) -> bool {
    matches!(
        cover_stem(name).as_str(),
        "cover" | "folder" | "front" | "front cover" | "jacket" | "package" | "package image" | "表紙" | "封面" | "パッケージ"
            | "パッケージ画像" | "main"
    )
}

fn cover_score(name: &str) -> i64 {
    if matches!(cover_stem(name).as_str(), "cover" | "folder" | "front" | "jacket" | "package" | "表紙" | "封面" | "パッケージ") {
        30
    } else {
        10
    }
}

#[derive(Debug, Clone)]
struct FileInfo {
    name: String,
    absolute_path: PathBuf,
    logical_path: String,
    extension: String,
    size: u64,
    kind: &'static str,
}

#[derive(Debug, Clone)]
struct CoverInfo {
    path: PathBuf,
    name: String,
    score: i64,
    width: Option<i64>,
    height: Option<i64>,
}

#[derive(Debug, Clone)]
struct DirInfo {
    path: PathBuf,
    relative_path: String,
    depth: usize,
    name: String,
    direct_files: Vec<FileInfo>,
    child_dirs: Vec<DirInfo>,
    metadata: Option<Metadata>,
    rj_codes: BTreeSet<String>,
    cover_candidates: Vec<CoverInfo>,
    evidence: Vec<String>,
    ambiguities: Vec<String>,
    excluded: Vec<(String, &'static str)>,
    audio_count: usize,
    entry_count: usize,
    has_direct_content: bool,
    has_descendant_content: bool,
    structural: bool,
    strong: bool,
}

impl DirInfo {
    fn has_metadata_identity(&self) -> bool {
        self.metadata.as_ref().map(|meta| !meta.title.is_empty() || !meta.source_code.is_empty()).unwrap_or(false)
    }
    fn has_metadata_title(&self) -> bool {
        self.metadata.as_ref().map(|meta| !meta.title.is_empty()).unwrap_or(false)
    }
}

struct Rejected {
    path: PathBuf,
    relative_path: String,
    reason: &'static str,
    detail: Option<String>,
}

struct Context {
    source_root: PathBuf,
    library_root: Option<PathBuf>,
    max_depth: usize,
    max_files: usize,
    scanned_files: usize,
    scanned_directories: usize,
    depth_limited: bool,
    file_limited: bool,
    rejected: Vec<Rejected>,
    ambiguities: Vec<String>,
}

impl Context {
    fn reject(&mut self, path: &Path, reason: &'static str, detail: Option<String>) {
        let relative = paths::relative_slash(&self.source_root, path);
        self.rejected.push(Rejected {
            path: path.to_path_buf(),
            relative_path: if relative.is_empty() { ".".to_string() } else { relative },
            reason,
            detail,
        });
    }
}

fn relative_logical(root: &Path, path: &Path) -> String {
    paths::relative_slash(root, path)
}

/// `isSameOrInside` on resolved paths.
fn same_or_inside(parent: &Path, child: &Path) -> bool {
    paths::is_inside(parent, child)
}

fn inspect_directory(absolute: &Path, relative: &str, depth: usize, ctx: &mut Context) -> Option<DirInfo> {
    if ctx.file_limited {
        return None;
    }
    ctx.scanned_directories += 1;
    let name = absolute.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    let mut info = DirInfo {
        path: absolute.to_path_buf(),
        relative_path: if relative.is_empty() { ".".to_string() } else { relative.to_string() },
        depth,
        name: name.clone(),
        direct_files: Vec::new(),
        child_dirs: Vec::new(),
        metadata: None,
        rj_codes: BTreeSet::new(),
        cover_candidates: Vec::new(),
        evidence: Vec::new(),
        ambiguities: Vec::new(),
        excluded: Vec::new(),
        audio_count: 0,
        entry_count: 0,
        has_direct_content: false,
        has_descendant_content: false,
        structural: false,
        strong: false,
    };
    if let Some(code) = extract_rj(&name) {
        info.rj_codes.insert(code);
    }
    let mut names: Vec<String> = match std::fs::read_dir(absolute) {
        Ok(children) => children.flatten().map(|child| child.file_name().to_string_lossy().to_string()).collect(),
        Err(error) => {
            ctx.reject(absolute, "unreadable-directory", Some(error.to_string()));
            return Some(info);
        }
    };
    names.sort_by(|a, b| locale_cmp(a, b));

    for name in names {
        if ctx.file_limited {
            break;
        }
        let child = absolute.join(&name);
        let child_relative = relative_logical(&ctx.source_root, &child);
        if SYSTEM_FILE_NAMES.contains(&normalized_name(&name).as_str()) {
            continue;
        }
        if EXCLUDED_DIR_NAMES.contains(&normalized_name(&name).as_str()) {
            // Still stat, so a *file* named "cache" is not treated as a directory.
            if std::fs::symlink_metadata(&child).map(|meta| meta.is_dir()).unwrap_or(false) {
                info.excluded.push((child_relative.clone(), "excluded-directory"));
                ctx.reject(&child, "excluded-directory", None);
            }
            continue;
        }
        if let Some(library) = &ctx.library_root {
            if same_or_inside(library, &child) {
                // The whole library root is excluded; never follow it.
                info.excluded.push((child_relative, "library-root"));
                ctx.reject(&child, "library-root", None);
                continue;
            }
        }
        let meta = match std::fs::symlink_metadata(&child) {
            Ok(meta) => meta,
            Err(error) => {
                ctx.reject(&child, "unreadable-entry", Some(error.to_string()));
                continue;
            }
        };
        if meta.file_type().is_symlink() || paths::assert_no_reparse(&child, false).is_err() {
            ctx.reject(&child, "symlink-or-junction", None);
            info.excluded.push((child_relative, "symlink-or-junction"));
            continue;
        }
        if meta.is_dir() {
            if depth >= ctx.max_depth {
                ctx.depth_limited = true;
                ctx.reject(&child, "max-depth", None);
                info.excluded.push((child_relative, "max-depth"));
                continue;
            }
            if let Some(dir) = inspect_directory(&child, &child_relative, depth + 1, ctx) {
                info.child_dirs.push(dir);
            }
            continue;
        }
        if !meta.is_file() {
            ctx.reject(&child, "not-regular-file", None);
            continue;
        }
        if ctx.scanned_files >= ctx.max_files {
            ctx.file_limited = true;
            break;
        }
        ctx.scanned_files += 1;
        let kind = kind_of(&name);
        let file = FileInfo {
            name: name.clone(),
            absolute_path: child.clone(),
            logical_path: relative_logical(absolute, &child),
            extension: extension_of(&name),
            size: meta.len(),
            kind,
        };
        if let Some(code) = extract_rj(&name) {
            info.rj_codes.insert(code);
        }
        if kind == "image" && is_cover_name(&name) {
            let size = read_head(&child, MAX_IMAGE_HEAD_BYTES)
                .ok()
                .and_then(|head| image_size_from_head(&head, &file.extension))
                .filter(|(width, height)| *width > 0 && *height > 0);
            info.cover_candidates.push(CoverInfo {
                path: child.clone(),
                name: name.clone(),
                score: cover_score(&name),
                width: size.map(|(width, _)| width),
                height: size.map(|(_, height)| height),
            });
        }
        info.direct_files.push(file);
    }

    // Sidecar metadata is read only after the file list is known; it supplies
    // display candidates and never authorizes a path.
    for file in info.direct_files.clone() {
        if !is_metadata_name(&file.name) {
            continue;
        }
        let Some(metadata) = read_metadata_file(&file) else { continue };
        if let Some(code) = extract_rj(&metadata.source_code) {
            info.rj_codes.insert(code);
        }
        info.metadata = Some(metadata);
        break;
    }

    info.audio_count = info.direct_files.iter().filter(|file| file.kind == "audio").count()
        + info.child_dirs.iter().map(|child| child.audio_count).sum::<usize>();
    info.entry_count = count_entries(&info);
    let cover_count = count_covers(&info);
    info.has_direct_content = !info.direct_files.is_empty();
    info.has_descendant_content = info.has_direct_content || info.child_dirs.iter().any(|child| child.entry_count > 0);
    info.structural = STRUCTURAL_NAMES.contains(&normalized_name(&info.name).as_str()) || is_sidecar_dir(&info.name);
    info.strong = !info.rj_codes.is_empty()
        || info.has_metadata_identity()
        || (!info.cover_candidates.is_empty() && info.audio_count > 0 && !info.structural);
    if info.rj_codes.len() > 1 {
        info.ambiguities.push(format!("rj-conflict:{}", info.rj_codes.iter().cloned().collect::<Vec<_>>().join(",")));
    }
    if info.has_metadata_title() {
        info.evidence.push(format!("metadata:{}", info.metadata.as_ref().unwrap().metadata_file));
    }
    for code in &info.rj_codes {
        info.evidence.push(format!("rj:{code}"));
    }
    if info.audio_count > 0 {
        info.evidence.push(format!("audio:{}", info.audio_count));
    }
    if cover_count > 0 {
        info.evidence.push(format!("cover:{cover_count}"));
    }
    if info.evidence.is_empty() && info.entry_count > 0 {
        info.evidence.push("files:present".to_string());
    }
    if info.structural {
        info.evidence.push(format!("structural:{}", normalized_name(&info.name)));
    }
    Some(info)
}

fn is_sidecar_dir(name: &str) -> bool {
    normalized_name(name) == ".monochrome"
}

fn count_entries(info: &DirInfo) -> usize {
    info.direct_files.len() + info.child_dirs.iter().map(count_entries).sum::<usize>()
}

fn count_covers(info: &DirInfo) -> usize {
    info.cover_candidates.len() + info.child_dirs.iter().map(count_covers).sum::<usize>()
}

fn flatten(root: &DirInfo) -> Vec<&DirInfo> {
    let mut result = Vec::new();
    fn visit<'a>(info: &'a DirInfo, out: &mut Vec<&'a DirInfo>) {
        out.push(info);
        for child in &info.child_dirs {
            visit(child, out);
        }
    }
    visit(root, &mut result);
    result
}

fn independent_strong(info: &DirInfo) -> bool {
    // Deviation D12: `.monochrome/` is the host's own sidecar (metadata.json +
    // manifest.json). Node scored it as an independent work in batch mode, so a
    // rescan offered every imported work twice. It is part of its parent.
    if is_sidecar_dir(&info.name) {
        return false;
    }
    info.strong && info.has_descendant_content && (!info.rj_codes.is_empty() || info.has_metadata_identity())
}

fn choose_candidates<'a>(root: &'a DirInfo, mode: &str, ctx: &mut Context) -> Vec<&'a DirInfo> {
    let infos = flatten(root);
    let all_strong: Vec<&DirInfo> = infos.iter().copied().filter(|info| independent_strong(info) && info.path != root.path).collect();
    let mut selected: Vec<&DirInfo>;
    if mode == "single" {
        // The selected directory stays the boundary; only two or more truly
        // independent RJ/metadata children trigger a split preview.
        if all_strong.len() >= 2 {
            selected = all_strong.clone();
            ctx.ambiguities.push("multiple-work-candidates-in-single-mode".to_string());
        } else {
            selected = vec![root];
        }
    } else {
        selected = infos.iter().copied().filter(|info| independent_strong(info)).collect();
        let mut by_depth = infos.clone();
        by_depth.sort_by_key(|info| info.depth);
        for info in by_depth {
            if selected.iter().any(|other| other.path == info.path) || info.structural {
                continue;
            }
            if !info.has_descendant_content || info.audio_count == 0 {
                continue;
            }
            if selected.iter().any(|candidate| candidate.path != info.path && same_or_inside(&info.path, &candidate.path)) {
                continue;
            }
            selected.push(info);
        }
        if selected.is_empty() && root.has_descendant_content {
            selected = vec![root];
        }
    }

    let mut unique: Vec<&DirInfo> = Vec::new();
    for info in selected {
        if !unique.iter().any(|other| other.path == info.path) {
            unique.push(info);
        }
    }
    let snapshot = unique.clone();
    let mut selected: Vec<&DirInfo> = unique
        .into_iter()
        .filter(|info| {
            info.path == root.path
                || !snapshot.iter().any(|other| {
                    other.path != info.path
                        && same_or_inside(&info.path, &other.path)
                        && !info.has_direct_content
                        && !info.has_metadata_title()
                        && info.rj_codes.is_empty()
                })
        })
        .collect();
    let snapshot = selected.clone();
    let with_content: Vec<&DirInfo> = selected
        .iter()
        .copied()
        .filter(|info| {
            let nested = snapshot.iter().any(|other| other.path != info.path && same_or_inside(&info.path, &other.path));
            info.has_descendant_content
                && (!nested || info.has_direct_content || info.path == root.path || !info.rj_codes.is_empty() || info.has_metadata_identity())
        })
        .collect();
    if !with_content.is_empty() {
        selected = with_content;
    }
    if mode == "batch" && selected.iter().any(|info| info.path == root.path) && all_strong.len() >= 2 {
        selected = all_strong;
    }
    selected.sort_by(|a, b| a.depth.cmp(&b.depth).then_with(|| locale_cmp(&a.relative_path, &b.relative_path)));
    selected
}

fn collect<'a>(info: &'a DirInfo, selected: &[PathBuf], files: &mut Vec<&'a FileInfo>, covers: &mut Vec<&'a CoverInfo>, root: &Path) {
    files.extend(info.direct_files.iter());
    covers.extend(info.cover_candidates.iter());
    for child in &info.child_dirs {
        if child.path != root && selected.contains(&child.path) {
            continue;
        }
        collect(child, selected, files, covers, root);
    }
}

fn normalize_relative_root(source: &Path, path: &Path) -> String {
    let relative = relative_logical(source, path);
    if relative.is_empty() { ".".to_string() } else { relative }
}

fn build_candidate(info: &DirInfo, ctx: &Context, mode: &str, selected: &[PathBuf]) -> Value {
    let nested: Vec<&PathBuf> = selected.iter().filter(|path| **path != info.path && same_or_inside(&info.path, path)).collect();
    let mut files = Vec::new();
    let mut covers = Vec::new();
    collect(info, selected, &mut files, &mut covers, &info.path);
    covers.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| locale_cmp(&a.path.to_string_lossy(), &b.path.to_string_lossy())));
    let entries: Vec<Value> = files
        .iter()
        .map(|file| {
            let mut entry = Map::new();
            entry.insert("logicalPath".to_string(), json!(relative_logical(&info.path, &file.absolute_path)));
            entry.insert("absolutePath".to_string(), json!(file.absolute_path.to_string_lossy()));
            entry.insert("kind".to_string(), json!(file.kind));
            entry.insert("size".to_string(), json!(file.size));
            if !file.extension.is_empty() {
                entry.insert("extension".to_string(), json!(file.extension));
            }
            Value::Object(entry)
        })
        .collect();
    let metadata = info.metadata.as_ref();
    let source_code: Option<String> = match metadata.filter(|meta| !meta.source_code.is_empty()) {
        Some(meta) => Some(extract_rj(&meta.source_code).unwrap_or_else(|| meta.source_code.clone())),
        None => info.rj_codes.iter().next().cloned(),
    };
    let folder_title = metadata
        .filter(|meta| !meta.title.is_empty())
        .map(|meta| meta.title.clone())
        .unwrap_or_else(|| clean_folder_title(&info.name, source_code.as_deref()));
    let circle = metadata
        .filter(|meta| !meta.circle.is_empty())
        .map(|meta| meta.circle.clone())
        .unwrap_or_else(|| parse_circle_from_name(&info.name));
    let cvs = metadata.map(|meta| meta.cvs.clone()).unwrap_or_default();
    let count = |kind: &str| files.iter().filter(|file| file.kind == kind).count();
    let (audio, subtitles, images, archives) = (count("audio"), count("subtitle"), count("image"), count("archive"));

    let mut ambiguities = info.ambiguities.clone();
    if source_code.is_none() {
        ambiguities.push("no-rj-code:lower-confidence-local-work".to_string());
    }
    if metadata.map(|meta| !meta.source_code.is_empty() && extract_rj(&meta.source_code).is_none()).unwrap_or(false) {
        ambiguities.push("non-rj-source-code:not-authoritative".to_string());
    }
    if !nested.is_empty() {
        ambiguities.push("nested-work-candidates:preview-split".to_string());
    }
    if ctx.depth_limited {
        ambiguities.push("max-depth-reached:preview-truncated".to_string());
    }
    if ctx.file_limited {
        ambiguities.push("max-files-reached:preview-truncated".to_string());
    }
    if mode == "single" && selected.len() > 1 {
        ambiguities.push("single-mode-multiple-candidates:needs-user-split".to_string());
    }
    let has_title = metadata.map(|meta| !meta.title.is_empty()).unwrap_or(false);
    let mut confidence: f64 = if source_code.is_some() {
        if has_title { 0.95 } else { 0.85 }
    } else if has_title {
        0.8
    } else if audio > 0 {
        0.55
    } else if !covers.is_empty() || !entries.is_empty() {
        0.4
    } else {
        0.3
    };
    if source_code.is_none() {
        confidence = confidence.min(0.55);
    }
    if !nested.is_empty() {
        confidence = confidence.min(0.7);
    }
    confidence = (confidence * 100.0).round() / 100.0;

    // Node also checks `metadata?.file`, a field the metadata object never has,
    // so `metadata-file:` evidence is never emitted; kept identical here.
    let mut evidence = info.evidence.clone();
    for (label, value) in [("entry-audio", audio), ("entry-subtitle", subtitles), ("entry-image", images), ("entry-archive", archives)] {
        if value > 0 {
            evidence.push(format!("{label}:{value}"));
        }
    }
    if evidence.is_empty() {
        evidence.push("files:present".to_string());
    }

    let mut excluded: Vec<Value> = info.excluded.iter().map(|(path, reason)| json!({ "path": path, "reason": reason })).collect();
    for rejected in &ctx.rejected {
        if same_or_inside(&info.path, &rejected.path) && !nested.iter().any(|path| same_or_inside(path, &rejected.path)) {
            excluded.push(json!({ "path": rejected.relative_path, "reason": rejected.reason }));
        }
    }
    let relative_root = normalize_relative_root(&ctx.source_root, &info.path);
    let mut candidate = Map::new();
    candidate.insert("candidateId".to_string(), json!(format!("local:{relative_root}")));
    candidate.insert("rootPath".to_string(), json!(info.path.to_string_lossy()));
    candidate.insert("relativeRoot".to_string(), json!(relative_root));
    candidate.insert("confidence".to_string(), json!(confidence));
    candidate.insert(
        "confidenceLabel".to_string(),
        json!(if confidence >= 0.8 { "high" } else if confidence >= 0.5 { "medium" } else { "low" }),
    );
    candidate.insert("evidence".to_string(), json!(evidence));
    candidate.insert("sourceCode".to_string(), json!(source_code));
    candidate.insert("folderTitle".to_string(), json!(folder_title));
    candidate.insert("circle".to_string(), json!(circle));
    candidate.insert("cvs".to_string(), json!(cvs));
    candidate.insert("entries".to_string(), Value::Array(entries));
    candidate.insert(
        "coverCandidates".to_string(),
        Value::Array(
            covers
                .iter()
                .map(|cover| {
                    let mut item = Map::new();
                    item.insert("path".to_string(), json!(cover.path.to_string_lossy()));
                    item.insert("relativePath".to_string(), json!(relative_logical(&info.path, &cover.path)));
                    item.insert("source".to_string(), json!("local"));
                    item.insert("name".to_string(), json!(cover.name));
                    if let Some(width) = cover.width {
                        item.insert("width".to_string(), json!(width));
                    }
                    if let Some(height) = cover.height {
                        item.insert("height".to_string(), json!(height));
                    }
                    Value::Object(item)
                })
                .collect(),
        ),
    );
    candidate.insert("excluded".to_string(), Value::Array(excluded));
    candidate.insert("ambiguities".to_string(), json!(ambiguities));
    candidate.insert("savingBytes".to_string(), json!("pending"));
    candidate.insert(
        "counts".to_string(),
        json!({ "entries": files.len(), "audio": audio, "subtitles": subtitles, "images": images, "archives": archives }),
    );
    if let Some(meta) = metadata {
        candidate.insert(
            "metadata".to_string(),
            json!({
                "file": meta.metadata_file,
                "title": meta.title,
                "circle": meta.circle,
                "sourceCode": meta.source_code,
                "cvs": meta.cvs,
                "language": meta.language,
                "role": meta.role,
            }),
        );
    }
    Value::Object(candidate)
}

/// Scan options (`{ mode, libraryRoot, maxDepth, maxFiles }`).
#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub mode: String,
    pub library_root: Option<PathBuf>,
    pub max_depth: usize,
    pub max_files: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self { mode: "single".to_string(), library_root: None, max_depth: 8, max_files: 5000 }
    }
}

impl ScanOptions {
    /// Parse the JSON options object with Node's validation messages.
    pub fn from_json(value: &Value) -> Result<Self> {
        let mut options = Self::default();
        if let Some(mode) = value.get("mode").filter(|mode| !mode.is_null()) {
            options.mode = storage_core::jsonutil::string_of(mode);
        }
        if let Some(depth) = value.get("maxDepth").filter(|depth| !depth.is_null()) {
            let depth = depth.as_f64().filter(|n| n.fract() == 0.0 && *n >= 0.0);
            options.max_depth = depth.ok_or_else(|| Error::new("maxDepth must be a non-negative integer"))? as usize;
        }
        if let Some(files) = value.get("maxFiles").filter(|files| !files.is_null()) {
            let files = files.as_f64().filter(|n| n.fract() == 0.0 && *n >= 1.0);
            options.max_files = files.ok_or_else(|| Error::new("maxFiles must be a positive integer"))? as usize;
        }
        if let Some(root) = value.get("libraryRoot").and_then(Value::as_str).filter(|root| !root.is_empty()) {
            options.library_root = Some(PathBuf::from(root));
        }
        Ok(options)
    }
}

/// Scan a source tree (`scanSource`). Read-only; returns the preview JSON.
pub fn scan_source(source_root: &Path, options: &ScanOptions) -> Result<Value> {
    if options.mode != "single" && options.mode != "batch" {
        return Err(Error::new("mode must be 'single' or 'batch'"));
    }
    let source = paths::resolve_lexical(source_root);
    let meta = std::fs::symlink_metadata(&source)
        .map_err(|_| Error::coded("ESOURCE_UNREADABLE", format!("sourceRoot is not readable: {}", source.display())))?;
    if meta.file_type().is_symlink() || paths::assert_no_reparse(&source, false).is_err() {
        return Err(Error::coded("ESOURCE_REPARSE", "sourceRoot must not be a symlink or junction"));
    }
    if !meta.is_dir() {
        return Err(Error::coded("ESOURCE_NOT_DIRECTORY", "sourceRoot must be a directory"));
    }
    let library_root = options.library_root.as_ref().map(|root| paths::resolve_lexical(root));
    if let Some(library) = &library_root {
        if same_or_inside(library, &source) {
            return Err(Error::coded("ESOURCE_LIBRARY", "sourceRoot is the library root or inside it"));
        }
    }
    let mut ctx = Context {
        source_root: source.clone(),
        library_root: library_root.clone(),
        max_depth: options.max_depth,
        max_files: options.max_files,
        scanned_files: 0,
        scanned_directories: 0,
        depth_limited: false,
        file_limited: false,
        rejected: Vec::new(),
        ambiguities: Vec::new(),
    };
    let root = inspect_directory(&source, ".", 0, &mut ctx).ok_or_else(|| Error::new("scan produced no root"))?;
    let mut selected: Vec<&DirInfo> = choose_candidates(&root, &options.mode, &mut ctx);
    if selected.is_empty() && root.has_descendant_content {
        selected = vec![&root];
    }
    let selected_paths: Vec<PathBuf> = selected.iter().map(|info| info.path.clone()).collect();
    let candidates: Vec<Value> = selected.iter().map(|info| build_candidate(info, &ctx, &options.mode, &selected_paths)).collect();

    let mut rejected: Vec<Value> = ctx
        .rejected
        .iter()
        .map(|item| {
            let mut value = json!({ "path": item.path.to_string_lossy(), "relativePath": item.relative_path, "reason": item.reason });
            if let Some(detail) = &item.detail {
                value["detail"] = json!(detail);
            }
            value
        })
        .collect();
    let mut top = ctx.ambiguities.clone();
    if options.mode == "single" && candidates.len() > 1 {
        top.push("single-mode-multiple-candidates:needs-user-split".to_string());
    }
    if options.mode == "batch" && candidates.len() > 1 {
        top.push("batch-mode-multiple-candidates:preview-each".to_string());
    }
    if ctx.depth_limited {
        top.push("max-depth-reached".to_string());
    }
    if ctx.file_limited {
        top.push("max-files-reached".to_string());
    }
    // Files outside every candidate are reported, never silently absorbed.
    for info in flatten(&root) {
        for file in &info.direct_files {
            if selected_paths.iter().any(|path| same_or_inside(path, &file.absolute_path)) {
                continue;
            }
            if !ctx.rejected.iter().any(|item| item.path == file.absolute_path) {
                rejected.push(json!({
                    "path": file.absolute_path.to_string_lossy(),
                    "relativePath": relative_logical(&source, &file.absolute_path),
                    "reason": "outside-work-root",
                }));
            }
        }
    }
    Ok(json!({
        "mode": options.mode,
        "sourceRoot": source.to_string_lossy(),
        "libraryRoot": library_root.map(|root| root.to_string_lossy().to_string()),
        "candidates": candidates,
        "rejected": rejected,
        "ambiguities": top,
        "savingBytes": "pending",
        "limits": {
            "maxDepth": options.max_depth,
            "maxFiles": options.max_files,
            "scannedFiles": ctx.scanned_files,
            "scannedDirectories": ctx.scanned_directories,
            "truncated": ctx.depth_limited || ctx.file_limited,
            "depthLimited": ctx.depth_limited,
            "fileLimited": ctx.file_limited,
        },
    }))
}

fn redact_path(path: &str, source: &Path) -> String {
    if path.is_empty() {
        return path.to_string();
    }
    if !Path::new(path).is_absolute() {
        return path.replace('\\', "/");
    }
    let relative = paths::relative_slash(source, Path::new(path));
    if relative.is_empty() { ".".to_string() } else { relative }
}

/// `host.mjs::redactPreview`: everything relative to the source root.
pub fn redact_preview(preview: &Value, source: &Path) -> Value {
    let mut clone = preview.clone();
    let Some(object) = clone.as_object_mut() else { return clone };
    object.insert("sourceRoot".to_string(), json!("."));
    object.insert("libraryRoot".to_string(), json!("."));
    if let Some(Value::Array(items)) = object.get_mut("rejected") {
        for item in items {
            let path = item.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            let redacted = redact_path(&path, source);
            let relative = item.get("relativePath").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string);
            item["path"] = json!(redacted.clone());
            item["relativePath"] = json!(relative.unwrap_or(redacted));
        }
    }
    if let Some(Value::Array(candidates)) = object.get_mut("candidates") {
        for candidate in candidates {
            let root = candidate.get("relativeRoot").and_then(Value::as_str).unwrap_or(".").to_string();
            candidate["rootPath"] = json!(root);
            if let Some(Value::Array(entries)) = candidate.get_mut("entries") {
                for entry in entries {
                    let logical = entry.get("logicalPath").cloned().unwrap_or(Value::Null);
                    entry["absolutePath"] = logical;
                }
            }
            if let Some(Value::Array(covers)) = candidate.get_mut("coverCandidates") {
                for cover in covers {
                    let relative = cover.get("relativePath").and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string);
                    let path = relative.unwrap_or_else(|| {
                        let raw = cover.get("path").and_then(Value::as_str).unwrap_or("");
                        Path::new(raw).file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default()
                    });
                    cover["path"] = json!(path);
                }
            }
            if let Some(Value::Array(excluded)) = candidate.get_mut("excluded") {
                for item in excluded {
                    let path = item.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                    item["path"] = json!(redact_path(&path, source));
                }
            }
        }
    }
    clone
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mono-scan-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn rj_extraction_matches_node_regex() {
        assert_eq!(extract_rj("[RJ01234567] title").as_deref(), Some("RJ01234567"));
        assert_eq!(extract_rj("rj123456").as_deref(), Some("RJ123456"));
        assert_eq!(extract_rj("XRJ123456"), None, "preceded by alphanumeric");
        assert_eq!(extract_rj("RJ123456789"), None, "9 digits never match");
        assert_eq!(extract_rj("RJ1234"), None);
    }

    #[test]
    fn folder_titles_and_circles_are_cleaned_like_node() {
        assert_eq!(clean_folder_title("[RJ01234567][Circle] Title (CV A)", Some("RJ01234567")), "Title (CV A)");
        assert_eq!(clean_folder_title("【RJ123456】 作品名 [2024-01-02]", Some("RJ123456")), "作品名");
        assert_eq!(clean_folder_title("", None), "Untitled local work");
        assert_eq!(parse_circle_from_name("[Circle Name] Title"), "Circle Name");
        assert_eq!(parse_circle_from_name("[RJ123456] Title"), "");
        assert_eq!(parse_circle_from_name("[2024-01] Title"), "");
    }

    #[test]
    fn text_metadata_is_parsed() {
        let meta = parse_text_metadata("Title: 夏\r\nCV: A, B、C\ncode = RJ123456\nnoise line", "info.txt");
        assert_eq!(meta.title, "夏");
        assert_eq!(meta.cvs, vec!["A", "B", "C"]);
        assert_eq!(meta.source_code, "RJ123456");
    }

    #[test]
    fn single_mode_keeps_root_and_excludes_tmp_and_cache() {
        let root = temp("single");
        let work = root.join("[RJ900201][Circle] Work");
        write(&work.join("mp3").join("01.mp3"), b"audio-one");
        write(&work.join("folder.png"), &crate::cover::tests::png(4, 3));
        write(&work.join("tmp").join("import-1").join("02.mp3"), b"unfinished");
        write(&work.join("cache").join("x.bin"), b"cache");
        let preview = scan_source(&work, &ScanOptions::default()).unwrap();
        let candidates = preview["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate["candidateId"], "local:.");
        assert_eq!(candidate["sourceCode"], "RJ900201");
        assert_eq!(candidate["folderTitle"], "Work");
        // Node only reads the *first* bracket group, which here is the RJ code,
        // so the circle is empty (verified against scan.mjs on the same tree).
        assert_eq!(candidate["circle"], "");
        let logical: Vec<&str> = candidate["entries"].as_array().unwrap().iter().map(|e| e["logicalPath"].as_str().unwrap()).collect();
        assert_eq!(logical, vec!["folder.png", "mp3/01.mp3"], "tmp/ and cache/ are never entries");
        assert_eq!(candidate["coverCandidates"][0]["width"], 4);
        assert_eq!(candidate["confidence"], 0.85);
        let reasons: Vec<&str> = preview["rejected"].as_array().unwrap().iter().map(|r| r["reason"].as_str().unwrap()).collect();
        assert!(reasons.iter().filter(|r| **r == "excluded-directory").count() == 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn batch_mode_splits_independent_works_and_redaction_is_relative() {
        let root = temp("batch");
        write(&root.join("[RJ900301] A").join("01.mp3"), b"a");
        write(&root.join("[RJ900302] B").join("音声").join("01.mp3"), b"b");
        write(&root.join("loose.txt"), b"loose");
        let options = ScanOptions { mode: "batch".to_string(), ..Default::default() };
        let preview = scan_source(&root, &options).unwrap();
        let ids: Vec<&str> = preview["candidates"].as_array().unwrap().iter().map(|c| c["candidateId"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["local:[RJ900301] A", "local:[RJ900302] B"]);
        assert!(preview["ambiguities"].as_array().unwrap().iter().any(|a| a == "batch-mode-multiple-candidates:preview-each"));
        assert!(preview["rejected"].as_array().unwrap().iter().any(|r| r["reason"] == "outside-work-root"));

        let redacted = redact_preview(&preview, &root);
        assert_eq!(redacted["sourceRoot"], ".");
        assert_eq!(redacted["candidates"][1]["rootPath"], "[RJ900302] B");
        assert_eq!(redacted["candidates"][1]["entries"][0]["absolutePath"], "音声/01.mp3");
        assert!(!redacted.to_string().contains(&*root.to_string_lossy().replace('\\', "\\\\")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn single_mode_with_two_strong_children_previews_a_split() {
        let root = temp("split");
        write(&root.join("[RJ900401] A").join("01.mp3"), b"a");
        write(&root.join("[RJ900402] B").join("01.mp3"), b"b");
        let preview = scan_source(&root, &ScanOptions::default()).unwrap();
        assert_eq!(preview["candidates"].as_array().unwrap().len(), 2);
        assert!(preview["ambiguities"].as_array().unwrap().iter().any(|a| a == "multiple-work-candidates-in-single-mode"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_roots_are_refused_with_node_codes() {
        let root = temp("invalid");
        let file = root.join("file.txt");
        write(&file, b"x");
        assert_eq!(scan_source(&file, &ScanOptions::default()).unwrap_err().code, Some("ESOURCE_NOT_DIRECTORY"));
        assert_eq!(scan_source(&root.join("missing"), &ScanOptions::default()).unwrap_err().code, Some("ESOURCE_UNREADABLE"));
        let inside = ScanOptions { library_root: Some(root.clone()), ..Default::default() };
        assert_eq!(scan_source(&root, &inside).unwrap_err().code, Some("ESOURCE_LIBRARY"));
        assert!(ScanOptions::from_json(&json!({ "maxFiles": 0 })).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
