/** Native provider bridge backed by the independent Tomny provider store. */
import { providerChannels } from '@/common/types/provider/providerChannels';
import type { IProvider } from '@/common/config/storage';
import { httpRequest } from '@/common/adapter/httpBridge';
import { detectProviderProtocol, fetchProviderModelList } from './tomnyModelDiscovery';
import { createProviderStore, type IProviderStore } from './tomnyProviderStore';

let sharedStore: IProviderStore | undefined;
let registered = false;
let migrationPromise: Promise<void> | undefined;

const migrateLegacyProvidersOnce = (store: IProviderStore): Promise<void> => {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    if ((await store.list()).length > 0) return;
    try {
      const legacyProviders = await httpRequest<IProvider[]>('GET', '/api/providers');
      for (const provider of legacyProviders) {
        try {
          // Atomic file persistence is intentionally serialized during one-time migration.
          // eslint-disable-next-line no-await-in-loop
          await store.create(provider);
        } catch (error) {
          console.warn('[ProviderBridge] skipped a legacy provider during one-time migration:', error);
        }
      }
      if (legacyProviders.length > 0) {
        console.info(`[ProviderBridge] migrated ${legacyProviders.length} provider(s) into the Tomny store.`);
      }
    } catch {
      // A fresh installation has no legacy backend. The independent store remains usable.
    }
  })();
  return migrationPromise;
};
export const getProviderStore = (): IProviderStore => {
  if (!sharedStore) sharedStore = createProviderStore();
  return sharedStore;
};

export const getReadyProviderStore = async (): Promise<IProviderStore> => {
  const store = getProviderStore();
  await migrateLegacyProvidersOnce(store);
  return store;
};
export const registerProviderBridge = (): void => {
  if (registered) return;
  registered = true;
  const store = getProviderStore();
  providerChannels.listProviders.provider(async () => {
    await getReadyProviderStore();
    return store.list();
  });
  providerChannels.createProvider.provider((request) => store.create(request));
  providerChannels.updateProvider.provider(({ id, ...request }) => store.update(id, request));
  providerChannels.deleteProvider.provider(({ id }) => store.remove(id));
  providerChannels.fetchProviderModels.provider(async ({ id }) => {
    const provider = await store.get(id);
    if (!provider) throw new Error(`Provider not found: ${id}`);
    return fetchProviderModelList(provider);
  });
  providerChannels.fetchModelList.provider((request) => fetchProviderModelList(request));
  providerChannels.detectProtocol.provider((request) => detectProviderProtocol(request));
};
export const resetProviderBridgeForTests = (): void => {
  sharedStore = undefined;
  registered = false;
  migrationPromise = undefined;
};
