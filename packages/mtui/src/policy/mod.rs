use crate::error::MtuiError;
use crate::history::OperationRecord;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PolicyViolation {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct PolicyStatusResult {
    pub command: String,
    pub strict: bool,
    pub clean: bool,
    pub changed_count: usize,
    pub baseline_count: usize,
    pub session_baseline_count: usize,
    pub auto_session_created: bool,
    pub session: Option<PolicySessionSummary>,
    pub mtui_operation_count: usize,
    pub violation_count: usize,
    pub violations_truncated: bool,
    pub violations: Vec<PolicyViolation>,
}

#[derive(Debug, Serialize)]
pub struct PolicyBaselineResult {
    pub command: String,
    pub baseline_file: String,
    pub baseline_count: usize,
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PolicySessionResult {
    pub command: String,
    pub session_file: String,
    pub session_baseline_count: usize,
    pub owner: String,
    pub note: Option<String>,
    pub truncated: bool,
    pub sample_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct PolicySessionClearResult {
    pub command: String,
    pub session_file: String,
    pub cleared: bool,
}

#[derive(Debug, Clone)]
pub struct PolicyAutoSession {
    pub owner: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PolicySessionSummary {
    pub owner: String,
    pub created_at: String,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PolicyBaselineFile {
    version: u8,
    created_at: String,
    paths: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PolicySessionFile {
    version: u8,
    created_at: String,
    owner: String,
    note: Option<String>,
    paths: Vec<String>,
}

const IGNORED_POLICY_PATHS: &[&str] = &[
    ".git/",
    ".mtui/",
    ".aionui/understand/",
    "node_modules/",
    "dist/",
    "build/",
    "target/",
    "coverage/",
];

fn normalize_rel(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_matches('"')
        .to_string()
}

fn is_ignored_policy_path(path: &str) -> bool {
    let normalized = normalize_rel(path);
    if normalized.starts_with(".aionui/specs/") && normalized.contains("/plan/temporary/") {
        return true;
    }
    if normalized.starts_with(".kiro/tmp-") {
        return true;
    }
    IGNORED_POLICY_PATHS
        .iter()
        .any(|prefix| normalized == prefix.trim_end_matches('/') || normalized.starts_with(prefix))
}

fn rel_from_operation(project_root: &Path, operation: &OperationRecord) -> Option<String> {
    if !operation.changed {
        return None;
    }
    let file_path = operation.file_path.as_ref()?;
    let path = PathBuf::from(file_path);
    let rel = path.strip_prefix(project_root).unwrap_or(&path);
    Some(normalize_rel(&rel.to_string_lossy()))
}

fn parse_git_status_line(line: &str) -> Option<String> {
    if line.len() < 4 {
        return None;
    }
    let path = line.get(3..)?.trim();
    if path.is_empty() {
        return None;
    }
    let final_path = path.split(" -> ").last().unwrap_or(path);
    Some(normalize_rel(final_path))
}

pub fn git_changed_paths(project_root: &Path) -> Result<Vec<String>, MtuiError> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(project_root)
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-uall")
        .output()
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to run git status: {}", e),
        })?;
    if !output.status.success() {
        return Err(MtuiError::Internal {
            message: "Failed to inspect git status for MTUI policy".to_string(),
        });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().filter_map(parse_git_status_line).collect())
}

fn baseline_path(project_root: &Path) -> PathBuf {
    project_root.join(".mtui").join("policy-baseline.json")
}

fn session_baseline_path(project_root: &Path) -> PathBuf {
    project_root
        .join(".mtui")
        .join("policy-session-baseline.json")
}

fn load_baseline(project_root: &Path) -> Result<HashSet<String>, MtuiError> {
    let path = baseline_path(project_root);
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| MtuiError::Internal {
        message: format!("Failed to read MTUI policy baseline: {}", e),
    })?;
    let baseline: PolicyBaselineFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to parse MTUI policy baseline: {}", e),
        })?;
    Ok(baseline
        .paths
        .into_iter()
        .map(|path| normalize_rel(&path))
        .collect())
}

fn load_session_baseline(project_root: &Path) -> Result<Option<PolicySessionFile>, MtuiError> {
    let path = session_baseline_path(project_root);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| MtuiError::Internal {
        message: format!("Failed to read MTUI policy session baseline: {}", e),
    })?;
    let parsed: PolicySessionFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to parse MTUI policy session baseline: {}", e),
        })?;
    Ok(Some(parsed))
}

pub fn write_policy_baseline(project_root: &Path) -> Result<PolicyBaselineResult, MtuiError> {
    let mut paths = git_changed_paths(project_root)?
        .into_iter()
        .map(|path| normalize_rel(&path))
        .filter(|path| !path.is_empty() && !is_ignored_policy_path(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    let target = baseline_path(project_root);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MtuiError::Internal {
            message: format!("Failed to create MTUI config directory: {}", e),
        })?;
    }
    let baseline = PolicyBaselineFile {
        version: 1,
        created_at: chrono::Utc::now().to_rfc3339(),
        paths: paths.clone(),
    };
    let text = serde_json::to_string_pretty(&baseline).map_err(|e| MtuiError::Internal {
        message: format!("Failed to serialize MTUI policy baseline: {}", e),
    })?;
    std::fs::write(&target, text).map_err(|e| MtuiError::Internal {
        message: format!("Failed to write MTUI policy baseline: {}", e),
    })?;
    Ok(PolicyBaselineResult {
        command: "policy".to_string(),
        baseline_file: target.display().to_string(),
        baseline_count: paths.len(),
        paths,
    })
}

pub fn write_policy_session_baseline(
    project_root: &Path,
    owner: &str,
    note: Option<String>,
    include_paths: bool,
) -> Result<PolicySessionResult, MtuiError> {
    let mut paths = git_changed_paths(project_root)?
        .into_iter()
        .map(|path| normalize_rel(&path))
        .filter(|path| !path.is_empty() && !is_ignored_policy_path(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();

    let owner = owner.trim();
    let owner = if owner.is_empty() { "agent" } else { owner };
    let target = session_baseline_path(project_root);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MtuiError::Internal {
            message: format!("Failed to create MTUI config directory: {}", e),
        })?;
    }
    let file = PolicySessionFile {
        version: 1,
        created_at: chrono::Utc::now().to_rfc3339(),
        owner: owner.to_string(),
        note: note.clone(),
        paths: paths.clone(),
    };
    let text = serde_json::to_string_pretty(&file).map_err(|e| MtuiError::Internal {
        message: format!("Failed to serialize MTUI policy session baseline: {}", e),
    })?;
    std::fs::write(&target, text).map_err(|e| MtuiError::Internal {
        message: format!("Failed to write MTUI policy session baseline: {}", e),
    })?;
    Ok(PolicySessionResult {
        command: "policy".to_string(),
        session_file: target.display().to_string(),
        session_baseline_count: paths.len(),
        owner: owner.to_string(),
        note,
        truncated: !include_paths && paths.len() > 12,
        sample_paths: paths.iter().take(12).cloned().collect(),
        paths: include_paths.then_some(paths),
    })
}

pub fn clear_policy_session_baseline(
    project_root: &Path,
) -> Result<PolicySessionClearResult, MtuiError> {
    let target = session_baseline_path(project_root);
    let cleared = if target.exists() {
        std::fs::remove_file(&target).map_err(|e| MtuiError::Internal {
            message: format!("Failed to clear MTUI policy session baseline: {}", e),
        })?;
        true
    } else {
        false
    };
    Ok(PolicySessionClearResult {
        command: "policy".to_string(),
        session_file: target.display().to_string(),
        cleared,
    })
}

pub fn detect_policy_violations(
    project_root: &Path,
    changed_paths: &[String],
    operations: &[OperationRecord],
    baseline_paths: &HashSet<String>,
) -> Vec<PolicyViolation> {
    let mtui_files = operations
        .iter()
        .filter_map(|operation| rel_from_operation(project_root, operation))
        .collect::<HashSet<_>>();

    changed_paths
        .iter()
        .map(|path| normalize_rel(path))
        .filter(|path| !path.is_empty() && !is_ignored_policy_path(path))
        .filter(|path| !baseline_paths.contains(path))
        .filter(|path| !mtui_files.contains(path))
        .map(|path| PolicyViolation {
            path,
            reason: "Changed file has no recent MTUI write operation.".to_string(),
        })
        .collect()
}

pub fn policy_status(
    project_root: &Path,
    operations: &[OperationRecord],
) -> Result<PolicyStatusResult, MtuiError> {
    policy_status_with_auto_session(project_root, operations, None)
}

pub fn policy_status_with_auto_session(
    project_root: &Path,
    operations: &[OperationRecord],
    auto_session: Option<PolicyAutoSession>,
) -> Result<PolicyStatusResult, MtuiError> {
    let changed_paths = git_changed_paths(project_root)?;
    let baseline_paths = load_baseline(project_root)?;
    let mut auto_session_created = false;
    let mut session_file = load_session_baseline(project_root)?;
    if session_file.is_none() {
        if let Some(auto_session) = auto_session {
            write_policy_session_baseline(
                project_root,
                &auto_session.owner,
                auto_session.note,
                false,
            )?;
            session_file = load_session_baseline(project_root)?;
            auto_session_created = session_file.is_some();
        }
    }
    let session_paths = session_file
        .as_ref()
        .map(|file| {
            file.paths
                .iter()
                .map(|path| normalize_rel(path))
                .filter(|path| !path.is_empty())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let combined_baseline = baseline_paths
        .union(&session_paths)
        .cloned()
        .collect::<HashSet<_>>();
    let violations =
        detect_policy_violations(project_root, &changed_paths, operations, &combined_baseline);
    let violation_count = violations.len();
    Ok(PolicyStatusResult {
        command: "policy".to_string(),
        strict: true,
        clean: violations.is_empty(),
        changed_count: changed_paths.len(),
        baseline_count: baseline_paths.len(),
        session_baseline_count: session_paths.len(),
        auto_session_created,
        session: session_file.map(|file| PolicySessionSummary {
            owner: file.owner,
            created_at: file.created_at,
            note: file.note,
        }),
        mtui_operation_count: operations.len(),
        violation_count,
        violations_truncated: false,
        violations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn op(file_path: &str) -> OperationRecord {
        OperationRecord {
            operation_id: "op".to_string(),
            command: "new".to_string(),
            operation_type: "new".to_string(),
            cwd: "/repo".to_string(),
            project_path: "/repo".to_string(),
            file_path: Some(file_path.to_string()),
            before_hash: None,
            after_hash: None,
            backup_path: None,
            diff_path: None,
            changed: true,
            created_at: "2026-06-04T00:00:00Z".to_string(),
            agent_id: None,
            task_id: None,
            plan_id: None,
        }
    }

    #[test]
    fn detects_changed_files_without_recent_mtui_operations() {
        let violations = detect_policy_violations(
            Path::new("/repo"),
            &[
                "src/a.ts".to_string(),
                "src/b.ts".to_string(),
                ".aionui/understand/summary.json".to_string(),
                ".kiro/tmp-ox.txt".to_string(),
            ],
            &[op("/repo/src/a.ts")],
            &HashSet::new(),
        );

        assert_eq!(
            violations,
            vec![PolicyViolation {
                path: "src/b.ts".to_string(),
                reason: "Changed file has no recent MTUI write operation.".to_string(),
            }]
        );
    }

    #[test]
    fn ignores_baselined_changed_files() {
        let violations = detect_policy_violations(
            Path::new("/repo"),
            &["src/a.ts".to_string(), "src/b.ts".to_string()],
            &[],
            &HashSet::from(["src/a.ts".to_string()]),
        );

        assert_eq!(
            violations,
            vec![PolicyViolation {
                path: "src/b.ts".to_string(),
                reason: "Changed file has no recent MTUI write operation.".to_string(),
            }]
        );
    }

    #[test]
    fn session_baseline_suppresses_only_current_dirty_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .expect("git init");
        std::fs::create_dir_all(root.join("src")).expect("create src");
        std::fs::write(root.join("src").join("preexisting.ts"), "pre").expect("write preexisting");

        let session = write_policy_session_baseline(
            root,
            "test-agent",
            Some("dirty before task".to_string()),
            false,
        )
        .expect("write session baseline");
        assert_eq!(session.session_baseline_count, 1);
        assert_eq!(session.sample_paths, vec!["src/preexisting.ts".to_string()]);
        assert!(session.paths.is_none());

        let status = policy_status(root, &[]).expect("policy status");
        assert!(status.clean);
        assert_eq!(status.session_baseline_count, 1);
        assert_eq!(
            status.session.expect("session").owner,
            "test-agent".to_string()
        );

        std::fs::write(root.join("src").join("new-change.ts"), "new").expect("write new change");
        let status = policy_status(root, &[]).expect("policy status");
        assert!(!status.clean);
        assert_eq!(
            status.violations,
            vec![PolicyViolation {
                path: "src/new-change.ts".to_string(),
                reason: "Changed file has no recent MTUI write operation.".to_string(),
            }]
        );

        let cleared = clear_policy_session_baseline(root).expect("clear session baseline");
        assert!(cleared.cleared);
    }

    #[test]
    fn auto_session_status_accepts_preexisting_dirty_files_once() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .expect("git init");
        std::fs::create_dir_all(root.join("src")).expect("create src");
        std::fs::write(root.join("src").join("preexisting.ts"), "pre").expect("write preexisting");

        let status = policy_status_with_auto_session(
            root,
            &[],
            Some(PolicyAutoSession {
                owner: "app".to_string(),
                note: Some("auto baseline".to_string()),
            }),
        )
        .expect("policy status");
        assert!(status.clean);
        assert!(status.auto_session_created);
        assert_eq!(status.session_baseline_count, 1);
        assert_eq!(status.session.expect("session").owner, "app".to_string());

        std::fs::write(root.join("src").join("new-change.ts"), "new").expect("write new change");
        let status = policy_status_with_auto_session(
            root,
            &[],
            Some(PolicyAutoSession {
                owner: "app".to_string(),
                note: Some("auto baseline".to_string()),
            }),
        )
        .expect("policy status");
        assert!(!status.auto_session_created);
        assert_eq!(
            status.violations,
            vec![PolicyViolation {
                path: "src/new-change.ts".to_string(),
                reason: "Changed file has no recent MTUI write operation.".to_string(),
            }]
        );
    }
}
