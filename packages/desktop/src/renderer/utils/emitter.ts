/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import EventEmitter from 'eventemitter3';
import type { DependencyList } from 'react';
import { useEffect } from 'react';
import type { FileOrFolderItem } from '@/renderer/utils/file/fileTypes';
import type { PreviewContentType } from '@/common/types/office/preview';

export type ReplyQuote = {
  messageId: string;
  content: string;
  position: 'left' | 'right' | 'center' | 'pop';
};

interface EventTypes {
  'aionrs.selected.file': [Array<string | FileOrFolderItem>];
  'aionrs.selected.file.append': [Array<string | FileOrFolderItem>];
  'aionrs.selected.file.clear': void;
  'aionrs.workspace.refresh': void;
  'acp.selected.file': [Array<string | FileOrFolderItem>];
  'acp.selected.file.append': [Array<string | FileOrFolderItem>];
  'acp.selected.file.clear': void;
  'acp.workspace.refresh': void;
  'codex.selected.file': [Array<string | FileOrFolderItem>];
  'codex.selected.file.append': [Array<string | FileOrFolderItem>];
  'codex.selected.file.clear': void;
  'codex.workspace.refresh': void;
  'openclaw-gateway.selected.file': [Array<string | FileOrFolderItem>];
  'openclaw-gateway.selected.file.append': [Array<string | FileOrFolderItem>];
  'openclaw-gateway.selected.file.clear': void;
  'openclaw-gateway.workspace.refresh': void;
  'nanobot.selected.file': [Array<string | FileOrFolderItem>];
  'nanobot.selected.file.append': [Array<string | FileOrFolderItem>];
  'nanobot.selected.file.clear': void;
  'nanobot.workspace.refresh': void;
  'remote.selected.file': [Array<string | FileOrFolderItem>];
  'remote.selected.file.append': [Array<string | FileOrFolderItem>];
  'remote.selected.file.clear': void;
  'remote.workspace.refresh': void;
  'chat.history.refresh': void;
  // 会话删除事件 / Conversation deletion event
  'conversation.deleted': [string]; // conversation_id
  // 预览面板事件 / Preview panel events
  'preview.open': [
    { content: string; contentType: PreviewContentType; metadata?: { title?: string; file_name?: string } },
  ];
  // 填充输入框事件 / Fill sendbox input event
  'sendbox.fill': [string]; // prompt text to fill
  'sendbox.reply': [ReplyQuote]; // reply/quote a message
  'sendbox.reply.clear': void; // clear reply quote
  'staroffice.install.request': [{ conversation_id: string; text: string; detectedUrl?: string | null }];
  'staroffice.install.finished': [{ conversation_id: string }];
  // Super: toggle the in-chat live-browser frames panel for a conversation.
  'super.watch.toggle': [string]; // conversation_id
  // Super: explicitly set the panel open/closed for a conversation.
  'super.watch.set': [string, boolean]; // conversation_id, open
  // Super: the overlay announces its open state so the header button can sync.
  'super.watch.state': [string, boolean]; // conversation_id, open
  // Browser: ask the Browser page to open its AI chat dock (e.g. when a URL is
  // opened from outside the app / default-browser hand-off).
  'browser.openChat': void;
  // IDE Agent Hooks: a fired hook wants the IDE Chat surface to run a prompt
  // (the workspace root + the prompt to send to a new/active agent tab).
  'ide.hook.askAgent': [{ rootPath: string; prompt: string; hookName: string; filePaths?: string[] }];
  // IDE navigation: the editor asks the workspace to resolve a symbol's
  // definition/references (the workspace owns rootPath + file-opening). When
  // `lsp` is present (a language server is attached to the file), the workspace
  // resolves via that server (type-aware, accurate) instead of the heuristic.
  'ide.nav.request': [
    {
      symbol: string;
      mode: 'definition' | 'references';
      lsp?: { serverId: string; filePath: string; line: number; column: number };
    },
  ];
  // IDE run-test-at-cursor: the editor asks the workspace to build + run the
  // nearest test for a file at a cursor line (workspace owns rootPath + terminal).
  'ide.test.runAtCursor': [{ filePath: string; content: string; line: number }];
  // IDE run-in-terminal: the file tree asks the terminal dock to open + run a
  // quick command in a fresh session at a cwd (empty command = just open here).
  'ide.terminal.run': [{ command: string; cwd?: string }];
  // IDE focus-terminal: Quick Run created a session itself (so it can read the
  // dev-server URL from the output) and asks the dock to open + focus that
  // existing session id, instead of spawning a second one.
  'ide.terminal.focus': [{ id: string }];
  // Quick Test and other IDE surfaces can toggle the existing terminal dock
  // without owning or duplicating its local open state.
  'ide.terminal.toggle': void;
  // IDE relations: the editor's impact CodeLens asks the workspace to reveal the
  // Related-code rail (so the user can see who depends on the file being edited).
  'ide.relations.reveal': [{ filePath: string }];
  // IDE knowledge graph updated for a repo (e.g. a file was re-summarised): open
  // editors refetch the graph so hovers/relations reflect the new summary.
  'ide.kg.updated': [{ rootPath: string }];
}

export const emitter = new EventEmitter<EventTypes>();

export const addEventListener = <T extends EventEmitter.EventNames<EventTypes>>(
  event: T,
  fn: EventEmitter.EventListener<EventTypes, T>
) => {
  emitter.on(event, fn);
  return () => {
    emitter.off(event, fn);
  };
};

export const useAddEventListener = <T extends EventEmitter.EventNames<EventTypes>>(
  event: T,
  fn: EventEmitter.EventListener<EventTypes, T>,
  deps?: DependencyList
) => {
  useEffect(() => {
    return addEventListener(event, fn);
  }, deps || []);
};
