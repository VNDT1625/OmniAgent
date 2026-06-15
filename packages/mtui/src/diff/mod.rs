use anyhow::Context;
use serde::Serialize;
use similar::{ChangeTag, TextDiff};
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct DiffSummary {
    pub insertions: usize,
    pub deletions: usize,
    pub diff: String,
}

pub fn generate_diff(old_text: &str, new_text: &str) -> DiffSummary {
    let diff = TextDiff::from_lines(old_text, new_text);
    let mut insertions = 0;
    let mut deletions = 0;

    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => insertions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }

    let unified = diff.unified_diff().to_string();

    DiffSummary {
        insertions,
        deletions,
        diff: unified,
    }
}

pub fn diff_file_path(project_root: &Path, operation_id: &str) -> std::path::PathBuf {
    crate::config::config_dir(project_root)
        .join("diffs")
        .join(format!("{}.diff", operation_id))
}

pub fn save_diff(
    project_root: &Path,
    operation_id: &str,
    diff: &str,
) -> anyhow::Result<std::path::PathBuf> {
    let path = diff_file_path(project_root, operation_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, diff)
        .with_context(|| format!("Failed to save diff: {}", path.display()))?;
    Ok(path)
}

pub fn diff_summary_string(insertions: usize, deletions: usize) -> String {
    format!("+{} -{}", insertions, deletions)
}
