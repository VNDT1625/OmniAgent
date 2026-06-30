/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * REAL end-to-end test for the Git Manager runner. Instead of mocking git, this
 * drives the user's actual `git` binary against a **bare local remote** (a
 * `file://`-style path), proving the whole flow works without GitHub, a token,
 * or the network: init → commit → push (up) → clone (down) → second commit →
 * push → pull (back). If `git` is not installed the suite skips itself rather
 * than failing the CI of a machine without git.
 *
 * Validates the Git Manager's core promise: "push lên GitHub thật" — here the
 * remote is a local bare repo, but the runner uses the exact same commands a
 * real remote would, so a green run means the commands are correct.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createGitRunner } from '@/process/git/gitRunner';

/** True when a `git` binary is on PATH. */
const gitAvailable = (): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const HAS_GIT = gitAvailable();
// Skip the whole suite (not fail) on a machine without git.
const describeGit = HAS_GIT ? describe : describe.skip;

describeGit('gitRunner — real git end-to-end (local bare remote)', () => {
  const runner = createGitRunner();
  let root: string;
  let bareRemote: string;
  let workA: string;
  let workB: string;
  /** Remote URL as a path git accepts cross-platform (forward slashes). */
  let remoteUrl: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-git-it-'));
    bareRemote = path.join(root, 'remote.git');
    workA = path.join(root, 'workA');
    workB = path.join(root, 'workB');
    fs.mkdirSync(workA, { recursive: true });
    // Create a bare repo to act as the "GitHub" remote.
    execFileSync('git', ['init', '--bare', '-b', 'main', bareRemote], { stdio: 'ignore' });
    remoteUrl = bareRemote.replace(/\\/g, '/');
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const author = { name: 'AionUi Test', email: 'test@aionui.local' };

  it('init + set remote, commit, and PUSH (the "up" / backup direction)', async () => {
    // init a working repo + point origin at the bare remote.
    const init = await runner.initAndSetRemote(workA, remoteUrl, 'main');
    expect(init.ok).toBe(true);

    // Write a file and commit ALL changes.
    fs.writeFileSync(path.join(workA, 'README.md'), '# Hello AionUi\n', 'utf-8');
    const commit = await runner.commitAll(workA, 'feat: initial commit', author);
    expect(commit.ok).toBe(true);

    // Push to the remote.
    const push = await runner.push(workA, 'main');
    expect(push.ok).toBe(true);

    // The bare remote now has the branch ref.
    const refs = execFileSync('git', ['--git-dir', bareRemote, 'branch', '--list'], { encoding: 'utf-8' });
    expect(refs).toMatch(/\bmain\b/);
  });

  it('CLONE (the "down" direction) brings the pushed content back', async () => {
    const clone = await runner.clone(remoteUrl, workB, 'main');
    expect(clone.ok).toBe(true);
    // The cloned working tree has the file we pushed.
    expect(fs.existsSync(path.join(workB, 'README.md'))).toBe(true);
    expect(fs.readFileSync(path.join(workB, 'README.md'), 'utf-8')).toContain('Hello AionUi');
  });

  it('status + log + changes reflect the real repo state', async () => {
    const status = await runner.status(workA);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.hasRemote).toBe(true);
    expect(status.changedCount).toBe(0); // clean after commit+push

    const log = await runner.log(workA, 10);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].subject).toBe('feat: initial commit');

    // Make an uncommitted edit → it shows up in changes() + status.changedCount.
    fs.writeFileSync(path.join(workA, 'note.txt'), 'scratch\n', 'utf-8');
    const changes = await runner.changes(workA);
    expect(changes.some((c) => c.path === 'note.txt')).toBe(true);
    const dirty = await runner.status(workA);
    expect(dirty.changedCount).toBeGreaterThanOrEqual(1);
  });

  it('PULL (the "back" direction) updates a clone after the other clone pushes', async () => {
    const pullRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-git-pull-it-'));
    try {
      const pullRemote = path.join(pullRoot, 'remote.git');
      const pullA = path.join(pullRoot, 'workA');
      const pullB = path.join(pullRoot, 'workB');
      fs.mkdirSync(pullA, { recursive: true });
      execFileSync('git', ['init', '--bare', '-b', 'main', pullRemote], { stdio: 'ignore' });
      const pullRemoteUrl = pullRemote.replace(/\\/g, '/');

      const init = await runner.initAndSetRemote(pullA, pullRemoteUrl, 'main');
      expect(init.ok).toBe(true);
      fs.writeFileSync(path.join(pullA, 'README.md'), '# Pull fixture\n', 'utf-8');
      expect((await runner.commitAll(pullA, 'feat: seed pull fixture', author)).ok).toBe(true);
      expect((await runner.push(pullA, 'main')).ok).toBe(true);

      expect((await runner.clone(pullRemoteUrl, pullB, 'main')).ok).toBe(true);
      fs.writeFileSync(path.join(pullB, 'CHANGES.md'), 'v2\n', 'utf-8');
      expect((await runner.commitAll(pullB, 'docs: add CHANGES', author)).ok).toBe(true);
      expect((await runner.push(pullB, 'main')).ok).toBe(true);

      const pull = await runner.pull(pullA, 'main');
      expect(pull.ok).toBe(true);
      expect(fs.existsSync(path.join(pullA, 'CHANGES.md'))).toBe(true);
    } finally {
      fs.rmSync(pullRoot, { recursive: true, force: true });
    }
  });
});
