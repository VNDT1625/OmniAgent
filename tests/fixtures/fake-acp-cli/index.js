#!/usr/bin/env node
/** Deterministic ACP JSON-RPC fixture selected by argv. */
const JSONRPC_VERSION = '2.0';
const scenario = process.argv[2] || 'happy';
let sessionCounter = 0;
let promptCounter = 0;
const pendingPrompts = new Map();

function sendResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result })}\n`);
}
function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } })}\n`);
}
function sendNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params })}\n`);
}
function streamText(sessionId, text) {
  const splitAt = Math.max(1, Math.floor(text.length / 2));
  for (const chunk of [text.slice(0, splitAt), text.slice(splitAt)]) {
    if (!chunk) continue;
    sendNotification('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
    });
  }
}
function completePrompt(id, sessionId, promptText) {
  if (scenario === 'tool') {
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'fixture-tool-1',
        title: 'Read fixture file',
        kind: 'read',
        status: 'pending',
        rawInput: { path: 'fixture.txt' },
      },
    });
    sendNotification('session/update', {
      sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'fixture-tool-1', status: 'in_progress' },
    });
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'fixture-tool-1',
        status: 'completed',
        rawOutput: { text: 'fixture content' },
      },
    });
  }
  streamText(sessionId, `Fake response to: ${promptText}`);
  sendResponse(id, { stopReason: 'end_turn' });
}
function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: scenario === 'incompatible' ? -1 : params?.protocolVersion,
        agentCapabilities:
          scenario === 'degraded'
            ? {}
            : {
                promptCapabilities: { image: true },
                mcpCapabilities: { http: true, sse: true },
              },
        agentInfo: { name: 'fake-acp-cli', version: '1.0.0' },
      });
      break;
    case 'session/new': {
      sessionCounter += 1;
      sendResponse(id, {
        sessionId: `fake-session-${sessionCounter}`,
        modes: null,
        configOptions: [],
        models:
          scenario === 'degraded'
            ? null
            : {
                currentModelId: 'fake-model-1',
                availableModels: [{ modelId: 'fake-model-1', name: 'Fake Model' }],
              },
      });
      break;
    }
    case 'session/prompt': {
      promptCounter += 1;
      const sessionId = params?.sessionId || 'unknown';
      const promptText = Array.isArray(params?.prompt) && params.prompt[0]?.text ? params.prompt[0].text : 'unknown';
      if (scenario === 'retry' && promptCounter === 1) {
        sendError(id, -32000, 'server busy status 503');
        break;
      }
      if (scenario === 'cancel') {
        pendingPrompts.set(sessionId, id);
        break;
      }
      completePrompt(id, sessionId, promptText);
      break;
    }
    case 'session/cancel': {
      const pendingId = pendingPrompts.get(params?.sessionId);
      if (pendingId !== undefined) {
        pendingPrompts.delete(params.sessionId);
        sendResponse(pendingId, { stopReason: 'cancelled' });
      }
      break;
    }
    case 'session/set_mode':
    case 'session/set_model':
    case 'session/set_config_option':
      sendResponse(id, {});
      break;
    default:
      if (id !== undefined) sendError(id, -32601, `Method not found: ${String(method)}`);
  }
}
const stdin = require('readline').createInterface({ input: process.stdin, terminal: false });
stdin.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleRequest(JSON.parse(trimmed));
  } catch {
    /* Ignore malformed test input. */
  }
});
process.stdin.resume();
