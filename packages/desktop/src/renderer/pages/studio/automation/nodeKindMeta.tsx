/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Presentation metadata for the Automation node kinds — the icon, accent class,
 * and i18n label/description key for each {@link WorkflowNodeKind}, plus a
 * factory for a fresh node's default config. Keeping this table in one place lets
 * the palette, the pipeline rows, and the config form stay consistent.
 *
 * Renderer-only. Icons from `@icon-park/react`, colours from UnoCSS semantic
 * tokens (no hardcoded values).
 */

import {
  Alarm,
  ApiApp,
  Branch,
  Browser,
  BuildingTwo,
  CalendarDot,
  Caution,
  Click,
  Code,
  Cycle,
  DataFile,
  Editor,
  Facebook,
  Filter,
  FolderOpen,
  Forbid,
  Link,
  ListCheckbox,
  Mail,
  Merge,
  MergeCells,
  MessageOne,
  MovieBoard,
  Pause,
  Power,
  Puzzle,
  Remind,
  Robot,
  Schedule,
  ShareTwo,
  Sleep,
  SplitCells,
  Switch,
  Tiktok,
  Timer,
  Transform,
} from '@icon-park/react';
import type { Icon } from '@icon-park/react/lib/runtime';
import type { WorkflowNodeKind } from './automationClient';

/** Per-kind UI descriptor. */
export type NodeKindMeta = {
  kind: WorkflowNodeKind;
  Icon: Icon;
  /** UnoCSS text-colour token class for the icon accent. */
  accentClass: string;
  /** i18n key for the short label. */
  labelKey: string;
  /** i18n key for the one-line description. */
  descKey: string;
  /** Whether this kind is a trigger (starts a pipeline). */
  trigger: boolean;
  /** Default config for a freshly added node of this kind. */
  defaultConfig: () => Record<string, unknown>;
};

/** Ordered table of node kinds offered in the palette. */
export const NODE_KIND_META: NodeKindMeta[] = [
  {
    kind: 'trigger.manual',
    Icon: Click,
    accentClass: 'text-primary',
    labelKey: 'automation.node.manual',
    descKey: 'automation.node.manualDesc',
    trigger: true,
    defaultConfig: () => ({}),
  },
  {
    kind: 'trigger.schedule',
    Icon: Timer,
    accentClass: 'text-primary',
    labelKey: 'automation.node.schedule',
    descKey: 'automation.node.scheduleDesc',
    trigger: true,
    defaultConfig: () => ({ everyMinutes: 60 }),
  },
  {
    kind: 'action.http',
    Icon: ApiApp,
    accentClass: 'text-warning',
    labelKey: 'automation.node.http',
    descKey: 'automation.node.httpDesc',
    trigger: false,
    defaultConfig: () => ({ method: 'GET', url: '' }),
  },
  {
    kind: 'action.ai',
    Icon: Robot,
    accentClass: 'text-success',
    labelKey: 'automation.node.ai',
    descKey: 'automation.node.aiDesc',
    trigger: false,
    defaultConfig: () => ({ model: '', prompt: '' }),
  },
  {
    kind: 'action.transform',
    Icon: Transform,
    accentClass: 'text-t-secondary',
    labelKey: 'automation.node.transform',
    descKey: 'automation.node.transformDesc',
    trigger: false,
    defaultConfig: () => ({ expression: '{{input}}' }),
  },
  {
    kind: 'action.delay',
    Icon: Sleep,
    accentClass: 'text-t-secondary',
    labelKey: 'automation.node.delay',
    descKey: 'automation.node.delayDesc',
    trigger: false,
    defaultConfig: () => ({ ms: 1000 }),
  },
  {
    kind: 'action.log',
    Icon: Power,
    accentClass: 'text-t-tertiary',
    labelKey: 'automation.node.log',
    descKey: 'automation.node.logDesc',
    trigger: false,
    defaultConfig: () => ({ label: '' }),
  },
  // --- App-function nodes: produce an artifact from an AionUi sub-app ---
  {
    kind: 'action.app.makeVideo',
    Icon: MovieBoard,
    accentClass: 'text-primary',
    labelKey: 'automation.node.makeVideo',
    descKey: 'automation.node.makeVideoDesc',
    trigger: false,
    defaultConfig: () => ({
      topic: '',
      style: 'cinematic',
      language: 'English',
      scriptModel: '',
      imageModel: '',
      sceneCount: 4,
      renderVideo: true,
      secondsPerScene: 3,
    }),
  },
  {
    kind: 'action.app.editor',
    Icon: Editor,
    accentClass: 'text-primary',
    labelKey: 'automation.node.editor',
    descKey: 'automation.node.editorDesc',
    trigger: false,
    defaultConfig: () => ({ path: '', operation: 'create', content: '{{input}}' }),
  },
  // --- Cloud storage ---
  {
    kind: 'action.cloud.upload',
    Icon: ShareTwo,
    accentClass: 'text-warning',
    labelKey: 'automation.node.cloudUpload',
    descKey: 'automation.node.cloudUploadDesc',
    trigger: false,
    defaultConfig: () => ({ provider: 's3', publicRead: true }),
  },
  // --- Email + social publishers ---
  {
    kind: 'action.email.send',
    Icon: Mail,
    accentClass: 'text-success',
    labelKey: 'automation.node.email',
    descKey: 'automation.node.emailDesc',
    trigger: false,
    defaultConfig: () => ({
      host: '',
      port: 587,
      secure: false,
      from: '',
      to: '',
      subject: '',
      body: '{{input}}',
      attachArtifact: true,
    }),
  },
  {
    kind: 'action.social.facebook',
    Icon: Facebook,
    accentClass: 'text-success',
    labelKey: 'automation.node.facebook',
    descKey: 'automation.node.facebookDesc',
    trigger: false,
    defaultConfig: () => ({ pageId: '', accessToken: '', message: '{{input}}', attachArtifact: true }),
  },
  {
    kind: 'action.social.tiktok',
    Icon: Tiktok,
    accentClass: 'text-success',
    labelKey: 'automation.node.tiktok',
    descKey: 'automation.node.tiktokDesc',
    trigger: false,
    defaultConfig: () => ({ accessToken: '', caption: '{{input}}', privacy: 'SELF_ONLY' }),
  },
  {
    kind: 'action.company',
    Icon: BuildingTwo,
    accentClass: 'text-primary',
    labelKey: 'automation.node.company',
    descKey: 'automation.node.companyDesc',
    trigger: false,
    defaultConfig: () => ({ mode: 'goal', companyId: '', goal: '{{input}}', autoApprove: true, maxDelegations: 4 }),
  },
  // --- Trigger: webhook ---
  {
    kind: 'trigger.webhook',
    Icon: Link,
    accentClass: 'text-primary',
    labelKey: 'automation.node.webhook',
    descKey: 'automation.node.webhookDesc',
    trigger: true,
    defaultConfig: () => ({ path: '/my-hook' }),
  },
  // --- Control flow ---
  {
    kind: 'control.if',
    Icon: Branch,
    accentClass: 'text-warning',
    labelKey: 'automation.node.if',
    descKey: 'automation.node.ifDesc',
    trigger: false,
    defaultConfig: () => ({ left: '{{input}}', operator: 'isNotEmpty' }),
  },
  {
    kind: 'control.switch',
    Icon: Switch,
    accentClass: 'text-warning',
    labelKey: 'automation.node.switch',
    descKey: 'automation.node.switchDesc',
    trigger: false,
    defaultConfig: () => ({ value: '{{input}}' }),
  },
  {
    kind: 'control.loop',
    Icon: Cycle,
    accentClass: 'text-warning',
    labelKey: 'automation.node.loop',
    descKey: 'automation.node.loopDesc',
    trigger: false,
    defaultConfig: () => ({ mode: 'forEach' }),
  },
  {
    kind: 'control.parallel',
    Icon: SplitCells,
    accentClass: 'text-warning',
    labelKey: 'automation.node.parallel',
    descKey: 'automation.node.parallelDesc',
    trigger: false,
    defaultConfig: () => ({}),
  },
  {
    kind: 'control.tryCatch',
    Icon: Caution,
    accentClass: 'text-warning',
    labelKey: 'automation.node.tryCatch',
    descKey: 'automation.node.tryCatchDesc',
    trigger: false,
    defaultConfig: () => ({}),
  },
  {
    kind: 'control.filter',
    Icon: Filter,
    accentClass: 'text-t-secondary',
    labelKey: 'automation.node.filter',
    descKey: 'automation.node.filterDesc',
    trigger: false,
    defaultConfig: () => ({ left: '{{input}}', operator: 'isNotEmpty' }),
  },
  {
    kind: 'control.merge',
    Icon: MergeCells,
    accentClass: 'text-t-secondary',
    labelKey: 'automation.node.merge',
    descKey: 'automation.node.mergeDesc',
    trigger: false,
    defaultConfig: () => ({}),
  },
  {
    kind: 'control.stop',
    Icon: Forbid,
    accentClass: 'text-t-tertiary',
    labelKey: 'automation.node.stop',
    descKey: 'automation.node.stopDesc',
    trigger: false,
    defaultConfig: () => ({}),
  },
  // --- Data nodes ---
  {
    kind: 'action.set',
    Icon: ListCheckbox,
    accentClass: 'text-t-secondary',
    labelKey: 'automation.node.set',
    descKey: 'automation.node.setDesc',
    trigger: false,
    defaultConfig: () => ({ fields: [{ key: '', value: '{{input}}' }] }),
  },
  {
    kind: 'action.code',
    Icon: Code,
    accentClass: 'text-t-secondary',
    labelKey: 'automation.node.code',
    descKey: 'automation.node.codeDesc',
    trigger: false,
    defaultConfig: () => ({ template: '{{input}}', parseJson: false }),
  },
  {
    kind: 'action.filesystem',
    Icon: FolderOpen,
    accentClass: 'text-t-secondary',
    labelKey: 'automation.node.filesystem',
    descKey: 'automation.node.filesystemDesc',
    trigger: false,
    defaultConfig: () => ({ operation: 'read', path: '' }),
  },
  // --- App-reuse nodes ---
  {
    kind: 'action.notify',
    Icon: Remind,
    accentClass: 'text-success',
    labelKey: 'automation.node.notify',
    descKey: 'automation.node.notifyDesc',
    trigger: false,
    defaultConfig: () => ({ title: 'Automation', body: '{{input}}' }),
  },
  {
    kind: 'action.manager',
    Icon: CalendarDot,
    accentClass: 'text-success',
    labelKey: 'automation.node.manager',
    descKey: 'automation.node.managerDesc',
    trigger: false,
    defaultConfig: () => ({ entity: 'task', title: '{{input}}' }),
  },
  {
    kind: 'action.browser',
    Icon: Browser,
    accentClass: 'text-success',
    labelKey: 'automation.node.browser',
    descKey: 'automation.node.browserDesc',
    trigger: false,
    defaultConfig: () => ({ task: '{{input}}' }),
  },
  {
    kind: 'action.conversation',
    Icon: MessageOne,
    accentClass: 'text-success',
    labelKey: 'automation.node.conversation',
    descKey: 'automation.node.conversationDesc',
    trigger: false,
    defaultConfig: () => ({ message: '{{input}}' }),
  },
  {
    kind: 'action.cron',
    Icon: Alarm,
    accentClass: 'text-success',
    labelKey: 'automation.node.cron',
    descKey: 'automation.node.cronDesc',
    trigger: false,
    defaultConfig: () => ({ cron: '0 9 * * *', prompt: '{{input}}' }),
  },
  {
    kind: 'action.subworkflow',
    Icon: Puzzle,
    accentClass: 'text-primary',
    labelKey: 'automation.node.subworkflow',
    descKey: 'automation.node.subworkflowDesc',
    trigger: false,
    defaultConfig: () => ({ workflowId: '' }),
  },
];

/** Look up a kind's metadata (falls back to the log node for unknown kinds). */
export const metaFor = (kind: WorkflowNodeKind): NodeKindMeta =>
  NODE_KIND_META.find((m) => m.kind === kind) ?? NODE_KIND_META[NODE_KIND_META.length - 1];
