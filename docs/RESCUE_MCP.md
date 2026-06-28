# Rescue MCP sidecar

The Omni MCP/IDE sidecar is a standalone service for rescue work when the Electron app, renderer, or build pipeline is broken. It runs outside the Electron lifecycle and exposes repo/file/search/Git/terminal tools.

## Start ChatGPT rescue mode

From the repo root on Windows PowerShell:

```powershell
bun run omni:rescue
```

`omni:rescue` now starts three pieces together:

- the local rescue sidecar: `http://127.0.0.1:17890/sse`
- the ChatGPT-compatible gateway: `http://127.0.0.1:47821/ide/mcp`
- a Cloudflare Quick Tunnel that forwards to the gateway when `cloudflared` is available

The command prints:

- local health URL
- local SSE URL
- local gateway MCP URL
- public MCP URL when the tunnel starts successfully
- `Authorization: Bearer <printed token>`
- required first tool: `omni_bootstrap_session` with `{}`

Use the printed **public MCP URL** and Bearer token in the ChatGPT `Omni_ide` connector. If the connector still points to an old app tunnel URL, ChatGPT can still return `502` even though local rescue health is `ok:true`.

## Local-only rescue mode

For local MCP clients that can reach `127.0.0.1` directly and only need raw SSE:

```powershell
bun run omni:rescue:local
```

Normal standalone mode uses the same service without truncating the rescue log:

```powershell
bun run omni:mcp
```

## Why plain local health can be OK while ChatGPT still gets 502

`bun run omni:mcp:health` checks only the local sidecar. ChatGPT's `Omni_ide` connector uses the external gateway contract instead:

- Streamable HTTP path: `/ide/mcp`
- auth: Bearer token or configured OAuth
- first tool: `omni_bootstrap_session`
- public URL: Cloudflare tunnel or another reverse proxy

So these can both be true:

```text
bun run omni:mcp:health  -> ok:true
ChatGPT Omni_ide         -> 502
```

That means ChatGPT is not reaching the rescue gateway/tunnel URL. Update the connector to the printed public MCP URL and token.

## Override ports

```powershell
$env:OMNI_MCP_PORT = '17890'
$env:OMNI_GATEWAY_PORT = '47821'
bun run omni:rescue
```

Set `OMNI_GATEWAY_TOKEN` to choose a stable token for the session. Set `OMNI_GATEWAY_ALLOW_DANGEROUS=0` to disable dangerous rescue tools; by default rescue enables them because the point is to repair a broken repo/app.

## Check health

```powershell
bun run omni:mcp:health
bun run omni:doctor
```

`omni:doctor` checks the repo path, log path, Git, Node, Bun, and whether the default sidecar health endpoint is already responding.

## Stop the sidecar

If it is running in the foreground, press `Ctrl+C` in that terminal.

From another terminal:

```powershell
node scripts/omni-mcp-sidecar.cjs stop
```

## Data and naming notes

This rescue sidecar does not perform branding migration. It does not rename `.aionui`, does not create an `.omni` data migration, and does not rename or rewrite `aioncore.exe` references. Logs use `.omni/logs` only when `.omni` already exists; otherwise they fall back to `.aionui/logs` when present or `.omni-sidecar/logs`.
