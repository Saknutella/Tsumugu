//! `monochrome-storage-host`: environment-driven storage host, a drop-in
//! replacement for `verify/storage-lab/host-server-start.mjs`.
//!
//! Same environment contract (`MONOCHROME_DATA`, `MONOCHROME_SOURCE`,
//! `MONOCHROME_BIND`, `MONOCHROME_PORT`, `MONOCHROME_TOKEN`,
//! `MONOCHROME_MEDIA_TTL_MS`), same single JSON line on stdout describing the
//! bound URL, same structured failure line on stderr/stdout with a non-zero exit.
//! The launcher scripts and the differential harness parse that line, so the shape
//! is a contract, not logging.

use std::process;

use storage_http::server::{host_options_from_env, server_options_from_env};
use storage_host::host::Host;

fn emit(value: serde_json::Value) {
    println!("{}", serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string()));
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    if let Err(error) = run().await {
        emit(serde_json::json!({
            "ok": false,
            "service": "monochrome-storage-lab",
            "error": { "code": null, "message": error },
        }));
        process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let host_options = host_options_from_env()?;
    let server_options = server_options_from_env()?;
    let auth = if server_options.token.is_some() { "bearer" } else { "none" };
    let source_configured = host_options.source_root.is_some();
    let bind = server_options.host.clone();

    let host = Host::open(host_options).map_err(|error| {
        serde_json::json!({ "code": error.code, "message": error.message }).to_string()
    })?;
    let library_id = host.library_id().to_string();
    let server = storage_http::start(host, server_options).await?;

    emit(serde_json::json!({
        "ok": true,
        "service": "monochrome-storage-lab",
        "url": server.url,
        "health": format!("{}/health", server.url),
        "healthUrl": format!("{}/health", server.url),
        "libraryId": library_id,
        "bind": bind,
        "port": server.port,
        "sourceConfigured": source_configured,
        "auth": auth,
    }));

    // Wait for Ctrl-C (SIGINT). SIGTERM handling needs platform code; on Windows
    // Ctrl-Break terminates the process, which is also what the Node host allows.
    let _ = tokio::signal::ctrl_c().await;
    let _ = server.shutdown.send(());
    emit(serde_json::json!({
        "ok": true,
        "service": "monochrome-storage-lab",
        "shutdown": "SIGINT",
        "url": server.url,
    }));
    Ok(())
}
