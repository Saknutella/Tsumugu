//! `storage-lab-cli`: Rust replacement for `verify/storage-lab/host.mjs`.
//!
//! Same contract as the Node CLI: one subcommand, `--name value` options,
//! exactly one pretty-printed JSON object on stdout, non-zero exit on failure
//! (`{ ok: false, command, error: { message, code } }`). Scripts parse that
//! object, so its shape is the interface, not cosmetic output.
//!
//! Commands: scan, import, backup, restore, export, verify, download, legacy.
//! `legacy` (`--bundle <json> [--key <k>]`) has no Node CLI counterpart: Node only
//! reaches migrateLegacyBundle from tests. It exists so a library migrated by
//! either backend can be resumed/checked by the other.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{json, Value};

use storage_host::core::error::Error;
use storage_host::host::{Host, HostOptions};

const COMMANDS: &[&str] = &["scan", "import", "backup", "restore", "export", "verify", "download", "legacy"];

struct Args {
    command: Option<String>,
    options: HashMap<String, String>,
    candidates: Vec<String>,
    include_media: Option<bool>,
    help: bool,
}

fn parse_args(argv: &[String]) -> Result<Args, Error> {
    let command = argv.first().filter(|value| !value.starts_with("--")).cloned();
    let mut args = Args { command, options: HashMap::new(), candidates: Vec::new(), include_media: None, help: false };
    let mut index = if args.command.is_some() { 1 } else { 0 };
    while index < argv.len() {
        let arg = &argv[index];
        let Some(name) = arg.strip_prefix("--") else {
            return Err(Error::new(format!("unexpected argument: {arg}")));
        };
        match name {
            "help" => args.help = true,
            "include-media" => args.include_media = Some(true),
            "no-include-media" => args.include_media = Some(false),
            _ => {
                let value = argv
                    .get(index + 1)
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(|| Error::new(format!("missing value for --{name}")))?;
                index += 1;
                if name == "candidate" {
                    args.candidates.push(value.clone());
                } else {
                    args.options.insert(name.to_string(), value.clone());
                }
            }
        }
        index += 1;
    }
    Ok(args)
}

fn number_option(args: &Args, name: &str) -> Result<Option<u64>, Error> {
    match args.options.get(name) {
        None => Ok(None),
        Some(value) => value
            .parse::<u64>()
            .map(Some)
            .map_err(|_| Error::new(format!("--{name} must be a non-negative integer"))),
    }
}

fn absolute(value: &str) -> PathBuf {
    let path = Path::new(value);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|cwd| cwd.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    storage_host::core::paths::resolve_lexical(&joined)
}

/// `.../data` means "the library root is its parent" (`resolveLibraryRoot`).
fn library_root(value: &str) -> PathBuf {
    let root = absolute(value);
    if root.file_name().map(|name| name == "data").unwrap_or(false) {
        if let Some(parent) = root.parent() {
            return parent.to_path_buf();
        }
    }
    root
}

fn emit(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string()));
}

fn open_host(args: &Args) -> Result<Host, Error> {
    let library = args
        .options
        .get("library")
        .or_else(|| args.options.get("library-root"))
        .ok_or_else(|| Error::new("--library is required"))?;
    let source = args.options.get("source").map(|value| absolute(value));
    Host::open(HostOptions {
        library_root: library_root(library),
        allowed_source_roots: source.iter().cloned().collect(),
        source_root: source,
        // The CLI is an operator tool: the operator names the library root.
        // Node's CLI keeps the experiment-root guard; MONOCHROME_EXPERIMENT_ROOT
        // restores it here when set.
        allow_outside_root: std::env::var("MONOCHROME_EXPERIMENT_ROOT").is_err(),
        experiment_root: None,
        snapshot_fault: None,
    })
}

fn scan_options(args: &Args) -> Result<Value, Error> {
    let mut options = serde_json::Map::new();
    options.insert("mode".to_string(), json!(args.options.get("mode").map(String::as_str).unwrap_or("single")));
    if let Some(depth) = number_option(args, "max-depth")? {
        options.insert("maxDepth".to_string(), json!(depth));
    }
    if let Some(files) = number_option(args, "max-files")? {
        options.insert("maxFiles".to_string(), json!(files));
    }
    Ok(Value::Object(options))
}

/// Run one command; `Ok((ok, value))` where `ok == false` still prints the
/// value but exits 1 (e.g. verify found issues).
fn run(args: &Args, command: &str) -> Result<(bool, Value), Error> {
    if command == "restore" {
        let (Some(backup), Some(destination)) = (args.options.get("backup"), args.options.get("destination")) else {
            return Err(Error::new("--backup and --destination are required"));
        };
        let result = restore(&absolute(backup), &absolute(destination))?;
        return Ok((true, json!({ "ok": true, "command": command, "result": result })));
    }

    let mut host = open_host(args)?;
    let outcome = (|| -> Result<(bool, Value), Error> {
        match command {
            "scan" => {
                if host.source_root.is_none() {
                    return Err(Error::new("--source is required for scan"));
                }
                let preview = scan(&mut host, &scan_options(args)?)?;
                let candidates = preview.get("candidates").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
                Ok((true, json!({
                    "ok": true,
                    "command": command,
                    "preview": preview,
                    "summary": {
                        "candidateCount": candidates,
                        "sourceRoot": preview.get("sourceRoot"),
                        "mode": preview.get("mode"),
                    },
                })))
            }
            "import" => {
                if host.source_root.is_none() {
                    return Err(Error::new("--source is required for import"));
                }
                let preview = scan(&mut host, &scan_options(args)?)?;
                let all: Vec<String> = preview
                    .get("candidates")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(|item| item.get("candidateId").and_then(Value::as_str).map(str::to_string)).collect())
                    .unwrap_or_default();
                let selected: Vec<String> = if args.candidates.is_empty() {
                    all.clone()
                } else {
                    args.candidates
                        .iter()
                        .flat_map(|value| value.split(',').map(str::trim).filter(|part| !part.is_empty()).map(str::to_string))
                        .collect()
                };
                if selected.is_empty() {
                    return Err(Error::new("no candidates selected"));
                }
                let result = host.import_candidates(&preview, &selected)?;
                let failed = result.get("failed").and_then(Value::as_u64).unwrap_or(0);
                Ok((failed == 0, json!({
                    "ok": failed == 0,
                    "command": command,
                    "result": result,
                    "summary": {
                        "candidateCount": all.len(),
                        "selectedCount": selected.len(),
                        "imported": result.get("imported"),
                        "failed": failed,
                    },
                })))
            }
            "backup" => {
                let destination = args.options.get("destination").ok_or_else(|| Error::new("--destination is required"))?;
                let backup = backup(&mut host, &absolute(destination), args.include_media != Some(false))?;
                let complete = backup.get("complete").and_then(Value::as_bool) == Some(true);
                Ok((complete, json!({ "ok": complete, "command": command, "backup": backup })))
            }
            "export" => {
                let (Some(work), Some(destination)) = (args.options.get("work"), args.options.get("destination")) else {
                    return Err(Error::new("--work and --destination are required"));
                };
                let friendly = args
                    .options
                    .get("friendly-name")
                    .or_else(|| args.options.get("friendlyName"))
                    .map(String::as_str)
                    .unwrap_or("auto");
                let exported = export(&mut host, work, &absolute(destination), friendly)?;
                Ok((true, json!({ "ok": true, "command": command, "export": exported })))
            }
            "download" => {
                let (Some(entry), Some(url)) = (args.options.get("entry"), args.options.get("source-url")) else {
                    return Err(Error::new("--entry and --source-url are required"));
                };
                let options = storage_host::download::BeginOptions {
                    source_url: url.clone(),
                    expected_bytes: number_option(args, "expected-bytes")?,
                    source_version: args.options.get("source-version").cloned(),
                    task_id: None,
                };
                let downloaded = storage_host::download::download_entry(&host.library, entry, &options)?;
                let completed = downloaded.get("status").and_then(Value::as_str) == Some("completed");
                Ok((completed, json!({ "ok": completed, "command": command, "download": downloaded })))
            }
            "legacy" => {
                let path = args.options.get("bundle").ok_or_else(|| Error::new("--bundle is required"))?;
                let raw = std::fs::read_to_string(absolute(path))?;
                let bundle: Value = serde_json::from_str(&raw).map_err(|error| Error::new(format!("invalid bundle JSON: {error}")))?;
                let options = storage_host::core::legacy::LegacyOptions { idempotency_key: args.options.get("key").cloned(), after_voice: None };
                let migrated = host.library.migrate_legacy_bundle(&bundle, &options)?;
                let completed = migrated.summary["status"] == "completed";
                Ok((completed, json!({
                    "ok": completed,
                    "command": command,
                    "legacy": migrated.summary,
                    "idempotent": migrated.idempotent,
                    "resumed": migrated.resumed,
                })))
            }
            "verify" => {
                let verification = host.verify()?;
                let ok = verification.get("ok").and_then(Value::as_bool) == Some(true);
                Ok((ok, json!({ "ok": ok, "command": command, "verification": verification })))
            }
            _ => Err(Error::new(format!("unknown command: {command}"))),
        }
    })();
    let closed = host.close();
    let outcome = outcome?;
    closed?;
    Ok(outcome)
}

// Thin adapters from the CLI's option shapes to the library API.

fn scan(host: &mut Host, options: &Value) -> Result<Value, Error> {
    host.scan(options)
}

fn backup(host: &mut Host, destination: &Path, include_media: bool) -> Result<Value, Error> {
    host.library.backup_library(destination, &storage_host::core::backup::BackupOptions { include_media })
}

fn restore(backup: &Path, destination: &Path) -> Result<Value, Error> {
    storage_host::core::backup::restore_library(backup, destination)
}

fn export(host: &mut Host, work: &str, destination: &Path, friendly: &str) -> Result<Value, Error> {
    host.library.export_work(work, destination, Some(friendly))
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let command_hint = argv.first().filter(|value| !value.starts_with("--")).cloned();
    let failure = |command: Option<String>, error: Error| {
        emit(&json!({
            "ok": false,
            "command": command,
            "error": { "message": error.message, "code": error.code },
        }));
        ExitCode::from(1)
    };
    let args = match parse_args(&argv) {
        Ok(args) => args,
        Err(error) => return failure(command_hint, error),
    };
    let Some(command) = args.command.clone().filter(|_| !args.help) else {
        emit(&json!({
            "ok": true,
            "command": args.command.clone().unwrap_or_else(|| "help".to_string()),
            "usage": COMMANDS.iter().map(|name| format!("storage-lab-cli {name} --library <root> ...")).collect::<Vec<_>>(),
            "commands": COMMANDS,
        }));
        // Node exits 1 when no command was given, 0 for an explicit --help.
        return if args.command.is_none() { ExitCode::from(1) } else { ExitCode::SUCCESS };
    };
    if !COMMANDS.contains(&command.as_str()) {
        return failure(Some(command.clone()), Error::new(format!("unknown command: {command}")));
    }
    match run(&args, &command) {
        Ok((ok, value)) => {
            emit(&value);
            if ok { ExitCode::SUCCESS } else { ExitCode::from(1) }
        }
        Err(error) => failure(Some(command), error),
    }
}
