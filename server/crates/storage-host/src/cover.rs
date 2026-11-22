//! Local cover selection with real PNG/JPEG header validation (port of `cover.mjs`).
//!
//! No image library and no network: dimensions come from the actual bytes. A
//! file named `cover.jpg` that is really a truncated download must not become
//! the work cover, so every candidate is decoded far enough to prove it is a
//! complete PNG (IHDR..IEND) or JPEG (SOF..EOI). Embedded covers (ID3v2
//! APIC/PIC, FLAC PICTURE) are extracted the same way. Live fetching is a host
//! concern and never happens here.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use storage_core::error::{Error, Result};
use storage_core::paths;

/// Explicit cover stems and their tie-break rank (`COVER_STEMS`).
const COVER_STEMS: &[(&str, i64)] = &[("cover", 50), ("folder", 40), ("front", 30), ("jacket", 20), ("package", 10)];

/// Source tie-break rank when decoded areas are equal (`SOURCE_RANK`).
pub fn source_rank(source: &str) -> i64 {
    match source.to_lowercase().as_str() {
        "manual" => 100,
        "embedded" => 80,
        "folder" | "local" => 60,
        "kikoeru" => 40,
        "dlsite" => 20,
        _ => 0,
    }
}

/// Decoded image facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    /// `png` or `jpeg`.
    pub format: &'static str,
}

impl ImageInfo {
    pub fn mime(&self) -> &'static str {
        if self.format == "png" { "image/png" } else { "image/jpeg" }
    }
    pub fn area(&self) -> u64 {
        self.width as u64 * self.height as u64
    }
}

fn be32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes.get(offset..offset + 4).map(|slice| u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn be24(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes.get(offset..offset + 3).map(|slice| (slice[0] as u32) << 16 | (slice[1] as u32) << 8 | slice[2] as u32)
}

fn be16(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes.get(offset..offset + 2).map(|slice| u16::from_be_bytes([slice[0], slice[1]]))
}

/// A complete PNG: signature, exactly one 13-byte IHDR, chunks in bounds, IEND.
pub fn parse_png(bytes: &[u8]) -> Option<ImageInfo> {
    if bytes.len() < 8 || bytes[0] != 0x89 || &bytes[1..4] != b"PNG" || &bytes[4..8] != b"\r\n\x1a\n" {
        return None;
    }
    let mut offset = 8usize;
    let (mut width, mut height) = (0u32, 0u32);
    let (mut saw_ihdr, mut saw_iend) = (false, false);
    while offset + 12 <= bytes.len() {
        let length = be32(bytes, offset)? as usize;
        if length > 0x7fff_ffff || offset + 12 + length > bytes.len() {
            return None;
        }
        let kind = &bytes[offset + 4..offset + 8];
        let data = offset + 8;
        if kind == b"IHDR" {
            if length != 13 || saw_ihdr {
                return None;
            }
            saw_ihdr = true;
            width = be32(bytes, data)?;
            height = be32(bytes, data + 4)?;
            if width == 0 || height == 0 {
                return None;
            }
        }
        if kind == b"IEND" {
            saw_iend = true;
            break;
        }
        offset += 12 + length;
    }
    (saw_ihdr && saw_iend).then_some(ImageInfo { width, height, format: "png" })
}

/// A JPEG with an SOF frame header and an EOI marker in the last 4 bytes.
pub fn parse_jpeg(bytes: &[u8]) -> Option<ImageInfo> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return None;
    }
    let mut offset = 2usize;
    let (mut width, mut height) = (0u16, 0u16);
    let mut saw_sof = false;
    while offset + 4 <= bytes.len() {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        if offset >= bytes.len() {
            break;
        }
        let marker = bytes[offset];
        offset += 1;
        if marker == 0xd9 {
            break;
        }
        if marker == 0xd8 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = be16(bytes, offset)? as usize;
        if length < 2 || offset + length > bytes.len() {
            return None;
        }
        let is_sof = matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf);
        if is_sof {
            if length < 7 {
                return None;
            }
            height = be16(bytes, offset + 3)?;
            width = be16(bytes, offset + 5)?;
            if width == 0 || height == 0 {
                return None;
            }
            saw_sof = true;
        }
        offset += length;
        if marker == 0xda {
            break;
        }
    }
    if !saw_sof {
        return None;
    }
    // A truncated entropy stream without EOI is not decodable.
    let tail = &bytes[bytes.len().saturating_sub(4)..];
    if !tail.windows(2).any(|pair| pair == [0xff, 0xd9]) {
        return None;
    }
    Some(ImageInfo { width: width as u32, height: height as u32, format: "jpeg" })
}

fn image_from_bytes(bytes: &[u8]) -> Option<ImageInfo> {
    parse_png(bytes).or_else(|| parse_jpeg(bytes))
}

/// An embedded picture: decoded facts plus the image bytes.
#[derive(Debug, Clone)]
pub struct EmbeddedPicture {
    pub info: ImageInfo,
    pub picture_type: u8,
    pub data: Vec<u8>,
}

fn synchsafe(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(
        ((slice[0] & 0x7f) as u32) << 21
            | ((slice[1] & 0x7f) as u32) << 14
            | ((slice[2] & 0x7f) as u32) << 7
            | (slice[3] & 0x7f) as u32,
    )
}

/// Undo ID3 unsynchronisation: every `FF 00` becomes `FF`.
fn de_unsynchronise(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        output.push(bytes[index]);
        if bytes[index] == 0xff && bytes.get(index + 1) == Some(&0x00) {
            index += 1;
        }
        index += 1;
    }
    output
}

fn parse_apic(payload: &[u8], major: u8) -> Option<EmbeddedPicture> {
    if payload.len() < 4 {
        return None;
    }
    let encoding = payload[0];
    let mut offset = 1usize;
    if major == 2 {
        // PIC: three-byte image format ("PNG"/"JPG").
        offset += 3;
        if offset > payload.len() {
            return None;
        }
    } else {
        let mime_end = payload[offset..].iter().position(|byte| *byte == 0)? + offset;
        offset = mime_end + 1;
    }
    if offset >= payload.len() {
        return None;
    }
    let picture_type = payload[offset];
    offset += 1;
    // The description ends with one NUL (single-byte encodings) or a NUL pair
    // on an even boundary (UTF-16); the image starts right after it.
    if encoding == 1 || encoding == 2 {
        let mut found = None;
        let mut index = offset;
        while index + 1 < payload.len() {
            if payload[index] == 0 && payload[index + 1] == 0 {
                found = Some(index + 2);
                break;
            }
            index += 2;
        }
        offset = found?;
    } else {
        let desc_end = payload[offset..].iter().position(|byte| *byte == 0)? + offset;
        offset = desc_end + 1;
    }
    let data = payload.get(offset..)?;
    let info = image_from_bytes(data)?;
    Some(EmbeddedPicture { info, picture_type, data: data.to_vec() })
}

/// ID3v2.2/2.3/2.4 APIC/PIC; prefers picture type 3 (front cover).
pub fn parse_id3(bytes: &[u8]) -> Option<EmbeddedPicture> {
    if bytes.len() < 10 || &bytes[0..3] != b"ID3" {
        return None;
    }
    let major = bytes[3];
    if !matches!(major, 2..=4) {
        return None;
    }
    let flags = bytes[5];
    let tag_size = synchsafe(bytes, 6)? as usize;
    if tag_size == 0 || 10 + tag_size > bytes.len() {
        return None;
    }
    let mut body: Vec<u8> = bytes[10..10 + tag_size].to_vec();
    if flags & 0x80 != 0 {
        body = de_unsynchronise(&body);
    }
    if flags & 0x40 != 0 {
        let extended = if major == 4 { synchsafe(&body, 0)? } else { be32(&body, 0)? } as usize;
        body = body.get(extended..)?.to_vec();
    }
    let header_size = if major == 2 { 6 } else { 10 };
    let mut offset = 0usize;
    let mut pictures = Vec::new();
    while offset + header_size <= body.len() {
        let (id, length) = if major == 2 {
            (&body[offset..offset + 3], be24(&body, offset + 3)? as usize)
        } else {
            let length = if major == 4 { synchsafe(&body, offset + 4)? } else { be32(&body, offset + 4)? };
            (&body[offset..offset + 4], length as usize)
        };
        if length == 0 || offset + header_size + length > body.len() {
            break;
        }
        if id == b"APIC" || id == b"PIC" {
            if let Some(picture) = parse_apic(&body[offset + header_size..offset + header_size + length], major) {
                pictures.push(picture);
            }
        }
        offset += header_size + length;
    }
    pick_front(pictures)
}

fn parse_flac_picture(block: &[u8]) -> Option<EmbeddedPicture> {
    let picture_type = be32(block, 0)?;
    let mime_length = be32(block, 4)? as usize;
    let mut offset = 8usize;
    if offset + mime_length + 4 > block.len() {
        return None;
    }
    offset += mime_length;
    let desc_length = be32(block, offset)? as usize;
    offset += 4;
    if offset + desc_length + 20 > block.len() {
        return None;
    }
    offset += desc_length + 16; // width, height, depth, indexed colours
    let data_length = be32(block, offset)? as usize;
    offset += 4;
    if data_length == 0 || offset + data_length > block.len() {
        return None;
    }
    let data = &block[offset..offset + data_length];
    let info = image_from_bytes(data)?;
    Some(EmbeddedPicture { info, picture_type: picture_type.min(255) as u8, data: data.to_vec() })
}

/// FLAC PICTURE metadata blocks; prefers picture type 3.
pub fn parse_flac(bytes: &[u8]) -> Option<EmbeddedPicture> {
    if bytes.len() < 8 || &bytes[0..4] != b"fLaC" {
        return None;
    }
    let mut offset = 4usize;
    let mut pictures = Vec::new();
    while offset + 4 <= bytes.len() {
        let header = bytes[offset];
        let last = header & 0x80 != 0;
        let kind = header & 0x7f;
        let length = be24(bytes, offset + 1)? as usize;
        if offset + 4 + length > bytes.len() {
            return None;
        }
        if kind == 6 {
            if let Some(picture) = parse_flac_picture(&bytes[offset + 4..offset + 4 + length]) {
                pictures.push(picture);
            }
        }
        offset += 4 + length;
        if last {
            break;
        }
    }
    pick_front(pictures)
}

fn pick_front(mut pictures: Vec<EmbeddedPicture>) -> Option<EmbeddedPicture> {
    if let Some(index) = pictures.iter().position(|picture| picture.picture_type == 3) {
        return Some(pictures.swap_remove(index));
    }
    if pictures.is_empty() { None } else { Some(pictures.remove(0)) }
}

/// Embedded cover from an audio file's bytes (ID3 first, then FLAC).
pub fn embedded_from_bytes(bytes: &[u8]) -> Option<EmbeddedPicture> {
    parse_id3(bytes).or_else(|| parse_flac(bytes))
}

/// Embedded cover from a path; `None` for symlinks, non-files or no picture.
///
/// Reads the whole file, like Node. Audio with an embedded cover keeps it in the
/// leading tag block, but FLAC can put PICTURE after large other blocks, so a
/// head-only read would miss real covers.
pub fn embedded_from_path(audio_path: &Path) -> Option<EmbeddedPicture> {
    let info = std::fs::symlink_metadata(audio_path).ok()?;
    if !info.is_file() {
        return None;
    }
    embedded_from_bytes(&std::fs::read(audio_path).ok()?)
}

/// Read and decode a cover image file; symlinks and truncated images are errors.
pub fn read_image(path: &Path) -> Result<(ImageInfo, u64)> {
    let invalid = |reason: String| Error::coded("ECOVER_INVALID", format!("invalid cover image: {reason}"));
    let info = std::fs::symlink_metadata(path).map_err(|error| invalid(error.to_string()))?;
    if info.file_type().is_symlink() {
        return Err(invalid(format!("symlink/junction: {}", path.display())));
    }
    if !info.is_file() {
        return Err(invalid(format!("not a regular file: {}", path.display())));
    }
    let bytes = std::fs::read(path).map_err(|error| invalid(error.to_string()))?;
    let parsed = image_from_bytes(&bytes).ok_or_else(|| invalid(format!("unrecognized or truncated PNG/JPEG: {}", path.display())))?;
    Ok((parsed, info.len()))
}

/// File stem, NFKC-normalised (`explicitName`): full-width `ｃｏｖｅｒ` counts.
fn explicit_name(path: &str) -> String {
    let name = Path::new(path).file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    let stem = match name.rfind('.') {
        Some(index) if index > 0 => name[..index].to_string(),
        _ => name,
    };
    stem.nfkc().collect()
}

/// Matched explicit stem, Node's `(?:^|[-_ ])(cover|…)(?:$|[-_ ])`, case-insensitive.
fn explicit_stem(stem: &str) -> Option<&'static str> {
    let lower = stem.to_lowercase();
    let is_separator = |ch: char| matches!(ch, '-' | '_' | ' ');
    for (word, _) in COVER_STEMS {
        let mut search = 0;
        while let Some(found) = lower[search..].find(word) {
            let start = search + found;
            let end = start + word.len();
            let left_ok = start == 0 || lower[..start].chars().next_back().map(is_separator).unwrap_or(false);
            let right_ok = end == lower.len() || lower[end..].chars().next().map(is_separator).unwrap_or(false);
            if left_ok && right_ok {
                return Some(word);
            }
            search = start + 1;
            if search >= lower.len() {
                break;
            }
        }
    }
    None
}

/// First explicit stem in *text order*, which is what Node's regex `match` returns.
fn explicit_rank(stem: &str) -> i64 {
    let lower = stem.to_lowercase();
    let mut best: Option<(usize, i64)> = None;
    for (word, rank) in COVER_STEMS {
        let is_separator = |ch: char| matches!(ch, '-' | '_' | ' ');
        let mut search = 0;
        while let Some(found) = lower[search..].find(word) {
            let start = search + found;
            let end = start + word.len();
            let left_ok = start == 0 || lower[..start].chars().next_back().map(is_separator).unwrap_or(false);
            let right_ok = end == lower.len() || lower[end..].chars().next().map(is_separator).unwrap_or(false);
            if left_ok && right_ok {
                if best.map(|(position, _)| start < position).unwrap_or(true) {
                    best = Some((start, *rank));
                }
                break;
            }
            search = start + 1;
            if search >= lower.len() {
                break;
            }
        }
    }
    best.map(|(_, rank)| rank).unwrap_or(0)
}

/// Is this file name an explicit cover (`EXPLICIT_COVER.test(stem)`)?
pub fn is_explicit_cover_name(path: &str) -> bool {
    explicit_stem(&explicit_name(path)).is_some()
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn path_for_candidate(candidate: &Value, value: &str) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Some(paths::resolve_lexical(path));
    }
    let root = text(candidate, "rootPath");
    if !root.is_empty() {
        return Some(paths::resolve_lexical(&Path::new(&root).join(path)));
    }
    std::env::current_dir().ok().map(|cwd| paths::resolve_lexical(&cwd.join(path)))
}

fn logical_cover_path(candidate: &Value, absolute: &Path) -> String {
    let root = text(candidate, "rootPath");
    let base = absolute.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    if root.is_empty() {
        return base;
    }
    let root = paths::resolve_lexical(Path::new(&root));
    if !paths::is_inside(&root, absolute) {
        return base;
    }
    paths::relative_slash(&root, absolute)
}

/// One cover choice (the subset of Node's choice object the pipeline reads).
#[derive(Debug, Clone)]
pub struct CoverChoice {
    /// `None` for an embedded cover until it is materialized to a temp file.
    pub path: Option<PathBuf>,
    pub logical_path: String,
    pub name: String,
    pub info: Option<ImageInfo>,
    /// `manual`, `embedded`, `folder`, `kikoeru`, `dlsite`, or `local` (fallback).
    pub source: String,
    pub manual: bool,
    pub embedded: bool,
    pub external: bool,
    pub fallback: bool,
    pub data: Option<Vec<u8>>,
    pub bytes: u64,
}

impl CoverChoice {
    fn area(&self) -> u64 {
        self.info.as_ref().map(ImageInfo::area).unwrap_or(0)
    }
    pub fn format(&self) -> Option<&'static str> {
        self.info.as_ref().map(|info| info.format)
    }
}

struct Explicit {
    path: PathBuf,
    rank: i64,
}

/// `candidateExplicitCovers`: explicit names from `coverCandidates`, then
/// explicit image entries; never an arbitrary CG or screenshot.
fn candidate_explicit_covers(candidate: &Value) -> Vec<Explicit> {
    let mut values = Vec::new();
    for cover in candidate.get("coverCandidates").and_then(Value::as_array).into_iter().flatten() {
        let raw = { let path = text(cover, "path"); if path.is_empty() { text(cover, "absolutePath") } else { path } };
        let Some(absolute) = path_for_candidate(candidate, &raw) else { continue };
        let name = { let name = text(cover, "name"); if name.is_empty() { absolute.to_string_lossy().to_string() } else { name } };
        let stem = explicit_name(&name);
        if explicit_stem(&stem).is_none() {
            continue;
        }
        values.push(Explicit { path: absolute, rank: explicit_rank(&stem) });
    }
    for entry in candidate.get("entries").and_then(Value::as_array).into_iter().flatten() {
        if text(entry, "kind").to_lowercase() != "image" {
            continue;
        }
        let raw = { let path = text(entry, "absolutePath"); if path.is_empty() { text(entry, "path") } else { path } };
        let Some(absolute) = path_for_candidate(candidate, &raw) else { continue };
        let logical = { let logical = text(entry, "logicalPath"); if logical.is_empty() { absolute.to_string_lossy().to_string() } else { logical } };
        let stem = explicit_name(&logical);
        if explicit_stem(&stem).is_none() {
            continue;
        }
        // Node ranks entry-derived covers by the *whole* stem (`COVER_STEMS.get(stem)`),
        // so only a bare `cover`/`folder`/... stem gets a rank here.
        let rank = COVER_STEMS.iter().find(|(word, _)| *word == stem.to_lowercase()).map(|(_, rank)| *rank).unwrap_or(0);
        values.push(Explicit { path: absolute, rank });
    }
    let mut seen = HashSet::new();
    let mut unique: Vec<Explicit> = values
        .into_iter()
        .filter(|value| seen.insert(value.path.to_string_lossy().to_lowercase()))
        .collect();
    unique.sort_by(|a, b| b.rank.cmp(&a.rank).then_with(|| locale_cmp(&a.path.to_string_lossy(), &b.path.to_string_lossy())));
    unique
}

/// Deterministic replacement for `String.prototype.localeCompare` (D13):
/// case-insensitive, then code-point order. Node's version follows the
/// *machine's* default locale (zh-CN ICU sorts 音声 before 字幕, code points
/// the other way), so a preview's order changed with the OS language. Order is
/// presentation only; nothing keys on it.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

fn choice_for(candidate: &Value, path: PathBuf, info: ImageInfo, bytes: u64, source: &str, manual: bool) -> CoverChoice {
    CoverChoice {
        logical_path: logical_cover_path(candidate, &path),
        name: path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        path: Some(path),
        info: Some(info),
        source: source.to_string(),
        manual,
        embedded: false,
        external: false,
        fallback: false,
        data: None,
        bytes,
    }
}

/// Audio entries of a candidate (`candidateAudioPaths`), de-duplicated.
fn candidate_audio_paths(candidate: &Value) -> Vec<PathBuf> {
    let mut values = Vec::new();
    let lists = [candidate.get("audioEntries"), candidate.get("entries")];
    for entry in lists.into_iter().flatten().filter_map(Value::as_array).flatten() {
        let is_audio = text(entry, "kind").to_lowercase() == "audio" || text(entry, "mime").to_lowercase().starts_with("audio/");
        if !is_audio {
            continue;
        }
        let raw = { let path = text(entry, "absolutePath"); if path.is_empty() { text(entry, "path") } else { path } };
        if let Some(path) = path_for_candidate(candidate, &raw) {
            if !values.contains(&path) {
                values.push(path);
            }
        }
    }
    values
}

/// Options for [`select_cover`].
#[derive(Debug, Default, Clone)]
pub struct SelectOptions {
    pub manual_path: Option<PathBuf>,
    pub include_embedded: bool,
    /// Prefetched online covers: `[{ path, source: "kikoeru"|"dlsite", name? }]`.
    pub online_candidates: Vec<Value>,
}

/// Select one cover (`selectCover`).
///
/// `manual_path` is a hard override when decodable; an invalid manual image is
/// `ECOVER_INVALID` and leaves the caller's previous choice untouched. Otherwise
/// the largest decoded area wins, ties broken by source rank then path.
pub fn select_cover(candidate: &Value, options: &SelectOptions) -> Result<Option<CoverChoice>> {
    if !candidate.is_object() {
        return Err(Error::new("candidate is required"));
    }
    if let Some(manual) = &options.manual_path {
        let manual = paths::resolve_lexical(manual);
        let (info, bytes) = read_image(&manual).map_err(|error| Error::coded("ECOVER_INVALID", error.message))?;
        return Ok(Some(choice_for(candidate, manual, info, bytes, "manual", true)));
    }
    let mut choices: Vec<CoverChoice> = Vec::new();
    if options.include_embedded {
        for audio in candidate_audio_paths(candidate) {
            if let Some(picture) = embedded_from_path(&audio) {
                let extension = if picture.info.format == "png" { "png" } else { "jpg" };
                choices.push(CoverChoice {
                    path: None,
                    logical_path: format!("embedded:{}", audio.to_string_lossy()),
                    name: format!("embedded-cover.{extension}"),
                    bytes: picture.data.len() as u64,
                    info: Some(picture.info),
                    source: "embedded".to_string(),
                    manual: false,
                    embedded: true,
                    external: false,
                    fallback: false,
                    data: Some(picture.data),
                });
            }
        }
    }
    for cover in candidate_explicit_covers(candidate) {
        // An explicit but truncated/corrupt candidate is rejected, not selected.
        if let Ok((info, bytes)) = read_image(&cover.path) {
            choices.push(choice_for(candidate, cover.path, info, bytes, "folder", false));
        }
    }
    let online = options
        .online_candidates
        .iter()
        .chain(candidate.get("onlineCandidates").and_then(Value::as_array).into_iter().flatten());
    let mut seen = HashSet::new();
    for item in online {
        let source = text(item, "source").to_lowercase();
        if source != "kikoeru" && source != "dlsite" {
            continue;
        }
        let raw = { let path = text(item, "path"); if path.is_empty() { text(item, "absolutePath") } else { path } };
        let Some(absolute) = path_for_candidate(candidate, &raw) else { continue };
        if !seen.insert(absolute.to_string_lossy().to_lowercase()) {
            continue;
        }
        // Prefetched online bytes are local files; corrupt/truncated ones are skipped.
        if let Ok((info, bytes)) = read_image(&absolute) {
            let mut choice = choice_for(candidate, absolute, info, bytes, &source, false);
            choice.external = true;
            choices.push(choice);
        }
    }
    choices.sort_by(|a, b| {
        b.area()
            .cmp(&a.area())
            .then_with(|| source_rank(&b.source).cmp(&source_rank(&a.source)))
            .then_with(|| {
                let key = |choice: &CoverChoice| choice.path.as_ref().map(|path| path.to_string_lossy().to_string()).unwrap_or_else(|| choice.name.clone());
                locale_cmp(&key(a), &key(b))
            })
    });
    Ok(choices.into_iter().next())
}

/// Explicit-name fallback without decoding (`selectExplicitNameFallback`).
pub fn select_explicit_name_fallback(candidate: &Value) -> Option<CoverChoice> {
    let first = candidate_explicit_covers(candidate).into_iter().next()?;
    Some(CoverChoice {
        logical_path: logical_cover_path(candidate, &first.path),
        name: first.path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        path: Some(first.path),
        info: None,
        source: "local".to_string(),
        manual: false,
        embedded: false,
        external: false,
        fallback: true,
        data: None,
        bytes: 0,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// Minimal valid PNG of `width`x`height` (IHDR + IEND; IDAT is not parsed).
    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]); // CRC (not checked, like Node)
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(b"IEND");
        bytes.extend_from_slice(&[0xae, 0x42, 0x60, 0x82]);
        bytes
    }

    /// Minimal JPEG: SOI, SOF0 with dimensions, SOS, EOI.
    pub fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08];
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
        bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x02, 0x00, 0x00, 0xff, 0xd9]);
        bytes
    }

    #[test]
    fn png_and_jpeg_dimensions_come_from_bytes() {
        assert_eq!(parse_png(&png(640, 480)), Some(ImageInfo { width: 640, height: 480, format: "png" }));
        assert_eq!(parse_jpeg(&jpeg(300, 200)), Some(ImageInfo { width: 300, height: 200, format: "jpeg" }));
        // Truncated: PNG without IEND, JPEG without EOI.
        let full = png(10, 10);
        assert_eq!(parse_png(&full[..full.len() - 12]), None);
        let jpg = jpeg(10, 10);
        assert_eq!(parse_jpeg(&jpg[..jpg.len() - 2]), None);
        assert_eq!(parse_png(b"not an image"), None);
    }

    #[test]
    fn id3_apic_prefers_front_cover() {
        let back = png(10, 10);
        let front = jpeg(50, 40);
        let frame = |picture_type: u8, image: &[u8]| {
            let mut payload = vec![0u8]; // ISO-8859-1
            payload.extend_from_slice(b"image/x\0");
            payload.push(picture_type);
            payload.extend_from_slice(b"desc\0");
            payload.extend_from_slice(image);
            let mut out = b"APIC".to_vec();
            out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(&payload);
            out
        };
        let mut body = frame(4, &back);
        body.extend(frame(3, &front));
        let size = body.len() as u32;
        let mut tag = b"ID3\x03\x00\x00".to_vec();
        tag.extend_from_slice(&[(size >> 21 & 0x7f) as u8, (size >> 14 & 0x7f) as u8, (size >> 7 & 0x7f) as u8, (size & 0x7f) as u8]);
        tag.extend(body);
        tag.extend_from_slice(b"audio-frames");
        let picture = parse_id3(&tag).unwrap();
        assert_eq!(picture.picture_type, 3);
        assert_eq!(picture.info.width, 50);
        assert_eq!(picture.data, front);
    }

    #[test]
    fn flac_picture_block_is_extracted() {
        let image = png(32, 16);
        let mut block = 3u32.to_be_bytes().to_vec();
        block.extend_from_slice(&9u32.to_be_bytes());
        block.extend_from_slice(b"image/png");
        block.extend_from_slice(&0u32.to_be_bytes());
        block.extend_from_slice(&[0u8; 16]);
        block.extend_from_slice(&(image.len() as u32).to_be_bytes());
        block.extend_from_slice(&image);
        let mut flac = b"fLaC".to_vec();
        flac.push(0x80 | 6);
        let length = block.len() as u32;
        flac.extend_from_slice(&[(length >> 16) as u8, (length >> 8) as u8, length as u8]);
        flac.extend(block);
        let picture = parse_flac(&flac).unwrap();
        assert_eq!((picture.info.width, picture.info.height), (32, 16));
        assert_eq!(picture.data, image);
    }

    #[test]
    fn explicit_names_follow_node_regex() {
        assert!(is_explicit_cover_name("cover.jpg"));
        assert!(is_explicit_cover_name("Front_Cover.PNG"));
        assert!(is_explicit_cover_name("ｃｏｖｅｒ.png"), "NFKC: full-width counts");
        assert!(is_explicit_cover_name("01 folder.jpg"));
        assert!(!is_explicit_cover_name("covers.jpg"));
        assert!(!is_explicit_cover_name("discover.jpg"));
        assert!(!is_explicit_cover_name("cg01.png"));
        // Text order, not rank order: "front-cover" matches "front" first in Node.
        assert_eq!(explicit_rank("front-cover"), 30);
        assert_eq!(explicit_rank("cover"), 50);
    }

    #[test]
    fn selection_prefers_area_then_source_and_skips_corrupt() {
        let root = std::env::temp_dir().join(format!("mono-cover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("cover.png"), png(100, 100)).unwrap();
        std::fs::write(root.join("folder.jpg"), jpeg(200, 200)).unwrap();
        let truncated = png(900, 900);
        std::fs::write(root.join("front.png"), &truncated[..truncated.len() - 12]).unwrap();
        std::fs::write(root.join("cg01.png"), png(2000, 2000)).unwrap();
        let candidate = json!({
            "rootPath": root.to_string_lossy(),
            "coverCandidates": [
                { "path": "cover.png", "name": "cover.png" },
                { "path": "folder.jpg", "name": "folder.jpg" },
                { "path": "front.png", "name": "front.png" },
                { "path": "cg01.png", "name": "cg01.png" }
            ]
        });
        let choice = select_cover(&candidate, &SelectOptions::default()).unwrap().unwrap();
        assert_eq!(choice.name, "folder.jpg", "largest decodable explicit cover wins; CG and truncated ignored");
        assert_eq!(choice.logical_path, "folder.jpg");

        // Manual override wins even when smaller; an invalid manual image is an error.
        std::fs::write(root.join("mine.png"), png(5, 5)).unwrap();
        let manual = SelectOptions { manual_path: Some(root.join("mine.png")), ..Default::default() };
        assert_eq!(select_cover(&candidate, &manual).unwrap().unwrap().source, "manual");
        let bad = SelectOptions { manual_path: Some(root.join("front.png")), ..Default::default() };
        assert_eq!(select_cover(&candidate, &bad).unwrap_err().code, Some("ECOVER_INVALID"));

        let fallback = select_explicit_name_fallback(&candidate).unwrap();
        assert!(fallback.fallback);
        let _ = std::fs::remove_dir_all(root);
    }
}
