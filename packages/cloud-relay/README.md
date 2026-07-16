# AionUi Cloud Workspace Relay

Production relay for two or more AionUi desktop replicas. Each workspace is one
Cloudflare Durable Object (ordered manifest, operations, leases, presence and
WebSockets); immutable file bodies are stored in R2.

## Deploy

Prerequisites: Cloudflare Workers and R2 enabled, Wrangler authenticated, and an
R2 bucket named `aionui-cloud-relay-blobs`.

```bash
bunx wrangler r2 bucket create aionui-cloud-relay-blobs
bun run check
bun run deploy
```

The default production URL is printed by Wrangler. Enter that URL in AionUi's
**Cloud workspace** dialog. On the first device, use **Generate secure
credentials**, then share the generated Workspace ID and token with the second
device over a secure channel. Both devices must select their local clone folder
when connecting.

A workspace is created on its first authenticated request. Its random UUID is
part of its security boundary, and the 64-character token becomes the immutable
workspace secret. Do not use a human-readable workspace ID or send the token in
chat/email. WebSockets use a 60-second, one-time ticket so the secret is never
placed in the connection URL.

## Consistency model

- Every mutation requires a per-file lease and a matching `baseHash`.
- The Durable Object assigns one monotonically increasing operation sequence.
- Online peers receive operations over hibernatable WebSockets.
- Local disk is the offline journal. Reconnect performs a three-way merge using
  the last synchronized blob as the base.
- Disjoint text edits merge automatically. Overlapping text edits, binary edits,
  and delete-versus-edit cases remain local until explicitly resolved.
- Operation IDs are idempotent. The manifest is durable; the last 5,000
  operations are retained for fast catch-up, after which clients reload it.

The replica intentionally excludes `.git`, dependency/build/cache directories,
`.env*`, files larger than 18 MiB, and repositories over 20,000 included files.
Git history and secrets remain device-local. Git can still be used normally for
commits and remote backup; it is not the realtime transport.

## Operations

```bash
bunx wrangler tail --config packages/cloud-relay/wrangler.jsonc
bunx wrangler versions list --config packages/cloud-relay/wrangler.jsonc
bunx wrangler rollback --config packages/cloud-relay/wrangler.jsonc
```

R2 blobs are content-addressed. Back up the R2 bucket for disaster recovery.
Old unreferenced blobs are safe to delete only after comparing them with all
live manifest hashes. Apply Cloudflare rate limiting/WAF rules to `/v1/*` when
exposing the relay outside a trusted team.
