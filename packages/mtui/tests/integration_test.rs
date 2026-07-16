use std::path::Path;

fn setup_test_env() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_current_dir(dir.path()).ok();
    dir
}

fn write_file(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
}

#[test]
fn test_search_finds_text() {
    let dir = setup_test_env();
    let file_path = dir.path().join("test.txt");
    write_file(&file_path, "hello world\nfoo bar\nhello again\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search(dir.path(), &file_path, "hello", 200, &config).unwrap();

    assert_eq!(result.match_count, 2);
    assert_eq!(result.matches[0].line, 1);
    assert_eq!(result.matches[1].line, 3);
}

#[test]
fn test_search_no_match() {
    let dir = setup_test_env();
    let file_path = dir.path().join("test.txt");
    write_file(&file_path, "hello world\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search(dir.path(), &file_path, "nonexistent", 200, &config).unwrap();

    assert_eq!(result.match_count, 0);
}

#[test]
fn test_search_limit_truncates_matches() {
    let dir = setup_test_env();
    let file_path = dir.path().join("test.txt");
    write_file(&file_path, "hello one\nhello two\nhello three\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search(dir.path(), &file_path, "hello", 2, &config).unwrap();

    assert_eq!(result.match_count, 2);
    assert_eq!(result.limit, 2);
    assert!(result.truncated);
}

#[test]
fn test_search_preview_preserves_utf8_boundaries() {
    let dir = setup_test_env();
    let file_path = dir.path().join("unicode.txt");
    let content = format!("{} terminal\n", "ụ".repeat(110));
    write_file(&file_path, &content);

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search(dir.path(), &file_path, "terminal", 200, &config).unwrap();

    assert_eq!(result.match_count, 1);
    assert!(result.matches[0].preview.contains("terminal"));
    assert!(result.matches[0].preview.is_char_boundary(0));
}

#[test]
fn test_search_supports_regex_glob_ignore_case_and_context() {
    let dir = setup_test_env();
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    write_file(&src.join("a.ts"), "before\nTODO First\nafter\n");
    write_file(&src.join("b.js"), "TODO Second\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search_with_options(
        dir.path(),
        &src,
        r"todo\s+\w+",
        mtui::ops::SearchOptions {
            limit: 20,
            regex: true,
            ignore_case: true,
            include_globs: vec!["**/*.{ts,tsx}".to_string()],
            context: 1,
            ..mtui::ops::SearchOptions::default()
        },
        &config,
    )
    .unwrap();

    assert_eq!(result.match_count, 1);
    assert_eq!(result.scanned_match_count, 1);
    assert_eq!(result.total_match_count, Some(1));
    assert_eq!(result.file_count, 1);
    assert_eq!(result.matches[0].file, "src/a.ts");
    assert_eq!(result.matches[0].before, vec!["before"]);
    assert_eq!(result.matches[0].after, vec!["after"]);
}

#[test]
fn test_search_count_groups_matching_lines_by_file() {
    let dir = setup_test_env();
    write_file(&dir.path().join("a.txt"), "hit\nmiss\nhit\n");
    write_file(&dir.path().join("b.txt"), "hit\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search_with_options(
        dir.path(),
        dir.path(),
        "hit",
        mtui::ops::SearchOptions {
            limit: 20,
            count: true,
            ..mtui::ops::SearchOptions::default()
        },
        &config,
    )
    .unwrap();

    assert_eq!(result.match_count, 3);
    assert_eq!(result.file_count, 2);
    assert_eq!(result.counts[0].matching_lines, 2);
    assert_eq!(result.counts[1].matching_lines, 1);
    assert!(result.matches.is_empty());
}

#[test]
fn test_search_rejects_invalid_regex() {
    let dir = setup_test_env();
    write_file(&dir.path().join("a.txt"), "value\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search_with_options(
        dir.path(),
        dir.path(),
        "[",
        mtui::ops::SearchOptions {
            limit: 20,
            regex: true,
            ..mtui::ops::SearchOptions::default()
        },
        &config,
    );

    assert!(matches!(
        result,
        Err(mtui::error::MtuiError::InvalidArgument { .. })
    ));
}

// Compact JSON regression tests.
#[test]
fn test_map_json_omits_empty_collections_for_compact_agent_output() {
    let dir = setup_test_env();
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    write_file(&src.join("main.rs"), "fn main() {}\n");

    let result = mtui::understand::map_folder(dir.path(), &src, 10).unwrap();
    let json = serde_json::to_value(result).unwrap();

    assert!(json.get("files").is_some());
    assert!(json.get("modules").is_none());
    assert!(json.get("recommended_path").is_none());
    assert!(json.get("related_folders").is_none());
}

#[test]
fn test_stats_json_omits_empty_breakdowns() {
    let dir = setup_test_env();
    let result = mtui::analyze::run_stats(dir.path(), dir.path(), 100, 10).unwrap();
    let json = serde_json::to_value(result).unwrap();

    assert!(json.get("extensions").is_none());
    assert!(json.get("largestFiles").is_none());
}

#[test]
fn test_create_file() {
    let dir = setup_test_env();
    let file_path = dir.path().join("new_file.txt");

    let config = mtui::config::MtuiConfig::default();
    let result =
        mtui::ops::create_file(dir.path(), &file_path, b"hello", false, &config, false).unwrap();

    assert!(result.changed);
    assert!(file_path.exists());
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "hello");
    assert!(dir
        .path()
        .join(".aionui")
        .join("understand")
        .join("stale.json")
        .exists());
}

#[test]
fn test_understand_stale_marker_accumulates_changed_paths() {
    let dir = setup_test_env();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("nested").join("second.txt");
    std::fs::create_dir_all(second.parent().unwrap()).unwrap();

    let config = mtui::config::MtuiConfig::default();
    mtui::ops::create_file(dir.path(), &first, b"first", false, &config, false).unwrap();
    mtui::ops::create_file(dir.path(), &second, b"second", false, &config, false).unwrap();

    let marker_path = dir
        .path()
        .join(".aionui")
        .join("understand")
        .join("stale.json");
    let marker =
        serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(marker_path).unwrap())
            .unwrap();
    let paths = marker["paths"].as_array().unwrap();
    assert_eq!(marker["pathCount"].as_u64(), Some(2));
    assert!(paths.iter().any(|path| path.as_str() == Some("first.txt")));
    assert!(paths
        .iter()
        .any(|path| path.as_str() == Some("nested/second.txt")));
}

#[test]
fn test_create_file_dry_run() {
    let dir = setup_test_env();
    let file_path = dir.path().join("dry_new.txt");

    let config = mtui::config::MtuiConfig::default();
    let result =
        mtui::ops::create_file(dir.path(), &file_path, b"hello", false, &config, true).unwrap();

    assert!(!result.changed);
    assert!(!file_path.exists());
}

#[test]
fn test_create_file_overwrite_records_backup() {
    let dir = setup_test_env();
    let file_path = dir.path().join("overwrite.txt");
    write_file(&file_path, "before\n");

    let config = mtui::config::MtuiConfig::default();
    let result =
        mtui::ops::create_file(dir.path(), &file_path, b"after\n", true, &config, false).unwrap();

    assert!(result.changed);
    assert_eq!(result.operation, "overwrite_file");
    assert!(result.backup.is_some());
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "after\n");

    let backup_path = Path::new(result.backup.as_ref().unwrap());
    assert!(backup_path.exists());
    assert_eq!(std::fs::read_to_string(backup_path).unwrap(), "before\n");

    let conn = mtui::history::open_db(dir.path()).unwrap();
    let op = mtui::history::get_operation(&conn, &result.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(op.operation_type, "overwrite_file");
    assert!(op.diff_path.is_some());
}

#[test]
fn test_delete_file_records_backup_and_can_undo() {
    let dir = setup_test_env();
    let file_path = dir.path().join("delete_me.txt");
    write_file(&file_path, "remove me\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::delete_file(dir.path(), &file_path, &config, false, false).unwrap();

    assert!(result.changed);
    assert_eq!(result.operation, "delete_file");
    assert!(!file_path.exists());
    assert!(result.backup.is_some());
    assert!(dir
        .path()
        .join(".aionui")
        .join("understand")
        .join("stale.json")
        .exists());

    let conn = mtui::history::open_db(dir.path()).unwrap();
    let op = mtui::history::get_operation(&conn, &result.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(op.operation_type, "delete_file");
    assert!(op.diff_path.is_some());

    let undo_result = mtui::undo::undo_operation(dir.path(), &op).unwrap();
    assert!(undo_result.restored);
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "remove me\n");
}

#[test]
fn test_delete_file_dry_run_keeps_file() {
    let dir = setup_test_env();
    let file_path = dir.path().join("dry_delete.txt");
    write_file(&file_path, "keep me\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::delete_file(dir.path(), &file_path, &config, true, false).unwrap();

    assert!(!result.changed);
    assert!(result.dry_run);
    assert!(file_path.exists());
    assert!(result.backup.is_none());
}

#[test]
fn test_replace_text() {
    let dir = setup_test_env();
    let file_path = dir.path().join("replace_test.txt");
    write_file(&file_path, "hello world\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "world",
        "Rust",
        false,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    assert_eq!(result.matches, Some(1));
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(content.contains("hello Rust"));
}

#[test]
fn test_apply_patch_records_operation() {
    let dir = setup_test_env();
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir.path())
        .arg("init")
        .arg("-q")
        .status()
        .unwrap();
    let file_path = dir.path().join("patch_test.txt");
    write_file(&file_path, "hello\nworld\n");
    let patch = "\
diff --git a/patch_test.txt b/patch_test.txt
--- a/patch_test.txt
+++ b/patch_test.txt
@@ -1,2 +1,2 @@
 hello
-world
+MTUI
";

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::apply_unified_patch(dir.path(), patch, &config, false, &[]).unwrap();

    assert!(result.changed);
    assert_eq!(result.file_count, 1);
    assert_eq!(
        std::fs::read_to_string(&file_path)
            .unwrap()
            .replace("\r\n", "\n"),
        "hello\nMTUI\n"
    );

    let conn = mtui::history::open_db(dir.path()).unwrap();
    let ops = mtui::history::list_operations(&conn, 5).unwrap();
    assert!(ops.iter().any(|op| {
        op.command == "apply-patch"
            && op
                .file_path
                .as_deref()
                .unwrap_or("")
                .ends_with("patch_test.txt")
    }));
}

#[test]
fn test_replace_no_match() {
    let dir = setup_test_env();
    let file_path = dir.path().join("nomatch.txt");
    write_file(&file_path, "hello\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "nonexistent",
        "new",
        false,
        false,
        None,
        None,
        &config,
    );

    assert!(result.is_err());
}

#[test]
fn test_replace_multiple_matches_without_all() {
    let dir = setup_test_env();
    let file_path = dir.path().join("multi.txt");
    write_file(&file_path, "hello\nhello\nhello\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "hello",
        "hi",
        false,
        false,
        None,
        None,
        &config,
    );

    assert!(result.is_err());
}

#[test]
fn test_replace_all_flag() {
    let dir = setup_test_env();
    let file_path = dir.path().join("all.txt");
    write_file(&file_path, "hello\nworld\nhello\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "hello",
        "hi",
        true,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(content.matches("hi").count(), 2);
    assert_eq!(content.matches("hello").count(), 0);
}

#[test]
fn test_replace_dry_run() {
    let dir = setup_test_env();
    let file_path = dir.path().join("dry.txt");
    write_file(&file_path, "original\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "original",
        "changed",
        false,
        true,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(!result.changed);
    assert_eq!(std::fs::read_to_string(&file_path).unwrap(), "original\n");
}

#[test]
fn test_line_replace() {
    let dir = setup_test_env();
    let file_path = dir.path().join("lines.txt");
    write_file(&file_path, "line1\nline2\nline3\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        2,
        "REPLACED",
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    assert_eq!(result.line, Some(2));
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(content.contains("REPLACED"));
}

#[test]
fn test_line_replace_invalid_line() {
    let dir = setup_test_env();
    let file_path = dir.path().join("short.txt");
    write_file(&file_path, "line1\n");

    let config = mtui::config::MtuiConfig::default();
    let result =
        mtui::ops::line_replace(dir.path(), &file_path, 99, "x", false, None, None, &config);

    assert!(result.is_err());
}

#[test]
fn test_stale_line_replace_allows_disjoint_recent_edit() {
    let dir = setup_test_env();
    let file_path = dir.path().join("concurrent_safe.txt");
    let original = "line1\nline2\nline3\n";
    write_file(&file_path, original);

    let config = mtui::config::MtuiConfig::default();
    let expected_hash = mtui::fs::compute_hash(original.as_bytes());
    mtui::ops::line_replace(dir.path(), &file_path, 1, "A", false, None, None, &config).unwrap();
    let result = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        3,
        "B",
        false,
        Some(&expected_hash),
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    assert!(result.concurrency.as_ref().unwrap().allowed);
    assert_eq!(
        std::fs::read_to_string(&file_path).unwrap(),
        "A\nline2\nB\n"
    );
}

#[test]
fn test_stale_line_replace_blocks_overlapping_recent_edit() {
    let dir = setup_test_env();
    let file_path = dir.path().join("concurrent_conflict.txt");
    let original = "line1\nline2\nline3\n";
    write_file(&file_path, original);

    let config = mtui::config::MtuiConfig::default();
    let expected_hash = mtui::fs::compute_hash(original.as_bytes());
    mtui::ops::line_replace(dir.path(), &file_path, 2, "A", false, None, None, &config).unwrap();
    let result = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        2,
        "B",
        false,
        Some(&expected_hash),
        None,
        &config,
    );

    assert!(result.is_err());
}

#[test]
fn test_stale_line_replace_checks_all_operations_since_expected_hash() {
    let dir = setup_test_env();
    let file_path = dir.path().join("concurrent_multi_ops.txt");
    let original = "line1\nline2\nline3\nline4\n";
    write_file(&file_path, original);

    let config = mtui::config::MtuiConfig::default();
    let expected_hash = mtui::fs::compute_hash(original.as_bytes());
    mtui::ops::line_replace(dir.path(), &file_path, 2, "A", false, None, None, &config).unwrap();
    mtui::ops::line_replace(dir.path(), &file_path, 4, "D", false, None, None, &config).unwrap();
    let result = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        2,
        "B",
        false,
        Some(&expected_hash),
        None,
        &config,
    );

    assert!(result.is_err());
}

#[test]
fn test_stale_line_replace_requires_confirmation_for_related_symbols_in_same_file() {
    let dir = setup_test_env();
    let file_path = dir.path().join("symbol_dependency.ts");
    let original = "function foo() {\n  return bar();\n}\n\nfunction bar() {\n  return 1;\n}\n";
    write_file(&file_path, original);
    let cache_dir = dir.path().join(".aionui").join("understand");
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(
        cache_dir.join("summary.json"),
        serde_json::json!({
            "builtAt": 1,
            "overview": null,
            "runbook": null,
            "modules": [],
            "files": [{
                "path": "symbol_dependency.ts",
                "label": "symbol_dependency.ts",
                "group": ".",
                "layer": "service",
                "summary": "test symbols",
                "summarySource": "fallback",
                "tags": [],
                "symbols": [
                    {"name": "foo", "kind": "function", "line": 1, "endLine": 3, "calls": ["bar"]},
                    {"name": "bar", "kind": "function", "line": 5, "endLine": 7, "calls": []}
                ],
                "language": "typescript",
                "importedBy": 0,
                "fingerprint": null
            }]
        })
        .to_string(),
    )
    .unwrap();

    let config = mtui::config::MtuiConfig::default();
    let expected_hash = mtui::fs::compute_hash(original.as_bytes());
    mtui::ops::line_replace(
        dir.path(),
        &file_path,
        2,
        "  return bar() + 1;",
        false,
        None,
        None,
        &config,
    )
    .unwrap();
    let result = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        6,
        "  return 2;",
        false,
        Some(&expected_hash),
        None,
        &config,
    );

    let err = result.expect_err("related symbols should require confirmation");
    assert!(err.message().contains("Confirmation required"));
    let mtui::error::MtuiError::ConflictDetailed { details, .. } = err else {
        panic!("expected detailed conflict");
    };
    assert_eq!(
        details["resolution"]["status"].as_str(),
        Some("needs_confirmation")
    );
    assert!(details["checked_operations"][0]["diff_excerpt"]
        .as_str()
        .unwrap()
        .contains("return bar() + 1"));
    let token = details["resolution"]["confirmation_token"]
        .as_str()
        .unwrap()
        .to_string();
    let current = mtui::ops::conflict_current(dir.path());
    assert!(current.found);
    assert!(!current.stale);
    assert_eq!(current.token.as_deref(), Some(token.as_str()));
    assert_eq!(current.status.as_deref(), Some("needs_confirmation"));
    let listed = mtui::ops::conflict_list(dir.path(), 10);
    assert_eq!(listed.conflicts.len(), 1);
    let explained = mtui::ops::conflict_explain(dir.path(), Some(&token));
    assert!(explained.found);
    let accepted_args = mtui::ops::conflict_accept(dir.path(), Some(&token));
    assert!(accepted_args.accepted);
    assert_eq!(
        accepted_args.accept_args,
        vec!["--accept-stale".to_string(), token.clone()]
    );

    let accepted = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        6,
        "  return 2;",
        false,
        Some(&expected_hash),
        Some(&token),
        &config,
    )
    .unwrap();

    assert!(accepted.changed);
    assert_eq!(
        accepted.concurrency.as_ref().unwrap().resolution.status,
        "accepted"
    );
}

#[test]
fn test_stale_confirmation_token_expires_when_new_same_file_edit_arrives() {
    let dir = setup_test_env();
    let file_path = dir.path().join("symbol_dependency_expiry.ts");
    let original = "function foo() {\n  return bar();\n}\n\nfunction bar() {\n  return 1;\n}\n";
    write_file(&file_path, original);
    let cache_dir = dir.path().join(".aionui").join("understand");
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(
        cache_dir.join("summary.json"),
        serde_json::json!({
            "builtAt": 1,
            "overview": null,
            "runbook": null,
            "modules": [],
            "files": [{
                "path": "symbol_dependency_expiry.ts",
                "label": "symbol_dependency_expiry.ts",
                "group": ".",
                "layer": "service",
                "summary": "test symbols",
                "summarySource": "fallback",
                "tags": [],
                "symbols": [
                    {"name": "foo", "kind": "function", "line": 1, "endLine": 3, "calls": ["bar"]},
                    {"name": "bar", "kind": "function", "line": 5, "endLine": 7, "calls": []}
                ],
                "language": "typescript",
                "importedBy": 0,
                "fingerprint": null
            }]
        })
        .to_string(),
    )
    .unwrap();

    let config = mtui::config::MtuiConfig::default();
    let expected_hash = mtui::fs::compute_hash(original.as_bytes());
    mtui::ops::line_replace(
        dir.path(),
        &file_path,
        2,
        "  return bar() + 1;",
        false,
        None,
        None,
        &config,
    )
    .unwrap();
    let result = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        6,
        "  return 2;",
        false,
        Some(&expected_hash),
        None,
        &config,
    );
    let err = result.expect_err("related symbols should require confirmation");
    let mtui::error::MtuiError::ConflictDetailed { details, .. } = err else {
        panic!("expected detailed conflict");
    };
    let stale_token = details["resolution"]["confirmation_token"]
        .as_str()
        .unwrap()
        .to_string();

    mtui::ops::line_replace(
        dir.path(),
        &file_path,
        6,
        "  return 3;",
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    let accept_after_c = mtui::ops::conflict_accept(dir.path(), Some(&stale_token));
    assert!(!accept_after_c.accepted);
    assert!(accept_after_c.stale);
    assert!(accept_after_c.accept_args.is_empty());

    let retry = mtui::ops::line_replace(
        dir.path(),
        &file_path,
        6,
        "  return 2;",
        false,
        Some(&expected_hash),
        Some(&stale_token),
        &config,
    );
    let err = retry.expect_err("stale token must not accept a newer overlapping edit");
    assert!(err.message().contains("overlaps lines"));
}

#[test]
fn test_insert_after() {
    let dir = setup_test_env();
    let file_path = dir.path().join("insert.txt");
    write_file(&file_path, "start\nmarker\nend\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::insert_after(
        dir.path(),
        &file_path,
        "marker",
        "INSERTED",
        false,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(content.contains("marker\nINSERTED"));
}

#[test]
fn test_insert_before() {
    let dir = setup_test_env();
    let file_path = dir.path().join("insert_before.txt");
    write_file(&file_path, "start\nmarker\nend\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::insert_before(
        dir.path(),
        &file_path,
        "marker",
        "INSERTED",
        false,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(content.contains("INSERTED\nmarker"));
}

#[test]
fn test_insert_no_marker() {
    let dir = setup_test_env();
    let file_path = dir.path().join("nomarker.txt");
    write_file(&file_path, "start\nend\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::insert_after(
        dir.path(),
        &file_path,
        "notfound",
        "x",
        false,
        false,
        None,
        None,
        &config,
    );

    assert!(result.is_err());
}

#[test]
fn test_delete_text() {
    let dir = setup_test_env();
    let file_path = dir.path().join("delete.txt");
    write_file(&file_path, "keep this\nremove me\nkeep too\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::delete_text(
        dir.path(),
        &file_path,
        "remove me\n",
        false,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    let content = std::fs::read_to_string(&file_path).unwrap();
    assert!(!content.contains("remove me"));
    assert!(content.contains("keep this"));
    assert!(content.contains("keep too"));
}

#[test]
fn test_delete_no_match() {
    let dir = setup_test_env();
    let file_path = dir.path().join("nodelete.txt");
    write_file(&file_path, "content\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::delete_text(
        dir.path(),
        &file_path,
        "nothere",
        false,
        false,
        None,
        None,
        &config,
    );

    assert!(result.is_err());
}

#[test]
fn test_backup_created_on_edit() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();
    let _db_path = mtui::history::db_path(dir.path());
    let _conn = mtui::history::open_db(dir.path()).unwrap();

    let file_path = dir.path().join("backup_test.txt");
    write_file(&file_path, "original\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "original",
        "modified",
        false,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    assert!(result.changed);
    assert!(result.backup.is_some());

    let backup_path = Path::new(result.backup.as_ref().unwrap());
    assert!(backup_path.exists());

    let backup_content = std::fs::read_to_string(backup_path).unwrap();
    assert_eq!(backup_content, "original\n");
}

#[test]
fn test_undo_restores_file() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();

    let file_path = dir.path().join("undo_test.txt");
    write_file(&file_path, "original content\n");

    let config = mtui::config::MtuiConfig::default();
    let edit_result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "original content",
        "modified content",
        false,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    let conn = mtui::history::open_db(dir.path()).unwrap();
    let op_record = mtui::history::get_operation(&conn, &edit_result.operation_id)
        .unwrap()
        .unwrap();

    let undo_result = mtui::undo::undo_operation(dir.path(), &op_record).unwrap();
    assert!(undo_result.restored);

    let restored_content = std::fs::read_to_string(&file_path).unwrap();
    assert_eq!(restored_content, "original content\n");
}

#[test]
fn test_undo_conflict_detection() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();

    let file_path = dir.path().join("conflict_test.txt");
    write_file(&file_path, "original\n");

    let config = mtui::config::MtuiConfig::default();
    let edit_result = mtui::ops::replace_text(
        dir.path(),
        &file_path,
        "original",
        "modified",
        false,
        false,
        None,
        None,
        &config,
    )
    .unwrap();

    write_file(&file_path, "someone else changed this\n");

    let conn = mtui::history::open_db(dir.path()).unwrap();
    let op_record = mtui::history::get_operation(&conn, &edit_result.operation_id)
        .unwrap()
        .unwrap();

    let undo_result = mtui::undo::undo_operation(dir.path(), &op_record);
    assert!(undo_result.is_err());
}

#[test]
fn test_safety_binary_detection() {
    let content = vec![0, 1, 2, 3];
    assert!(mtui::safety::is_binary(&content));
}

#[test]
fn test_safety_text_not_binary() {
    let content = b"hello world\nthis is text\n";
    assert!(!mtui::safety::is_binary(content));
}

#[test]
fn test_config_default_values() {
    let config = mtui::config::MtuiConfig::default();
    assert_eq!(config.project_root, ".");
    assert!(!config.allow_outside_project);
    assert!(!config.default_json);
    assert!(config.ignore.patterns.contains(&".git/**".to_string()));
    assert!(config
        .ignore
        .patterns
        .contains(&"node_modules/**".to_string()));
}

#[test]
fn test_error_type_names() {
    let err = mtui::error::MtuiError::NoMatch {
        message: "test".to_string(),
        suggestion: "hint".to_string(),
    };
    assert_eq!(err.error_type(), mtui::error::ErrorType::NoMatch);
    assert_eq!(err.message(), "test");
    assert_eq!(err.suggestion(), Some("hint"));

    let err2 = mtui::error::MtuiError::MultipleMatches {
        message: "test".to_string(),
        matches: 4,
        suggestion: "hint".to_string(),
    };
    assert_eq!(err2.matches_count(), Some(4));
}

#[test]
fn test_history_operations() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();
    let conn = mtui::history::open_db(dir.path()).unwrap();

    let record = mtui::history::OperationRecord {
        operation_id: "test_op_1".to_string(),
        command: "edit".to_string(),
        operation_type: "replace".to_string(),
        cwd: "/test".to_string(),
        project_path: "/test".to_string(),
        file_path: Some("/test/file.txt".to_string()),
        before_hash: Some("abc".to_string()),
        after_hash: Some("def".to_string()),
        backup_path: None,
        diff_path: None,
        changed: true,
        created_at: "2026-06-03T00:00:00Z".to_string(),
        agent_id: Some("agent-a".to_string()),
        task_id: Some("task-1".to_string()),
        plan_id: Some("plan-1".to_string()),
    };

    mtui::history::record_operation(&conn, &record).unwrap();
    let ops = mtui::history::list_operations(&conn, 10).unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].operation_id, "test_op_1");
    assert_eq!(ops[0].agent_id.as_deref(), Some("agent-a"));

    let retrieved = mtui::history::get_operation(&conn, "test_op_1").unwrap();
    assert!(retrieved.is_some());

    let last = mtui::history::get_last_operation(&conn).unwrap();
    assert!(last.is_some());
}

#[test]
fn test_command_history() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();
    let conn = mtui::history::open_db(dir.path()).unwrap();

    mtui::history::record_command(&conn, "bun run test", "/test", "/test", 0, 5000).unwrap();

    let commands = mtui::history::list_commands(&conn, 10).unwrap();
    assert!(!commands.is_empty());
    assert_eq!(commands[0].command, "bun run test");
    assert_eq!(commands[0].used_count, 1);

    mtui::history::record_command(&conn, "bun run test", "/test", "/test", 0, 3000).unwrap();

    let commands = mtui::history::list_commands(&conn, 10).unwrap();
    assert_eq!(commands[0].used_count, 2);
    assert_eq!(commands[0].success_count, 2);
}

#[test]
fn test_suggest_prefix_matching() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();
    let conn = mtui::history::open_db(dir.path()).unwrap();

    mtui::history::record_command(&conn, "cargo build", "/test", "/test", 0, 1000).unwrap();
    mtui::history::record_command(&conn, "cargo test", "/test", "/test", 1, 2000).unwrap();
    mtui::history::record_command(&conn, "bun run", "/test", "/test", 0, 500).unwrap();

    let suggestions = mtui::suggest::suggest(&conn, "cargo", dir.path()).unwrap();
    assert!(!suggestions.is_empty());
    assert!(suggestions[0].command.contains("cargo"));
}

#[test]
fn test_repair_no_match() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();
    let conn = mtui::history::open_db(dir.path()).unwrap();

    let result = mtui::repair::repair(&conn, "unknowncmd", "nothing").unwrap();
    assert!(!result.repair_available);
}

#[test]
fn test_repair_common_builtin_typo() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();
    let conn = mtui::history::open_db(dir.path()).unwrap();

    let result = mtui::repair::repair(&conn, "bun rn test", "unknown command").unwrap();

    assert!(result.repair_available);
    assert_eq!(result.suggested_command.as_deref(), Some("bun run test"));
    assert_eq!(result.source.as_deref(), Some("builtin_typo"));
}

#[test]
fn test_repair_uses_successful_history_fuzzy_match() {
    let dir = setup_test_env();
    let _config_dir = mtui::config::ensure_config_dir(dir.path()).unwrap();
    let conn = mtui::history::open_db(dir.path()).unwrap();

    mtui::history::record_command(&conn, "bun run typecheck", "/test", "/test", 0, 1200).unwrap();
    mtui::history::record_command(&conn, "bun run test", "/test", "/test", 1, 900).unwrap();

    let result = mtui::repair::repair(&conn, "bun rn typecheck", "unknown command").unwrap();

    assert!(result.repair_available);
    assert_eq!(
        result.suggested_command.as_deref(),
        Some("bun run typecheck")
    );
    assert_eq!(result.source.as_deref(), Some("history_fuzzy"));
}

#[test]
fn test_risk_classification() {
    assert_eq!(
        mtui::safety::classify_command_risk("rm -rf /"),
        mtui::safety::RiskLevel::Destructive
    );
    assert_eq!(
        mtui::safety::classify_command_risk("sudo vim"),
        mtui::safety::RiskLevel::Privileged
    );
    assert_eq!(
        mtui::safety::classify_command_risk("curl https://example.com"),
        mtui::safety::RiskLevel::ExternalNetwork
    );
    assert_eq!(
        mtui::safety::classify_command_risk("cat file.txt"),
        mtui::safety::RiskLevel::ReadOnly
    );
    assert_eq!(
        mtui::safety::classify_command_risk("bun run test"),
        mtui::safety::RiskLevel::ProjectWrite
    );
}

#[test]
fn test_understand_summary_falls_back_to_filesystem_when_cache_missing() {
    let dir = setup_test_env();
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    write_file(
        &src.join("lib.rs"),
        "pub fn foo() -> i32 {\n    1\n}\n\nstruct Bar;\n",
    );

    let file = mtui::understand::query_file(dir.path(), Path::new("src/lib.rs"), true).unwrap();
    assert!(file.stale);
    assert!(file.summary.contains("Filesystem fallback"));
    assert_eq!(
        file.details["summarySource"].as_str(),
        Some("filesystem-fallback")
    );
    assert!(file.details["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .any(|symbol| symbol["name"].as_str() == Some("foo")));

    let folder = mtui::understand::query_folder(dir.path(), Path::new("src"), false).unwrap();
    assert!(folder.stale);
    assert_eq!(
        folder.details["summarySource"].as_str(),
        Some("filesystem-fallback")
    );
    assert_eq!(folder.details["fileCount"].as_u64(), Some(1));
}

#[test]
fn test_understand_map_folder_falls_back_to_filesystem_when_cache_missing() {
    let dir = setup_test_env();
    let src = dir.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    write_file(&src.join("main.ts"), "export const value = 1;\n");

    let map = mtui::understand::map_folder(dir.path(), Path::new("src"), 10).unwrap();

    assert!(map.stale);
    assert_eq!(map.confidence, "low");
    assert_eq!(map.files.len(), 1);
    assert_eq!(map.files[0].path, "src/main.ts");
    assert!(map.files[0]
        .next_commands
        .iter()
        .any(|command| command.contains("compass read src/main.ts")));
}

#[test]
fn test_understand_map_intent_preserves_graph_file_metadata() {
    let dir = setup_test_env();
    let src = dir.path().join("src").join("services");
    std::fs::create_dir_all(&src).unwrap();
    write_file(
        &src.join("transcriptCrawler.ts"),
        "export function crawlSubtitle() { return 'ok'; }\n",
    );
    let cache_dir = dir.path().join(".aionui").join("understand");
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(
        cache_dir.join("summary.json"),
        serde_json::json!({
            "builtAt": 42,
            "overview": null,
            "runbook": null,
            "modules": [{
                "id": "src/services",
                "label": "services",
                "layer": "service",
                "summary": "Subtitle crawling service module.",
                "fileCount": 1,
                "files": ["src/services/transcriptCrawler.ts"],
                "entryFiles": ["src/services/transcriptCrawler.ts"]
            }],
            "files": [{
                "path": "src/services/transcriptCrawler.ts",
                "label": "transcriptCrawler.ts",
                "group": "src",
                "layer": "service",
                "summary": "Crawls browser video subtitles and transcript text.",
                "summarySource": "llm",
                "tags": ["subtitle", "crawler"],
                "symbols": [{"name": "crawlSubtitle", "kind": "function", "line": 1}],
                "language": "typescript",
                "importedBy": 2,
                "fingerprint": null
            }, {
                "path": "mobile/app/index.tsx",
                "label": "index.tsx",
                "group": "mobile",
                "layer": "ui",
                "summary": "Generic mobile app entry screen.",
                "summarySource": "llm",
                "tags": [],
                "symbols": [{"name": "IndexScreen", "kind": "component", "line": 1}],
                "language": "typescriptreact",
                "importedBy": 0,
                "fingerprint": null
            }]
        })
        .to_string(),
    )
    .unwrap();

    let map = mtui::understand::map_intent(dir.path(), "subtitle crawler", 10).unwrap();

    assert_eq!(map.files.len(), 1);
    assert_eq!(map.files[0].path, "src/services/transcriptCrawler.ts");
    assert_eq!(map.files[0].layer, "service");
    assert_eq!(map.files[0].language, "typescript");
    assert_eq!(map.files[0].role, "service");
    assert_eq!(map.related_folders, vec!["src/services".to_string()]);
    assert_eq!(map.freshness.unknown_fingerprint_count, 2);
    assert!(map
        .freshness
        .sample_unknown
        .contains(&"src/services/transcriptCrawler.ts".to_string()));
}

#[test]
fn test_search_skips_build_and_cache_folders() {
    let dir = setup_test_env();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::create_dir_all(dir.path().join("target")).unwrap();
    std::fs::create_dir_all(dir.path().join("coverage")).unwrap();
    std::fs::create_dir_all(dir.path().join(".turbo")).unwrap();
    std::fs::create_dir_all(dir.path().join(".mtui")).unwrap();
    write_file(&dir.path().join("src").join("keep.txt"), "needle\n");
    write_file(&dir.path().join("target").join("ignore.txt"), "needle\n");
    write_file(&dir.path().join("coverage").join("ignore.txt"), "needle\n");
    write_file(&dir.path().join(".turbo").join("ignore.txt"), "needle\n");
    write_file(&dir.path().join(".mtui").join("ignore.txt"), "needle\n");

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search(dir.path(), Path::new("."), "needle", 10, &config).unwrap();

    assert_eq!(result.match_count, 1);
    assert!(result.matches[0].file.contains("keep.txt"));
}

#[test]
fn test_search_skips_large_files_during_directory_search() {
    let dir = setup_test_env();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    write_file(&dir.path().join("src").join("keep.txt"), "needle\n");
    write_file(
        &dir.path().join("src").join("large.log"),
        &format!("{}needle\n", "x".repeat(2 * 1024 * 1024)),
    );

    let config = mtui::config::MtuiConfig::default();
    let result = mtui::ops::search(dir.path(), Path::new("."), "needle", 10, &config).unwrap();

    assert_eq!(result.match_count, 1);
    assert!(result.matches[0].file.contains("keep.txt"));
}

#[test]
fn test_search_accepts_max_count_alias() {
    let cli = <mtui::cli::Cli as clap::Parser>::try_parse_from([
        "mtui",
        "search",
        "src",
        "needle",
        "--max-count",
        "3",
    ])
    .unwrap();

    let mtui::cli::Commands::Search(args) = cli.command else {
        panic!("expected search command");
    };
    assert_eq!(args.limit, 3);
}

#[test]
fn test_wiki_query_returns_ranked_shared_project_knowledge() {
    let dir = setup_test_env();
    let wiki_dir = dir.path().join(".omni").join("wiki");
    std::fs::create_dir_all(&wiki_dir).unwrap();
    write_file(
        &wiki_dir.join("wiki.json"),
        r#"{
          "version": 1,
          "rootPath": "/repo",
          "builtAt": 42,
          "sections": [
            {"id":"overview","titleKey":"overview","content":"A web application."},
            {"id":"api","titleKey":"api","content":"The REST API is served by services/api on port 4000."}
          ],
          "keyFiles": ["services/api/package.json"],
          "docReports": []
        }"#,
    );

    let result = mtui::understand::wiki::query_wiki(dir.path(), "api", 3).unwrap();

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].id, "api");
    assert!(result.matches[0].content.contains("services/api"));
}

#[test]
fn test_wiki_query_reports_when_the_project_wiki_has_not_been_built() {
    let dir = setup_test_env();

    let error = mtui::understand::wiki::query_wiki(dir.path(), "api", 3).unwrap_err();

    assert!(matches!(error, mtui::error::MtuiError::FileNotFound { .. }));
}

#[test]
fn test_cli_accepts_wiki_query_command() {
    let cli =
        <mtui::cli::Cli as clap::Parser>::try_parse_from(["mtui", "wiki", "api", "--limit", "2"])
            .unwrap();

    let mtui::cli::Commands::Wiki(args) = cli.command else {
        panic!("expected wiki command");
    };
    assert_eq!(args.query, "api");
    assert_eq!(args.limit, 2);
}

#[test]

fn test_invalid_args_with_json_return_json_error() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_mtui"))
        .args(["--json", "search", ".", "needle", "--definitely-invalid"])
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    let json: serde_json::Value = serde_json::from_str(&stderr).unwrap();
    assert_eq!(json["ok"].as_bool(), Some(false));
    assert_eq!(json["error_type"].as_str(), Some("INVALID_ARGUMENT"));
    assert!(json["message"]
        .as_str()
        .unwrap()
        .contains("--definitely-invalid"));
}

#[test]
fn test_policy_status_limits_violation_output_but_keeps_total_count() {
    let dir = setup_test_env();
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    for name in ["a.ts", "b.ts", "c.ts"] {
        write_file(&dir.path().join("src").join(name), "dirty\n");
    }

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_mtui"))
        .current_dir(dir.path())
        .args(["--json", "policy", "status", "--violation-limit", "2"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(json["ok"].as_bool(), Some(true));
    assert_eq!(json["violation_count"].as_u64(), Some(3));
    assert_eq!(json["violations"].as_array().unwrap().len(), 2);
    assert_eq!(json["violations_truncated"].as_bool(), Some(true));
}
