/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildCompilerOptions,
  buildDiagnosticsOptions,
  configureMonacoTypeScript,
  isTypeScriptLike,
  SINGLE_FILE_IGNORED_DIAGNOSTICS,
  type TypeScriptEnums,
} from '../../../packages/desktop/src/renderer/pages/editor/adapters/monacoTsSetup';

const enums: TypeScriptEnums = {
  ScriptTarget: { ESNext: 99 },
  ModuleKind: { ESNext: 99 },
  ModuleResolutionKind: { NodeJs: 2 },
  JsxEmit: { Preserve: 1 },
};

describe('isTypeScriptLike', () => {
  it('matches only typescript and javascript language ids', () => {
    expect(isTypeScriptLike('typescript')).toBe(true);
    expect(isTypeScriptLike('javascript')).toBe(true);
    expect(isTypeScriptLike('json')).toBe(false);
    expect(isTypeScriptLike('python')).toBe(false);
    expect(isTypeScriptLike('plaintext')).toBe(false);
  });
});

describe('buildCompilerOptions', () => {
  it('targets modern ESNext + JSX preserve + permissive single-file resolution', () => {
    const options = buildCompilerOptions(enums);
    expect(options.target).toBe(enums.ScriptTarget.ESNext);
    expect(options.module).toBe(enums.ModuleKind.ESNext);
    expect(options.jsx).toBe(enums.JsxEmit.Preserve);
    expect(options.allowJs).toBe(true);
    expect(options.allowNonTsExtensions).toBe(true);
    expect(options.skipLibCheck).toBe(true);
  });
});

describe('buildDiagnosticsOptions', () => {
  it('keeps syntax + semantic validation ON', () => {
    const options = buildDiagnosticsOptions();
    expect(options.noSemanticValidation).toBe(false);
    expect(options.noSyntaxValidation).toBe(false);
  });

  it('ignores the module-resolution codes that are noise in isolation', () => {
    const options = buildDiagnosticsOptions();
    expect(options.diagnosticCodesToIgnore).toEqual([...SINGLE_FILE_IGNORED_DIAGNOSTICS]);
    // 2307 = cannot find module — must be silenced for single-file editing.
    expect(options.diagnosticCodesToIgnore).toContain(2307);
  });

  it('returns a fresh array (callers may mutate without affecting the source)', () => {
    const a = buildDiagnosticsOptions();
    const b = buildDiagnosticsOptions();
    expect(a.diagnosticCodesToIgnore).not.toBe(b.diagnosticCodesToIgnore);
  });
});

describe('configureMonacoTypeScript', () => {
  const makeDefaults = () => ({
    setCompilerOptions: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  });

  it('applies compiler + diagnostics options to both TS and JS defaults', () => {
    const tsDefaults = makeDefaults();
    const jsDefaults = makeDefaults();
    const monaco = {
      languages: {
        typescript: {
          ...enums,
          typescriptDefaults: tsDefaults,
          javascriptDefaults: jsDefaults,
        },
      },
    };
    const configured = configureMonacoTypeScript(monaco);
    expect(configured).toBe(true);
    expect(tsDefaults.setCompilerOptions).toHaveBeenCalledOnce();
    expect(tsDefaults.setDiagnosticsOptions).toHaveBeenCalledOnce();
    expect(tsDefaults.setEagerModelSync).toHaveBeenCalledWith(true);
    expect(jsDefaults.setCompilerOptions).toHaveBeenCalledOnce();
    expect(jsDefaults.setDiagnosticsOptions).toHaveBeenCalledOnce();
  });

  it('is a no-op when the TS language feature is unavailable', () => {
    const monaco = { languages: {} };
    expect(configureMonacoTypeScript(monaco)).toBe(false);
  });

  it('tolerates a missing setEagerModelSync (slim monaco builds)', () => {
    const tsDefaults = { setCompilerOptions: vi.fn(), setDiagnosticsOptions: vi.fn() };
    const jsDefaults = { setCompilerOptions: vi.fn(), setDiagnosticsOptions: vi.fn() };
    const monaco = {
      languages: {
        typescript: {
          ...enums,
          typescriptDefaults: tsDefaults,
          javascriptDefaults: jsDefaults,
        },
      },
    };
    expect(() => configureMonacoTypeScript(monaco)).not.toThrow();
  });
});
