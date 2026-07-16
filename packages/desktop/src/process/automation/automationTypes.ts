/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Domain model for the Automation feature — an n8n-style workflow engine.
 *
 * A {@link Workflow} is a **linear, ordered pipeline**: nodes execute in array
 * order and each node's output becomes the next node's `input`. Keeping the
 * shape linear (rather than a general DAG) makes runs deterministic and easy to
 * reason about, test, and stream as a flat event log.
 *
 * Every type here is a plain, serialisable value so it can cross the IPC bridge
 * to the renderer untouched (no class instances, no functions, no `Date`s — only
 * JSON-friendly primitives, arrays, and records).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** The kinds of node a workflow pipeline may contain. */
export type WorkflowNodeKind =
  | 'trigger.manual'
  | 'trigger.schedule'
  | 'trigger.webhook'
  | 'action.http'
  | 'action.ai'
  | 'action.transform'
  | 'action.delay'
  | 'action.log'
  // --- Data nodes ---
  | 'action.set'
  | 'action.code'
  | 'action.filesystem'
  // --- Control flow (interpreted by the engine, not the executor map) ---
  | 'control.if'
  | 'control.switch'
  | 'control.loop'
  | 'control.parallel'
  | 'control.tryCatch'
  | 'control.filter'
  | 'control.merge'
  | 'control.stop'
  // --- App-function nodes: call an AionUi sub-app to produce an artifact ---
  | 'action.app.makeVideo'
  | 'action.app.editor'
  // --- App-reuse nodes (drive existing AionUi features) ---
  | 'action.notify'
  | 'action.manager'
  | 'action.browser'
  | 'action.conversation'
  | 'action.cron'
  | 'action.subworkflow'
  // --- Cloud storage: persist an artifact and expose a public/shareable URL ---
  | 'action.cloud.upload'
  // --- Social / messaging publishers ---
  | 'action.email.send'
  | 'action.social.facebook'
  | 'action.social.tiktok'
  // --- Agent Company: delegate a goal/task to a multi-agent company ---
  | 'action.company';

/**
 * A single step in a workflow pipeline. `config` is an open record whose shape
 * depends on {@link WorkflowNode.kind} — see the per-kind config types below for
 * the documented contract each executor expects.
 */
export type WorkflowNode = {
  /** Stable id, unique within its workflow. */
  id: string;
  /** Discriminates which executor runs this node. */
  kind: WorkflowNodeKind;
  /** Human-friendly label shown in the editor / run log. */
  name: string;
  /** Kind-specific configuration (see the `*NodeConfig` types). */
  config: Record<string, unknown>;
  /**
   * Named child pipelines for control-flow nodes (`control.*`). Each branch is
   * an ordered list of nodes the engine runs when that branch is taken — e.g.
   * `then`/`else` for `control.if`, `body` for `control.loop`, `case:<value>`
   * for `control.switch`, `branch:0..n` for `control.parallel`, and
   * `try`/`catch` for `control.tryCatch`. Leaf action nodes leave this absent.
   */
  branches?: Record<string, WorkflowNode[]>;
  /**
   * Per-node error policy (optional). When set, the engine retries a failing
   * leaf node up to `retries` times (with `retryDelayMs` between attempts), and
   * when it still fails either continues the pipeline (`continueOnError`) or
   * fails the run (default). Ignored by control-flow nodes.
   */
  onError?: NodeErrorPolicy;
};

/** Per-node error/retry policy. */
export type NodeErrorPolicy = {
  /** How many extra attempts after the first failure (0 = no retry). */
  retries?: number;
  /** Delay between attempts (ms). */
  retryDelayMs?: number;
  /** When true, a final failure does not stop the run; the node output is null. */
  continueOnError?: boolean;
};

/**
 * A linear, ordered automation pipeline. `nodes` execute front-to-back, each
 * receiving the previous node's output as its `input`.
 */
export type Workflow = {
  /** Stable id. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional longer description. */
  description?: string;
  /** Ordered pipeline of steps. */
  nodes: WorkflowNode[];
  /** Whether the workflow is active (metadata; the engine runs on demand). */
  enabled: boolean;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last-update timestamp (epoch ms). */
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Per-node config shapes (documented contracts the executors read)
// ---------------------------------------------------------------------------

/** HTTP verbs the `action.http` node supports. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Config for an `action.http` node. */
export type HttpNodeConfig = {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

/**
 * Config for an `action.ai` node. `prompt` may reference the previous node's
 * output via the `{{input}}` placeholder.
 */
export type AiNodeConfig = {
  model: string;
  prompt: string;
};

/**
 * Config for an `action.transform` node. `expression` is template-substituted
 * (`{{input}}` → the incoming value) and returned as a string — no arbitrary JS
 * is evaluated.
 */
export type TransformNodeConfig = {
  expression: string;
};

/** Config for an `action.delay` node. */
export type DelayNodeConfig = {
  ms: number;
};

/** Config for an `action.log` node. */
export type LogNodeConfig = {
  label?: string;
};

/** Config for a `trigger.schedule` node. Metadata only — the engine does not
 * actually schedule anything; a scheduler (outside this module) would read it.
 */
export type ScheduleNodeConfig = {
  cron?: string;
  everyMinutes?: number;
};

// ---------------------------------------------------------------------------
// Data nodes
// ---------------------------------------------------------------------------

/** One field assignment for an `action.set` node. */
export type SetField = {
  /** Output key. */
  key: string;
  /** Value (supports `{{input}}` / `{{input.path}}` substitution). */
  value: string;
};

/** Config for an `action.set` node — build/extend an object from fields. */
export type SetNodeConfig = {
  /** When true, start from the (object) input and add fields; else a fresh object. */
  keepInput?: boolean;
  /** The fields to set. */
  fields: SetField[];
};

/** Config for an `action.code` node — a safe template expression (no eval). */
export type CodeNodeConfig = {
  /** Template text with `{{input}}` / `{{input.path}}` placeholders. */
  template: string;
  /** Parse the rendered result as JSON before passing it on. */
  parseJson?: boolean;
};

/** What an `action.filesystem` node does. */
export type FilesystemOperation = 'read' | 'write' | 'append' | 'list';

/** Config for an `action.filesystem` node. */
export type FilesystemNodeConfig = {
  operation: FilesystemOperation;
  /** Target path (supports `{{input}}`). */
  path: string;
  /** Content for write/append (supports `{{input}}`). */
  content?: string;
};

// ---------------------------------------------------------------------------
// App-reuse nodes
// ---------------------------------------------------------------------------

/** Config for an `action.notify` node (desktop notification). */
export type NotifyNodeConfig = {
  title: string;
  body: string;
};

/** What an `action.manager` node creates in the Personal Manager. */
export type ManagerEntityKind = 'task' | 'note' | 'event';

/** Config for an `action.manager` node. */
export type ManagerNodeConfig = {
  entity: ManagerEntityKind;
  /** Title/summary (supports `{{input}}`). */
  title: string;
  /** Optional detail/body (supports `{{input}}`). */
  detail?: string;
  /** ISO datetime for an event/task due (supports `{{input}}`). */
  at?: string;
};

/** Config for an `action.browser` node (web-agent task). */
export type BrowserNodeConfig = {
  /** Natural-language instruction for the web agent (supports `{{input}}`). */
  task: string;
  /** Optional starting URL. */
  url?: string;
  /** Model id for the agent (optional). */
  model?: string;
};

/** Config for an `action.conversation` node (send to an agent, await reply). */
export type ConversationNodeConfig = {
  /** Message to send (supports `{{input}}`). */
  message: string;
  /** Model id (optional). */
  model?: string;
};

/** Config for an `action.cron` node (create a scheduled task in the app). */
export type CronNodeConfig = {
  /** Cron expression. */
  cron: string;
  /** What the cron job should do (prompt/command, supports `{{input}}`). */
  prompt: string;
  /** Display name for the job. */
  name?: string;
};

/** Config for an `action.subworkflow` node (call another workflow). */
export type SubworkflowNodeConfig = {
  /** Id of the workflow to run. */
  workflowId: string;
};

/** Config for a `trigger.webhook` node (metadata; the webhook server reads it). */
export type WebhookTriggerConfig = {
  /** URL path the webhook listens on (e.g. `/my-hook`). */
  path: string;
};

// ---------------------------------------------------------------------------
// Control-flow node configs
// ---------------------------------------------------------------------------

/** Config for `control.loop`. */
export type LoopNodeConfig = {
  /** `forEach` iterates an array input; `times` repeats a fixed count. */
  mode?: 'forEach' | 'times';
  /** For `times`: how many iterations. */
  times?: number;
  /** For `forEach`: dotted path to the array inside the input object. */
  itemsPath?: string;
};

/** Config for `control.switch`. */
export type SwitchNodeConfig = {
  /** Value to switch on (supports `{{input}}`); matched against `case:<value>` branches. */
  value: string;
};

/** What an `action.company` node does. */
export type CompanyNodeMode =
  /** Design + persist a new company from a free-text prompt. */
  | 'create'
  /** Give the President a goal; it delegates across the whole company. */
  | 'goal'
  /** Give a task to one specific role in the company. */
  | 'tasks';

/** Config for an `action.company` node. */
export type CompanyNodeConfig = {
  /** Which of the three company operations this node performs. */
  mode: CompanyNodeMode;
  /**
   * Target company id. Required for `goal`/`tasks`; for `create` it is the id of
   * the company to (re)create (optional — a fresh one is generated when blank).
   */
  companyId?: string;
  /** `create`: the description the company is designed from (supports `{{input}}`). */
  description?: string;
  /** `goal`: the objective handed to the President (supports `{{input}}`). */
  goal?: string;
  /** `tasks`: the role node id the task is assigned to. */
  roleId?: string;
  /** `tasks`: the task text for the chosen role (supports `{{input}}`). */
  task?: string;
  /** Model id to run the company agents with (optional — provider picks one). */
  model?: string;
  /** Cap on how many direct reports the President delegates to (default 4). */
  maxDelegations?: number;
  /**
   * Auto-approve any permission the company asks for during the run. Required
   * for unattended automation (no human to click "approve"). Defaults to true.
   */
  autoApprove?: boolean;
};

// ---------------------------------------------------------------------------
// Artifact — the "product" an app-function node yields and later nodes consume
// ---------------------------------------------------------------------------

/**
 * A produced file (video, document, image…) flowing through the pipeline. App
 * nodes emit an {@link Artifact} so downstream cloud/social nodes can upload or
 * publish it without re-deriving the path. The engine still threads the whole
 * node output into the next node's `input`; connectors call {@link "artifacts"}
 * helpers to locate the most recent artifact when their own config omits one.
 */
export type Artifact = {
  /** Absolute local path to the produced file. */
  path: string;
  /** Best-effort MIME type (e.g. `video/mp4`, `image/png`); else `null`. */
  mimeType?: string | null;
  /** Optional human label (project topic, file name…). */
  title?: string | null;
  /** Public/shareable URL once an upload node has hosted it; else `null`. */
  url?: string | null;
};

/** Config for an `action.app.makeVideo` node. */
export type MakeVideoNodeConfig = {
  /** Topic / premise the movie is about. */
  topic: string;
  /** Visual/narrative style (e.g. "anime", "noir film"). */
  style: string;
  /** Narration language (e.g. "English", "Tiếng Việt"). */
  language: string;
  /** LLM model id for the scene-by-scene script. */
  scriptModel: string;
  /** Image model id for rendering each scene. */
  imageModel: string;
  /** Number of scenes to generate. */
  sceneCount: number;
  /** Stitch the rendered scene images into an `.mp4` (needs an image model). */
  renderVideo?: boolean;
  /** Seconds each scene image stays on screen when rendering a video. */
  secondsPerScene?: number;
};

/** What an `action.app.editor` node does to a file. */
export type EditorNodeOperation = 'create' | 'append';

/** Config for an `action.app.editor` node. */
export type EditorNodeConfig = {
  /** Absolute output path for the document. */
  path: string;
  /** Whether to create/overwrite or append to the file. */
  operation: EditorNodeOperation;
  /** Text content. Supports `{{input}}` substitution from the previous step. */
  content: string;
};

/** Supported cloud-storage providers for `action.cloud.upload`. */
export type CloudProviderKind = 's3' | 'webdav';

/** Config for an `action.cloud.upload` node. */
export type CloudUploadNodeConfig = {
  /** Which storage backend to upload to. */
  provider: CloudProviderKind;
  /** Optional explicit artifact path; defaults to the previous step's artifact. */
  sourcePath?: string;
  /** Destination object key / remote path (supports `{{input}}`). */
  destination?: string;
  // S3-compatible (AWS S3, Cloudflare R2, MinIO…)
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Make the uploaded object publicly readable (S3 ACL). */
  publicRead?: boolean;
  // WebDAV (Nextcloud, generic)
  baseUrl?: string;
  username?: string;
  password?: string;
};

/** Config for an `action.email.send` node (SMTP). */
export type EmailNodeConfig = {
  host: string;
  port: number;
  secure?: boolean;
  username?: string;
  password?: string;
  from: string;
  /** Comma-separated recipient list (supports `{{input}}`). */
  to: string;
  subject: string;
  /** Email body (supports `{{input}}`). */
  body: string;
  /** Attach the previous step's artifact, if any. */
  attachArtifact?: boolean;
};

/** Config for an `action.social.facebook` node (Graph API page post). */
export type FacebookNodeConfig = {
  /** Facebook Page id to publish to. */
  pageId: string;
  /** Page access token with publish permissions. */
  accessToken: string;
  /** Post caption / message (supports `{{input}}`). */
  message: string;
  /** Optionally attach the previous step's media artifact as a photo/video. */
  attachArtifact?: boolean;
  /** Public link to share (used instead of an artifact when set). */
  link?: string;
};

/** Config for an `action.social.tiktok` node (Content Posting API). */
export type TiktokNodeConfig = {
  /** OAuth access token for the TikTok Content Posting API. */
  accessToken: string;
  /** Video caption / title (supports `{{input}}`). */
  caption: string;
  /** Explicit video path; defaults to the previous step's video artifact. */
  videoPath?: string;
  /** Privacy level for the upload. */
  privacy?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY';
};

// ---------------------------------------------------------------------------
// Run events (streamed to the renderer over the event channel)
// ---------------------------------------------------------------------------

/**
 * A single lifecycle event emitted while a workflow runs. The discriminated
 * `type` lets the renderer build a live, ordered run log without parsing.
 */
export type RunEvent =
  | { type: 'run-start'; runId: string; at: number }
  | { type: 'node-start'; runId: string; nodeId: string; name: string; at: number }
  | { type: 'node-finish'; runId: string; nodeId: string; ok: boolean; output?: unknown; error?: string; at: number }
  | { type: 'run-finish'; runId: string; ok: boolean; at: number };

/** Execution context threaded between nodes — the previous node's output. */
export type NodeContext = {
  /** Output of the previous node (or `undefined` for the first node). */
  input: unknown;
};
