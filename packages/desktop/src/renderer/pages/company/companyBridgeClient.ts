/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the company IPC surface (Requirement 3.1, Task 4.10).
 *
 * The Main-process bridge module (`process/company/companyBridge.ts`) pulls in
 * Electron + Node `fs` (via `companyConfig.ts`), so it must NOT be imported into
 * the renderer at runtime. Instead this module:
 *
 * - re-declares the channel-name strings (the renderer-safe contract — kept in
 *   sync with `COMPANY_CHANNELS` in the bridge), and
 * - rebuilds matching `bridge.buildProvider(...)` invokers from those names,
 *   exactly the way `ipcBridge.ts` declares the Electron-native `resource`
 *   namespace.
 *
 * Only **types** are borrowed from the Main-process modules via `import type`,
 * which is erased at compile time and therefore safe across the process
 * boundary.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { CompanyConfig } from '@process/company/companyConfig';
import type { CompanyStructure } from '@process/company/companyOrchestrator';
import type {
  AcceptDraftsResult,
  CancelConversationRequest,
  CompanyIdRequest,
  CompanyResult,
  ConversationEventEnvelope,
  CreateFromDescriptionRequest,
  ListAgentsResponse,
  ResolvePermissionRequest,
  RunConversationBridgeRequest,
  RunConversationBridgeResult,
  SetAssignmentRequest,
  SetRulesRequest,
  UpdateStructureRequest,
} from '@process/company/companyBridge';

/**
 * Company IPC channel names. These mirror `COMPANY_CHANNELS` exported from the
 * Main-process `companyBridge.ts`; they are duplicated here (rather than
 * imported) so the renderer never loads the Node-only bridge module.
 */
const COMPANY_CHANNELS = {
  createFromDescription: 'company.create-from-description',
  getStructure: 'company.get-structure',
  getRules: 'company.get-rules',
  setRules: 'company.set-rules',
  listAgents: 'company.list-agents',
  setAssignment: 'company.set-assignment',
  acceptDrafts: 'company.accept-drafts',
  updateStructure: 'company.update-structure',
  deleteCompany: 'company.delete-company',
  runConversation: 'company.run-conversation',
  resolvePermission: 'company.resolve-permission',
  cancelConversation: 'company.cancel-conversation',
  conversationEvent: 'company.conversation-event',
} as const;

/**
 * Typed company invokers for the renderer. Each `.invoke(req)` round-trips to
 * the matching Main-process provider registered by `registerCompanyBridge`.
 *
 * Every channel resolves with a {@link CompanyResult} envelope (never rejects on
 * a handled failure), because the platform bridge swallows rejected promises and
 * would otherwise hang the renderer. Callers read `result.ok` to branch.
 */
export const companyClient = {
  createFromDescription: bridge.buildProvider<CompanyResult<CompanyConfig>, CreateFromDescriptionRequest>(
    COMPANY_CHANNELS.createFromDescription
  ),
  getStructure: bridge.buildProvider<CompanyResult<CompanyStructure>, CompanyIdRequest>(COMPANY_CHANNELS.getStructure),
  getRules: bridge.buildProvider<CompanyResult<string[]>, CompanyIdRequest>(COMPANY_CHANNELS.getRules),
  setRules: bridge.buildProvider<CompanyResult<CompanyConfig>, SetRulesRequest>(COMPANY_CHANNELS.setRules),
  listAgents: bridge.buildProvider<CompanyResult<ListAgentsResponse>, void>(COMPANY_CHANNELS.listAgents),
  setAssignment: bridge.buildProvider<CompanyResult<CompanyConfig>, SetAssignmentRequest>(
    COMPANY_CHANNELS.setAssignment
  ),
  acceptDrafts: bridge.buildProvider<CompanyResult<AcceptDraftsResult>, CompanyIdRequest>(
    COMPANY_CHANNELS.acceptDrafts
  ),
  updateStructure: bridge.buildProvider<CompanyResult<CompanyConfig>, UpdateStructureRequest>(
    COMPANY_CHANNELS.updateStructure
  ),
  deleteCompany: bridge.buildProvider<CompanyResult<{ deleted: boolean }>, CompanyIdRequest>(
    COMPANY_CHANNELS.deleteCompany
  ),
  runConversation: bridge.buildProvider<CompanyResult<RunConversationBridgeResult>, RunConversationBridgeRequest>(
    COMPANY_CHANNELS.runConversation
  ),
  resolvePermission: bridge.buildProvider<CompanyResult<{ resolved: boolean }>, ResolvePermissionRequest>(
    COMPANY_CHANNELS.resolvePermission
  ),
  cancelConversation: bridge.buildProvider<CompanyResult<void>, CancelConversationRequest>(
    COMPANY_CHANNELS.cancelConversation
  ),
};

/**
 * Subscribe to live company conversation events (transcript + status board).
 *
 * The Main-process bridge pushes a {@link ConversationEventEnvelope} per step;
 * the listener receives the unwrapped event. Returns an unsubscribe function.
 */
const conversationEventEmitter = bridge.buildEmitter<ConversationEventEnvelope>(COMPANY_CHANNELS.conversationEvent);

export const onCompanyConversationEvent = (listener: (envelope: ConversationEventEnvelope) => void): (() => void) =>
  conversationEventEmitter.on(listener);
