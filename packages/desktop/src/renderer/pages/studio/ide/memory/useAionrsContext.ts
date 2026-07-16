/**
 * Renderer state for the exact provider-neutral context owned by AionRS.
 * Non-AionRS conversations must never call this hook with `enabled = true`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge, type AionrsContextBranch, type AionrsContextSnapshot } from '@/common';

const POLL_MS = 3000;

export type UseAionrsContext = {
  snapshot: AionrsContextSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (customContext: string, branches: AionrsContextBranch[]) => Promise<string | null>;
};

export const useAionrsContext = (conversationId: string | null, enabled: boolean): UseAionrsContext => {
  const [snapshot, setSnapshot] = useState<AionrsContextSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!conversationId || !enabled) {
      setSnapshot(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const next = await ipcBridge.conversation.getAionrsContext.invoke({ conversation_id: conversationId });
      if (!aliveRef.current) return;
      setSnapshot(next);
      setError(null);
    } catch (reason) {
      if (!aliveRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [conversationId, enabled]);

  const save = useCallback(
    async (customContext: string, branches: AionrsContextBranch[]): Promise<string | null> => {
      if (!conversationId || !enabled) return null;
      setSaving(true);
      try {
        const next = await ipcBridge.conversation.updateAionrsContext.invoke({
          conversation_id: conversationId,
          custom_context: customContext,
          context_branches: branches,
        });
        if (aliveRef.current) {
          setSnapshot(next);
          setError(null);
        }
        return null;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (aliveRef.current) setError(message);
        return message;
      } finally {
        if (aliveRef.current) setSaving(false);
      }
    },
    [conversationId, enabled]
  );

  useEffect(() => {
    if (!conversationId || !enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [conversationId, enabled, refresh]);

  return { snapshot, loading, saving, error, refresh, save };
};
