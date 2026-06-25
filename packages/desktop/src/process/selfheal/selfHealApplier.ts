/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `selfHealApplier` — executes the concrete {@link SelfHealFix} carried by a
 * Tier-0 finding. Three fix kinds are auto-applicable and each is reversible or
 * idempotent:
 *
 *  - **rename-identifier** — rewrite a bare identifier (icon name) across import
 *    specifiers + usages within a SINGLE file, taking a snapshot of the original
 *    content first so the change can be reverted.
 *  - **install-package** — run the injected package-manager command to install a
 *    pinned dependency (idempotent: installing an already-present package is a
 *    no-op).
 *  - **copy-locale-file** — copy the base-language json to the missing locale
 *    path (only creates; never overwrites an existing file).
 *
 * `manual` fixes are never executed here — they are surfaced for a human / Tier 1.
 *
 * All fs + command access is injected so this is unit-testable without real disk
 * or a real package manager. Identifier rewriting uses word-boundary matching so
 * `Branch` does not corrupt `BranchTwo`.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { SelfHealFinding, SelfHealFix, SelfHealFixResult } from './selfHealTypes';

/** Minimal fs surface used by the applier (injectable for tests). */
export type SelfHealFs = {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, data: string): Promise<void>;
  /** Resolve when the path exists, reject otherwise. */
  access(filePath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
};

/** Runs a package-manager install for a single package. */
export type PackageInstaller = {
  /** Install `packageName`; resolve ok=false (with detail) on failure. */
  install(packageName: string): Promise<{ ok: boolean; detail?: string }>;
};

/** Options for {@link createSelfHealApplier}. */
export type SelfHealApplierDeps = {
  /** fs implementation. */
  fs: SelfHealFs;
  /** Optional package installer; when absent, install-package fixes are skipped. */
  installer?: PackageInstaller;
  /**
   * Snapshot sink for reversibility: called with (filePath, originalContent)
   * before a `rename-identifier` write so the caller can persist a rollback
   * point. Optional — omit to skip snapshotting (e.g. when git already tracks it).
   */
  onSnapshot?: (filePath: string, original: string) => Promise<void>;
  /** Directory separator extractor for `copy-locale-file` mkdir. Defaults to POSIX-ish. */
  dirnameOf?: (filePath: string) => string;
};

/** Default dirname that handles both `/` and `\` separators. */
const defaultDirname = (filePath: string): string => {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx <= 0 ? '.' : filePath.slice(0, idx);
};

/** Escape a string for use as a literal inside a RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace every whole-word occurrence of `from` with `to` in `source`. Word
 * boundaries (`\b`) ensure `Branch` does not match inside `BranchTwo` or
 * `gitBranchName`. Returns the new text + how many replacements were made.
 */
export const rewriteIdentifier = (source: string, from: string, to: string): { text: string; count: number } => {
  const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g');
  let count = 0;
  const text = source.replace(re, () => {
    count++;
    return to;
  });
  return { text, count };
};

/** Public contract of the self-heal applier. */
export type ISelfHealApplier = {
  /** Apply a single finding's fix. Never throws — returns a result. */
  apply(finding: SelfHealFinding): Promise<SelfHealFixResult>;
  /** Apply every auto-fixable finding (skips `manual`). Returns per-fix results. */
  applyAll(findings: SelfHealFinding[]): Promise<SelfHealFixResult[]>;
};

/**
 * Create a {@link ISelfHealApplier} over the injected fs + installer.
 *
 * @param deps fs, optional installer, optional snapshot sink.
 * @returns An applier that executes Tier-0 fixes reversibly/idempotently.
 */
export const createSelfHealApplier = (deps: SelfHealApplierDeps): ISelfHealApplier => {
  const dirnameOf = deps.dirnameOf ?? defaultDirname;

  const applyRename = async (fix: Extract<SelfHealFix, { kind: 'rename-identifier' }>): Promise<SelfHealFixResult> => {
    const signature = `rename:${fix.from}->${fix.to}:${fix.filePath}`;
    let original: string;
    try {
      original = await deps.fs.readFile(fix.filePath);
    } catch (err) {
      return { signature, applied: false, detail: `Cannot read ${fix.filePath}: ${String(err)}` };
    }
    const { text, count } = rewriteIdentifier(original, fix.from, fix.to);
    if (count === 0) {
      return { signature, applied: false, detail: `Identifier "${fix.from}" not found in ${fix.filePath}.` };
    }
    if (deps.onSnapshot) await deps.onSnapshot(fix.filePath, original);
    await deps.fs.writeFile(fix.filePath, text);
    return { signature, applied: true, detail: `Renamed "${fix.from}" → "${fix.to}" (${count} occurrence(s)).` };
  };

  const applyInstall = async (fix: Extract<SelfHealFix, { kind: 'install-package' }>): Promise<SelfHealFixResult> => {
    const signature = `install:${fix.packageName}`;
    if (!deps.installer) {
      return { signature, applied: false, detail: 'No package installer configured.' };
    }
    const result = await deps.installer.install(fix.packageName);
    return result.ok
      ? { signature, applied: true, detail: `Installed "${fix.packageName}".` }
      : { signature, applied: false, detail: result.detail ?? `Failed to install "${fix.packageName}".` };
  };

  const applyCopyLocale = async (
    fix: Extract<SelfHealFix, { kind: 'copy-locale-file' }>
  ): Promise<SelfHealFixResult> => {
    const signature = `copy-locale:${fix.toPath}`;
    // Never overwrite an existing file — only create the missing fallback.
    try {
      await deps.fs.access(fix.toPath);
      return { signature, applied: false, detail: `Target already exists: ${fix.toPath}.` };
    } catch {
      // expected: target missing
    }
    let base: string;
    try {
      base = await deps.fs.readFile(fix.fromPath);
    } catch (err) {
      return { signature, applied: false, detail: `Cannot read base locale ${fix.fromPath}: ${String(err)}` };
    }
    await deps.fs.mkdir(dirnameOf(fix.toPath));
    await deps.fs.writeFile(fix.toPath, base);
    return { signature, applied: true, detail: `Created ${fix.toPath} from ${fix.fromPath}.` };
  };

  const apply: ISelfHealApplier['apply'] = async (finding) => {
    const { fix } = finding;
    switch (fix.kind) {
      case 'rename-identifier':
        return applyRename(fix);
      case 'install-package':
        return applyInstall(fix);
      case 'copy-locale-file':
        return applyCopyLocale(fix);
      case 'manual':
        return { signature: finding.signature, applied: false, detail: `Manual fix required: ${fix.hint}` };
    }
  };

  const applyAll: ISelfHealApplier['applyAll'] = async (findings) => {
    const results: SelfHealFixResult[] = [];
    for (const finding of findings) {
      if (finding.fix.kind === 'manual') continue;
      results.push(await apply(finding));
    }
    return results;
  };

  return { apply, applyAll };
};
