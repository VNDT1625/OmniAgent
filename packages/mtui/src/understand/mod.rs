pub mod wiki;
use crate::error::MtuiError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryCache {
    built_at: u64,
    overview: Option<ProjectOverview>,
    runbook: Option<serde_json::Value>,
    modules: Vec<ModuleSummary>,
    files: Vec<FileSummary>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectOverview {
    tagline: String,
    description: String,
    technologies: Vec<String>,
    entry_points: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModuleSummary {
    id: String,
    label: String,
    layer: String,
    summary: String,
    fingerprint: Option<String>,
    file_count: usize,
    files: Vec<String>,
    parent_id: Option<String>,
    child_module_ids: Option<Vec<String>>,
    related_module_ids: Option<Vec<String>>,
    entry_files: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileSummary {
    path: String,
    label: String,
    group: String,
    layer: String,
    summary: String,
    summary_source: Option<String>,
    tags: Vec<String>,
    symbols: Vec<serde_json::Value>,
    language: String,
    imported_by: usize,
    fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UnderstandResult {
    pub command: String,
    pub target_type: String,
    pub target: String,
    pub built_at: u64,
    pub stale: bool,
    pub summary: String,
    pub details: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct ContextCandidate {
    pub path: String,
    pub score: usize,
    pub stale: bool,
    pub reason: String,
    pub role: String,
    pub layer: String,
    pub language: String,
    pub module: Option<String>,
    pub summary: String,
    pub next_commands: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FreshnessSummary {
    pub fresh: bool,
    pub stale_marker: bool,
    pub marker_changed_count: usize,
    pub changed_count: usize,
    pub missing_count: usize,
    pub unknown_fingerprint_count: usize,
    pub sample_marker_changed: Vec<String>,
    pub sample_changed: Vec<String>,
    pub sample_missing: Vec<String>,
    pub sample_unknown: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ContextResult {
    pub command: String,
    pub intent: String,
    pub built_at: u64,
    pub stale: bool,
    pub freshness: FreshnessSummary,
    pub candidate_count: usize,
    pub candidates: Vec<ContextCandidate>,
}

#[derive(Debug, Serialize)]
pub struct MapOverview {
    pub tagline: String,
    pub description: String,
    pub technologies: Vec<String>,
    pub entry_points: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MapModuleEntry {
    pub path: String,
    pub label: String,
    pub layer: String,
    pub summary: String,
    pub file_count: usize,
    pub key_files: Vec<String>,
    pub parent_id: Option<String>,
    pub child_module_ids: Vec<String>,
    pub related_module_ids: Vec<String>,
    pub entry_files: Vec<String>,
    pub stale: bool,
    pub when_to_open: Vec<String>,
    pub next_commands: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MapFileEntry {
    pub path: String,
    pub role: String,
    pub layer: String,
    pub language: String,
    pub summary: String,
    pub read_priority: usize,
    pub stale: bool,
    pub next_commands: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MapIntentStep {
    pub step: String,
    pub files: Vec<String>,
    pub folders: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MapResult {
    pub command: String,
    pub scope: String,
    pub target: String,
    pub built_at: u64,
    pub stale: bool,
    pub freshness: FreshnessSummary,
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overview: Option<MapOverview>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<MapModuleEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<MapFileEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recommended_path: Vec<MapIntentStep>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub related_folders: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub next_commands: Vec<String>,
}

fn cache_path(project_root: &Path) -> std::path::PathBuf {
    project_root
        .join(".aionui")
        .join("understand")
        .join("summary.json")
}

fn stale_marker_path(project_root: &Path) -> std::path::PathBuf {
    project_root
        .join(".aionui")
        .join("understand")
        .join("stale.json")
}

fn cache_has_stale_marker(project_root: &Path) -> bool {
    stale_marker_path(project_root).exists()
}

fn stale_marker_paths(project_root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(stale_marker_path(project_root)) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let mut paths = json
        .get("paths")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|path| path.replace('\\', "/")))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    paths.sort();
    paths.dedup();
    paths
}

fn load_cache(project_root: &Path) -> Result<SummaryCache, MtuiError> {
    let path = cache_path(project_root);
    let text = std::fs::read_to_string(&path).map_err(|_| MtuiError::FileNotFound {
        message: "Understand summary cache not found".to_string(),
        suggestion: "Build Understand/codegraph in the IDE first".to_string(),
    })?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| MtuiError::Internal {
        message: format!("Failed to parse Understand summary cache: {}", e),
    })
}

fn normalize_rel(path: &Path, project_root: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    };
    absolute
        .strip_prefix(project_root)
        .unwrap_or(&absolute)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string()
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_target_path(project_root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    }
}

fn should_skip_fallback_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            matches!(
                name,
                ".git" | ".mtui" | ".aionui" | "node_modules" | "target" | "dist" | "build"
            )
        })
        .unwrap_or(false)
}

fn language_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "toml" => "toml",
        "md" | "mdx" => "markdown",
        "css" => "css",
        "html" => "html",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "cpp" | "cc" | "cxx" | "hpp" | "h" => "cpp",
        _ => "text",
    }
}

fn is_code_like_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default(),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "json"
            | "toml"
            | "md"
            | "mdx"
            | "css"
            | "html"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "swift"
            | "cpp"
            | "cc"
            | "cxx"
            | "hpp"
            | "h"
    )
}

fn fallback_symbol_scan(text: &str) -> Vec<serde_json::Value> {
    let mut symbols = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        let candidates = [
            ("function", "function "),
            ("class", "class "),
            ("type", "type "),
            ("interface", "interface "),
            ("const", "const "),
            ("fn", "fn "),
            ("struct", "struct "),
            ("enum", "enum "),
            ("trait", "trait "),
            ("impl", "impl "),
            ("mod", "mod "),
            ("pub fn", "pub fn "),
            ("pub struct", "pub struct "),
            ("pub enum", "pub enum "),
            ("pub mod", "pub mod "),
        ];
        for (kind, marker) in candidates {
            if let Some(at) = trimmed.find(marker) {
                let name = trimmed[at + marker.len()..]
                    .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'))
                    .find(|part| !part.is_empty())
                    .unwrap_or("<anonymous>");
                symbols.push(serde_json::json!({
                    "name": name,
                    "kind": kind,
                    "line": index + 1,
                    "source": "filesystem-fallback",
                }));
                break;
            }
        }
        if symbols.len() >= 24 {
            break;
        }
    }
    symbols
}

fn fallback_folder_files(project_root: &Path, folder_path: &Path, limit: usize) -> Vec<PathBuf> {
    let folder = resolve_target_path(project_root, folder_path);
    if !folder.exists() {
        return Vec::new();
    }
    let mut files = walkdir::WalkDir::new(folder)
        .into_iter()
        .filter_entry(|entry| {
            !entry.file_type().is_dir() || !should_skip_fallback_dir(entry.path())
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .filter(|path| is_code_like_file(path))
        .collect::<Vec<_>>();
    files.sort();
    files.truncate(limit.max(1));
    files
}

fn fallback_file_result(
    project_root: &Path,
    file_path: &Path,
    detailed: bool,
    built_at: Option<u64>,
) -> Result<UnderstandResult, MtuiError> {
    let absolute = resolve_target_path(project_root, file_path);
    if !absolute.exists() || !absolute.is_file() {
        return Err(MtuiError::NoMatch {
            message: format!(
                "No Understand summary or filesystem file for: {}",
                normalize_rel(file_path, project_root)
            ),
            suggestion: "Rebuild Understand/codegraph or check the file path".to_string(),
        });
    }
    let target = normalize_rel(&absolute, project_root);
    let content = crate::fs::read_file_utf8(&absolute).unwrap_or_default();
    let symbols = fallback_symbol_scan(&content);
    let language = language_for_path(&absolute);
    let line_count = content.lines().count();
    let summary = format!(
        "Filesystem fallback: `{}` is a {} file with {} line(s), {} byte(s), and {} detected symbol(s). Rebuild Understand/codegraph for semantic relationships.",
        target,
        language,
        line_count,
        content.len(),
        symbols.len()
    );
    Ok(UnderstandResult {
        command: if detailed { "info" } else { "summary" }.to_string(),
        target_type: "file".to_string(),
        target,
        built_at: built_at.unwrap_or_else(current_millis),
        stale: true,
        summary,
        details: if detailed {
            serde_json::json!({
                "summarySource": "filesystem-fallback",
                "language": language,
                "lineCount": line_count,
                "byteCount": content.len(),
                "symbols": symbols,
                "nextCommands": [
                    format!("mtui --json compass read {} --query \"<intent>\"", normalize_rel(&absolute, project_root)),
                    format!("mtui --json read {} --from <line> --to <line>", normalize_rel(&absolute, project_root))
                ],
            })
        } else {
            serde_json::json!({
                "summarySource": "filesystem-fallback",
                "language": language,
                "lineCount": line_count,
                "symbolCount": symbols.len(),
            })
        },
    })
}

fn fallback_folder_result(
    project_root: &Path,
    folder_path: &Path,
    detailed: bool,
    built_at: Option<u64>,
) -> Result<UnderstandResult, MtuiError> {
    let absolute = resolve_target_path(project_root, folder_path);
    if !absolute.exists() || !absolute.is_dir() {
        return Err(MtuiError::NoMatch {
            message: format!(
                "No Understand summary or filesystem folder for: {}",
                normalize_rel(folder_path, project_root)
            ),
            suggestion: "Rebuild Understand/codegraph or check the folder path".to_string(),
        });
    }
    let target = normalize_rel(&absolute, project_root);
    let files = fallback_folder_files(project_root, &absolute, 80);
    let file_details = files
        .iter()
        .take(24)
        .map(|file| {
            let rel = normalize_rel(file, project_root);
            let language = language_for_path(file);
            serde_json::json!({
                "path": rel,
                "language": language,
                "summarySource": "filesystem-fallback",
                "nextCommands": [
                    format!("mtui --json compass read {} --query \"<intent>\"", normalize_rel(file, project_root)),
                    format!("mtui --json information file {}", normalize_rel(file, project_root))
                ],
            })
        })
        .collect::<Vec<_>>();
    let preview = files
        .iter()
        .take(8)
        .map(|file| format!("- {}", normalize_rel(file, project_root)))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(UnderstandResult {
        command: if detailed { "info" } else { "summary" }.to_string(),
        target_type: "folder".to_string(),
        target,
        built_at: built_at.unwrap_or_else(current_millis),
        stale: true,
        summary: format!(
            "Filesystem fallback: folder contains {} code-like file(s) after ignoring build/cache folders. Rebuild Understand/codegraph for semantic summaries.\n{}",
            files.len(),
            preview
        ),
        details: if detailed {
            serde_json::json!({
                "summarySource": "filesystem-fallback",
                "fileCount": files.len(),
                "files": file_details,
            })
        } else {
            serde_json::json!({
                "summarySource": "filesystem-fallback",
                "fileCount": files.len(),
                "files": file_details.iter().filter_map(|file| file.get("path").and_then(|path| path.as_str()).map(|path| path.to_string())).collect::<Vec<_>>(),
            })
        },
    })
}

fn fallback_map_folder(
    project_root: &Path,
    folder_path: &Path,
    limit: usize,
    built_at: Option<u64>,
) -> Result<MapResult, MtuiError> {
    let absolute = resolve_target_path(project_root, folder_path);
    if !absolute.exists() || !absolute.is_dir() {
        return Err(MtuiError::NoMatch {
            message: format!(
                "No Understand map or filesystem folder for: {}",
                normalize_rel(folder_path, project_root)
            ),
            suggestion: "Rebuild Understand/codegraph or check the folder path".to_string(),
        });
    }
    let target = normalize_rel(&absolute, project_root);
    let files = fallback_folder_files(project_root, &absolute, limit.max(1));
    let file_entries = files
        .iter()
        .enumerate()
        .map(|(index, file)| fallback_map_file_entry(project_root, file, index + 1))
        .collect::<Vec<_>>();
    Ok(MapResult {
        command: "map".to_string(),
        scope: "folder".to_string(),
        target,
        built_at: built_at.unwrap_or_else(current_millis),
        stale: true,
        freshness: fallback_freshness_summary(),
        confidence: "low".to_string(),
        overview: Some(MapOverview {
            tagline: "Filesystem fallback".to_string(),
            description:
                "Understand/codegraph has no semantic map for this folder; MTUI returned a safe filesystem scan instead."
                    .to_string(),
            technologies: Vec::new(),
            entry_points: Vec::new(),
        }),
        modules: Vec::new(),
        files: file_entries,
        recommended_path: Vec::new(),
        related_folders: Vec::new(),
        next_commands: vec![
            "Rebuild Understand/codegraph for semantic map freshness.".to_string(),
            "mtui --json compass read <file> --query \"<intent>\"".to_string(),
            "mtui --json read <file> --from <line> --to <line>".to_string(),
        ],
    })
}

fn fallback_map_file_entry(project_root: &Path, file: &Path, read_priority: usize) -> MapFileEntry {
    let rel = normalize_rel(file, project_root);
    MapFileEntry {
        path: rel.clone(),
        role: "filesystem fallback; graph summary unavailable".to_string(),
        layer: "unknown".to_string(),
        language: language_for_path(file).to_string(),
        summary: format!(
            "`{}` discovered from filesystem fallback. Use compass/read for real code; rebuild Understand/codegraph for semantic ranking.",
            rel
        ),
        read_priority,
        stale: true,
        next_commands: vec![
            format!("mtui --json compass read {} --query \"<intent>\"", rel),
            format!("mtui --json information file {}", rel),
        ],
    }
}

fn base36_u32(mut value: u32) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while value > 0 {
        let digit = value % 36;
        chars.push(std::char::from_digit(digit, 36).unwrap_or('0'));
        value /= 36;
    }
    chars.iter().rev().collect()
}

fn base36_usize(mut value: usize) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u32;
        chars.push(std::char::from_digit(digit, 36).unwrap_or('0'));
        value /= 36;
    }
    chars.iter().rev().collect()
}

fn fingerprint_of(content: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for unit in content.encode_utf16() {
        hash ^= u32::from(unit & 0xff);
        hash = hash.wrapping_mul(0x01000193);
        hash ^= u32::from(unit >> 8);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!(
        "{}-{}",
        base36_usize(content.encode_utf16().count()),
        base36_u32(hash)
    )
}

fn file_is_stale(project_root: &Path, file: &FileSummary) -> bool {
    let Some(expected) = &file.fingerprint else {
        return true;
    };
    let path = project_root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let Ok(content) = std::fs::read_to_string(path) else {
        return true;
    };
    fingerprint_of(&content) != *expected
}

fn freshness_sample(mut paths: Vec<String>) -> Vec<String> {
    paths.sort();
    paths.truncate(8);
    paths
}

fn fallback_freshness_summary() -> FreshnessSummary {
    FreshnessSummary {
        fresh: false,
        stale_marker: false,
        marker_changed_count: 0,
        changed_count: 0,
        missing_count: 0,
        unknown_fingerprint_count: 0,
        sample_marker_changed: Vec::new(),
        sample_changed: Vec::new(),
        sample_missing: Vec::new(),
        sample_unknown: Vec::new(),
    }
}

fn freshness_summary(project_root: &Path, cache: &SummaryCache) -> FreshnessSummary {
    let marker_changed = stale_marker_paths(project_root);
    let stale_marker = !marker_changed.is_empty() || cache_has_stale_marker(project_root);
    let mut changed = Vec::new();
    let mut missing = Vec::new();
    let mut unknown = Vec::new();
    for file in &cache.files {
        let Some(expected) = &file.fingerprint else {
            unknown.push(file.path.clone());
            continue;
        };
        let path = project_root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        match std::fs::read_to_string(path) {
            Ok(content) => {
                if fingerprint_of(&content) != *expected {
                    changed.push(file.path.clone());
                }
            }
            Err(_) => missing.push(file.path.clone()),
        }
    }
    let changed_count = changed.len();
    let missing_count = missing.len();
    let unknown_fingerprint_count = unknown.len();
    let marker_changed_count = marker_changed.len();
    FreshnessSummary {
        fresh: !stale_marker
            && changed_count == 0
            && missing_count == 0
            && unknown_fingerprint_count == 0,
        stale_marker,
        marker_changed_count,
        changed_count,
        missing_count,
        unknown_fingerprint_count,
        sample_marker_changed: freshness_sample(marker_changed),
        sample_changed: freshness_sample(changed),
        sample_missing: freshness_sample(missing),
        sample_unknown: freshness_sample(unknown),
    }
}

pub fn query_file(
    project_root: &Path,
    file_path: &Path,
    detailed: bool,
) -> Result<UnderstandResult, MtuiError> {
    let target = normalize_rel(file_path, project_root);
    let cache = match load_cache(project_root) {
        Ok(cache) => cache,
        Err(_) => return fallback_file_result(project_root, file_path, detailed, None),
    };
    let file = cache.files.iter().find(|item| item.path == target);
    let Some(file) = file else {
        return fallback_file_result(project_root, file_path, detailed, Some(cache.built_at));
    };
    let stale = file_is_stale(project_root, file);
    let details = if detailed {
        serde_json::to_value(file).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::json!({
            "layer": file.layer,
            "tags": file.tags,
            "symbols": file.symbols,
            "importedBy": file.imported_by,
        })
    };

    Ok(UnderstandResult {
        command: if detailed { "info" } else { "summary" }.to_string(),
        target_type: "file".to_string(),
        target,
        built_at: cache.built_at,
        stale,
        summary: file.summary.clone(),
        details,
    })
}

fn folder_file_details(files: &[FileSummary]) -> Vec<serde_json::Value> {
    files
        .iter()
        .map(|file| {
            let symbols = file
                .symbols
                .iter()
                .take(12)
                .map(|symbol| {
                    serde_json::json!({
                        "name": symbol.get("name").cloned().unwrap_or(serde_json::Value::Null),
                        "kind": symbol.get("kind").cloned().unwrap_or(serde_json::Value::Null),
                        "line": symbol.get("line").cloned().unwrap_or(serde_json::Value::Null),
                    })
                })
                .collect::<Vec<_>>();
            serde_json::json!({
                "path": file.path,
                "label": file.label,
                "layer": file.layer,
                "language": file.language,
                "summary": file.summary,
                "summarySource": file.summary_source,
                "tags": file.tags,
                "importedBy": file.imported_by,
                "fingerprint": file.fingerprint,
                "symbolCount": file.symbols.len(),
                "symbols": symbols,
            })
        })
        .collect()
}

pub fn query_folder(
    project_root: &Path,
    folder_path: &Path,
    detailed: bool,
) -> Result<UnderstandResult, MtuiError> {
    let target = normalize_rel(folder_path, project_root);
    let cache = match load_cache(project_root) {
        Ok(cache) => cache,
        Err(_) => return fallback_folder_result(project_root, folder_path, detailed, None),
    };
    if target.is_empty() || target == "." {
        return Ok(UnderstandResult {
            command: if detailed { "info" } else { "summary" }.to_string(),
            target_type: "folder".to_string(),
            target: ".".to_string(),
            built_at: cache.built_at,
            stale: cache
                .files
                .iter()
                .any(|file| file_is_stale(project_root, file)),
            summary: cache
                .overview
                .as_ref()
                .map(|overview| overview.description.clone())
                .unwrap_or_else(|| {
                    "Project overview is not available in the Understand cache.".to_string()
                }),
            details: if detailed {
                serde_json::json!({
                    "overview": cache.overview,
                    "runbook": cache.runbook,
                    "modules": cache.modules,
                })
            } else {
                serde_json::json!({
                    "moduleCount": cache.modules.len(),
                    "fileCount": cache.files.len(),
                    "entryPoints": cache.overview.as_ref().map(|overview| overview.entry_points.clone()).unwrap_or_default(),
                })
            },
        });
    }

    let module = cache.modules.iter().find(|item| {
        item.id == target
            || item
                .files
                .iter()
                .any(|file| file.starts_with(&format!("{}/", target)))
    });
    let Some(module) = module else {
        let files = cache
            .files
            .iter()
            .filter(|file| file.path.starts_with(&format!("{}/", target)))
            .cloned()
            .collect::<Vec<_>>();
        if files.is_empty() {
            return fallback_folder_result(
                project_root,
                folder_path,
                detailed,
                Some(cache.built_at),
            );
        }
        let stale = files.iter().any(|file| file_is_stale(project_root, file));
        let summaries = files
            .iter()
            .take(6)
            .map(|file| format!("- {}: {}", file.path, file.summary))
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(UnderstandResult {
            command: if detailed { "info" } else { "summary" }.to_string(),
            target_type: "folder".to_string(),
            target,
            built_at: cache.built_at,
            stale,
            summary: format!(
                "Folder contains {} summarized file(s).\n{}",
                files.len(),
                summaries
            ),
            details: if detailed {
                serde_json::json!({
                    "files": folder_file_details(&files),
                })
            } else {
                serde_json::json!({
                    "fileCount": files.len(),
                    "files": files.iter().map(|file| file.path.clone()).collect::<Vec<_>>(),
                })
            },
        });
    };
    let target_prefix = format!("{}/", target);
    let module_matches_target = module.id == target;
    let module_file_paths = if module_matches_target {
        module.files.clone()
    } else {
        module
            .files
            .iter()
            .filter(|path| path.starts_with(&target_prefix))
            .cloned()
            .collect::<Vec<_>>()
    };
    let files = cache
        .files
        .iter()
        .filter(|file| module_file_paths.contains(&file.path))
        .cloned()
        .collect::<Vec<_>>();
    let stale = files.iter().any(|file| file_is_stale(project_root, file));
    let summary = if module_matches_target {
        module.summary.clone()
    } else {
        let key_files = files
            .iter()
            .filter(|file| is_key_file(&file.path))
            .map(|file| file.path.clone())
            .take(6)
            .collect::<Vec<_>>();
        let summaries = files
            .iter()
            .take(6)
            .map(|file| format!("- {}: {}", file.path, file.summary))
            .collect::<Vec<_>>()
            .join("\n");
        let folder_summary =
            synthetic_folder_summary(&target, &files, &key_files, &dominant_layer(&files));
        format!("{}\n{}", folder_summary, summaries)
    };
    let module_details = if module_matches_target {
        serde_json::json!({
            "id": module.id,
            "label": module.label,
            "layer": module.layer,
            "summary": module.summary,
            "fingerprint": module.fingerprint,
            "fileCount": files.len(),
            "files": module_file_paths,
            "parentId": module.parent_id,
            "childModuleIds": module.child_module_ids,
            "relatedModuleIds": module.related_module_ids,
            "entryFiles": module.entry_files,
        })
    } else {
        serde_json::json!({
            "id": target,
            "label": target.rsplit_once('/').map(|(_, label)| label).unwrap_or(&target),
            "layer": dominant_layer(&files),
            "summary": summary,
            "fingerprint": null,
            "fileCount": files.len(),
            "files": module_file_paths,
            "parentId": target.rsplit_once('/').map(|(parent, _)| parent),
            "childModuleIds": [],
            "relatedModuleIds": [],
            "entryFiles": files.iter().filter(|file| is_key_file(&file.path)).map(|file| file.path.clone()).take(6).collect::<Vec<_>>(),
            "sourceModule": module.id,
        })
    };
    let details = if detailed {
        serde_json::json!({
            "module": module_details,
            "files": folder_file_details(&files),
        })
    } else {
        serde_json::json!({
            "layer": if module_matches_target { module.layer.clone() } else { dominant_layer(&files) },
            "fileCount": files.len(),
            "files": module_file_paths,
            "sourceModule": if module_matches_target { None::<String> } else { Some(module.id.clone()) },
        })
    };

    Ok(UnderstandResult {
        command: if detailed { "info" } else { "summary" }.to_string(),
        target_type: "folder".to_string(),
        target,
        built_at: cache.built_at,
        stale,
        summary,
        details,
    })
}

pub fn map_repo(project_root: &Path, limit: usize) -> Result<MapResult, MtuiError> {
    let cache = load_cache(project_root)?;
    let freshness = freshness_summary(project_root, &cache);
    let mut modules = cache
        .modules
        .iter()
        .map(|module| map_module_entry(project_root, &cache, module))
        .collect::<Vec<_>>();
    modules.sort_by(|a, b| {
        b.file_count
            .cmp(&a.file_count)
            .then_with(|| a.path.cmp(&b.path))
    });
    modules.truncate(limit.max(1));
    let stale = !freshness.fresh || modules.iter().any(|module| module.stale);
    let overview = cache.overview.as_ref().map(|overview| MapOverview {
        tagline: overview.tagline.clone(),
        description: overview.description.clone(),
        technologies: overview.technologies.clone(),
        entry_points: overview.entry_points.clone(),
    });
    Ok(MapResult {
        command: "map".to_string(),
        scope: "repo".to_string(),
        target: ".".to_string(),
        built_at: cache.built_at,
        stale,
        freshness,
        confidence: if stale { "medium" } else { "high" }.to_string(),
        overview,
        modules,
        files: Vec::new(),
        recommended_path: Vec::new(),
        related_folders: Vec::new(),
        next_commands: vec![
            "mtui --json map intent \"<intent>\"".to_string(),
            "mtui --json map folder <folder>".to_string(),
            "mtui --json context \"<intent>\"".to_string(),
        ],
    })
}

pub fn map_folder(
    project_root: &Path,
    folder_path: &Path,
    limit: usize,
) -> Result<MapResult, MtuiError> {
    let target = normalize_rel(folder_path, project_root);
    let cache = match load_cache(project_root) {
        Ok(cache) => cache,
        Err(_) => return fallback_map_folder(project_root, folder_path, limit, None),
    };
    let freshness = freshness_summary(project_root, &cache);
    let module = cache.modules.iter().find(|item| {
        item.id == target
            || item
                .files
                .iter()
                .any(|file| file.starts_with(&format!("{}/", target)))
    });
    let files = if let Some(module) = module {
        cache
            .files
            .iter()
            .filter(|file| module.files.contains(&file.path))
            .filter(|file| {
                module.id == target
                    || target.is_empty()
                    || file.path == target
                    || file.path.starts_with(&format!("{}/", target))
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        cache
            .files
            .iter()
            .filter(|file| target.is_empty() || file.path.starts_with(&format!("{}/", target)))
            .cloned()
            .collect::<Vec<_>>()
    };
    if files.is_empty() {
        return fallback_map_folder(project_root, folder_path, limit, Some(cache.built_at));
    }
    let mut file_entries = files
        .iter()
        .enumerate()
        .map(|(index, file)| map_file_entry(project_root, file, index + 1))
        .collect::<Vec<_>>();
    let live_files = if freshness.fresh {
        Vec::new()
    } else {
        fallback_folder_files(project_root, folder_path, 20_000)
    };
    if !live_files.is_empty() {
        let cached_paths = file_entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<std::collections::HashSet<_>>();
        for file in &live_files {
            let rel = normalize_rel(file, project_root);
            if !cached_paths.contains(&rel) {
                file_entries.push(fallback_map_file_entry(project_root, file, 0));
            }
        }
    }
    file_entries.sort_by(|a, b| {
        a.read_priority
            .cmp(&b.read_priority)
            .then_with(|| a.path.cmp(&b.path))
    });
    file_entries.truncate(limit.max(1));
    for (index, entry) in file_entries.iter_mut().enumerate() {
        entry.read_priority = index + 1;
    }
    let stale = !freshness.fresh || file_entries.iter().any(|file| file.stale);
    let related_folders = related_folders_for_files(&files);
    let output_target = if target.is_empty() {
        ".".to_string()
    } else {
        target.clone()
    };
    let mut modules = module
        .filter(|module| target.is_empty() || module.id == target)
        .map(|module| vec![map_module_entry(project_root, &cache, module)])
        .unwrap_or_else(|| vec![synthetic_folder_module_entry(project_root, &target, &files)]);
    if !live_files.is_empty() {
        for module in &mut modules {
            module.file_count = live_files.len();
            module.key_files = live_files
                .iter()
                .take(6)
                .map(|file| normalize_rel(file, project_root))
                .collect();
            module.stale = true;
        }
    }
    Ok(MapResult {
        command: "map".to_string(),
        scope: "folder".to_string(),
        target: output_target,
        built_at: cache.built_at,
        stale,
        freshness,
        confidence: if stale { "medium" } else { "high" }.to_string(),
        overview: cache.overview.as_ref().map(|overview| MapOverview {
            tagline: overview.tagline.clone(),
            description: overview.description.clone(),
            technologies: overview.technologies.clone(),
            entry_points: overview.entry_points.clone(),
        }),
        modules,
        files: file_entries,
        recommended_path: Vec::new(),
        related_folders,
        next_commands: vec![
            "mtui --json map intent \"<intent>\"".to_string(),
            "mtui --json compass read <file> --query \"<intent>\"".to_string(),
            "mtui --json read <file> --from <line> --to <line>".to_string(),
        ],
    })
}

pub fn map_intent(project_root: &Path, intent: &str, limit: usize) -> Result<MapResult, MtuiError> {
    let context = query_context(project_root, intent, limit)?;
    let mut folders = context
        .candidates
        .iter()
        .filter_map(|candidate| {
            candidate
                .path
                .rsplit_once('/')
                .map(|(folder, _)| folder.to_string())
        })
        .collect::<Vec<_>>();
    folders.sort();
    folders.dedup();
    let recommended_path = context
        .candidates
        .iter()
        .take(5)
        .enumerate()
        .map(|(index, candidate)| MapIntentStep {
            step: format!("Inspect candidate {}", index + 1),
            files: vec![candidate.path.clone()],
            folders: candidate
                .path
                .rsplit_once('/')
                .map(|(folder, _)| vec![folder.to_string()])
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    Ok(MapResult {
        command: "map".to_string(),
        scope: "intent".to_string(),
        target: intent.to_string(),
        built_at: context.built_at,
        stale: context.stale,
        freshness: context.freshness.clone(),
        confidence: if context.stale { "medium" } else { "high" }.to_string(),
        overview: None,
        modules: Vec::new(),
        files: context
            .candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| MapFileEntry {
                path: candidate.path.clone(),
                role: candidate.role.clone(),
                layer: candidate.layer.clone(),
                language: candidate.language.clone(),
                summary: candidate.summary.clone(),
                read_priority: index + 1,
                stale: candidate.stale,
                next_commands: candidate.next_commands.clone(),
            })
            .collect(),
        recommended_path,
        related_folders: folders,
        next_commands: vec![
            format!("mtui --json context \"{}\"", intent.replace('"', "\\\"")),
            "mtui --json map folder <folder>".to_string(),
            format!(
                "mtui --json compass read <file> --query \"{}\"",
                intent.replace('"', "\\\"")
            ),
        ],
    })
}

fn map_module_entry(
    project_root: &Path,
    cache: &SummaryCache,
    module: &ModuleSummary,
) -> MapModuleEntry {
    let entry_files = module.entry_files.clone().unwrap_or_default();
    let mut key_files = entry_files.iter().take(6).cloned().collect::<Vec<_>>();
    if key_files.is_empty() {
        key_files = module
            .files
            .iter()
            .filter(|path| is_key_file(path))
            .take(6)
            .cloned()
            .collect::<Vec<_>>();
    }
    if key_files.is_empty() {
        key_files = module.files.iter().take(4).cloned().collect();
    }
    let stale = cache
        .files
        .iter()
        .filter(|file| module.files.contains(&file.path))
        .any(|file| file_is_stale(project_root, file));
    MapModuleEntry {
        path: module.id.clone(),
        label: module.label.clone(),
        layer: module.layer.clone(),
        summary: module.summary.clone(),
        file_count: module.file_count,
        key_files,
        parent_id: module.parent_id.clone(),
        child_module_ids: module.child_module_ids.clone().unwrap_or_default(),
        related_module_ids: module.related_module_ids.clone().unwrap_or_default(),
        entry_files,
        stale,
        when_to_open: when_to_open_terms(module),
        next_commands: vec![
            format!("mtui --json map folder {}", module.id),
            format!("mtui --json summary folder {}", module.id),
        ],
    }
}

fn synthetic_folder_module_entry(
    project_root: &Path,
    target: &str,
    files: &[FileSummary],
) -> MapModuleEntry {
    let label = if target.is_empty() {
        ".".to_string()
    } else {
        target
            .rsplit_once('/')
            .map(|(_, label)| label.to_string())
            .unwrap_or_else(|| target.to_string())
    };
    let mut key_files = files
        .iter()
        .filter(|file| is_key_file(&file.path))
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    if key_files.is_empty() {
        key_files = files.iter().take(6).map(|file| file.path.clone()).collect();
    } else {
        key_files.truncate(6);
    }
    let layer = dominant_layer(files);
    let summary = synthetic_folder_summary(target, files, &key_files, &layer);
    let stale = files.iter().any(|file| file_is_stale(project_root, file));
    let path = if target.is_empty() {
        ".".to_string()
    } else {
        target.to_string()
    };
    MapModuleEntry {
        path: path.clone(),
        label,
        layer,
        summary,
        file_count: files.len(),
        key_files: key_files.clone(),
        parent_id: target
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_string()),
        child_module_ids: Vec::new(),
        related_module_ids: Vec::new(),
        entry_files: key_files,
        stale,
        when_to_open: target
            .split('/')
            .rev()
            .filter(|part| part.len() >= 3)
            .take(5)
            .map(|part| part.to_lowercase())
            .collect(),
        next_commands: vec![
            format!("mtui --json map folder {}", path),
            format!("mtui --json summary folder {}", path),
        ],
    }
}

fn dominant_layer(files: &[FileSummary]) -> String {
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for file in files {
        *counts.entry(file.layer.clone()).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|(left_layer, left_count), (right_layer, right_count)| {
            left_count
                .cmp(right_count)
                .then_with(|| right_layer.cmp(left_layer))
        })
        .map(|(layer, _)| layer)
        .unwrap_or_else(|| "unknown".to_string())
}

fn synthetic_folder_summary(
    target: &str,
    files: &[FileSummary],
    key_files: &[String],
    layer: &str,
) -> String {
    let folder = if target.is_empty() {
        "repo root"
    } else {
        target
    };
    let key = if key_files.is_empty() {
        String::new()
    } else {
        format!(
            " Key files: {}.",
            key_files
                .iter()
                .take(4)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "{} contains {} {} file{} selected from the graph.{}",
        folder,
        files.len(),
        layer,
        if files.len() == 1 { "" } else { "s" },
        key
    )
}

fn map_file_entry(project_root: &Path, file: &FileSummary, priority: usize) -> MapFileEntry {
    MapFileEntry {
        path: file.path.clone(),
        role: role_for_file(file),
        layer: file.layer.clone(),
        language: file.language.clone(),
        summary: file.summary.clone(),
        read_priority: priority,
        stale: file_is_stale(project_root, file),
        next_commands: vec![
            format!(
                "mtui --json information file {}",
                file.path.replace('"', "\\\"")
            ),
            format!(
                "mtui --json compass read {} --query \"<intent>\"",
                file.path.replace('"', "\\\"")
            ),
        ],
    }
}

fn is_key_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with("main.rs")
        || lower.ends_with("mod.rs")
        || lower.ends_with("index.ts")
        || lower.ends_with("index.tsx")
        || lower.ends_with("bridge.ts")
        || lower.ends_with("service.ts")
        || lower.ends_with("manager.ts")
        || lower.ends_with("policy.ts")
        || lower.ends_with("types.ts")
        || lower.ends_with("config.ts")
}

fn role_for_file(file: &FileSummary) -> String {
    let lower = file.path.to_lowercase();
    if lower.ends_with("main.rs") || lower.ends_with("index.ts") || lower.ends_with("index.tsx") {
        "entry/router".to_string()
    } else if lower.contains("bridge") {
        "bridge/ipc".to_string()
    } else if lower.contains("policy") {
        "policy/enforcement".to_string()
    } else if lower.contains("test") || lower.ends_with(".test.ts") || lower.ends_with(".test.tsx")
    {
        "test".to_string()
    } else if lower.contains("service") {
        "service".to_string()
    } else if lower.contains("manager") {
        "manager".to_string()
    } else {
        file.tags
            .first()
            .cloned()
            .unwrap_or_else(|| "source".to_string())
    }
}

fn language_from_path(path: &str) -> String {
    if path.ends_with(".rs") {
        "rust".to_string()
    } else if path.ends_with(".tsx") {
        "tsx".to_string()
    } else if path.ends_with(".ts") {
        "typescript".to_string()
    } else if path.ends_with(".json") {
        "json".to_string()
    } else if path.ends_with(".md") {
        "markdown".to_string()
    } else {
        "unknown".to_string()
    }
}

fn when_to_open_terms(module: &ModuleSummary) -> Vec<String> {
    let mut terms = module
        .summary
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_')
        .filter(|term| term.len() >= 4)
        .take(5)
        .map(|term| term.to_lowercase())
        .collect::<Vec<_>>();
    if terms.is_empty() {
        terms.push(module.label.to_lowercase());
    }
    terms
}

fn related_folders_for_files(files: &[FileSummary]) -> Vec<String> {
    let mut folders = files
        .iter()
        .filter_map(|file| {
            file.path
                .rsplit_once('/')
                .map(|(folder, _)| folder.to_string())
        })
        .collect::<Vec<_>>();
    folders.sort();
    folders.dedup();
    folders.truncate(8);
    folders
}

pub fn query_context(
    project_root: &Path,
    intent: &str,
    limit: usize,
) -> Result<ContextResult, MtuiError> {
    let terms = intent_terms(intent);
    let cache = match load_cache(project_root) {
        Ok(cache) => cache,
        Err(_) => return fallback_context(project_root, intent, &terms, limit),
    };
    let freshness = freshness_summary(project_root, &cache);
    let global_stale = !freshness.fresh;
    let module_by_file = module_lookup_by_file(&cache.modules);
    let mut candidates = cache
        .files
        .iter()
        .filter_map(|file| {
            let module = module_by_file
                .get(&file.path)
                .and_then(|module_id| cache.modules.iter().find(|module| module.id == *module_id));
            let score = context_score(file, module, &terms);
            if score == 0 {
                return None;
            }
            let stale = global_stale || file_is_stale(project_root, file);
            let reason = context_reason(file, &terms);
            Some(ContextCandidate {
                path: file.path.clone(),
                score,
                stale,
                reason,
                role: role_for_file(file),
                layer: file.layer.clone(),
                language: file.language.clone(),
                module: module.map(|item| item.id.clone()),
                summary: file.summary.clone(),
                next_commands: vec![
                    format!(
                        "mtui --json compass read {} --query \"{}\"",
                        file.path,
                        intent.replace('"', "\\\"")
                    ),
                    format!("mtui --json read {} --from 1 --to 160", file.path),
                ],
            })
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        candidates = cache
            .files
            .iter()
            .take(limit.max(1))
            .map(|file| ContextCandidate {
                path: file.path.clone(),
                score: 1,
                stale: global_stale || file_is_stale(project_root, file),
                reason: "fallback_entry".to_string(),
                role: role_for_file(file),
                layer: file.layer.clone(),
                language: file.language.clone(),
                module: module_by_file.get(&file.path).cloned(),
                summary: file.summary.clone(),
                next_commands: vec![format!(
                    "mtui --json compass read {} --query \"{}\"",
                    file.path,
                    intent.replace('"', "\\\"")
                )],
            })
            .collect();
    }
    candidates.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    candidates.truncate(limit.max(1));
    let stale = global_stale || candidates.iter().any(|candidate| candidate.stale);
    Ok(ContextResult {
        command: "context".to_string(),
        intent: intent.to_string(),
        built_at: cache.built_at,
        stale,
        freshness,
        candidate_count: candidates.len(),
        candidates,
    })
}

fn fallback_context(
    project_root: &Path,
    intent: &str,
    terms: &[String],
    limit: usize,
) -> Result<ContextResult, MtuiError> {
    let mut candidates = walkdir::WalkDir::new(project_root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            let relative = path
                .strip_prefix(project_root)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            if should_skip_fallback_path(&relative) {
                return None;
            }
            let path_score = fallback_path_score(&relative, "", terms);
            if path_score == 0 {
                return None;
            }
            let preview = read_fallback_preview(path);
            let score = path_score + fallback_preview_score(&preview, terms);
            let reason = if preview.is_empty() {
                "fallback_path_match_no_understand_cache"
            } else {
                "fallback_path_and_code_preview_no_understand_cache"
            };
            Some(ContextCandidate {
                path: relative.clone(),
                score,
                stale: true,
                reason: reason.to_string(),
                role: "filesystem-fallback".to_string(),
                layer: "unknown".to_string(),
                language: language_from_path(&relative),
                module: relative
                    .rsplit_once('/')
                    .map(|(folder, _)| folder.to_string()),
                summary: fallback_summary_for_path(&relative, !preview.is_empty()),
                next_commands: vec![
                    format!(
                        "mtui --json compass read {} --query \"{}\"",
                        relative,
                        intent.replace('"', "\\\"")
                    ),
                    format!("mtui --json read {} --from 1 --to 160", relative),
                ],
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    candidates.truncate(limit.max(1));
    if candidates.is_empty() {
        return Err(MtuiError::FileNotFound {
            message:
                "Understand summary cache not found and fallback path search found no candidates"
                    .to_string(),
            suggestion:
                "Build Understand/codegraph in the IDE or use `mtui search <path> <keyword>`"
                    .to_string(),
        });
    }
    Ok(ContextResult {
        command: "context".to_string(),
        intent: intent.to_string(),
        built_at: 0,
        stale: true,
        freshness: fallback_freshness_summary(),
        candidate_count: candidates.len(),
        candidates,
    })
}

fn should_skip_fallback_path(path: &str) -> bool {
    path.starts_with(".git/")
        || path.starts_with("node_modules/")
        || path.starts_with("target/")
        || path.starts_with("dist/")
        || path.starts_with("build/")
        || path.starts_with(".mtui/")
        || path.starts_with(".aionui/")
        || path.starts_with(".next/")
        || path.starts_with(".turbo/")
        || path.starts_with("coverage/")
        || path.contains("/node_modules/")
        || path.contains("/target/")
        || path.contains("/dist/")
        || path.contains("/build/")
        || path.contains("/coverage/")
        || path.ends_with(".lock")
        || path.ends_with(".log")
        || path.ends_with(".png")
        || path.ends_with(".jpg")
        || path.ends_with(".jpeg")
        || path.ends_with(".webp")
        || path.ends_with(".gif")
        || path.ends_with(".zip")
        || path.ends_with(".exe")
}

fn intent_terms(intent: &str) -> Vec<String> {
    let mut terms = intent
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-')
        .map(|term| term.trim().to_lowercase())
        .filter(|term| term.len() >= 3)
        .collect::<Vec<_>>();
    let seed = terms.clone();
    for term in seed {
        terms.extend(expand_intent_term(&term));
    }
    terms.sort();
    terms.dedup();
    terms
}

fn expand_intent_term(term: &str) -> Vec<String> {
    match term {
        "understand" => vec!["knowledge", "graph", "context", "summary", "builder", "map"],
        "codegraph" | "graph" => vec![
            "understand",
            "knowledge",
            "graph",
            "context",
            "map",
            "summary",
            "folder",
        ],
        "cursor" => vec!["context", "rank", "ranking", "retrieval", "graph", "search"],
        "map" => vec!["context", "understand", "knowledge", "folder"],
        "summary" => vec!["understand", "information", "folder", "module"],
        "folder" => vec!["module", "directory", "group"],
        "file" | "files" => vec!["path", "source", "symbol"],
        "query" | "search" => vec!["context", "rank", "ranking", "intent"],
        "mtui" => vec!["understand", "context", "map", "compass"],
        "adaptive" | "concurrency" => vec!["summary", "builder", "performance"],
        "fingerprint" => vec!["summary", "module", "freshness", "reuse"],
        "stale" => vec!["freshness", "understand", "summary"],
        _ => Vec::new(),
    }
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn module_lookup_by_file(modules: &[ModuleSummary]) -> std::collections::HashMap<String, String> {
    let mut lookup = std::collections::HashMap::new();
    for module in modules {
        for file in &module.files {
            lookup.insert(file.clone(), module.id.clone());
        }
    }
    lookup
}

fn context_score(file: &FileSummary, module: Option<&ModuleSummary>, terms: &[String]) -> usize {
    let haystack = format!(
        "{} {} {} {} {} {} {}",
        file.path,
        file.label,
        file.group,
        file.layer,
        file.summary,
        file.tags.join(" "),
        module
            .map(|item| format!("{} {} {} {}", item.id, item.label, item.layer, item.summary))
            .unwrap_or_default()
    )
    .to_lowercase();
    let path_terms = path_search_text(&file.path);
    let mut score = 0usize;
    let mut has_direct_match = false;
    for term in terms {
        let importance = term_importance(term);
        let path_score = weighted_match_score(&path_terms, term, 10) * importance;
        let haystack_score = weighted_match_score(&haystack, term, 3) * importance;
        score += path_score;
        score += haystack_score;
        let symbol_hit = file
            .symbols
            .iter()
            .any(|symbol| symbol.to_string().to_lowercase().contains(term));
        if symbol_hit {
            score += 5;
        }
        has_direct_match = has_direct_match || path_score > 0 || haystack_score > 0 || symbol_hit;
        if module
            .and_then(|item| item.entry_files.as_ref())
            .is_some_and(|entry_files| entry_files.contains(&file.path))
            && path_terms.contains(term)
        {
            score += 3;
        }
    }
    if !has_direct_match {
        return 0;
    }
    score += role_boost(file);
    if file.summary_source.as_deref() == Some("llm") {
        score += 1;
    }
    if is_test_path(&file.path) && !intent_wants_tests(terms) {
        score = score.saturating_sub(40);
    }
    score
}

fn path_search_text(path: &str) -> String {
    let mut text = path.to_lowercase();
    let mut expanded = String::new();
    for ch in path.chars() {
        if ch == '/' || ch == '\\' || ch == '-' || ch == '_' || ch == '.' {
            expanded.push(' ');
        } else if ch.is_ascii_uppercase() {
            expanded.push(' ');
            expanded.push(ch.to_ascii_lowercase());
        } else {
            expanded.push(ch.to_ascii_lowercase());
        }
    }
    text.push(' ');
    text.push_str(&expanded);
    text
}

fn weighted_match_score(haystack: &str, term: &str, weight: usize) -> usize {
    if haystack.is_empty() || term.is_empty() {
        return 0;
    }
    if haystack
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|part| part == term)
    {
        weight * 2
    } else if haystack.contains(term) {
        weight
    } else {
        0
    }
}

fn role_boost(file: &FileSummary) -> usize {
    let lower = file.path.to_lowercase();
    if is_key_file(&lower) {
        2
    } else if lower.contains("/tests/")
        || lower.ends_with(".test.ts")
        || lower.ends_with(".test.tsx")
    {
        0
    } else {
        1
    }
}

fn fallback_path_score(path: &str, preview: &str, terms: &[String]) -> usize {
    let path_text = path_search_text(path);
    let mut score = 0usize;
    for term in terms {
        let importance = term_importance(term);
        score += weighted_match_score(&path_text, term, 10) * importance;
        if !preview.is_empty() {
            score += weighted_match_score(&preview.to_lowercase(), term, 2) * importance;
        }
    }
    if is_key_file(path) {
        score += 4;
    }
    if is_test_path(path) && !intent_wants_tests(terms) {
        score = score.saturating_sub(60);
    }
    score
}

fn fallback_preview_score(preview: &str, terms: &[String]) -> usize {
    if preview.is_empty() {
        return 0;
    }
    let preview_text = preview.to_lowercase();
    terms
        .iter()
        .map(|term| weighted_match_score(&preview_text, term, 2) * term_importance(term))
        .sum()
}

fn term_importance(term: &str) -> usize {
    match term {
        "file" | "files" | "path" | "source" | "context" | "map" | "folder" | "module"
        | "group" => 1,
        "rank" | "ranking" | "query" | "search" | "summary" | "information" => 2,
        _ => 3,
    }
}

fn is_test_path(path: &str) -> bool {
    path.contains("/tests/")
        || path.contains("\\tests\\")
        || path.ends_with(".test.ts")
        || path.ends_with(".test.tsx")
        || path.ends_with(".test.rs")
        || path.ends_with(".spec.ts")
        || path.ends_with(".spec.tsx")
}

fn intent_wants_tests(terms: &[String]) -> bool {
    terms.iter().any(|term| {
        matches!(
            term.as_str(),
            "test" | "tests" | "verify" | "verification" | "vitest" | "cargo"
        )
    })
}

fn fallback_summary_for_path(path: &str, used_preview: bool) -> String {
    let folder = path
        .rsplit_once('/')
        .map(|(folder, _)| folder)
        .unwrap_or(".");
    if used_preview {
        format!(
            "Understand cache is unavailable; fallback matched path plus a bounded code preview in folder `{}`.",
            folder
        )
    } else {
        format!(
            "Understand cache is unavailable; fallback matched path only in folder `{}`.",
            folder
        )
    }
}

fn read_fallback_preview(path: &Path) -> String {
    let relative = path.to_string_lossy().to_lowercase();
    if !should_read_fallback_preview(&relative) {
        return String::new();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let max = bytes.len().min(32 * 1024);
    String::from_utf8_lossy(&bytes[..max]).to_string()
}

fn should_read_fallback_preview(path: &str) -> bool {
    path.ends_with(".rs")
        || path.ends_with(".ts")
        || path.ends_with(".tsx")
        || path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".json")
        || path.ends_with(".md")
        || path.ends_with(".toml")
        || path.ends_with(".yaml")
        || path.ends_with(".yml")
}

fn context_reason(file: &FileSummary, terms: &[String]) -> String {
    let symbol_text = file
        .symbols
        .iter()
        .map(|symbol| symbol.to_string().to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let matched = terms
        .iter()
        .filter(|term| {
            file.path.to_lowercase().contains(term.as_str())
                || file.summary.to_lowercase().contains(term.as_str())
                || file
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(term.as_str()))
                || symbol_text.contains(term.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();
    if matched.is_empty() {
        format!("summary/layer match: {}", file.layer)
    } else {
        format!("matched intent terms: {}", matched.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        context_score, fallback_path_score, fallback_preview_score, intent_terms, map_folder,
        query_folder, stale_marker_paths, FileSummary,
    };

    #[test]
    fn intent_terms_expand_codegraph_to_understand_terms() {
        let terms = intent_terms("improve codegraph map ranking");

        assert!(terms.contains(&"codegraph".to_string()));
        assert!(terms.contains(&"understand".to_string()));
        assert!(terms.contains(&"knowledge".to_string()));
        assert!(terms.contains(&"context".to_string()));
        assert!(terms.contains(&"ranking".to_string()));
    }

    #[test]
    fn fallback_path_score_prefers_understand_sources_over_unrelated_context_file() {
        let terms = intent_terms("improve codegraph query related files");
        let understand_score =
            fallback_path_score("packages/mtui/src/understand/mod.rs", "", &terms);
        let unrelated_score =
            fallback_path_score("mobile/src/context/FilesTabContext.tsx", "", &terms);

        assert!(understand_score > unrelated_score);
    }

    #[test]
    fn mixed_benchmark_query_prefers_understand_builder_over_startup_benchmark() {
        let terms = intent_terms(
            "implement adaptive understand concurrency module fingerprint mtui stale benchmark ranking",
        );
        let builder_score = fallback_path_score(
            "packages/desktop/src/process/ide/knowledgeGraphBuilder.ts",
            "summary concurrency module fingerprint freshness understand graph builder",
            &terms,
        );
        let benchmark_score = fallback_path_score(
            "scripts/benchmark-startup.ts",
            "startup benchmark timing script",
            &terms,
        );

        assert!(builder_score > benchmark_score);
    }

    #[test]
    fn context_score_demotes_tests_when_intent_does_not_ask_for_tests() {
        let source = FileSummary {
            path: "src/knowledgeGraphBuilder.ts".to_string(),
            label: "knowledgeGraphBuilder.ts".to_string(),
            group: "src".to_string(),
            layer: "service".to_string(),
            summary: "knowledge graph builder".to_string(),
            summary_source: Some("llm".to_string()),
            tags: vec!["graph".to_string()],
            symbols: Vec::new(),
            language: "typescript".to_string(),
            imported_by: 1,
            fingerprint: None,
        };
        let test = FileSummary {
            path: "tests/unit/ide/knowledgeGraphBuilder.test.ts".to_string(),
            label: "knowledgeGraphBuilder.test.ts".to_string(),
            group: "tests".to_string(),
            layer: "test".to_string(),
            summary: "knowledge graph builder test".to_string(),
            summary_source: Some("llm".to_string()),
            tags: vec!["graph".to_string()],
            symbols: Vec::new(),
            language: "typescript".to_string(),
            imported_by: 0,
            fingerprint: None,
        };
        let source_first_terms = intent_terms("knowledge graph builder");
        let test_terms = intent_terms("test knowledge graph builder");

        assert!(
            context_score(&source, None, &source_first_terms)
                > context_score(&test, None, &source_first_terms)
        );
        assert!(context_score(&test, None, &test_terms) > 0);
    }

    #[test]
    fn fallback_preview_score_uses_bounded_code_content() {
        let terms = intent_terms("knowledge graph context");
        let score =
            fallback_preview_score("export function buildKnowledgeGraphContext() {}", &terms);

        assert!(score > 0);
    }

    #[test]
    fn stale_marker_paths_are_deduped_sorted_and_malformed_safe() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cache_dir = temp.path().join(".aionui").join("understand");
        std::fs::create_dir_all(&cache_dir).expect("cache dir");
        std::fs::write(
            cache_dir.join("stale.json"),
            serde_json::json!({
                "paths": ["src/b.ts", "src/a.ts", "src/a.ts", 42]
            })
            .to_string(),
        )
        .expect("marker");

        assert_eq!(
            stale_marker_paths(temp.path()),
            vec!["src/a.ts".to_string(), "src/b.ts".to_string()]
        );

        std::fs::write(cache_dir.join("stale.json"), "{not-json").expect("bad marker");
        assert!(stale_marker_paths(temp.path()).is_empty());
    }

    #[test]
    fn map_folder_filters_inside_a_coarse_parent_module() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cache_dir = temp.path().join(".aionui").join("understand");
        std::fs::create_dir_all(&cache_dir).expect("cache dir");
        std::fs::write(
            cache_dir.join("summary.json"),
            serde_json::json!({
                "builtAt": 1,
                "overview": null,
                "runbook": null,
                "modules": [{
                    "id": "packages/desktop/src",
                    "label": "src",
                    "layer": "ui",
                    "summary": "desktop source",
                    "fingerprint": null,
                    "fileCount": 2,
                    "files": [
                        "packages/desktop/src/process/browser/webAgentRunner.ts",
                        "packages/desktop/src/renderer/App.tsx"
                    ],
                    "parentId": null,
                    "childModuleIds": [],
                    "relatedModuleIds": [],
                    "entryFiles": []
                }],
                "files": [
                    {
                        "path": "packages/desktop/src/process/browser/webAgentRunner.ts",
                        "label": "webAgentRunner.ts",
                        "group": "packages",
                        "layer": "service",
                        "summary": "browser agent runner",
                        "summarySource": "llm",
                        "tags": [],
                        "symbols": [],
                        "language": "typescript",
                        "importedBy": 0,
                        "fingerprint": null
                    },
                    {
                        "path": "packages/desktop/src/renderer/App.tsx",
                        "label": "App.tsx",
                        "group": "packages",
                        "layer": "ui",
                        "summary": "renderer app",
                        "summarySource": "llm",
                        "tags": [],
                        "symbols": [],
                        "language": "typescriptreact",
                        "importedBy": 0,
                        "fingerprint": null
                    }
                ]
            })
            .to_string(),
        )
        .expect("summary");

        let result = map_folder(
            temp.path(),
            std::path::Path::new("packages/desktop/src/process/browser"),
            10,
        )
        .expect("map folder");

        assert_eq!(result.files.len(), 1);
        assert_eq!(
            result.files[0].path,
            "packages/desktop/src/process/browser/webAgentRunner.ts"
        );
        assert_eq!(result.modules.len(), 1);
        assert_eq!(
            result.modules[0].path,
            "packages/desktop/src/process/browser"
        );
        assert_eq!(result.modules[0].file_count, 1);

        let summary = query_folder(
            temp.path(),
            std::path::Path::new("packages/desktop/src/process/browser"),
            true,
        )
        .expect("summary folder");
        assert!(summary.summary.starts_with(
            "packages/desktop/src/process/browser contains 1 service file selected from the graph."
        ));
        assert!(!summary
            .summary
            .contains("inside module `packages/desktop/src`"));
        assert_eq!(
            summary.details["module"]["id"].as_str(),
            Some("packages/desktop/src/process/browser")
        );
        assert_eq!(
            summary.details["module"]["sourceModule"].as_str(),
            Some("packages/desktop/src")
        );
        let compact_summary = query_folder(
            temp.path(),
            std::path::Path::new("packages/desktop/src/process/browser"),
            false,
        )
        .expect("compact summary folder");
        assert_eq!(compact_summary.details["layer"].as_str(), Some("service"));
        assert_eq!(
            compact_summary.details["sourceModule"].as_str(),
            Some("packages/desktop/src")
        );

        let live_folder = temp.path().join("packages/desktop/src/process/browser");
        std::fs::create_dir_all(&live_folder).expect("live folder");
        std::fs::write(
            live_folder.join("webAgentRunner.ts"),
            "export const cached = true;\n",
        )
        .expect("cached file");
        std::fs::write(
            live_folder.join("newBrowserTool.ts"),
            "export const fresh = true;\n",
        )
        .expect("new file");
        std::fs::write(
            cache_dir.join("stale.json"),
            serde_json::json!({ "paths": ["packages/desktop/src/process/browser/newBrowserTool.ts"] }).to_string(),
        )
        .expect("stale marker");

        let overlaid = map_folder(
            temp.path(),
            std::path::Path::new("packages/desktop/src/process/browser"),
            10,
        )
        .expect("overlaid map");
        assert!(overlaid.stale);
        assert_eq!(overlaid.files.len(), 2);
        assert!(overlaid
            .files
            .iter()
            .any(|file| file.path.ends_with("newBrowserTool.ts") && file.stale));
        assert_eq!(overlaid.modules[0].file_count, 2);
    }

    #[test]
    fn query_folder_filters_inside_a_coarse_parent_module() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cache_dir = temp.path().join(".aionui").join("understand");
        std::fs::create_dir_all(&cache_dir).expect("cache dir");
        std::fs::write(
            cache_dir.join("summary.json"),
            serde_json::json!({
                "builtAt": 1,
                "overview": null,
                "runbook": null,
                "modules": [{
                    "id": "packages/desktop/src",
                    "label": "src",
                    "layer": "ui",
                    "summary": "desktop source",
                    "fingerprint": null,
                    "fileCount": 2,
                    "files": [
                        "packages/desktop/src/process/browser/webAgentRunner.ts",
                        "packages/desktop/src/renderer/App.tsx"
                    ],
                    "parentId": null,
                    "childModuleIds": [],
                    "relatedModuleIds": [],
                    "entryFiles": []
                }],
                "files": [
                    {
                        "path": "packages/desktop/src/process/browser/webAgentRunner.ts",
                        "label": "webAgentRunner.ts",
                        "group": "packages",
                        "layer": "service",
                        "summary": "browser agent runner",
                        "summarySource": "llm",
                        "tags": [],
                        "symbols": [],
                        "language": "typescript",
                        "importedBy": 0,
                        "fingerprint": null
                    },
                    {
                        "path": "packages/desktop/src/renderer/App.tsx",
                        "label": "App.tsx",
                        "group": "packages",
                        "layer": "ui",
                        "summary": "renderer app",
                        "summarySource": "llm",
                        "tags": [],
                        "symbols": [],
                        "language": "typescriptreact",
                        "importedBy": 0,
                        "fingerprint": null
                    }
                ]
            })
            .to_string(),
        )
        .expect("summary");

        let result = query_folder(
            temp.path(),
            std::path::Path::new("packages/desktop/src/process/browser"),
            false,
        )
        .expect("summary folder");

        assert_eq!(result.details["fileCount"], 1);
        assert!(result.summary.contains("browser agent runner"));
        assert!(!result.summary.contains("renderer app"));
    }

    #[test]
    fn query_folder_info_compacts_file_symbols() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cache_dir = temp.path().join(".aionui").join("understand");
        std::fs::create_dir_all(&cache_dir).expect("cache dir");
        std::fs::write(
            cache_dir.join("summary.json"),
            serde_json::json!({
                "builtAt": 1,
                "overview": null,
                "runbook": null,
                "modules": [],
                "files": [{
                    "path": "src/a.ts",
                    "label": "a.ts",
                    "group": "src",
                    "layer": "service",
                    "summary": "a service",
                    "summarySource": "llm",
                    "tags": ["service"],
                    "symbols": [{
                        "name": "run",
                        "kind": "function",
                        "line": 7,
                        "endLine": 42,
                        "calls": ["expensive"]
                    }],
                    "language": "typescript",
                    "importedBy": 2,
                    "fingerprint": null
                }]
            })
            .to_string(),
        )
        .expect("summary");

        let result =
            query_folder(temp.path(), std::path::Path::new("src"), true).expect("info folder");

        let symbol = &result.details["files"][0]["symbols"][0];
        assert_eq!(result.details["files"][0]["symbolCount"], 1);
        assert_eq!(symbol["name"], "run");
        assert!(symbol.get("calls").is_none());
        assert!(symbol.get("endLine").is_none());
    }
}
