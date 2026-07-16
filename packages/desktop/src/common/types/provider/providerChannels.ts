/**
 * Native provider-management channels shared by Main and renderer.
 * Replaces the legacy /api/providers dependency while preserving ipcBridge.mode.
 */
import { bridge } from '@office-ai/platform';
import type { IProvider } from '@/common/config/storage';
import type {
  CreateProviderRequest,
  FetchModelsAnonymousRequest,
  FetchModelsResponse,
  UpdateProviderRequest,
} from './providerApi';
import type { ProtocolDetectionRequest, ProtocolDetectionResponse } from '@/common/utils/protocolDetector';

export const PROVIDER_CHANNEL_NAMES = {
  list: 'tomny-provider.list',
  create: 'tomny-provider.create',
  update: 'tomny-provider.update',
  remove: 'tomny-provider.remove',
  fetchModels: 'tomny-provider.fetch-models',
  fetchModelList: 'tomny-provider.fetch-model-list',
  detectProtocol: 'tomny-provider.detect-protocol',
} as const;

export const providerChannels = {
  listProviders: bridge.buildProvider<IProvider[], void>(PROVIDER_CHANNEL_NAMES.list),
  createProvider: bridge.buildProvider<IProvider, CreateProviderRequest>(PROVIDER_CHANNEL_NAMES.create),
  updateProvider: bridge.buildProvider<IProvider, { id: string } & UpdateProviderRequest>(
    PROVIDER_CHANNEL_NAMES.update
  ),
  deleteProvider: bridge.buildProvider<void, { id: string }>(PROVIDER_CHANNEL_NAMES.remove),
  fetchProviderModels: bridge.buildProvider<FetchModelsResponse, { id: string; try_fix?: boolean }>(
    PROVIDER_CHANNEL_NAMES.fetchModels
  ),
  fetchModelList: bridge.buildProvider<FetchModelsResponse, FetchModelsAnonymousRequest>(
    PROVIDER_CHANNEL_NAMES.fetchModelList
  ),
  detectProtocol: bridge.buildProvider<ProtocolDetectionResponse, ProtocolDetectionRequest>(
    PROVIDER_CHANNEL_NAMES.detectProtocol
  ),
};
