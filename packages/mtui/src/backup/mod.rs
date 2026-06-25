use anyhow::Context;
use chrono::Local;
use std::path::{Path, PathBuf};

pub fn backup_dir(project_root: &Path) -> PathBuf {
    crate::config::config_dir(project_root).join("backups")
}

pub fn generate_backup_path(project_root: &Path, operation_id: &str, file_path: &Path) -> PathBuf {
    let date = Local::now().format("%Y-%m-%d").to_string();
    backup_dir(project_root)
        .join(&date)
        .join(operation_id)
        .join(
            file_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        )
}

pub fn create_backup(
    project_root: &Path,
    operation_id: &str,
    file_path: &Path,
    content: &[u8],
) -> anyhow::Result<PathBuf> {
    let backup_path = generate_backup_path(project_root, operation_id, file_path);
    if let Some(parent) = backup_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&backup_path, content)
        .with_context(|| format!("Failed to create backup: {}", backup_path.display()))?;
    Ok(backup_path)
}

pub fn load_backup(backup_path: &Path) -> anyhow::Result<Vec<u8>> {
    std::fs::read(backup_path)
        .with_context(|| format!("Failed to read backup: {}", backup_path.display()))
}
