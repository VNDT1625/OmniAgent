/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useCredentials` — state + actions for the Automation credential vault. Lists
 * the stored credentials (metadata only), and exposes save/remove. Secret values
 * are write-only from the renderer's perspective: they are sent to the Main
 * process to be encrypted, but never read back.
 *
 * Renderer-only.
 */

import { useCallback, useEffect, useState } from 'react';
import { credentialClient, type CredentialSummary } from './credentialClient';
import type { SaveCredentialRequest } from '@process/automation/credentialBridge';

/** Public shape returned by {@link useCredentials}. */
export type UseCredentials = {
  credentials: CredentialSummary[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  save: (req: SaveCredentialRequest) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
};

export const useCredentials = (): UseCredentials => {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await credentialClient.list();
      if (result.ok) {
        setCredentials(result.data);
        setError(null);
      } else {
        setError((result as { ok: false; error: string }).error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (req: SaveCredentialRequest): Promise<boolean> => {
      const result = await credentialClient.save(req).catch((): null => null);
      if (result && result.ok) {
        await reload();
        return true;
      }
      if (result && !result.ok) setError((result as { ok: false; error: string }).error);
      return false;
    },
    [reload]
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    const result = await credentialClient.remove(id).catch((): null => null);
    if (result && result.ok) setCredentials(result.data);
  }, []);

  return { credentials, loading, error, reload, save, remove };
};

export default useCredentials;
