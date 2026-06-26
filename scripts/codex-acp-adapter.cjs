#!/usr/bin/env node
/**
 * Minimal ACP adapter for current Codex CLI versions.
 *
 * Codex CLI no longer exposes `codex acp`, but AionUi's agent catalog expects
 * an ACP JSON-RPC stdio server. This adapter implements the small ACP surface
 * AionUi needs and delegates each prompt to `codex exec`.
 */

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

const JSONRPC_VERSION = '2.0';
const sessions = new Map();
let sessionCounter = 0;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: JSONRPC_VERSION, id, result });
}

function fail(id, code, message) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: JSONRPC_VERSION, method, params });
}

function getTextPart(part) {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

function extractPrompt(params) {
  const prompt = params && params.prompt;
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map(getTextPart).filter(Boolean).join('\n\n');
  }
  if (params && typeof params.input === 'string') return params.input;
  if (params && typeof params.message === 'string') return params.message;
  return '';
}

function extractWorkspace(params) {
  const candidates = [
    params && params.cwd,
    params && params.workspace,
    params && params.path,
    params && params.session && params.session.cwd,
    params && params.session && params.session.workspace,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return process.cwd();
}

function resolveCodexCommand() {
  return process.env.CODEX_CLI_PATH || process.env.CODEX_PATH || 'codex';
}

function resolveCodexArgs(prompt, session) {
  const args = ['exec', '--skip-git-repo-check', '--color', 'never'];
  if (session.modelId) args.push('-m', session.modelId);
  if (session.mode === 'read-only' || session.mode === 'auto' || session.mode === 'full-access') {
    const sandbox =
      session.mode === 'full-access' ? 'danger-full-access' : session.mode === 'auto' ? 'workspace-write' : 'read-only';
    args.push('-s', sandbox);
  }
  args.push('-C', session.workspace, '-');
  return args;
}

function runCodex(prompt, session, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCodexCommand(), resolveCodexArgs(prompt, session), {
      cwd: session.workspace,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onChunk(text);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ text: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error((stderr || stdout || `codex exec exited with code ${code}`).trim()));
      }
    });

    child.stdin.end(prompt);
  });
}

async function handleRequest(message) {
  const { id, method, params = {} } = message || {};

  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: 1,
          serverCapabilities: { streaming: true, sessionManagement: true },
          serverInfo: { name: 'codex-acp-adapter', version: '1.0.0' },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, embeddedContext: false },
          },
          authMethods: [],
        });
        break;

      case 'session/new': {
        const sessionId = `codex-adapter-${++sessionCounter}`;
        const workspace = path.resolve(extractWorkspace(params));
        const modelId = params.currentModelId || params.modelId || params.model || 'gpt-5.3-codex';
        sessions.set(sessionId, { workspace, modelId, mode: 'auto' });
        respond(id, {
          sessionId,
          modes: [
            { id: 'read-only', name: 'Read only' },
            { id: 'auto', name: 'Auto' },
            { id: 'full-access', name: 'Full access' },
          ],
          configOptions: [],
          models: {
            currentModelId: modelId,
            availableModels: [
              { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
              { id: 'gpt-5.2-codex', name: 'gpt-5.2-codex' },
              { id: 'gpt-5.1-codex-max', name: 'gpt-5.1-codex-max' },
              { id: 'gpt-5.1-codex-mini', name: 'gpt-5.1-codex-mini' },
            ],
          },
        });
        break;
      }

      case 'session/set_mode': {
        const session = sessions.get(params.sessionId);
        if (session && typeof params.modeId === 'string') session.mode = params.modeId;
        if (session && typeof params.mode === 'string') session.mode = params.mode;
        respond(id, {});
        break;
      }

      case 'session/set_model': {
        const session = sessions.get(params.sessionId);
        if (session && typeof params.modelId === 'string') session.modelId = params.modelId;
        if (session && typeof params.model === 'string') session.modelId = params.model;
        respond(id, {});
        break;
      }

      case 'session/set_config_option':
        respond(id, {});
        break;

      case 'session/cancel':
        respond(id, {});
        break;

      case 'session/prompt': {
        const sessionId = params.sessionId;
        const session = sessions.get(sessionId) || { workspace: process.cwd(), modelId: 'gpt-5.3-codex', mode: 'auto' };
        const prompt = extractPrompt(params);
        if (!prompt.trim()) {
          respond(id, { stopReason: 'end_turn' });
          break;
        }

        await runCodex(prompt, session, (chunk) => {
          notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk },
            },
          });
        });
        respond(id, { stopReason: 'end_turn' });
        break;
      }

      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    fail(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    void handleRequest(JSON.parse(trimmed));
  } catch {
    // Ignore malformed input to match permissive ACP adapters.
  }
});

process.stdin.resume();
