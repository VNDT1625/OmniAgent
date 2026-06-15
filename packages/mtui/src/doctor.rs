use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct DoctorResult {
    pub command: String,
    pub current_exe: String,
    pub install_dir: Option<String>,
    pub latest_version_dir: Option<String>,
    pub latest_binary: Option<String>,
    pub primary_exe: Option<String>,
    pub path_has_latest_version: bool,
    pub path_has_install_dir: bool,
    pub current_is_primary: bool,
    pub current_is_latest_version: bool,
    pub primary_matches_latest: Option<bool>,
    pub understand_cache: CacheStatus,
    pub recommendations: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CacheStatus {
    pub exists: bool,
    pub path: String,
    pub stale_marker: bool,
    pub stale_marker_path: String,
}

pub fn run(project_root: &Path) -> DoctorResult {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("mtui"));
    let install_dir = install_dir();
    let latest_version_dir = install_dir
        .as_ref()
        .and_then(|dir| latest_version_dir_from_manifest(dir).or_else(|| latest_version_dir(dir)));
    let primary_exe = install_dir.as_ref().map(|dir| {
        dir.join(if cfg!(windows) { "mtui.exe" } else { "mtui" })
            .to_string_lossy()
            .to_string()
    });
    let latest_binary_path = latest_version_dir
        .as_ref()
        .map(|dir| dir.join(if cfg!(windows) { "mtui.exe" } else { "mtui" }));
    let path_entries = path_entries();
    let path_has_latest_version = latest_version_dir
        .as_ref()
        .is_some_and(|dir| path_entries.iter().any(|entry| same_path(entry, dir)));
    let path_has_install_dir = install_dir
        .as_ref()
        .is_some_and(|dir| path_entries.iter().any(|entry| same_path(entry, dir)));
    let primary_exe_path = primary_exe.as_ref().map(PathBuf::from);
    let current_is_primary = primary_exe_path
        .as_ref()
        .is_some_and(|primary| same_path(&current_exe, primary));
    let current_is_latest_version = latest_binary_path
        .as_ref()
        .is_some_and(|latest| same_path(&current_exe, latest));
    let primary_matches_latest = primary_exe_path.as_ref().and_then(|primary| {
        latest_binary_path
            .as_ref()
            .map(|latest| files_match(primary, latest))
    });
    let cache_path = project_root
        .join(".aionui")
        .join("understand")
        .join("summary.json");
    let stale_marker_path = project_root
        .join(".aionui")
        .join("understand")
        .join("stale.json");
    let understand_cache = CacheStatus {
        exists: cache_path.exists(),
        path: cache_path.to_string_lossy().to_string(),
        stale_marker: stale_marker_path.exists(),
        stale_marker_path: stale_marker_path.to_string_lossy().to_string(),
    };
    let mut recommendations = Vec::new();
    if !path_has_install_dir {
        recommendations.push(
            "Run packages/mtui/install.ps1, then open a new terminal so PATH includes the MTUI primary install directory."
                .to_string(),
        );
    }
    if !current_is_primary && !current_is_latest_version && latest_binary_path.is_some() {
        recommendations.push(
            "This shell resolved an older MTUI binary. Open a new terminal after reinstalling so `mtui` points at the primary install directory."
                .to_string(),
        );
    }
    if matches!(primary_matches_latest, Some(false)) {
        recommendations.push(
            "The primary mtui.exe does not match latest.json; close terminals using MTUI and rerun packages/mtui/install.ps1."
                .to_string(),
        );
    }
    if !understand_cache.exists {
        recommendations.push("Build Understand/codegraph in the IDE before relying on MTUI summary/map/context for high-confidence results.".to_string());
    }
    if understand_cache.stale_marker {
        recommendations.push("Understand/codegraph is marked stale after MTUI writes; rebuild or update changed files in the IDE before relying on high-confidence MTUI map/context.".to_string());
    }
    DoctorResult {
        command: "doctor".to_string(),
        current_exe: current_exe.to_string_lossy().to_string(),
        install_dir: install_dir.map(|path| path.to_string_lossy().to_string()),
        latest_version_dir: latest_version_dir.map(|path| path.to_string_lossy().to_string()),
        latest_binary: latest_binary_path.map(|path| path.to_string_lossy().to_string()),
        primary_exe,
        path_has_latest_version,
        path_has_install_dir,
        current_is_primary,
        current_is_latest_version,
        primary_matches_latest,
        understand_cache,
        recommendations,
    }
}

fn install_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("mtui"))
    } else {
        std::env::var_os("HOME").map(|root| PathBuf::from(root).join(".local").join("bin"))
    }
}

fn latest_version_dir(install_dir: &Path) -> Option<PathBuf> {
    let versions_dir = install_dir.join("versions");
    let mut versions = std::fs::read_dir(versions_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    versions.sort_by(|a, b| b.to_string_lossy().cmp(&a.to_string_lossy()));
    versions.into_iter().next()
}

fn latest_version_dir_from_manifest(install_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(install_dir.join("latest.json")).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let dir = json.get("versionDir")?.as_str()?;
    let path = PathBuf::from(dir);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn path_entries() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default()
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().replace('\\', "/").to_lowercase();
    let right = right.to_string_lossy().replace('\\', "/").to_lowercase();
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

fn files_match(left: &Path, right: &Path) -> bool {
    let Ok(left_bytes) = std::fs::read(left) else {
        return false;
    };
    let Ok(right_bytes) = std::fs::read(right) else {
        return false;
    };
    blake3::hash(&left_bytes) == blake3::hash(&right_bytes)
}
