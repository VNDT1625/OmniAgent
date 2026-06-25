/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `selfHealScanner` — the Tier-0 (deterministic, no-AI) detectors. Each scans a
 * narrow, well-understood failure class and emits {@link SelfHealFinding}s that
 * carry a concrete, machine-applicable fix:
 *
 *  - **invalid-icon-import** — an identifier imported from `@icon-park/react`
 *    that the library does not export (the `GitBranch` class of bug). Suggests
 *    the nearest valid export via {@link nearestName}.
 *  - **missing-dependency** — a bare `import ... from 'pkg'` whose package is not
 *    resolvable (not in the provided installed-set). Fix = install it.
 *  - **missing-route-module** — a `React.lazy(() => import('…'))` target that
 *    resolves to no file on disk (the `pages/git/index.tsx` class of bug).
 *  - **missing-locale-file** — a locale `index.ts` importing a `*.json` sibling
 *    that does not exist (fix = copy the base-language file as a fallback).
 *
 * Every detector is PURE over injected inputs: file contents, a directory lister,
 * the set of valid icon names, and the set of installed packages are all passed
 * in. This keeps the scanner unit-testable with no disk, no network, and no
 * Electron — the wiring module supplies the real implementations.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { nearestName } from './nearestName';
import type { SelfHealFinding } from './selfHealTypes';

/** A source file handed to the scanner: its path + text content. */
export type SourceFile = {
  /** Repo-relative (or absolute) path — used in findings + as the fix target. */
  path: string;
  /** The file's text content. */
  content: string;
};

/** Inputs for {@link scanInvalidIcons}. */
export type IconScanInput = {
  /** The `.tsx` files to scan. */
  files: SourceFile[];
  /** The set of identifiers `@icon-park/react` actually exports. */
  validIcons: ReadonlySet<string>;
};

/** Match a component import block from `@icon-park/react` (single-line form). */
const ICON_IMPORT_RE = /import\s+(?:type\s+)?\{([^{}]*)\}\s+from\s+['"]@icon-park\/react['"]/g;

/** Split an import clause into bare local identifiers (handles `X as Y`). */
const parseSpecifiers = (clause: string): Array<{ original: string; local: string }> =>
  clause
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const [original, alias] = spec.split(/\s+as\s+/);
      return { original: original.trim(), local: (alias ?? original).trim() };
    })
    .filter((s) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s.original));

/**
 * Detect identifiers imported from `@icon-park/react` that the library does not
 * export. For each, suggest the nearest valid export (when close enough) so the
 * fix can rewrite the import deterministically.
 */
export const scanInvalidIcons = (input: IconScanInput): SelfHealFinding[] => {
  const findings: SelfHealFinding[] = [];
  for (const file of input.files) {
    if (!file.content.includes('@icon-park/react')) continue;
    ICON_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ICON_IMPORT_RE.exec(file.content)) !== null) {
      for (const { original } of parseSpecifiers(match[1])) {
        if (input.validIcons.has(original)) continue;
        const suggestion = nearestName(original, input.validIcons);
        findings.push({
          ruleId: 'invalid-icon-import',
          tier: 'tier0',
          severity: 'critical',
          signature: `invalid-icon:${original}:${file.path}`,
          summary: suggestion
            ? `Icon "${original}" is not exported by @icon-park/react; nearest valid export is "${suggestion.name}".`
            : `Icon "${original}" is not exported by @icon-park/react and no close replacement was found.`,
          filePath: file.path,
          fix: suggestion
            ? { kind: 'rename-identifier', filePath: file.path, from: original, to: suggestion.name }
            : {
                kind: 'manual',
                hint: `Replace the non-existent icon "${original}" with a valid @icon-park/react export.`,
              },
        });
      }
    }
  }
  return findings;
};

/** Inputs for {@link scanMissingDependencies}. */
export type DependencyScanInput = {
  /** The source files to scan. */
  files: SourceFile[];
  /** Package names known to be installed/resolvable (node_modules + workspace). */
  installedPackages: ReadonlySet<string>;
  /** Bare-import prefixes to ignore (node builtins, path aliases). */
  ignorePrefixes?: readonly string[];
};

/** Match any `from '...'` or `import '...'` specifier. */
const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/** Default specifiers/prefixes the dependency scan never flags. */
const DEFAULT_IGNORE_PREFIXES = ['@/', '@renderer/', '@process/', '@common/', '@worker/', 'node:', '.', '/'] as const;

/** Resolve a bare specifier to its package name (`@scope/pkg/sub` → `@scope/pkg`). */
export const packageNameOf = (specifier: string): string | undefined => {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }
  const first = specifier.split('/')[0];
  return first.length > 0 ? first : undefined;
};

/**
 * Detect bare imports whose package is not in {@link DependencyScanInput.installedPackages}.
 * Path aliases, relative imports and node builtins are skipped via prefixes.
 */
export const scanMissingDependencies = (input: DependencyScanInput): SelfHealFinding[] => {
  const ignore = input.ignorePrefixes ?? DEFAULT_IGNORE_PREFIXES;
  const findings: SelfHealFinding[] = [];
  const seen = new Set<string>();

  for (const file of input.files) {
    IMPORT_SPECIFIER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPECIFIER_RE.exec(file.content)) !== null) {
      const specifier = match[1];
      if (ignore.some((p) => specifier.startsWith(p))) continue;
      const pkg = packageNameOf(specifier);
      if (!pkg || input.installedPackages.has(pkg)) continue;
      const signature = `missing-dependency:${pkg}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      findings.push({
        ruleId: 'missing-dependency',
        tier: 'tier0',
        severity: 'critical',
        signature,
        summary: `Package "${pkg}" is imported but not installed.`,
        filePath: file.path,
        fix: { kind: 'install-package', packageName: pkg },
      });
    }
  }
  return findings;
};

/** A lazy-route declaration: the importer file + the module specifier it loads. */
export type LazyRoute = {
  /** File that declares the `React.lazy(() => import('...'))`. */
  importerPath: string;
  /** The raw module specifier inside the dynamic import. */
  specifier: string;
};

/** Inputs for {@link scanMissingRouteModules}. */
export type RouteScanInput = {
  /** Declared lazy routes. */
  routes: LazyRoute[];
  /**
   * Resolver: given an importer path + specifier, return the resolved absolute
   * file path if it exists on disk, else `undefined`. Injected (no real fs here).
   */
  resolveModule: (importerPath: string, specifier: string) => string | undefined;
};

/**
 * Detect lazy routes whose target module does not resolve to a file — the cause
 * of "Failed to fetch dynamically imported module" / a route silently 404ing.
 * No automatic fix is safe (we cannot invent the page), so these are `manual`
 * findings escalated for a human / Tier 1.
 */
export const scanMissingRouteModules = (input: RouteScanInput): SelfHealFinding[] => {
  const findings: SelfHealFinding[] = [];
  for (const route of input.routes) {
    if (input.resolveModule(route.importerPath, route.specifier)) continue;
    findings.push({
      ruleId: 'missing-route-module',
      tier: 'tier0',
      severity: 'critical',
      signature: `missing-route-module:${route.specifier}`,
      summary: `Lazy route imports "${route.specifier}" but no module file resolves for it.`,
      filePath: route.importerPath,
      fix: {
        kind: 'manual',
        hint: `Create the missing module for "${route.specifier}" or remove the route/import in ${route.importerPath}.`,
      },
    });
  }
  return findings;
};

/** A locale module-index import: the index file + the json sibling it imports. */
export type LocaleImport = {
  /** The locale `index.ts` file path. */
  indexPath: string;
  /** Imported json filename (e.g. `git.json`). */
  jsonFile: string;
  /** Whether that json sibling exists on disk. */
  exists: boolean;
  /** Absolute path of the base-language equivalent, when it exists. */
  baseFallbackPath?: string;
};

/** Inputs for {@link scanMissingLocaleFiles}. */
export type LocaleScanInput = {
  /** Locale imports gathered from every locale `index.ts`. */
  imports: LocaleImport[];
};

/**
 * Detect locale `index.ts` files importing a `*.json` that does not exist on
 * disk — a static import that breaks the whole renderer build. When the
 * base-language file exists, the fix copies it as a fallback (translations can
 * be filled later); otherwise it is escalated as manual.
 */
export const scanMissingLocaleFiles = (input: LocaleScanInput): SelfHealFinding[] => {
  const findings: SelfHealFinding[] = [];
  for (const imp of input.imports) {
    if (imp.exists) continue;
    const targetPath = imp.indexPath.replace(/index\.ts$/, imp.jsonFile);
    findings.push({
      ruleId: 'missing-locale-file',
      tier: 'tier0',
      severity: 'critical',
      signature: `missing-locale-file:${targetPath}`,
      summary: `Locale index imports "${imp.jsonFile}" but the file is missing.`,
      filePath: imp.indexPath,
      fix: imp.baseFallbackPath
        ? { kind: 'copy-locale-file', fromPath: imp.baseFallbackPath, toPath: targetPath }
        : { kind: 'manual', hint: `Create the missing locale file "${imp.jsonFile}" next to ${imp.indexPath}.` },
    });
  }
  return findings;
};

/** Aggregate result of a full Tier-0 scan. */
export type SelfHealScanReport = {
  /** All findings across every detector, in detector order. */
  findings: SelfHealFinding[];
  /** Count of findings that carry a non-manual (auto-applicable) fix. */
  autoFixable: number;
};

/** Inputs for {@link runTier0Scan} — the union of every detector's inputs. */
export type Tier0ScanInput = {
  icons?: IconScanInput;
  dependencies?: DependencyScanInput;
  routes?: RouteScanInput;
  locales?: LocaleScanInput;
};

/**
 * Run every provided Tier-0 detector and aggregate the findings. Detectors with
 * no input are skipped, so callers can run a subset (e.g. icons only).
 */
export const runTier0Scan = (input: Tier0ScanInput): SelfHealScanReport => {
  const findings: SelfHealFinding[] = [
    ...(input.icons ? scanInvalidIcons(input.icons) : []),
    ...(input.dependencies ? scanMissingDependencies(input.dependencies) : []),
    ...(input.routes ? scanMissingRouteModules(input.routes) : []),
    ...(input.locales ? scanMissingLocaleFiles(input.locales) : []),
  ];
  const autoFixable = findings.filter((f) => f.fix.kind !== 'manual').length;
  return { findings, autoFixable };
};
