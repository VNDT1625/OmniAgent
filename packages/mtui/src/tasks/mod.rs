use crate::error::MtuiError;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Done,
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskRecord {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub source_line: usize,
}

#[derive(Debug, Serialize)]
pub struct TaskCounts {
    pub total: usize,
    pub pending: usize,
    pub in_progress: usize,
    pub done: usize,
    pub blocked: usize,
}

#[derive(Debug, Serialize)]
pub struct TasksResult {
    pub command: String,
    pub spec: String,
    pub spec_dir: String,
    pub mode: String,
    pub counts: TaskCounts,
    pub tasks: Vec<TaskRecord>,
}

fn status_from_marker(marker: &str) -> TaskStatus {
    match marker {
        "x" | "X" => TaskStatus::Done,
        "~" => TaskStatus::InProgress,
        "!" | "/" => TaskStatus::Blocked,
        _ => TaskStatus::Pending,
    }
}

fn task_id_for(source_line: usize, title: &str) -> String {
    let slug: String = title
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(36)
        .collect();
    if slug.is_empty() {
        format!("t{:03}", source_line)
    } else {
        format!("t{:03}-{}", source_line, slug)
    }
}

fn parse_task_line(line: &str, source_line: usize) -> Option<TaskRecord> {
    let trimmed_start = line.trim_start();
    let after_bullet = trimmed_start
        .strip_prefix("- ")
        .or_else(|| trimmed_start.strip_prefix("* "))?;
    let marker = after_bullet.strip_prefix('[')?.chars().next()?;
    let after_marker = after_bullet.strip_prefix('[')?.get(1..)?;
    let title = after_marker.strip_prefix("] ")?.trim();
    if title.is_empty() {
        return None;
    }
    Some(TaskRecord {
        id: task_id_for(source_line, title),
        title: title.to_string(),
        status: status_from_marker(&marker.to_string()),
        source_line,
    })
}

fn parse_tasks(text: &str) -> Vec<TaskRecord> {
    text.lines()
        .enumerate()
        .filter_map(|(index, line)| parse_task_line(line, index + 1))
        .collect()
}

fn counts_from_tasks(tasks: &[TaskRecord]) -> TaskCounts {
    let mut counts = TaskCounts {
        total: 0,
        pending: 0,
        in_progress: 0,
        done: 0,
        blocked: 0,
    };
    for task in tasks {
        counts.total += 1;
        match task.status {
            TaskStatus::Pending => counts.pending += 1,
            TaskStatus::InProgress => counts.in_progress += 1,
            TaskStatus::Done => counts.done += 1,
            TaskStatus::Blocked => counts.blocked += 1,
        }
    }
    counts
}

fn specs_root(project_root: &Path) -> PathBuf {
    project_root.join(".aionui").join("specs")
}

fn resolve_spec_dir(
    project_root: &Path,
    spec: Option<&str>,
) -> Result<(String, PathBuf), MtuiError> {
    let root = specs_root(project_root);
    if let Some(value) = spec {
        let normalized = value
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
        if slug.is_empty() {
            return Err(MtuiError::InvalidArgument {
                message: "Spec slug is empty".to_string(),
                suggestion: "Use --spec <slug> or --spec .aionui/specs/<slug>/".to_string(),
            });
        }
        return Ok((slug.clone(), root.join(slug)));
    }

    let mut entries = fs::read_dir(&root)
        .map_err(|_| MtuiError::FileNotFound {
            message: "No .aionui/specs directory found".to_string(),
            suggestion: "Create a planning spec in the IDE first".to_string(),
        })?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_dir() {
                return None;
            }
            let modified = metadata.modified().ok()?;
            Some((
                entry.file_name().to_string_lossy().to_string(),
                entry.path(),
                modified,
            ))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    entries
        .into_iter()
        .next()
        .map(|(slug, dir, _)| (slug, dir))
        .ok_or_else(|| MtuiError::FileNotFound {
            message: "No planning specs found".to_string(),
            suggestion: "Create a planning spec in the IDE first".to_string(),
        })
}

pub fn query_tasks(
    project_root: &Path,
    spec: Option<&str>,
    mode: &str,
) -> Result<TasksResult, MtuiError> {
    let (slug, spec_dir) = resolve_spec_dir(project_root, spec)?;
    let tasks_path = spec_dir.join("tasks.md");
    let text = fs::read_to_string(&tasks_path).map_err(|_| MtuiError::FileNotFound {
        message: format!("tasks.md not found for spec {}", slug),
        suggestion: "Create or repair the planning spec before querying tasks".to_string(),
    })?;
    let all_tasks = parse_tasks(&text);
    let tasks = match mode {
        "current" => all_tasks
            .iter()
            .find(|task| task.status == TaskStatus::InProgress)
            .or_else(|| {
                all_tasks
                    .iter()
                    .find(|task| task.status == TaskStatus::Pending)
            })
            .cloned()
            .into_iter()
            .collect(),
        "done" => all_tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Done)
            .cloned()
            .collect(),
        _ => all_tasks.clone(),
    };

    Ok(TasksResult {
        command: "tasks".to_string(),
        spec: slug,
        spec_dir: spec_dir.display().to_string(),
        mode: mode.to_string(),
        counts: counts_from_tasks(&all_tasks),
        tasks,
    })
}
