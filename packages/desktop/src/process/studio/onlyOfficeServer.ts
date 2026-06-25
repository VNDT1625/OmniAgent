/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-demand ONLYOFFICE integration server (Yêu cầu 2a — full Office editing).
 *
 * ONLYOFFICE Docs has two halves:
 *  1. **Document Server** — the heavy editor engine (runs separately, e.g. a
 *     Docker container the user points us at; NOT bundled — it is ~GB).
 *  2. **Integration host** — a tiny HTTP server WE run that (a) serves the file
 *     to the Document Server and (b) receives the edited file back on save.
 *
 * This module is that integration host. It is started **only when the user opens
 * a document for full editing** and shuts itself down after an idle period (the
 * "chỉ gọi ra khi dùng tới" requirement). Each editing session gets a random
 * token; the server exposes:
 *
 *   GET  /download/<token>   → streams the current file bytes to Document Server
 *   POST /callback/<token>   → ONLYOFFICE save callback; on status 2/3 it
 *                              downloads the edited file `url` and overwrites disk
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { basename, extname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {
  admitParticipant,
  getPrimarySession,
  getSession as getCollabSession,
  listParticipants,
  passwordMatches,
  removeParticipant,
} from './collabServer';

/** One active editing session served by the integration host. */
type EditSession = {
  token: string;
  filePath: string;
  fileName: string;
  /** Document key ONLYOFFICE uses for caching; changes when the file changes. */
  documentKey: string;
};

/** Public info the renderer needs to mount the editor. */
export type EditSessionInfo = {
  token: string;
  /** URL the Document Server fetches the file from (reachable from the server). */
  downloadUrl: string;
  /** URL the Document Server posts the save callback to. */
  callbackUrl: string;
  /** Unique document key for ONLYOFFICE caching. */
  documentKey: string;
  /** File extension without the dot (docx, xlsx, pptx, …). */
  fileType: string;
  /** Title shown in the editor. */
  title: string;
};

/** How long the host stays up with no active sessions before shutting down. */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

let server: Server | null = null;
let serverPort = 0;
let idleTimer: NodeJS.Timeout | null = null;
const sessions = new Map<string, EditSession>();

/** Host the Document Server uses to reach us. Override if DS runs in Docker. */
let advertisedHost = '127.0.0.1';

/** Set the host:port the Document Server should use to reach this integration
 * host. When DS runs in Docker, `127.0.0.1` points at the container, so callers
 * may need `host.docker.internal`. Defaults to localhost. */
export const setAdvertisedHost = (host: string): void => {
  advertisedHost = host;
};

/** Current integration-host port (0 until the host is started). */
export const getServerPort = (): number => serverPort;

/** Compute a content-derived document key so edits invalidate the DS cache. */
const computeKey = async (filePath: string): Promise<string> => {
  try {
    const stat = await fs.stat(filePath);
    const raw = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    return createHash('sha1').update(raw).digest('hex').slice(0, 20);
  } catch {
    return randomBytes(10).toString('hex');
  }
};

/** Reset the idle shutdown timer; stops the host when no sessions remain. */
const armIdleTimer = (): void => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (sessions.size === 0) void stopServer();
  }, IDLE_SHUTDOWN_MS);
};

/** Read the full body of a request as a Buffer. */
const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * Download the edited file from the URL ONLYOFFICE provides in its callback and
 * overwrite the on-disk file. Uses global fetch (Node 18+/Electron).
 */
const saveEditedFile = async (session: EditSession, downloadUrl: string): Promise<void> => {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Document Server returned HTTP ${res.status} for the edited file.`);
  // Stream the edited file straight to disk instead of buffering it all in
  // memory — keeps RAM flat even for very large saved documents. Write to a
  // temp file first, then atomically rename so a crash mid-write can't corrupt
  // the original.
  if (res.body) {
    const tmpPath = `${session.filePath}.aionui-tmp-${randomBytes(6).toString('hex')}`;
    try {
      await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tmpPath));
      await fs.rename(tmpPath, session.filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  } else {
    // No streamable body (older runtime): fall back to a single buffer.
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(session.filePath, buf);
  }
  // Refresh the document key so the next open reflects the saved content.
  session.documentKey = await computeKey(session.filePath);
};

/** Send a JSON response with a status code. */
const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
};

/**
 * Handle the collaboration control surface (`/collab/*`). Peers on the LAN hit
 * these to discover the published doc and join it. Password-gated.
 *
 *   GET  /collab/info                 → { ok, hasSession, title?, fileType? }
 *   POST /collab/join {password,name} → { ok, join } | 401
 *   GET  /collab/participants/<id>    → { ok, participants }
 *   POST /collab/leave {shareId,participantId} → { ok }
 */
const handleCollab = async (req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> => {
  const sub = parts[1];

  // GET /collab/info — advertise whether a doc is published (no secrets).
  if (req.method === 'GET' && sub === 'info') {
    const session = getPrimarySession();
    if (!session) {
      sendJson(res, 200, { ok: true, hasSession: false });
      return;
    }
    sendJson(res, 200, { ok: true, hasSession: true, title: session.title, fileType: session.fileType });
    return;
  }

  // POST /collab/join — verify password, admit the peer, return editor config.
  if (req.method === 'POST' && sub === 'join') {
    const session = getPrimarySession();
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'no-session' });
      return;
    }
    let payload: { password?: string; name?: string } = {};
    try {
      payload = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    if (!passwordMatches(session.passwordHash, payload.password ?? '')) {
      sendJson(res, 401, { ok: false, error: 'bad-password' });
      return;
    }
    const participant = admitParticipant(session, payload.name ?? '');
    // The DS fetches the file from the host integration server. Peers use the
    // host's DS, so the host-side download/callback URLs are reachable from it.
    sendJson(res, 200, {
      ok: true,
      join: {
        shareId: session.shareId,
        documentServerUrl: session.documentServerUrl,
        documentType: session.documentType,
        fileType: session.fileType,
        title: session.title,
        documentKey: session.documentKey,
        downloadUrl: session.downloadUrl,
        callbackUrl: session.callbackUrl,
        participant,
      },
    });
    return;
  }

  // GET /collab/participants/<shareId> — presence list.
  if (req.method === 'GET' && sub === 'participants' && parts[2]) {
    const session = getCollabSession(parts[2]);
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'no-session' });
      return;
    }
    sendJson(res, 200, { ok: true, participants: listParticipants(parts[2]) });
    return;
  }

  // POST /collab/leave — drop a participant.
  if (req.method === 'POST' && sub === 'leave') {
    let payload: { shareId?: string; participantId?: string } = {};
    try {
      payload = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
    } catch {
      /* ignore */
    }
    if (payload.shareId && payload.participantId) removeParticipant(payload.shareId, payload.participantId);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not-found' });
};

/** Route a single request for the integration host. */
const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url ?? '/', `http://${advertisedHost}:${serverPort}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // Collab control surface is cross-origin (peer app → host LAN). Allow it.
  if (parts[0] === 'collab') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    await handleCollab(req, res, parts);
    return;
  }

  // GET /download/<token>
  if (req.method === 'GET' && parts[0] === 'download' && parts[1]) {
    const session = sessions.get(parts[1]);
    if (!session) {
      res.writeHead(404).end('Unknown session');
      return;
    }
    try {
      // Stream the file to the Document Server instead of buffering the whole
      // file into memory — large documents (hundreds of MB) would otherwise
      // spike Main-process RAM. `stat` first so we can advertise Content-Length.
      const stat = await fs.stat(session.filePath);
      // Use the correct MIME type so Chromium's PDF engine recognises the stream
      // when the viewer loads it in an <iframe> / <webview>.
      const ext = session.fileName.split('.').pop()?.toLowerCase() ?? '';
      const contentType = ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Content-Disposition': `inline; filename="${encodeURIComponent(session.fileName)}"`,
      });
      await pipeline(createReadStream(session.filePath), res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end('Could not read the file');
      else res.end();
    }
    return;
  }

  // POST /callback/<token>  (ONLYOFFICE save callback)
  if (req.method === 'POST' && parts[0] === 'callback' && parts[1]) {
    const session = sessions.get(parts[1]);
    if (!session) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 1 }));
      return;
    }
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString('utf-8') || '{}') as { status?: number; url?: string };
      // status 2 = ready to save (all users closed), 3 = save error, 6 = force-save while editing.
      if ((payload.status === 2 || payload.status === 6) && payload.url) {
        await saveEditedFile(session, payload.url);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 0 }));
    } catch (error) {
      console.error('[OnlyOfficeServer] callback failed:', error);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 1 }));
    }
    return;
  }

  res.writeHead(404).end('Not found');
};

/** Ensure the integration host is listening; returns its port. */
const ensureServer = async (): Promise<number> => {
  if (server && serverPort > 0) return serverPort;
  server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  serverPort = await new Promise<number>((resolve, reject) => {
    server!.once('error', reject);
    // Bind on all interfaces so a Dockerized Document Server can reach us.
    server!.listen(0, '0.0.0.0', () => {
      const addr = server!.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Failed to determine integration host port.'));
    });
  });
  console.log(`[OnlyOfficeServer] integration host listening on ${serverPort}`);
  return serverPort;
};

/**
 * Start (or reuse) the integration host and register an editing session for
 * `filePath`. Returns the URLs + keys the renderer needs to mount the editor.
 */
export const startEditSession = async (filePath: string): Promise<EditSessionInfo> => {
  const port = await ensureServer();
  const token = randomBytes(12).toString('hex');
  const fileName = basename(filePath);
  const documentKey = await computeKey(filePath);
  const session: EditSession = { token, filePath, fileName, documentKey };
  sessions.set(token, session);
  if (idleTimer) clearTimeout(idleTimer);

  const base = `http://${advertisedHost}:${port}`;
  return {
    token,
    downloadUrl: `${base}/download/${token}`,
    callbackUrl: `${base}/callback/${token}`,
    documentKey,
    fileType: extname(fileName).replace(/^\./, '').toLowerCase(),
    title: fileName,
  };
};

/** End an editing session; shuts the host down once none remain. */
export const endEditSession = (token: string): void => {
  sessions.delete(token);
  if (sessions.size === 0) armIdleTimer();
};

/** Stop the integration host and drop all sessions. */
export const stopServer = async (): Promise<void> => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  sessions.clear();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    serverPort = 0;
    console.log('[OnlyOfficeServer] integration host stopped (idle).');
  }
};
