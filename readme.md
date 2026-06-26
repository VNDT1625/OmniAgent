# Omni Agentic

<p align="center">
  <strong>Local-first agentic workspace for coding, automation, research, documents, browser control, databases, terminals, and multi-agent work.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active%20rebuild-32CD32?style=flat-square" alt="Status">
  &nbsp;
  <img src="https://img.shields.io/badge/license-Apache--2.0-32CD32?style=flat-square&logo=apache&logoColor=white" alt="License">
  &nbsp;
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-6C757D?style=flat-square&logo=linux&logoColor=white" alt="Platform">
  &nbsp;
  <img src="https://img.shields.io/badge/agentic-local--first-7C3AED?style=flat-square" alt="Local first">
</p>

---

## What is Omni Agentic?

**Omni Agentic** is a personal agentic desktop system: a local app where AI can read, understand, edit, test, automate, and operate tools on your machine with guard rails you control.

It is not only a chat UI. It is an **agentic operating layer** around your workspace:

- a real IDE agent plane for code and repo intelligence;
- a browser agent for live web work;
- a document and office studio;
- a database workbench;
- a terminal and command runner;
- an automation engine;
- a company-style multi-agent orchestrator;
- an external MCP gateway so other AI hosts can call Omni tools;
- a local-first architecture designed to reduce dependency on cloud services.

The goal is simple: **one local agentic system that can use powerful tools, stay understandable, and keep the user in control.**

---

## Core idea

Most AI products are either:

1. a chat box with limited tools, or
2. a cloud service that owns the workflow, or
3. a coding agent that only works inside one narrow IDE.

Omni Agentic is different. It is built as a **local agentic workspace** where the app carries part of the intelligence: repo maps, memory, file tools, terminal tools, browser tools, database tools, document tools, quick tests, and automation tools. The model does not need to hold everything in its context. It can ask Omni for the right slice of reality, act through guarded tools, and verify the result.

```text
User goal
  ↓
Omni workspace context
  ↓
AI model / CLI agent / external MCP client
  ↓
Guarded Omni tools
  ↓
Files, browser, terminal, database, documents, tests, automation
  ↓
Verified result + undoable work trail
```

---

## Highlights

### Omni IDE

A code-aware workspace built around repository understanding, not just file editing.

- Repo map and code graph.
- File explorer and editor.
- Semantic summaries and focused context packs.
- Go-to-definition and references.
- LSP integration where available.
- Quick Run and IDE terminal.
- Quick Test tracing for web, Android, and Windows targets.
- Wiki generation from verified repo evidence.
- Spec manager for requirements, tasks, traceability, and phase gates.
- Experience memory for hard bug-fix lessons.
- Session memory for each IDE chat tab.
- Team edit / collaboration primitives.

### External MCP Gateway

Expose Omni IDE tools to external AI hosts through a controlled gateway.

- Bootstrap an external session into the active workspace.
- List, read, search, map, summarize, and analyze repo files.
- Run guarded commands through `ide_command`.
- Write files through team-safe write/edit tools.
- Use ephemeral session memory.
- Optionally expose the gateway through web access for remote AI clients.
- Token/OAuth-based authorization model.
- Strict IDE Mode to stop raw shell/file operations and route them through Omni tools instead.

### Local-first agentic backend

Omni is designed to run on your machine and coordinate tools locally.

- Desktop app with local state.
- Local workspace access.
- Local terminal/session management.
- Local repo intelligence cache.
- Local memory layers.
- Optional cloud/model/API integrations when you choose them.

### Multi-model and multi-agent

Use the model or agent that fits the task.

- Built-in agent flows.
- CLI agent integration.
- OpenAI-compatible providers.
- Local models through Ollama or LM Studio style endpoints.
- Claude/Codex/Gemini-style external agents where configured.
- Multi-agent team workflows.
- Company-style role orchestration.

### Studio

A workspace for files and creation flows.

- Universal editor for code, text, documents, spreadsheets, slides, PDFs, images, media, and binary inspection.
- Office editing workflows.
- Make Video pipeline.
- Automation canvas.
- Repo IDE.
- AI-assisted document creation and editing.

### Browser agent

A controlled embedded browser for agentic web work.

- Browser tabs inside the app.
- Web agent actions: navigate, inspect, click, type, summarize, research.
- Transcript and content extraction.
- Background run survival.
- Browser-control MCP tools.

### Database workbench

A database client for both user and agent workflows.

- SQLite, PostgreSQL, MySQL.
- Cloud-style connectors such as D1 and Firestore work in progress.
- Schema browsing.
- Table detail, indexes, foreign keys.
- Query and script execution with read-only guards.
- Export and profiling tools.
- Agent-facing DB tools.

### Automation

Workflow automation inside the desktop app.

- HTTP, AI, transform, delay, log, and trigger nodes.
- App actions such as editor and video generation.
- Cloud upload, email, and social posting connectors.
- Agent company node.
- Webhook and schedule support.
- Credential vault for secrets.

### Safety direction

Omni should not let agents touch a repo naked. The intended safety direction is:

- checkpoint before agent/tool/terminal writes;
- journal operations by AI turn;
- inspect diffs before keeping changes;
- rollback single files, folders, or whole transactions;
- local repo capsule/vault for recovery even before GitHub push;
- dangerous command guard rails.

This is a core product direction, not an optional add-on.

---

## Why this exists

The long-term vision is to make a personal AI stack that is:

- **local-first** — useful even before cloud infrastructure exists;
- **tool-rich** — the app gives the AI strong tools instead of relying only on raw model intelligence;
- **model-flexible** — cloud, local, CLI, and external agents can all participate;
- **cost-aware** — use context packs, repo maps, local memory, and deterministic tools to reduce token waste;
- **recoverable** — agent work must be visible, journaled, and reversible;
- **integratable** — other apps and AI clients can call Omni through MCP/API surfaces;
- **future-ready** — designed as a base for a local AI product family, including a future local model layer.

---

## Architecture overview

```text
Electron Desktop App
  ├─ Renderer: React UI, IDE, Studio, Browser, Settings, Manager
  ├─ Main process: native bridges, local services, gateway, terminal, browser, IDE tools
  ├─ Backend service: conversations, agents, providers, MCP catalog, storage
  ├─ Built-in MCP servers: browser, IDE, automation, manager, testing, resources
  └─ External MCP Gateway: exposes selected Omni tools to outside AI hosts
```

Important boundaries:

| Layer | Role |
| --- | --- |
| Renderer | UI, panels, chat surfaces, editor surfaces |
| Main process | Native desktop capabilities, local tool services, bridges |
| Backend | Conversations, agents, provider/model settings, MCP registry |
| MCP tools | Structured capabilities for AI agents |
| MTUI / repo intelligence | Code maps, context packs, guarded file writes, undoable edits |

---

## Quick start

### Requirements

- Node.js 22 or newer, below 25.
- Bun.
- Git.
- Platform: Windows, macOS, or Linux.

### Install

```bash
bun install
```

### Run desktop app

```bash
bun start
```

### Common development checks

```bash
bun run lint:fix
bun run format
bunx tsc --noEmit
bun run test
```

For renderer or i18n changes:

```bash
bun run i18n:types
node scripts/check-i18n.js
```

Before pushing production-quality changes, use the project push workflow:

```bash
just push
```

---

## External AI connection model

Omni can act as a local tool server for external AI clients.

Typical flow:

```text
1. Enable Omni gateway in the desktop app.
2. Copy the local or web-access MCP endpoint.
3. Give the external AI client the bearer/OAuth authorization.
4. The external AI calls Omni tools instead of raw shell/file operations.
5. Omni routes reads, writes, commands, memory, DB, and repo intelligence through guard rails.
```

This enables workflows such as:

- ChatGPT using the local Omni IDE toolset.
- Claude Desktop reading and editing the same repo through Omni.
- Cursor-like or CLI agents using Omni's repository context and team-safe writes.
- Remote debugging through read-only debug bridge routes.

---

## Security and control

Omni's direction is explicit control, not invisible automation.

- Gateway is disabled by default.
- Dangerous tools are opt-in.
- Tokens can be rotated or revoked.
- Secrets should live in encrypted stores or ephemeral memory.
- External clients should be routed through structured tools, not raw filesystem access.
- Tool actions should be inspectable and eventually undoable.
- Online sharing must not use weak default passwords.

---

## Project map

```text
packages/
  desktop/              Electron app, renderer, main-process services
  web-host/             Headless web host layer
  web-cli/              Web UI CLI wrapper
  music-core/           Local music engine experiments
  shared-scripts/       Shared build scripts

tests/
  unit/                 Vitest unit and DOM tests
  e2e/                  Playwright tests

docs/
  guides/               Operator/user guides
  contributing/         Contributor rules
  architecture/         System design notes
  specs/                Engineering specs
  prds/                 Product requirement documents
```

---

## Roadmap

### Near term

- Finish the Omni branding split across README, docs, UI copy, and package metadata.
- Stabilize External MCP Gateway flows.
- Harden Strict IDE Mode and tool remapping.
- Improve command safety and terminal guard rails.
- Add Repo Capsule / local safety vault for lightweight recovery before GitHub push.
- Keep IDE collaboration and team-edit flows stable.

### Mid term

- Make Omni IDE the default development surface.
- Make repo safety mandatory before agent writes.
- Improve local model support and OpenAI-compatible local runtimes.
- Expand automation connectors.
- Strengthen browser and quick-test feedback loops.
- Turn experience memory into a practical debugging assistant.

### Long term

- Build toward an independent local AI stack.
- Make the app capable of carrying more task intelligence so the model can be smaller, cheaper, and more local.
- Provide a clean API/MCP layer for apps that want to embed Omni capabilities.
- Prepare the base for a dedicated local model layer.

---

## Development principles

- Local-first unless the user explicitly enables cloud access.
- Structured tools over raw shell access.
- Guarded writes over blind writes.
- Context packs over dumping whole repos into prompts.
- Tests and verification over trusting model claims.
- Reversible agent work over one-way automation.
- User control over hidden autonomy.

---

## License

Apache-2.0.

---

## Status

Omni Agentic is under active rebuild and rebranding. Some internal paths, package names, assets, and translated documents may still reflect the original upstream base while the product direction is being separated into Omni.
