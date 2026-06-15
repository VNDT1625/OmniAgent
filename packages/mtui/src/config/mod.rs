use anyhow::Context;
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct MtuiConfig {
    #[serde(default = "default_project_root")]
    #[allow(dead_code)]
    pub project_root: String,

    #[serde(default)]
    pub allow_outside_project: bool,

    #[serde(default)]
    #[allow(dead_code)]
    pub default_json: bool,

    #[serde(default)]
    pub ignore: IgnoreConfig,
}

#[derive(Debug, Deserialize)]
pub struct IgnoreConfig {
    #[serde(default = "default_ignore_patterns")]
    pub patterns: Vec<String>,
}

impl Default for IgnoreConfig {
    fn default() -> Self {
        IgnoreConfig {
            patterns: default_ignore_patterns(),
        }
    }
}

fn default_project_root() -> String {
    ".".to_string()
}

fn default_ignore_patterns() -> Vec<String> {
    vec![
        ".git/**".to_string(),
        "node_modules/**".to_string(),
        "dist/**".to_string(),
        "build/**".to_string(),
        "target/**".to_string(),
        "vendor/**".to_string(),
    ]
}

impl Default for MtuiConfig {
    fn default() -> Self {
        MtuiConfig {
            project_root: default_project_root(),
            allow_outside_project: false,
            default_json: false,
            ignore: IgnoreConfig::default(),
        }
    }
}

pub fn config_dir(project_root: &Path) -> PathBuf {
    project_root.join(".mtui")
}

pub fn config_file(project_root: &Path) -> PathBuf {
    config_dir(project_root).join("config.toml")
}

pub fn load_config(project_root: &Path) -> anyhow::Result<MtuiConfig> {
    let path = config_file(project_root);
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read config: {}", path.display()))?;
        let config: MtuiConfig = toml::from_str(&content)
            .with_context(|| format!("Failed to parse config: {}", path.display()))?;
        Ok(config)
    } else {
        Ok(MtuiConfig::default())
    }
}

pub fn resolve_project_root() -> anyhow::Result<PathBuf> {
    let cwd = std::env::current_dir().context("Failed to get current directory")?;

    let mut current = cwd.as_path();
    loop {
        if current.join(".mtui").exists() {
            return Ok(current.to_path_buf());
        }
        if current.join(".git").exists() {
            return Ok(current.to_path_buf());
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => break,
        }
    }

    Ok(cwd)
}

pub fn ensure_config_dir(project_root: &Path) -> anyhow::Result<PathBuf> {
    let dir = config_dir(project_root);
    std::fs::create_dir_all(dir.join("backups"))?;
    std::fs::create_dir_all(dir.join("diffs"))?;
    std::fs::create_dir_all(dir.join("operations"))?;
    std::fs::create_dir_all(dir.join("tmp"))?;
    Ok(dir)
}
