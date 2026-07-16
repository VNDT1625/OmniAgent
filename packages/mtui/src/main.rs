mod analyze;
mod backup;
mod cli;
mod compact;
mod config;
mod diff;
mod doctor;
mod error;
mod exp;
mod fs;
mod history;
mod ops;
mod output;
mod policy;
mod pricing;
mod repair;
mod safety;
mod suggest;
mod tasks;
mod understand;
mod undo;

use clap::Parser;
use cli::{
    Commands, CompassQuery, ConflictQuery, EditOperation, ExpQuery, HistoryType, MapQuery,
    MemoryQuery, PolicyQuery, PricingQuery, TasksQuery, UnderstandQuery, VerifyCommand,
};
use output::OutputMode;
use std::io::Read;

fn main() {
    let cli = match cli::Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            if std::env::args().any(|arg| arg == "--json") {
                let mtui_error = error::MtuiError::InvalidArgument {
                    message: err.to_string(),
                    suggestion: "Run `mtui --help` or `mtui <command> --help` for valid arguments."
                        .to_string(),
                };
                let response = error::ErrorResponse::from_error(&mtui_error, "mtui", None);
                output::print_error_json(&response);
                std::process::exit(err.exit_code());
            }
            err.exit();
        }
    };
    let output_mode = if cli.json {
        OutputMode::Json
    } else {
        OutputMode::Human
    };

    if let Err(err) = run(cli, output_mode) {
        match output_mode {
            OutputMode::Json => {
                let response = error::ErrorResponse::from_error(&err, "mtui", None);
                output::print_error_json(&response);
            }
            OutputMode::Human => {
                output::print_human_error(&err);
            }
        }
        std::process::exit(1);
    }
}

fn run(cli: cli::Cli, output_mode: OutputMode) -> Result<(), error::MtuiError> {
    let project_root = config::resolve_project_root().map_err(|e| error::MtuiError::Internal {
        message: format!("Failed to resolve project root: {}", e),
    })?;

    let cfg = config::load_config(&project_root).map_err(|e| error::MtuiError::Internal {
        message: format!("Failed to load config: {}", e),
    })?;

    config::ensure_config_dir(&project_root).ok();

    match cli.command {
        Commands::New(args) => {
            let content = resolve_new_content(&args)?;
            let result = ops::create_file(
                &project_root,
                std::path::Path::new(&args.file),
                content.as_bytes(),
                args.overwrite,
                &cfg,
                args.dry_run,
            )?;

            match output_mode {
                OutputMode::Json => output::print_json(&output::SuccessResponse::new(&result)),
                OutputMode::Human => {
                    println!("Created {}", result.file);
                    println!("Operation: {}", result.operation);
                    println!("Operation ID: {}", result.operation_id);
                    println!("Diff: {}", result.diff_summary);
                }
            }
        }

        Commands::Delete(args) => {
            let result = ops::delete_file(
                &project_root,
                std::path::Path::new(&args.file),
                &cfg,
                args.dry_run,
                args.force,
            )?;

            match output_mode {
                OutputMode::Json => output::print_json(&output::SuccessResponse::new(&result)),
                OutputMode::Human => {
                    if result.dry_run {
                        println!("Would delete {}", result.file);
                    } else {
                        println!("Deleted {}", result.file);
                        println!("Undo: mtui undo --operation {}", result.operation_id);
                    }
                    println!("Operation: {}", result.operation);
                    println!("Diff: {}", result.diff_summary);
                }
            }
        }

        Commands::Edit(args) => match args.operation {
            EditOperation::Replace(replace_args) => {
                let result = ops::replace_text(
                    &project_root,
                    std::path::Path::new(&args.file),
                    &replace_args.old,
                    &replace_args.new,
                    replace_args.all,
                    replace_args.dry_run,
                    replace_args.expect_hash.as_deref(),
                    replace_args.accept_stale.as_deref(),
                    &cfg,
                )?;

                match output_mode {
                    OutputMode::Json => {
                        if replace_args.dry_run {
                            #[derive(serde::Serialize)]
                            struct DryRunResult {
                                command: String,
                                operation: String,
                                dry_run: bool,
                                file: String,
                                matches: Option<usize>,
                                would_change: bool,
                                diff_summary: String,
                            }
                            let dr = DryRunResult {
                                command: result.command,
                                operation: result.operation,
                                dry_run: true,
                                file: result.file,
                                matches: result.matches,
                                would_change: result.changed,
                                diff_summary: result.diff_summary,
                            };
                            output::print_json(&output::SuccessResponse::new(&dr));
                        } else {
                            output::print_json(&output::SuccessResponse::new(&result));
                        }
                    }
                    OutputMode::Human => {
                        println!("Edited {}", result.file);
                        println!("Operation: {}", result.operation);
                        println!("Matches: {:?}", result.matches);
                        println!("Diff: {}", result.diff_summary);
                        println!("Undo: mtui undo --operation {}", result.operation_id);
                    }
                }
            }

            EditOperation::Line(line_args) => {
                let result = ops::line_replace(
                    &project_root,
                    std::path::Path::new(&args.file),
                    line_args.line,
                    &line_args.content,
                    line_args.dry_run,
                    line_args.expect_hash.as_deref(),
                    line_args.accept_stale.as_deref(),
                    &cfg,
                )?;

                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("Edited {}", result.file);
                        println!("Operation: {}", result.operation);
                        println!("Line: {:?}", result.line);
                        println!("Diff: {}", result.diff_summary);
                        println!("Undo: mtui undo --operation {}", result.operation_id);
                    }
                }
            }

            EditOperation::InsertAfter(insert_args) => {
                let content = resolve_insert_content(&insert_args)?;
                let result = ops::insert_after(
                    &project_root,
                    std::path::Path::new(&args.file),
                    &insert_args.marker,
                    &content,
                    insert_args.all,
                    insert_args.dry_run,
                    insert_args.expect_hash.as_deref(),
                    insert_args.accept_stale.as_deref(),
                    &cfg,
                )?;

                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("Edited {}", result.file);
                        println!("Operation: {}", result.operation);
                        println!("Diff: {}", result.diff_summary);
                        println!("Undo: mtui undo --operation {}", result.operation_id);
                    }
                }
            }

            EditOperation::InsertBefore(insert_args) => {
                let content = resolve_insert_content(&insert_args)?;
                let result = ops::insert_before(
                    &project_root,
                    std::path::Path::new(&args.file),
                    &insert_args.marker,
                    &content,
                    insert_args.all,
                    insert_args.dry_run,
                    insert_args.expect_hash.as_deref(),
                    insert_args.accept_stale.as_deref(),
                    &cfg,
                )?;

                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("Edited {}", result.file);
                        println!("Operation: {}", result.operation);
                        println!("Diff: {}", result.diff_summary);
                        println!("Undo: mtui undo --operation {}", result.operation_id);
                    }
                }
            }

            EditOperation::Delete(delete_args) => {
                let text = resolve_delete_text(&delete_args)?;
                let result = ops::delete_text(
                    &project_root,
                    std::path::Path::new(&args.file),
                    &text,
                    delete_args.all,
                    delete_args.dry_run,
                    delete_args.expect_hash.as_deref(),
                    delete_args.accept_stale.as_deref(),
                    &cfg,
                )?;

                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("Edited {}", result.file);
                        println!("Operation: {}", result.operation);
                        println!("Diff: {}", result.diff_summary);
                        println!("Undo: mtui undo --operation {}", result.operation_id);
                    }
                }
            }
        },

        Commands::ApplyPatch(args) => {
            let patch_text = resolve_patch_content(&args)?;
            let result = ops::apply_unified_patch(
                &project_root,
                &patch_text,
                &cfg,
                args.dry_run,
                &args.expect_hash,
            )?;

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!(
                        "Applied patch: {} file(s), dry_run={}",
                        result.file_count, result.dry_run
                    );
                    for file in &result.files {
                        println!("{} {} {}", file.operation_id, file.file, file.diff_summary);
                    }
                }
            }
        }

        Commands::Read(args) => {
            let result = ops::read_file(
                &project_root,
                std::path::Path::new(&args.file),
                &cfg,
                ops::ReadOptions {
                    from: args.from,
                    to: args.to,
                    max_lines: args.max_lines,
                    max_chars: args.max_chars,
                    all: args.all,
                    line_numbers: !args.no_line_numbers,
                },
            )?;

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("{}", result.text);
                    if result.truncated {
                        eprintln!(
                            "[mtui read] returned {} of {} lines. Use --all, --from/--to, or larger limits for more.",
                            result.returned_lines,
                            result.total_lines
                        );
                    }
                }
            }
        }

        Commands::Search(args) => {
            let result = ops::search_with_options(
                &project_root,
                std::path::Path::new(&args.path),
                &args.query,
                ops::SearchOptions {
                    limit: args.limit,
                    regex: args.regex,
                    ignore_case: args.ignore_case,
                    include_globs: args.globs,
                    exclude_globs: args.excludes,
                    context: args.context,
                    files_with_matches: args.files_with_matches,
                    count: args.count,
                },
                &cfg,
            )?;

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    if result.counts.is_empty() && result.files.is_empty() {
                        for m in &result.matches {
                            println!("{}:{}:{}", m.file, m.line, m.column);
                            for line in &m.before {
                                println!("  - {}", line);
                            }
                            println!("  > {}", m.preview);
                            for line in &m.after {
                                println!("  + {}", line);
                            }
                        }
                    } else if !result.counts.is_empty() {
                        for item in &result.counts {
                            println!("{}:{}", item.file, item.matching_lines);
                        }
                    } else {
                        for file in &result.files {
                            println!("{}", file);
                        }
                    }
                    println!("Found {} matches", result.match_count);
                }
            }
        }

        Commands::Diff(args) => {
            let conn = history::open_db(&project_root).map_err(|e| error::MtuiError::Internal {
                message: format!("Database error: {}", e),
            })?;

            let operation_id = if args.last {
                None
            } else {
                args.operation.as_deref()
            };

            let result = ops::get_diff(&conn, &project_root, operation_id)?;

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    for f in &result.files {
                        println!("File: {}", f.file);
                        println!("{}", f.diff);
                    }
                }
            }
        }

        Commands::Undo(args) => {
            let conn = history::open_db(&project_root).map_err(|e| error::MtuiError::Internal {
                message: format!("Database error: {}", e),
            })?;

            let operation = if args.last || args.operation.is_none() {
                history::get_last_operation(&conn).map_err(|e| error::MtuiError::Internal {
                    message: format!("Database error: {}", e),
                })?
            } else {
                history::get_operation(&conn, args.operation.as_deref().unwrap()).map_err(|e| {
                    error::MtuiError::Internal {
                        message: format!("Database error: {}", e),
                    }
                })?
            };

            let operation = operation.ok_or_else(|| error::MtuiError::UndoNotAvailable {
                message: "No operation to undo".to_string(),
                suggestion: "Perform a file operation first".to_string(),
            })?;

            let result = undo::undo_operation(&project_root, &operation)?;

            let now = chrono::Utc::now().to_rfc3339();
            let short_id = &uuid::Uuid::new_v4().to_string()[..8];
            let undo_id = format!("undo_{}", short_id);
            let undo_record = history::OperationRecord {
                operation_id: undo_id,
                command: "undo".to_string(),
                operation_type: "undo".to_string(),
                cwd: std::env::current_dir()
                    .unwrap_or_default()
                    .display()
                    .to_string(),
                project_path: project_root.display().to_string(),
                file_path: Some(result.file.clone()),
                before_hash: None,
                after_hash: None,
                backup_path: None,
                diff_path: None,
                changed: true,
                created_at: now,
                agent_id: std::env::var("MTUI_AGENT_ID").ok(),
                task_id: std::env::var("MTUI_TASK_ID").ok(),
                plan_id: std::env::var("MTUI_PLAN_ID").ok(),
            };
            history::record_operation(&conn, &undo_record).ok();

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("Undone: {}", result.operation_id);
                    println!("Restored: {}", result.file);
                }
            }
        }

        Commands::History(args) => {
            let conn = history::open_db(&project_root).map_err(|e| error::MtuiError::Internal {
                message: format!("Database error: {}", e),
            })?;

            let limit = args.limit.unwrap_or(20);

            match args.history_type {
                Some(HistoryType::Commands) => {
                    let commands = history::list_commands(&conn, limit).map_err(|e| {
                        error::MtuiError::Internal {
                            message: format!("Database error: {}", e),
                        }
                    })?;

                    let result = ops::CommandHistoryResult {
                        command: "history".to_string(),
                        history_type: "commands".to_string(),
                        items: commands,
                    };

                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result));
                        }
                        OutputMode::Human => {
                            for cmd in &result.items {
                                let rate = if cmd.used_count > 0 {
                                    cmd.success_count as f64 / cmd.used_count as f64
                                } else {
                                    0.0
                                };
                                println!(
                                    "{} (used: {}, success: {:.0}%, last: {})",
                                    cmd.command,
                                    cmd.used_count,
                                    rate * 100.0,
                                    cmd.last_used
                                );
                            }
                        }
                    }
                }

                Some(HistoryType::Record(record_args)) => {
                    let cwd = std::env::current_dir()
                        .unwrap_or_default()
                        .display()
                        .to_string();
                    history::record_command(
                        &conn,
                        &record_args.command,
                        &cwd,
                        &project_root.display().to_string(),
                        record_args.exit_code,
                        record_args.duration_ms,
                    )
                    .map_err(|e| error::MtuiError::Internal {
                        message: format!("Failed to record command: {}", e),
                    })?;

                    #[derive(serde::Serialize)]
                    struct RecordResult {
                        command: String,
                        recorded: bool,
                    }
                    let result = RecordResult {
                        command: "history".to_string(),
                        recorded: true,
                    };

                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result));
                        }
                        OutputMode::Human => {
                            println!("Recorded command: {}", record_args.command);
                        }
                    }
                }

                _ => {
                    let operations = history::list_operations(&conn, limit).map_err(|e| {
                        error::MtuiError::Internal {
                            message: format!("Database error: {}", e),
                        }
                    })?;

                    let result = ops::HistoryResult {
                        command: "history".to_string(),
                        operations,
                    };

                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result));
                        }
                        OutputMode::Human => {
                            for op in &result.operations {
                                println!(
                                    "{} {} {} (changed: {}, {})",
                                    op.operation_id,
                                    op.operation_type,
                                    op.file_path.as_deref().unwrap_or("N/A"),
                                    op.changed,
                                    op.created_at
                                );
                            }
                        }
                    }
                }
            }
        }

        Commands::Suggest(args) => {
            let conn = history::open_db(&project_root).map_err(|e| error::MtuiError::Internal {
                message: format!("Database error: {}", e),
            })?;

            let suggestions =
                suggest::suggest(&conn, &args.prefix, &project_root).map_err(|e| {
                    error::MtuiError::Internal {
                        message: format!("Suggestion error: {}", e),
                    }
                })?;

            #[derive(serde::Serialize)]
            struct SuggestResult<'a> {
                command: &'static str,
                query: String,
                suggestions: &'a [suggest::Suggestion],
            }

            let result = SuggestResult {
                command: "suggest",
                query: args.prefix,
                suggestions: &suggestions,
            };

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    for s in suggestions {
                        println!(
                            "{} (score: {}, success: {:.0}%, used: {}, source: {})",
                            s.command, s.score, s.success_rate, s.used_count, s.source
                        );
                    }
                }
            }
        }

        Commands::Repair(args) => {
            let conn = history::open_db(&project_root).map_err(|e| error::MtuiError::Internal {
                message: format!("Database error: {}", e),
            })?;

            let stderr = if let Some(ref path) = args.stderr_file {
                std::fs::read_to_string(path).unwrap_or_default()
            } else {
                args.stderr.unwrap_or_default()
            };

            let result = repair::repair(&conn, &args.command, &stderr).map_err(|e| {
                error::MtuiError::Internal {
                    message: format!("Repair error: {}", e),
                }
            })?;

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    if result.repair_available {
                        println!("{}", result.message.as_deref().unwrap_or(""));
                        println!(
                            "Suggested: {}",
                            result.suggested_command.as_deref().unwrap_or("")
                        );
                        println!(
                            "Risk: {:?}, Confirm: {:?}",
                            result.risk, result.requires_confirm
                        );
                    } else {
                        println!("No repair available for: {}", result.original_command);
                    }
                }
            }
        }

        Commands::Compact(args) => {
            let input = if let Some(ref id) = args.retrieve {
                compact::retrieve_full_input(&project_root, id)?
            } else if let Some(ref path) = args.file {
                std::fs::read_to_string(path).map_err(|_| error::MtuiError::FileNotFound {
                    message: format!("Compact input file not found: {}", path),
                    suggestion: "Check the file path or pipe content on stdin".to_string(),
                })?
            } else {
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf).map_err(|e| {
                    error::MtuiError::InvalidArgument {
                        message: format!("Failed to read stdin: {}", e),
                        suggestion: "Pipe command output into `mtui compact` or pass --file"
                            .to_string(),
                    }
                })?;
                buf
            };
            let saved = if args.save && args.retrieve.is_none() {
                Some(compact::save_full_input(&project_root, &input)?)
            } else {
                None
            };
            let result = compact::compact_text(
                &input,
                compact::CompactOptions {
                    all: args.all || args.retrieve.is_some(),
                    profile: args.profile,
                    max_lines: args.max_lines,
                    max_chars: args.max_chars,
                    saved_id: saved.as_ref().map(|(id, _)| id.clone()),
                    saved_path: saved.as_ref().map(|(_, path)| path.clone()),
                },
            );

            match output_mode {
                OutputMode::Json => output::print_json(&output::SuccessResponse::new(&result)),
                OutputMode::Human => {
                    println!("{}", result.text);
                    if result.compacted {
                        eprintln!(
                            "[mtui compact] {} -> {} lines (omitted {}, important {}, repeated-noise {})",
                            result.original_lines,
                            result.output_lines,
                            result.omitted_lines,
                            result.important_lines,
                            result.repeated_noise_lines
                        );
                        if let Some(id) = &result.saved_id {
                            eprintln!(
                                "[mtui compact] Retrieve full input: mtui compact --retrieve {}",
                                id
                            );
                        } else {
                            eprintln!(
                                "[mtui compact] Use `mtui compact --all` to return the full input, or --save to keep piped input retrievable."
                            );
                        }
                    }
                }
            }
        }

        Commands::Verify(args) => {
            let result = match args.command {
                VerifyCommand::Python(python_args) => {
                    let script = safety::validate_path(
                        std::path::Path::new(&python_args.script),
                        &project_root,
                        &cfg,
                    )?;
                    let mut command_args = vec![script.display().to_string()];
                    command_args.extend(python_args.args);
                    let cwd = python_args
                        .cwd
                        .as_deref()
                        .map(|value| {
                            safety::validate_path(std::path::Path::new(value), &project_root, &cfg)
                        })
                        .transpose()?;
                    ops::run_verification(
                        &project_root,
                        ops::VerifyOptions {
                            mode: "python".to_string(),
                            program: python_args.python_bin,
                            args: command_args,
                            cwd,
                            spec: python_args.spec,
                            all: python_args.all,
                            profile: python_args.profile.or_else(|| Some("python".to_string())),
                            max_lines: python_args.max_lines,
                            max_chars: python_args.max_chars,
                        },
                    )?
                }
                VerifyCommand::Run(run_args) => {
                    let cwd = run_args
                        .cwd
                        .as_deref()
                        .map(|value| {
                            safety::validate_path(std::path::Path::new(value), &project_root, &cfg)
                        })
                        .transpose()?;
                    ops::run_verification(
                        &project_root,
                        ops::VerifyOptions {
                            mode: "run".to_string(),
                            program: run_args.program,
                            args: run_args.args,
                            cwd,
                            spec: run_args.spec,
                            all: run_args.all,
                            profile: run_args.profile,
                            max_lines: run_args.max_lines,
                            max_chars: run_args.max_chars,
                        },
                    )?
                }
            };

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("{}", result.summary);
                    if !result.output.trim().is_empty() {
                        println!("{}", result.output);
                    }
                    println!("Full log: {}", result.full_log_path);
                }
            }
        }

        Commands::Run(run_args) => {
            let cwd = run_args
                .cwd
                .as_deref()
                .map(|value| {
                    safety::validate_path(std::path::Path::new(value), &project_root, &cfg)
                })
                .transpose()?;
            let result = ops::run_verification(
                &project_root,
                ops::VerifyOptions {
                    mode: "fallback".to_string(),
                    program: run_args.program,
                    args: run_args.args,
                    cwd,
                    spec: run_args.spec,
                    all: run_args.all,
                    profile: run_args.profile,
                    max_lines: run_args.max_lines,
                    max_chars: run_args.max_chars,
                },
            )?;

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("{}", result.summary);
                    if !result.output.trim().is_empty() {
                        println!("{}", result.output);
                    }
                    println!("Full log: {}", result.full_log_path);
                }
            }
        }

        Commands::Tasks(args) => {
            let mode = match args.query {
                TasksQuery::Current => "current",
                TasksQuery::Done => "done",
                TasksQuery::List => "list",
            };
            let result = tasks::query_tasks(&project_root, args.spec.as_deref(), mode)?;

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("Spec: .aionui/specs/{}/", result.spec);
                    println!(
                        "Tasks: {}/{} done, {} pending, {} active, {} blocked",
                        result.counts.done,
                        result.counts.total,
                        result.counts.pending,
                        result.counts.in_progress,
                        result.counts.blocked
                    );
                    for task in &result.tasks {
                        println!("{:?} {} {}", task.status, task.id, task.title);
                    }
                }
            }
        }

        Commands::Policy(args) => match args.query {
            PolicyQuery::Status(status_args) => {
                let conn =
                    history::open_db(&project_root).map_err(|e| error::MtuiError::Internal {
                        message: format!("Database error: {}", e),
                    })?;
                let operations =
                    history::list_operations(&conn, status_args.limit.unwrap_or(10_000)).map_err(
                        |e| error::MtuiError::Internal {
                            message: format!("Database error: {}", e),
                        },
                    )?;
                let auto_session = status_args
                    .auto_session
                    .then_some(policy::PolicyAutoSession {
                        owner: status_args.owner,
                        note: status_args.note,
                    });
                let mut result = if let Some(auto_session) = auto_session {
                    policy::policy_status_with_auto_session(
                        &project_root,
                        &operations,
                        Some(auto_session),
                    )?
                } else {
                    policy::policy_status(&project_root, &operations)?
                };
                if result.violations.len() > status_args.violation_limit {
                    result.violations.truncate(status_args.violation_limit);
                    result.violations_truncated = true;
                }

                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!(
                            "Strict MTUI: {}",
                            if result.clean { "clean" } else { "violations" }
                        );
                        println!(
                            "Changed files: {}, baseline files: {}, session baseline files: {}, MTUI operations checked: {}",
                            result.changed_count,
                            result.baseline_count,
                            result.session_baseline_count,
                            result.mtui_operation_count
                        );
                        if let Some(session) = &result.session {
                            println!(
                                "Session baseline: owner {}, created {}",
                                session.owner, session.created_at
                            );
                        }
                        if result.auto_session_created {
                            println!(
                                "Session baseline was created automatically for this status check."
                            );
                        }
                        for violation in &result.violations {
                            println!("{}: {}", violation.path, violation.reason);
                        }
                    }
                }
            }
            PolicyQuery::Baseline => {
                let result = policy::write_policy_baseline(&project_root)?;
                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("Policy baseline: {}", result.baseline_file);
                        println!("Accepted current changed files: {}", result.baseline_count);
                    }
                }
            }
            PolicyQuery::SessionStart(session_args) => {
                let result = policy::write_policy_session_baseline(
                    &project_root,
                    &session_args.owner,
                    session_args.note,
                    session_args.all,
                )?;
                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("Policy session baseline: {}", result.session_file);
                        println!(
                            "Accepted current changed files for this session: {}",
                            result.session_baseline_count
                        );
                    }
                }
            }
            PolicyQuery::SessionClear => {
                let result = policy::clear_policy_session_baseline(&project_root)?;
                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!(
                            "Policy session baseline {}: {}",
                            if result.cleared {
                                "cleared"
                            } else {
                                "not found"
                            },
                            result.session_file
                        );
                    }
                }
            }
        },

        Commands::Pricing(args) => match args.query {
            PricingQuery::Model(model_args) => {
                let result =
                    pricing::lookup_model(&project_root, &model_args.model, model_args.refresh)?;
                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("{} ({})", result.name, result.id);
                        println!(
                            "input ${:.6}/1M, output ${:.6}/1M",
                            result.prompt_per_million_usd, result.completion_per_million_usd
                        );
                        if let Some(cache_read) = result.input_cache_read_per_million_usd {
                            println!("cache read ${:.6}/1M", cache_read);
                        }
                        println!(
                            "source: {}, cached: {}, fetched_at: {}",
                            result.source, result.cached, result.fetched_at
                        );
                    }
                }
            }
            PricingQuery::Estimate(estimate_args) => {
                let result = pricing::estimate(
                    &project_root,
                    &estimate_args.model,
                    estimate_args.input_tokens,
                    estimate_args.output_tokens,
                    estimate_args.cached_input_tokens,
                    estimate_args.refresh,
                )?;
                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("{} ({})", result.model.name, result.model.id);
                        println!("input: ${:.9}", result.input_cost_usd);
                        println!("output: ${:.9}", result.output_cost_usd);
                        println!("cached input: ${:.9}", result.cached_input_cost_usd);
                        println!("total: ${:.9}", result.total_cost_usd);
                    }
                }
            }
        },

        Commands::Summary(args) => {
            let result = match args.query {
                UnderstandQuery::File(path_args) => understand::query_file(
                    &project_root,
                    std::path::Path::new(&path_args.path),
                    false,
                )?,
                UnderstandQuery::Folder(path_args) => understand::query_folder(
                    &project_root,
                    std::path::Path::new(&path_args.path),
                    false,
                )?,
            };

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("{}: {}", result.target_type, result.target);
                    println!("Stale: {}", result.stale);
                    println!("{}", result.summary);
                }
            }
        }

        Commands::Compass(args) => {
            let result = match args.query {
                CompassQuery::Read(read_args) => ops::compass_read_file(
                    &project_root,
                    std::path::Path::new(&read_args.file),
                    &cfg,
                    ops::CompassReadOptions {
                        query: read_args.query,
                        max_lines: read_args.max_lines,
                        max_chars: read_args.max_chars,
                    },
                )?,
            };

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("{}", result.text);
                    eprintln!(
                        "[mtui compass] {} -> {} lines, omitted {}, truncated {}",
                        result.total_lines,
                        result.returned_lines,
                        result.omitted_lines,
                        result.truncated
                    );
                }
            }
        }

        Commands::Context(args) => {
            let result = understand::query_context(&project_root, &args.intent, args.limit)?;
            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("Intent: {}", result.intent);
                    println!("Stale: {}", result.stale);
                    for candidate in &result.candidates {
                        println!(
                            "{} score={} {}",
                            candidate.path, candidate.score, candidate.reason
                        );
                        println!("  {}", candidate.summary);
                    }
                }
            }
        }

        Commands::Wiki(args) => {
            let result = understand::wiki::query_wiki(&project_root, &args.query, args.limit)?;
            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("Wiki query: {}", result.query);
                    println!("Built at: {}", result.built_at);
                    if result.matches.is_empty() {
                        println!("No matching Wiki sections.");
                    }
                    for item in &result.matches {
                        println!("\n## {} (score {})", item.title, item.score);
                        println!("{}", item.content);
                    }
                }
            }
        }

        Commands::Map(args) => {
            let result = match args.query {
                MapQuery::Repo(repo_args) => understand::map_repo(&project_root, repo_args.limit)?,
                MapQuery::Folder(folder_args) => understand::map_folder(
                    &project_root,
                    std::path::Path::new(&folder_args.path),
                    folder_args.limit,
                )?,
                MapQuery::Intent(intent_args) => {
                    understand::map_intent(&project_root, &intent_args.intent, intent_args.limit)?
                }
            };
            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("Map {}: {}", result.scope, result.target);
                    println!("Stale: {}, confidence: {}", result.stale, result.confidence);
                    if let Some(overview) = &result.overview {
                        println!("{}", overview.description);
                    }
                    for module in &result.modules {
                        println!("{} [{}] {}", module.path, module.layer, module.summary);
                    }
                    for file in &result.files {
                        println!("#{} {} ({})", file.read_priority, file.path, file.role);
                        println!("  {}", file.summary);
                    }
                    for command in &result.next_commands {
                        println!("next: {}", command);
                    }
                }
            }
        }

        Commands::Analyze(args) => {
            let is_type = args.target.as_deref() == Some("type");
            if is_type {
                let result = analyze::run(&project_root, args.max_files)?;
                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!("Analyzed {} code file(s)", result.total_files);
                        for entry in &result.languages {
                            println!(
                                "{:>5}  {:<16} {:>5.1}%  -> {} ({:?}{})",
                                entry.file_count,
                                entry.language,
                                entry.share_percent,
                                entry.engine.kind,
                                entry.engine.cost,
                                entry
                                    .engine
                                    .server
                                    .as_ref()
                                    .map(|server| format!(", {}", server))
                                    .unwrap_or_default()
                            );
                        }
                        if !result.dominant.is_empty() {
                            println!("Dominant: {}", result.dominant.join(", "));
                        }
                    }
                }
            } else {
                let result =
                    analyze::run_check(&project_root, args.target.as_deref(), args.max_files)?;
                match output_mode {
                    OutputMode::Json => {
                        output::print_json(&output::SuccessResponse::new(&result));
                    }
                    OutputMode::Human => {
                        println!(
                            "Error-check {}: {} issue(s)",
                            result.target, result.total_issues
                        );
                        for check in &result.checks {
                            match check.status.as_str() {
                                "ran" => {
                                    println!("[{}] {} issue(s)", check.tool, check.issues.len());
                                    for issue in &check.issues {
                                        println!(
                                            "  {}:{}:{}: {}",
                                            issue.file, issue.line, issue.column, issue.message
                                        );
                                    }
                                }
                                "skipped-missing-tool" => {
                                    println!(
                                        "[{}] skipped (not on PATH); try: {}",
                                        check.tool,
                                        check.suggested_command.as_deref().unwrap_or("")
                                    );
                                }
                                _ => {
                                    println!(
                                        "[{}] suggested: {}",
                                        check.tool,
                                        check.suggested_command.as_deref().unwrap_or("")
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        Commands::Stats(args) => {
            let target =
                safety::validate_path(std::path::Path::new(&args.path), &project_root, &cfg)?;
            let result = analyze::run_stats(&project_root, &target, args.max_files, args.largest)?;
            match output_mode {
                OutputMode::Json => output::print_json(&output::SuccessResponse::new(&result)),
                OutputMode::Human => {
                    println!(
                        "{}: {} direct children, {} files, {} directories, {} lines, {} bytes{}",
                        result.target,
                        result.direct_children,
                        result.total_files,
                        result.total_directories,
                        result.total_lines,
                        result.total_bytes,
                        if result.truncated { " (truncated)" } else { "" }
                    );
                    for file in &result.largest_files {
                        println!(
                            "{:>7} lines {:>10} bytes  {}",
                            file.lines, file.bytes, file.path
                        );
                    }
                }
            }
        }

        Commands::Memory(args) => {
            let result = match args.query {
                MemoryQuery::Compact(compact_args) => ops::compact_memory(
                    &project_root,
                    compact_args.spec.as_deref(),
                    compact_args.limit,
                )?,
            };
            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("{}", result.summary);
                    for operation in &result.operations {
                        println!(
                            "{} {} {:?}",
                            operation.id, operation.operation_type, operation.file
                        );
                    }
                }
            }
        }

        Commands::Conflict(args) => {
            let result = match args.query {
                ConflictQuery::Current => ops::conflict_current(&project_root),
                ConflictQuery::List { limit } => ops::conflict_list(&project_root, limit),
                ConflictQuery::Explain { token } => {
                    ops::conflict_explain(&project_root, token.as_deref())
                }
                ConflictQuery::Accept { token } => {
                    ops::conflict_accept(&project_root, token.as_deref())
                }
            };
            match output_mode {
                OutputMode::Json => output::print_json(&output::SuccessResponse::new(&result)),
                OutputMode::Human => {
                    println!("{}", result.message);
                    if let Some(token) = result.token {
                        println!("Token: {}", token);
                    }
                    if !result.accept_args.is_empty() {
                        println!("Accept args: {}", result.accept_args.join(" "));
                    }
                }
            }
        }

        Commands::Info(args) => {
            let result = match args.query {
                UnderstandQuery::File(path_args) => understand::query_file(
                    &project_root,
                    std::path::Path::new(&path_args.path),
                    true,
                )?,
                UnderstandQuery::Folder(path_args) => understand::query_folder(
                    &project_root,
                    std::path::Path::new(&path_args.path),
                    true,
                )?,
            };

            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("{}: {}", result.target_type, result.target);
                    println!("Stale: {}", result.stale);
                    println!("{}", result.summary);
                }
            }
        }

        Commands::Doctor => {
            let result = doctor::run(&project_root);
            match output_mode {
                OutputMode::Json => {
                    output::print_json(&output::SuccessResponse::new(&result));
                }
                OutputMode::Human => {
                    println!("MTUI doctor");
                    println!("current_exe: {}", result.current_exe);
                    if let Some(latest) = &result.latest_version_dir {
                        println!("latest_version_dir: {}", latest);
                    }
                    println!(
                        "path_has_latest_version: {}",
                        result.path_has_latest_version
                    );
                    println!("understand_cache: {}", result.understand_cache.exists);
                    for recommendation in &result.recommendations {
                        println!("recommendation: {}", recommendation);
                    }
                }
            }
        }

        Commands::Exp(args) => {
            let now_ms = chrono::Utc::now().timestamp_millis() as f64;
            let now_iso = chrono::Utc::now().to_rfc3339();
            match args.query {
                ExpQuery::Search(search_args) => {
                    let query = exp::SearchQuery {
                        text: search_args.query.clone(),
                        frameworks: search_args.framework,
                        packages: search_args.package,
                        files: search_args.file,
                        commands: search_args.command,
                        error_category: search_args.error,
                        kind: search_args.kind,
                        tags: search_args.tag,
                        limit: search_args.limit,
                        min_score: search_args.min_score,
                    };
                    let projection = exp::load_projection(&project_root)?;
                    let suggestions = match &projection {
                        Some(p) => exp::search(p, &query, now_ms),
                        None => Vec::new(),
                    };
                    let result = exp::SearchResult {
                        command: "exp.search",
                        query: search_args.query,
                        count: suggestions.len(),
                        stale_index: projection.is_none(),
                        suggestions,
                    };
                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result))
                        }
                        OutputMode::Human => {
                            if result.suggestions.is_empty() {
                                println!("No ExpBase suggestions found.");
                            }
                            for suggestion in &result.suggestions {
                                println!(
                                    "[{:.2}] {} ({})",
                                    suggestion.score, suggestion.symptom, suggestion.kind
                                );
                                println!("  lesson: {}", suggestion.lesson);
                                if !suggestion.why_relevant.is_empty() {
                                    println!("  why: {}", suggestion.why_relevant.join(", "));
                                }
                            }
                        }
                    }
                }
                ExpQuery::Get(get_args) => {
                    let projection = exp::load_projection(&project_root)?;
                    let entry = projection
                        .and_then(|p| p.entries.into_iter().find(|e| e.id == get_args.id));
                    let result = exp::GetResult {
                        command: "exp.get",
                        found: entry.is_some(),
                        entry,
                    };
                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result))
                        }
                        OutputMode::Human => match &result.entry {
                            Some(entry) => {
                                println!("{} [{}] {}", entry.id, entry.kind, entry.symptom);
                                println!("lesson: {}", entry.lesson);
                            }
                            None => println!("Entry not found: {}", get_args.id),
                        },
                    }
                }
                ExpQuery::List(list_args) => {
                    let projection = exp::load_projection(&project_root)?;
                    let mut entries = projection.map(|p| p.entries).unwrap_or_default();
                    if let Some(kind) = &list_args.kind {
                        entries.retain(|e| &e.kind == kind);
                    }
                    entries.truncate(list_args.limit);
                    let result = exp::ListResult {
                        command: "exp.list",
                        count: entries.len(),
                        entries,
                    };
                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result))
                        }
                        OutputMode::Human => {
                            for entry in &result.entries {
                                println!("{} [{}] {}", entry.id, entry.kind, entry.symptom);
                            }
                        }
                    }
                }
                ExpQuery::Add(add_args) => {
                    let draft: serde_json::Value = if add_args.stdin {
                        let mut buf = String::new();
                        std::io::stdin().read_to_string(&mut buf).map_err(|e| {
                            error::MtuiError::InvalidArgument {
                                message: format!("Failed to read stdin: {}", e),
                                suggestion: "Pipe a JSON draft object into `mtui exp add --stdin`"
                                    .to_string(),
                            }
                        })?;
                        serde_json::from_str(&buf).map_err(|e| {
                            error::MtuiError::InvalidArgument {
                                message: format!("Invalid draft JSON: {}", e),
                                suggestion: "Provide a JSON object matching ExperienceEntryDraft"
                                    .to_string(),
                            }
                        })?
                    } else {
                        let symptom =
                            add_args
                                .symptom
                                .ok_or_else(|| error::MtuiError::InvalidArgument {
                                    message: "Missing --symptom".to_string(),
                                    suggestion:
                                        "Pass --symptom \"...\" or use --stdin with a JSON draft"
                                            .to_string(),
                                })?;
                        let mut context = serde_json::Map::new();
                        context.insert(
                            "frameworks".to_string(),
                            serde_json::json!(add_args.framework),
                        );
                        context.insert("packages".to_string(), serde_json::json!(add_args.package));
                        context.insert("files".to_string(), serde_json::json!(add_args.file));
                        context.insert("commands".to_string(), serde_json::json!(add_args.command));
                        if let Some(error_category) = add_args.error {
                            context.insert(
                                "errorCategory".to_string(),
                                serde_json::json!(error_category),
                            );
                        }
                        let mut draft = serde_json::Map::new();
                        draft.insert("kind".to_string(), serde_json::json!(add_args.kind));
                        draft.insert(
                            "symptoms".to_string(),
                            serde_json::json!({ "summary": symptom }),
                        );
                        draft.insert("context".to_string(), serde_json::Value::Object(context));
                        draft.insert("tags".to_string(), serde_json::json!(add_args.tag));
                        if let Some(lesson) = add_args.lesson {
                            draft.insert("lesson".to_string(), serde_json::json!(lesson));
                        }
                        if let Some(root_cause) = add_args.root_cause {
                            draft.insert("rootCause".to_string(), serde_json::json!(root_cause));
                        }
                        if let Some(fix) = add_args.fix {
                            draft.insert("fix".to_string(), serde_json::json!({ "summary": fix, "steps": [], "changedFiles": [] }));
                        }
                        if let Some(confidence) = add_args.confidence {
                            draft.insert("confidence".to_string(), serde_json::json!(confidence));
                        }
                        serde_json::Value::Object(draft)
                    };
                    let path = exp::queue_add(&project_root, &draft, &now_iso)?;
                    let result = exp::QueueResult {
                        command: "exp.add",
                        queued: true,
                        file: path.display().to_string(),
                        note: "Draft queued; the engine embeds and dedupes it on the next drain."
                            .to_string(),
                    };
                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result))
                        }
                        OutputMode::Human => println!("Queued experience draft to {}", result.file),
                    }
                }
                ExpQuery::Forget(forget_args) => {
                    let path = exp::queue_forget(&project_root, &forget_args.id)?;
                    let result = exp::QueueResult {
                        command: "exp.forget",
                        queued: true,
                        file: path.display().to_string(),
                        note:
                            "Id queued for archival; hidden from search until the engine rebuilds."
                                .to_string(),
                    };
                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result))
                        }
                        OutputMode::Human => println!("Queued forget for {}", forget_args.id),
                    }
                }
                ExpQuery::Feedback(feedback_args) => {
                    let helped = if feedback_args.helpful {
                        true
                    } else if feedback_args.unhelpful {
                        false
                    } else {
                        return Err(error::MtuiError::InvalidArgument {
                            message: "Specify --helpful or --unhelpful".to_string(),
                            suggestion: "mtui exp feedback <id> --helpful  (or --unhelpful)"
                                .to_string(),
                        });
                    };
                    let path = exp::queue_feedback(&project_root, &feedback_args.id, helped)?;
                    let result = exp::QueueResult {
                        command: "exp.feedback",
                        queued: true,
                        file: path.display().to_string(),
                        note: "Feedback queued; the engine adjusts confidence on the next drain."
                            .to_string(),
                    };
                    match output_mode {
                        OutputMode::Json => {
                            output::print_json(&output::SuccessResponse::new(&result))
                        }
                        OutputMode::Human => println!(
                            "Queued {} feedback for {}",
                            if helped { "helpful" } else { "unhelpful" },
                            feedback_args.id
                        ),
                    }
                }
            }
        }
    }

    Ok(())
}

fn resolve_new_content(args: &cli::NewArgs) -> Result<String, error::MtuiError> {
    if args.content_stdin {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf).map_err(|e| {
            error::MtuiError::InvalidArgument {
                message: format!("Failed to read from stdin: {}", e),
                suggestion: "Check that stdin is available".to_string(),
            }
        })?;
        return Ok(buf);
    }

    if let Some(ref path) = args.content_file {
        return std::fs::read_to_string(path).map_err(|_| error::MtuiError::FileNotFound {
            message: format!("Content file not found: {}", path),
            suggestion: "Check the file path".to_string(),
        });
    }

    if let Some(ref content) = args.content {
        return Ok(content.clone());
    }

    Err(error::MtuiError::InvalidArgument {
        message: "No content provided".to_string(),
        suggestion: "Use --content, --content-file, or --content-stdin".to_string(),
    })
}

fn resolve_insert_content(args: &cli::InsertArgs) -> Result<String, error::MtuiError> {
    if let Some(ref path) = args.content_file {
        return std::fs::read_to_string(path).map_err(|_| error::MtuiError::FileNotFound {
            message: format!("Content file not found: {}", path),
            suggestion: "Check the file path".to_string(),
        });
    }

    Ok(args.content.clone())
}

fn resolve_patch_content(args: &cli::ApplyPatchArgs) -> Result<String, error::MtuiError> {
    match (&args.file, args.stdin) {
        (Some(_), true) => Err(error::MtuiError::InvalidArgument {
            message: "Use either --file or --stdin, not both".to_string(),
            suggestion: "Pass one patch source".to_string(),
        }),
        (Some(path), false) => {
            std::fs::read_to_string(path).map_err(|_| error::MtuiError::FileNotFound {
                message: format!("Patch file not found: {}", path),
                suggestion: "Check the patch path".to_string(),
            })
        }
        (None, true) => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| {
                error::MtuiError::InvalidArgument {
                    message: format!("Failed to read patch from stdin: {}", e),
                    suggestion: "Pipe a unified diff into `mtui apply-patch --stdin`".to_string(),
                }
            })?;
            Ok(buf)
        }
        (None, false) => Err(error::MtuiError::InvalidArgument {
            message: "No patch source provided".to_string(),
            suggestion: "Use --file <patch.diff> or --stdin".to_string(),
        }),
    }
}

fn resolve_delete_text(args: &cli::DeleteArgs) -> Result<String, error::MtuiError> {
    if let Some(ref path) = args.text_file {
        return std::fs::read_to_string(path).map_err(|_| error::MtuiError::FileNotFound {
            message: format!("Text file not found: {}", path),
            suggestion: "Check the file path".to_string(),
        });
    }

    Ok(args.text.clone())
}
