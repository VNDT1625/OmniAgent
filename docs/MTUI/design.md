# MTUI Design

## High-Level Architecture

```text
MTUI
|-- CLI Layer
|   |-- clap parser
|   |-- command routing
|   `-- output mode selection
|
|-- File Operation Engine
|   |-- new file
|   |-- replace
|   |-- line replace
|   |-- insert before/after
|   |-- delete
|   `-- search
|
|-- Safety Engine
|   |-- path validation
|   |-- ignored path detection
|   |-- symlink escape detection
|   |-- binary detection
|   `-- command risk classification
|
|-- Backup Engine
|   |-- backup path generation
|   |-- file copy
|   `-- metadata storage
|
|-- Diff Engine
|   |-- before/after diff
|   |-- summary generation
|   `-- diff file storage
|
|-- Undo Engine
|   |-- operation lookup
|   |-- hash validation
|   |-- restore backup
|   `-- conflict detection
|
|-- History Engine
|   |-- operation history
|   |-- command history
|   `-- SQLite storage
|
|-- Suggestion Engine
|   |-- command prefix matching
|   |-- project command discovery
|   |-- scoring
|   `-- ranked output
|
|-- Repair Engine
|   |-- local repair rules
|   |-- stderr matching
|   |-- replacement suggestion
|   `-- risk metadata
|
`-- Output Layer
    |-- JSON output
    |-- human output
    `-- error formatting
```

## Recommended Rust Crates

```text
clap              CLI parser
serde             serialization
serde_json        JSON output
rusqlite          SQLite database
anyhow            application error handling
thiserror         typed errors
similar or diffy  diff generation
ignore            ignore-aware filesystem traversal
walkdir           directory walking
sha2 or blake3    file hashing
chrono            timestamps
uuid              operation ids
tempfile          atomic write support
```

Optional later:

```text
ratatui           future TUI
crossterm         future terminal UI
```

## CLI Design

### Main Command Tree

```text
mtui
|-- new
|-- edit
|   |-- replace
|   |-- line
|   |-- insert-before
|   |-- insert-after
|   `-- delete
|-- search
|-- stats
|-- diff
|-- undo
|-- history
|   |-- operations
|   `-- commands
|-- suggest
|-- repair
`-- map
```

Possible command syntax:

```bash
mtui new <file> --content <text> [--json]

mtui edit <file> replace <old> <new> [--json]
mtui edit <file> line <line> replace <content> [--json]
mtui edit <file> insert-after <marker> <content> [--json]
mtui edit <file> insert-before <marker> <content> [--json]
mtui edit <file> delete <text> [--json]

mtui search <path> <query> [--json]
mtui search <path> <query> [--regex] [--ignore-case] [--glob <pattern>] [--exclude <pattern>] [--context <n>] [--files-with-matches | --count] [--json]

mtui stats <path> [--largest <n>] [--max-files <n>] [--json]

mtui diff [--last] [--operation <id>] [--json]

mtui undo [--last] [--operation <id>] [--json]

mtui history operations [--limit <n>] [--json]
mtui history commands [--limit <n>] [--json]

mtui suggest <prefix> [--json]

mtui repair --command <command> [--stderr <text> | --stderr-file <file>] [--json]

mtui map repo [--json]
mtui map folder <path> [--json]
mtui map intent "<intent>" [--json]
```

## Output Design

All JSON responses should follow a shared envelope.

Success envelope:

```json
{
  "ok": true,
  "command": "edit",
  "operation": "replace",
  "operation_id": "op_xxx",
  "changed": true
}
```

Error envelope:

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

Required error types:

```text
NO_MATCH
MULTIPLE_MATCHES
FILE_NOT_FOUND
FILE_EXISTS
PATH_OUTSIDE_PROJECT
PATH_IGNORED
BINARY_FILE
ENCODING_ERROR
PERMISSION_DENIED
INVALID_ARGUMENT
BACKUP_FAILED
WRITE_FAILED
DIFF_FAILED
UNDO_NOT_AVAILABLE
CONFLICT
COMMAND_BLOCKED
COMMAND_NEEDS_CONFIRM
REPAIR_NOT_FOUND
INTERNAL_ERROR
```

## Storage Design

### `.mtui/config.toml`

Example:

```toml
project_root = "."
allow_outside_project = false
default_json = false

[ignore]
patterns = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "target/**",
  "vendor/**"
]
```

### SQLite Tables

#### operations

```sql
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project_path TEXT NOT NULL,
  file_path TEXT,
  before_hash TEXT,
  after_hash TEXT,
  backup_path TEXT,
  diff_path TEXT,
  changed INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

#### command_history

```sql
CREATE TABLE command_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project_path TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  used_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  last_used TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

#### repair_rules

```sql
CREATE TABLE repair_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_command TEXT NOT NULL,
  stderr_contains TEXT,
  suggested_command TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT,
  risk TEXT NOT NULL,
  requires_confirm INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## File Operation Flow

For write operations:

```text
1. Parse command.
2. Resolve project root.
3. Validate path.
4. Read file.
5. Detect binary/encoding.
6. Compute operation.
7. If no match or invalid input, return error.
8. If dry-run, return preview without write.
9. Compute before hash.
10. Create backup.
11. Write file atomically.
12. Compute after hash.
13. Generate diff.
14. Store operation history.
15. Return JSON/human output.
```

## Undo Flow

```text
1. Resolve target operation.
2. Load operation metadata.
3. Check backup exists.
4. Read current file.
5. Compute current hash.
6. Compare current hash with operation after_hash.
7. If mismatch, return CONFLICT.
8. Restore backup atomically.
9. Generate undo operation entry.
10. Return output.
```

## Suggestion Scoring

Example scoring:

```text
score =
  prefix_score
+ project_score
+ cwd_score
+ success_score
+ frequency_score
+ recency_score
+ project_script_score
```

Suggested weights:

```text
prefix_score:        0-40
same_project:        0-15
same_cwd:            0-10
success_rate:        0-15
frequency:           0-10
recency:             0-10
project_script:      0-20
```

Maximum score can exceed 100, then normalize to 0-100.

## Repair Rule Design

Repair rules should be deterministic.

Example rule:

```json
{
  "match_command": "gemini",
  "stderr_contains": "deprecated|replaced|agi",
  "suggested_command": "agi",
  "message": "gemini appears to be replaced by agi",
  "source": "local_rule",
  "risk": "unknown",
  "requires_confirm": true
}
```

MTUI should only return the suggestion. Omni or the shell integration decides whether to ask:

```text
gemini updated -> agi
Use agi instead? [Y/n]
```

## Integration with Omni

Omni can use MTUI in three ways.

### Phase 1 - CLI Spawn

```text
Electron Main -> child_process.spawn("mtui", args)
```

Best for MVP.

### Phase 2 - Embedded Service / Sidecar

```text
Electron Main -> mtuid sidecar -> JSON-RPC
```

Better for realtime integration.

### Phase 3 - Library / MTUI Line

Expose MTUI as:

```text
- standalone CLI
- optional Rust library
- optional npm wrapper
```
