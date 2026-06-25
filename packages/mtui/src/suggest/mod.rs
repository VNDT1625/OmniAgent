use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct Suggestion {
    pub command: String,
    pub score: u32,
    pub success_rate: f64,
    pub used_count: i64,
    pub last_used: String,
    pub source: String,
}

pub fn suggest(
    conn: &rusqlite::Connection,
    prefix: &str,
    project_root: &Path,
) -> anyhow::Result<Vec<Suggestion>> {
    let result = crate::history::search_commands(conn, prefix)?;

    let project_path_str = project_root.display().to_string();
    let cwd_str = std::env::current_dir()
        .unwrap_or_default()
        .display()
        .to_string();

    let now = chrono::Utc::now();
    let mut suggestions: Vec<Suggestion> = result
        .into_iter()
        .map(|cmd| {
            let score = compute_score(&cmd, prefix, &project_path_str, &cwd_str, &now);
            let success_rate = if cmd.used_count > 0 {
                cmd.success_count as f64 / cmd.used_count as f64
            } else {
                0.0
            };

            Suggestion {
                command: cmd.command,
                score,
                success_rate: (success_rate * 100.0).round() / 100.0,
                used_count: cmd.used_count,
                last_used: cmd.last_used,
                source: "history".to_string(),
            }
        })
        .collect();

    let project_scripts = discover_project_scripts(project_root, prefix);
    suggestions.extend(project_scripts);

    suggestions.sort_by_key(|suggestion| std::cmp::Reverse(suggestion.score));
    suggestions.truncate(20);

    Ok(suggestions)
}

fn compute_score(
    cmd: &crate::history::CommandRecord,
    prefix: &str,
    project_path: &str,
    cwd: &str,
    now: &chrono::DateTime<chrono::Utc>,
) -> u32 {
    let mut score: u32 = 0;

    let prefix_len = prefix.len().min(cmd.command.len());
    if cmd.command.len() >= prefix.len() && cmd.command[..prefix_len].eq_ignore_ascii_case(prefix) {
        score += 40;
    }

    if cmd.project_path == project_path {
        score += 15;
    }

    if cmd.cwd == cwd {
        score += 10;
    }

    let success_rate = if cmd.used_count > 0 {
        cmd.success_count as f64 / cmd.used_count as f64
    } else {
        0.0
    };
    score += (success_rate * 15.0) as u32;

    if cmd.used_count > 0 {
        let freq_score = (cmd.used_count.min(100) as f64 / 100.0 * 10.0) as u32;
        score += freq_score;
    }

    if let Ok(last_used) = chrono::DateTime::parse_from_rfc3339(&cmd.last_used) {
        let last_used_utc = last_used.with_timezone(&chrono::Utc);
        let hours_ago = (now.timestamp() - last_used_utc.timestamp()).max(0) / 3600;
        if hours_ago < 1 {
            score += 10;
        } else if hours_ago < 24 {
            score += 7;
        } else if hours_ago < 168 {
            score += 3;
        }
    }

    score
}

fn discover_project_scripts(project_root: &Path, prefix: &str) -> Vec<Suggestion> {
    let mut suggestions = Vec::new();

    if let Ok(content) = std::fs::read_to_string(project_root.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(scripts) = json["scripts"].as_object() {
                for (name, _) in scripts {
                    let cmd = format!("bun run {}", name);
                    if cmd.starts_with(prefix) || name.starts_with(prefix) {
                        suggestions.push(Suggestion {
                            command: cmd,
                            score: 15,
                            success_rate: 1.0,
                            used_count: 0,
                            last_used: String::new(),
                            source: "project_script".to_string(),
                        });
                    }
                }
            }
        }
    }

    if let Ok(content) = std::fs::read_to_string(project_root.join("justfile")) {
        for line in content.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                if let Some(name) = trimmed.split_whitespace().next() {
                    if let Some(recipe) = name.strip_suffix(':') {
                        let cmd = format!("just {}", recipe);
                        if cmd.starts_with(prefix) || recipe.starts_with(prefix) {
                            suggestions.push(Suggestion {
                                command: cmd,
                                score: 15,
                                success_rate: 1.0,
                                used_count: 0,
                                last_used: String::new(),
                                source: "project_script".to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    suggestions
}
