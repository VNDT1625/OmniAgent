use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorType {
    NoMatch,
    MultipleMatches,
    FileNotFound,
    FileExists,
    PathOutsideProject,
    PathIgnored,
    BinaryFile,
    EncodingError,
    PermissionDenied,
    InvalidArgument,
    BackupFailed,
    WriteFailed,
    DiffFailed,
    UndoNotAvailable,
    Conflict,
    CommandBlocked,
    CommandNeedsConfirm,
    RepairNotFound,
    InternalError,
}

#[derive(Debug, Error)]
pub enum MtuiError {
    #[error("{message}")]
    NoMatch { message: String, suggestion: String },

    #[error("{message}")]
    MultipleMatches {
        message: String,
        matches: usize,
        suggestion: String,
    },

    #[error("{message}")]
    FileNotFound { message: String, suggestion: String },

    #[error("{message}")]
    FileExists { message: String, suggestion: String },

    #[error("{message}")]
    PathOutsideProject { message: String, suggestion: String },

    #[error("{message}")]
    PathIgnored { message: String, suggestion: String },

    #[error("{message}")]
    BinaryFile { message: String, suggestion: String },

    #[error("{message}")]
    EncodingError { message: String, suggestion: String },

    #[error("{message}")]
    PermissionDenied { message: String, suggestion: String },

    #[error("{message}")]
    InvalidArgument { message: String, suggestion: String },

    #[error("{message}")]
    BackupFailed { message: String, suggestion: String },

    #[error("{message}")]
    WriteFailed { message: String, suggestion: String },

    #[error("{message}")]
    DiffFailed { message: String, suggestion: String },

    #[error("{message}")]
    UndoNotAvailable { message: String, suggestion: String },

    #[error("{message}")]
    Conflict { message: String, suggestion: String },

    #[error("{message}")]
    ConflictDetailed {
        message: String,
        suggestion: String,
        details: serde_json::Value,
    },

    #[error("{message}")]
    CommandBlocked { message: String, suggestion: String },

    #[error("{message}")]
    #[allow(dead_code)]
    CommandNeedsConfirm { message: String, suggestion: String },

    #[error("{message}")]
    #[allow(dead_code)]
    RepairNotFound { message: String },

    #[error("{message}")]
    Internal { message: String },
}

impl MtuiError {
    pub fn error_type(&self) -> ErrorType {
        match self {
            MtuiError::NoMatch { .. } => ErrorType::NoMatch,
            MtuiError::MultipleMatches { .. } => ErrorType::MultipleMatches,
            MtuiError::FileNotFound { .. } => ErrorType::FileNotFound,
            MtuiError::FileExists { .. } => ErrorType::FileExists,
            MtuiError::PathOutsideProject { .. } => ErrorType::PathOutsideProject,
            MtuiError::PathIgnored { .. } => ErrorType::PathIgnored,
            MtuiError::BinaryFile { .. } => ErrorType::BinaryFile,
            MtuiError::EncodingError { .. } => ErrorType::EncodingError,
            MtuiError::PermissionDenied { .. } => ErrorType::PermissionDenied,
            MtuiError::InvalidArgument { .. } => ErrorType::InvalidArgument,
            MtuiError::BackupFailed { .. } => ErrorType::BackupFailed,
            MtuiError::WriteFailed { .. } => ErrorType::WriteFailed,
            MtuiError::DiffFailed { .. } => ErrorType::DiffFailed,
            MtuiError::UndoNotAvailable { .. } => ErrorType::UndoNotAvailable,
            MtuiError::Conflict { .. } | MtuiError::ConflictDetailed { .. } => ErrorType::Conflict,
            MtuiError::CommandBlocked { .. } => ErrorType::CommandBlocked,
            MtuiError::CommandNeedsConfirm { .. } => ErrorType::CommandNeedsConfirm,
            MtuiError::RepairNotFound { .. } => ErrorType::RepairNotFound,
            MtuiError::Internal { .. } => ErrorType::InternalError,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            MtuiError::NoMatch { message, .. }
            | MtuiError::MultipleMatches { message, .. }
            | MtuiError::FileNotFound { message, .. }
            | MtuiError::FileExists { message, .. }
            | MtuiError::PathOutsideProject { message, .. }
            | MtuiError::PathIgnored { message, .. }
            | MtuiError::BinaryFile { message, .. }
            | MtuiError::EncodingError { message, .. }
            | MtuiError::PermissionDenied { message, .. }
            | MtuiError::InvalidArgument { message, .. }
            | MtuiError::BackupFailed { message, .. }
            | MtuiError::WriteFailed { message, .. }
            | MtuiError::DiffFailed { message, .. }
            | MtuiError::UndoNotAvailable { message, .. }
            | MtuiError::Conflict { message, .. }
            | MtuiError::ConflictDetailed { message, .. }
            | MtuiError::CommandBlocked { message, .. }
            | MtuiError::CommandNeedsConfirm { message, .. } => message,
            MtuiError::RepairNotFound { message } | MtuiError::Internal { message } => message,
        }
    }

    pub fn suggestion(&self) -> Option<&str> {
        match self {
            MtuiError::NoMatch { suggestion, .. }
            | MtuiError::MultipleMatches { suggestion, .. }
            | MtuiError::FileNotFound { suggestion, .. }
            | MtuiError::FileExists { suggestion, .. }
            | MtuiError::PathOutsideProject { suggestion, .. }
            | MtuiError::PathIgnored { suggestion, .. }
            | MtuiError::BinaryFile { suggestion, .. }
            | MtuiError::EncodingError { suggestion, .. }
            | MtuiError::PermissionDenied { suggestion, .. }
            | MtuiError::InvalidArgument { suggestion, .. }
            | MtuiError::BackupFailed { suggestion, .. }
            | MtuiError::WriteFailed { suggestion, .. }
            | MtuiError::DiffFailed { suggestion, .. }
            | MtuiError::UndoNotAvailable { suggestion, .. }
            | MtuiError::Conflict { suggestion, .. }
            | MtuiError::ConflictDetailed { suggestion, .. }
            | MtuiError::CommandBlocked { suggestion, .. }
            | MtuiError::CommandNeedsConfirm { suggestion, .. } => Some(suggestion),
            MtuiError::RepairNotFound { .. } | MtuiError::Internal { .. } => None,
        }
    }

    pub fn matches_count(&self) -> Option<usize> {
        match self {
            MtuiError::MultipleMatches { matches, .. } => Some(*matches),
            _ => None,
        }
    }

    pub fn details(&self) -> Option<&serde_json::Value> {
        match self {
            MtuiError::ConflictDetailed { details, .. } => Some(details),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub schema_version: u16,
    pub mtui_version: &'static str,
    pub warnings: Vec<String>,
    pub command: String,
    pub operation: Option<String>,
    pub error_type: ErrorType,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ErrorResponse {
    pub fn from_error(error: &MtuiError, command: &str, operation: Option<&str>) -> Self {
        ErrorResponse {
            ok: false,
            schema_version: crate::output::SCHEMA_VERSION,
            mtui_version: crate::output::MTUI_VERSION,
            warnings: Vec::new(),
            command: command.to_string(),
            operation: operation.map(|s| s.to_string()),
            error_type: error.error_type(),
            message: error.message().to_string(),
            suggestion: error.suggestion().map(|s| s.to_string()),
            matches: error.matches_count(),
            details: error.details().cloned(),
        }
    }
}
