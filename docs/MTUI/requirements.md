# MTUI Requirements

## Overview

### Product Name

MTUI - Memory Terminal UI

### Product Type

MTUI is a deterministic backend terminal and file-operation layer for Omni.

MTUI is not:

```text
- an AI assistant
- an agent
- an agentic runtime
- a coding model
- a semantic reasoning engine
```

MTUI is:

```text
- a backend action utility
- a CLI-first local tool
- a file operation engine
- a terminal command helper
- a safe edit/diff/backup/undo layer
- a JSON-output provider for AI agents and Omni
```

### Main Purpose

MTUI helps Omni agents and users perform common file and terminal operations through short, deterministic, safe commands.

Instead of forcing an AI agent to generate temporary scripts like:

```python
from pathlib import Path

p = Path("file.txt")
text = p.read_text(encoding="utf-8")
text = text.replace("old", "new")
p.write_text(text, encoding="utf-8")
```

The agent can call:

```bash
mtui edit "file.txt" replace "old" "new" --json
```

MTUI handles:

```text
- file reading/writing
- exact replacement
- backup creation
- diff generation
- operation history
- undo metadata
- JSON output
- error handling
```

### Relationship with Omni

MTUI is a backend component used by Omni.

```text
Tomni Agentic / User
        |
        v
Omni App / Terminal UI
        |
        v
MTUI CLI or Sidecar Backend
        |
        v
Filesystem / Terminal History / Local Database
```

Omni may use MTUI through:

```text
- direct CLI calls
- child process spawn
- future sidecar process
- future library binding
```

MTUI does not decide what the agent should do. MTUI only executes deterministic operations requested by Omni, user, or agent.

## Scope

### In Scope

MTUI should support:

```text
- safe file creation
- safe file editing
- exact text replacement
- line-based replacement
- insert before/after marker
- delete exact text
- file search
- backup before write
- diff generation
- undo
- operation history
- command history
- command suggestion
- rule-based command repair
- codebase map queries from Understand/codegraph cache
- JSON output
- terminal-friendly human output
```

### Out of Scope

MTUI should not include:

```text
- AI model inference
- semantic code understanding
- vector search
- codebase graph reasoning
- autonomous task planning
- agent behavior
- automatic coding decisions
- LLM-powered command repair
- full IDE UI
- full Vim/VS Code replacement
```

These belong to Omni or other Omni backend systems, not MTUI.

## Functional Requirements

### Requirement 1 - CLI Interface

MTUI must provide a command-line interface named:

```bash
mtui
```

The CLI must support both JSON output for agents and Omni, and human-readable output for terminal users.

Required commands:

```bash
mtui new
mtui edit
mtui search
mtui diff
mtui undo
mtui history
mtui suggest
mtui repair
mtui map
```

All important commands must support:

```bash
--json
```

When `--json` is provided, MTUI must output valid JSON only. No ANSI color, spinner, progress bar, or human prompt may appear in JSON mode.

### Requirement 2 - File Creation

MTUI must create new files safely.

Command:

```bash
mtui new "file.txt" --content "hello" --json
```

Optional forms:

```bash
mtui new "file.txt" --content-file "content.txt" --json
mtui new "file.txt" --content-stdin --json
```

Rules:

```text
- If file already exists, do not overwrite by default.
- If overwrite is requested, create backup first.
- Parent directories may be created only if explicitly allowed or safely inferred.
- Operation must be stored in history.
- JSON output must include operation_id.
```

Example success output:

```json
{
  "ok": true,
  "command": "new",
  "operation": "create_file",
  "operation_id": "op_20260603_001",
  "file": "file.txt",
  "changed": true,
  "backup": null,
  "diff_summary": "+1 -0"
}
```

Example error output:

```json
{
  "ok": false,
  "command": "new",
  "error_type": "FILE_EXISTS",
  "message": "file.txt already exists",
  "suggestion": "Use --overwrite if you want to replace the file"
}
```

### Requirement 3 - Exact Text Replacement

MTUI must support exact text replacement.

Command:

```bash
mtui edit "file.txt" replace "old text" "new text" --json
```

Alternative safer forms:

```bash
mtui edit "file.txt" replace --old "old text" --new "new text" --json
mtui edit "file.txt" replace --old-file "old.txt" --new-file "new.txt" --json
mtui edit "file.txt" replace --old-stdin --new-file "new.txt" --json
```

Rules:

```text
- Replacement must be exact, not fuzzy.
- If no match is found, file must not be modified.
- If multiple matches are found, file must not be modified unless --all or line/range constraint is provided.
- Backup must be created before write.
- Diff must be generated after write.
- Operation history must be stored.
- Undo metadata must be stored.
```

Example success output:

```json
{
  "ok": true,
  "command": "edit",
  "operation": "replace",
  "operation_id": "op_20260603_002",
  "file": "file.txt",
  "matches": 1,
  "changed": true,
  "backup": ".mtui/backups/2026-06-03/op_20260603_002/file.txt.bak",
  "diff_summary": "+1 -1"
}
```

Example no-match output:

```json
{
  "ok": false,
  "command": "edit",
  "operation": "replace",
  "error_type": "NO_MATCH",
  "message": "Text not found in file.txt",
  "suggestion": "Use mtui search \"file.txt\" \"keyword\" --json"
}
```

Example multiple-match output:

```json
{
  "ok": false,
  "command": "edit",
  "operation": "replace",
  "error_type": "MULTIPLE_MATCHES",
  "message": "Found 4 matches in file.txt",
  "matches": 4,
  "suggestion": "Use --all, --line, or a more specific old text"
}
```

### Requirement 4 - Line-Based Replacement

MTUI must support replacing a specific line.

Command:

```bash
mtui edit "file.txt" line 20 replace "new content" --json
```

Rules:

```text
- Line number is 1-based.
- Invalid line number must not modify the file.
- Backup must be created before write.
- Diff must be generated.
- Operation must be undoable.
```

Example output:

```json
{
  "ok": true,
  "command": "edit",
  "operation": "line_replace",
  "operation_id": "op_20260603_003",
  "file": "file.txt",
  "line": 20,
  "changed": true,
  "backup": ".mtui/backups/2026-06-03/op_20260603_003/file.txt.bak",
  "diff_summary": "+1 -1"
}
```

### Requirement 5 - Insert Before / Insert After

MTUI must support deterministic insertion around an exact marker.

Commands:

```bash
mtui edit "file.txt" insert-after "marker" "new paragraph" --json
mtui edit "file.txt" insert-before "marker" "new paragraph" --json
```

Alternative forms:

```bash
mtui edit "file.txt" insert-after --marker "marker" --content-file "insert.txt" --json
mtui edit "file.txt" insert-before --marker "marker" --content-stdin --json
```

Rules:

```text
- Marker matching must be exact.
- If no marker is found, file must not be modified.
- If multiple markers are found, file must not be modified unless --all or line/range constraint is provided.
- Backup, diff, history, and undo metadata are required.
```

### Requirement 6 - Delete Exact Text

MTUI must support deleting exact text from a file.

Command:

```bash
mtui edit "file.txt" delete "text to delete" --json
```

Alternative:

```bash
mtui edit "file.txt" delete --text-file "delete.txt" --json
```

Rules:

```text
- Delete must be exact.
- No-match must not modify the file.
- Multiple matches require --all or line/range constraint.
- Backup, diff, history, and undo metadata are required.
```

### Requirement 7 - Search

MTUI must search for text in a file or path.

Commands:

```bash
mtui search "file.txt" "keyword" --json
mtui search "src" "keyword" --json
```

Rules:

```text
- Search should return matching files, line numbers, and preview snippets.
- Search should respect ignore patterns.
- Search should not scan binary files by default.
- Search must support JSON output.
```

Example output:

```json
{
  "ok": true,
  "command": "search",
  "query": "keyword",
  "matches": [
    {
      "file": "file.txt",
      "line": 12,
      "column": 5,
      "preview": "const value = \"keyword\";"
    }
  ],
  "match_count": 1
}
```

### Requirement 8 - Diff

MTUI must show diff for recent operations.

Commands:

```bash
mtui diff --json
mtui diff --operation "op_20260603_002" --json
mtui diff --last --json
```

Rules:

```text
- Diff must support operation-level diff.
- Diff must support last operation.
- Diff should support transaction-level diff in future.
- JSON output must include summary and optionally diff text.
```

Example output:

```json
{
  "ok": true,
  "command": "diff",
  "operation_id": "op_20260603_002",
  "files": [
    {
      "file": "file.txt",
      "insertions": 1,
      "deletions": 1,
      "diff": "@@ -1 +1 @@\n-old\n+new"
    }
  ],
  "diff_summary": "+1 -1"
}
```

### Requirement 9 - Undo

MTUI must undo previous file operations safely.

Commands:

```bash
mtui undo --json
mtui undo --last --json
mtui undo --operation "op_20260603_002" --json
```

Rules:

```text
- Undo must restore from backup or inverse patch.
- Undo must verify file hash before applying.
- If file was changed after the operation, undo must fail with conflict.
- Undo must create its own operation history entry.
- Undo must be available only for supported operations.
```

Conflict output:

```json
{
  "ok": false,
  "command": "undo",
  "operation_id": "op_20260603_002",
  "error_type": "CONFLICT",
  "message": "File changed after operation; undo is not safe",
  "suggestion": "Review the diff manually before restoring"
}
```

### Requirement 10 - Dry Run

MTUI must support dry-run for write operations.

Command:

```bash
mtui edit "file.txt" replace "old" "new" --dry-run --json
```

Rules:

```text
- Dry-run must not modify files.
- Dry-run must not create backup.
- Dry-run may compute diff preview.
- Dry-run output must clearly say dry_run: true.
```

Example output:

```json
{
  "ok": true,
  "command": "edit",
  "operation": "replace",
  "dry_run": true,
  "file": "file.txt",
  "matches": 1,
  "would_change": true,
  "diff_summary": "+1 -1"
}
```

### Requirement 11 - Operation History

MTUI must store operation history.

Each file operation should store:

```text
- operation_id
- command
- operation type
- cwd
- project_path
- file path
- before hash
- after hash
- backup path
- diff path
- changed
- created_at
```

History command:

```bash
mtui history --json
mtui history --limit 20 --json
```

Example output:

```json
{
  "ok": true,
  "command": "history",
  "operations": [
    {
      "operation_id": "op_20260603_002",
      "operation": "replace",
      "file": "file.txt",
      "changed": true,
      "created_at": "2026-06-03T10:12:00Z"
    }
  ]
}
```

### Requirement 12 - Command History

MTUI must store terminal command history.

Stored fields:

```text
- command
- cwd
- project_path
- exit_code
- duration_ms
- used_count
- success_count
- failure_count
- last_used
- created_at
```

Possible command:

```bash
mtui history commands --json
```

Example output:

```json
{
  "ok": true,
  "command": "history",
  "history_type": "commands",
  "items": [
    {
      "command": "bun run test",
      "cwd": "C:/Project/App",
      "exit_code": 0,
      "duration_ms": 8200,
      "used_count": 18,
      "success_rate": 1.0,
      "last_used": "2026-06-03T10:12:00Z"
    }
  ]
}
```

### Requirement 13 - Command Suggestion

MTUI must suggest terminal commands from local history and known project commands.

Command:

```bash
mtui suggest "b" --json
```

Suggestion ranking should be rule-based, not AI-based.

Score should consider:

```text
- prefix match
- same project
- same cwd
- success rate
- frequency
- recency
- exact script match from package.json or project config
```

Example output:

```json
{
  "ok": true,
  "command": "suggest",
  "query": "b",
  "suggestions": [
    {
      "command": "bun start",
      "score": 92,
      "success_rate": 1.0,
      "used_count": 18,
      "last_used": "2026-06-03T10:12:00Z",
      "source": "history"
    }
  ]
}
```

### Requirement 14 - Rule-Based Command Repair

MTUI must support simple command repair based on deterministic rules.

Command:

```bash
mtui repair --command "gemini" --stderr "deprecated, use agi" --json
```

or:

```bash
mtui repair --command "gemini" --stderr-file ".mtui/tmp/stderr.log" --json
```

Rules:

```text
- Repair must be rule-based.
- No LLM should be used.
- Repair must not auto-run replacement commands by default.
- Dangerous replacements must require confirmation in Omni or shell integration.
- MTUI only outputs suggestion and risk level.
```

Example output:

```json
{
  "ok": true,
  "command": "repair",
  "repair_available": true,
  "original_command": "gemini",
  "suggested_command": "agi",
  "message": "gemini appears to be replaced by agi",
  "source": "local_rule",
  "risk": "unknown",
  "requires_confirm": true
}
```

No repair output:

```json
{
  "ok": true,
  "command": "repair",
  "repair_available": false,
  "original_command": "unknowncmd",
  "suggestion": null
}
```

### Requirement 15 - Safety Policy

MTUI must include basic safety rules.

Path safety:

```text
- default to project root
- prevent writing outside project root unless explicitly allowed
- detect symlink escape
- ignore binary files by default
- avoid editing ignored folders by default
```

Ignored folders:

```text
.git
node_modules
dist
build
target
vendor
```

Command risk classifications:

```text
read_only
project_write
external_network
destructive
privileged
unknown
```

MTUI itself should not be responsible for user confirmation UI in all environments, but it should output structured risk metadata:

```json
{
  "requires_confirm": true,
  "risk": "destructive"
}
```

Omni or shell integration can decide how to prompt the user.

### Requirement 16 - Local Storage

MTUI must store local state in a `.mtui` directory.

Recommended structure:

```text
.mtui/
|-- config.toml
|-- mtui.db
|-- backups/
|   `-- 2026-06-03/
|-- diffs/
|   `-- op_xxx.diff
|-- operations/
|   `-- op_xxx.json
`-- tmp/
```

SQLite should be used for structured data.

Files should be used for:

```text
- backups
- full diffs
- large command logs
```

### Requirement 17 - Cross-Platform Support

MTUI must work on:

```text
- Windows
- macOS
- Linux
```

Special attention:

```text
- Windows path handling
- Unicode paths
- CRLF/LF handling
- UTF-8 files
- shell quoting
```

### Requirement 18 - Future MTUI Line

At the final stage, MTUI should be able to become a lightweight standalone tool named conceptually:

```text
MTUI Line
```

MTUI Line should only include lower-level utility layers:

```text
Layer 1: safe file operation backend
Layer 2: command history/suggestion/repair backend
```

MTUI Line should not include Omni-specific features. It should be downloadable and usable quickly on any terminal machine.

Example:

```bash
mtui new hello.txt --content "hello" --json
mtui edit hello.txt replace "hello" "hi" --json
mtui suggest "b" --json
```

### Requirement 19 - Agent Terminal Replacement Surface

For repository work, an agent must be able to use MTUI as its only terminal-facing interface. MTUI may delegate to deterministic system programs internally, but callers must not need shell pipelines or shell-specific state.

Required coverage:

```text
- bounded Unicode-safe file reads
- literal and regex search with include/exclude globs, context, files-only, and counts
- file-tree statistics (direct children, files, directories, lines, bytes, extensions, largest files)
- verification and generic program execution with an explicit working directory
- compact pass/fail output with retrievable full logs
- safe file creation/edit/delete/apply-patch with history, diff, and undo
- fresh filesystem fallback/overlay when Understand data is missing or stale
- a deterministic `run` fallback for programs not yet represented by a native primitive
```

Efficiency and reliability gates:

```text
- JSON mode emits compact machine-readable output by default
- empty optional collections are omitted
- no command may panic on valid UTF-8 input or Unicode paths
- paths in repository results are repo-relative when possible
- limited/truncated results must say so accurately and must not claim an unknown total
- a representative IDE audit must complete without a normal-shell fallback
```

## Non-Functional Requirements

### Performance

MTUI should be fast startup, low memory, suitable for repeated CLI calls, and efficient for common file edits.

Targets:

```text
- simple file edit under 100ms for small files
- command suggestion under 50ms
- no long-running background process required for MVP
```

### Reliability

MTUI must:

```text
- avoid modifying files on error
- never partially write files without backup
- use atomic writes where possible
- preserve encoding and newline style when possible
- detect conflicts before undo
```

### Determinism

MTUI must produce predictable results.

```text
Same input + same file state = same output
```

No AI reasoning should be inside MTUI.

### Agent Compatibility

MTUI must be easy for agents to call.

Therefore:

```text
- short CLI syntax
- JSON output
- stable error_type values
- no interactive prompt in --json mode
- clear exit codes
```

### Human Compatibility

MTUI should also be useful for terminal users.

Without `--json`, output may be human-readable:

```text
Edited file.txt
Operation: replace
Matches: 1
Diff: +1 -1
Undo: mtui undo --operation op_20260603_002
```

## Suggested MVP Cut

```text
MVP 1:
- mtui new
- mtui search
- mtui edit replace
- mtui edit line replace
- mtui edit insert-after
- mtui edit insert-before
- mtui edit delete
- mtui diff
- mtui undo
- --json
- backup
- operation history
- dry-run

MVP 2:
- command history
- mtui suggest
- project script discovery

MVP 3:
- mtui repair
- command risk classification
- Omni terminal integration

Future:
- MTUI Line standalone distribution
- sidecar mode
- optional TUI review/editor
```

## Final Definition

MTUI is a deterministic backend utility layer for Omni that provides safe file operations, diff, backup, undo, command history, command suggestion, and rule-based command repair through a CLI-first JSON interface. It contains no AI and performs no agentic reasoning.

Shorter version:

MTUI is a non-AI backend action layer that helps agents and users operate files and terminal commands safely, quickly, and with structured JSON output.
