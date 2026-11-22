//! Manual, local-only checks of the v8 post storage against real source data.
//!
//! Both tests are `#[ignore]` and read every input from files named in
//! environment variables, so no real post content ever has to live in the
//! repository: a real Patreon/Pawchive body is somebody else's work and may be
//! paywalled. The synthetic regressions for whatever these runs uncover belong
//! in `src/posts.rs` / `src/html.rs`, not here.
//!
//! ```text
//! # import one post into a scratch source root and print the result
//! BODY_HTML_FILE=<body.html> POST_JSON_FILE=<post.json> V8_SOURCE_ROOT=<empty dir> \
//!   cargo test -p monochrome-storage-host --test local_post_import -- --ignored --nocapture import_post_from_local_files
//!
//! # sanitize one HTML file (to diff against the frontend sanitizer)
//! SANITIZE_INPUT_FILE=<in.html> SANITIZE_OUTPUT_FILE=<out.html> \
//!   cargo test -p monochrome-storage-host --test local_post_import -- --ignored sanitize_local_file
//! ```
//!
//! `post.json` holds the import fields except the body (`provider`, `sourceId`,
//! `title`, `publishedAt`, `sourceUrl`, `creator`, `tags`, optional `meta`);
//! `category` is forced to `creation`. A missing variable prints `skip:` and
//! passes, because "not configured" is not a failure of the code under test.

use std::path::PathBuf;

use serde_json::{json, Value};
use storage_host::host::{Host, HostOptions};

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

#[test]
#[ignore = "local-only: needs BODY_HTML_FILE, POST_JSON_FILE and V8_SOURCE_ROOT"]
fn import_post_from_local_files() {
    let (Some(body_file), Some(post_file), Some(root)) =
        (env_path("BODY_HTML_FILE"), env_path("POST_JSON_FILE"), env_path("V8_SOURCE_ROOT"))
    else {
        println!("skip: BODY_HTML_FILE / POST_JSON_FILE / V8_SOURCE_ROOT not set");
        return;
    };
    // Never import into a library that already has content: the run is a probe,
    // and a real library would be modified by it.
    std::fs::create_dir_all(&root).unwrap();
    assert!(
        std::fs::read_dir(&root).unwrap().next().is_none(),
        "V8_SOURCE_ROOT must be an empty directory"
    );
    let body = std::fs::read_to_string(&body_file).unwrap();
    let mut input: Value = serde_json::from_str(&std::fs::read_to_string(&post_file).unwrap()).unwrap();
    input["category"] = json!("creation");
    input["bodyHtml"] = json!(body);

    let mut host = Host::open(HostOptions {
        library_root: root.join("lib"),
        source_root: Some(root.clone()),
        allowed_source_roots: vec![root.clone()],
        allow_outside_root: true,
        experiment_root: None,
        snapshot_fault: None,
    })
    .unwrap();
    let outcome = host.import_post(&input).unwrap();
    let root_path = outcome["rootPath"].as_str().unwrap().to_string();
    let folder = root.join(&root_path);
    let stored_body = std::fs::read_to_string(folder.join(".monochrome/post.html")).unwrap();
    let metadata: Value =
        serde_json::from_str(&std::fs::read_to_string(folder.join(".monochrome/metadata.json")).unwrap()).unwrap();
    let row = host.get_post(outcome["postId"].as_str().unwrap()).unwrap();

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "outcome": outcome,
            "rootPath": root_path,
            "postHtml": stored_body,
            "metadata": metadata,
            "row": row,
        }))
        .unwrap()
    );

    // Invariants that hold for any input; the human reading the output judges
    // the rest (does the layout survive, is the title readable).
    let parts: Vec<&str> = root_path.split('/').collect();
    assert_eq!(parts.len(), 4, "{root_path}");
    assert_eq!(parts[0], "Creations");
    let source_id = input["sourceId"].as_str().unwrap();
    assert!(parts[3].ends_with(&format!("[{source_id}]")), "{root_path}");
    let lower = stored_body.to_ascii_lowercase();
    assert!(!lower.contains("<script"), "{stored_body}");
    assert!(!lower.contains("javascript:"), "{stored_body}");
    assert_eq!(metadata["rootPath"], json!(root_path));
}

#[test]
#[ignore = "local-only: needs SANITIZE_INPUT_FILE and SANITIZE_OUTPUT_FILE"]
fn sanitize_local_file() {
    let (Some(input), Some(output)) = (env_path("SANITIZE_INPUT_FILE"), env_path("SANITIZE_OUTPUT_FILE")) else {
        println!("skip: SANITIZE_INPUT_FILE / SANITIZE_OUTPUT_FILE not set");
        return;
    };
    let html = std::fs::read_to_string(&input).unwrap();
    std::fs::write(&output, storage_host::html::sanitize_body(&html)).unwrap();
}
