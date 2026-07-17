/** Lightweight planning harness for automation-capable agents. */
import type { WorkflowNode, WorkflowNodeKind } from './automationTypes';

export type AutomationCapability = { kind: WorkflowNodeKind; purpose: string; configHint: string };
export type WorkflowPlan = { goal: string; nodes: WorkflowNode[]; warnings: string[] };

const CAPABILITIES: readonly AutomationCapability[] = [
  { kind: 'trigger.manual', purpose: 'Run on demand', configHint: '{}' },
  { kind: 'trigger.schedule', purpose: 'Run on cron or interval', configHint: '{ cron | everyMinutes }' },
  { kind: 'trigger.webhook', purpose: 'Accept an inbound webhook', configHint: '{ path }' },
  { kind: 'action.http', purpose: 'Call a REST endpoint', configHint: '{ method, url, headers?, body? }' },
  { kind: 'action.ai', purpose: 'Use a configured model', configHint: '{ model, prompt }' },
  { kind: 'action.transform', purpose: 'Template the previous output', configHint: '{ expression }' },
  { kind: 'action.set', purpose: 'Build a structured object', configHint: '{ keepInput?, fields }' },
  { kind: 'action.code', purpose: 'Render a safe template', configHint: '{ template, parseJson? }' },
  { kind: 'action.filesystem', purpose: 'Read or write local files', configHint: '{ operation, path, content? }' },
  { kind: 'action.n8n', purpose: 'Execute an n8n webhook workflow', configHint: '{ webhookUrl, method?, headers?, payload?, timeoutMs? }' },
  { kind: 'action.notify', purpose: 'Show a desktop notification', configHint: '{ title, body }' },
  { kind: 'action.manager', purpose: 'Create a task, note, or event', configHint: '{ entity, title, detail?, at? }' },
  { kind: 'action.browser', purpose: 'Delegate a browser task', configHint: '{ task, url?, model? }' },
  { kind: 'action.conversation', purpose: 'Ask an agent and await its reply', configHint: '{ message, model? }' },
  { kind: 'action.subworkflow', purpose: 'Run another AionUi workflow', configHint: '{ workflowId }' },
  { kind: 'action.company', purpose: 'Delegate to an Agent Company', configHint: '{ mode, companyId?, goal?, task? }' },
  { kind: 'action.email.send', purpose: 'Send email', configHint: '{ credentialId?, from, to, subject, body }' },
  { kind: 'action.cloud.upload', purpose: 'Upload an artifact', configHint: '{ credentialId?, provider, destination? }' },
  { kind: 'control.if', purpose: 'Choose a branch', configHint: '{ condition } + then/else branches' },
  { kind: 'control.loop', purpose: 'Repeat a branch', configHint: '{ mode, times?, itemsPath? } + body branch' },
  { kind: 'control.parallel', purpose: 'Run branches concurrently', configHint: '{} + branch:*' },
  { kind: 'control.tryCatch', purpose: 'Recover from branch failure', configHint: '{} + try/catch branches' },
  { kind: 'control.stop', purpose: 'Stop the run', configHint: '{ message? }' },
];

const MAX_PLANNED_NODES = 24;

export const getCompactAutomationCapabilities = (): readonly AutomationCapability[] => CAPABILITIES;

export const buildWorkflowPlan = (goal: string, nodes: WorkflowNode[]): WorkflowPlan => {
  const warnings: string[] = [];
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) warnings.push('The workflow goal is empty.');
  if (nodes.length === 0) warnings.push('The workflow has no nodes.');
  if (nodes.length > MAX_PLANNED_NODES) warnings.push(`The workflow exceeds the lightweight limit of ${MAX_PLANNED_NODES} nodes.`);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id.trim()) warnings.push('Every node needs a non-empty id.');
    if (ids.has(node.id)) warnings.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  const first = nodes[0];
  if (first && !first.kind.startsWith('trigger.')) warnings.push('The first node should normally be a trigger.');
  return { goal: trimmedGoal, nodes, warnings };
};
