import { bridge } from '@office-ai/platform';
import type { CompareResult, FileChangeOperation, SnapshotInfo } from '@/common/types/platform/fileSnapshot';
import { NativeSnapshotService } from './snapshotService';

export const nativeSnapshotChannels = {
  init: bridge.buildProvider<SnapshotInfo, { workspace: string }>('native-snapshot.init'),
  compare: bridge.buildProvider<CompareResult, { workspace: string }>('native-snapshot.compare'),
  baseline: bridge.buildProvider<string | null, { workspace: string; file_path: string }>('native-snapshot.baseline'),
  info: bridge.buildProvider<SnapshotInfo, { workspace: string }>('native-snapshot.info'),
  dispose: bridge.buildProvider<void, { workspace: string }>('native-snapshot.dispose'),
  stage: bridge.buildProvider<void, { workspace: string; file_path: string }>('native-snapshot.stage'),
  stageAll: bridge.buildProvider<void, { workspace: string }>('native-snapshot.stage-all'),
  unstage: bridge.buildProvider<void, { workspace: string; file_path: string }>('native-snapshot.unstage'),
  unstageAll: bridge.buildProvider<void, { workspace: string }>('native-snapshot.unstage-all'),
  discard: bridge.buildProvider<void, { workspace: string; file_path: string; operation: FileChangeOperation }>(
    'native-snapshot.discard'
  ),
  reset: bridge.buildProvider<void, { workspace: string; file_path: string; operation: FileChangeOperation }>(
    'native-snapshot.reset'
  ),
  branches: bridge.buildProvider<string[], { workspace: string }>('native-snapshot.branches'),
};

export const registerNativeSnapshotBridge = (service = new NativeSnapshotService()): void => {
  nativeSnapshotChannels.init.provider(({ workspace }) => service.init(workspace));
  nativeSnapshotChannels.compare.provider(({ workspace }) => service.compare(workspace));
  nativeSnapshotChannels.baseline.provider(({ workspace, file_path }) => service.baseline(workspace, file_path));
  nativeSnapshotChannels.info.provider(({ workspace }) => service.getInfo(workspace));
  nativeSnapshotChannels.dispose.provider(({ workspace }) => service.dispose(workspace));
  nativeSnapshotChannels.stage.provider(({ workspace, file_path }) => service.stage(workspace, file_path));
  nativeSnapshotChannels.stageAll.provider(({ workspace }) => service.stage(workspace));
  nativeSnapshotChannels.unstage.provider(({ workspace, file_path }) => service.unstage(workspace, file_path));
  nativeSnapshotChannels.unstageAll.provider(({ workspace }) => service.unstage(workspace));
  nativeSnapshotChannels.discard.provider(({ workspace, file_path, operation }) =>
    service.discard(workspace, file_path, operation)
  );
  nativeSnapshotChannels.reset.provider(({ workspace, file_path }) => service.reset(workspace, file_path));
  nativeSnapshotChannels.branches.provider(({ workspace }) => service.branches(workspace));
};
