export type OrchestrationKind = 'team' | 'company';

export type OrchestrationRole = {
  id: string;
  name: string;
  responsibility: string;
  dependsOn: string[];
  estimatedTokens?: number;
};

export type OrchestrationProposal = {
  kind: OrchestrationKind;
  name: string;
  reason: string;
  parallelism: number;
  estimatedTokens?: number;
  roles: OrchestrationRole[];
};

const OPEN = '<tomny_orchestration_proposal>';
const CLOSE = '</tomny_orchestration_proposal>';
const MAX_ROLES = 8;

export const ORCHESTRATION_CAPABILITY_PROMPT = `
Tomny Core orchestration capability:
You can propose creating a Team or Company, but you CANNOT create either without explicit user approval.

Propose a Team only when the request has at least two genuinely independent workstreams that can run concurrently, or when implementation and independent review/testing materially improve the result. Use Team for one bounded goal with one leader and temporary collaborators.

Propose a Company only when the request needs multiple durable disciplines/divisions, multiple leaders, recurring work, or agent-to-agent coordination beyond one bounded task.

Do not propose orchestration for a simple question, a small one-file edit, a tightly sequential task, or when coordination overhead is likely larger than the speed gain. Keep the total token estimate within what one strong agent would reasonably spend: split a shared budget instead of multiplying it per role.

When the conditions are met, respond ONLY with this exact envelope containing valid JSON:
<tomny_orchestration_proposal>{"kind":"team|company","name":"short name","reason":"why parallel agents help","parallelism":2,"estimatedTokens":4000,"roles":[{"id":"unique-slug","name":"Role name","responsibility":"bounded deliverable","dependsOn":[]}]}</tomny_orchestration_proposal>

Use 2-8 roles. Dependencies must reference role ids. Otherwise answer normally without this envelope.
`.trim();

const COMPLEX_TASK_SIGNALS = [
  /\b(frontend|backend|database|qa|testing|security|research|architecture|giao diện|cơ sở dữ liệu|kiểm thử|bảo mật|nghiên cứu|kiến trúc)\b/giu,
  /\b(build|implement|refactor|migrate|audit|design|develop|xây dựng|triển khai|tái cấu trúc|di chuyển|đánh giá|thiết kế|phát triển)\b/giu,
  /\b(parallel|multiple|several|team|company|end[- ]to[- ]end|full|song song|nhiều|toàn bộ|toàn diện|đội|công ty)\b/giu,
  /\b(and|plus|then|after|before|dependency|dependencies|và|sau đó|trước khi|phụ thuộc)\b/giu,
];

/** Cheap local gate: avoid spending orchestration prompt tokens on simple chat/small tasks. */
export const shouldOfferOrchestration = (prompt: string): boolean => {
  const normalized = prompt.trim();
  if (/\b(team|company|đội|công ty)\b/iu.test(normalized)) return true;
  if (normalized.length < 80) return false;
  const signalGroups = COMPLEX_TASK_SIGNALS.reduce((count, pattern) => {
    pattern.lastIndex = 0;
    return count + (pattern.test(normalized) ? 1 : 0);
  }, 0);
  return normalized.length >= 320 || signalGroups >= 2;
};

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export const parseOrchestrationProposal = (response: string): OrchestrationProposal | undefined => {
  const start = response.indexOf(OPEN);
  const end = response.indexOf(CLOSE, start + OPEN.length);
  if (start < 0 || end < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.slice(start + OPEN.length, end));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== 'team' && record.kind !== 'company') return undefined;
  if (!Array.isArray(record.roles) || record.roles.length < 2 || record.roles.length > MAX_ROLES) return undefined;
  const roles = record.roles.map((item): OrchestrationRole | undefined => {
    if (!item || typeof item !== 'object') return undefined;
    const role = item as Record<string, unknown>;
    const id = text(role.id, 48)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/gu, '-');
    const name = text(role.name, 80);
    const responsibility = text(role.responsibility, 600);
    if (!id || !name || !responsibility) return undefined;
    return {
      id,
      name,
      responsibility,
      dependsOn: Array.isArray(role.dependsOn)
        ? role.dependsOn.map((dependency) => text(dependency, 48)).filter(Boolean)
        : [],
      estimatedTokens:
        typeof role.estimatedTokens === 'number' && role.estimatedTokens > 0
          ? Math.floor(role.estimatedTokens)
          : undefined,
    };
  });
  if (roles.some((role) => !role)) return undefined;
  const validRoles = roles as OrchestrationRole[];
  const ids = new Set(validRoles.map((role) => role.id));
  if (ids.size !== validRoles.length) return undefined;
  if (validRoles.some((role) => role.dependsOn.some((dependency) => !ids.has(dependency) || dependency === role.id))) {
    return undefined;
  }

  const rolesById = new Map(validRoles.map((role) => [role.id, role]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const hasDependencyCycle = (roleId: string): boolean => {
    if (visiting.has(roleId)) return true;
    if (visited.has(roleId)) return false;
    visiting.add(roleId);
    const cyclic = rolesById.get(roleId)?.dependsOn.some(hasDependencyCycle) ?? false;
    visiting.delete(roleId);
    visited.add(roleId);
    return cyclic;
  };
  if (validRoles.some((role) => hasDependencyCycle(role.id))) return undefined;
  const name = text(record.name, 80);
  const reason = text(record.reason, 800);
  if (!name || !reason) return undefined;
  return {
    kind: record.kind,
    name,
    reason,
    parallelism: Math.max(1, Math.min(validRoles.length, Math.floor(Number(record.parallelism) || 2))),
    estimatedTokens:
      typeof record.estimatedTokens === 'number' && record.estimatedTokens > 0
        ? Math.floor(record.estimatedTokens)
        : undefined,
    roles: validRoles,
  };
};

export const describeOrchestrationProposal = (proposal: OrchestrationProposal): string =>
  [
    proposal.reason,
    `Type: ${proposal.kind}`,
    `Parallel agents: ${proposal.parallelism}/${proposal.roles.length}`,
    proposal.estimatedTokens ? `Shared token budget: ~${proposal.estimatedTokens}` : '',
    ...proposal.roles.map((role) => `• ${role.name}: ${role.responsibility}`),
  ]
    .filter(Boolean)
    .join('\n');
