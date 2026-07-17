import { getCompanyServices, type CompanyServices } from '@process/company/companyBridge';
import {
  createCompanyConversation,
  type CompanyChat,
  type ConversationEvent,
  type PermissionDecision,
} from '@process/company/companyConversation';
import { toStructureSpec } from '@process/company/companyConfig';
import { getResourceCoordinator } from '@process/resource/resourceCoordinator';
import type { OrchestrationProposal } from './orchestrationCapability';

export type CompanyCoreRunnerEvent =
  | { type: 'status'; text: string }
  | { type: 'permission'; tool: string; detail?: string; resolve: (approved: boolean) => void };

export type CompanyCoreRunInput = {
  companyId: string;
  goal: string;
  model?: string;
  signal: AbortSignal;
  chat: CompanyChat;
  onEvent: (event: CompanyCoreRunnerEvent) => void;
};

export type CompanyCoreRunner = {
  create(proposal: OrchestrationProposal): Promise<string>;
  run(input: CompanyCoreRunInput): Promise<string>;
};

const statusText = (event: Extract<ConversationEvent, { type: 'status' }>): string => {
  const detail = event.status.task ? ' · ' + event.status.task : '';
  return event.status.id + ': ' + event.status.activity + detail;
};

/** Run the persisted Company role tree through a caller-supplied direct core chat transport. */
export const createCompanyCoreRunner = (
  services: Pick<CompanyServices, 'configStore' | 'buildStructure'> = getCompanyServices()
): CompanyCoreRunner => ({
  async create(proposal) {
    if (proposal.kind !== 'company') throw new Error('Only Company proposals can be persisted as a company.');
    const slug =
      proposal.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 36) || 'company';
    const companyId = `${slug}-${Date.now().toString(36)}`;
    await services.configStore.save(companyId, {
      companyId,
      name: proposal.name,
      description: proposal.reason,
      rules: [
        'Agents may communicate only within the approved role graph.',
        'Keep work within the shared token budget and report evidence to the President.',
      ],
      divisions: proposal.roles.map((role) => ({
        divisionId: role.id,
        name: role.name,
        headName: role.name,
        workerCount: 1,
        responsibilities: role.responsibility,
      })),
    });
    return companyId;
  },
  async run(input) {
    const config = await services.configStore.load(input.companyId);
    const structure = services.buildStructure(toStructureSpec(config));
    const rules = await services.configStore.getRules(input.companyId).catch((): string[] => []);
    let summary = '';
    let failure = '';
    const chat: CompanyChat = (params) =>
      input.chat({ ...params, signal: AbortSignal.any([params.signal, input.signal]) });
    const conversation = createCompanyConversation({ chat, coordinator: getResourceCoordinator() });
    await conversation.run(
      {
        structure,
        companyName: input.companyId,
        rules,
        goal: input.goal,
        model: input.model,
      },
      (event) => {
        if (event.type === 'status') input.onEvent({ type: 'status', text: statusText(event) });
        if (event.type === 'message') {
          input.onEvent({
            type: 'status',
            text: event.message.fromId + ' → ' + event.message.toId + ': ' + event.message.kind,
          });
        }
        if (event.type === 'permission') {
          input.onEvent({
            type: 'permission',
            tool: event.request.action,
            detail: event.request.reason,
            resolve: (approved) => {
              const decision: PermissionDecision = { requestId: event.request.id, approved };
              conversation.resolvePermission(decision);
            },
          });
        }
        if (event.type === 'run-finished') summary = event.summary;
        if (event.type === 'run-error') failure = event.message;
      }
    );
    if (input.signal.aborted) throw new Error('The request was cancelled.');
    if (failure) throw new Error(failure);
    return summary;
  },
});
