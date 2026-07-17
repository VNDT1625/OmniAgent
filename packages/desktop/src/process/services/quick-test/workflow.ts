export const QUICK_TEST_WORKFLOW_SCHEMA_VERSION = 1;
export const MAX_SCENARIO_STEPS = 500;
export const MAX_REPORT_EVENTS = 500;
export const MAX_REPORT_REFERENCES = 200;

const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_DETAIL_LENGTH = 2_000;
const MAX_REFERENCE_TARGET_LENGTH = 2_048;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SENSITIVE_KEY_PATTERN = /authorization|cookie|password|secret|token|api[_-]?key/i;

export type DiagnosticStatus = 'passed' | 'failed' | 'blocked' | 'cancelled';

export type DiagnosticReferenceKind =
  | 'screenshot'
  | 'video'
  | 'trace'
  | 'network'
  | 'log'
  | 'source'
  | 'visual-diff'
  | 'other';

export type DiagnosticReference = {
  id: string;
  kind: DiagnosticReferenceKind;
  label: string;
  target: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
};

export type DiagnosticEvent = {
  timestamp: number;
  type: string;
  outcome?: 'passed' | 'failed' | 'warning' | 'info';
  detail?: string;
  referenceIds?: readonly string[];
};

export type DiagnosticFinding = {
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
  referenceIds?: readonly string[];
};

export type DiagnosticReportInput = {
  reportId: string;
  scenarioId: string;
  runId: string;
  title: string;
  summary: string;
  status: DiagnosticStatus;
  createdAt: number;
  durationMs?: number;
  environment?: Readonly<Record<string, string>>;
  events?: readonly DiagnosticEvent[];
  findings?: readonly DiagnosticFinding[];
  references?: readonly DiagnosticReference[];
};

export type DiagnosticReportManifest = {
  schemaVersion: typeof QUICK_TEST_WORKFLOW_SCHEMA_VERSION;
  reportId: string;
  scenarioId: string;
  runId: string;
  title: string;
  summary: string;
  status: DiagnosticStatus;
  createdAt: number;
  durationMs?: number;
  environment: Record<string, string>;
  events: DiagnosticEvent[];
  findings: DiagnosticFinding[];
  references: DiagnosticReference[];
  truncated: {
    events: number;
    findings: number;
    references: number;
  };
};

export type DiagnosticReportBundle = {
  manifest: DiagnosticReportManifest;
  json: string;
  markdown: string;
};

function requireSafeId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || !SAFE_ID_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a non-empty portable identifier`);
  }
  return normalized;
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function sanitizeDetail(value: string): string {
  return boundedText(
    value
      .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]'),
    MAX_DETAIL_LENGTH
  );
}

function validateReference(reference: DiagnosticReference): DiagnosticReference {
  const target = reference.target.trim();
  if (
    !target ||
    target.length > MAX_REFERENCE_TARGET_LENGTH ||
    /^(?:data|blob):/i.test(target) ||
    /;base64,/i.test(target)
  ) {
    throw new Error(`Reference ${reference.id} must point to an external or local artifact`);
  }
  if (reference.sizeBytes !== undefined && (!Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 0)) {
    throw new Error(`Reference ${reference.id} has an invalid size`);
  }
  return {
    id: requireSafeId(reference.id, 'reference.id'),
    kind: reference.kind,
    label: boundedText(reference.label, MAX_TITLE_LENGTH),
    target,
    ...(reference.mediaType ? { mediaType: boundedText(reference.mediaType, 100) } : {}),
    ...(reference.sizeBytes === undefined ? {} : { sizeBytes: reference.sizeBytes }),
    ...(reference.sha256 ? { sha256: boundedText(reference.sha256, 128) } : {}),
  };
}

function uniqueById<T extends { id: string }>(items: readonly T[], field: string): T[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate ${field}: ${item.id}`);
    }
    seen.add(item.id);
    return item;
  });
}

function filterReferenceIds(
  referenceIds: readonly string[] | undefined,
  knownReferences: ReadonlySet<string>
): string[] | undefined {
  if (!referenceIds) return undefined;
  const filtered = [...new Set(referenceIds)].filter((id) => knownReferences.has(id));
  return filtered.length ? filtered : undefined;
}

function normalizeEvent(event: DiagnosticEvent, knownReferences: ReadonlySet<string>): DiagnosticEvent {
  const normalized: DiagnosticEvent = {
    timestamp: event.timestamp,
    type: boundedText(event.type, 100),
  };
  if (event.outcome) normalized.outcome = event.outcome;
  if (event.detail) normalized.detail = sanitizeDetail(event.detail);
  const referenceIds = filterReferenceIds(event.referenceIds, knownReferences);
  if (referenceIds) normalized.referenceIds = referenceIds;
  return normalized;
}

function normalizeFinding(finding: DiagnosticFinding, knownReferences: ReadonlySet<string>): DiagnosticFinding {
  const normalized: DiagnosticFinding = {
    severity: finding.severity,
    title: boundedText(finding.title, MAX_TITLE_LENGTH),
    detail: sanitizeDetail(finding.detail),
  };
  const referenceIds = filterReferenceIds(finding.referenceIds, knownReferences);
  if (referenceIds) normalized.referenceIds = referenceIds;
  return normalized;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function buildDiagnosticReport(input: DiagnosticReportInput): DiagnosticReportBundle {
  if (!Number.isFinite(input.createdAt) || input.createdAt < 0) {
    throw new Error('createdAt must be a non-negative timestamp');
  }
  if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) {
    throw new Error('durationMs must be non-negative');
  }

  const allReferences = uniqueById((input.references ?? []).map(validateReference), 'reference id');
  const references = allReferences.slice(0, MAX_REPORT_REFERENCES);
  const knownReferences = new Set(references.map((reference) => reference.id));
  const allEvents = input.events ?? [];
  const allFindings = input.findings ?? [];
  const environment = Object.fromEntries(
    Object.entries(input.environment ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        boundedText(key, 100),
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeDetail(value),
      ])
  );

  const manifest: DiagnosticReportManifest = {
    schemaVersion: QUICK_TEST_WORKFLOW_SCHEMA_VERSION,
    reportId: requireSafeId(input.reportId, 'reportId'),
    scenarioId: requireSafeId(input.scenarioId, 'scenarioId'),
    runId: requireSafeId(input.runId, 'runId'),
    title: boundedText(input.title, MAX_TITLE_LENGTH),
    summary: sanitizeDetail(boundedText(input.summary, MAX_SUMMARY_LENGTH)),
    status: input.status,
    createdAt: input.createdAt,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    environment,
    events: allEvents.slice(0, MAX_REPORT_EVENTS).map((event) => normalizeEvent(event, knownReferences)),
    findings: allFindings.slice(0, MAX_REPORT_EVENTS).map((finding) => normalizeFinding(finding, knownReferences)),
    references,
    truncated: {
      events: Math.max(0, allEvents.length - MAX_REPORT_EVENTS),
      findings: Math.max(0, allFindings.length - MAX_REPORT_EVENTS),
      references: Math.max(0, allReferences.length - MAX_REPORT_REFERENCES),
    },
  };

  const lines = [
    `# ${manifest.title || manifest.reportId}`,
    '',
    `- Status: **${manifest.status}**`,
    `- Scenario: \`${manifest.scenarioId}\``,
    `- Run: \`${manifest.runId}\``,
    `- Created: ${new Date(manifest.createdAt).toISOString()}`,
    ...(manifest.durationMs === undefined ? [] : [`- Duration: ${manifest.durationMs} ms`]),
    '',
    '## Summary',
    '',
    manifest.summary || '_No summary_',
  ];

  if (manifest.findings.length) {
    lines.push('', '## Findings', '');
    for (const finding of manifest.findings) {
      lines.push(`- **${finding.severity.toUpperCase()} — ${finding.title}:** ${finding.detail}`);
    }
  }
  if (manifest.events.length) {
    lines.push('', '## Timeline', '', '| Time | Type | Outcome | Detail |', '| ---: | --- | --- | --- |');
    for (const event of manifest.events) {
      lines.push(
        `| ${event.timestamp} | ${markdownCell(event.type)} | ${event.outcome ?? 'info'} | ${markdownCell(event.detail ?? '')} |`
      );
    }
  }
  if (manifest.references.length) {
    lines.push('', '## Artifact references', '');
    for (const reference of manifest.references) {
      lines.push(`- [${reference.label || reference.id}](${reference.target}) — ${reference.kind}`);
    }
  }
  if (Object.keys(manifest.environment).length) {
    lines.push('', '## Environment', '');
    for (const [key, value] of Object.entries(manifest.environment)) {
      lines.push(`- ${key}: \`${value.replace(/`/g, '\\`')}\``);
    }
  }

  return {
    manifest,
    json: JSON.stringify(manifest, null, 2),
    markdown: `${lines.join('\n')}\n`,
  };
}

export type RetentionCategory = 'run' | 'baseline' | 'media' | 'report';

export type RetentionAsset = {
  id: string;
  category: RetentionCategory;
  createdAt: number;
  sizeBytes: number;
  pinned?: boolean;
  references?: readonly string[];
};

export type CategoryRetentionPolicy = {
  maxAgeMs: number;
  maxCount: number;
  maxBytes: number;
};

export type RetentionPolicy = {
  categories: Readonly<Record<RetentionCategory, CategoryRetentionPolicy>>;
  totalMaxBytes: number;
};

export type CleanupReason = 'expired' | 'count-limit' | 'size-limit' | 'total-size-limit';

export type CleanupDecision = {
  asset: RetentionAsset;
  reason: CleanupReason;
};

export type RetentionCleanupPlan = {
  keep: RetentionAsset[];
  delete: CleanupDecision[];
  reclaimedBytes: number;
  retainedBytes: number;
  warnings: string[];
};

const RETENTION_CATEGORIES: readonly RetentionCategory[] = ['run', 'baseline', 'media', 'report'];

function validateLimit(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
}

function validateRetentionAsset(asset: RetentionAsset): void {
  requireSafeId(asset.id, 'asset.id');
  validateLimit(asset.createdAt, `${asset.id}.createdAt`);
  validateLimit(asset.sizeBytes, `${asset.id}.sizeBytes`);
}

function protectedReferences(ids: ReadonlySet<string>, assetsById: ReadonlyMap<string, RetentionAsset>): Set<string> {
  const protectedIds = new Set(ids);
  const queue = [...ids];
  while (queue.length) {
    const current = assetsById.get(queue.shift() ?? '');
    for (const reference of current?.references ?? []) {
      if (assetsById.has(reference) && !protectedIds.has(reference)) {
        protectedIds.add(reference);
        queue.push(reference);
      }
    }
  }
  return protectedIds;
}

export function planRetentionCleanup(
  assets: readonly RetentionAsset[],
  policy: RetentionPolicy,
  now: number
): RetentionCleanupPlan {
  validateLimit(now, 'now');
  validateLimit(policy.totalMaxBytes, 'totalMaxBytes');
  for (const category of RETENTION_CATEGORIES) {
    const categoryPolicy = policy.categories[category];
    validateLimit(categoryPolicy.maxAgeMs, `${category}.maxAgeMs`);
    validateLimit(categoryPolicy.maxCount, `${category}.maxCount`);
    validateLimit(categoryPolicy.maxBytes, `${category}.maxBytes`);
  }

  const checkedAssets = uniqueById(
    assets.map((asset) => {
      validateRetentionAsset(asset);
      return { ...asset, references: asset.references ? [...asset.references] : undefined };
    }),
    'asset id'
  );
  const byId = new Map(checkedAssets.map((asset) => [asset.id, asset]));
  const decisions = new Map<string, CleanupReason>();

  for (const category of RETENTION_CATEGORIES) {
    const categoryPolicy = policy.categories[category];
    const candidates = checkedAssets
      .filter((asset) => asset.category === category)
      .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));

    for (const asset of candidates) {
      if (!asset.pinned && now - asset.createdAt > categoryPolicy.maxAgeMs) {
        decisions.set(asset.id, 'expired');
      }
    }

    const countEligible = candidates.filter((asset) => !asset.pinned && !decisions.has(asset.id));
    for (const asset of countEligible.slice(categoryPolicy.maxCount)) {
      decisions.set(asset.id, 'count-limit');
    }

    let usedBytes = candidates.filter((asset) => asset.pinned).reduce((total, asset) => total + asset.sizeBytes, 0);
    for (const asset of candidates) {
      if (asset.pinned || decisions.has(asset.id)) continue;
      if (usedBytes + asset.sizeBytes > categoryPolicy.maxBytes) {
        decisions.set(asset.id, 'size-limit');
      } else {
        usedBytes += asset.sizeBytes;
      }
    }
  }

  const provisionalKeep = new Set(checkedAssets.filter((asset) => !decisions.has(asset.id)).map((asset) => asset.id));
  const required = protectedReferences(provisionalKeep, byId);
  const warnings: string[] = [];
  for (const id of required) {
    if (decisions.delete(id)) warnings.push(`Preserved referenced asset ${id}`);
  }

  const currentlyKept = (): RetentionAsset[] => checkedAssets.filter((asset) => !decisions.has(asset.id));
  let retainedBytes = currentlyKept().reduce((total, asset) => total + asset.sizeBytes, 0);

  if (retainedBytes > policy.totalMaxBytes) {
    const referenced = protectedReferences(
      new Set(
        currentlyKept()
          .filter((asset) => asset.pinned)
          .map((asset) => asset.id)
      ),
      byId
    );
    const referencedByKept = new Set(
      currentlyKept()
        .flatMap((asset) => asset.references ?? [])
        .filter((id) => byId.has(id))
    );
    const totalCandidates = currentlyKept()
      .filter((asset) => !asset.pinned && !referenced.has(asset.id) && !referencedByKept.has(asset.id))
      .toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    for (const asset of totalCandidates) {
      if (retainedBytes <= policy.totalMaxBytes) break;
      decisions.set(asset.id, 'total-size-limit');
      retainedBytes -= asset.sizeBytes;
    }
  }

  const keep = currentlyKept().toSorted(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)
  );
  retainedBytes = keep.reduce((total, asset) => total + asset.sizeBytes, 0);
  if (retainedBytes > policy.totalMaxBytes) {
    warnings.push('Retention limits cannot be met without deleting pinned or referenced assets');
  }
  const deleted = checkedAssets
    .filter((asset) => decisions.has(asset.id))
    .toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((asset) => ({ asset, reason: decisions.get(asset.id) as CleanupReason }));

  return {
    keep,
    delete: deleted,
    reclaimedBytes: deleted.reduce((total, decision) => total + decision.asset.sizeBytes, 0),
    retainedBytes,
    warnings,
  };
}

export type ScenarioActionStep = {
  id: string;
  kind: 'action';
  action: 'navigate' | 'click' | 'input' | 'wait';
  target?: string;
  value?: string;
  timeoutMs?: number;
};

export type ScenarioAssertionStep = {
  id: string;
  kind: 'assertion';
  assertion: 'visible' | 'text' | 'url' | 'network' | 'visual';
  target?: string;
  expected: string | number | boolean;
  timeoutMs?: number;
};

export type ScenarioCheckpointStep = {
  id: string;
  kind: 'checkpoint';
  name: string;
  capture: 'screenshot' | 'trace' | 'network' | 'all';
};

export type ScenarioStep = ScenarioActionStep | ScenarioAssertionStep | ScenarioCheckpointStep;

export type EditableScenario = {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  steps: readonly ScenarioStep[];
};

export type ScenarioValidationIssue = {
  path: string;
  code:
    | 'invalid-id'
    | 'invalid-name'
    | 'duplicate-step-id'
    | 'too-many-steps'
    | 'missing-action'
    | 'missing-target'
    | 'invalid-timeout'
    | 'invalid-expected'
    | 'invalid-checkpoint';
  message: string;
};

export type ScenarioEditOperation =
  | { type: 'reorder'; stepId: string; toIndex: number }
  | { type: 'edit'; stepId: string; step: ScenarioStep }
  | { type: 'delete'; stepId: string }
  | { type: 'add-assertion'; afterStepId?: string; step: ScenarioAssertionStep }
  | { type: 'add-checkpoint'; afterStepId?: string; step: ScenarioCheckpointStep };

export class ScenarioValidationError extends Error {
  readonly issues: ScenarioValidationIssue[];

  constructor(issues: ScenarioValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'ScenarioValidationError';
    this.issues = issues;
  }
}

function isBlank(value: string | undefined): boolean {
  return !value?.trim();
}

function validateTimeout(path: string, timeoutMs: number | undefined, issues: ScenarioValidationIssue[]): void {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000)) {
    issues.push({
      path,
      code: 'invalid-timeout',
      message: 'Timeout must be an integer between 0 and 300000 ms',
    });
  }
}

export function validateScenario(scenario: EditableScenario): ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];
  if (!SAFE_ID_PATTERN.test(scenario.id.trim())) {
    issues.push({ path: 'id', code: 'invalid-id', message: 'Scenario id is not portable' });
  }
  if (isBlank(scenario.name)) {
    issues.push({ path: 'name', code: 'invalid-name', message: 'Scenario name is required' });
  }
  if (scenario.steps.length > MAX_SCENARIO_STEPS) {
    issues.push({
      path: 'steps',
      code: 'too-many-steps',
      message: `A scenario supports at most ${MAX_SCENARIO_STEPS} steps`,
    });
  }
  if (!scenario.steps.some((step) => step.kind === 'action')) {
    issues.push({ path: 'steps', code: 'missing-action', message: 'At least one action is required' });
  }

  const ids = new Set<string>();
  scenario.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    if (!SAFE_ID_PATTERN.test(step.id.trim())) {
      issues.push({ path: `${path}.id`, code: 'invalid-id', message: 'Step id is not portable' });
    } else if (ids.has(step.id)) {
      issues.push({
        path: `${path}.id`,
        code: 'duplicate-step-id',
        message: `Duplicate step id ${step.id}`,
      });
    }
    ids.add(step.id);

    if (step.kind === 'action') {
      if ((step.action === 'navigate' || step.action === 'click' || step.action === 'input') && isBlank(step.target)) {
        issues.push({
          path: `${path}.target`,
          code: 'missing-target',
          message: `${step.action} requires a target`,
        });
      }
      validateTimeout(`${path}.timeoutMs`, step.timeoutMs, issues);
      return;
    }
    if (step.kind === 'assertion') {
      if (step.assertion !== 'url' && isBlank(step.target)) {
        issues.push({
          path: `${path}.target`,
          code: 'missing-target',
          message: `${step.assertion} assertion requires a target`,
        });
      }
      if (typeof step.expected === 'string' && isBlank(step.expected)) {
        issues.push({
          path: `${path}.expected`,
          code: 'invalid-expected',
          message: 'Expected value cannot be empty',
        });
      }
      validateTimeout(`${path}.timeoutMs`, step.timeoutMs, issues);
      return;
    }
    if (isBlank(step.name)) {
      issues.push({
        path: `${path}.name`,
        code: 'invalid-checkpoint',
        message: 'Checkpoint name is required',
      });
    }
  });
  return issues;
}

function findStepIndex(steps: readonly ScenarioStep[], stepId: string): number {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`Unknown scenario step: ${stepId}`);
  return index;
}

function insertionIndex(steps: readonly ScenarioStep[], afterStepId: string | undefined): number {
  return afterStepId === undefined ? steps.length : findStepIndex(steps, afterStepId) + 1;
}

export function applyScenarioEdits(
  scenario: EditableScenario,
  operations: readonly ScenarioEditOperation[],
  editedAt: number
): EditableScenario {
  validateLimit(editedAt, 'editedAt');
  const initialIssues = validateScenario(scenario);
  if (initialIssues.length) throw new ScenarioValidationError(initialIssues);

  const steps = scenario.steps.map((step) => ({ ...step }));
  for (const operation of operations) {
    if (operation.type === 'reorder') {
      if (!Number.isSafeInteger(operation.toIndex) || operation.toIndex < 0 || operation.toIndex >= steps.length) {
        throw new Error(`Invalid destination index: ${operation.toIndex}`);
      }
      const fromIndex = findStepIndex(steps, operation.stepId);
      const [step] = steps.splice(fromIndex, 1);
      steps.splice(operation.toIndex, 0, step);
    } else if (operation.type === 'edit') {
      const index = findStepIndex(steps, operation.stepId);
      if (operation.step.id !== operation.stepId) {
        throw new Error('Editing a step cannot change its id');
      }
      steps[index] = { ...operation.step };
    } else if (operation.type === 'delete') {
      steps.splice(findStepIndex(steps, operation.stepId), 1);
    } else {
      const index = insertionIndex(steps, operation.afterStepId);
      steps.splice(index, 0, { ...operation.step });
    }
  }

  const edited: EditableScenario = {
    ...scenario,
    revision: scenario.revision + 1,
    updatedAt: editedAt,
    steps,
  };
  const issues = validateScenario(edited);
  if (issues.length) throw new ScenarioValidationError(issues);
  return edited;
}
