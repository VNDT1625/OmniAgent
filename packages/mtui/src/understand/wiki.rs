//! Query the durable project Wiki exported by AionUi into `.omni/wiki/wiki.json`.
//!
//! This is intentionally a small read-only adapter over the persisted Wiki
//! schema. Agents can retrieve shared, model-authored project knowledge without
//! rescanning source files or depending on the Electron renderer.

use crate::error::MtuiError;
use serde::{Deserialize, Serialize};
use std::path::Path;

const WIKI_REL_PATH: &str = ".omni/wiki/wiki.json";
const MAX_MATCH_CONTENT_CHARS: usize = 8_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWiki {
    built_at: u64,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    sections: Vec<PersistedWikiSection>,
    #[serde(default)]
    key_files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWikiSection {
    id: String,
    title_key: String,
    content: String,
}

#[derive(Debug, Serialize)]
pub struct WikiMatch {
    pub id: String,
    pub title: String,
    pub score: u32,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct WikiQueryResult {
    pub command: String,
    pub query: String,
    pub wiki_path: String,
    pub built_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub section_count: usize,
    pub key_files: Vec<String>,
    pub matches: Vec<WikiMatch>,
}

fn query_terms(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|term| term.len() > 1)
        .map(str::to_string)
        .collect()
}

fn score_section(section: &PersistedWikiSection, query: &str, terms: &[String]) -> u32 {
    if terms.is_empty() {
        return 1;
    }
    let title = format!("{} {}", section.id, section.title_key).to_lowercase();
    let content = section.content.to_lowercase();
    let normalized_query = query.trim().to_lowercase();
    let mut score = 0;
    if title.contains(&normalized_query) {
        score += 12;
    }
    if content.contains(&normalized_query) {
        score += 4;
    }
    for term in terms {
        if title.contains(term) {
            score += 5;
        }
        if content.contains(term) {
            score += 1;
        }
    }
    score
}

fn clip_content(content: &str) -> (String, bool) {
    if content.chars().count() <= MAX_MATCH_CONTENT_CHARS {
        return (content.to_string(), false);
    }
    let clipped: String = content.chars().take(MAX_MATCH_CONTENT_CHARS).collect();
    (format!("{clipped}\n[truncated]"), true)
}

/// Search the durable project Wiki and return the highest-scoring sections.
pub fn query_wiki(
    project_root: &Path,
    query: &str,
    limit: usize,
) -> Result<WikiQueryResult, MtuiError> {
    let wiki_path = project_root.join(WIKI_REL_PATH);
    let raw = std::fs::read_to_string(&wiki_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            MtuiError::FileNotFound {
                message: format!("Project Wiki not found at {WIKI_REL_PATH}"),
                suggestion: "Build the Wiki from AionUi Studio, then retry `mtui wiki <query>`"
                    .to_string(),
            }
        } else {
            MtuiError::Internal {
                message: format!("Failed to read project Wiki: {error}"),
            }
        }
    })?;
    let wiki: PersistedWiki = serde_json::from_str(&raw).map_err(|error| MtuiError::Internal {
        message: format!("Project Wiki is invalid JSON: {error}"),
    })?;
    let terms = query_terms(query);
    let section_count = wiki.sections.len();
    let mut scored: Vec<(u32, PersistedWikiSection)> = wiki
        .sections
        .into_iter()
        .filter_map(|section| {
            let score = score_section(&section, query, &terms);
            (score > 0).then_some((score, section))
        })
        .collect();
    scored.sort_by(|(score_a, section_a), (score_b, section_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| section_a.title_key.cmp(&section_b.title_key))
    });
    scored.truncate(limit.max(1));
    let matches = scored
        .into_iter()
        .map(|(score, section)| {
            let (content, truncated) = clip_content(&section.content);
            WikiMatch {
                id: section.id,
                title: section.title_key,
                score,
                content,
                truncated,
            }
        })
        .collect();

    Ok(WikiQueryResult {
        command: "wiki".to_string(),
        query: query.to_string(),
        wiki_path: WIKI_REL_PATH.to_string(),
        built_at: wiki.built_at,
        language: wiki.language,
        model: wiki.model,
        section_count,
        key_files: wiki.key_files,
        matches,
    })
}
