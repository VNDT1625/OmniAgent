//! ExpBase surface for MTUI.
//!
//! MTUI is AI-free: it never computes embeddings. Instead it reads the compact
//! projection file written by the TS engine (`.mtui/exp/index.json`) and ranks
//! experiences with deterministic lexical + metadata scoring — the hot path an
//! agent hits while debugging, with zero model round-trips.
//!
//! Writes (`add`, `forget`) are queued for the engine to process:
//! - `add`    -> append a draft to `.mtui/exp/inbox.jsonl`
//! - `forget` -> append an id to `.mtui/exp/forget.jsonl` and archive it in the
//!   projection in place so CLI search hides it immediately.

use crate::error::MtuiError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const EXP_DIR: &str = ".mtui/exp";
const INDEX_FILE: &str = "index.json";
const INBOX_FILE: &str = "inbox.jsonl";
const FORGET_FILE: &str = "forget.jsonl";
const FEEDBACK_FILE: &str = "feedback.jsonl";

const RECENCY_HALF_LIFE_DAYS: f64 = 180.0;
const MS_PER_DAY: f64 = 86_400_000.0;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionEntry {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub symptom: String,
    pub lesson: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub frameworks: Vec<String>,
    #[serde(default)]
    pub packages: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub error_category: Option<String>,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub verification_strength: f64,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub lexical_text: String,
    #[serde(default)]
    pub caution: Vec<String>,
    #[serde(default)]
    pub suggested_checks: Vec<String>,
    #[serde(default)]
    pub vector: Option<Vec<f64>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub dimensions: usize,
    #[serde(default)]
    pub built_at: u64,
    #[serde(default)]
    pub entries: Vec<ProjectionEntry>,
}

/// One ranked suggestion returned by `exp search`.
#[derive(Debug, Serialize)]
pub struct Suggestion {
    pub entry_id: String,
    pub score: f64,
    pub kind: String,
    pub symptom: String,
    pub lesson: String,
    pub why_relevant: Vec<String>,
    pub caution: Vec<String>,
    pub suggested_checks: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub command: &'static str,
    pub query: String,
    pub count: usize,
    pub stale_index: bool,
    pub suggestions: Vec<Suggestion>,
}

#[derive(Debug, Serialize)]
pub struct ListResult {
    pub command: &'static str,
    pub count: usize,
    pub entries: Vec<ProjectionEntry>,
}

#[derive(Debug, Serialize)]
pub struct GetResult {
    pub command: &'static str,
    pub found: bool,
    pub entry: Option<ProjectionEntry>,
}

#[derive(Debug, Serialize)]
pub struct QueueResult {
    pub command: &'static str,
    pub queued: bool,
    pub file: String,
    pub note: String,
}

/// Query parameters for {@link search}.
pub struct SearchQuery {
    pub text: String,
    pub frameworks: Vec<String>,
    pub packages: Vec<String>,
    pub files: Vec<String>,
    pub commands: Vec<String>,
    pub error_category: Option<String>,
    pub kind: Option<String>,
    pub tags: Vec<String>,
    pub limit: usize,
    pub min_score: f64,
}

fn exp_dir(project_root: &Path) -> PathBuf {
    project_root.join(EXP_DIR)
}

fn index_path(project_root: &Path) -> PathBuf {
    exp_dir(project_root).join(INDEX_FILE)
}

/// Load the projection file; `Ok(None)` when it does not exist yet.
pub fn load_projection(project_root: &Path) -> Result<Option<Projection>, MtuiError> {
    let path = index_path(project_root);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| MtuiError::Internal {
        message: format!("Failed to read ExpBase index: {}", e),
    })?;
    let projection = serde_json::from_str::<Projection>(&raw).map_err(|e| MtuiError::Internal {
        message: format!("Failed to parse ExpBase index: {}", e),
    })?;
    Ok(Some(projection))
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            if current.len() >= 2 {
                tokens.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= 2 {
        tokens.push(current);
    }
    tokens
}

fn lexical_similarity(query_tokens: &[String], lexical_text: &str) -> f64 {
    if query_tokens.is_empty() {
        return 0.0;
    }
    let entry_tokens: std::collections::HashSet<&str> = lexical_text.split_whitespace().collect();
    let query_set: std::collections::HashSet<&String> = query_tokens.iter().collect();
    if entry_tokens.is_empty() {
        return 0.0;
    }
    let mut intersection = 0usize;
    for token in &query_set {
        if entry_tokens.contains(token.as_str()) {
            intersection += 1;
        }
    }
    intersection as f64 / query_set.len() as f64
}

fn overlap_fraction(query_values: &[String], entry_values: &[String]) -> f64 {
    if query_values.is_empty() {
        return 0.0;
    }
    let entry_lower: std::collections::HashSet<String> =
        entry_values.iter().map(|v| v.to_lowercase()).collect();
    let matched = query_values
        .iter()
        .filter(|v| entry_lower.contains(&v.to_lowercase()))
        .count();
    matched as f64 / query_values.len() as f64
}

fn file_overlap_fraction(query_files: &[String], entry_files: &[String]) -> f64 {
    if query_files.is_empty() {
        return 0.0;
    }
    let normalize = |f: &str| f.replace('\\', "/").to_lowercase();
    let entry_norm: Vec<String> = entry_files.iter().map(|f| normalize(f)).collect();
    let matched = query_files
        .iter()
        .filter(|f| {
            let q = normalize(f);
            entry_norm
                .iter()
                .any(|e| *e == q || e.ends_with(&q) || q.ends_with(e.as_str()))
        })
        .count();
    matched as f64 / query_files.len() as f64
}

struct ContextMatch {
    score: f64,
    why: Vec<String>,
}

fn compute_context_match(query: &SearchQuery, entry: &ProjectionEntry) -> ContextMatch {
    let mut signals: Vec<f64> = Vec::new();
    let mut why: Vec<String> = Vec::new();

    if !query.frameworks.is_empty() {
        let fraction = overlap_fraction(&query.frameworks, &entry.frameworks);
        signals.push(fraction);
        if fraction > 0.0 {
            why.push("Same framework".to_string());
        }
    }
    if !query.packages.is_empty() {
        let fraction = overlap_fraction(&query.packages, &entry.packages);
        signals.push(fraction);
        if fraction > 0.0 {
            why.push("Same package".to_string());
        }
    }
    if !query.commands.is_empty() {
        let fraction = overlap_fraction(&query.commands, &entry.commands);
        signals.push(fraction);
        if fraction > 0.0 {
            why.push("Same command failed".to_string());
        }
    }
    if !query.files.is_empty() {
        let fraction = file_overlap_fraction(&query.files, &entry.files);
        signals.push(fraction);
        if fraction > 0.0 {
            why.push("Same file/subsystem".to_string());
        }
    }
    if let (Some(query_error), Some(entry_error)) = (&query.error_category, &entry.error_category) {
        let matched = if query_error.to_lowercase() == entry_error.to_lowercase() {
            1.0
        } else {
            0.0
        };
        signals.push(matched);
        if matched > 0.0 {
            why.push("Same error category".to_string());
        }
    }

    let score = if signals.is_empty() {
        0.0
    } else {
        signals.iter().sum::<f64>() / signals.len() as f64
    };
    ContextMatch { score, why }
}

fn recency_score(updated_at: &str, now_ms: f64) -> f64 {
    match chrono::DateTime::parse_from_rfc3339(updated_at) {
        Ok(parsed) => {
            let updated_ms = parsed.timestamp_millis() as f64;
            let days = ((now_ms - updated_ms) / MS_PER_DAY).max(0.0);
            (-days * std::f64::consts::LN_2 / RECENCY_HALF_LIFE_DAYS).exp()
        }
        Err(_) => 0.0,
    }
}

fn status_penalty(status: &str) -> f64 {
    match status {
        "superseded" => 0.3,
        "archived" => 0.6,
        _ => 0.0,
    }
}

/// Rank projection entries against a query using lexical + metadata scoring.
pub fn search(projection: &Projection, query: &SearchQuery, now_ms: f64) -> Vec<Suggestion> {
    let query_tokens = tokenize(&query.text);
    let mut scored: Vec<Suggestion> = projection
        .entries
        .iter()
        .filter(|entry| entry.status != "archived")
        .filter(|entry| query.kind.as_ref().map(|k| &entry.kind == k).unwrap_or(true))
        .filter(|entry| {
            query.tags.is_empty() || {
                let entry_tags: std::collections::HashSet<String> =
                    entry.tags.iter().map(|t| t.to_lowercase()).collect();
                query.tags.iter().any(|t| entry_tags.contains(&t.to_lowercase()))
            }
        })
        .map(|entry| {
            let lexical = lexical_similarity(&query_tokens, &entry.lexical_text);
            let context = compute_context_match(query, entry);
            let recency = recency_score(&entry.updated_at, now_ms);
            let raw = 0.5 * lexical
                + 0.22 * context.score
                + 0.1 * entry.confidence
                + 0.1 * entry.verification_strength
                + 0.08 * recency
                - status_penalty(&entry.status);
            let score = raw.clamp(0.0, 1.0);

            let mut why = context.why;
            if lexical >= 0.5 {
                why.insert(0, "Strong keyword match".to_string());
            } else if lexical >= 0.25 {
                why.push("Partial keyword match".to_string());
            }
            if why.is_empty() {
                why.push("Loosely related symptom".to_string());
            }

            Suggestion {
                entry_id: entry.id.clone(),
                score,
                kind: entry.kind.clone(),
                symptom: entry.symptom.clone(),
                lesson: entry.lesson.clone(),
                why_relevant: why,
                caution: entry.caution.clone(),
                suggested_checks: entry.suggested_checks.clone(),
            }
        })
        .filter(|s| s.score >= query.min_score)
        .collect();

    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.entry_id.cmp(&a.entry_id))
    });
    scored.truncate(query.limit);
    scored
}

fn ensure_dir(project_root: &Path) -> Result<PathBuf, MtuiError> {
    let dir = exp_dir(project_root);
    std::fs::create_dir_all(&dir).map_err(|e| MtuiError::Internal {
        message: format!("Failed to create {}: {}", dir.display(), e),
    })?;
    Ok(dir)
}

fn append_line(path: &Path, line: &str) -> Result<(), MtuiError> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to open {}: {}", path.display(), e),
        })?;
    writeln!(file, "{}", line).map_err(|e| MtuiError::Internal {
        message: format!("Failed to write {}: {}", path.display(), e),
    })
}

/// Queue a draft (already shaped as the inbox item's `draft`) into inbox.jsonl.
pub fn queue_add(project_root: &Path, draft: &serde_json::Value, now_iso: &str) -> Result<PathBuf, MtuiError> {
    let dir = ensure_dir(project_root)?;
    let path = dir.join(INBOX_FILE);
    let item = serde_json::json!({ "receivedAt": now_iso, "draft": draft });
    append_line(&path, &item.to_string())?;
    Ok(path)
}

/// Queue an id for archival and patch the projection in place so search hides it.
pub fn queue_forget(project_root: &Path, id: &str) -> Result<PathBuf, MtuiError> {
    let dir = ensure_dir(project_root)?;
    let path = dir.join(FORGET_FILE);
    append_line(&path, id)?;

    // Best-effort in-place archive so the CLI hides it before the engine rebuilds.
    let index = index_path(project_root);
    if index.exists() {
        if let Ok(raw) = std::fs::read_to_string(&index) {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(entries) = value.get_mut("entries").and_then(|e| e.as_array_mut()) {
                    for entry in entries.iter_mut() {
                        if entry.get("id").and_then(|v| v.as_str()) == Some(id) {
                            entry["status"] = serde_json::Value::String("archived".to_string());
                        }
                    }
                }
                if let Ok(serialized) = serde_json::to_string_pretty(&value) {
                    let _ = std::fs::write(&index, serialized);
                }
            }
        }
    }
    Ok(path)
}

/// Queue confidence feedback for an entry; the engine applies it on next drain.
pub fn queue_feedback(project_root: &Path, id: &str, helped: bool) -> Result<PathBuf, MtuiError> {
    let dir = ensure_dir(project_root)?;
    let path = dir.join(FEEDBACK_FILE);
    let item = serde_json::json!({ "id": id, "helped": helped });
    append_line(&path, &item.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, lexical: &str) -> ProjectionEntry {
        ProjectionEntry {
            id: id.to_string(),
            kind: "successful_fix".to_string(),
            status: "active".to_string(),
            symptom: "vitest mock not applied".to_string(),
            lesson: "hoist vi.mock".to_string(),
            tags: vec!["vitest".to_string()],
            frameworks: vec!["vitest".to_string()],
            packages: vec!["vitest".to_string()],
            files: vec!["useThing.ts".to_string()],
            commands: vec!["bun run test".to_string()],
            error_category: Some("test-failure".to_string()),
            confidence: 0.8,
            verification_strength: 0.8,
            updated_at: "2026-06-08T00:00:00.000Z".to_string(),
            lexical_text: lexical.to_string(),
            caution: vec!["check context".to_string()],
            suggested_checks: vec!["Run: bun run test".to_string()],
            vector: None,
        }
    }

    fn query() -> SearchQuery {
        SearchQuery {
            text: "vitest mock not applied".to_string(),
            frameworks: vec!["vitest".to_string()],
            packages: vec![],
            files: vec![],
            commands: vec!["bun run test".to_string()],
            error_category: Some("test-failure".to_string()),
            kind: None,
            tags: vec![],
            limit: 5,
            min_score: 0.0,
        }
    }

    #[test]
    fn tokenize_lowercases_and_drops_short_tokens() {
        assert_eq!(tokenize("Vitest a Mock_X!"), vec!["vitest", "mock_x"]);
    }

    #[test]
    fn lexical_similarity_matches_shared_tokens() {
        let tokens = tokenize("vitest mock applied");
        let sim = lexical_similarity(&tokens, "vitest mock applied here");
        assert!(sim > 0.9);
    }

    #[test]
    fn search_ranks_matching_entry_first() {
        let projection = Projection {
            version: 1,
            provider_id: None,
            model: None,
            dimensions: 0,
            built_at: 0,
            entries: vec![
                entry("low", "completely unrelated electron wayland issue"),
                entry("high", "vitest mock not applied hoist vi.mock vitest bun run test test-failure"),
            ],
        };
        let now = chrono::DateTime::parse_from_rfc3339("2026-06-09T00:00:00.000Z")
            .unwrap()
            .timestamp_millis() as f64;
        let results = search(&projection, &query(), now);
        assert_eq!(results[0].entry_id, "high");
        assert!(results[0].why_relevant.iter().any(|w| w == "Same framework"));
    }

    #[test]
    fn search_drops_archived_entries() {
        let mut e = entry("a", "vitest mock not applied");
        e.status = "archived".to_string();
        let projection = Projection {
            version: 1,
            provider_id: None,
            model: None,
            dimensions: 0,
            built_at: 0,
            entries: vec![e],
        };
        assert!(search(&projection, &query(), 0.0).is_empty());
    }

    #[test]
    fn search_filters_by_kind() {
        let projection = Projection {
            version: 1,
            provider_id: None,
            model: None,
            dimensions: 0,
            built_at: 0,
            entries: vec![entry("a", "vitest mock not applied vitest bun run test")],
        };
        let mut q = query();
        q.kind = Some("agent_mistake".to_string());
        assert!(search(&projection, &q, 0.0).is_empty());
    }
}
