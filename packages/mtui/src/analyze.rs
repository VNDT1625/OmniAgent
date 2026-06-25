//! Codebase language analysis for editor-intelligence engine selection.
//!
//! `mtui analyze` walks the project, counts files per language, and recommends
//! which "intelligence engine" the host IDE should enable for each language:
//!
//! - `monaco-builtin` — Monaco's bundled language service (TS/JS, JSON, CSS,
//!   HTML). Near-LSP quality for those languages at ~zero cost; always safe to
//!   enable by default.
//! - `linter` — a fast per-file external linter (e.g. oxlint, ruff). Light; only
//!   reports diagnostics, no completion/hover.
//! - `lsp` — a real language server (pyright, rust-analyzer, gopls, clangd…).
//!   Full intelligence but resident RAM/CPU cost; recommended opt-in only when a
//!   language is well represented in the repo.
//! - `syntax` — syntax highlight only (Monaco fallback). Free, no analysis.
//!
//! The result is emitted as JSON so the renderer can drive a per-language engine
//! registry (the host decides what to actually load). This command is pure I/O
//! over the filesystem and never spawns anything.

use crate::error::MtuiError;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// How costly an engine is to run, so the host can warn before enabling.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EngineCost {
    /// No measurable cost (bundled with Monaco or highlight-only).
    Free,
    /// Spawns a short-lived per-file process; negligible resident memory.
    Light,
    /// Resident server with moderate memory (e.g. pyright, gopls).
    Medium,
    /// Resident server with large memory/CPU (e.g. rust-analyzer, clangd).
    Heavy,
}

/// The recommended intelligence source for one language.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    /// `monaco-builtin` | `linter` | `lsp` | `syntax`.
    pub kind: String,
    /// Suggested provider binary when `kind` is `lsp` or `linter` (else `None`).
    pub server: Option<String>,
    /// Relative cost of running this engine.
    pub cost: EngineCost,
    /// Whether the host should enable this engine by default (free engines) or
    /// leave it opt-in (anything that costs resident memory).
    pub default_on: bool,
    /// Human-readable rationale (English; the host localizes if needed).
    pub reason: String,
}

/// Per-language analysis entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageEntry {
    /// Canonical language id (matches Monaco language ids where possible).
    pub language: String,
    /// Number of files of this language found in the repo.
    pub file_count: usize,
    /// Share of analyzed code files, 0–100 (rounded to one decimal).
    pub share_percent: f64,
    /// Recommended engine for this language.
    pub engine: Engine,
}

/// Full `analyze` result, JSON-serialized for the host IDE.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub command: String,
    pub built_at: u64,
    /// Total code-like files counted.
    pub total_files: usize,
    /// Languages sorted by file count, descending.
    pub languages: Vec<LanguageEntry>,
    /// Top language ids (file count desc), capped to a small set.
    pub dominant: Vec<String>,
    /// Suggested follow-up commands for the agent.
    pub next_commands: Vec<String>,
}

/// Directories never worth analyzing (build output, caches, vendored deps).
fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".mtui"
            | ".aionui"
            | ".kiro"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "out"
            | "coverage"
            | ".next"
            | ".turbo"
            | ".cache"
            | "vendor"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

/// Map a lowercase file extension to a canonical language id, or `None` when the
/// extension is not a code/markup file we care to analyze.
pub fn classify_language(ext: &str) -> Option<&'static str> {
    let lang = match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "json" | "json5" | "jsonc" => "json",
        "css" | "scss" | "sass" | "less" => "css",
        "html" | "htm" | "xhtml" => "html",
        "vue" | "svelte" | "astro" => "html",
        "py" | "pyw" | "pyi" => "python",
        "rs" => "rust",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "scala" => "scala",
        "lua" => "lua",
        "dart" => "dart",
        "sh" | "bash" | "zsh" => "shell",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" | "mdx" | "markdown" => "markdown",
        "sql" => "sql",
        _ => return None,
    };
    Some(lang)
}

/// Recommend an intelligence engine for a language given its representation.
///
/// `count` is this language's file count; `total` is all analyzed code files.
/// The threshold logic keeps heavy LSP engines opt-in and only worth suggesting
/// when the language is clearly present (≥ 5 files or ≥ 5% of the repo).
pub fn recommend_engine(language: &str, count: usize, total: usize) -> Engine {
    let share = if total > 0 { (count as f64) * 100.0 / (total as f64) } else { 0.0 };
    let well_represented = count >= 5 || share >= 5.0;

    match language {
        // Monaco ships a real language service for these — free near-LSP support.
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" | "json" | "css"
        | "html" => Engine {
            kind: "monaco-builtin".to_string(),
            server: None,
            cost: EngineCost::Free,
            default_on: true,
            reason: "Monaco's bundled language service covers this language (diagnostics, completion, hover) at no extra cost.".to_string(),
        },
        // Languages with a light, fast per-file linter we already know how to run.
        "shell" => Engine {
            kind: "linter".to_string(),
            server: Some("shellcheck".to_string()),
            cost: EngineCost::Light,
            default_on: false,
            reason: "shellcheck gives per-file diagnostics cheaply; enable when available on PATH.".to_string(),
        },
        // Real language servers — full intelligence, but resident memory cost.
        "python" => lsp_engine("pyright", EngineCost::Medium, well_represented, "Python"),
        "go" => lsp_engine("gopls", EngineCost::Medium, well_represented, "Go"),
        "rust" => lsp_engine("rust-analyzer", EngineCost::Heavy, well_represented, "Rust"),
        "c" | "cpp" => lsp_engine("clangd", EngineCost::Heavy, well_represented, "C/C++"),
        // Everything else: highlight only.
        _ => Engine {
            kind: "syntax".to_string(),
            server: None,
            cost: EngineCost::Free,
            default_on: true,
            reason: "Syntax highlighting only; no language server wired for this language.".to_string(),
        },
    }
}

/// Build an `lsp` engine recommendation. Heavy/medium servers stay opt-in
/// (`default_on = false`); the reason notes whether the language is dominant
/// enough to be worth the resident cost.
fn lsp_engine(server: &str, cost: EngineCost, well_represented: bool, label: &str) -> Engine {
    let reason = if well_represented {
        format!(
            "{} is well represented in this repo; {} provides full LSP intelligence (opt-in due to resident memory cost).",
            label, server
        )
    } else {
        format!(
            "{} appears only sparsely; {} (LSP) is available but likely not worth its resident cost here.",
            label, server
        )
    };
    Engine {
        kind: "lsp".to_string(),
        server: Some(server.to_string()),
        cost,
        default_on: false,
        reason,
    }
}

// ---------------------------------------------------------------------------
// `mtui analyze type`  →  language detection + engine recommendation (below)
// `mtui analyze [path]`→  error-check (further down)
// ---------------------------------------------------------------------------

/// Turn a language→count map into a sorted, recommended [`AnalyzeResult`].
pub fn build_result(counts: BTreeMap<String, usize>, built_at: u64) -> AnalyzeResult {
    let total: usize = counts.values().copied().sum();
    let mut languages: Vec<LanguageEntry> = counts
        .into_iter()
        .map(|(language, file_count)| {
            let share = if total > 0 {
                ((file_count as f64) * 1000.0 / (total as f64)).round() / 10.0
            } else {
                0.0
            };
            let engine = recommend_engine(&language, file_count, total);
            LanguageEntry { language, file_count, share_percent: share, engine }
        })
        .collect();
    // Sort by file count desc, then language id asc for stable ordering.
    languages.sort_by(|a, b| {
        b.file_count
            .cmp(&a.file_count)
            .then_with(|| a.language.cmp(&b.language))
    });
    let dominant: Vec<String> = languages.iter().take(5).map(|entry| entry.language.clone()).collect();
    AnalyzeResult {
        command: "analyze".to_string(),
        built_at,
        total_files: total,
        languages,
        dominant,
        next_commands: vec![
            "mtui --json map repo".to_string(),
            "mtui --json context \"<task>\"".to_string(),
        ],
    }
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Walk the project root, count code-like files per language, and recommend an
/// engine per language. `max_files` caps the walk so huge repos stay responsive.
pub fn run(project_root: &Path, max_files: usize) -> Result<AnalyzeResult, MtuiError> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut scanned = 0usize;
    for entry in walkdir::WalkDir::new(project_root)
        .into_iter()
        .filter_entry(|entry| {
            if entry.file_type().is_dir() {
                entry
                    .path()
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| !is_ignored_dir(name))
                    .unwrap_or(true)
            } else {
                true
            }
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        let Some(ext) = ext else { continue };
        let Some(language) = classify_language(&ext) else { continue };
        *counts.entry(language.to_string()).or_insert(0) += 1;
        scanned += 1;
        if scanned >= max_files {
            break;
        }
    }
    Ok(build_result(counts, current_millis()))
}

// ---------------------------------------------------------------------------
// `mtui analyze [path]`  →  error-check the repo (or one path)
// ---------------------------------------------------------------------------

/// A diagnostic-producing checker for one language, picked by file extension.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checker {
    /// Language id the checker targets.
    pub language: String,
    /// Tool binary to invoke (e.g. `oxlint`, `ruff`, `shellcheck`, `tsc`).
    pub tool: String,
    /// Argument template; `{path}` is replaced with the target file/dir.
    pub args: Vec<String>,
    /// Whether MTUI will run it automatically (light tools) or only suggest it
    /// (heavy/project-wide tools like `tsc`/`cargo check` that can hang or need
    /// a full project graph). Suggest-only keeps `analyze` fast and safe.
    pub auto_run: bool,
}

/// Pick a checker for a file extension. Light, per-file linters are `auto_run`;
/// project-wide type checkers are suggest-only (`auto_run = false`).
pub fn checker_for_ext(ext: &str) -> Option<Checker> {
    let checker = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Checker {
            language: "typescript".to_string(),
            tool: "oxlint".to_string(),
            args: vec!["--format".to_string(), "unix".to_string(), "{path}".to_string()],
            auto_run: true,
        },
        "py" | "pyw" => Checker {
            language: "python".to_string(),
            tool: "ruff".to_string(),
            args: vec!["check".to_string(), "{path}".to_string()],
            auto_run: true,
        },
        "sh" | "bash" => Checker {
            language: "shell".to_string(),
            tool: "shellcheck".to_string(),
            args: vec!["{path}".to_string()],
            auto_run: true,
        },
        "rs" => Checker {
            language: "rust".to_string(),
            tool: "cargo".to_string(),
            args: vec!["check".to_string()],
            auto_run: false, // project-wide; suggest only
        },
        "go" => Checker {
            language: "go".to_string(),
            tool: "go".to_string(),
            args: vec!["vet".to_string(), "{path}".to_string()],
            auto_run: false,
        },
        _ => return None,
    };
    Some(checker)
}

/// One issue reported by a checker (parsed from `unix`/generic `file:line:col`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub message: String,
    pub tool: String,
}

/// Outcome of running (or skipping) one checker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckerRun {
    pub tool: String,
    pub language: String,
    /// `ran` | `skipped-missing-tool` | `suggested`.
    pub status: String,
    pub issues: Vec<Issue>,
    /// Command MTUI suggests the user run for suggest-only checkers.
    pub suggested_command: Option<String>,
}

/// Full `analyze [path]` (error-check) result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub command: String,
    pub built_at: u64,
    pub target: String,
    pub total_issues: usize,
    pub checks: Vec<CheckerRun>,
    pub next_commands: Vec<String>,
}

/// Parse a single `file:line:col: message` style diagnostic line (oxlint
/// `--format unix`, shellcheck default, ruff default all share this shape).
/// Returns `None` for lines that don't match so summaries stay clean.
pub fn parse_issue_line(line: &str, tool: &str) -> Option<Issue> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Split into at most 4 parts: file, line, col, rest.
    let mut parts = trimmed.splitn(4, ':');
    let file = parts.next()?.trim();
    let line_no = parts.next()?.trim().parse::<usize>().ok()?;
    let col = parts.next()?.trim().parse::<usize>().ok()?;
    let message = parts.next().unwrap_or("").trim();
    if file.is_empty() {
        return None;
    }
    Some(Issue {
        file: file.replace('\\', "/"),
        line: line_no,
        column: col,
        message: message.to_string(),
        tool: tool.to_string(),
    })
}

/// Parse all diagnostic lines from a checker's stdout/stderr blob.
pub fn parse_issues(output: &str, tool: &str) -> Vec<Issue> {
    output.lines().filter_map(|line| parse_issue_line(line, tool)).collect()
}

fn build_command(checker: &Checker, target: &str) -> String {
    let args: Vec<String> = checker
        .args
        .iter()
        .map(|arg| arg.replace("{path}", target))
        .collect();
    format!("{} {}", checker.tool, args.join(" "))
}

/// Whether a binary is resolvable on PATH (best-effort; used to decide whether
/// to auto-run a checker or report it as missing).
fn tool_available(tool: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(probe)
        .arg(tool)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Run one auto-run checker against a target path, returning a [`CheckerRun`].
/// Resolves regardless of exit code (linters exit non-zero when they find
/// issues — that is expected, not a failure).
fn run_checker(project_root: &Path, checker: &Checker, target: &str) -> CheckerRun {
    let suggested = build_command(checker, target);
    if !checker.auto_run {
        return CheckerRun {
            tool: checker.tool.clone(),
            language: checker.language.clone(),
            status: "suggested".to_string(),
            issues: Vec::new(),
            suggested_command: Some(suggested),
        };
    }
    if !tool_available(&checker.tool) {
        return CheckerRun {
            tool: checker.tool.clone(),
            language: checker.language.clone(),
            status: "skipped-missing-tool".to_string(),
            issues: Vec::new(),
            suggested_command: Some(suggested),
        };
    }
    let args: Vec<String> = checker
        .args
        .iter()
        .map(|arg| arg.replace("{path}", target))
        .collect();
    let output = std::process::Command::new(&checker.tool)
        .args(&args)
        .current_dir(project_root)
        .output();
    let issues = match output {
        Ok(out) => {
            let mut blob = String::from_utf8_lossy(&out.stdout).into_owned();
            blob.push('\n');
            blob.push_str(&String::from_utf8_lossy(&out.stderr));
            parse_issues(&blob, &checker.tool)
        }
        Err(_) => Vec::new(),
    };
    CheckerRun {
        tool: checker.tool.clone(),
        language: checker.language.clone(),
        status: "ran".to_string(),
        issues,
        suggested_command: None,
    }
}

/// Error-check a target path (file or directory; defaults to the repo root).
/// Collects unique checkers by extension, runs the light ones, and suggests the
/// heavy ones. Pure-ish: spawns only known linter binaries that are present.
pub fn run_check(project_root: &Path, target: Option<&str>, max_files: usize) -> Result<CheckResult, MtuiError> {
    let target_str = target.unwrap_or(".").to_string();
    let target_path = if Path::new(&target_str).is_absolute() {
        std::path::PathBuf::from(&target_str)
    } else {
        project_root.join(&target_str)
    };

    // Collect distinct checkers needed by scanning extensions under the target.
    let mut checkers: BTreeMap<String, Checker> = BTreeMap::new();
    if target_path.is_file() {
        if let Some(ext) = target_path.extension().and_then(|e| e.to_str()) {
            if let Some(checker) = checker_for_ext(&ext.to_ascii_lowercase()) {
                checkers.insert(checker.tool.clone(), checker);
            }
        }
    } else {
        let mut scanned = 0usize;
        for entry in walkdir::WalkDir::new(&target_path)
            .into_iter()
            .filter_entry(|entry| {
                if entry.file_type().is_dir() {
                    entry
                        .path()
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(|name| !is_ignored_dir(name))
                        .unwrap_or(true)
                } else {
                    true
                }
            })
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                if let Some(checker) = checker_for_ext(&ext.to_ascii_lowercase()) {
                    checkers.entry(checker.tool.clone()).or_insert(checker);
                }
            }
            scanned += 1;
            if scanned >= max_files {
                break;
            }
        }
    }

    let checks: Vec<CheckerRun> = checkers
        .values()
        .map(|checker| run_checker(project_root, checker, &target_str))
        .collect();
    let total_issues: usize = checks.iter().map(|run| run.issues.len()).sum();
    Ok(CheckResult {
        command: "analyze".to_string(),
        built_at: current_millis(),
        target: target_str,
        total_issues,
        checks,
        next_commands: vec![
            "mtui --json analyze type".to_string(),
            "mtui --json map repo".to_string(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_extensions() {
        assert_eq!(classify_language("ts"), Some("typescript"));
        assert_eq!(classify_language("tsx"), Some("typescriptreact"));
        assert_eq!(classify_language("rs"), Some("rust"));
        assert_eq!(classify_language("py"), Some("python"));
        assert_eq!(classify_language("exe"), None);
        assert_eq!(classify_language("lock"), None);
    }

    #[test]
    fn monaco_languages_are_free_and_default_on() {
        let engine = recommend_engine("typescript", 100, 100);
        assert_eq!(engine.kind, "monaco-builtin");
        assert_eq!(engine.cost, EngineCost::Free);
        assert!(engine.default_on);
        assert!(engine.server.is_none());
    }

    #[test]
    fn rust_is_heavy_opt_in_lsp() {
        let engine = recommend_engine("rust", 50, 100);
        assert_eq!(engine.kind, "lsp");
        assert_eq!(engine.server.as_deref(), Some("rust-analyzer"));
        assert_eq!(engine.cost, EngineCost::Heavy);
        assert!(!engine.default_on, "heavy LSP must stay opt-in");
    }

    #[test]
    fn sparse_language_reason_differs_from_dominant() {
        let sparse = recommend_engine("python", 1, 1000);
        let dominant = recommend_engine("python", 500, 1000);
        assert_eq!(sparse.server.as_deref(), Some("pyright"));
        assert!(sparse.reason.contains("sparsely"));
        assert!(dominant.reason.contains("well represented"));
    }

    #[test]
    fn build_result_sorts_by_count_and_computes_share() {
        let mut counts = BTreeMap::new();
        counts.insert("typescript".to_string(), 75usize);
        counts.insert("rust".to_string(), 25usize);
        let result = build_result(counts, 0);
        assert_eq!(result.total_files, 100);
        assert_eq!(result.languages[0].language, "typescript");
        assert_eq!(result.languages[0].share_percent, 75.0);
        assert_eq!(result.languages[1].language, "rust");
        assert_eq!(result.dominant, vec!["typescript".to_string(), "rust".to_string()]);
    }

    #[test]
    fn empty_repo_yields_no_languages() {
        let result = build_result(BTreeMap::new(), 0);
        assert_eq!(result.total_files, 0);
        assert!(result.languages.is_empty());
        assert!(result.dominant.is_empty());
    }

    #[test]
    fn checker_for_ext_picks_light_linters_as_auto_run() {
        let ts = checker_for_ext("ts").unwrap();
        assert_eq!(ts.tool, "oxlint");
        assert!(ts.auto_run);
        let py = checker_for_ext("py").unwrap();
        assert_eq!(py.tool, "ruff");
        assert!(py.auto_run);
        let sh = checker_for_ext("sh").unwrap();
        assert_eq!(sh.tool, "shellcheck");
        assert!(sh.auto_run);
    }

    #[test]
    fn checker_for_ext_marks_project_wide_checkers_suggest_only() {
        let rs = checker_for_ext("rs").unwrap();
        assert_eq!(rs.tool, "cargo");
        assert!(!rs.auto_run, "cargo check is project-wide; must be suggest-only");
        let go = checker_for_ext("go").unwrap();
        assert!(!go.auto_run);
    }

    #[test]
    fn checker_for_ext_none_for_unknown() {
        assert!(checker_for_ext("png").is_none());
        assert!(checker_for_ext("lock").is_none());
    }

    #[test]
    fn parse_issue_line_reads_file_line_col_message() {
        let issue = parse_issue_line("src/a.ts:12:5: Unexpected var", "oxlint").unwrap();
        assert_eq!(issue.file, "src/a.ts");
        assert_eq!(issue.line, 12);
        assert_eq!(issue.column, 5);
        assert_eq!(issue.message, "Unexpected var");
        assert_eq!(issue.tool, "oxlint");
    }

    #[test]
    fn parse_issue_line_normalizes_backslashes() {
        let issue = parse_issue_line("src\\b.ts:1:1: x", "oxlint").unwrap();
        assert_eq!(issue.file, "src/b.ts");
    }

    #[test]
    fn parse_issue_line_rejects_non_diagnostic_lines() {
        assert!(parse_issue_line("", "oxlint").is_none());
        assert!(parse_issue_line("Checked 10 files", "oxlint").is_none());
        assert!(parse_issue_line("just text", "ruff").is_none());
    }

    #[test]
    fn parse_issues_collects_only_matching_lines() {
        let blob = "src/a.ts:1:1: bad\nrandom noise\nsrc/b.ts:2:3: worse\n";
        let issues = parse_issues(blob, "oxlint");
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[1].file, "src/b.ts");
    }
}
