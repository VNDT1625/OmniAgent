import { bridge } from '@office-ai/platform';
import { NativeOfficeWatchService, NativeWatchService, NativeZipService, type ZipEntry } from './fileOperations';

export const nativeFileOperationChannels = {
  createZip: bridge.buildProvider<boolean, { path: string; request_id?: string; files: ZipEntry[] }>('native-fs.zip'),
  cancelZip: bridge.buildProvider<boolean, { request_id: string }>('native-fs.zip-cancel'),
  watchStart: bridge.buildProvider<void, { file_path: string }>('native-fs.watch-start'),
  watchStop: bridge.buildProvider<void, { file_path: string }>('native-fs.watch-stop'),
  watchStopAll: bridge.buildProvider<void, void>('native-fs.watch-stop-all'),
  fileChanged: bridge.buildEmitter<{ file_path: string; event_type: string }>('fileWatch.fileChanged'),
  officeWatchStart: bridge.buildProvider<void, { workspace: string }>('native-fs.office-watch-start'),
  officeWatchStop: bridge.buildProvider<void, { workspace: string }>('native-fs.office-watch-stop'),
  officeFileAdded: bridge.buildEmitter<{ file_path: string; workspace: string }>('workspaceOfficeWatch.fileAdded'),
};

export const registerNativeFileOperationBridge = (
  zip = new NativeZipService(),
  watch = new NativeWatchService(),
  officeWatch = new NativeOfficeWatchService()
): void => {
  nativeFileOperationChannels.createZip.provider((input) => zip.create(input));
  nativeFileOperationChannels.cancelZip.provider(({ request_id }) => zip.cancel(request_id));
  nativeFileOperationChannels.watchStart.provider(({ file_path }) => {
    watch.start(file_path, (event) => nativeFileOperationChannels.fileChanged.emit(event));
  });
  nativeFileOperationChannels.watchStop.provider(({ file_path }) => watch.stop(file_path));
  nativeFileOperationChannels.watchStopAll.provider(() => watch.stopAll());
  nativeFileOperationChannels.officeWatchStart.provider(({ workspace }) =>
    officeWatch.start(workspace, (file_path, resolvedWorkspace) =>
      nativeFileOperationChannels.officeFileAdded.emit({ file_path, workspace: resolvedWorkspace })
    )
  );
  nativeFileOperationChannels.officeWatchStop.provider(({ workspace }) => officeWatch.stop(workspace));
};
