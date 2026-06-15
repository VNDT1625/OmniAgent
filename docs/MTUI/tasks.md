# MTUI Tasks

## Phase 0 - Project Setup

### Task 0.1 - Create Rust project

Create Rust CLI project for MTUI.

Deliverables:

```text
- Cargo.toml
- src/main.rs
- src/lib.rs
- basic CLI entry
```

Acceptance criteria:

```text
- `mtui --help` works
- project builds on Windows/macOS/Linux
```

### Task 0.2 - Add dependencies

Add required crates:

```text
clap
serde
serde_json
rusqlite
anyhow
thiserror
similar or diffy
ignore
walkdir
blake3 or sha2
chrono
uuid
tempfile
```

Acceptance criteria:

```text
- dependencies compile
- no unused initial modules if possible
```

### Task 0.3 - Define module structure

Recommended structure:

```text
src/
|-- main.rs
|-- lib.rs
|-- cli/
|-- output/
|-- error/
|-- fs/
|-- ops/
|-- diff/
|-- backup/
|-- undo/
|-- history/
|-- suggest/
|-- repair/
|-- safety/
`-- config/
```

Acceptance criteria:

```text
- modules are separated by responsibility
- no module mixes CLI parsing with core operation logic
```

## Phase 1 - Core Output and Error System

### Task 1.1 - Implement JSON output envelope

Create shared response structs.

Acceptance criteria:

```text
- success responses serialize to valid JSON
- error responses serialize to valid JSON
- --json mode outputs JSON only
```

### Task 1.2 - Implement typed error system

Define error enum:

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

Acceptance criteria:

```text
- each error maps to stable error_type
- each error can produce JSON output
```

## Phase 2 - Storage and Config

### Task 2.1 - Implement `.mtui` directory initialization

MTUI should create `.mtui` when needed.

Acceptance criteria:

```text
- `.mtui` is created in project root
- backups/diffs/operations/tmp directories are created
```

### Task 2.2 - Implement config loading

Support `.mtui/config.toml`.

Acceptance criteria:

```text
- default config works if file missing
- ignore patterns are loaded
- project root is resolved
```

### Task 2.3 - Implement SQLite database

Create tables:

```text
operations
command_history
repair_rules
```

Acceptance criteria:

```text
- database is created automatically
- schema migration is safe for first version
```

## Phase 3 - Safety Engine

### Task 3.1 - Implement path validation

Acceptance criteria:

```text
- writing outside project root is blocked by default
- symlink escape is detected
- ignored directories are respected
```

### Task 3.2 - Implement binary file detection

Acceptance criteria:

```text
- binary files are not edited by default
- JSON error uses BINARY_FILE
```

### Task 3.3 - Implement atomic write helper

Acceptance criteria:

```text
- writes are atomic where supported
- failed writes do not corrupt original file
```

## Phase 4 - Backup and Diff

### Task 4.1 - Implement backup engine

Acceptance criteria:

```text
- backup is created before every real write
- backup path includes operation id
- backup path is returned in output
```

### Task 4.2 - Implement diff engine

Acceptance criteria:

```text
- unified diff can be generated
- diff summary includes insertions/deletions
- diff file is stored under `.mtui/diffs`
```

## Phase 5 - File Operations

### Task 5.1 - Implement `mtui new`

Acceptance criteria:

```text
- creates file with content
- supports --content
- supports --content-file
- supports --content-stdin
- refuses overwrite unless requested
- supports --json
```

### Task 5.2 - Implement `mtui search`

Acceptance criteria:

```text
- searches file
- searches directory
- returns line/column/preview
- respects ignore patterns
- supports --json
```

### Task 5.3 - Implement `mtui edit replace`

Acceptance criteria:

```text
- exact replace works
- no match does not modify file
- multiple match requires --all or constraint
- backup/diff/history are recorded
- supports dry-run
- supports --json
```

### Task 5.4 - Implement `mtui edit line replace`

Acceptance criteria:

```text
- line number is 1-based
- invalid line does not modify file
- backup/diff/history are recorded
- supports dry-run
- supports --json
```

### Task 5.5 - Implement `mtui edit insert-after`

Acceptance criteria:

```text
- exact marker search
- no match does not modify file
- multiple match requires --all or constraint
- backup/diff/history are recorded
- supports dry-run
- supports --json
```

### Task 5.6 - Implement `mtui edit insert-before`

Acceptance criteria:

```text
- exact marker search
- no match does not modify file
- multiple match requires --all or constraint
- backup/diff/history are recorded
- supports dry-run
- supports --json
```

### Task 5.7 - Implement `mtui edit delete`

Acceptance criteria:

```text
- exact delete works
- no match does not modify file
- multiple match requires --all or constraint
- backup/diff/history are recorded
- supports dry-run
- supports --json
```

## Phase 6 - Operation History, Diff, Undo

### Task 6.1 - Store operation history

Acceptance criteria:

```text
- every write operation has operation_id
- before_hash and after_hash are stored
- backup path and diff path are stored
```

### Task 6.2 - Implement `mtui diff`

Acceptance criteria:

```text
- `mtui diff --last --json` works
- `mtui diff --operation <id> --json` works
- returns diff summary and diff content/path
```

### Task 6.3 - Implement `mtui undo`

Acceptance criteria:

```text
- undo last operation works
- undo by operation id works
- conflict detection works
- undo creates a new operation record
```

## Phase 7 - Command History

### Task 7.1 - Implement command history storage API

Acceptance criteria:

```text
- can record command, cwd, exit code, duration
- updates used_count, success_count, failure_count
- stores last_used
```

### Task 7.2 - Implement `mtui history commands`

Acceptance criteria:

```text
- lists recent commands
- supports --limit
- supports --json
```

### Task 7.3 - Add shell/Omni integration endpoint for recording commands

Possible command:

```bash
mtui history record --command "bun run test" --exit-code 0 --duration-ms 8200 --json
```

Acceptance criteria:

```text
- external terminal integration can record command results
- JSON response confirms record
```

## Phase 8 - Suggestion Engine

### Task 8.1 - Implement prefix matching

Acceptance criteria:

```text
- `mtui suggest "b" --json` returns matching history commands
- prefix matches rank higher
```

### Task 8.2 - Implement scoring

Acceptance criteria:

```text
- score considers prefix, same project, same cwd, success rate, frequency, recency
- output is sorted by score desc
```

### Task 8.3 - Add project script discovery

Detect common project commands from:

```text
package.json
justfile
Makefile
Cargo.toml
```

Acceptance criteria:

```text
- project scripts appear in suggestions
- source field says project_script/history
```

## Phase 9 - Repair Engine

### Task 9.1 - Implement repair rule storage

Acceptance criteria:

```text
- repair rules can be loaded from SQLite or config file
- built-in rules can be added safely
```

### Task 9.2 - Implement `mtui repair`

Acceptance criteria:

```text
- accepts command and stderr
- matches deterministic rules
- returns suggested command
- returns requires_confirm and risk
- does not auto-run command
```

### Task 9.3 - Implement risk classification

Acceptance criteria:

```text
- classifies simple commands
- destructive commands are marked destructive
- unknown commands are marked unknown
```

## Phase 10 - Human Output

### Task 10.1 - Implement human-readable output

Acceptance criteria:

```text
- without --json, output is readable
- errors are concise
- includes undo hint when relevant
```

Example:

```text
Edited file.txt
Operation: replace
Matches: 1
Diff: +1 -1
Undo: mtui undo --operation op_20260603_002
```

## Phase 11 - Testing

### Task 11.1 - Unit tests for file operations

Acceptance criteria:

```text
- replace tested
- line replace tested
- insert before/after tested
- delete tested
- no-match tested
- multiple-match tested
```

### Task 11.2 - Unit tests for safety

Acceptance criteria:

```text
- path outside project blocked
- ignored path blocked
- binary file blocked
- symlink escape blocked
```

### Task 11.3 - Unit tests for backup/diff/undo

Acceptance criteria:

```text
- backup created
- diff generated
- undo restores file
- conflict prevents undo
```

### Task 11.4 - Unit tests for suggestion and repair

Acceptance criteria:

```text
- prefix suggestion works
- scoring order works
- repair rule matches
- no repair returns repair_available false
```

## Phase 12 - Omni Integration

### Task 12.1 - Add Omni spawn wrapper

Omni should call MTUI from Electron Main.

Acceptance criteria:

```text
- Omni can run mtui command
- stdout JSON is parsed
- stderr/error is handled
```

### Task 12.2 - Add terminal command record integration

When Omni terminal runs a command, it should record result into MTUI.

Acceptance criteria:

```text
- command, cwd, exit_code, duration_ms are stored
- failed commands are also stored
```

### Task 12.3 - Add terminal suggestion integration

Omni terminal can call:

```bash
mtui suggest "<prefix>" --json
```

Acceptance criteria:

```text
- suggestions appear in Omni terminal UI
- suggestions are local and deterministic
```

### Task 12.4 - Add repair prompt integration

When a command fails, Omni can call:

```bash
mtui repair --command "<cmd>" --stderr-file "<file>" --json
```

Acceptance criteria:

```text
- if repair_available, Omni shows a prompt
- replacement command is not auto-run without user confirmation
```

## Phase 13 - Future MTUI Line

### Task 13.1 - Define MTUI Line package boundary

MTUI Line should include:

```text
- CLI
- file operation engine
- backup/diff/undo
- command history
- command suggestion
- command repair
```

MTUI Line should exclude:

```text
- Omni-specific graph
- Omni-specific UI
- agent orchestration
- vector docs
- AI integration
```

### Task 13.2 - Add standalone installer

Possible distribution:

```text
- GitHub release binary
- cargo install
- npm wrapper
- PowerShell install script
- shell install script
```

Acceptance criteria:

```text
- user can install quickly
- `mtui --version` works
- basic commands work outside Omni
```

### Task 13.3 - Add documentation

Docs should include:

```text
- quick start
- file edit commands
- diff/undo
- command suggestion
- repair rules
- JSON output schema
- safety policy
```
