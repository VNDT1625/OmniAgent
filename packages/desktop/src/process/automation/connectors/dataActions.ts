/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data connectors for the Automation feature — the small, dependency-free leaf
 * nodes that shape data between steps:
 *
 *  - `action.set`        — build/extend an object from templated fields.
 *  - `action.code`       — render a `{{input}}` template (optionally JSON-parsed).
 *    NOTE: this is intentionally NOT a JS `eval` — only safe template
 *    substitution, so a workflow can never run arbitrary code.
 *  - `action.filesystem` — read / write / append / list local files.
 *
 * The fs surface is injected so the filesystem node unit-tests without disk.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeNodeConfig, FilesystemNodeConfig, SetNodeConfig } from '../automationTypes';
import { substituteInput } from './artifacts';

/** Render a `{{input}}` / `{{input.path}}` template against the pipeline input. */
const renderTemplate = (template: string, input: unknown): string =>
  template.replace(/\{\{\s*input(\.[^}]*)?\s*\}\}/g, (_m, dotted: string | undefined) => {
    if (!dotted) return typeof input === 'string' ? input : input == null ? '' : JSON.stringify(input);
    const value = readPath(input, dotted.replace(/^\./, ''));
    return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  });

/** Read a dotted path out of an object/array. */
const readPath = (root: unknown, dotted: string): unknown => {
  let cur: unknown = root;
  for (const part of dotted.split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
};

/** Run an `action.set` node: build an object from templated fields. */
export const runSet = (config: SetNodeConfig, input: unknown): Record<string, unknown> => {
  const base: Record<string, unknown> =
    config.keepInput && input != null && typeof input === 'object' && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {};
  for (const field of config.fields ?? []) {
    if (!field || typeof field.key !== 'string' || field.key.length === 0) continue;
    base[field.key] = renderTemplate(typeof field.value === 'string' ? field.value : '', input);
  }
  return base;
};

/** Run an `action.code` node: render a template, optionally JSON-parse it. */
export const runCode = (config: CodeNodeConfig, input: unknown): unknown => {
  const rendered = renderTemplate(typeof config.template === 'string' ? config.template : '', input);
  if (config.parseJson) {
    try {
      return JSON.parse(rendered) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`action.code: could not parse rendered output as JSON: ${message}`, { cause: error });
    }
  }
  return rendered;
};

/** Minimal fs surface the filesystem node needs (injectable for tests). */
export type FilesystemFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, encoding: 'utf-8'): Promise<void>;
  appendFile(filePath: string, data: string, encoding: 'utf-8'): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(dirPath: string): Promise<string[]>;
};

/** Default fs adapter backed by Node's `fs/promises`. */
const defaultFs: FilesystemFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, encoding) => fs.promises.writeFile(filePath, data, { encoding }),
  appendFile: (filePath, data, encoding) => fs.promises.appendFile(filePath, data, { encoding }),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  readdir: (dirPath) => fs.promises.readdir(dirPath),
};

/** Result of an `action.filesystem` node. */
export type FilesystemResult =
  | { operation: 'read'; path: string; content: string }
  | { operation: 'write' | 'append'; path: string; bytes: number }
  | { operation: 'list'; path: string; entries: string[] };

/** Create the filesystem action runner bound to an (optionally fake) fs. */
export const createFilesystemAction = (fsImpl: FilesystemFs = defaultFs) => ({
  async run(config: FilesystemNodeConfig, input: unknown, nodeName: string): Promise<FilesystemResult> {
    const target = substituteInput(config.path ?? '', input).trim();
    if (target.length === 0) throw new Error(`"${nodeName}" is missing a file path.`);

    switch (config.operation) {
      case 'read': {
        const content = await fsImpl.readFile(target, 'utf-8');
        return { operation: 'read', path: target, content };
      }
      case 'write': {
        const content = substituteInput(config.content ?? '', input);
        await fsImpl.mkdir(path.dirname(target), { recursive: true });
        await fsImpl.writeFile(target, content, 'utf-8');
        return { operation: 'write', path: target, bytes: content.length };
      }
      case 'append': {
        const content = substituteInput(config.content ?? '', input);
        await fsImpl.mkdir(path.dirname(target), { recursive: true });
        await fsImpl.appendFile(target, content, 'utf-8');
        return { operation: 'append', path: target, bytes: content.length };
      }
      case 'list': {
        const entries = await fsImpl.readdir(target);
        return { operation: 'list', path: target, entries };
      }
      default:
        throw new Error(`"${nodeName}" has an unknown filesystem operation.`);
    }
  },
});
