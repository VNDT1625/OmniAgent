/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `selfHealService` — orchestrates the Tier-0 self-heal flow: collect real
 * inputs → run the pure detectors → optionally auto-apply the safe fixes. It is
 * the single entry the wiring/bridge calls.
 *
 * Two run modes:
 *  - **scan()** — diagnose only; never writes. Returns the findings so a caller
 *    (boot check, Monitor UI) can show them. This is always safe to run.
 *  - **healAuto()** — scan, then apply ONLY auto-fixable findings whose rule is
 *    in the allow-list. Defaults to a conservative allow-list (icon renames +
 *    locale fallbacks). Package installs are OFF by default because they mutate
 *    node_modules; opt in explicitly. `manual` and route-module findings are
 *    never auto-applied — they are returned for a human / Tier 1.
 *
 * The collector, scanner runner, and applier are injected so the service is
 * unit-testable end-to-end without disk. The wiring builds the real ones.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { runTier0Scan, type SelfHealScanReport, type Tier0ScanInput } from './selfHealScanner';
import type { ISelfHealApplier } from './selfHealApplier';
import type { ISelfHealCollector } from './selfHealCollector';
import type { SelfHealFinding, SelfHealFixResult, SelfHealRuleId } from './selfHealTypes';

/** Rules whose auto-fix is safe enough to apply without a human by default. */
export const DEFAULT_AUTO_RULES: ReadonlySet<SelfHealRuleId> = new Set<SelfHealRuleId>([
  'invalid-icon-import',
  'missing-locale-file',
]);

/** Options for {@link createSelfHealService}. */
export type SelfHealServiceDeps = {
  /** Gathers real scanner inputs from disk + the icon package. */
  collector: ISelfHealCollector;
  /** Applies the safe fixes. */
  applier: ISelfHealApplier;
  /** Router file path (repo-relative) for the route-module scan. */
  routerRelPath: string;
  /** Locales dir path (repo-relative) for the locale scan. */
  localesRelPath: string;
  /** Whether to include the (slower) dependency scan. Defaults to true. */
  includeDependencies?: boolean;
};

/** Options for a {@link ISelfHealService.healAuto} run. */
export type HealAutoOptions = {
  /** Rule allow-list for auto-apply. Defaults to {@link DEFAULT_AUTO_RULES}. */
  autoRules?: ReadonlySet<SelfHealRuleId>;
};

/** Result of a {@link ISelfHealService.healAuto} run. */
export type HealAutoResult = {
  /** The scan that drove the run. */
  scan: SelfHealScanReport;
  /** Findings selected for auto-apply (rule in allow-list + non-manual fix). */
  attempted: SelfHealFinding[];
  /** Per-fix results for the attempted findings. */
  results: SelfHealFixResult[];
  /** Findings NOT auto-applied — left for a human / Tier 1. */
  deferred: SelfHealFinding[];
};

/** Public contract of the self-heal service. */
export type ISelfHealService = {
  /** Diagnose only — collect inputs + run every detector. Never writes. */
  scan(): Promise<SelfHealScanReport>;
  /** Scan, then auto-apply the allow-listed safe fixes. */
  healAuto(options?: HealAutoOptions): Promise<HealAutoResult>;
};

/**
 * Create the {@link ISelfHealService}.
 *
 * @param deps Collector, applier, router/locale paths, dependency-scan toggle.
 * @returns A service exposing `scan` (read-only) and `healAuto` (gated apply).
 */
export const createSelfHealService = (deps: SelfHealServiceDeps): ISelfHealService => {
  const includeDeps = deps.includeDependencies ?? true;

  const buildScanInput = async (): Promise<Tier0ScanInput> => {
    const [icons, dependencies] = await Promise.all([
      deps.collector.collectIcons(),
      includeDeps ? deps.collector.collectDependencies() : Promise.resolve(undefined),
    ]);
    return {
      icons,
      dependencies: dependencies ?? undefined,
      routes: deps.collector.collectRoutes(deps.routerRelPath),
      locales: deps.collector.collectLocales(deps.localesRelPath),
    };
  };

  const scan: ISelfHealService['scan'] = async () => {
    const input = await buildScanInput();
    return runTier0Scan(input);
  };

  const healAuto: ISelfHealService['healAuto'] = async (options) => {
    const autoRules = options?.autoRules ?? DEFAULT_AUTO_RULES;
    const report = await scan();

    const attempted: SelfHealFinding[] = [];
    const deferred: SelfHealFinding[] = [];
    for (const finding of report.findings) {
      const eligible = finding.fix.kind !== 'manual' && autoRules.has(finding.ruleId);
      if (eligible) attempted.push(finding);
      else deferred.push(finding);
    }

    const results = await deps.applier.applyAll(attempted);
    return { scan: report, attempted, results, deferred };
  };

  return { scan, healAuto };
};
