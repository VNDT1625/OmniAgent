/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { systemInfo } from '@/common/adapter/ipcBridge';
import type {
  LiveSystemMetrics,
  MetricSample,
  ProcessPriorityLevel,
  SetPriorityResult,
  StaticSystemInfo,
} from '@process/system/systemInfoTypes';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Status of the initial System Insight load. */
export type SystemLoadStatus = 'loading' | 'ready' | 'error';

/** Maximum history points kept client-side for sparklines (mirrors the service). */
const HISTORY_MAX = 120;

export type UseSystemMetrics = {
  status: SystemLoadStatus;
  staticInfo: StaticSystemInfo | null;
  live: LiveSystemMetrics | null;
  history: MetricSample[];
  refreshStatic: () => Promise<void>;
  setProcessPriority: (pid: number, level: ProcessPriorityLevel) => Promise<SetPriorityResult>;
};

/**
 * Subscribe to the System Insight service for the Quan sát page.
 *
 * On mount: reads the static profile + the latest snapshot once, calls
 * `startStream` (ref-counted, switches the Main sampler to its fast cadence) and
 * listens to `metricsChanged` for live samples. On unmount it calls `stopStream`
 * and detaches, so the sampler relaxes back to its slow cadence when no page is
 * watching.
 */
export function useSystemMetrics(): UseSystemMetrics {
  const [status, setStatus] = useState<SystemLoadStatus>('loading');
  const [staticInfo, setStaticInfo] = useState<StaticSystemInfo | null>(null);
  const [live, setLive] = useState<LiveSystemMetrics | null>(null);
  const [history, setHistory] = useState<MetricSample[]>([]);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const load = async () => {
      try {
        const [profile, snapshot] = await Promise.all([
          systemInfo.getStaticInfo.invoke(),
          systemInfo.getSnapshot.invoke(),
        ]);
        if (!aliveRef.current) return;
        if (profile) setStaticInfo(profile);
        else if (snapshot) setStaticInfo(snapshot.static);
        if (snapshot) {
          setLive(snapshot.live);
          setHistory(snapshot.history ?? []);
        }
        setStatus(profile || snapshot ? 'ready' : 'error');
      } catch {
        if (aliveRef.current) setStatus('error');
      }
    };

    void load();
    void systemInfo.startStream.invoke();

    const unsubscribe = systemInfo.metricsChanged.on((next) => {
      if (!aliveRef.current || !next) return;
      setLive(next);
      setStatus('ready');
      setHistory((prev) => {
        const appended = [...prev, { t: next.sampledAt, cpu: next.cpu.overallPercent, mem: next.memory.usedPercent }];
        return appended.length > HISTORY_MAX ? appended.slice(appended.length - HISTORY_MAX) : appended;
      });
    });

    return () => {
      aliveRef.current = false;
      unsubscribe();
      void systemInfo.stopStream.invoke();
    };
  }, []);

  const refreshStatic = useCallback(async () => {
    const fresh = await systemInfo.refreshStatic.invoke();
    if (aliveRef.current && fresh) setStaticInfo(fresh);
  }, []);

  const setProcessPriority = useCallback(
    (pid: number, level: ProcessPriorityLevel) => systemInfo.setProcessPriority.invoke({ pid, level }),
    []
  );

  return { status, staticInfo, live, history, refreshStatic, setProcessPriority };
}
