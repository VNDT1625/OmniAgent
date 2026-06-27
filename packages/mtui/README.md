# MTUI — Memory Terminal UI

Deterministic backend terminal and file-operation layer. No AI, no agentic reasoning — just safe, fast, JSON-output file operations for agents and terminal users.

## Quick Start

```bash
# Build from source
cd packages/mtui
cargo build --release

# Or install
./install.sh       # macOS / Linux
powershell -File install.ps1  # Windows

# Verify
mtui --version
mtui --help

# Smoke test every command family (Windows)
powershell -ExecutionPolicy Bypass -File scripts/smoke.ps1
```

## Commands

### File Operations

```bash
# Create a new file
mtui new hello.txt --content "Hello World" --json

# Edit: exact text replacement
mtui edit hello.txt replace "Hello" "Hi" --json

# Edit: replace a specific line
mtui edit hello.txt line 3 replace "new content" --json

# Edit: insert after a marker
mtui edit hello.txt insert-after "## Section" "new paragraph" --json

# Edit: insert before a marker
mtui edit hello.txt insert-before "## Section" "new paragraph" --json

# Edit: delete exact text
mtui edit hello.txt delete "text to remove" --json

# Delete a file with backup/history/diff/undo
mtui delete old-file.txt --json
mtui delete old-file.txt --dry-run --json

# Apply a unified diff through MTUI backup/history/policy
mtui --json apply-patch --file .omni/specs/my-plan/plan/temporary/change.diff
git diff -- src/app.ts | mtui --json apply-patch --stdin --dry-run

# Read a bounded file slice with line numbers
mtui read src/app.ts --from 40 --to 120 --json

# Return a full file only when the bounded view is not enough
mtui read src/app.ts --all --json

# Search for text
mtui search src "keyword" --json
mtui search src "keyword" --limit 20 --json
mtui search src "keyword" --max-count 20 --json
```

`read` validates paths, rejects ignored/binary/non-UTF-8 files, and caps output by default to protect agent context. Use `--from/--to` for targeted source reads, `--max-lines` or `--max-chars` for larger bounded reads, and `--all` only when full content is necessary.

`search` skips build/cache folders such as `.git`, `.mtui`, `.omni`, `node_modules`, `target`, `dist`, and `build`. `--max-count` is an alias for `--limit` for agents coming from ripgrep-style commands.

`context` and `map intent` return ranked candidates with score, stale flag, role, layer, language, module, summaries, and next read commands. They also include compact freshness counts (`changed`, `missing`, `unknown fingerprint`) with sample paths, so agents can decide whether to rebuild Understand/codegraph or continue with bounded source reads.

### Token-Aware Context

```bash
# Build intent-focused candidate files from Understand/codegraph
mtui --json context "fix planning execute command"

# Read real source code through code-aware compression first
mtui --json compass read packages/desktop/src/renderer/pages/studio/ide/planningGuard.ts --query "execute planning"

# Then read exact raw ranges when needed
mtui --json read packages/desktop/src/renderer/pages/studio/ide/planningGuard.ts --from 70 --to 150

# Compact recent MTUI session state instead of rereading long history
mtui --json memory compact --limit 20
mtui --json memory compact --spec my-plan
```

Token-saving layers:

1. `compact` / `verify`: output compression for logs, tests, tracebacks, and build output.
2. `compass read`: file compression that keeps structure, query matches, line numbers, ranges, and next raw read commands.
3. `context`: intent compression that uses Understand/codegraph to choose candidate files before loading source.
4. `memory compact`: session compression for recent MTUI writes, command history, and optional task state.

Compressed outputs are explicit: they include `compressed`/`lossy` flags where applicable, source paths, ranges, and next commands so agents know when to read raw source.

### Diff / Undo

```bash
# Show diff for last operation
mtui diff --last --json

# Show diff for specific operation
mtui diff --operation op_20260603_002 --json

# Undo last operation
mtui undo --last --json

# Undo specific operation
mtui undo --operation op_20260603_002 --json

# View operation history
mtui history --limit 20 --json
```

### Command History & Suggestion

```bash
# Record a command execution
mtui history record --command "bun run test" --exit-code 0 --duration-ms 8200 --json

# View command history
mtui history commands --limit 20 --json

# Get command suggestions
mtui suggest "bun" --json
```

### Command Repair

```bash
# Repair a failed command
mtui repair --command "gemini" --stderr "deprecated, use agi" --json

# Repair common typos and close matches from successful command history
mtui repair --command "bun rn test" --stderr "unknown command" --json

# Read stderr from file
mtui repair --command "gemini" --stderr-file ".mtui/tmp/stderr.log" --json
```

### Planning Task Inspection

```bash
# Show active task, or next pending task, from the newest spec
mtui tasks current --json

# Show completed tasks for a specific spec
mtui tasks done --spec exp-graph --json

# Show all tasks from a spec folder path
mtui tasks list --spec .omni/specs/exp-graph/ --json
```

`tasks` is read-only. It helps agents check plan state quickly without loading a full `tasks.md`; execution still belongs to the app chat command `/execute @...`.

### Compact Noisy Output

```bash
# Compact long logs/errors from stdin
bun run test 2>&1 | mtui compact --profile auto --save --json

# Compact a saved stderr/stdout file
mtui compact --profile vitest --file .omni/specs/my-plan/plan/temporary/test.log --json

# Return everything when the compact view is not enough
mtui compact --file .omni/specs/my-plan/plan/temporary/test.log --all --json

# Retrieve full piped output saved by --save
mtui compact --retrieve cmp_20260604_110000_ab12cd34 --json
```

`compact` keeps likely errors, warnings, file references, assertions, and the useful tail while dropping repeated progress/noise. Use `--save` for piped output so the compact view is reversible; use `--all` or `--retrieve <id>` only when the short view is insufficient.

Profiles can be `auto`, `generic`, `python`, `vitest`, `tsc`, `cargo`, or `pytest`. `auto` detects common traceback/build/test formats from the output.

### Verification Runs

```bash
# Run a Python verification script and save the full log in the spec temporary folder
mtui --json verify python --spec my-plan .omni/specs/my-plan/plan/temporary/test.py

# Pass arguments to the Python script
mtui --json verify python --spec my-plan .omni/specs/my-plan/plan/temporary/test.py -- --case login --verbose

# Run a generic verification command without shell expansion
mtui --json verify run bun test tests/unit/example.test.ts

# Return full output instead of the compact focused view
mtui --json verify python --all .omni/specs/my-plan/plan/temporary/test.py
```

`verify` captures stdout/stderr, stores the full log, and returns structured JSON with `passed`, `exit_code`, `duration_ms`, `summary`, `output`, and `full_log_path`. Successful runs stay short. Failed runs focus on traceback, assertion, warning, error, and file-line signals. When `--spec` is provided, logs are written to `.omni/specs/<slug>/plan/temporary/`; otherwise they go to `.mtui/verify/`.

### Strict MTUI Policy

```bash
# Check whether changed files have matching recent MTUI write operations
mtui policy status --json

# Accept the current dirty worktree as a baseline before a new agent run
mtui policy baseline --json

# Compare against a larger operation window
mtui policy status --limit 250 --json
```

Agents should run this before executing plan tasks. A non-empty `violations` list means file changes bypassed MTUI history and must be explained or repaired before continuing. Use `policy baseline` only when the user confirms the current dirty worktree is pre-existing and should not block the next task.

### Stale Edit Conflict Flow

```bash
# Read a file and keep content_hash
mtui --json read src/app.ts --from 1 --to 120

# Pass the hash when editing after a read
mtui --json edit src/app.ts line 42 replace "new code" --expect-hash <content_hash>

# If MTUI returns resolution.status=needs_confirmation, inspect the current conflict
mtui --json conflict current
mtui --json conflict explain <confirmation_token>

# Validate freshness and get retry args
mtui --json conflict accept <confirmation_token>

# Retry the same edit only after reviewing checked_operations[].diff_excerpt
mtui --json edit src/app.ts line 42 replace "new code" --expect-hash <content_hash> --accept-stale <confirmation_token>
```

When two agents edit the same file from the same old read, MTUI checks later MTUI operations by line range and same-file symbol relationship. Line overlap and same symbol are blocked. Related symbols in the same file return `needs_confirmation` with a token and diff excerpt; `conflict accept` only returns retry args while the file still matches the token's current hash.

### Understand Summary / Info

```bash
# Concise file summary from the repo-local Understand cache
mtui summary file packages/desktop/src/process/ide/knowledgeGraphBridge.ts --json

# Concise folder/module summary
mtui summary folder packages/desktop/src/process/ide --json

# Detailed file or folder info, including symbols/tags/module files
mtui info file packages/desktop/src/process/ide/knowledgeGraphBridge.ts --json
mtui info folder packages/desktop/src/process/ide --json

# `information` is an alias for `info`
mtui information file packages/desktop/src/process/ide/knowledgeGraphBridge.ts --json
mtui information folder packages/desktop/src/process/ide --json

# Project-level overview
mtui summary folder . --json
mtui information folder . --json
```

`summary` and `info` read `.omni/understand/summary.json`, exported by the IDE Understand/codegraph build. Treat results with `"stale": true` as hints only and rebuild Understand before relying on them.

If the Understand cache is missing a file or folder, `summary`, `info`, and `map folder` fall back to a safe filesystem scan instead of returning an empty result. Fallback output is marked with `summarySource: "filesystem-fallback"`, `stale: true`, and low map confidence; use it to pick candidate files, then run `compass read` or rebuild Understand for semantic relationships.

## JSON Output

All commands support `--json` for structured output. Success responses have `ok: true`; error responses have `ok: false` with `error_type`, `message`, and optional `suggestion`. Invalid arguments also honor `--json`, so agents can parse CLI mistakes instead of hanging on human-only Clap output.

### Success envelope

```json
{
  "ok": true,
  "command": "edit",
  "operation": "replace",
  "operation_id": "op_20260603_002",
  "changed": true
}
```

### Error envelope

```json
{
  "ok": false,
  "command": "edit",
  "error_type": "NO_MATCH",
  "message": "Text not found in file.txt",
  "suggestion": "Use mtui search \"file.txt\" \"keyword\" --json"
}
```

### Error types

| Error type             | Description                              |
| ---------------------- | ---------------------------------------- |
| `NO_MATCH`             | Text/marker not found in file            |
| `MULTIPLE_MATCHES`     | Multiple matches found, use --all        |
| `FILE_NOT_FOUND`       | File does not exist                      |
| `FILE_EXISTS`          | File already exists                      |
| `PATH_OUTSIDE_PROJECT` | Path is outside project root             |
| `PATH_IGNORED`         | Path matches ignore pattern              |
| `BINARY_FILE`          | Binary file detected                     |
| `ENCODING_ERROR`       | File is not valid UTF-8                  |
| `INVALID_ARGUMENT`     | CLI argument or command input is invalid |
| `PERMISSION_DENIED`    | Cannot read/write file                   |
| `BACKUP_FAILED`        | Could not create backup                  |
| `WRITE_FAILED`         | Could not write file                     |
| `CONFLICT`             | File changed after operation             |
| `UNDO_NOT_AVAILABLE`   | No backup for undo                       |
| `INTERNAL_ERROR`       | Unexpected error                         |

## Safety Policy

MTUI includes basic safety rules enforced by default:

- **Path safety**: Writing outside the project root is blocked
- **Ignored paths**: `.git`, `node_modules`, `dist`, `build`, `target`, `vendor` are excluded
- **Binary detection**: Binary files are not edited
- **Atomic writes**: Files are written atomically via tempfile
- **Backup before write**: Every write operation creates a backup
- **Dry-run**: All write operations support `--dry-run`

### Risk classification

Commands are classified for Omni terminal integration:

| Level              | Examples                  |
| ------------------ | ------------------------- |
| `read_only`        | cat, ls, echo, head, tail |
| `project_write`    | git, cargo, npm, bun      |
| `external_network` | curl, wget                |
| `destructive`      | rm, git push --force      |
| `privileged`       | sudo, su                  |
| `unknown`          | Everything else           |

## Storage

MTUI stores state in `.mtui/` at the project root:

```
.mtui/
├── config.toml      # Configuration
├── mtui.db          # SQLite database
├── backups/         # File backups before edit
├── diffs/           # Diff files per operation
├── operations/      # Operation metadata
└── tmp/             # Temporary files
```

## Integration with Omni

MTUI is designed to be called from Omni via `child_process.spawn`:

```typescript
import { runMtui } from '@process/terminal/mtuiBridge';

// Run any MTUI command
const result = await runMtui(['edit', 'file.txt', 'replace', 'old', 'new', '--json']);

// Record terminal commands
const { recordCommand } = await import('@process/terminal/mtuiBridge');
await recordCommand('bun run test', 0, 8200);

// Get suggestions
const { getSuggestions } = await import('@process/terminal/mtuiBridge');
const suggestions = await getSuggestions('bun');

// Get repair hint
const { getRepair } = await import('@process/terminal/mtuiBridge');
const repair = await getRepair('gemini', 'deprecated, use agi');
```

Agent operating rule:

- Prefer `mtui --json` for deterministic workspace file operations.
- Use `mtui read <file> --from <line> --to <line> --json` for bounded source reads after summaries narrow the target.
- Use `mtui apply-patch --file <patch.diff> --json` or `mtui apply-patch --stdin --json` as the universal write gateway for agent-generated unified diffs.
- Run `mtui diff --last --json` after MTUI writes.
- Use `mtui undo --last --json` if the write is wrong.
- Use `mtui tasks current --json` or `mtui tasks done --json` to inspect planning state quickly.
- Use `mtui summary ... --json` or `mtui info ... --json` for fast codegraph context; if `stale` is true, rebuild Understand or read source before acting.
- Use `mtui context "<intent>" --json` and `mtui compass read ... --query "<intent>" --json` before raw file reads when the task scope is unclear.
- Use `mtui verify ... --json` for test/verification commands so pass output is summarized and failures focus on useful lines.
- Use `mtui memory compact --json` before resuming a long task.
- Record useful terminal commands with `mtui history record ... --json`.

### ExpBase (Debugging Experience Memory)

```bash
# Search past experiences for a symptom + context (AI-free lexical + metadata ranking)
mtui --json exp search "vitest mock not applied" --framework vitest --command "bun run test" --error test-failure

# Queue a new experience draft for the engine to embed + dedupe later
mtui --json exp add --kind successful_fix --symptom "tsc OOM on large union" --lesson "split union types" --framework typescript

# Pass a full draft as JSON on stdin
echo '{"kind":"lesson","symptoms":{"summary":"..."}}' | mtui --json exp add --stdin

# Inspect / list entries
mtui --json exp get exp_abc123
mtui --json exp list --limit 20 --kind successful_fix

# Queue an entry id for archival (hidden from search immediately)
mtui --json exp forget exp_abc123

# Queue confidence feedback after applying a lesson (tunes ranking over time)
mtui --json exp feedback exp_abc123 --helpful
mtui --json exp feedback exp_abc123 --unhelpful
```

`exp` reads the projection file `.mtui/exp/index.json` written by the Omni ExpBase engine
(`packages/desktop/src/process/experience/`). MTUI stays AI-free: it ranks with deterministic lexical
+ metadata scoring and never computes embeddings. `add` and `forget` only queue intent
(`.mtui/exp/inbox.jsonl`, `.mtui/exp/forget.jsonl`); the engine embeds, de-dupes, archives, and
rebuilds the projection on its next drain. `feedback` queues a confidence nudge
(`.mtui/exp/feedback.jsonl`, `--helpful`/`--unhelpful`) applied on the same drain. Use `exp search`
when stuck on a hard bug (failed verify/test or two failed fix attempts) to recall a grounded lesson —
it costs no tokens and no model round-trips.

## License

Apache-2.0 — see the project root LICENSE file.