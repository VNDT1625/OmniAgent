/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';

export const removeWorkspaceEntry = (path: string) => {
  return ipcBridge.fs.removeEntry.invoke({ path });
};

export const renameWorkspaceEntry = (path: string, new_name: string) => {
  return ipcBridge.fs.renameEntry.invoke({ path, new_name });
};
