import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCoreDoctorReport } from '@process/services/diagnostics/coreDoctor';
import {
  CoreTelemetryRecorder,
  JsonlCoreTelemetrySink,
  MemoryCoreTelemetrySink,
  toPublicCoreTelemetryEvent,
} from '@process/services/diagnostics/coreTelemetry';
import { normalizeTelemetryLimit } from '@process/experimentalCore/experimentalCoreBridge';
import type { CoreAdapter, DetectedCoreTarget } from '@process/experimentalCore/adapters';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const identity = { runId: 'run-1', sessionId: 'session-1', targetId: 'codex' };

describe('core telemetry', () => {
  it('measures first token, completion, retry and tool outcomes without storing prompt data', async () => {
    let now = 100;
    const sink = new MemoryCoreTelemetrySink();
    const recorder = new CoreTelemetryRecorder(sink, () => now);
    await recorder.startRun(identity, { protocol: 'acp', prompt: 'private prompt', token: 'secret' });
    now = 225;
    await recorder.firstToken(identity.runId);
    await recorder.retry(identity.runId, 'Bearer abcdefghijklmnop');
    await recorder.toolStarted(identity.runId, 'Tomny_Read');
    await recorder.toolCompleted(identity.runId, 'Tomny_Read', 'error');
    now = 500;
    await recorder.complete(identity.runId);

    expect(recorder.snapshot(identity.runId)).toMatchObject({
      firstTokenMs: 125,
      completionMs: 400,
      retryCount: 1,
      toolCallCount: 1,
      toolFailureCount: 1,
      terminalState: 'completed',
    });
    const events = await sink.query({ runId: identity.runId });
    expect(events[0]?.attributes).toEqual({ protocol: 'acp' });
    expect(JSON.stringify(events)).not.toContain('private prompt');
    expect(JSON.stringify(events)).not.toContain('abcdefghijklmnop');
  });

  it('recovers the valid hash-chained prefix after a partial JSONL write', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tomny-telemetry-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'events.jsonl');
    const first = new JsonlCoreTelemetrySink(filePath);
    await first.append({ ...identity, eventId: 'event-1', kind: 'run-started', timestamp: 1, elapsedMs: 0 });
    await appendFile(filePath, '{"sequence":2', 'utf8');

    const recovered = new JsonlCoreTelemetrySink(filePath);
    expect(await recovered.query()).toHaveLength(1);
    expect(await readFile(filePath, 'utf8')).not.toContain('{"sequence":2');
  });

  it('rejects recording events after a terminal state', async () => {
    const recorder = new CoreTelemetryRecorder(new MemoryCoreTelemetrySink(), () => 1);
    await recorder.startRun(identity);
    await recorder.cancel(identity.runId);
    await expect(recorder.retry(identity.runId)).rejects.toThrow('already terminal');
  });

  it('redacts migrated telemetry again before it crosses the renderer boundary', () => {
    const event = toPublicCoreTelemetryEvent({
      ...identity,
      eventId: 'event-1',
      kind: 'tool-started',
      timestamp: 1,
      elapsedMs: 0,
      tool: 'Read C:\\Users\\Alice\\secret.txt token=abcdefghijklmnop',
      attributes: { protocol: 'acp', prompt: 'must never cross IPC' },
    });

    expect(event.tool).toContain('[USER_HOME]');
    expect(JSON.stringify(event)).not.toContain('Alice');
    expect(JSON.stringify(event)).not.toContain('must never cross IPC');
  });

  it('bounds diagnostic telemetry queries', () => {
    expect(normalizeTelemetryLimit(undefined)).toBe(200);
    expect(normalizeTelemetryLimit(-10)).toBe(1);
    expect(normalizeTelemetryLimit(100_000)).toBe(1_000);
  });
});

describe('core doctor', () => {
  it('reports an available target without a direct adapter as unhealthy', () => {
    const target: DetectedCoreTarget = {
      id: 'claude',
      name: 'Claude',
      protocol: 'acp',
      candidates: ['claude-agent-acp'],
      args: [],
      detail: 'ACP',
      runnable: true,
      detected: true,
      available: true,
      command: 'claude-agent-acp',
    };
    const report = buildCoreDoctorReport({ targets: [target], adapters: [], telemetry: [], generatedAt: 100 });
    expect(report.status).toBe('unhealthy');
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'adapter-missing', targetId: 'claude' }));
  });

  it('calculates aggregate health metrics from transport-neutral events', () => {
    const adapter = { protocol: 'acp' } as CoreAdapter;
    const target: DetectedCoreTarget = {
      id: 'claude',
      name: 'Claude',
      protocol: 'acp',
      candidates: ['claude-agent-acp'],
      args: [],
      detail: 'ACP',
      runnable: true,
      detected: true,
      available: true,
      command: 'claude-agent-acp',
    };
    const report = buildCoreDoctorReport({
      targets: [target],
      adapters: [adapter],
      generatedAt: 1_000,
      telemetry: [
        { ...identity, eventId: '1', kind: 'run-started', timestamp: 0, elapsedMs: 0 },
        { ...identity, eventId: 'startup', kind: 'startup-completed', timestamp: 10, elapsedMs: 10 },
        { ...identity, eventId: '2', kind: 'first-token', timestamp: 25, elapsedMs: 25 },
        { ...identity, eventId: '3', kind: 'completed', timestamp: 100, elapsedMs: 100 },
      ],
    });
    expect(report.metrics).toMatchObject({
      runCount: 1,
      completionRate: 1,
      startupP95Ms: 10,
      firstTokenP95Ms: 25,
      completionP95Ms: 100,
    });
  });
});
