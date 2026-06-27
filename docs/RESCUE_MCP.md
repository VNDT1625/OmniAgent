# Rescue MCP Sidecar

The Omni MCP/IDE sidecar is a standalone local service for rescue work when the Electron app, renderer, or build pipeline is broken. It runs outside the Electron lifecycle and exposes MCP SSE tools for repo/file search, Git inspection, and bounded terminal commands.

## Start rescue mode

From the repo root on Windows PowerShell:

```powershell
bun run omni:rescue
```

Normal standalone mode uses the same service without truncating the rescue log:

```powershell
bun run omni:mcp
```

The command prints the MCP SSE URL, health URL, repo path, log path, and state file. By default the sidecar listens on `127.0.0.1:17890`. Override it when needed:

```powershell
$env:OMNI_MCP_PORT = '17990'
bun run omni:rescue
```

## Check health

```powershell
bun run omni:mcp:health
bun run omni:doctor
```

`omni:doctor` checks the repo path, log path, Git, Node, Bun, and whether the default sidecar health endpoint is already responding.

## If the app fails

1. Leave the broken app closed.
2. Run `bun run omni:rescue` from the repo root.
3. Give the printed `MCP SSE` URL to the agent/client that needs rescue tools.
4. Inspect logs at the printed `Logs` path.

The Electron app may connect to an already-running sidecar. If no sidecar is available, the app falls back to its existing in-process IDE MCP host.

## Stop the sidecar

If it is running in the foreground, press `Ctrl+C` in that terminal.

From another terminal:

```powershell
node scripts/omni-mcp-sidecar.cjs stop
```

## Data and naming notes

This rescue sidecar does not perform branding migration. It does not rename `.aionui`, does not create an `.omni` data migration, and does not rename or rewrite `aioncore.exe` references. Logs use `.omni/logs` only when `.omni` already exists; otherwise they fall back to `.aionui/logs` when present or `.omni-sidecar/logs`.
