//! Category-scoped post routes (`/api/videos*`).
//!
//! The v8 `post` table holds creations and videos side by side. Each HTTP
//! surface owns exactly one category, and every operation that takes a post id
//! checks it first: otherwise `/api/videos/delete` would happily delete a
//! creation whose id a client guessed or reused, and the two libraries would
//! stop being independent.

use serde_json::{Map, Value};
use storage_core::error::{Error, Result};
use storage_host::host::Host;

/// The post, if it exists and belongs to `category`; `ECATEGORY` otherwise.
///
/// A missing post stays `ENOTFOUND` so the two failures remain distinguishable:
/// "no such post" is a stale client, "wrong category" is a client using the
/// wrong route.
pub fn require_category(host: &Host, post_id: &str, category: &str) -> Result<Value> {
    let post = host.get_post(post_id)?;
    if post.get("category").and_then(Value::as_str) != Some(category) {
        return Err(Error::coded("ECATEGORY", format!("post is not a {category}")));
    }
    Ok(post)
}

/// Give every `files[]` entry its unsigned `/media/<fileId>` path.
///
/// Post files share the audio media route (signature, Range, ETag, HEAD)
/// instead of getting a multi-segment route of their own; the server signs the
/// path just before sending, like `/api/works` does for `mediaPath`.
fn add_media_paths(post: &mut Value) {
    if let Some(files) = post.get_mut("files").and_then(Value::as_array_mut) {
        for file in files {
            if let Some(file_id) = file.get("fileId").and_then(Value::as_str) {
                file["mediaPath"] = Value::String(format!("/media/{file_id}"));
            }
        }
    }
}

/// Replace each `files[].mediaPath` with its signed form.
///
/// `now` is taken once per response by the caller so every URL in one listing
/// expires together.
pub fn sign_media_paths(post: &mut Value, token: Option<&str>, ttl_ms: i64, now: i64) {
    if let Some(files) = post.get_mut("files").and_then(Value::as_array_mut) {
        for file in files {
            if let Some(path) = file.get("mediaPath").and_then(Value::as_str) {
                let signed = crate::auth::sign_media_path(token, path, ttl_ms, now);
                file["mediaPath"] = Value::String(signed);
            }
        }
    }
}

/// Live posts of one category.
pub fn list(host: &Host, category: &str) -> Result<Value> {
    let mut posts = host.list_posts(category)?;
    if let Some(items) = posts.as_array_mut() {
        items.iter_mut().for_each(add_media_paths);
    }
    Ok(posts)
}

/// One post of `category`, with its sidecar body as `bodyHtml`.
///
/// The body lives only in the sidecar (the row stores its hash), so the detail
/// view has to read it from the folder; listings skip it to stay cheap.
pub fn get(host: &Host, post_id: &str, category: &str) -> Result<Value> {
    let mut post = require_category(host, post_id, category)?;
    // Same folder gate as every write: a row whose `root_path` is not a
    // four-segment post folder must not make the detail view read a sidecar
    // from somewhere else (e.g. an audio work's `.monochrome/`).
    let folder = storage_host::posts::post_folder_of(host, &post)?;
    let sidecar = storage_host::posts::read_sidecar(&folder)?;
    post["bodyHtml"] = Value::String(sidecar.body);
    add_media_paths(&mut post);
    Ok(post)
}

/// Import a post into the route's category, whatever the body claims.
///
/// The override is the isolation guarantee for writes: without it a client
/// could create a creation through `/api/videos/import`, and the category check
/// on every other route would be meaningless. `rootPath` is dropped for the
/// same reason: the folder is the host's naming decision (`import_post` ignores
/// it too; removing it here keeps the intent visible at the route).
pub fn import(host: &mut Host, body: &Map<String, Value>, category: &str) -> Result<Value> {
    let mut input = body.clone();
    input.insert("category".to_string(), Value::String(category.to_string()));
    input.remove("rootPath");
    host.import_post(&Value::Object(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use storage_host::host::HostOptions;

    /// Same layout as the storage-host post tests: the source root is the temp
    /// dir and the library lives beneath it, so `rootPath` joins back onto it.
    fn test_host(root: &Path) -> Host {
        Host::open(HostOptions {
            library_root: root.join("lib"),
            source_root: Some(root.to_path_buf()),
            allowed_source_roots: vec![root.to_path_buf()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap()
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mono-routes-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn post(category: &str, source_id: &str) -> Value {
        json!({
            "category": category,
            "provider": "YouTube",
            "sourceId": source_id,
            "title": format!("Post {source_id}"),
            "publishedAt": "2026-01-01T00:00:00.000Z",
            "bodyText": "hello body",
            "creator": { "sourceId": "c1", "name": "Chan" }
        })
    }

    #[test]
    fn video_list_never_contains_creations() {
        let root = temp_root("list");
        let mut host = test_host(&root);
        host.import_post(&post("creation", "c-1")).unwrap();
        host.import_post(&post("video", "v-1")).unwrap();

        let videos = list(&host, "video").unwrap();
        let videos = videos.as_array().expect("list returns an array");
        assert_eq!(videos.len(), 1, "{videos:?}");
        assert_eq!(videos[0]["category"], "video");
        drop(host);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn video_route_rejects_a_creation_id() {
        let root = temp_root("reject");
        let mut host = test_host(&root);
        let creation = host.import_post(&post("creation", "c-2")).unwrap();
        let id = creation["postId"].as_str().unwrap();

        let error = require_category(&host, id, "video").unwrap_err();
        assert_eq!(error.code, Some("ECATEGORY"), "{error:?}");
        // The matching category passes and returns the post itself.
        assert_eq!(require_category(&host, id, "creation").unwrap()["postId"], id);
        drop(host);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn video_files_carry_a_single_segment_media_path() {
        let root = temp_root("media");
        let mut host = test_host(&root);
        let saved = host.import_post(&post("video", "v-4")).unwrap();
        let id = saved["postId"].as_str().unwrap().to_string();
        let file_id = storage_core::posts::insert_file(
            &host.library.connection,
            &id,
            &json!({ "role": "video", "relPath": "v.mp4", "mime": "video/mp4" }),
            "now",
        )
        .unwrap();
        let expected = format!("/media/{file_id}");

        let listed = list(&host, "video").unwrap();
        assert_eq!(listed[0]["files"][0]["fileId"], file_id.as_str());
        assert_eq!(listed[0]["files"][0]["mediaPath"], expected.as_str(), "{listed}");
        let detail = get(&host, &id, "video").unwrap();
        assert_eq!(detail["files"][0]["mediaPath"], expected.as_str(), "{detail}");
        // Signing keys off the id: a path `sign_media_path` cannot parse would
        // silently go out unsigned and fail playback under a token.
        let signed = crate::auth::sign_media_path(Some("t"), &expected, 60_000, 0);
        assert!(signed.starts_with(&format!("{expected}?")), "{signed}");
        drop(host);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn video_import_forces_category() {
        let root = temp_root("force");
        let mut host = test_host(&root);
        let body = post("creation", "v-3").as_object().unwrap().clone();

        let saved = import(&mut host, &body, "video").unwrap();
        let id = saved["postId"].as_str().unwrap();
        assert_eq!(host.get_post(id).unwrap()["category"], "video");
        assert!(saved["rootPath"].as_str().unwrap().starts_with("Videos/"), "{saved}");

        let detail = get(&host, id, "video").unwrap();
        assert!(detail["bodyHtml"].as_str().unwrap().contains("hello body"), "{detail}");
        drop(host);
        let _ = std::fs::remove_dir_all(root);
    }
}
