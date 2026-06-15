use crate::error::MtuiError;
use crate::fs;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct UndoResult {
    pub operation_id: String,
    pub file: String,
    pub restored: bool,
}

pub fn undo_operation(
    _project_root: &Path,
    operation: &crate::history::OperationRecord,
) -> Result<UndoResult, MtuiError> {
    if operation.backup_path.is_none() {
        return Err(MtuiError::UndoNotAvailable {
            message: format!(
                "No backup available for operation: {}",
                operation.operation_id
            ),
            suggestion: "This operation does not have undo data".to_string(),
        });
    }

    let backup_path = Path::new(operation.backup_path.as_ref().unwrap());
    if !backup_path.exists() {
        return Err(MtuiError::UndoNotAvailable {
            message: format!(
                "Backup file not found for operation: {}",
                operation.operation_id
            ),
            suggestion: "Backup file may have been deleted".to_string(),
        });
    }

    let file_path = match &operation.file_path {
        Some(fp) => Path::new(fp),
        None => {
            return Err(MtuiError::UndoNotAvailable {
                message: "No file path in operation record".to_string(),
                suggestion: "Cannot determine which file to restore".to_string(),
            });
        }
    };

    if file_path.exists() {
        let current_content =
            fs::read_file_bytes(file_path).map_err(|_| MtuiError::PermissionDenied {
                message: format!("Cannot read current file: {}", file_path.display()),
                suggestion: "Check file permissions".to_string(),
            })?;

        let current_hash = fs::compute_hash(&current_content);

        if let Some(ref expected_hash) = operation.after_hash {
            if current_hash != *expected_hash {
                return Err(MtuiError::Conflict {
                    message: "File changed after operation; undo is not safe".to_string(),
                    suggestion: "Review the diff manually before restoring".to_string(),
                });
            }
        }
    }

    let backup_content =
        crate::backup::load_backup(backup_path).map_err(|_| MtuiError::BackupFailed {
            message: format!("Failed to read backup: {}", backup_path.display()),
            suggestion: "Backup file may be corrupted".to_string(),
        })?;

    fs::atomic_write(file_path, &backup_content).map_err(|e| MtuiError::WriteFailed {
        message: format!("Failed to restore file: {}", e),
        suggestion: "Check disk space and permissions".to_string(),
    })?;

    Ok(UndoResult {
        operation_id: operation.operation_id.clone(),
        file: file_path.display().to_string(),
        restored: true,
    })
}
