use crate::error::MtuiError;
use std::path::{Path, PathBuf};

pub fn validate_path_for_new(
    file_path: &Path,
    project_root: &Path,
    config: &crate::config::MtuiConfig,
) -> Result<std::path::PathBuf, MtuiError> {
    let resolved = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        project_root.join(file_path)
    };

    if let Some(parent) = resolved.parent() {
        if !config.allow_outside_project {
            let canonical_root =
                std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
            if parent.starts_with(&canonical_root)
                || std::fs::canonicalize(parent)
                    .map(|p| p.starts_with(&canonical_root))
                    .unwrap_or(false)
            {
                // OK
            } else {
                return Err(MtuiError::PathOutsideProject {
                    message: format!("Path is outside project root: {}", file_path.display()),
                    suggestion: "Use allow_outside_project in config to bypass".to_string(),
                });
            }
        }
    }

    Ok(resolved)
}

pub fn validate_path(
    file_path: &Path,
    project_root: &Path,
    config: &crate::config::MtuiConfig,
) -> Result<PathBuf, MtuiError> {
    let resolved = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        project_root.join(file_path)
    };

    let canonical = std::fs::canonicalize(&resolved).map_err(|_| MtuiError::FileNotFound {
        message: format!("File not found: {}", file_path.display()),
        suggestion: "Check the path and try again".to_string(),
    })?;

    if !config.allow_outside_project {
        let canonical_root =
            std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());

        if !canonical.starts_with(&canonical_root) {
            return Err(MtuiError::PathOutsideProject {
                message: format!("Path is outside project root: {}", file_path.display()),
                suggestion: "Use allow_outside_project in config to bypass".to_string(),
            });
        }
    }

    let relative = match canonical.strip_prefix(project_root) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => canonical.to_string_lossy().to_string(),
    };

    for pattern in &config.ignore.patterns {
        let glob = match glob::Pattern::new(pattern) {
            Ok(g) => g,
            Err(_) => continue,
        };
        if glob.matches(&relative) {
            return Err(MtuiError::PathIgnored {
                message: format!("Path is ignored: {}", file_path.display()),
                suggestion: "This path matches an ignore pattern".to_string(),
            });
        }
    }

    Ok(canonical)
}

pub fn is_binary(content: &[u8]) -> bool {
    let slice = if content.len() > 8192 {
        &content[..8192]
    } else {
        content
    };
    slice.contains(&0)
}

pub fn check_not_binary(file_path: &Path) -> Result<Vec<u8>, MtuiError> {
    let content = std::fs::read(file_path).map_err(|e| MtuiError::PermissionDenied {
        message: format!("Cannot read {}: {}", file_path.display(), e),
        suggestion: "Check file permissions".to_string(),
    })?;

    if is_binary(&content) {
        return Err(MtuiError::BinaryFile {
            message: format!("Binary file detected: {}", file_path.display()),
            suggestion: "MTUI only edits text files".to_string(),
        });
    }

    Ok(content)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    ReadOnly,
    ProjectWrite,
    ExternalNetwork,
    Destructive,
    Privileged,
    Unknown,
}

pub fn classify_command_risk(cmd: &str) -> RiskLevel {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    let bin = parts.first().copied().unwrap_or("");

    match bin {
        "rm" | "rmdir" | "del" => RiskLevel::Destructive,
        "sudo" | "su" => RiskLevel::Privileged,
        "curl" | "wget" => RiskLevel::ExternalNetwork,
        "cat" | "ls" | "echo" | "pwd" | "which" | "head" | "tail" | "type" => RiskLevel::ReadOnly,
        "git" if contains_force_flag(&parts) => RiskLevel::Destructive,
        "git" | "cargo" | "npm" | "bun" | "yarn" | "pnpm" | "go" | "rustc" => {
            RiskLevel::ProjectWrite
        }
        _ => RiskLevel::Unknown,
    }
}

pub fn is_direct_write_command(program: &str, args: &[String]) -> bool {
    let command = std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let lower = command.to_lowercase();
    let program_lower = program.to_lowercase();

    if matches!(
        program_lower.as_str(),
        "rm" | "rmdir" | "del" | "remove-item" | "set-content" | "out-file" | "add-content"
    ) {
        return true;
    }

    lower.contains("set-content")
        || lower.contains("out-file")
        || lower.contains("add-content")
        || lower.contains("remove-item")
        || lower.contains("writefile")
        || lower.contains("writefilesync")
        || (lower.contains("open(")
            && (lower.contains("'w'")
                || lower.contains("\"w\"")
                || lower.contains("'a'")
                || lower.contains("\"a\"")))
}

fn contains_force_flag(parts: &[&str]) -> bool {
    parts
        .iter()
        .any(|p| *p == "--force" || *p == "-f" || *p == "--hard" || p.starts_with("--force"))
}
