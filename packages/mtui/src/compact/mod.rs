use crate::error::MtuiError;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct CompactResult {
    pub command: String,
    pub mode: String,
    pub profile: String,
    pub saved_id: Option<String>,
    pub saved_path: Option<String>,
    pub compacted: bool,
    pub truncated: bool,
    pub original_lines: usize,
    pub output_lines: usize,
    pub omitted_lines: usize,
    pub repeated_noise_lines: usize,
    pub important_lines: usize,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct CompactOptions {
    pub all: bool,
    pub profile: Option<String>,
    pub max_lines: usize,
    pub max_chars: usize,
    pub saved_id: Option<String>,
    pub saved_path: Option<String>,
}

const IMPORTANT_PATTERNS: &[&str] = &[
    "error",
    "failed",
    "failure",
    "fatal",
    "panic",
    "exception",
    "traceback",
    "warning",
    "warn",
    "assert",
    "expected",
    "received",
    "not found",
    "cannot find",
    "permission denied",
    "exit code",
    "test result",
    "failures:",
    "failures",
    "diff",
    "mismatch",
];

const PYTHON_PATTERNS: &[&str] = &["traceback", "file \"", "assertionerror", "pytest", ".py:"];
const VITEST_PATTERNS: &[&str] = &["vitest", "test files", "tests", "failed", "expect("];
const TSC_PATTERNS: &[&str] = &["error ts", ".ts(", ".tsx(", "type '", "is not assignable"];
const CARGO_PATTERNS: &[&str] = &[
    "error[",
    "error:",
    "warning:",
    ".rs:",
    "panicked at",
    "test result",
];
const PYTEST_PATTERNS: &[&str] = &[
    "pytest",
    "assert ",
    "e       ",
    "short test summary",
    ".py:",
];

const NOISE_PATTERNS: &[&str] = &[
    "blocking waiting for file lock",
    "finished `",
    "compiling ",
    "downloaded ",
    "checking ",
    "building ",
    "fresh ",
    "running `",
    "0 tests",
    "test result: ok",
    "done in ",
    "added ",
    "updated ",
];

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn normalize_repetition_key(line: &str) -> String {
    let stripped = strip_ansi(line).trim().to_lowercase();
    stripped
        .chars()
        .map(|ch| {
            if ch.is_ascii_digit() {
                '#'
            } else if ch.is_whitespace() {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_important(line: &str) -> bool {
    let lower = strip_ansi(line).to_lowercase();
    IMPORTANT_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
        || lower.contains(".ts:")
        || lower.contains(".tsx:")
        || lower.contains(".rs:")
        || lower.contains(".py:")
        || lower.contains(".js:")
}

fn normalized_profile(profile: Option<&str>, input: &str) -> String {
    let requested = profile.unwrap_or("auto").trim().to_lowercase();
    if requested != "auto" && !requested.is_empty() {
        return requested;
    }
    let lower = strip_ansi(input).to_lowercase();
    if lower.contains("traceback (most recent call last)") {
        "python".to_string()
    } else if lower.contains("vitest") || lower.contains("test files") {
        "vitest".to_string()
    } else if lower.contains("error ts") || lower.contains("tsc") {
        "tsc".to_string()
    } else if lower.contains("cargo") || lower.contains("error[") || lower.contains(".rs:") {
        "cargo".to_string()
    } else if lower.contains("pytest") || lower.contains("short test summary") {
        "pytest".to_string()
    } else {
        "generic".to_string()
    }
}

fn profile_patterns(profile: &str) -> &'static [&'static str] {
    match profile {
        "python" => PYTHON_PATTERNS,
        "vitest" => VITEST_PATTERNS,
        "tsc" => TSC_PATTERNS,
        "cargo" => CARGO_PATTERNS,
        "pytest" => PYTEST_PATTERNS,
        _ => &[],
    }
}

fn is_profile_important(line: &str, profile: &str) -> bool {
    let lower = strip_ansi(line).to_lowercase();
    profile_patterns(profile)
        .iter()
        .any(|pattern| lower.contains(pattern))
}

fn is_noise(line: &str) -> bool {
    let lower = strip_ansi(line).trim().to_lowercase();
    if lower.is_empty() {
        return true;
    }
    NOISE_PATTERNS.iter().any(|pattern| lower.contains(pattern))
        || lower
            .chars()
            .all(|ch| ch == '-' || ch == '=' || ch == '.' || ch.is_whitespace())
}

fn push_unique(lines: &mut Vec<String>, line: &str) {
    if !lines.iter().any(|existing| existing == line) {
        lines.push(line.to_string());
    }
}

fn enforce_limits(lines: &mut Vec<String>, max_lines: usize, max_chars: usize) -> bool {
    let mut truncated = false;
    if max_lines > 0 && lines.len() > max_lines {
        lines.truncate(max_lines);
        truncated = true;
    }
    if max_chars > 0 {
        let mut total = 0usize;
        let mut keep = 0usize;
        for line in lines.iter() {
            total += line.len() + 1;
            if total > max_chars {
                truncated = true;
                break;
            }
            keep += 1;
        }
        if keep < lines.len() {
            lines.truncate(keep);
        }
    }
    truncated
}

pub fn compact_text(input: &str, options: CompactOptions) -> CompactResult {
    let profile = normalized_profile(options.profile.as_deref(), input);
    let lines = input
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    if options.all {
        let empty = input.is_empty();
        return CompactResult {
            command: "compact".to_string(),
            mode: "all".to_string(),
            profile: profile.clone(),
            saved_id: options.saved_id,
            saved_path: options.saved_path,
            compacted: false,
            truncated: false,
            original_lines: lines.len(),
            output_lines: if empty { 1 } else { lines.len() },
            omitted_lines: 0,
            repeated_noise_lines: 0,
            important_lines: lines
                .iter()
                .filter(|line| is_important(line) || is_profile_important(line, &profile))
                .count(),
            text: if empty {
                "null".to_string()
            } else {
                input.to_string()
            },
        };
    }

    let mut frequency = HashMap::<String, usize>::new();
    for line in &lines {
        let key = normalize_repetition_key(line);
        *frequency.entry(key).or_insert(0) += 1;
    }

    let important = lines
        .iter()
        .filter(|line| is_important(line) || is_profile_important(line, &profile))
        .cloned()
        .collect::<Vec<_>>();
    let repeated_noise_lines = lines
        .iter()
        .filter(|line| {
            let key = normalize_repetition_key(line);
            frequency.get(&key).copied().unwrap_or(0) > 2
                && is_noise(line)
                && !is_profile_important(line, &profile)
        })
        .count();

    let mut output = Vec::<String>::new();
    for line in lines.iter().take(12) {
        if !is_noise(line) || is_important(line) || is_profile_important(line, &profile) {
            push_unique(&mut output, line);
        }
    }
    if !important.is_empty() {
        push_unique(&mut output, "---- important lines ----");
        for line in important.iter().take(50) {
            push_unique(&mut output, line);
        }
    }
    let tail = lines.len().saturating_sub(20);
    if tail > 0 {
        push_unique(&mut output, "---- tail ----");
    }
    for line in lines.iter().skip(tail) {
        if !is_noise(line) || is_important(line) || is_profile_important(line, &profile) {
            push_unique(&mut output, line);
        }
    }

    if output.is_empty() {
        output = lines.iter().take(20).cloned().collect();
    }
    if output.is_empty() {
        output.push("null".to_string());
    }

    let limit_truncated = enforce_limits(&mut output, options.max_lines, options.max_chars);
    let text = output.join("\n");
    let omitted_lines = lines.len().saturating_sub(output.len());

    CompactResult {
        command: "compact".to_string(),
        mode: "compact".to_string(),
        profile,
        saved_id: options.saved_id,
        saved_path: options.saved_path,
        compacted: true,
        truncated: limit_truncated || omitted_lines > 0,
        original_lines: lines.len(),
        output_lines: output.len(),
        omitted_lines,
        repeated_noise_lines,
        important_lines: important.len(),
        text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_errors_and_omits_repeated_noise() {
        let input = [
            "Compiling a",
            "Compiling b",
            "Compiling c",
            "Blocking waiting for file lock",
            "Blocking waiting for file lock",
            "Blocking waiting for file lock",
            "error: cannot find module",
            "src/main.ts:10:5",
            "test result: FAILED",
        ]
        .join("\n");

        let result = compact_text(
            &input,
            CompactOptions {
                all: false,
                profile: None,
                max_lines: 20,
                max_chars: 2000,
                saved_id: None,
                saved_path: None,
            },
        );

        assert!(result.compacted);
        assert_eq!(result.profile, "generic");
        assert!(result.text.contains("error: cannot find module"));
        assert!(result.text.contains("src/main.ts:10:5"));
        assert!(result.output_lines < result.original_lines);
    }

    #[test]
    fn all_mode_returns_full_text() {
        let input = "a\nb\nc";
        let result = compact_text(
            input,
            CompactOptions {
                all: true,
                profile: Some("python".to_string()),
                max_lines: 1,
                max_chars: 1,
                saved_id: Some("cmp_test".to_string()),
                saved_path: Some(".mtui/compact/cmp_test.log".to_string()),
            },
        );

        assert!(!result.compacted);
        assert_eq!(result.profile, "python");
        assert_eq!(result.text, input);
        assert_eq!(result.saved_id.as_deref(), Some("cmp_test"));
    }

    #[test]
    fn empty_input_returns_null_sentinel() {
        let result = compact_text(
            "",
            CompactOptions {
                all: false,
                profile: None,
                max_lines: 20,
                max_chars: 2000,
                saved_id: None,
                saved_path: None,
            },
        );

        assert_eq!(result.text, "null");
        assert_eq!(result.output_lines, 1);

        let all_result = compact_text(
            "",
            CompactOptions {
                all: true,
                profile: None,
                max_lines: 20,
                max_chars: 2000,
                saved_id: None,
                saved_path: None,
            },
        );

        assert_eq!(all_result.text, "null");
        assert_eq!(all_result.output_lines, 1);
    }

    #[test]
    fn auto_detects_python_traceback_profile() {
        let input =
            "Traceback (most recent call last):\n  File \"x.py\", line 1\nAssertionError: bad";
        let result = compact_text(
            input,
            CompactOptions {
                all: false,
                profile: None,
                max_lines: 20,
                max_chars: 2000,
                saved_id: None,
                saved_path: None,
            },
        );

        assert_eq!(result.profile, "python");
        assert!(result.text.contains("AssertionError"));
    }
}
pub fn compact_store_dir(project_root: &Path) -> PathBuf {
    project_root.join(".mtui").join("compact")
}

pub fn save_full_input(project_root: &Path, input: &str) -> Result<(String, String), MtuiError> {
    let dir = compact_store_dir(project_root);
    std::fs::create_dir_all(&dir).map_err(|e| MtuiError::Internal {
        message: format!("Failed to create compact store: {}", e),
    })?;
    let id = format!(
        "cmp_{}_{}",
        chrono::Utc::now().format("%Y%m%d_%H%M%S"),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let path = dir.join(format!("{}.log", id));
    std::fs::write(&path, input).map_err(|e| MtuiError::Internal {
        message: format!("Failed to save compact input: {}", e),
    })?;
    Ok((id, path.display().to_string()))
}

pub fn retrieve_full_input(project_root: &Path, id: &str) -> Result<String, MtuiError> {
    let clean_id = id.trim();
    if clean_id.is_empty()
        || clean_id.contains('/')
        || clean_id.contains('\\')
        || clean_id.contains("..")
        || !clean_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(MtuiError::InvalidArgument {
            message: "Invalid compact retrieval id".to_string(),
            suggestion: "Use the saved_id returned by `mtui compact --save --json`".to_string(),
        });
    }
    let path = compact_store_dir(project_root).join(format!("{}.log", clean_id));
    std::fs::read_to_string(&path).map_err(|_| MtuiError::FileNotFound {
        message: format!("Saved compact input not found: {}", clean_id),
        suggestion: "Check the saved_id or re-run the command with --save".to_string(),
    })
}
