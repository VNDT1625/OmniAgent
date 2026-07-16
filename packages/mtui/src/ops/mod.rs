use crate::error::MtuiError;
use crate::fs;
use crate::safety::RiskLevel;
use serde::Serialize;
use std::path::{Path, PathBuf};

const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const UNDERSTAND_STALE_MAX_PATHS: usize = 200;

fn mark_understand_stale(project_root: &Path, changed_path: &Path) {
    let dir = project_root.join(".aionui").join("understand");
    let marker = dir.join("stale.json");
    let relative = display_project_path(project_root, changed_path);
    let existing = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let first_updated_at = existing
        .as_ref()
        .and_then(|value| value.get("firstUpdatedAt"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let mut paths = existing
        .as_ref()
        .and_then(|value| value.get("paths"))
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !paths.iter().any(|path| path == &relative) {
        paths.push(relative);
    }
    if paths.len() > UNDERSTAND_STALE_MAX_PATHS {
        let excess = paths.len() - UNDERSTAND_STALE_MAX_PATHS;
        paths.drain(0..excess);
    }
    let updated_at = chrono::Utc::now().to_rfc3339();
    let payload = serde_json::json!({
        "version": 1,
        "firstUpdatedAt": first_updated_at.unwrap_or_else(|| updated_at.clone()),
        "updatedAt": updated_at,
        "reason": "mtui_write",
        "pathCount": paths.len(),
        "paths": paths,
    });
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(
        marker,
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()),
    );
}

fn operation_metadata() -> (Option<String>, Option<String>, Option<String>) {
    (
        std::env::var("MTUI_AGENT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty()),
        std::env::var("MTUI_TASK_ID")
            .ok()
            .filter(|value| !value.trim().is_empty()),
        std::env::var("MTUI_PLAN_ID")
            .ok()
            .filter(|value| !value.trim().is_empty()),
    )
}

#[derive(Debug, Serialize)]
pub struct NewResult {
    pub command: String,
    pub operation: String,
    pub operation_id: String,
    pub file: String,
    pub changed: bool,
    pub backup: Option<String>,
    pub diff_summary: String,
}

#[derive(Debug, Serialize)]
pub struct DeleteFileResult {
    pub command: String,
    pub operation: String,
    pub operation_id: String,
    pub file: String,
    pub changed: bool,
    pub backup: Option<String>,
    pub diff_summary: String,
    pub before_hash: String,
    pub after_hash: Option<String>,
    pub dry_run: bool,
}

pub fn delete_file(
    project_root: &Path,
    file_path: &Path,
    config: &crate::config::MtuiConfig,
    dry_run: bool,
    force: bool,
) -> Result<DeleteFileResult, MtuiError> {
    let canonical = crate::safety::validate_path(file_path, project_root, config)?;
    let metadata = std::fs::metadata(&canonical).map_err(|e| MtuiError::PermissionDenied {
        message: format!("Cannot inspect {}: {}", canonical.display(), e),
        suggestion: "Check file permissions".to_string(),
    })?;
    if metadata.is_dir() {
        return Err(MtuiError::InvalidArgument {
            message: format!("Refusing to delete directory: {}", file_path.display()),
            suggestion: "mtui delete only deletes files; remove directories manually after review"
                .to_string(),
        });
    }
    if metadata.permissions().readonly() && !force {
        return Err(MtuiError::InvalidArgument {
            message: format!("Refusing to delete read-only file: {}", file_path.display()),
            suggestion: "Use --force if this deletion is intentional".to_string(),
        });
    }

    let before = fs::read_file_bytes(&canonical).map_err(|e| MtuiError::PermissionDenied {
        message: format!("Cannot read {} before delete: {}", canonical.display(), e),
        suggestion: "Check file permissions".to_string(),
    })?;
    let before_hash = fs::compute_hash(&before);
    let operation_id = generate_operation_id();
    let before_text = String::from_utf8_lossy(&before);
    let diff = crate::diff::generate_diff(&before_text, "");
    let diff_summary = crate::diff::diff_summary_string(diff.insertions, diff.deletions);

    if dry_run {
        return Ok(DeleteFileResult {
            command: "delete".to_string(),
            operation: "delete_file".to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: false,
            backup: None,
            diff_summary,
            before_hash,
            after_hash: None,
            dry_run: true,
        });
    }

    let backup_path =
        crate::backup::create_backup(project_root, &operation_id, &canonical, &before).map_err(
            |e| MtuiError::BackupFailed {
                message: format!("{}", e),
                suggestion: "Check disk space".to_string(),
            },
        )?;
    let diff_path =
        crate::diff::save_diff(project_root, &operation_id, &diff.diff).map_err(|e| {
            MtuiError::DiffFailed {
                message: format!("{}", e),
                suggestion: "Check disk space".to_string(),
            }
        })?;

    std::fs::remove_file(&canonical).map_err(|e| MtuiError::WriteFailed {
        message: format!("Failed to delete file: {}", e),
        suggestion: "Check permissions and whether another process is using the file".to_string(),
    })?;
    mark_understand_stale(project_root, &canonical);

    crate::config::ensure_config_dir(project_root).map_err(|e| MtuiError::Internal {
        message: format!("Failed to prepare MTUI state directory: {}", e),
    })?;
    let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
        message: format!("Database error: {}", e),
    })?;

    let (agent_id, task_id, plan_id) = operation_metadata();
    let record = crate::history::OperationRecord {
        operation_id: operation_id.clone(),
        command: "delete".to_string(),
        operation_type: "delete_file".to_string(),
        cwd: std::env::current_dir()
            .unwrap_or_default()
            .display()
            .to_string(),
        project_path: project_root.display().to_string(),
        file_path: Some(canonical.display().to_string()),
        before_hash: Some(before_hash.clone()),
        after_hash: None,
        backup_path: Some(backup_path.display().to_string()),
        diff_path: Some(diff_path.display().to_string()),
        changed: true,
        created_at: chrono::Utc::now().to_rfc3339(),
        agent_id,
        task_id,
        plan_id,
    };
    crate::history::record_operation(&conn, &record).map_err(|e| MtuiError::Internal {
        message: format!("Failed to record operation: {}", e),
    })?;

    Ok(DeleteFileResult {
        command: "delete".to_string(),
        operation: "delete_file".to_string(),
        operation_id,
        file: canonical.display().to_string(),
        changed: true,
        backup: Some(backup_path.display().to_string()),
        diff_summary,
        before_hash,
        after_hash: None,
        dry_run: false,
    })
}

pub fn create_file(
    project_root: &Path,
    file_path: &Path,
    content: &[u8],
    overwrite: bool,
    config: &crate::config::MtuiConfig,
    dry_run: bool,
) -> Result<NewResult, MtuiError> {
    let canonical = crate::safety::validate_path_for_new(file_path, project_root, config)?;
    let existing_content = if canonical.exists() {
        Some(crate::safety::check_not_binary(&canonical)?)
    } else {
        None
    };

    if existing_content.is_some() && !overwrite {
        return Err(MtuiError::FileExists {
            message: format!("{} already exists", file_path.display()),
            suggestion: "Use --overwrite if you want to replace the file".to_string(),
        });
    }

    let operation_id = generate_operation_id();
    let diff = existing_content.as_ref().map(|before| {
        let before_text = String::from_utf8_lossy(before);
        let after_text = String::from_utf8_lossy(content);
        crate::diff::generate_diff(&before_text, &after_text)
    });
    let diff_summary = if dry_run {
        if let Some(ref diff) = diff {
            crate::diff::diff_summary_string(diff.insertions, diff.deletions)
        } else {
            let new_content_str = String::from_utf8_lossy(content);
            let line_count = new_content_str.lines().count();
            format!("+{} -0", line_count)
        }
    } else {
        String::new()
    };

    if !dry_run {
        if let Some(parent) = canonical.parent() {
            std::fs::create_dir_all(parent).map_err(|e| MtuiError::WriteFailed {
                message: format!("Cannot create parent directory: {}", e),
                suggestion: "Check permissions".to_string(),
            })?;
        }

        let backup_path = if let Some(ref before) = existing_content {
            Some(
                crate::backup::create_backup(project_root, &operation_id, &canonical, before)
                    .map_err(|e| MtuiError::BackupFailed {
                        message: format!("{}", e),
                        suggestion: "Check disk space".to_string(),
                    })?,
            )
        } else {
            None
        };

        let diff_path = if let Some(ref diff) = diff {
            Some(
                crate::diff::save_diff(project_root, &operation_id, &diff.diff).map_err(|e| {
                    MtuiError::DiffFailed {
                        message: format!("{}", e),
                        suggestion: "Check disk space".to_string(),
                    }
                })?,
            )
        } else {
            None
        };

        fs::atomic_write(&canonical, content).map_err(|e| MtuiError::WriteFailed {
            message: format!("Failed to write file: {}", e),
            suggestion: "Check disk space and permissions".to_string(),
        })?;
        mark_understand_stale(project_root, &canonical);

        let diff_summary = if let Some(ref diff) = diff {
            crate::diff::diff_summary_string(diff.insertions, diff.deletions)
        } else {
            let new_content_str = String::from_utf8_lossy(content);
            let line_count = new_content_str.lines().count();
            format!("+{} -0", line_count)
        };

        crate::config::ensure_config_dir(project_root).map_err(|e| MtuiError::Internal {
            message: format!("Failed to prepare MTUI state directory: {}", e),
        })?;
        let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;

        let (agent_id, task_id, plan_id) = operation_metadata();
        let record = crate::history::OperationRecord {
            operation_id: operation_id.clone(),
            command: "new".to_string(),
            operation_type: if backup_path.is_some() {
                "overwrite_file".to_string()
            } else {
                "create_file".to_string()
            },
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string(),
            project_path: project_root.display().to_string(),
            file_path: Some(canonical.display().to_string()),
            before_hash: existing_content
                .as_ref()
                .map(|before| fs::compute_hash(before)),
            after_hash: Some(fs::compute_hash(content)),
            backup_path: backup_path.as_ref().map(|p| p.display().to_string()),
            diff_path: diff_path.as_ref().map(|p| p.display().to_string()),
            changed: true,
            created_at: chrono::Utc::now().to_rfc3339(),
            agent_id,
            task_id,
            plan_id,
        };
        crate::history::record_operation(&conn, &record).map_err(|e| MtuiError::Internal {
            message: format!("Failed to record operation: {}", e),
        })?;

        return Ok(NewResult {
            command: "new".to_string(),
            operation: if backup_path.is_some() {
                "overwrite_file".to_string()
            } else {
                "create_file".to_string()
            },
            operation_id,
            file: canonical.display().to_string(),
            changed: true,
            backup: backup_path.map(|p| p.display().to_string()),
            diff_summary,
        });
    }

    Ok(NewResult {
        command: "new".to_string(),
        operation: if existing_content.is_some() {
            "overwrite_file".to_string()
        } else {
            "create_file".to_string()
        },
        operation_id,
        file: canonical.display().to_string(),
        changed: false,
        backup: None,
        diff_summary,
    })
}

#[derive(Debug, Serialize)]
pub struct EditResult {
    pub command: String,
    pub operation: String,
    pub operation_id: String,
    pub file: String,
    pub changed: bool,
    pub backup: Option<String>,
    pub diff_summary: String,
    pub matches: Option<usize>,
    pub line: Option<usize>,
    pub current_hash: String,
    pub expected_hash: Option<String>,
    pub concurrency: Option<ConcurrencyAssessment>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConcurrencyAssessment {
    pub allowed: bool,
    pub reason: String,
    pub expected_hash: String,
    pub current_hash: String,
    pub edit_lines: LineRange,
    pub previous_operation: Option<String>,
    pub previous_lines: Option<LineRange>,
    pub edit_symbol: Option<String>,
    pub previous_symbol: Option<String>,
    pub checked_operations: Vec<ConcurrentOperation>,
    pub related_files: Vec<String>,
    pub current_agent_id: Option<String>,
    pub current_task_id: Option<String>,
    pub current_plan_id: Option<String>,
    pub resolution: ConflictResolution,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConcurrentOperation {
    pub operation_id: String,
    pub operation_type: String,
    pub lines: Option<LineRange>,
    pub symbol: Option<String>,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub plan_id: Option<String>,
    pub reason: String,
    pub diff_excerpt: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConflictResolution {
    pub status: String,
    pub reload_command: String,
    pub history_command: String,
    pub recommended_action: String,
    pub confirmation_token: Option<String>,
    pub accept_command_hint: Option<String>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize)]
pub struct ConflictCommandResult {
    pub command: String,
    pub action: String,
    pub found: bool,
    pub accepted: bool,
    pub token: Option<String>,
    pub status: Option<String>,
    pub stale: bool,
    pub file: Option<String>,
    pub message: String,
    pub accept_args: Vec<String>,
    pub conflicts: Vec<serde_json::Value>,
    pub conflict: Option<serde_json::Value>,
}

fn line_for_byte(content: &str, byte_idx: usize) -> usize {
    content[..byte_idx.min(content.len())]
        .bytes()
        .filter(|b| *b == b'\n')
        .count()
        + 1
}

fn text_range_for_match(content: &str, needle: &str, all: bool) -> LineRange {
    let mut range: Option<LineRange> = None;
    for (idx, _) in content.match_indices(needle) {
        let start = line_for_byte(content, idx);
        let end = line_for_byte(content, idx + needle.len());
        range = Some(match range {
            Some(existing) => LineRange {
                start: existing.start.min(start),
                end: existing.end.max(end),
            },
            None => LineRange { start, end },
        });
        if !all {
            break;
        }
    }
    range.unwrap_or(LineRange { start: 1, end: 1 })
}

fn ranges_overlap(a: LineRange, b: LineRange) -> bool {
    a.start <= b.end && b.start <= a.end
}

fn parse_added_hunk_range(diff: &str) -> Option<LineRange> {
    let mut current_new_line: Option<usize> = None;
    let mut changed: Option<LineRange> = None;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("@@ ") {
            let Some(plus_at) = rest.find('+') else {
                continue;
            };
            let added = &rest[plus_at + 1..];
            let added = added.split_whitespace().next().unwrap_or(added);
            let mut parts = added.split(',');
            current_new_line = parts.next().and_then(|value| value.parse::<usize>().ok());
            continue;
        }
        let Some(new_line) = current_new_line else {
            continue;
        };
        if line.starts_with('+') {
            changed = Some(match changed {
                Some(existing) => LineRange {
                    start: existing.start.min(new_line),
                    end: existing.end.max(new_line),
                },
                None => LineRange {
                    start: new_line,
                    end: new_line,
                },
            });
            current_new_line = Some(new_line + 1);
        } else if line.starts_with('-') {
            changed = Some(match changed {
                Some(existing) => LineRange {
                    start: existing.start.min(new_line),
                    end: existing.end.max(new_line),
                },
                None => LineRange {
                    start: new_line,
                    end: new_line,
                },
            });
        } else if line.starts_with(' ') {
            current_new_line = Some(new_line + 1);
        }
    }
    changed
}

fn file_operations_since_expected(
    project_root: &Path,
    canonical: &Path,
    expected_hash: &str,
) -> Result<Vec<crate::history::OperationRecord>, MtuiError> {
    let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
        message: format!("Database error: {}", e),
    })?;
    let operations =
        crate::history::list_operations(&conn, 500).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;
    let target = canonical.display().to_string();
    let mut relevant = Vec::new();
    for op in operations.into_iter().filter(|op| {
        op.changed
            && op
                .file_path
                .as_ref()
                .map(|path| path == &target)
                .unwrap_or(false)
    }) {
        let reached_expected = op
            .before_hash
            .as_ref()
            .map(|hash| hash == expected_hash)
            .unwrap_or(false);
        relevant.push(op);
        if reached_expected {
            break;
        }
    }
    Ok(relevant)
}

fn compact_diff_excerpt(diff_path: Option<&String>) -> Option<String> {
    let diff = std::fs::read_to_string(diff_path?).ok()?;
    const MAX_CHARS: usize = 2000;
    if diff.chars().count() <= MAX_CHARS {
        return Some(diff);
    }
    let excerpt = diff.chars().take(MAX_CHARS).collect::<String>();
    Some(format!(
        "{}\n... truncated; run mtui diff for full diff ...",
        excerpt
    ))
}

fn conflicts_dir(project_root: &Path) -> PathBuf {
    crate::config::config_dir(project_root).join("conflicts")
}

fn conflict_path(project_root: &Path, token: &str) -> PathBuf {
    conflicts_dir(project_root).join(format!("{}.json", token))
}

fn current_conflict_path(project_root: &Path) -> PathBuf {
    conflicts_dir(project_root).join("current.json")
}

fn conflict_token(value: &serde_json::Value) -> Option<String> {
    value
        .get("token")
        .and_then(|token| token.as_str())
        .map(|token| token.to_string())
}

fn conflict_status(value: &serde_json::Value) -> Option<String> {
    value
        .get("conflict")
        .and_then(|conflict| conflict.get("resolution"))
        .and_then(|resolution| resolution.get("status"))
        .and_then(|status| status.as_str())
        .map(|status| status.to_string())
}

fn conflict_file(value: &serde_json::Value) -> Option<String> {
    value
        .get("file")
        .and_then(|file| file.as_str())
        .map(|file| file.to_string())
}

fn load_conflict_file(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn load_current_conflict(project_root: &Path) -> Option<serde_json::Value> {
    load_conflict_file(&current_conflict_path(project_root))
}

fn load_conflict_by_token(project_root: &Path, token: Option<&str>) -> Option<serde_json::Value> {
    match token {
        Some(token) => load_conflict_file(&conflict_path(project_root, token)),
        None => load_current_conflict(project_root),
    }
}

fn conflict_is_stale(value: &serde_json::Value) -> bool {
    let Some(file) = value.get("file").and_then(|file| file.as_str()) else {
        return true;
    };
    let Some(expected_current_hash) = value
        .get("conflict")
        .and_then(|conflict| conflict.get("current_hash"))
        .and_then(|hash| hash.as_str())
    else {
        return true;
    };
    let Ok(bytes) = std::fs::read(file) else {
        return true;
    };
    fs::compute_hash(&bytes) != expected_current_hash
}

fn accept_args_for_token(token: &str) -> Vec<String> {
    vec!["--accept-stale".to_string(), token.to_string()]
}

fn persist_confirmation_conflict(
    project_root: &Path,
    canonical: &Path,
    assessment: &ConcurrencyAssessment,
) {
    let Some(token) = assessment.resolution.confirmation_token.as_ref() else {
        return;
    };
    let dir = conflicts_dir(project_root);
    let payload = serde_json::json!({
        "version": 1,
        "created_at": chrono::Utc::now().to_rfc3339(),
        "token": token,
        "file": canonical.display().to_string(),
        "relative_file": display_project_path(project_root, canonical),
        "accept_args": accept_args_for_token(token),
        "message": "Review conflict.checked_operations[].diff_excerpt; retry the same edit with accept_args only if the current diff is acceptable.",
        "conflict": assessment,
    });
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(conflict_path(project_root, token), &text);
        let _ = std::fs::write(current_conflict_path(project_root), text);
    }
}

pub fn conflict_current(project_root: &Path) -> ConflictCommandResult {
    let Some(conflict) = load_current_conflict(project_root) else {
        return ConflictCommandResult {
            command: "conflict".to_string(),
            action: "current".to_string(),
            found: false,
            accepted: false,
            token: None,
            status: None,
            stale: false,
            file: None,
            message: "No pending stale-edit confirmation conflict.".to_string(),
            accept_args: Vec::new(),
            conflicts: Vec::new(),
            conflict: None,
        };
    };
    let token = conflict_token(&conflict);
    let stale = conflict_is_stale(&conflict);
    ConflictCommandResult {
        command: "conflict".to_string(),
        action: "current".to_string(),
        found: true,
        accepted: false,
        token: token.clone(),
        status: conflict_status(&conflict),
        stale,
        file: conflict_file(&conflict),
        message: if stale {
            "Conflict file changed after this token was generated; retry the original edit without --accept-stale to refresh analysis."
                .to_string()
        } else {
            "Review diff excerpts; use accept_args only if the current diff is acceptable."
                .to_string()
        },
        accept_args: token
            .map(|token| accept_args_for_token(&token))
            .unwrap_or_default(),
        conflicts: Vec::new(),
        conflict: Some(conflict),
    }
}

pub fn conflict_list(project_root: &Path, limit: usize) -> ConflictCommandResult {
    let mut entries = std::fs::read_dir(conflicts_dir(project_root))
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter(|entry| entry.file_name().to_string_lossy() != "current.json")
        .filter_map(|entry| load_conflict_file(&entry.path()))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.get("created_at")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .cmp(
                a.get("created_at")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default(),
            )
    });
    entries.truncate(limit.max(1));
    ConflictCommandResult {
        command: "conflict".to_string(),
        action: "list".to_string(),
        found: !entries.is_empty(),
        accepted: false,
        token: None,
        status: None,
        stale: false,
        file: None,
        message: if entries.is_empty() {
            "No stale-edit confirmation conflicts recorded.".to_string()
        } else {
            format!("{} stale-edit confirmation conflict(s).", entries.len())
        },
        accept_args: Vec::new(),
        conflicts: entries,
        conflict: None,
    }
}

pub fn conflict_explain(project_root: &Path, token: Option<&str>) -> ConflictCommandResult {
    let Some(conflict) = load_conflict_by_token(project_root, token) else {
        return ConflictCommandResult {
            command: "conflict".to_string(),
            action: "explain".to_string(),
            found: false,
            accepted: false,
            token: token.map(|token| token.to_string()),
            status: None,
            stale: false,
            file: None,
            message: "No matching stale-edit confirmation conflict.".to_string(),
            accept_args: Vec::new(),
            conflicts: Vec::new(),
            conflict: None,
        };
    };
    let token = conflict_token(&conflict);
    let stale = conflict_is_stale(&conflict);
    ConflictCommandResult {
        command: "conflict".to_string(),
        action: "explain".to_string(),
        found: true,
        accepted: false,
        token: token.clone(),
        status: conflict_status(&conflict),
        stale,
        file: conflict_file(&conflict),
        message: if stale {
            "This conflict is stale because the file changed after the token was generated."
                .to_string()
        } else {
            "This conflict is current; inspect conflict.checked_operations[].diff_excerpt before accepting."
                .to_string()
        },
        accept_args: token
            .map(|token| accept_args_for_token(&token))
            .unwrap_or_default(),
        conflicts: Vec::new(),
        conflict: Some(conflict),
    }
}

pub fn conflict_accept(project_root: &Path, token: Option<&str>) -> ConflictCommandResult {
    let Some(conflict) = load_conflict_by_token(project_root, token) else {
        return ConflictCommandResult {
            command: "conflict".to_string(),
            action: "accept".to_string(),
            found: false,
            accepted: false,
            token: token.map(|token| token.to_string()),
            status: None,
            stale: false,
            file: None,
            message: "No matching stale-edit confirmation conflict.".to_string(),
            accept_args: Vec::new(),
            conflicts: Vec::new(),
            conflict: None,
        };
    };
    let token = conflict_token(&conflict);
    let stale = conflict_is_stale(&conflict);
    ConflictCommandResult {
        command: "conflict".to_string(),
        action: "accept".to_string(),
        found: true,
        accepted: !stale && token.is_some(),
        token: token.clone(),
        status: conflict_status(&conflict),
        stale,
        file: conflict_file(&conflict),
        message: if stale {
            "Not accepted: file changed after this token was generated; retry the original edit without --accept-stale."
                .to_string()
        } else {
            "Accepted for retry: append accept_args to the same edit command.".to_string()
        },
        accept_args: if stale {
            Vec::new()
        } else {
            token
                .as_ref()
                .map(|token| accept_args_for_token(token))
                .unwrap_or_default()
        },
        conflicts: Vec::new(),
        conflict: Some(conflict),
    }
}

fn summary_cache(project_root: &Path) -> Option<serde_json::Value> {
    let summary_path = project_root
        .join(".aionui")
        .join("understand")
        .join("summary.json");
    let data = std::fs::read_to_string(summary_path).ok()?;
    serde_json::from_str(&data).ok()
}

fn symbol_for_range(project_root: &Path, canonical: &Path, range: LineRange) -> Option<String> {
    let from_cache = symbol_for_range_from_cache(project_root, canonical, range);
    from_cache.or_else(|| lightweight_symbol_for_range(canonical, range))
}

fn symbol_for_range_from_cache(
    project_root: &Path,
    canonical: &Path,
    range: LineRange,
) -> Option<String> {
    let json = summary_cache(project_root)?;
    let rel = display_project_path(project_root, canonical);
    let files = json.get("files")?.as_array()?;
    let file = files.iter().find(|file| {
        file.get("path")
            .and_then(|value| value.as_str())
            .map(|path| path == rel)
            .unwrap_or(false)
    })?;
    let symbols = file.get("symbols")?.as_array()?;
    symbols
        .iter()
        .filter_map(|symbol| {
            let start = symbol.get("line")?.as_u64()? as usize;
            let end = symbol
                .get("endLine")
                .and_then(|value| value.as_u64())
                .map(|value| value as usize)
                .unwrap_or(start);
            if ranges_overlap(range, LineRange { start, end }) {
                Some(format!(
                    "{}:{}",
                    symbol
                        .get("kind")
                        .and_then(|value| value.as_str())
                        .unwrap_or("symbol"),
                    symbol
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("<anonymous>")
                ))
            } else {
                None
            }
        })
        .next()
}

fn lightweight_symbol_for_range(canonical: &Path, range: LineRange) -> Option<String> {
    let content = std::fs::read_to_string(canonical).ok()?;
    let lines = content.lines().collect::<Vec<_>>();
    let mut best = None;
    for (idx, line) in lines
        .iter()
        .enumerate()
        .take(range.start.min(lines.len()))
        .rev()
    {
        let trimmed = line.trim();
        let candidates = [
            ("function", "function "),
            ("class", "class "),
            ("type", "type "),
            ("const", "const "),
            ("export", "export "),
        ];
        for (kind, marker) in candidates {
            if let Some(at) = trimmed.find(marker) {
                let name = trimmed[at + marker.len()..]
                    .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'))
                    .find(|part| !part.is_empty())
                    .unwrap_or("<anonymous>");
                best = Some(format!("{}:{}", kind, name));
                break;
            }
        }
        if best.is_some() || idx + 1 < range.start.saturating_sub(80) {
            break;
        }
    }
    best
}

fn symbol_name(symbol: &str) -> &str {
    symbol.split(':').nth(1).unwrap_or(symbol)
}

fn same_file_symbol_dependency(
    project_root: &Path,
    canonical: &Path,
    left: Option<&str>,
    right: Option<&str>,
) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    if left == right {
        return true;
    }
    let left_name = symbol_name(left);
    let right_name = symbol_name(right);
    if left_name.is_empty()
        || right_name.is_empty()
        || left_name == "<anonymous>"
        || right_name == "<anonymous>"
    {
        return false;
    }
    let Some(json) = summary_cache(project_root) else {
        return false;
    };
    let rel = display_project_path(project_root, canonical);
    let Some(file) = json
        .get("files")
        .and_then(|value| value.as_array())
        .and_then(|files| {
            files.iter().find(|file| {
                file.get("path")
                    .and_then(|value| value.as_str())
                    .map(|path| path == rel)
                    .unwrap_or(false)
            })
        })
    else {
        return false;
    };
    let Some(symbols) = file.get("symbols").and_then(|value| value.as_array()) else {
        return false;
    };
    let calls_for = |name: &str| -> Vec<String> {
        symbols
            .iter()
            .filter(|symbol| {
                symbol
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|symbol_name| symbol_name == name)
                    .unwrap_or(false)
            })
            .flat_map(|symbol| {
                symbol
                    .get("calls")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|value| value.as_str().map(|call| call.to_string()))
            .collect::<Vec<_>>()
    };
    let left_calls = calls_for(left_name);
    let right_calls = calls_for(right_name);
    left_calls.iter().any(|call| call == right_name)
        || right_calls.iter().any(|call| call == left_name)
}

fn related_files_for_symbol(
    project_root: &Path,
    canonical: &Path,
    symbol: Option<&str>,
) -> Vec<String> {
    let Some(json) = summary_cache(project_root) else {
        return Vec::new();
    };
    let rel = display_project_path(project_root, canonical);
    let files = json
        .get("files")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let target_file = files
        .iter()
        .find(|file| file.get("path").and_then(|value| value.as_str()) == Some(rel.as_str()));
    let mut related = std::collections::BTreeSet::new();
    if target_file
        .and_then(|file| file.get("importedBy"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0)
        > 0
    {
        let stem = canonical
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        for file in &files {
            let Some(path) = file.get("path").and_then(|value| value.as_str()) else {
                continue;
            };
            if path == rel {
                continue;
            }
            let haystack = serde_json::to_string(file)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !stem.is_empty() && haystack.contains(&stem) {
                related.insert(path.to_string());
            }
        }
    }
    if let Some(symbol) = symbol {
        let name = symbol_name(symbol).to_ascii_lowercase();
        if !name.is_empty() && name != "<anonymous>" {
            for file in &files {
                let Some(path) = file.get("path").and_then(|value| value.as_str()) else {
                    continue;
                };
                if path == rel {
                    continue;
                }
                let haystack = serde_json::to_string(file)
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if haystack.contains(&name) {
                    related.insert(path.to_string());
                }
            }
        }
    }
    related.into_iter().take(12).collect()
}

fn stale_acceptance_token(
    canonical: &Path,
    expected_hash: &str,
    current_hash: &str,
    edit_lines: LineRange,
    edit_symbol: Option<&str>,
    checked_operations: &[ConcurrentOperation],
) -> Option<String> {
    let dependency_operations = checked_operations
        .iter()
        .filter(|op| op.reason == "same_file_symbol_dependency")
        .collect::<Vec<_>>();
    if dependency_operations.is_empty() {
        return None;
    }

    let mut material = format!(
        "file={}\nexpected={}\ncurrent={}\nedit_lines={}-{}\nedit_symbol={}\n",
        canonical.display(),
        expected_hash,
        current_hash,
        edit_lines.start,
        edit_lines.end,
        edit_symbol.unwrap_or_default()
    );
    for op in dependency_operations {
        let lines = op
            .lines
            .map(|range| format!("{}-{}", range.start, range.end))
            .unwrap_or_default();
        material.push_str(&format!(
            "op={}|type={}|lines={}|symbol={}|agent={}|task={}|plan={}\n",
            op.operation_id,
            op.operation_type,
            lines,
            op.symbol.as_deref().unwrap_or_default(),
            op.agent_id.as_deref().unwrap_or_default(),
            op.task_id.as_deref().unwrap_or_default(),
            op.plan_id.as_deref().unwrap_or_default()
        ));
    }
    Some(fs::compute_hash(material.as_bytes()))
}

fn assess_stale_edit(
    project_root: &Path,
    canonical: &Path,
    current_hash: &str,
    expected_hash: Option<&str>,
    edit_lines: LineRange,
    accept_stale: Option<&str>,
) -> Result<Option<ConcurrencyAssessment>, MtuiError> {
    let Some(expected_hash) = expected_hash else {
        return Ok(None);
    };
    if expected_hash == current_hash {
        return Ok(None);
    }

    let edit_symbol = symbol_for_range(project_root, canonical, edit_lines);
    let operations = file_operations_since_expected(project_root, canonical, expected_hash)?;
    let mut checked_operations = Vec::new();
    let mut line_conflict = false;
    let mut symbol_conflict = false;
    let mut dependency_conflict = false;
    let mut previous_lines = None;
    let mut previous_symbol = None;
    let mut previous_operation = None;
    for op in operations {
        let op_lines = op
            .diff_path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|diff| parse_added_hunk_range(&diff));
        let op_symbol = op_lines.and_then(|range| symbol_for_range(project_root, canonical, range));
        let op_line_conflict = op_lines
            .map(|range| ranges_overlap(edit_lines, range))
            .unwrap_or(false);
        let op_symbol_conflict = edit_symbol.is_some() && edit_symbol == op_symbol;
        let op_dependency_conflict = same_file_symbol_dependency(
            project_root,
            canonical,
            edit_symbol.as_deref(),
            op_symbol.as_deref(),
        );
        if op_line_conflict || op_symbol_conflict || op_dependency_conflict {
            line_conflict |= op_line_conflict;
            symbol_conflict |= op_symbol_conflict;
            dependency_conflict |= op_dependency_conflict;
            previous_lines = op_lines;
            previous_symbol = op_symbol.clone();
            previous_operation = Some(op.operation_id.clone());
        }
        checked_operations.push(ConcurrentOperation {
            operation_id: op.operation_id,
            operation_type: op.operation_type,
            lines: op_lines,
            symbol: op_symbol,
            agent_id: op.agent_id,
            task_id: op.task_id,
            plan_id: op.plan_id,
            reason: if op_line_conflict {
                "line_overlap".to_string()
            } else if op_symbol_conflict {
                "same_symbol".to_string()
            } else if op_dependency_conflict {
                "same_file_symbol_dependency".to_string()
            } else {
                "disjoint".to_string()
            },
            diff_excerpt: compact_diff_excerpt(op.diff_path.as_ref()),
        });
    }
    let hard_conflict = line_conflict || symbol_conflict;
    let confirmation_token = if dependency_conflict && !hard_conflict {
        stale_acceptance_token(
            canonical,
            expected_hash,
            current_hash,
            edit_lines,
            edit_symbol.as_deref(),
            &checked_operations,
        )
    } else {
        None
    };
    let dependency_accepted = confirmation_token
        .as_deref()
        .map(|token| accept_stale == Some(token))
        .unwrap_or(false);
    let allowed = !hard_conflict && (!dependency_conflict || dependency_accepted);
    let related_files = related_files_for_symbol(project_root, canonical, edit_symbol.as_deref());
    let (current_agent_id, current_task_id, current_plan_id) = operation_metadata();
    let reload_command = format!(
        "mtui --json read {} --all",
        display_project_path(project_root, canonical)
    );
    let history_command = "mtui --json history operations --limit 20".to_string();
    let accept_command_hint = confirmation_token.as_ref().map(|token| {
        format!(
            "Review checked_operations[].diff_excerpt, then retry the same edit command with --accept-stale {}",
            token
        )
    });
    let reason = if line_conflict {
        format!(
            "Blocked: file changed since read and at least one later MTUI edit overlaps lines {}-{}.",
            edit_lines.start, edit_lines.end
        )
    } else if symbol_conflict {
        format!(
            "Blocked: file changed since read and at least one later MTUI edit touches {}.",
            edit_symbol
                .clone()
                .unwrap_or_else(|| "the same symbol".to_string())
        )
    } else if dependency_conflict && dependency_accepted {
        format!(
            "Allowed: file changed since read and related same-file symbol edit was accepted with a current confirmation token: {} <-> {}.",
            edit_symbol.clone().unwrap_or_else(|| "current edit".to_string()),
            previous_symbol.clone().unwrap_or_else(|| "previous edit".to_string())
        )
    } else if dependency_conflict {
        format!(
            "Confirmation required: file changed since read and a later MTUI edit touches a related symbol in the same file: {} <-> {}.",
            edit_symbol.clone().unwrap_or_else(|| "current edit".to_string()),
            previous_symbol.clone().unwrap_or_else(|| "previous edit".to_string())
        )
    } else {
        "Allowed: file changed since read, but later MTUI edits appear disjoint by line/symbol."
            .to_string()
    };
    let assessment = ConcurrencyAssessment {
        allowed,
        reason,
        expected_hash: expected_hash.to_string(),
        current_hash: current_hash.to_string(),
        edit_lines,
        previous_operation,
        previous_lines,
        edit_symbol,
        previous_symbol,
        checked_operations,
        related_files,
        current_agent_id,
        current_task_id,
        current_plan_id,
        resolution: ConflictResolution {
            status: if allowed && dependency_accepted {
                "accepted".to_string()
            } else if allowed {
                "allowed".to_string()
            } else if dependency_conflict && !hard_conflict {
                "needs_confirmation".to_string()
            } else {
                "blocked".to_string()
            },
            reload_command: reload_command.clone(),
            history_command,
            recommended_action: if dependency_accepted {
                "Proceed; the related same-file symbol edit was reviewed and accepted with the current confirmation token."
                    .to_string()
            } else if allowed {
                "Proceed; same-file stale edits are disjoint by line/symbol dependency.".to_string()
            } else if dependency_conflict && !hard_conflict {
                "Review checked_operations[].diff_excerpt. If the previous edit is acceptable, retry the same edit with --accept-stale using the current confirmation token."
                    .to_string()
            } else {
                "Reload current file, inspect listed same-file operations, then rebase the edit."
                    .to_string()
            },
            confirmation_token,
            accept_command_hint,
        },
    };
    if assessment.resolution.status == "needs_confirmation" {
        persist_confirmation_conflict(project_root, canonical, &assessment);
    }
    if assessment.allowed {
        Ok(Some(assessment))
    } else {
        let prev = assessment
            .previous_lines
            .map(|range| format!(" Previous edit lines: {}-{}.", range.start, range.end))
            .unwrap_or_default();
        Err(MtuiError::ConflictDetailed {
            message: format!("{}{}", assessment.reason, prev),
            suggestion: assessment
                .resolution
                .accept_command_hint
                .clone()
                .unwrap_or_else(|| {
                    format!(
                        "Run `{}` to reload current content, then rebase the edit. expected_hash={}, current_hash={}",
                        reload_command,
                        assessment.expected_hash,
                        assessment.current_hash
                    )
                }),
            details: serde_json::to_value(&assessment).unwrap_or(serde_json::Value::Null),
        })
    }
}

#[derive(Debug, Serialize)]
pub struct ApplyPatchFileResult {
    pub operation_id: String,
    pub file: String,
    pub existed_before: bool,
    pub exists_after: bool,
    pub backup: Option<String>,
    pub diff_summary: String,
    pub concurrency: Option<ConcurrencyAssessment>,
}

#[derive(Debug, Serialize)]
pub struct ApplyPatchResult {
    pub command: String,
    pub operation: String,
    pub changed: bool,
    pub dry_run: bool,
    pub file_count: usize,
    pub files: Vec<ApplyPatchFileResult>,
}

pub fn apply_unified_patch(
    project_root: &Path,
    patch_text: &str,
    config: &crate::config::MtuiConfig,
    dry_run: bool,
    expected_hashes: &[String],
) -> Result<ApplyPatchResult, MtuiError> {
    if patch_text.trim().is_empty() {
        return Err(MtuiError::InvalidArgument {
            message: "Patch is empty".to_string(),
            suggestion: "Pass --file <patch.diff> or --stdin with a unified diff".to_string(),
        });
    }
    let relative_paths = parse_patch_paths(patch_text)?;
    let expected_hashes = parse_expected_hashes(expected_hashes)?;
    let patch_ranges = parse_patch_ranges_by_file(patch_text);
    let mut targets = Vec::new();
    for relative in &relative_paths {
        let requested = Path::new(relative);
        let absolute = if project_root.join(requested).exists() {
            crate::safety::validate_path(requested, project_root, config)?
        } else {
            crate::safety::validate_path_for_new(requested, project_root, config)?
        };
        targets.push((relative.clone(), absolute));
    }

    if dry_run {
        validate_git_apply(project_root, patch_text, true)?;
        return Ok(ApplyPatchResult {
            command: "apply-patch".to_string(),
            operation: "apply_patch".to_string(),
            changed: false,
            dry_run: true,
            file_count: targets.len(),
            files: targets
                .into_iter()
                .map(|(relative, absolute)| ApplyPatchFileResult {
                    operation_id: String::new(),
                    file: relative_path_for(project_root, &absolute, &relative),
                    existed_before: absolute.exists(),
                    exists_after: absolute.exists(),
                    backup: None,
                    diff_summary: String::new(),
                    concurrency: None,
                })
                .collect(),
        });
    }

    let mut before = Vec::new();
    for (relative, absolute) in &targets {
        let content = if absolute.exists() {
            Some(crate::safety::check_not_binary(absolute)?)
        } else {
            None
        };
        before.push((relative.clone(), absolute.clone(), content));
    }

    let mut concurrency_by_path = std::collections::BTreeMap::new();
    for (relative, absolute, before_content) in &before {
        let Some(expected_hash) = expected_hashes.get(relative) else {
            continue;
        };
        let current_hash = before_content
            .as_ref()
            .map(|content| fs::compute_hash(content))
            .unwrap_or_default();
        let edit_lines = patch_ranges
            .get(relative)
            .copied()
            .unwrap_or(LineRange { start: 1, end: 1 });
        let assessment = assess_stale_edit(
            project_root,
            absolute,
            &current_hash,
            Some(expected_hash),
            edit_lines,
            None,
        )?;
        if let Some(assessment) = assessment {
            concurrency_by_path.insert(relative.clone(), assessment);
        }
    }

    validate_git_apply(project_root, patch_text, false)?;

    crate::config::ensure_config_dir(project_root).map_err(|e| MtuiError::Internal {
        message: format!("Failed to prepare MTUI state directory: {}", e),
    })?;
    let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
        message: format!("Database error: {}", e),
    })?;

    let mut files = Vec::new();
    for (relative, absolute, before_content) in before {
        let operation_id = generate_operation_id();
        let after_content = if absolute.exists() {
            Some(crate::safety::check_not_binary(&absolute)?)
        } else {
            None
        };
        let backup_path = if let Some(content) = &before_content {
            Some(
                crate::backup::create_backup(project_root, &operation_id, &absolute, content)
                    .map_err(|e| MtuiError::BackupFailed {
                        message: format!("{}", e),
                        suggestion: "Check disk space".to_string(),
                    })?,
            )
        } else {
            None
        };
        let before_text = before_content
            .as_ref()
            .map(|content| String::from_utf8_lossy(content).to_string())
            .unwrap_or_default();
        let after_text = after_content
            .as_ref()
            .map(|content| String::from_utf8_lossy(content).to_string())
            .unwrap_or_default();
        let diff = crate::diff::generate_diff(&before_text, &after_text);
        let diff_path =
            crate::diff::save_diff(project_root, &operation_id, &diff.diff).map_err(|e| {
                MtuiError::DiffFailed {
                    message: format!("{}", e),
                    suggestion: "Check disk space".to_string(),
                }
            })?;
        let before_hash = before_content
            .as_ref()
            .map(|content| fs::compute_hash(content));
        let after_hash = after_content
            .as_ref()
            .map(|content| fs::compute_hash(content));
        let (agent_id, task_id, plan_id) = operation_metadata();
        let record = crate::history::OperationRecord {
            operation_id: operation_id.clone(),
            command: "apply-patch".to_string(),
            operation_type: "apply_patch".to_string(),
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string(),
            project_path: project_root.display().to_string(),
            file_path: Some(absolute.display().to_string()),
            before_hash,
            after_hash,
            backup_path: backup_path.as_ref().map(|path| path.display().to_string()),
            diff_path: Some(diff_path.display().to_string()),
            changed: before_text != after_text,
            created_at: chrono::Utc::now().to_rfc3339(),
            agent_id,
            task_id,
            plan_id,
        };
        crate::history::record_operation(&conn, &record).map_err(|e| MtuiError::Internal {
            message: format!("Failed to record operation: {}", e),
        })?;
        files.push(ApplyPatchFileResult {
            operation_id,
            file: relative_path_for(project_root, &absolute, &relative),
            existed_before: before_content.is_some(),
            exists_after: after_content.is_some(),
            backup: backup_path.map(|path| path.display().to_string()),
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            concurrency: concurrency_by_path.remove(&relative),
        });
    }

    Ok(ApplyPatchResult {
        command: "apply-patch".to_string(),
        operation: "apply_patch".to_string(),
        changed: true,
        dry_run: false,
        file_count: files.len(),
        files,
    })
}

fn parse_patch_paths(patch_text: &str) -> Result<Vec<String>, MtuiError> {
    let mut paths = std::collections::BTreeSet::<String>::new();
    for line in patch_text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let parts = rest.split_whitespace().collect::<Vec<_>>();
            if parts.len() >= 2 {
                add_patch_path(&mut paths, parts[0]);
                add_patch_path(&mut paths, parts[1]);
            }
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            add_patch_path(&mut paths, rest.trim());
        } else if let Some(rest) = line.strip_prefix("--- ") {
            add_patch_path(&mut paths, rest.trim());
        }
    }
    if paths.is_empty() {
        return Err(MtuiError::InvalidArgument {
            message: "No file paths found in patch".to_string(),
            suggestion: "Use a unified diff with diff --git, ---/+++ headers".to_string(),
        });
    }
    Ok(paths.into_iter().collect())
}

fn parse_expected_hashes(
    items: &[String],
) -> Result<std::collections::BTreeMap<String, String>, MtuiError> {
    let mut parsed = std::collections::BTreeMap::new();
    for item in items {
        let Some((path, hash)) = item.split_once('=') else {
            return Err(MtuiError::InvalidArgument {
                message: format!("Invalid --expect-hash value: {}", item),
                suggestion: "Use --expect-hash path/to/file=content_hash".to_string(),
            });
        };
        let path = path.trim().replace('\\', "/");
        let hash = hash.trim();
        if path.is_empty() || hash.is_empty() {
            return Err(MtuiError::InvalidArgument {
                message: format!("Invalid --expect-hash value: {}", item),
                suggestion: "Use --expect-hash path/to/file=content_hash".to_string(),
            });
        }
        parsed.insert(path, hash.to_string());
    }
    Ok(parsed)
}

fn parse_patch_ranges_by_file(patch_text: &str) -> std::collections::BTreeMap<String, LineRange> {
    let mut ranges = std::collections::BTreeMap::new();
    let mut current_file: Option<String> = None;
    let mut current_new_line: Option<usize> = None;
    for line in patch_text.lines() {
        if let Some(rest) = line.strip_prefix("+++ ") {
            let mut paths = std::collections::BTreeSet::new();
            add_patch_path(&mut paths, rest.trim());
            current_file = paths.into_iter().next();
            current_new_line = None;
            continue;
        }
        if line.starts_with("--- ") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("@@ ") {
            let Some(plus_at) = rest.find('+') else {
                continue;
            };
            let added = &rest[plus_at + 1..];
            let added = added.split_whitespace().next().unwrap_or(added);
            let mut parts = added.split(',');
            current_new_line = parts.next().and_then(|value| value.parse::<usize>().ok());
            continue;
        }
        let (Some(file), Some(new_line)) = (current_file.as_ref(), current_new_line) else {
            continue;
        };
        if line.starts_with('+') {
            ranges
                .entry(file.clone())
                .and_modify(|range: &mut LineRange| {
                    range.start = range.start.min(new_line);
                    range.end = range.end.max(new_line);
                })
                .or_insert(LineRange {
                    start: new_line,
                    end: new_line,
                });
            current_new_line = Some(new_line + 1);
        } else if line.starts_with('-') {
            ranges
                .entry(file.clone())
                .and_modify(|range: &mut LineRange| {
                    range.start = range.start.min(new_line);
                    range.end = range.end.max(new_line);
                })
                .or_insert(LineRange {
                    start: new_line,
                    end: new_line,
                });
        } else if line.starts_with(' ') {
            current_new_line = Some(new_line + 1);
        }
    }
    ranges
}

fn add_patch_path(paths: &mut std::collections::BTreeSet<String>, raw: &str) {
    let cleaned = raw.trim().trim_matches('"');
    if cleaned == "/dev/null" {
        return;
    }
    let without_prefix = cleaned
        .strip_prefix("a/")
        .or_else(|| cleaned.strip_prefix("b/"))
        .unwrap_or(cleaned)
        .replace('\\', "/");
    if without_prefix.is_empty()
        || without_prefix.starts_with('/')
        || without_prefix.contains("../")
        || without_prefix == ".."
        || without_prefix.starts_with(".git/")
        || without_prefix.starts_with(".mtui/")
    {
        return;
    }
    paths.insert(without_prefix);
}

fn validate_git_apply(project_root: &Path, patch_text: &str, check: bool) -> Result<(), MtuiError> {
    let mut command = std::process::Command::new("git");
    command
        .arg("-C")
        .arg(project_root)
        .arg("apply")
        .arg("--whitespace=nowarn");
    if check {
        command.arg("--check");
    }
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to start git apply: {}", e),
        })?;
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().ok_or_else(|| MtuiError::Internal {
            message: "Failed to open git apply stdin".to_string(),
        })?;
        stdin
            .write_all(patch_text.as_bytes())
            .map_err(|e| MtuiError::Internal {
                message: format!("Failed to write patch to git apply: {}", e),
            })?;
    }
    let output = child.wait_with_output().map_err(|e| MtuiError::Internal {
        message: format!("Failed to wait for git apply: {}", e),
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(MtuiError::Conflict {
            message: format!("Patch does not apply cleanly: {}", stderr.trim()),
            suggestion: "Regenerate the patch from current file contents or use mtui read to inspect exact ranges".to_string(),
        });
    }
    Ok(())
}

fn relative_path_for(project_root: &Path, absolute: &Path, fallback: &str) -> String {
    absolute
        .strip_prefix(project_root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| fallback.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn replace_text(
    project_root: &Path,
    file_path: &Path,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
    dry_run: bool,
    expected_hash: Option<&str>,
    accept_stale: Option<&str>,
    config: &crate::config::MtuiConfig,
) -> Result<EditResult, MtuiError> {
    let canonical = crate::safety::validate_path(file_path, project_root, config)?;
    let content_bytes = crate::safety::check_not_binary(&canonical)?;
    let content = String::from_utf8(content_bytes).map_err(|_| MtuiError::EncodingError {
        message: "File is not valid UTF-8".to_string(),
        suggestion: "MTUI only supports UTF-8 files".to_string(),
    })?;

    let count = content.matches(old_text).count();

    if count == 0 {
        return Err(MtuiError::NoMatch {
            message: format!("Text not found in {}", file_path.display()),
            suggestion: format!(
                "Use mtui search \"{}\" \"keyword\" --json",
                file_path.display()
            ),
        });
    }

    if count > 1 && !replace_all {
        return Err(MtuiError::MultipleMatches {
            message: format!("Found {} matches in {}", count, file_path.display()),
            matches: count,
            suggestion: "Use --all, --line, or a more specific old text".to_string(),
        });
    }

    let before_hash = fs::compute_hash(content.as_bytes());
    let edit_lines = text_range_for_match(&content, old_text, replace_all);
    let concurrency = assess_stale_edit(
        project_root,
        &canonical,
        &before_hash,
        expected_hash,
        edit_lines,
        accept_stale,
    )?;
    let new_content = content.replace(old_text, new_text);
    let after_hash = fs::compute_hash(new_content.as_bytes());
    let diff = crate::diff::generate_diff(&content, &new_content);
    let operation_id = generate_operation_id();

    if !dry_run {
        let backup_path = crate::backup::create_backup(
            project_root,
            &operation_id,
            &canonical,
            content.as_bytes(),
        )
        .map_err(|e| MtuiError::BackupFailed {
            message: format!("{}", e),
            suggestion: "Check disk space".to_string(),
        })?;

        let diff_path =
            crate::diff::save_diff(project_root, &operation_id, &diff.diff).map_err(|e| {
                MtuiError::DiffFailed {
                    message: format!("{}", e),
                    suggestion: "Check disk space".to_string(),
                }
            })?;

        fs::atomic_write(&canonical, new_content.as_bytes()).map_err(|e| {
            MtuiError::WriteFailed {
                message: format!("Failed to write file: {}", e),
                suggestion: "Check disk space and permissions".to_string(),
            }
        })?;
        mark_understand_stale(project_root, &canonical);

        let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;

        let (agent_id, task_id, plan_id) = operation_metadata();
        let record = crate::history::OperationRecord {
            operation_id: operation_id.clone(),
            command: "edit".to_string(),
            operation_type: "replace".to_string(),
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string(),
            project_path: project_root.display().to_string(),
            file_path: Some(canonical.display().to_string()),
            before_hash: Some(before_hash.clone()),
            after_hash: Some(after_hash),
            backup_path: Some(backup_path.display().to_string()),
            diff_path: Some(diff_path.display().to_string()),
            changed: true,
            created_at: chrono::Utc::now().to_rfc3339(),
            agent_id,
            task_id,
            plan_id,
        };

        crate::history::record_operation(&conn, &record).map_err(|e| MtuiError::Internal {
            message: format!("Failed to record operation: {}", e),
        })?;

        Ok(EditResult {
            command: "edit".to_string(),
            operation: "replace".to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: true,
            backup: Some(backup_path.display().to_string()),
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: Some(count),
            line: None,
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    } else {
        Ok(EditResult {
            command: "edit".to_string(),
            operation: "replace".to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: false,
            backup: None,
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: Some(count),
            line: None,
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub fn line_replace(
    project_root: &Path,
    file_path: &Path,
    line_num: usize,
    new_content: &str,
    dry_run: bool,
    expected_hash: Option<&str>,
    accept_stale: Option<&str>,
    config: &crate::config::MtuiConfig,
) -> Result<EditResult, MtuiError> {
    if line_num == 0 {
        return Err(MtuiError::InvalidArgument {
            message: "Line number must be >= 1".to_string(),
            suggestion: "Line numbers are 1-based".to_string(),
        });
    }

    let canonical = crate::safety::validate_path(file_path, project_root, config)?;
    let content_bytes = crate::safety::check_not_binary(&canonical)?;
    let content = String::from_utf8(content_bytes).map_err(|_| MtuiError::EncodingError {
        message: "File is not valid UTF-8".to_string(),
        suggestion: "MTUI only supports UTF-8 files".to_string(),
    })?;

    let lines: Vec<&str> = content.lines().collect();

    if line_num > lines.len() {
        return Err(MtuiError::InvalidArgument {
            message: format!(
                "Line {} not found in {} ({} lines total)",
                line_num,
                file_path.display(),
                lines.len()
            ),
            suggestion: "Check the line number".to_string(),
        });
    }

    let before_hash = fs::compute_hash(content.as_bytes());
    let concurrency = assess_stale_edit(
        project_root,
        &canonical,
        &before_hash,
        expected_hash,
        LineRange {
            start: line_num,
            end: line_num,
        },
        accept_stale,
    )?;
    let newline = crate::fs::detect_newline_style(&content);
    let mut new_lines: Vec<&str> = lines.clone();
    new_lines[line_num - 1] = new_content;
    let new_text = new_lines.join(newline);
    if content.ends_with('\n') {
        let _ = new_text;
    }
    let mut final_text = new_lines.join(newline);
    if content.ends_with('\n') && !final_text.ends_with('\n') {
        final_text.push('\n');
    }

    let after_hash = fs::compute_hash(final_text.as_bytes());
    let diff = crate::diff::generate_diff(&content, &final_text);
    let operation_id = generate_operation_id();

    if !dry_run {
        let backup_path = crate::backup::create_backup(
            project_root,
            &operation_id,
            &canonical,
            content.as_bytes(),
        )
        .map_err(|e| MtuiError::BackupFailed {
            message: format!("{}", e),
            suggestion: "Check disk space".to_string(),
        })?;

        let diff_path =
            crate::diff::save_diff(project_root, &operation_id, &diff.diff).map_err(|e| {
                MtuiError::DiffFailed {
                    message: format!("{}", e),
                    suggestion: "Check disk space".to_string(),
                }
            })?;

        fs::atomic_write(&canonical, final_text.as_bytes()).map_err(|e| {
            MtuiError::WriteFailed {
                message: format!("Failed to write file: {}", e),
                suggestion: "Check disk space and permissions".to_string(),
            }
        })?;
        mark_understand_stale(project_root, &canonical);

        let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;

        let (agent_id, task_id, plan_id) = operation_metadata();
        let record = crate::history::OperationRecord {
            operation_id: operation_id.clone(),
            command: "edit".to_string(),
            operation_type: "line_replace".to_string(),
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string(),
            project_path: project_root.display().to_string(),
            file_path: Some(canonical.display().to_string()),
            before_hash: Some(before_hash.clone()),
            after_hash: Some(after_hash),
            backup_path: Some(backup_path.display().to_string()),
            diff_path: Some(diff_path.display().to_string()),
            changed: true,
            created_at: chrono::Utc::now().to_rfc3339(),
            agent_id,
            task_id,
            plan_id,
        };

        crate::history::record_operation(&conn, &record).map_err(|e| MtuiError::Internal {
            message: format!("Failed to record operation: {}", e),
        })?;

        Ok(EditResult {
            command: "edit".to_string(),
            operation: "line_replace".to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: true,
            backup: Some(backup_path.display().to_string()),
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: None,
            line: Some(line_num),
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    } else {
        Ok(EditResult {
            command: "edit".to_string(),
            operation: "line_replace".to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: false,
            backup: None,
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: None,
            line: Some(line_num),
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub fn insert_after(
    project_root: &Path,
    file_path: &Path,
    marker: &str,
    insert_text: &str,
    insert_all: bool,
    dry_run: bool,
    expected_hash: Option<&str>,
    accept_stale: Option<&str>,
    config: &crate::config::MtuiConfig,
) -> Result<EditResult, MtuiError> {
    insert_at_marker(
        project_root,
        file_path,
        marker,
        insert_text,
        insert_all,
        dry_run,
        expected_hash,
        accept_stale,
        config,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn insert_before(
    project_root: &Path,
    file_path: &Path,
    marker: &str,
    insert_text: &str,
    insert_all: bool,
    dry_run: bool,
    expected_hash: Option<&str>,
    accept_stale: Option<&str>,
    config: &crate::config::MtuiConfig,
) -> Result<EditResult, MtuiError> {
    insert_at_marker(
        project_root,
        file_path,
        marker,
        insert_text,
        insert_all,
        dry_run,
        expected_hash,
        accept_stale,
        config,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn insert_at_marker(
    project_root: &Path,
    file_path: &Path,
    marker: &str,
    insert_text: &str,
    insert_all: bool,
    dry_run: bool,
    expected_hash: Option<&str>,
    accept_stale: Option<&str>,
    config: &crate::config::MtuiConfig,
    before: bool,
) -> Result<EditResult, MtuiError> {
    let canonical = crate::safety::validate_path(file_path, project_root, config)?;
    let content_bytes = crate::safety::check_not_binary(&canonical)?;
    let content = String::from_utf8(content_bytes).map_err(|_| MtuiError::EncodingError {
        message: "File is not valid UTF-8".to_string(),
        suggestion: "MTUI only supports UTF-8 files".to_string(),
    })?;

    let count = content.matches(marker).count();

    if count == 0 {
        return Err(MtuiError::NoMatch {
            message: format!("Marker not found in {}", file_path.display()),
            suggestion: "Check the marker text".to_string(),
        });
    }

    if count > 1 && !insert_all {
        return Err(MtuiError::MultipleMatches {
            message: format!("Found {} marker matches in {}", count, file_path.display()),
            matches: count,
            suggestion: "Use --all or a more specific marker".to_string(),
        });
    }

    let newline = crate::fs::detect_newline_style(&content);
    let before_hash = fs::compute_hash(content.as_bytes());
    let concurrency = assess_stale_edit(
        project_root,
        &canonical,
        &before_hash,
        expected_hash,
        text_range_for_match(&content, marker, insert_all),
        accept_stale,
    )?;

    let new_content = if before {
        content.replace(marker, &format!("{}{}{}", insert_text, newline, marker))
    } else {
        content.replace(marker, &format!("{}{}{}", marker, newline, insert_text))
    };

    let after_hash = fs::compute_hash(new_content.as_bytes());
    let diff = crate::diff::generate_diff(&content, &new_content);
    let operation_id = generate_operation_id();
    let op_name = if before {
        "insert_before"
    } else {
        "insert_after"
    };

    if !dry_run {
        let backup_path = crate::backup::create_backup(
            project_root,
            &operation_id,
            &canonical,
            content.as_bytes(),
        )
        .map_err(|e| MtuiError::BackupFailed {
            message: format!("{}", e),
            suggestion: "Check disk space".to_string(),
        })?;

        let diff_path =
            crate::diff::save_diff(project_root, &operation_id, &diff.diff).map_err(|e| {
                MtuiError::DiffFailed {
                    message: format!("{}", e),
                    suggestion: "Check disk space".to_string(),
                }
            })?;

        fs::atomic_write(&canonical, new_content.as_bytes()).map_err(|e| {
            MtuiError::WriteFailed {
                message: format!("Failed to write file: {}", e),
                suggestion: "Check disk space and permissions".to_string(),
            }
        })?;
        mark_understand_stale(project_root, &canonical);

        let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;

        let (agent_id, task_id, plan_id) = operation_metadata();
        let record = crate::history::OperationRecord {
            operation_id: operation_id.clone(),
            command: "edit".to_string(),
            operation_type: op_name.to_string(),
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string(),
            project_path: project_root.display().to_string(),
            file_path: Some(canonical.display().to_string()),
            before_hash: Some(before_hash.clone()),
            after_hash: Some(after_hash),
            backup_path: Some(backup_path.display().to_string()),
            diff_path: Some(diff_path.display().to_string()),
            changed: true,
            created_at: chrono::Utc::now().to_rfc3339(),
            agent_id,
            task_id,
            plan_id,
        };

        crate::history::record_operation(&conn, &record).map_err(|e| MtuiError::Internal {
            message: format!("Failed to record operation: {}", e),
        })?;

        Ok(EditResult {
            command: "edit".to_string(),
            operation: op_name.to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: true,
            backup: Some(backup_path.display().to_string()),
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: Some(count),
            line: None,
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    } else {
        Ok(EditResult {
            command: "edit".to_string(),
            operation: op_name.to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: false,
            backup: None,
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: Some(count),
            line: None,
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub fn delete_text(
    project_root: &Path,
    file_path: &Path,
    text_to_delete: &str,
    delete_all: bool,
    dry_run: bool,
    expected_hash: Option<&str>,
    accept_stale: Option<&str>,
    config: &crate::config::MtuiConfig,
) -> Result<EditResult, MtuiError> {
    let canonical = crate::safety::validate_path(file_path, project_root, config)?;
    let content_bytes = crate::safety::check_not_binary(&canonical)?;
    let content = String::from_utf8(content_bytes).map_err(|_| MtuiError::EncodingError {
        message: "File is not valid UTF-8".to_string(),
        suggestion: "MTUI only supports UTF-8 files".to_string(),
    })?;

    let count = content.matches(text_to_delete).count();

    if count == 0 {
        return Err(MtuiError::NoMatch {
            message: format!("Text not found in {}", file_path.display()),
            suggestion: format!(
                "Use mtui search \"{}\" \"keyword\" --json",
                file_path.display()
            ),
        });
    }

    if count > 1 && !delete_all {
        return Err(MtuiError::MultipleMatches {
            message: format!("Found {} matches in {}", count, file_path.display()),
            matches: count,
            suggestion: "Use --all or a more specific text".to_string(),
        });
    }

    let before_hash = fs::compute_hash(content.as_bytes());
    let concurrency = assess_stale_edit(
        project_root,
        &canonical,
        &before_hash,
        expected_hash,
        text_range_for_match(&content, text_to_delete, delete_all),
        accept_stale,
    )?;
    let new_content = content.replace(text_to_delete, "");
    let after_hash = fs::compute_hash(new_content.as_bytes());
    let diff = crate::diff::generate_diff(&content, &new_content);
    let operation_id = generate_operation_id();

    if !dry_run {
        let backup_path = crate::backup::create_backup(
            project_root,
            &operation_id,
            &canonical,
            content.as_bytes(),
        )
        .map_err(|e| MtuiError::BackupFailed {
            message: format!("{}", e),
            suggestion: "Check disk space".to_string(),
        })?;

        let diff_path =
            crate::diff::save_diff(project_root, &operation_id, &diff.diff).map_err(|e| {
                MtuiError::DiffFailed {
                    message: format!("{}", e),
                    suggestion: "Check disk space".to_string(),
                }
            })?;

        fs::atomic_write(&canonical, new_content.as_bytes()).map_err(|e| {
            MtuiError::WriteFailed {
                message: format!("Failed to write file: {}", e),
                suggestion: "Check disk space and permissions".to_string(),
            }
        })?;
        mark_understand_stale(project_root, &canonical);

        let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;

        let (agent_id, task_id, plan_id) = operation_metadata();
        let record = crate::history::OperationRecord {
            operation_id: operation_id.clone(),
            command: "edit".to_string(),
            operation_type: "delete".to_string(),
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string(),
            project_path: project_root.display().to_string(),
            file_path: Some(canonical.display().to_string()),
            before_hash: Some(before_hash.clone()),
            after_hash: Some(after_hash),
            backup_path: Some(backup_path.display().to_string()),
            diff_path: Some(diff_path.display().to_string()),
            changed: true,
            created_at: chrono::Utc::now().to_rfc3339(),
            agent_id,
            task_id,
            plan_id,
        };

        crate::history::record_operation(&conn, &record).map_err(|e| MtuiError::Internal {
            message: format!("Failed to record operation: {}", e),
        })?;

        Ok(EditResult {
            command: "edit".to_string(),
            operation: "delete".to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: true,
            backup: Some(backup_path.display().to_string()),
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: Some(count),
            line: None,
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    } else {
        Ok(EditResult {
            command: "edit".to_string(),
            operation: "delete".to_string(),
            operation_id,
            file: canonical.display().to_string(),
            changed: false,
            backup: None,
            diff_summary: crate::diff::diff_summary_string(diff.insertions, diff.deletions),
            matches: Some(count),
            line: None,
            current_hash: before_hash,
            expected_hash: expected_hash.map(|value| value.to_string()),
            concurrency,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReadOptions {
    pub from: Option<usize>,
    pub to: Option<usize>,
    pub max_lines: usize,
    pub max_chars: usize,
    pub all: bool,
    pub line_numbers: bool,
}

#[derive(Debug, Serialize)]
pub struct ReadResult {
    pub command: String,
    pub file: String,
    pub content_hash: String,
    pub line_start: usize,
    pub line_end: usize,
    pub total_lines: usize,
    pub returned_lines: usize,
    pub truncated: bool,
    pub all: bool,
    pub line_numbers: bool,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct CompassReadOptions {
    pub query: Option<String>,
    pub max_lines: usize,
    pub max_chars: usize,
}

#[derive(Debug, Serialize)]
pub struct CompassRange {
    pub start: usize,
    pub end: usize,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct CompassReadResult {
    pub command: String,
    pub file: String,
    pub compressed: bool,
    pub lossy: bool,
    pub truncated: bool,
    pub query: Option<String>,
    pub total_lines: usize,
    pub returned_lines: usize,
    pub omitted_lines: usize,
    pub ranges: Vec<CompassRange>,
    pub next_read_commands: Vec<String>,
    pub text: String,
}

pub fn read_file(
    project_root: &Path,
    file_path: &Path,
    config: &crate::config::MtuiConfig,
    options: ReadOptions,
) -> Result<ReadResult, MtuiError> {
    if options.from == Some(0) || options.to == Some(0) {
        return Err(MtuiError::InvalidArgument {
            message: "Line numbers must be >= 1".to_string(),
            suggestion: "Use 1-based line numbers, for example `--from 1 --to 120`".to_string(),
        });
    }
    if let (Some(from), Some(to)) = (options.from, options.to) {
        if to < from {
            return Err(MtuiError::InvalidArgument {
                message: "`--to` must be greater than or equal to `--from`".to_string(),
                suggestion: "Use an inclusive range such as `--from 10 --to 80`".to_string(),
            });
        }
    }

    let canonical = crate::safety::validate_path(file_path, project_root, config)?;
    let content_bytes = crate::safety::check_not_binary(&canonical)?;
    let content = String::from_utf8(content_bytes).map_err(|_| MtuiError::EncodingError {
        message: "File is not valid UTF-8".to_string(),
        suggestion: "MTUI only supports UTF-8 files".to_string(),
    })?;
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    if total_lines == 0 {
        return Ok(ReadResult {
            command: "read".to_string(),
            file: display_project_path(project_root, &canonical),
            content_hash: fs::compute_hash(content.as_bytes()),
            line_start: 0,
            line_end: 0,
            total_lines,
            returned_lines: 0,
            truncated: false,
            all: options.all,
            line_numbers: options.line_numbers,
            text: String::new(),
        });
    }

    let requested_start = options.from.unwrap_or(1).min(total_lines + 1);
    let requested_end = options.to.unwrap_or(total_lines).min(total_lines);
    let selected: Vec<(usize, &str)> =
        if requested_start > total_lines || requested_start > requested_end {
            Vec::new()
        } else {
            lines
                .iter()
                .enumerate()
                .skip(requested_start - 1)
                .take(requested_end - requested_start + 1)
                .map(|(idx, line)| (idx + 1, *line))
                .collect()
        };

    let mut returned = Vec::new();
    let mut total_chars = 0usize;
    let mut truncated = false;
    for (line_number, line) in selected.iter() {
        if !options.all && returned.len() >= options.max_lines {
            truncated = true;
            break;
        }
        let rendered = if options.line_numbers {
            format!("{}: {}", line_number, line)
        } else {
            (*line).to_string()
        };
        let next_chars = total_chars + rendered.len() + usize::from(!returned.is_empty());
        if !options.all && next_chars > options.max_chars {
            truncated = true;
            break;
        }
        total_chars = next_chars;
        returned.push((*line_number, rendered));
    }

    if !truncated && returned.len() < selected.len() {
        truncated = true;
    }

    let text = returned
        .iter()
        .map(|(_, line)| line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let line_start = returned
        .first()
        .map(|(line, _)| *line)
        .unwrap_or(requested_start);
    let line_end = returned
        .last()
        .map(|(line, _)| *line)
        .unwrap_or(line_start.saturating_sub(1));

    Ok(ReadResult {
        command: "read".to_string(),
        file: display_project_path(project_root, &canonical),
        content_hash: fs::compute_hash(content.as_bytes()),
        line_start,
        line_end,
        total_lines,
        returned_lines: returned.len(),
        truncated,
        all: options.all,
        line_numbers: options.line_numbers,
        text,
    })
}

pub fn compass_read_file(
    project_root: &Path,
    file_path: &Path,
    config: &crate::config::MtuiConfig,
    options: CompassReadOptions,
) -> Result<CompassReadResult, MtuiError> {
    let canonical = crate::safety::validate_path(file_path, project_root, config)?;
    let content_bytes = crate::safety::check_not_binary(&canonical)?;
    let content = String::from_utf8(content_bytes).map_err(|_| MtuiError::EncodingError {
        message: "File is not valid UTF-8".to_string(),
        suggestion: "MTUI only supports UTF-8 files".to_string(),
    })?;
    let lines = content.lines().collect::<Vec<_>>();
    let total_lines = lines.len();
    let query_terms = query_terms(options.query.as_deref().unwrap_or(""));
    let mut keep = std::collections::BTreeMap::<usize, String>::new();
    for (idx, line) in lines.iter().enumerate() {
        let line_no = idx + 1;
        let reason = classify_code_line(line, &query_terms);
        if let Some(reason) = reason {
            let is_query_match = reason == "query_match";
            keep.insert(line_no, reason);
            if is_query_match {
                for ctx in line_no.saturating_sub(2).max(1)..=(line_no + 2).min(total_lines) {
                    keep.entry(ctx)
                        .or_insert_with(|| "query_context".to_string());
                }
            }
        }
    }
    if keep.is_empty() {
        for line_no in 1..=total_lines.min(80) {
            keep.insert(line_no, "head_fallback".to_string());
        }
    }

    let mut rendered = Vec::new();
    let mut ranges = Vec::new();
    let mut current_start = 0usize;
    let mut current_end = 0usize;
    let mut current_reason = String::new();
    let mut last_line = 0usize;
    let mut chars = 0usize;
    let mut truncated = false;
    for (line_no, reason) in keep {
        if rendered.len() >= options.max_lines {
            truncated = true;
            break;
        }
        if last_line > 0 && line_no > last_line + 1 {
            let marker = format!("... lines {}-{} omitted ...", last_line + 1, line_no - 1);
            if chars + marker.len() < options.max_chars {
                rendered.push(marker);
                chars += rendered.last().map(|line| line.len() + 1).unwrap_or(0);
            }
            ranges.push(CompassRange {
                start: current_start,
                end: current_end,
                reason: current_reason.clone(),
            });
            current_start = 0;
        }
        let line_text = format!("{}: {}", line_no, lines[line_no - 1]);
        if chars + line_text.len() + 1 > options.max_chars {
            truncated = true;
            break;
        }
        if current_start == 0 {
            current_start = line_no;
            current_reason = reason.clone();
        }
        current_end = line_no;
        last_line = line_no;
        chars += line_text.len() + 1;
        rendered.push(line_text);
    }
    if current_start > 0 {
        ranges.push(CompassRange {
            start: current_start,
            end: current_end,
            reason: current_reason,
        });
    }
    let returned_lines = rendered
        .iter()
        .filter(|line| !line.starts_with("... lines "))
        .count();
    let rel = display_project_path(project_root, &canonical);
    let next_read_commands = ranges
        .iter()
        .take(8)
        .map(|range| {
            format!(
                "mtui --json read {} --from {} --to {}",
                rel, range.start, range.end
            )
        })
        .collect::<Vec<_>>();

    Ok(CompassReadResult {
        command: "compass".to_string(),
        file: rel,
        compressed: true,
        lossy: true,
        truncated,
        query: options.query,
        total_lines,
        returned_lines,
        omitted_lines: total_lines.saturating_sub(returned_lines),
        ranges,
        next_read_commands,
        text: rendered.join("\n"),
    })
}

fn query_terms(query: &str) -> Vec<String> {
    query
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-')
        .map(|term| term.trim().to_lowercase())
        .filter(|term| term.len() >= 3)
        .collect()
}

fn classify_code_line(line: &str, query_terms: &[String]) -> Option<String> {
    let trimmed = line.trim_start();
    let lower = trimmed.to_lowercase();
    if !query_terms.is_empty() && query_terms.iter().any(|term| lower.contains(term)) {
        return Some("query_match".to_string());
    }
    let structural = [
        "import ",
        "export ",
        "pub ",
        "fn ",
        "function ",
        "const ",
        "let ",
        "type ",
        "interface ",
        "class ",
        "enum ",
        "impl ",
        "#[",
        "def ",
    ];
    if structural.iter().any(|prefix| lower.starts_with(prefix)) {
        return Some("structure".to_string());
    }
    if lower.contains("=>") || lower.contains("useeffect(") || lower.contains("ipc") {
        return Some("behavior".to_string());
    }
    None
}

#[derive(Debug, Clone)]
pub struct VerifyOptions {
    pub mode: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<std::path::PathBuf>,
    pub spec: Option<String>,
    pub all: bool,
    pub profile: Option<String>,
    pub max_lines: usize,
    pub max_chars: usize,
}

#[derive(Debug, Serialize)]
pub struct VerifyResult {
    pub command: String,
    pub mode: String,
    pub program: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    pub cwd: String,
    pub risk_level: RiskLevel,
    pub passed: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    pub history_recorded: bool,
    pub summary: String,
    pub stdout_lines: usize,
    pub stderr_lines: usize,
    pub full_log_id: String,
    pub full_log_path: String,
    pub compacted: bool,
    pub output_lines: usize,
    pub omitted_lines: usize,
    pub important_lines: usize,
    pub output: String,
}

#[derive(Debug, Serialize)]
pub struct MemoryOperationSummary {
    pub id: String,
    pub operation_type: String,
    pub file: Option<String>,
    pub changed: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct MemoryCommandSummary {
    pub command: String,
    pub used_count: i64,
    pub success_count: i64,
    pub last_used: String,
}

#[derive(Debug, Serialize)]
pub struct MemoryCompactResult {
    pub command: String,
    pub mode: String,
    pub limit: usize,
    pub operation_count: usize,
    pub command_count: usize,
    pub task_state: Option<serde_json::Value>,
    pub summary: String,
    pub operations: Vec<MemoryOperationSummary>,
    pub commands: Vec<MemoryCommandSummary>,
}

fn format_command_line(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn record_fallback_command_history(
    project_root: &Path,
    cwd: &Path,
    command_line: &str,
    exit_code: i32,
    duration_ms: u128,
) -> bool {
    if crate::config::ensure_config_dir(project_root).is_err() {
        return false;
    }
    let conn = match crate::history::open_db(project_root) {
        Ok(conn) => conn,
        Err(_) => return false,
    };
    let cwd = cwd.display().to_string();
    crate::history::record_command(
        &conn,
        command_line,
        &cwd,
        &project_root.display().to_string(),
        exit_code,
        duration_ms.min(i64::MAX as u128) as i64,
    )
    .is_ok()
}

pub fn run_verification(
    project_root: &Path,
    options: VerifyOptions,
) -> Result<VerifyResult, MtuiError> {
    if options.program.trim().is_empty() {
        return Err(MtuiError::InvalidArgument {
            message: "Verification program is empty".to_string(),
            suggestion: "Use `mtui verify python <script>` or `mtui verify run <program>`"
                .to_string(),
        });
    }
    if crate::safety::is_direct_write_command(&options.program, &options.args) {
        return Err(MtuiError::CommandBlocked {
            message: format!(
                "Fallback command `{}` looks like a direct file-write bypass",
                format_command_line(&options.program, &options.args)
            ),
            suggestion: "Use `mtui --json new`, `mtui --json edit`, or `mtui --json apply-patch` for file changes"
                .to_string(),
        });
    }

    let started = std::time::Instant::now();
    let command_line = format_command_line(&options.program, &options.args);
    let risk_level = crate::safety::classify_command_risk(&command_line);
    let execution_cwd = options.cwd.as_deref().unwrap_or(project_root);
    let execution_cwd_string = execution_cwd.display().to_string();
    let output_result = std::process::Command::new(&options.program)
        .args(&options.args)
        .current_dir(execution_cwd)
        .output();
    let duration_ms = started.elapsed().as_millis();
    let (exit_code, passed, stdout, stderr) = match output_result {
        Ok(output) => (
            output.status.code(),
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ),
        Err(error) => (
            None,
            false,
            String::new(),
            format!(
                "Failed to start command `{}`: {}\nCheck the executable path and arguments.",
                command_line, error
            ),
        ),
    };
    let history_recorded = record_fallback_command_history(
        project_root,
        execution_cwd,
        &command_line,
        exit_code.unwrap_or(-1),
        duration_ms,
    );
    let stdout_lines = stdout.lines().count();
    let stderr_lines = stderr.lines().count();
    let full_output =
        format_full_verification_log(&options, exit_code, duration_ms, &stdout, &stderr);
    let (full_log_id, full_log_path) =
        save_verification_log(project_root, options.spec.as_deref(), &full_output)?;
    let compact = crate::compact::compact_text(
        &full_output,
        crate::compact::CompactOptions {
            all: options.all,
            profile: options.profile.clone(),
            max_lines: options.max_lines,
            max_chars: options.max_chars,
            saved_id: Some(full_log_id.clone()),
            saved_path: Some(full_log_path.clone()),
        },
    );
    let summary = summarize_verification(
        passed,
        exit_code,
        duration_ms,
        stdout_lines,
        stderr_lines,
        &compact,
    );

    Ok(VerifyResult {
        command: "verify".to_string(),
        mode: options.mode,
        program: options.program,
        args: options.args,
        cwd: execution_cwd_string,
        risk_level,
        passed,
        exit_code,
        duration_ms,
        history_recorded,
        summary,
        stdout_lines,
        stderr_lines,
        full_log_id,
        full_log_path,
        compacted: compact.compacted,
        output_lines: compact.output_lines,
        omitted_lines: compact.omitted_lines,
        important_lines: compact.important_lines,
        output: compact.text,
    })
}

pub fn compact_memory(
    project_root: &Path,
    spec: Option<&str>,
    limit: usize,
) -> Result<MemoryCompactResult, MtuiError> {
    let conn = crate::history::open_db(project_root).map_err(|e| MtuiError::Internal {
        message: format!("Database error: {}", e),
    })?;
    let operations =
        crate::history::list_operations(&conn, limit).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;
    let commands =
        crate::history::list_commands(&conn, limit).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?;
    let operation_summaries = operations
        .iter()
        .map(|operation| MemoryOperationSummary {
            id: operation.operation_id.clone(),
            operation_type: operation.operation_type.clone(),
            file: operation
                .file_path
                .as_ref()
                .map(|path| path.replace('\\', "/")),
            changed: operation.changed,
            created_at: operation.created_at.clone(),
        })
        .collect::<Vec<_>>();
    let command_summaries = commands
        .iter()
        .map(|command| MemoryCommandSummary {
            command: command.command.clone(),
            used_count: command.used_count,
            success_count: command.success_count,
            last_used: command.last_used.clone(),
        })
        .collect::<Vec<_>>();
    let task_state = spec
        .and_then(|value| crate::tasks::query_tasks(project_root, Some(value), "current").ok())
        .map(|tasks| serde_json::to_value(tasks).unwrap_or(serde_json::Value::Null));
    let changed_files = operation_summaries
        .iter()
        .filter(|operation| operation.changed)
        .filter_map(|operation| operation.file.as_deref())
        .take(6)
        .collect::<Vec<_>>();
    let summary = format!(
        "Recent MTUI session: {} operations, {} command history entries. Recent changed files: {}.",
        operation_summaries.len(),
        command_summaries.len(),
        if changed_files.is_empty() {
            "none".to_string()
        } else {
            changed_files.join(", ")
        }
    );

    Ok(MemoryCompactResult {
        command: "memory".to_string(),
        mode: "compact".to_string(),
        limit,
        operation_count: operation_summaries.len(),
        command_count: command_summaries.len(),
        task_state,
        summary,
        operations: operation_summaries,
        commands: command_summaries,
    })
}

fn format_full_verification_log(
    options: &VerifyOptions,
    exit_code: Option<i32>,
    duration_ms: u128,
    stdout: &str,
    stderr: &str,
) -> String {
    [
        format!("$ {} {}", options.program, options.args.join(" ")),
        format!("mode: {}", options.mode),
        format!(
            "exit_code: {}",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "terminated".to_string())
        ),
        format!("duration_ms: {}", duration_ms),
        "---- stdout ----".to_string(),
        stdout.to_string(),
        "---- stderr ----".to_string(),
        stderr.to_string(),
    ]
    .join("\n")
}

fn summarize_verification(
    passed: bool,
    exit_code: Option<i32>,
    duration_ms: u128,
    stdout_lines: usize,
    stderr_lines: usize,
    compact: &crate::compact::CompactResult,
) -> String {
    if passed {
        return format!(
            "Verification passed in {} ms with exit code {}. stdout lines: {}, stderr lines: {}.",
            duration_ms,
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "0".to_string()),
            stdout_lines,
            stderr_lines
        );
    }
    let first_signal = compact
        .text
        .lines()
        .find(|line| {
            let lower = line.to_lowercase();
            lower.contains("error")
                || lower.contains("failed")
                || lower.contains("traceback")
                || lower.contains("assert")
                || lower.contains(".py:")
                || lower.contains(".ts:")
                || lower.contains(".rs:")
        })
        .unwrap_or("No focused error line found in compacted output.");
    format!(
        "Verification failed in {} ms with exit code {}. Focus: {}",
        duration_ms,
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated".to_string()),
        first_signal
    )
}

fn save_verification_log(
    project_root: &Path,
    spec: Option<&str>,
    content: &str,
) -> Result<(String, String), MtuiError> {
    let id = format!(
        "verify_{}_{}",
        chrono::Utc::now().format("%Y%m%d_%H%M%S"),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let dir = if let Some(spec_value) = spec {
        resolve_spec_temporary_dir(project_root, spec_value)
    } else {
        Ok(project_root.join(".mtui").join("verify"))
    }?;
    std::fs::create_dir_all(&dir).map_err(|e| MtuiError::Internal {
        message: format!("Failed to create verification log directory: {}", e),
    })?;
    let path = dir.join(format!("{}.log", id));
    std::fs::write(&path, content).map_err(|e| MtuiError::Internal {
        message: format!("Failed to save verification log: {}", e),
    })?;
    Ok((id, path.display().to_string()))
}

fn resolve_spec_temporary_dir(project_root: &Path, spec: &str) -> Result<PathBuf, MtuiError> {
    let normalized = spec
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let slug = normalized
        .split(".aionui/specs/")
        .last()
        .unwrap_or(&normalized)
        .split('/')
        .next()
        .unwrap_or(&normalized)
        .to_string();
    if slug.is_empty()
        || slug.contains("..")
        || !slug
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(MtuiError::InvalidArgument {
            message: "Invalid spec slug".to_string(),
            suggestion: "Use --spec <slug> or --spec .aionui/specs/<slug>/".to_string(),
        });
    }
    Ok(project_root
        .join(".aionui")
        .join("specs")
        .join(slug)
        .join("plan")
        .join("temporary"))
}

fn display_project_path(project_root: &Path, path: &Path) -> String {
    let canonical_root =
        std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical_path
        .strip_prefix(&canonical_root)
        .or_else(|_| path.strip_prefix(&canonical_root))
        .or_else(|_| canonical_path.strip_prefix(project_root))
        .or_else(|_| path.strip_prefix(project_root))
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| {
            let root = normalize_project_path_string(&canonical_root);
            let full = normalize_project_path_string(&canonical_path);
            let root_lower = root.to_ascii_lowercase();
            let full_lower = full.to_ascii_lowercase();
            let prefix = format!("{root_lower}/");
            if full_lower.starts_with(&prefix) {
                full[root.len() + 1..].to_string()
            } else {
                full
            }
        })
}

fn normalize_project_path_string(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    raw.strip_prefix("//?/")
        .or_else(|| raw.strip_prefix(r"\\?\"))
        .unwrap_or(&raw)
        .trim_end_matches('/')
        .to_string()
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub command: String,
    pub query: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub matches: Vec<SearchMatch>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub counts: Vec<SearchFileCount>,
    pub match_count: usize,
    pub scanned_match_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_match_count: Option<usize>,
    pub file_count: usize,
    pub limit: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub before: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileCount {
    pub file: String,
    pub matching_lines: usize,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub limit: usize,
    pub regex: bool,
    pub ignore_case: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub context: usize,
    pub files_with_matches: bool,
    pub count: bool,
}

fn compile_search_globs(patterns: &[String]) -> Result<Vec<glob::Pattern>, MtuiError> {
    let mut compiled = Vec::new();
    for pattern in patterns {
        for expanded in expand_brace_glob(pattern) {
            compiled.push(glob::Pattern::new(&expanded).map_err(|error| {
                MtuiError::InvalidArgument {
                    message: format!("Invalid glob `{pattern}`: {error}"),
                    suggestion: "Use a valid glob such as `**/*.ts` or `**/*.{ts,tsx}`".to_string(),
                }
            })?);
        }
    }
    Ok(compiled)
}

fn expand_brace_glob(pattern: &str) -> Vec<String> {
    let Some(open) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(relative_close) = pattern[open + 1..].find('}') else {
        return vec![pattern.to_string()];
    };
    let close = open + 1 + relative_close;
    let alternatives = pattern[open + 1..close].split(',').collect::<Vec<_>>();
    if alternatives.len() < 2 || alternatives.iter().any(|item| item.is_empty()) {
        return vec![pattern.to_string()];
    }

    alternatives
        .into_iter()
        .flat_map(|alternative| {
            let expanded = format!(
                "{}{}{}",
                &pattern[..open],
                alternative,
                &pattern[close + 1..]
            );
            expand_brace_glob(&expanded)
        })
        .collect()
}

fn glob_matches(pattern: &glob::Pattern, relative: &str) -> bool {
    pattern.matches(relative)
        || relative
            .rsplit('/')
            .next()
            .map(|name| pattern.matches(name))
            .unwrap_or(false)
}

fn search_path_allowed(
    project_root: &Path,
    path: &Path,
    includes: &[glob::Pattern],
    excludes: &[glob::Pattern],
) -> bool {
    let relative = display_project_path(project_root, path).replace('\\', "/");
    (includes.is_empty()
        || includes
            .iter()
            .any(|pattern| glob_matches(pattern, &relative)))
        && !excludes
            .iter()
            .any(|pattern| glob_matches(pattern, &relative))
}

fn search_regex(query: &str, options: &SearchOptions) -> Result<regex::Regex, MtuiError> {
    let expression = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    regex::RegexBuilder::new(&expression)
        .case_insensitive(options.ignore_case)
        .build()
        .map_err(|error| MtuiError::InvalidArgument {
            message: format!("Invalid search expression: {error}"),
            suggestion: "Fix the regular expression or omit --regex for literal search".to_string(),
        })
}

fn search_one_file(
    project_root: &Path,
    path: &Path,
    matcher: &regex::Regex,
    options: &SearchOptions,
) -> Result<(Vec<SearchMatch>, usize), MtuiError> {
    let content = crate::safety::check_not_binary(path)?;
    let text = String::from_utf8(content).map_err(|_| MtuiError::EncodingError {
        message: format!("File is not valid UTF-8: {}", path.display()),
        suggestion: "MTUI only searches UTF-8 text files".to_string(),
    })?;
    let lines = text.lines().collect::<Vec<_>>();
    let display_path = display_project_path(project_root, path);
    let mut matches = Vec::new();
    let mut matching_lines = 0usize;

    for (line_idx, line) in lines.iter().enumerate() {
        let Some(found) = matcher.find(line) else {
            continue;
        };
        matching_lines += 1;
        if options.count || options.files_with_matches || matches.len() >= options.limit.max(1) {
            continue;
        }
        let context_start = line_idx.saturating_sub(options.context);
        let context_end = (line_idx + options.context + 1).min(lines.len());
        matches.push(SearchMatch {
            file: display_path.clone(),
            line: line_idx + 1,
            column: line[..found.start()].chars().count() + 1,
            preview: search_preview(line, found.start(), found.end() - found.start()),
            before: lines[context_start..line_idx]
                .iter()
                .map(|line| (*line).to_string())
                .collect(),
            after: lines[line_idx + 1..context_end]
                .iter()
                .map(|line| (*line).to_string())
                .collect(),
        });
    }
    Ok((matches, matching_lines))
}

#[allow(dead_code)]
pub fn search(
    project_root: &Path,
    path: &Path,
    query: &str,
    limit: usize,
    config: &crate::config::MtuiConfig,
) -> Result<SearchResult, MtuiError> {
    search_with_options(
        project_root,
        path,
        query,
        SearchOptions {
            limit,
            ..SearchOptions::default()
        },
        config,
    )
}

pub fn search_with_options(
    project_root: &Path,
    path: &Path,
    query: &str,
    options: SearchOptions,
    _config: &crate::config::MtuiConfig,
) -> Result<SearchResult, MtuiError> {
    let search_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    };

    if !search_path.exists() {
        return Err(MtuiError::FileNotFound {
            message: format!("Path not found: {}", path.display()),
            suggestion: "Check the path and try again".to_string(),
        });
    }

    let limit = options.limit.max(1);
    let matcher = search_regex(query, &options)?;
    let includes = compile_search_globs(&options.include_globs)?;
    let excludes = compile_search_globs(&options.exclude_globs)?;
    let mut matches = Vec::new();
    let mut files = Vec::new();
    let mut counts = Vec::new();
    let mut total_match_count = 0usize;
    let mut truncated = false;

    let candidate_paths = if search_path.is_file() {
        vec![search_path.clone()]
    } else {
        walkdir::WalkDir::new(&search_path)
            .into_iter()
            .filter_entry(|entry| {
                !entry.file_type().is_dir() || !should_skip_search_dir(entry.path())
            })
            .filter_map(|e| e.ok())
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.path().to_path_buf())
            .collect::<Vec<_>>()
    };

    for entry_path in candidate_paths {
        if should_skip_search_file(&entry_path)
            || !search_path_allowed(project_root, &entry_path, &includes, &excludes)
        {
            continue;
        }
        let Ok((file_matches, matching_lines)) =
            search_one_file(project_root, &entry_path, &matcher, &options)
        else {
            continue;
        };
        if matching_lines == 0 {
            continue;
        }
        total_match_count += matching_lines;
        let display_path = display_project_path(project_root, &entry_path);
        if options.files_with_matches {
            if files.len() >= limit {
                truncated = true;
                break;
            }
            files.push(display_path);
        } else if options.count {
            if counts.len() >= limit {
                truncated = true;
                break;
            }
            counts.push(SearchFileCount {
                file: display_path,
                matching_lines,
            });
        } else {
            let remaining = limit.saturating_sub(matches.len());
            if matching_lines > file_matches.len()
                || file_matches.len() > remaining
                || (remaining == 0 && matching_lines > 0)
            {
                truncated = true;
            }
            matches.extend(file_matches.into_iter().take(remaining));
            if matches.len() >= limit {
                truncated = true;
                break;
            }
        }
    }

    let file_count = if options.files_with_matches {
        files.len()
    } else if options.count {
        counts.len()
    } else {
        matches
            .iter()
            .map(|item| item.file.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    };
    let returned_match_count = if options.files_with_matches || options.count {
        total_match_count
    } else {
        matches.len()
    };
    Ok(SearchResult {
        command: "search".to_string(),
        query: query.to_string(),
        matches,
        files,
        counts,
        match_count: returned_match_count,
        scanned_match_count: total_match_count,
        total_match_count: (!truncated).then_some(total_match_count),
        file_count,
        limit,
        truncated,
    })
}

fn search_preview(line: &str, match_start: usize, query_len: usize) -> String {
    if line.len() <= 200 {
        return line.to_string();
    }

    let mut start = match_start.saturating_sub(20);
    while start > 0 && !line.is_char_boundary(start) {
        start -= 1;
    }

    let mut end = (match_start + query_len + 50).min(line.len());
    while end > start && !line.is_char_boundary(end) {
        end -= 1;
    }

    line[start..end].to_string()
}

fn should_skip_search_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            matches!(
                name,
                ".git"
                    | ".mtui"
                    | ".aionui"
                    | ".cache"
                    | ".next"
                    | ".turbo"
                    | ".vite"
                    | "coverage"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | "out"
            )
        })
        .unwrap_or(false)
}

fn should_skip_search_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() > SEARCH_MAX_FILE_BYTES)
        .unwrap_or(false)
}

#[derive(Debug, Serialize)]
pub struct HistoryResult {
    pub command: String,
    pub operations: Vec<crate::history::OperationRecord>,
}

#[derive(Debug, Serialize)]
pub struct CommandHistoryResult {
    pub command: String,
    pub history_type: String,
    pub items: Vec<crate::history::CommandRecord>,
}

#[derive(Debug, Serialize)]
pub struct DiffResult {
    pub command: String,
    pub operation_id: Option<String>,
    pub files: Vec<DiffFileEntry>,
    pub diff_summary: String,
}

#[derive(Debug, Serialize)]
pub struct DiffFileEntry {
    pub file: String,
    pub insertions: usize,
    pub deletions: usize,
    pub diff: String,
}

pub fn get_diff(
    conn: &rusqlite::Connection,
    _project_root: &Path,
    operation_id: Option<&str>,
) -> Result<DiffResult, MtuiError> {
    let operation = match operation_id {
        Some(id) => crate::history::get_operation(conn, id).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?,
        None => crate::history::get_last_operation(conn).map_err(|e| MtuiError::Internal {
            message: format!("Database error: {}", e),
        })?,
    };

    let operation = operation.ok_or_else(|| MtuiError::NoMatch {
        message: "No operation found".to_string(),
        suggestion: "Perform a file operation first".to_string(),
    })?;

    let diff_text = match &operation.diff_path {
        Some(path) => {
            let diff_path = std::path::Path::new(path);
            if diff_path.exists() {
                std::fs::read_to_string(diff_path).unwrap_or_default()
            } else {
                "No diff file found".to_string()
            }
        }
        None => "No diff available".to_string(),
    };

    let files = vec![DiffFileEntry {
        file: operation.file_path.clone().unwrap_or_default(),
        insertions: 0,
        deletions: 0,
        diff: diff_text,
    }];

    Ok(DiffResult {
        command: "diff".to_string(),
        operation_id: Some(operation.operation_id),
        files,
        diff_summary: String::new(),
    })
}

fn generate_operation_id() -> String {
    let now = chrono::Local::now();
    let short_uuid = &uuid::Uuid::new_v4().to_string()[..8];
    format!("op_{}_{}", now.format("%Y%m%d_%H%M%S"), short_uuid)
}

#[cfg(test)]
mod tests {
    use super::{
        compass_read_file, read_file, run_verification, CompassReadOptions, ReadOptions,
        VerifyOptions,
    };

    #[test]
    fn read_file_returns_a_bounded_line_numbered_slice() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("sample.txt");
        std::fs::write(&path, "one\ntwo\nthree\nfour\n").expect("write sample");

        let result = read_file(
            temp.path(),
            std::path::Path::new("sample.txt"),
            &crate::config::MtuiConfig::default(),
            ReadOptions {
                from: Some(2),
                to: Some(4),
                max_lines: 2,
                max_chars: 20000,
                all: false,
                line_numbers: true,
            },
        )
        .expect("read file");

        assert_eq!(result.line_start, 2);
        assert_eq!(result.line_end, 3);
        assert_eq!(result.returned_lines, 2);
        assert!(result.truncated);
        assert_eq!(result.text, "2: two\n3: three");
    }

    #[test]
    fn read_file_all_ignores_limits() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("sample.txt");
        std::fs::write(&path, "one\ntwo\nthree\n").expect("write sample");

        let result = read_file(
            temp.path(),
            std::path::Path::new("sample.txt"),
            &crate::config::MtuiConfig::default(),
            ReadOptions {
                from: None,
                to: None,
                max_lines: 1,
                max_chars: 3,
                all: true,
                line_numbers: false,
            },
        )
        .expect("read file");

        assert_eq!(result.returned_lines, 3);
        assert!(!result.truncated);
        assert_eq!(result.text, "one\ntwo\nthree");
    }

    #[test]
    fn read_file_rejects_invalid_ranges() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("sample.txt");
        std::fs::write(&path, "one\n").expect("write sample");

        let result = read_file(
            temp.path(),
            std::path::Path::new("sample.txt"),
            &crate::config::MtuiConfig::default(),
            ReadOptions {
                from: Some(3),
                to: Some(2),
                max_lines: 160,
                max_chars: 20000,
                all: false,
                line_numbers: true,
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn compass_read_keeps_structure_and_query_matches() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("sample.ts");
        std::fs::write(
            &path,
            [
                "import { x } from './x';",
                "const unrelated = 1;",
                "function buildPlanningGuard() {",
                "  return 'execute planning';",
                "}",
                "const tail = 2;",
            ]
            .join("\n"),
        )
        .expect("write sample");

        let result = compass_read_file(
            temp.path(),
            std::path::Path::new("sample.ts"),
            &crate::config::MtuiConfig::default(),
            CompassReadOptions {
                query: Some("planning execute".to_string()),
                max_lines: 20,
                max_chars: 4000,
            },
        )
        .expect("compass read");

        assert!(result.lossy);
        assert!(result.text.contains("import"));
        assert!(result.text.contains("execute planning"));
        assert!(!result.next_read_commands.is_empty());
    }

    #[test]
    fn compass_read_query_match_on_first_line_never_uses_line_zero() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("sample.ts");
        std::fs::write(
            &path,
            "export const firstLine = true;\nconst second = true;\n",
        )
        .expect("write sample");

        let result = compass_read_file(
            temp.path(),
            std::path::Path::new("sample.ts"),
            &crate::config::MtuiConfig::default(),
            CompassReadOptions {
                query: Some("firstLine".to_string()),
                max_lines: 20,
                max_chars: 4000,
            },
        )
        .expect("compass read");

        assert!(result.ranges.iter().all(|range| range.start >= 1));
        assert!(result.text.contains("1: export const firstLine"));
    }

    #[test]
    fn run_verification_returns_pass_result_and_log() {
        let temp = tempfile::tempdir().expect("tempdir");
        let program = std::env::current_exe().expect("current exe");

        let result = run_verification(
            temp.path(),
            VerifyOptions {
                mode: "run".to_string(),
                program: program.display().to_string(),
                args: vec!["--help".to_string()],
                cwd: None,
                spec: None,
                all: false,
                profile: None,
                max_lines: 80,
                max_chars: 12000,
            },
        )
        .expect("verification");

        assert!(result.passed);
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.risk_level, crate::safety::RiskLevel::Unknown);
        assert!(result.history_recorded);
        assert!(std::path::Path::new(&result.full_log_path).exists());
        assert!(result.summary.contains("Verification passed"));
    }

    #[test]
    fn run_verification_uses_requested_working_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let nested = temp.path().join("nested");
        std::fs::create_dir_all(&nested).expect("create nested");

        #[cfg(windows)]
        let (program, args) = ("cmd".to_string(), vec!["/C".to_string(), "cd".to_string()]);
        #[cfg(not(windows))]
        let (program, args) = ("pwd".to_string(), Vec::new());

        let result = run_verification(
            temp.path(),
            VerifyOptions {
                mode: "run".to_string(),
                program,
                args,
                cwd: Some(nested.clone()),
                spec: None,
                all: false,
                profile: None,
                max_lines: 80,
                max_chars: 12000,
            },
        )
        .expect("verification");

        assert!(result.passed);
        assert_eq!(result.cwd, nested.display().to_string());
        let log = std::fs::read_to_string(&result.full_log_path).expect("verification log");
        assert!(log
            .to_lowercase()
            .contains(&nested.display().to_string().to_lowercase()));
    }

    #[test]
    fn run_verification_returns_focused_fail_result() {
        let temp = tempfile::tempdir().expect("tempdir");
        let program = std::env::current_exe().expect("current exe");

        let result = run_verification(
            temp.path(),
            VerifyOptions {
                mode: "run".to_string(),
                program: program.display().to_string(),
                args: vec!["--definitely-invalid-mtui-test-flag".to_string()],
                cwd: None,
                spec: None,
                all: false,
                profile: None,
                max_lines: 80,
                max_chars: 12000,
            },
        )
        .expect("verification");

        assert!(!result.passed);
        assert!(result.history_recorded);
        assert!(std::path::Path::new(&result.full_log_path).exists());
        assert!(result.summary.contains("Verification failed"));
    }

    #[test]
    fn run_verification_returns_json_result_for_missing_program() {
        let temp = tempfile::tempdir().expect("tempdir");

        let result = run_verification(
            temp.path(),
            VerifyOptions {
                mode: "fallback".to_string(),
                program: "definitely-missing-mtui-program".to_string(),
                args: vec![],
                cwd: None,
                spec: None,
                all: false,
                profile: None,
                max_lines: 80,
                max_chars: 12000,
            },
        )
        .expect("fallback result");

        assert!(!result.passed);
        assert_eq!(result.exit_code, None);
        assert!(result.history_recorded);
        assert!(result.summary.contains("Verification failed"));
        assert!(result.output.contains("Failed to start command"));
    }

    #[test]
    fn run_verification_blocks_direct_write_bypass() {
        let temp = tempfile::tempdir().expect("tempdir");

        let result = run_verification(
            temp.path(),
            VerifyOptions {
                mode: "fallback".to_string(),
                program: "Set-Content".to_string(),
                args: vec!["src/a.ts".to_string(), "x".to_string()],
                cwd: None,
                spec: None,
                all: false,
                profile: None,
                max_lines: 80,
                max_chars: 12000,
            },
        );

        assert!(matches!(
            result,
            Err(crate::error::MtuiError::CommandBlocked { .. })
        ));
    }
}
