use crate::safety::{classify_command_risk, RiskLevel};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct RepairResult {
    pub command: String,
    pub repair_available: bool,
    pub original_command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<RiskLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_confirm: Option<bool>,
}

pub fn repair(
    conn: &rusqlite::Connection,
    command: &str,
    stderr: &str,
) -> anyhow::Result<RepairResult> {
    let rules = crate::history::load_repair_rules(conn)?;

    let bin = command.split_whitespace().next().unwrap_or("").to_string();

    for rule in &rules {
        if rule.match_command == bin {
            let matches_stderr = match &rule.stderr_contains {
                Some(pattern) => {
                    let parts: Vec<&str> = pattern.split('|').collect();
                    parts
                        .iter()
                        .any(|p| stderr.to_lowercase().contains(&p.to_lowercase()))
                }
                None => true,
            };

            if matches_stderr {
                let risk = match rule.risk.as_str() {
                    "read_only" => RiskLevel::ReadOnly,
                    "project_write" => RiskLevel::ProjectWrite,
                    "external_network" => RiskLevel::ExternalNetwork,
                    "destructive" => RiskLevel::Destructive,
                    "privileged" => RiskLevel::Privileged,
                    _ => RiskLevel::Unknown,
                };

                return Ok(RepairResult {
                    command: "repair".to_string(),
                    repair_available: true,
                    original_command: command.to_string(),
                    suggested_command: Some(rule.suggested_command.clone()),
                    message: Some(rule.message.clone()),
                    source: Some(rule.source.clone()),
                    risk: Some(risk),
                    requires_confirm: Some(rule.requires_confirm),
                });
            }
        }
    }

    if let Some(suggested_command) = repair_from_history(conn, command)? {
        return Ok(repair_result(
            command,
            suggested_command,
            "Use the closest successful command from local MTUI history.".to_string(),
            "history_fuzzy".to_string(),
        ));
    }

    if let Some(suggested_command) = repair_builtin_typo(command) {
        return Ok(repair_result(
            command,
            suggested_command,
            "Apply a built-in correction for a common command typo.".to_string(),
            "builtin_typo".to_string(),
        ));
    }

    Ok(RepairResult {
        command: "repair".to_string(),
        repair_available: false,
        original_command: command.to_string(),
        suggested_command: None,
        message: None,
        source: None,
        risk: None,
        requires_confirm: None,
    })
}

fn repair_result(
    original_command: &str,
    suggested_command: String,
    message: String,
    source: String,
) -> RepairResult {
    let risk = classify_command_risk(&suggested_command);
    let requires_confirm = matches!(risk, RiskLevel::Destructive | RiskLevel::Privileged);
    RepairResult {
        command: "repair".to_string(),
        repair_available: true,
        original_command: original_command.to_string(),
        suggested_command: Some(suggested_command),
        message: Some(message),
        source: Some(source),
        risk: Some(risk),
        requires_confirm: Some(requires_confirm),
    }
}

fn repair_from_history(
    conn: &rusqlite::Connection,
    command: &str,
) -> anyhow::Result<Option<String>> {
    let commands = crate::history::list_commands(conn, 100)?;
    let normalized = normalize_command(command);
    let mut best: Option<(String, usize, i64)> = None;

    for record in commands {
        if record.success_count <= 0 {
            continue;
        }
        let candidate = normalize_command(&record.command);
        let distance = levenshtein(&normalized, &candidate);
        let threshold = (candidate.len().max(normalized.len()) / 4).max(2);
        if distance > threshold {
            continue;
        }

        match &best {
            Some((_, best_distance, best_used)) if distance > *best_distance => {}
            Some((_, best_distance, best_used))
                if distance == *best_distance && record.used_count <= *best_used => {}
            _ => best = Some((record.command, distance, record.used_count)),
        }
    }

    Ok(best.map(|(candidate, _, _)| candidate))
}

fn repair_builtin_typo(command: &str) -> Option<String> {
    let mut parts: Vec<&str> = command.split_whitespace().collect();
    let first = parts.first_mut()?;
    match *first {
        "gti" => *first = "git",
        "sl" => *first = "ls",
        "claer" => *first = "clear",
        _ => {}
    }

    if parts.len() >= 2 {
        match (parts[0], parts[1]) {
            ("bun" | "npm" | "pnpm" | "yarn", "rn") | ("bun" | "npm" | "pnpm" | "yarn", "r") => {
                parts[1] = "run";
            }
            ("cargo", "buid") => parts[1] = "build",
            ("cargo", "tset") => parts[1] = "test",
            _ => {}
        }
    }

    let repaired = parts.join(" ");
    if repaired == command {
        None
    } else {
        Some(repaired)
    }
}

fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn levenshtein(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }
    if a.is_empty() {
        return b.chars().count();
    }
    if b.is_empty() {
        return a.chars().count();
    }

    let b_chars: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b_chars.len()).collect();
    let mut current = vec![0; b_chars.len() + 1];

    for (i, a_char) in a.chars().enumerate() {
        current[0] = i + 1;
        for (j, b_char) in b_chars.iter().enumerate() {
            let substitution = previous[j] + usize::from(a_char != *b_char);
            let insertion = current[j] + 1;
            let deletion = previous[j + 1] + 1;
            current[j + 1] = substitution.min(insertion).min(deletion);
        }
        std::mem::swap(&mut previous, &mut current);
    }

    previous[b_chars.len()]
}
