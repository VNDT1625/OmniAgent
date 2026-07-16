use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "mtui",
    about = "Memory Terminal UI - safe file operations for agents"
)]
#[command(version)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    #[arg(long, global = true, help = "Output as JSON")]
    pub json: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    #[command(about = "Create a new file")]
    New(NewArgs),

    #[command(about = "Edit a file")]
    Edit(EditArgs),

    #[command(about = "Delete a file with MTUI backup, history, diff, and undo support")]
    Delete(FileDeleteArgs),

    #[command(about = "Apply a unified diff through MTUI history, backup, and policy")]
    ApplyPatch(ApplyPatchArgs),

    #[command(about = "Read a text file safely with line and character limits")]
    Read(ReadArgs),

    #[command(about = "Search for text in files")]
    Search(SearchArgs),

    #[command(about = "Show diff for operations")]
    Diff(DiffArgs),

    #[command(about = "Undo a file operation")]
    Undo(UndoArgs),

    #[command(about = "Show operation or command history")]
    History(HistoryArgs),

    #[command(about = "Suggest commands from history")]
    Suggest(SuggestArgs),

    #[command(about = "Repair a failed command")]
    Repair(RepairArgs),

    #[command(about = "Compact noisy logs or command output for agent context")]
    Compact(CompactArgs),

    #[command(about = "Run verification commands and return compact pass/fail output")]
    Verify(VerifyArgs),

    #[command(
        alias = "fallback",
        about = "Fallback to an external command with compact JSON output when MTUI has no primitive"
    )]
    Run(VerifyRunArgs),

    #[command(about = "Inspect planning tasks without executing them")]
    Tasks(TasksArgs),

    #[command(about = "Inspect Strict MTUI policy state")]
    Policy(PolicyArgs),

    #[command(about = "Fetch model pricing from llmprices.ai and estimate token cost")]
    Pricing(PricingArgs),

    #[command(about = "Read concise Understand/codegraph summaries")]
    Summary(UnderstandArgs),

    #[command(about = "Read code-aware compressed source slices")]
    Compass(CompassArgs),

    #[command(about = "Build intent-focused repo context from Understand/codegraph")]
    Context(ContextArgs),

    #[command(about = "Query the durable shared project Wiki built by AionUi Studio")]
    Wiki(WikiArgs),

    #[command(about = "Show a codebase map from Understand/codegraph")]
    Map(MapArgs),

    #[command(
        about = "Analyze the codebase: `analyze type` detects languages + editor engines; `analyze [path]` error-checks"
    )]
    Analyze(AnalyzeArgs),

    #[command(
        about = "Measure a file tree: direct children, files, lines, extensions, and largest files"
    )]
    Stats(StatsArgs),

    #[command(about = "Compact recent MTUI session state for agent continuity")]
    Memory(MemoryArgs),

    #[command(about = "Inspect or accept the latest stale-edit confirmation conflict")]
    Conflict(ConflictArgs),

    #[command(
        alias = "information",
        about = "Read detailed Understand/codegraph information"
    )]
    Info(UnderstandArgs),

    #[command(about = "Diagnose MTUI install, PATH, and Understand cache state")]
    Doctor,

    #[command(
        about = "ExpBase debugging memory: search/add/get/list/forget/feedback (reads .mtui/exp)"
    )]
    Exp(ExpArgs),
}

#[derive(Args)]
pub struct NewArgs {
    #[arg(help = "File path to create")]
    pub file: String,

    #[arg(long, help = "Content for the new file")]
    pub content: Option<String>,

    #[arg(long, help = "Read content from a file")]
    pub content_file: Option<String>,

    #[arg(long, help = "Read content from stdin")]
    pub content_stdin: bool,

    #[arg(long, help = "Overwrite existing file")]
    pub overwrite: bool,

    #[arg(long, help = "Dry run (no actual write)")]
    pub dry_run: bool,
}

#[derive(Args)]
pub struct EditArgs {
    #[arg(help = "File to edit")]
    pub file: String,

    #[command(subcommand)]
    pub operation: EditOperation,
}

#[derive(Args)]
pub struct ApplyPatchArgs {
    #[arg(long, help = "Read unified diff from a patch file")]
    pub file: Option<String>,

    #[arg(long, help = "Read unified diff from stdin")]
    pub stdin: bool,

    #[arg(long, help = "Validate and summarize without applying")]
    pub dry_run: bool,

    #[arg(
        long,
        value_name = "PATH=HASH",
        help = "Expected content hash for a patched file; may be repeated"
    )]
    pub expect_hash: Vec<String>,
}

#[derive(Args)]
pub struct FileDeleteArgs {
    #[arg(help = "File path to delete")]
    pub file: String,

    #[arg(
        long,
        help = "Dry run (show what would be deleted without removing the file)"
    )]
    pub dry_run: bool,

    #[arg(long, help = "Confirm deletion of a read-only file")]
    pub force: bool,
}

#[derive(Args)]
pub struct PricingArgs {
    #[command(subcommand)]
    pub query: PricingQuery,
}

#[derive(Subcommand)]
pub enum PricingQuery {
    #[command(about = "Fetch pricing for a provider-qualified model id")]
    Model(PricingModelArgs),

    #[command(about = "Estimate USD cost from token counts for a model")]
    Estimate(PricingEstimateArgs),
}

#[derive(Args)]
pub struct PricingModelArgs {
    #[arg(help = "Provider-qualified model id, e.g. openai/gpt-4o")]
    pub model: String,

    #[arg(long, help = "Bypass local cache and fetch fresh pricing")]
    pub refresh: bool,
}

#[derive(Args)]
pub struct ConflictArgs {
    #[command(subcommand)]
    pub query: ConflictQuery,
}

#[derive(Subcommand)]
pub enum ConflictQuery {
    #[command(about = "Show the latest pending stale-edit confirmation")]
    Current,

    #[command(about = "List recent stale-edit confirmations")]
    List {
        #[arg(long, default_value_t = 10, help = "Maximum conflicts to return")]
        limit: usize,
    },

    #[command(about = "Explain a stale-edit confirmation token")]
    Explain {
        #[arg(help = "Confirmation token; defaults to latest current token")]
        token: Option<String>,
    },

    #[command(about = "Return accept args for a confirmation token after validating freshness")]
    Accept {
        #[arg(help = "Confirmation token; defaults to latest current token")]
        token: Option<String>,
    },
}

#[derive(Args)]
pub struct PricingEstimateArgs {
    #[arg(help = "Provider-qualified model id, e.g. openai/gpt-4o")]
    pub model: String,

    #[arg(long, default_value_t = 0, help = "Input token count")]
    pub input_tokens: u64,

    #[arg(long, default_value_t = 0, help = "Output token count")]
    pub output_tokens: u64,

    #[arg(long, default_value_t = 0, help = "Cached input token count")]
    pub cached_input_tokens: u64,

    #[arg(long, help = "Bypass local cache and fetch fresh pricing")]
    pub refresh: bool,
}

#[derive(Subcommand)]
pub enum EditOperation {
    #[command(about = "Replace exact text")]
    Replace(ReplaceArgs),

    #[command(about = "Replace a specific line")]
    Line(LineArgs),

    #[command(about = "Insert text after a marker")]
    InsertAfter(InsertArgs),

    #[command(about = "Insert text before a marker")]
    InsertBefore(InsertArgs),

    #[command(about = "Delete exact text")]
    Delete(DeleteArgs),
}

#[derive(Args)]
pub struct ReplaceArgs {
    #[arg(help = "Old text to replace")]
    pub old: String,

    #[arg(help = "New text")]
    pub new: String,

    #[arg(long, help = "Replace all occurrences")]
    pub all: bool,

    #[arg(long, help = "Dry run")]
    pub dry_run: bool,

    #[arg(
        long,
        help = "Content hash returned by `mtui read`; enables stale edit analysis"
    )]
    pub expect_hash: Option<String>,

    #[arg(long, help = "Confirmation token returned by stale edit analysis")]
    pub accept_stale: Option<String>,
}

#[derive(Args)]
pub struct LineArgs {
    #[arg(help = "Line number (1-based)")]
    pub line: usize,

    #[arg(help = "Action: replace")]
    pub action: String,

    #[arg(help = "New content for the line")]
    pub content: String,

    #[arg(long, help = "Dry run")]
    pub dry_run: bool,

    #[arg(
        long,
        help = "Content hash returned by `mtui read`; enables stale edit analysis"
    )]
    pub expect_hash: Option<String>,

    #[arg(long, help = "Confirmation token returned by stale edit analysis")]
    pub accept_stale: Option<String>,
}

#[derive(Args)]
pub struct InsertArgs {
    #[arg(help = "Marker text to find")]
    pub marker: String,

    #[arg(help = "Content to insert")]
    pub content: String,

    #[arg(long, help = "Insert at all occurrences")]
    pub all: bool,

    #[arg(long, help = "Read content from file")]
    pub content_file: Option<String>,

    #[arg(long, help = "Dry run")]
    pub dry_run: bool,

    #[arg(
        long,
        help = "Content hash returned by `mtui read`; enables stale edit analysis"
    )]
    pub expect_hash: Option<String>,

    #[arg(long, help = "Confirmation token returned by stale edit analysis")]
    pub accept_stale: Option<String>,
}

#[derive(Args)]
pub struct DeleteArgs {
    #[arg(help = "Text to delete")]
    pub text: String,

    #[arg(long, help = "Delete all occurrences")]
    pub all: bool,

    #[arg(long, help = "Read text from file")]
    pub text_file: Option<String>,

    #[arg(long, help = "Dry run")]
    pub dry_run: bool,

    #[arg(
        long,
        help = "Content hash returned by `mtui read`; enables stale edit analysis"
    )]
    pub expect_hash: Option<String>,

    #[arg(long, help = "Confirmation token returned by stale edit analysis")]
    pub accept_stale: Option<String>,
}

#[derive(Args)]
pub struct ReadArgs {
    #[arg(help = "File path to read")]
    pub file: String,

    #[arg(long, help = "Start line, 1-based")]
    pub from: Option<usize>,

    #[arg(long, help = "End line, 1-based and inclusive")]
    pub to: Option<usize>,

    #[arg(
        long,
        default_value_t = 160,
        help = "Maximum returned lines unless --all is set"
    )]
    pub max_lines: usize,

    #[arg(
        long,
        default_value_t = 20000,
        help = "Maximum returned characters unless --all is set"
    )]
    pub max_chars: usize,

    #[arg(long, help = "Return the full file without line or character limits")]
    pub all: bool,

    #[arg(long, help = "Do not prefix returned text lines with line numbers")]
    pub no_line_numbers: bool,
}

#[derive(Args)]
pub struct SearchArgs {
    #[arg(help = "File or directory to search in")]
    pub path: String,

    #[arg(help = "Text to search for")]
    pub query: String,

    #[arg(long, help = "Interpret the query as a regular expression")]
    pub regex: bool,

    #[arg(short = 'i', long, help = "Match without case sensitivity")]
    pub ignore_case: bool,

    #[arg(
        short = 'g',
        long = "glob",
        help = "Include files matching this glob (repeatable)"
    )]
    pub globs: Vec<String>,

    #[arg(
        long = "exclude",
        help = "Exclude files matching this glob (repeatable)"
    )]
    pub excludes: Vec<String>,

    #[arg(
        short = 'C',
        long,
        default_value_t = 0,
        help = "Context lines before and after each match"
    )]
    pub context: usize,

    #[arg(short = 'l', long, help = "Return only files containing matches")]
    pub files_with_matches: bool,

    #[arg(
        short = 'c',
        long,
        help = "Return matching-line counts grouped by file"
    )]
    pub count: bool,

    #[arg(
        long,
        alias = "max-count",
        default_value_t = 200,
        help = "Maximum matches to return"
    )]
    pub limit: usize,
}

#[derive(Args)]
pub struct DiffArgs {
    #[arg(long, help = "Show diff for last operation")]
    pub last: bool,

    #[arg(long, help = "Show diff for specific operation")]
    pub operation: Option<String>,
}

#[derive(Args)]
pub struct UndoArgs {
    #[arg(long, help = "Undo last operation")]
    pub last: bool,

    #[arg(long, help = "Undo specific operation")]
    pub operation: Option<String>,
}

#[derive(Args)]
pub struct HistoryArgs {
    #[command(subcommand)]
    pub history_type: Option<HistoryType>,

    #[arg(long, global = true, help = "Limit results")]
    pub limit: Option<usize>,
}

#[derive(Subcommand)]
pub enum HistoryType {
    #[command(about = "Show operation history")]
    Operations,

    #[command(about = "Show command history")]
    Commands,

    #[command(about = "Record a command execution")]
    Record(RecordArgs),
}

#[derive(Args)]
pub struct RecordArgs {
    #[arg(long, help = "The command that was run")]
    pub command: String,

    #[arg(long, help = "Exit code")]
    pub exit_code: i32,

    #[arg(long, help = "Duration in milliseconds")]
    pub duration_ms: i64,
}

#[derive(Args)]
pub struct SuggestArgs {
    #[arg(help = "Command prefix to suggest for")]
    pub prefix: String,
}

#[derive(Args)]
pub struct RepairArgs {
    #[arg(long, help = "The command that failed")]
    pub command: String,

    #[arg(long, help = "Stderr output")]
    pub stderr: Option<String>,

    #[arg(long, help = "Path to stderr file")]
    pub stderr_file: Option<String>,
}

#[derive(Args)]
pub struct CompactArgs {
    #[arg(long, help = "Read input from a file instead of stdin")]
    pub file: Option<String>,

    #[arg(long, help = "Save full input locally and return a retrieval id")]
    pub save: bool,

    #[arg(long, help = "Retrieve a saved compact input by id")]
    pub retrieve: Option<String>,

    #[arg(long, help = "Return the full input without compaction")]
    pub all: bool,

    #[arg(
        long,
        help = "Compression profile: auto, generic, python, vitest, tsc, cargo, pytest"
    )]
    pub profile: Option<String>,

    #[arg(long, default_value_t = 80, help = "Maximum compacted lines")]
    pub max_lines: usize,

    #[arg(long, default_value_t = 12000, help = "Maximum compacted characters")]
    pub max_chars: usize,
}

#[derive(Args)]
pub struct VerifyArgs {
    #[command(subcommand)]
    pub command: VerifyCommand,
}

#[derive(Subcommand)]
pub enum VerifyCommand {
    #[command(about = "Run a Python verification script")]
    Python(VerifyPythonArgs),

    #[command(about = "Run an arbitrary verification program without shell expansion")]
    Run(VerifyRunArgs),
}

#[derive(Args)]
pub struct VerifyPythonArgs {
    #[arg(help = "Python script path")]
    pub script: String,

    #[arg(
        long,
        help = "Working directory for the verification command (defaults to project root)"
    )]
    pub cwd: Option<String>,

    #[arg(long, default_value = "python", help = "Python executable to use")]
    pub python_bin: String,

    #[arg(
        long,
        help = "Spec slug or .aionui/specs/<slug>/ path for plan/temporary log storage"
    )]
    pub spec: Option<String>,

    #[arg(long, default_value_t = 80, help = "Maximum compacted output lines")]
    pub max_lines: usize,

    #[arg(
        long,
        default_value_t = 12000,
        help = "Maximum compacted output characters"
    )]
    pub max_chars: usize,

    #[arg(long, help = "Return full output instead of compact output")]
    pub all: bool,

    #[arg(
        long,
        help = "Compression profile: auto, generic, python, vitest, tsc, cargo, pytest"
    )]
    pub profile: Option<String>,

    #[arg(
        trailing_var_arg = true,
        allow_hyphen_values = true,
        help = "Arguments passed to the Python script"
    )]
    pub args: Vec<String>,
}

#[derive(Args)]
pub struct VerifyRunArgs {
    #[arg(help = "Program to run")]
    pub program: String,

    #[arg(
        long,
        help = "Working directory for the command (defaults to project root)"
    )]
    pub cwd: Option<String>,

    #[arg(
        long,
        help = "Spec slug or .aionui/specs/<slug>/ path for plan/temporary log storage"
    )]
    pub spec: Option<String>,

    #[arg(long, default_value_t = 80, help = "Maximum compacted output lines")]
    pub max_lines: usize,

    #[arg(
        long,
        default_value_t = 12000,
        help = "Maximum compacted output characters"
    )]
    pub max_chars: usize,

    #[arg(long, help = "Return full output instead of compact output")]
    pub all: bool,

    #[arg(
        long,
        help = "Compression profile: auto, generic, python, vitest, tsc, cargo, pytest"
    )]
    pub profile: Option<String>,

    #[arg(
        trailing_var_arg = true,
        allow_hyphen_values = true,
        help = "Arguments passed to the program"
    )]
    pub args: Vec<String>,
}

#[derive(Args)]
pub struct TasksArgs {
    #[command(subcommand)]
    pub query: TasksQuery,

    #[arg(long, global = true, help = "Spec slug or .aionui/specs/<slug>/ path")]
    pub spec: Option<String>,
}

#[derive(Subcommand)]
pub enum TasksQuery {
    #[command(about = "Show active task, or next pending task")]
    Current,

    #[command(about = "Show completed tasks")]
    Done,

    #[command(about = "Show all tasks")]
    List,
}

#[derive(Args)]
pub struct PolicyArgs {
    #[command(subcommand)]
    pub query: PolicyQuery,
}

#[derive(Subcommand)]
pub enum PolicyQuery {
    #[command(about = "Show changed files that bypassed recent MTUI write history")]
    Status(PolicyStatusArgs),

    #[command(about = "Record current dirty files as an accepted baseline")]
    Baseline,

    #[command(about = "Record current dirty files as the temporary baseline for this session")]
    SessionStart(PolicySessionStartArgs),

    #[command(about = "Clear the temporary policy baseline for this session")]
    SessionClear,
}

#[derive(Args)]
pub struct PolicyStatusArgs {
    #[arg(long, help = "Recent MTUI operations to compare against")]
    pub limit: Option<usize>,

    #[arg(
        long,
        help = "Create a temporary session baseline from current dirty files if none exists"
    )]
    pub auto_session: bool,

    #[arg(
        long,
        default_value_t = 100,
        help = "Maximum policy violations to include in the command output"
    )]
    pub violation_limit: usize,

    #[arg(
        long,
        default_value = "agent",
        help = "Owner label used when --auto-session creates a session baseline"
    )]
    pub owner: String,

    #[arg(
        long,
        help = "Optional note used when --auto-session creates a session baseline"
    )]
    pub note: Option<String>,
}

#[derive(Args)]
pub struct PolicySessionStartArgs {
    #[arg(
        long,
        default_value = "agent",
        help = "Owner label for the session baseline"
    )]
    pub owner: String,

    #[arg(
        long,
        help = "Optional note explaining why the session baseline was created"
    )]
    pub note: Option<String>,

    #[arg(long, help = "Return all baselined paths instead of a short sample")]
    pub all: bool,
}

#[derive(Args)]
pub struct UnderstandArgs {
    #[command(subcommand)]
    pub query: UnderstandQuery,
}

#[derive(Subcommand)]
pub enum UnderstandQuery {
    #[command(about = "Inspect one file summary")]
    File(UnderstandPathArgs),

    #[command(alias = "dir", about = "Inspect one folder/module summary")]
    Folder(UnderstandPathArgs),
}

#[derive(Args)]
pub struct UnderstandPathArgs {
    #[arg(help = "Repo-relative or absolute path")]
    pub path: String,
}

#[derive(Args)]
pub struct CompassArgs {
    #[command(subcommand)]
    pub query: CompassQuery,
}

#[derive(Subcommand)]
pub enum CompassQuery {
    #[command(about = "Read one file with code-aware compression")]
    Read(CompassReadArgs),
}

#[derive(Args)]
pub struct CompassReadArgs {
    #[arg(help = "Repo-relative or absolute file path")]
    pub file: String,

    #[arg(long, help = "Intent/query used to keep relevant lines")]
    pub query: Option<String>,

    #[arg(long, default_value_t = 120, help = "Maximum compressed lines")]
    pub max_lines: usize,

    #[arg(long, default_value_t = 16000, help = "Maximum compressed characters")]
    pub max_chars: usize,
}

#[derive(Args)]
pub struct ContextArgs {
    #[arg(help = "Task intent or question")]
    pub intent: String,

    #[arg(long, default_value_t = 8, help = "Maximum candidate files")]
    pub limit: usize,
}

#[derive(Args)]
pub struct WikiArgs {
    #[arg(help = "Topic or question to retrieve from the shared project Wiki")]
    pub query: String,

    #[arg(long, default_value_t = 5, help = "Maximum matching Wiki sections")]
    pub limit: usize,
}

#[derive(Args)]

pub struct MapArgs {
    #[command(subcommand)]
    pub query: MapQuery,
}

#[derive(Args)]
pub struct AnalyzeArgs {
    #[arg(
        help = "Either the keyword `type` (detect languages + recommend editor engines) or a path to error-check; omit to error-check the whole repo"
    )]
    pub target: Option<String>,

    #[arg(
        long,
        default_value_t = 20000,
        help = "Maximum files to scan before stopping (keeps huge repos responsive)"
    )]
    pub max_files: usize,
}

#[derive(Args)]
pub struct StatsArgs {
    #[arg(
        default_value = ".",
        help = "Repo-relative or absolute file/directory path"
    )]
    pub path: String,

    #[arg(long, default_value_t = 20, help = "Number of largest files to return")]
    pub largest: usize,

    #[arg(
        long,
        default_value_t = 20000,
        help = "Maximum files to scan before stopping"
    )]
    pub max_files: usize,
}

#[derive(Subcommand)]
pub enum MapQuery {
    #[command(about = "Show top-level module/folder map")]
    Repo(MapLimitArgs),

    #[command(about = "Show file-level map for one folder/module")]
    Folder(MapPathArgs),

    #[command(about = "Show recommended code path for an intent")]
    Intent(MapIntentArgs),
}

#[derive(Args)]
pub struct MapLimitArgs {
    #[arg(long, default_value_t = 12, help = "Maximum entries to return")]
    pub limit: usize,
}

#[derive(Args)]
pub struct MapPathArgs {
    #[arg(help = "Repo-relative or absolute folder/module path")]
    pub path: String,

    #[arg(long, default_value_t = 12, help = "Maximum files to return")]
    pub limit: usize,
}

#[derive(Args)]
pub struct MapIntentArgs {
    #[arg(help = "Natural-language intent")]
    pub intent: String,

    #[arg(long, default_value_t = 8, help = "Maximum candidates to return")]
    pub limit: usize,
}

#[derive(Args)]
pub struct MemoryArgs {
    #[command(subcommand)]
    pub query: MemoryQuery,
}

#[derive(Subcommand)]
pub enum MemoryQuery {
    #[command(about = "Compact recent MTUI operations, commands, and optional task state")]
    Compact(MemoryCompactArgs),
}

#[derive(Args)]
pub struct MemoryCompactArgs {
    #[arg(long, default_value_t = 20, help = "Recent operation/command limit")]
    pub limit: usize,

    #[arg(
        long,
        help = "Spec slug or .aionui/specs/<slug>/ path to include task state"
    )]
    pub spec: Option<String>,
}

#[derive(Args)]
pub struct ExpArgs {
    #[command(subcommand)]
    pub query: ExpQuery,
}

#[derive(Subcommand)]
pub enum ExpQuery {
    #[command(about = "Search ExpBase for lessons matching a symptom + context")]
    Search(ExpSearchArgs),

    #[command(about = "Queue a new experience draft into the inbox for the engine to embed")]
    Add(ExpAddArgs),

    #[command(about = "Show one experience entry by id")]
    Get(ExpGetArgs),

    #[command(about = "List recent experience entries")]
    List(ExpListArgs),

    #[command(about = "Queue an entry id to be archived by the engine")]
    Forget(ExpGetArgs),

    #[command(about = "Queue confidence feedback (helpful/unhelpful) for an entry")]
    Feedback(ExpFeedbackArgs),
}

#[derive(Args)]
pub struct ExpSearchArgs {
    #[arg(help = "Symptom / error text to search for")]
    pub query: String,

    #[arg(long, help = "Framework to match, may be repeated")]
    pub framework: Vec<String>,

    #[arg(long, help = "Package to match, may be repeated")]
    pub package: Vec<String>,

    #[arg(long, help = "File/path to match, may be repeated")]
    pub file: Vec<String>,

    #[arg(long, help = "Failing command to match, may be repeated")]
    pub command: Vec<String>,

    #[arg(long, help = "Error category to match")]
    pub error: Option<String>,

    #[arg(
        long,
        help = "Restrict to one kind: successful_fix|agent_mistake|failed_attempt|lesson"
    )]
    pub kind: Option<String>,

    #[arg(long, help = "Tag to match, may be repeated")]
    pub tag: Vec<String>,

    #[arg(long, default_value_t = 5, help = "Maximum suggestions to return")]
    pub limit: usize,

    #[arg(
        long,
        default_value_t = 0.18,
        help = "Minimum combined score to surface"
    )]
    pub min_score: f64,
}

#[derive(Args)]
pub struct ExpAddArgs {
    #[arg(
        long,
        help = "Read the full draft JSON object from stdin instead of flags"
    )]
    pub stdin: bool,

    #[arg(
        long,
        default_value = "lesson",
        help = "Kind: successful_fix|agent_mistake|failed_attempt|lesson"
    )]
    pub kind: String,

    #[arg(long, help = "Symptom summary (required unless --stdin)")]
    pub symptom: Option<String>,

    #[arg(long, help = "Lesson learned")]
    pub lesson: Option<String>,

    #[arg(long, help = "Root cause")]
    pub root_cause: Option<String>,

    #[arg(long, help = "Fix summary")]
    pub fix: Option<String>,

    #[arg(long, help = "Framework, may be repeated")]
    pub framework: Vec<String>,

    #[arg(long, help = "Package, may be repeated")]
    pub package: Vec<String>,

    #[arg(long, help = "File touched, may be repeated")]
    pub file: Vec<String>,

    #[arg(long, help = "Command, may be repeated")]
    pub command: Vec<String>,

    #[arg(long, help = "Error category")]
    pub error: Option<String>,

    #[arg(long, help = "Tag, may be repeated")]
    pub tag: Vec<String>,

    #[arg(long, help = "Confidence in [0,1]")]
    pub confidence: Option<f64>,
}

#[derive(Args)]
pub struct ExpGetArgs {
    #[arg(help = "Experience entry id")]
    pub id: String,
}

#[derive(Args)]
pub struct ExpListArgs {
    #[arg(long, default_value_t = 20, help = "Maximum entries to return")]
    pub limit: usize,

    #[arg(long, help = "Restrict to one kind")]
    pub kind: Option<String>,
}

#[derive(Args)]
pub struct ExpFeedbackArgs {
    #[arg(help = "Experience entry id")]
    pub id: String,

    #[arg(long, help = "Mark the suggestion as helpful (raises confidence)")]
    pub helpful: bool,

    #[arg(
        long,
        help = "Mark the suggestion as unhelpful / a false match (lowers confidence)"
    )]
    pub unhelpful: bool,
}
