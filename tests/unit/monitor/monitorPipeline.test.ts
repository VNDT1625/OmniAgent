/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the newly-wired monitor pipeline pieces (Yêu cầu 6):
 *
 * - `proposalStore`     — persists/recalls proposals by id + signature (6.9).
 * - `codeContextProvider` — parses stack refs, reads only within roots (6.3).
 * - `analyzerAgent`     — parses the model's fenced-JSON analysis (6.3).
 * - `sentryErrorSource` — projects a Sentry event onto a CapturedError (6.1).
 * - `patchValidationSandbox` — isolated apply + lease through coordinator (6.4/6.8).
 * - `patchApplier`      — reversible snapshot → apply → restore (6.5/6.7).
 *
 * All fs / leases are injected so nothing touches real disk or builds.
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProposalStore, type ProposalStoreFs } from '@/process/monitor/proposalStore';
import { createCodeContextProvider, parseStackRefs, type CodeContextFs } from '@/process/monitor/codeContextProvider';
import { parseAnalysisResponse } from '@/process/monitor/analyzerAgent';
import { capturedErrorFromSentryEvent, createSentryErrorSourceFrom } from '@/process/monitor/sentryErrorSource';
import { createPatchValidationSandbox, type ValidationSandboxFs } from '@/process/monitor/patchValidationSandbox';
import { createPatchApplier, filesInDiff, type PatchApplierFs } from '@/process/monitor/patchApplier';
import type { BugReport, PatchProposal } from '@/process/monitor/monitorTypes';
import type { Lease, LeaseRequest } from '@/process/resource/leaseTypes';

// --- helpers ----------------------------------------------------------------

const proposal = (over: Partial<PatchProposal> = {}): PatchProposal => ({
  id: over.id ?? 'p1',
  reportId: 'r1',
  signature: over.signature ?? 'sig',
  rootCause: 'rc',
  explanation: 'ex',
  diff: over.diff ?? '',
  risk: 'low',
  createdAt: 0,
  ...over,
});

const report = (over: Partial<BugReport> = {}): BugReport => ({
  id: 'r1',
  source: 'sentry',
  signature: 'sig',
  title: 't',
  message: 'm',
  breadcrumbs: [],
  occurrences: 1,
  firstSeen: 0,
  lastSeen: 0,
  ...over,
});

/** In-memory fs covering every method the monitor modules need. */
const createMemFs = () => {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return c;
    },
    writeFile: async (p: string, data: string) => {
      files.set(p, data);
    },
    rename: async (a: string, b: string) => {
      const c = files.get(a);
      if (c !== undefined) {
        files.set(b, c);
        files.delete(a);
      }
    },
    mkdir: async () => undefined,
    rm: async (target: string) => {
      for (const key of Array.from(files.keys())) {
        if (key === target || key.startsWith(`${target}/`) || key.startsWith(`${target}\\`)) files.delete(key);
      }
    },
    access: async (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT');
    },
  };
};

const createAccountingCoordinator = () => {
  const held = new Set<string>();
  const grants: LeaseRequest[] = [];
  let n = 0;
  return {
    coordinator: {
      requestLease: async (req: LeaseRequest): Promise<Lease> => {
        grants.push(req);
        const id = `l-${++n}`;
        held.add(id);
        return { id, kind: req.kind, grantedAt: n, estCostMB: req.estCostMB };
      },
      releaseLease: (id: string) => {
        held.delete(id);
      },
    },
    held,
    grants,
  };
};

// --- proposalStore ----------------------------------------------------------

describe('proposalStore (criterion 6.9)', () => {
  const FILE = path.join('store', 'patch-proposals.json');

  it('saves and recalls a proposal by id', async () => {
    const fsImpl = createMemFs();
    const store = createProposalStore({ filePath: FILE, fs: fsImpl as ProposalStoreFs });
    await store.save(proposal({ id: 'abc' }));
    const got = await store.get('abc');
    expect(got?.id).toBe('abc');
  });

  it('overwrites a proposal with the same id (no duplicates)', async () => {
    const fsImpl = createMemFs();
    const store = createProposalStore({ filePath: FILE, fs: fsImpl as ProposalStoreFs });
    await store.save(proposal({ id: 'abc', rootCause: 'first' }));
    await store.save(proposal({ id: 'abc', rootCause: 'second' }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].rootCause).toBe('second');
  });

  it('finds the latest proposal for a signature', async () => {
    const fsImpl = createMemFs();
    const store = createProposalStore({ filePath: FILE, fs: fsImpl as ProposalStoreFs });
    await store.save(proposal({ id: 'old', signature: 's', rootCause: 'old' }));
    await store.save(proposal({ id: 'new', signature: 's', rootCause: 'new' }));
    const found = await store.findBySignature('s');
    expect(found?.id).toBe('new');
  });
});

// --- codeContextProvider ----------------------------------------------------

describe('codeContextProvider (criterion 6.3)', () => {
  it('parses file:line refs from a stack', () => {
    const stack = 'Error: boom\n    at foo (src/a.ts:12:3)\n    at bar (/abs/b.ts:5)';
    const refs = parseStackRefs(stack);
    expect(refs.map((r) => r.file)).toContain('src/a.ts');
    expect(refs.find((r) => r.file === 'src/a.ts')?.line).toBe(12);
  });

  it('reads only files within a root and skips escapes', async () => {
    const root = path.resolve('app');
    const inside = path.join(root, 'src', 'a.ts');
    const memFs = createMemFs();
    memFs.files.set(inside, ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'));
    const provider = createCodeContextProvider({ roots: [root], fs: memFs as CodeContextFs, windowLines: 4 });

    const stack = `Error\n at f (src/a.ts:3:1)\n at g (../../etc/passwd:1:1)`;
    const out = await provider.gather(report({ stack }));
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(path.resolve(inside));
    expect(out[0].content).toContain('line3');
  });

  it('returns nothing when there is no stack', async () => {
    const provider = createCodeContextProvider({ roots: [path.resolve('app')], fs: createMemFs() as CodeContextFs });
    expect(await provider.gather(report({ stack: undefined }))).toEqual([]);
  });
});

// --- analyzerAgent JSON parsing ---------------------------------------------

describe('analyzerAgent.parseAnalysisResponse (criterion 6.3)', () => {
  it('parses a fenced JSON object with prose around it', () => {
    const raw =
      'Sure!\n```json\n{"rootCause":"rc","explanation":"ex","diff":"--- a\\n+++ b\\n","risk":"low"}\n```\nDone.';
    const out = parseAnalysisResponse(raw);
    expect(out.rootCause).toBe('rc');
    expect(out.risk).toBe('low');
    expect(out.diff).toContain('+++ b');
  });

  it('clamps an unknown risk to high (forces review, never auto-applies)', () => {
    const out = parseAnalysisResponse('{"rootCause":"rc","explanation":"ex","diff":"","risk":"banana"}');
    expect(out.risk).toBe('high');
  });

  it('throws on non-JSON', () => {
    expect(() => parseAnalysisResponse('not json at all')).toThrow();
  });
});

// --- sentryErrorSource ------------------------------------------------------

describe('sentryErrorSource (criterion 6.1)', () => {
  it('projects a Sentry event with an exception onto a CapturedError', () => {
    const captured = capturedErrorFromSentryEvent({
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'x is undefined',
            stacktrace: { frames: [{ function: 'foo', filename: 'a.ts', lineno: 5 }] },
          },
        ],
      },
    });
    expect(captured?.title).toBe('TypeError');
    expect(captured?.message).toBe('x is undefined');
    expect(captured?.stack).toContain('foo');
  });

  it('returns undefined when there is no usable error text', () => {
    expect(capturedErrorFromSentryEvent({})).toBeUndefined();
  });

  it('forwards captured errors to a subscribed source', () => {
    const listeners = new Set<(e: { title: string; message: string }) => void>();
    const tap = {
      subscribe: (fn: (e: { title: string; message: string }) => void) => (
        listeners.add(fn), () => listeners.delete(fn)
      ),
    };
    const source = createSentryErrorSourceFrom(tap as never);
    const seen: string[] = [];
    const unsub = source.subscribe((e) => seen.push(e.title));
    for (const l of listeners) l({ title: 'Boom', message: 'm' });
    expect(seen).toEqual(['Boom']);
    unsub();
    expect(listeners.size).toBe(0);
  });
});

// --- patchValidationSandbox -------------------------------------------------

const DIFF_A = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' line1', '-line2', '+line2patched'].join('\n');

describe('patchValidationSandbox (criteria 6.4 / 6.8)', () => {
  it('passes a clean-applying diff, leasing patchBuild and releasing it', async () => {
    const acct = createAccountingCoordinator();
    const memFs = createMemFs();
    const sourceRoot = path.resolve('src-root');
    memFs.files.set(path.join(sourceRoot, 'src/a.ts'), 'line1\nline2\n');
    const sandbox = createPatchValidationSandbox({
      sourceRoot,
      sandboxRoot: path.resolve('sbx'),
      coordinator: acct.coordinator,
      fs: memFs as ValidationSandboxFs,
      generateId: () => 'copy1',
    });

    const result = await sandbox.tryPatch(proposal({ diff: DIFF_A }));
    expect(result.passed).toBe(true);
    expect(acct.grants.map((g) => g.kind)).toEqual(['patchBuild']);
    expect(acct.held.size).toBe(0);
  });

  it('fails (balanced) when the diff does not apply cleanly', async () => {
    const acct = createAccountingCoordinator();
    const memFs = createMemFs();
    const sourceRoot = path.resolve('src-root');
    memFs.files.set(path.join(sourceRoot, 'src/a.ts'), 'completely different content\n');
    const sandbox = createPatchValidationSandbox({
      sourceRoot,
      sandboxRoot: path.resolve('sbx'),
      coordinator: acct.coordinator,
      fs: memFs as ValidationSandboxFs,
      generateId: () => 'copy1',
    });

    const result = await sandbox.tryPatch(proposal({ diff: DIFF_A }));
    expect(result.passed).toBe(false);
    expect(acct.held.size).toBe(0);
  });

  it('fails a command-validation failure even when the diff applies', async () => {
    const acct = createAccountingCoordinator();
    const memFs = createMemFs();
    const sourceRoot = path.resolve('src-root');
    memFs.files.set(path.join(sourceRoot, 'src/a.ts'), 'line1\nline2\n');
    const sandbox = createPatchValidationSandbox({
      sourceRoot,
      sandboxRoot: path.resolve('sbx'),
      coordinator: acct.coordinator,
      fs: memFs as ValidationSandboxFs,
      generateId: () => 'copy1',
      commandRunner: { run: async () => ({ ok: false, detail: 'typecheck failed' }) },
    });

    const result = await sandbox.tryPatch(proposal({ diff: DIFF_A }));
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/typecheck failed/);
    expect(acct.held.size).toBe(0);
  });
});

// --- patchApplier (reversibility) -------------------------------------------

describe('patchApplier (criteria 6.5 / 6.7)', () => {
  it('lists files a diff touches', () => {
    expect(filesInDiff(DIFF_A)).toEqual([{ relPath: 'src/a.ts' }]);
  });

  it('snapshots, applies, then restores the original bytes', async () => {
    const memFs = createMemFs();
    const targetRoot = path.resolve('target');
    const original = 'line1\nline2\n';
    const target = path.join(targetRoot, 'src/a.ts');
    memFs.files.set(target, original);

    const applier = createPatchApplier({ targetRoot, snapshotRoot: path.resolve('rb'), fs: memFs as PatchApplierFs });
    const p = proposal({ diff: DIFF_A });

    const { rollbackId } = await applier.snapshot(p);
    await applier.apply(p);
    expect(memFs.files.get(target)).toContain('line2patched');

    await applier.restore(rollbackId);
    expect(memFs.files.get(target)).toBe(original);
  });

  it('removes a newly-created file on rollback', async () => {
    const memFs = createMemFs();
    const targetRoot = path.resolve('target2');
    const newFileDiff = ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,1 @@', '+hello'].join('\n');
    const applier = createPatchApplier({ targetRoot, snapshotRoot: path.resolve('rb2'), fs: memFs as PatchApplierFs });
    const p = proposal({ id: 'pnew', diff: newFileDiff });

    const { rollbackId } = await applier.snapshot(p);
    await applier.apply(p);
    const created = path.join(targetRoot, 'src/new.ts');
    expect(memFs.files.get(created)).toContain('hello');

    await applier.restore(rollbackId);
    expect(memFs.files.has(created)).toBe(false);
  });

  it('refuses to patch a path escaping the target root', async () => {
    const memFs = createMemFs();
    const escapeDiff = ['--- a/../../evil.ts', '+++ b/../../evil.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    const applier = createPatchApplier({
      targetRoot: path.resolve('safe'),
      snapshotRoot: path.resolve('rb3'),
      fs: memFs as PatchApplierFs,
    });
    await expect(applier.snapshot(proposal({ id: 'evil', diff: escapeDiff }))).rejects.toThrow(
      /outside the target root/
    );
  });
});

// --- manual-trigger contract (no auto-analysis on capture) ------------------

describe('monitor manual-fix contract (criterion 6.6 — user must press Fix)', () => {
  it('capturing an error does NOT trigger analysis when no onReport hook is wired', async () => {
    // Mirrors how monitorWiring builds the bug monitor: store + sources only,
    // NO onReport. So capturing must only record — never analyse/patch.
    const fsImpl = createMemFs();
    const { createReportStore } = await import('@/process/monitor/reportStore');
    const reportStore = createReportStore({ filePath: path.join('s', 'bug-reports.json'), fs: fsImpl as never });

    const { createBugMonitor } = await import('@/process/monitor/bugMonitor');
    const monitor = createBugMonitor({ store: reportStore });
    monitor.start();

    await monitor.capture({ title: 'Boom', message: 'kaboom' });

    // The report is stored — but with no onReport hook, nothing downstream ran.
    expect((await reportStore.list()).length).toBe(1);
  });

  it('analysis only runs when explicitly invoked on a stored report', async () => {
    const fsImpl = createMemFs();
    const { createReportStore } = await import('@/process/monitor/reportStore');
    const reportStore = createReportStore({ filePath: path.join('s2', 'bug-reports.json'), fs: fsImpl as never });
    const proposalStore = createProposalStore({
      filePath: path.join('s2', 'proposals.json'),
      fs: fsImpl as ProposalStoreFs,
    });

    const { createRootCauseAnalyzer } = await import('@/process/monitor/rootCauseAnalyzer');
    const agent = {
      analyze: vi.fn(async () => ({ rootCause: 'rc', explanation: 'ex', diff: '', risk: 'low' as const })),
    };
    const analyzer = createRootCauseAnalyzer({
      store: reportStore,
      codeContext: { gather: async () => [] },
      agent,
      knownFixes: proposalStore,
    });

    const stored = await reportStore.record({ source: 'sentry', title: 'X', message: 'specific failure' });
    expect(agent.analyze).not.toHaveBeenCalled(); // recording alone never analyses

    // Explicit, user-triggered analysis (what fixReport does internally).
    const { proposal: out } = await analyzer.analyze(stored);
    expect(agent.analyze).toHaveBeenCalledTimes(1);
    expect(out.rootCause).toBe('rc');
  });
});

// --- releasePublisher (Yêu cầu 6 — publish an applied fix as a branch) ------

describe('releasePublisher (branch + commit + guarded push)', () => {
  const proposalWithDiff = (over: Partial<PatchProposal> = {}): PatchProposal =>
    proposal({ diff: DIFF_A, rootCause: 'null deref in foo', explanation: 'guard the null', ...over });

  /** A fake GitRunner recording every git invocation, with a scripted remote URL. */
  const fakeGit = (remoteUrl: string) => {
    const calls: string[][] = [];
    return {
      calls,
      runner: {
        run: async (args: string[]) => {
          calls.push(args);
          if (args[0] === 'remote' && args[1] === 'get-url') {
            return { stdout: remoteUrl, stderr: '', code: remoteUrl ? 0 : 1 };
          }
          return { stdout: '', stderr: '', code: 0 };
        },
      },
    };
  };

  it('prepares a branch + commit locally and does NOT push by default', async () => {
    const { createReleasePublisher } = await import('@/process/monitor/releasePublisher');
    const git = fakeGit('https://github.com/me/fork.git');
    const publisher = createReleasePublisher({
      git: git.runner,
      prOpener: { open: async () => ({ compareUrl: 'x' }) },
      config: { push: false },
    });

    const result = await publisher.publish(proposalWithDiff());
    expect(result.pushed).toBe(false);
    expect(result.branch).toMatch(/^fix\/monitor-/);
    // Created the branch, staged only the diff's files, committed — but never pushed.
    expect(git.calls.some((c) => c[0] === 'checkout' && c.includes('-b'))).toBe(true);
    expect(git.calls.some((c) => c[0] === 'commit')).toBe(true);
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('REFUSES to push to the protected upstream remote (VNDT1625/OmniAgent)', async () => {
    const { createReleasePublisher } = await import('@/process/monitor/releasePublisher');
    const git = fakeGit('https://github.com/VNDT1625/OmniAgent.git');
    const publisher = createReleasePublisher({
      git: git.runner,
      prOpener: { open: async () => ({}) },
      config: { push: true, targetRemote: 'origin' },
    });

    const result = await publisher.publish(proposalWithDiff());
    expect(result.pushed).toBe(false);
    expect(result.note).toMatch(/upstream/i);
    expect(git.calls.some((c) => c[0] === 'push')).toBe(false); // never pushed
  });

  it('pushes to a fork remote and opens a PR when push is enabled', async () => {
    const { createReleasePublisher } = await import('@/process/monitor/releasePublisher');
    const git = fakeGit('https://github.com/me/fork.git');
    const publisher = createReleasePublisher({
      git: git.runner,
      prOpener: { open: async ({ branch }) => ({ prUrl: `https://github.com/me/fork/pull/1#${branch}` }) },
      config: { push: true, targetRemote: 'tomni-agentic-fork' },
    });

    const result = await publisher.publish(proposalWithDiff());
    expect(result.pushed).toBe(true);
    expect(result.prUrl).toContain('/pull/1');
    expect(git.calls.some((c) => c[0] === 'push' && c.includes('tomni-agentic-fork'))).toBe(true);
  });
});
