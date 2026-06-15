/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `selfHealCollector` — gathers the REAL inputs the pure {@link selfHealScanner}
 * detectors need, from disk + the installed `@icon-park/react` package. This is
 * the impure edge that the wiring uses; the scanner itself stays pure/testable.
 *
 * Responsibilities:
 *  - Walk the renderer source tree and read every `.tsx` (for the icon scan) and
 *    every `.ts/.tsx` (for the dependency scan).
 *  - Load the set of valid `@icon-park/react` export names.
 *  - Read installed package names from `node_modules` + workspace package.jsons.
 *  - Parse `React.lazy(() => import('...'))` declarations from the router and
 *    resolve each specifier against disk (for the missing-route detector).
 *  - Walk locale `index.ts` files and check each imported json sibling exists.
 *
 * Everything that touches disk or the live package lives here so it can be
 * swapped/mocked at the wiring boundary. Heavy work is bounded: it only scans
 * the renderer source directory, never node_modules.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type {
  SourceFile,
  LazyRoute,
  LocaleImport,
  DependencyScanInput,
  IconScanInput,
  RouteScanInput,
  LocaleScanInput,
} from './selfHealScanner';

/** Options for {@link createSelfHealCollector}. */
export type SelfHealCollectorDeps = {
  /** Absolute path to `packages/desktop/src/renderer`. */
  rendererRoot: string;
  /** Absolute path to the repo root (holds `node_modules`, `package.json`). */
  repoRoot: string;
  /** Loader for the valid icon names. Injected so tests avoid importing the pkg. */
  loadValidIcons: () => Promise<ReadonlySet<string>>;
};

/** Recursively collect files under `dir` matching `exts`. Skips node_modules/dot dirs. */
const walkFiles = (dir: string, exts: readonly string[]): string[] => {
  const out: string[] = [];
  let entries: nodeFs.Dirent[];
  try {
    entries = nodeFs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
};

/** Read a file as utf-8, returning '' on failure (best-effort scan input). */
const readSafe = (filePath: string): string => {
  try {
    return nodeFs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
};

/** Read the names of installed packages (top-level + scoped) from node_modules. */
const readInstalledPackages = (repoRoot: string): Set<string> => {
  const installed = new Set<string>();
  const nodeModules = path.join(repoRoot, 'node_modules');
  let entries: nodeFs.Dirent[];
  try {
    entries = nodeFs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return installed;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      // Scoped: read one level deeper for `@scope/pkg`.
      try {
        for (const sub of nodeFs.readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true })) {
          if (sub.isDirectory()) installed.add(`${entry.name}/${sub.name}`);
        }
      } catch {
        // ignore unreadable scope dir
      }
    } else if (entry.isDirectory()) {
      installed.add(entry.name);
    }
  }
  return installed;
};

/** Match `React.lazy(() => import('SPEC'))` and bare `import('SPEC')` dynamic imports. */
const LAZY_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Path-alias → absolute root map for resolving lazy import specifiers. */
const buildAliasMap = (repoRoot: string): Array<{ prefix: string; root: string }> => {
  const desktopSrc = path.join(repoRoot, 'packages', 'desktop', 'src');
  return [
    { prefix: '@renderer/', root: path.join(desktopSrc, 'renderer') },
    { prefix: '@process/', root: path.join(desktopSrc, 'process') },
    { prefix: '@common/', root: path.join(desktopSrc, 'common') },
    { prefix: '@worker/', root: path.join(desktopSrc, 'process', 'worker') },
    { prefix: '@/', root: desktopSrc },
  ];
};

/** Candidate file paths a specifier could resolve to (extensions + index files). */
const resolutionCandidates = (basePath: string): string[] => {
  const exts = ['.tsx', '.ts', '.jsx', '.js'];
  return [...exts.map((e) => basePath + e), ...exts.map((e) => path.join(basePath, `index${e}`))];
};

/** Public contract of the collector. */
export type ISelfHealCollector = {
  /** Read renderer `.tsx` files + valid icon names for the icon scan. */
  collectIcons(): Promise<IconScanInput>;
  /** Read renderer source files + installed packages for the dependency scan. */
  collectDependencies(): Promise<DependencyScanInput>;
  /** Parse router lazy routes + a disk resolver for the route scan. */
  collectRoutes(routerRelPath: string): RouteScanInput;
  /** Walk locale index files + check json siblings for the locale scan. */
  collectLocales(localesRelPath: string): LocaleScanInput;
};

/**
 * Create a collector bound to the real renderer/repo roots.
 *
 * @param deps Renderer + repo roots and the icon-name loader.
 * @returns A collector producing real scanner inputs from disk.
 */
export const createSelfHealCollector = (deps: SelfHealCollectorDeps): ISelfHealCollector => {
  const toSourceFiles = (paths: string[]): SourceFile[] => paths.map((p) => ({ path: p, content: readSafe(p) }));

  const collectIcons: ISelfHealCollector['collectIcons'] = async () => {
    const files = toSourceFiles(walkFiles(deps.rendererRoot, ['.tsx']));
    const validIcons = await deps.loadValidIcons();
    return { files, validIcons };
  };

  const collectDependencies: ISelfHealCollector['collectDependencies'] = async () => {
    const files = toSourceFiles(walkFiles(deps.rendererRoot, ['.ts', '.tsx']));
    const installedPackages = readInstalledPackages(deps.repoRoot);
    return { files, installedPackages };
  };

  const collectRoutes: ISelfHealCollector['collectRoutes'] = (routerRelPath) => {
    const routerPath = path.isAbsolute(routerRelPath) ? routerRelPath : path.join(deps.repoRoot, routerRelPath);
    const content = readSafe(routerPath);
    const aliases = buildAliasMap(deps.repoRoot);
    const routes: LazyRoute[] = [];
    LAZY_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LAZY_IMPORT_RE.exec(content)) !== null) {
      routes.push({ importerPath: routerPath, specifier: match[1] });
    }

    const resolveModule: RouteScanInput['resolveModule'] = (importerPath, specifier) => {
      let basePath: string | undefined;
      const alias = aliases.find((a) => specifier.startsWith(a.prefix));
      if (alias) {
        basePath = path.join(alias.root, specifier.slice(alias.prefix.length));
      } else if (specifier.startsWith('.')) {
        basePath = path.resolve(path.dirname(importerPath), specifier);
      } else {
        // Bare package import — not a route module file; treat as resolvable.
        return importerPath;
      }
      for (const candidate of resolutionCandidates(basePath)) {
        try {
          nodeFs.accessSync(candidate);
          return candidate;
        } catch {
          // try next candidate
        }
      }
      return undefined;
    };

    return { routes, resolveModule };
  };

  const collectLocales: ISelfHealCollector['collectLocales'] = (localesRelPath) => {
    const localesRoot = path.isAbsolute(localesRelPath) ? localesRelPath : path.join(deps.repoRoot, localesRelPath);
    const imports: LocaleImport[] = [];
    let localeDirs: nodeFs.Dirent[];
    try {
      localeDirs = nodeFs.readdirSync(localesRoot, { withFileTypes: true });
    } catch {
      return { imports };
    }
    const baseLang = 'en-US';
    for (const dir of localeDirs) {
      if (!dir.isDirectory()) continue;
      const indexPath = path.join(localesRoot, dir.name, 'index.ts');
      const content = readSafe(indexPath);
      if (!content) continue;
      // Match `import x from './name.json'`.
      const jsonImportRe = /from\s+['"]\.\/([\w-]+\.json)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = jsonImportRe.exec(content)) !== null) {
        const jsonFile = m[1];
        const jsonPath = path.join(localesRoot, dir.name, jsonFile);
        let exists = true;
        try {
          nodeFs.accessSync(jsonPath);
        } catch {
          exists = false;
        }
        const basePath = path.join(localesRoot, baseLang, jsonFile);
        let baseExists = true;
        try {
          nodeFs.accessSync(basePath);
        } catch {
          baseExists = false;
        }
        imports.push({ indexPath, jsonFile, exists, baseFallbackPath: baseExists ? basePath : undefined });
      }
    }
    return { imports };
  };

  return { collectIcons, collectDependencies, collectRoutes, collectLocales };
};

/**
 * Default icon-name loader: dynamically import `@icon-park/react` and return the
 * set of its exported component names. Kept separate so the collector stays
 * test-friendly (tests pass a fixed set instead).
 */
export const loadIconParkNames = async (): Promise<ReadonlySet<string>> => {
  const mod = (await import('@icon-park/react')) as Record<string, unknown>;
  return new Set(Object.keys(mod));
};
