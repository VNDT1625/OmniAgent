/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Monaco TypeScript/JavaScript language-service setup — the "monaco-builtin"
 * engine from the Language Engine model (see `mtui analyze`). Monaco bundles a
 * real TS/JS language service (the TS worker) that gives inline type/syntax
 * diagnostics, completion, hover, and signature help at near-LSP quality with
 * zero extra processes. This module turns it on with options tuned for an editor
 * that opens ONE file at a time (no cross-file module graph), so it stays useful
 * without spamming "cannot find module" errors that are meaningless in isolation.
 *
 * Pure decision helpers ({@link isTypeScriptLike}, {@link buildCompilerOptions},
 * {@link buildDiagnosticsOptions}) are exported for unit testing; the
 * {@link configureMonacoTypeScript} entry point applies them to a Monaco
 * instance and is idempotent (safe to call on every editor mount).
 *
 * Renderer-only. No Node.js APIs.
 */

/** Monaco language ids handled by the bundled TS worker. */
const TS_LIKE = new Set(['typescript', 'javascript']);

/**
 * Whether a Monaco language id is served by the bundled TypeScript worker.
 * Only `typescript` and `javascript` qualify (Monaco maps `tsx`/`jsx` onto
 * these via {@link languageForFile}).
 */
export const isTypeScriptLike = (language: string): boolean => TS_LIKE.has(language);

/**
 * TS diagnostic codes that are noise when a single file is opened without its
 * project (no module resolution, no ambient/global types loaded):
 *  - 2307: "Cannot find module '…' or its type declarations."
 *  - 2304: "Cannot find name '…'." (globals/imports not loaded in isolation)
 *  - 2792: "Cannot find module … Did you mean to set 'moduleResolution'?"
 *  - 7016: "Could not find a declaration file for module '…'."
 *  - 2580: "Cannot find name 'require'/'process'/… (need @types/node)."
 */
export const SINGLE_FILE_IGNORED_DIAGNOSTICS: readonly number[] = [2307, 2304, 2792, 7016, 2580];

/** Shape of the subset of `monaco.languages.typescript` options we set. */
type CompilerOptionsShape = {
  target: number;
  module: number;
  moduleResolution: number;
  jsx: number;
  allowJs: boolean;
  checkJs: boolean;
  allowNonTsExtensions: boolean;
  esModuleInterop: boolean;
  noEmit: boolean;
  skipLibCheck: boolean;
};

/** Shape of the diagnostics options we set on the TS/JS defaults. */
type DiagnosticsOptionsShape = {
  noSemanticValidation: boolean;
  noSyntaxValidation: boolean;
  diagnosticCodesToIgnore: number[];
};

/**
 * The Monaco `typescript` enums we depend on. Passed in from the live monaco
 * instance so this module needs no static `monaco-editor` import (the project
 * only depends on `@monaco-editor/react`, which loads monaco at runtime).
 */
export type TypeScriptEnums = {
  ScriptTarget: { ESNext: number };
  ModuleKind: { ESNext: number };
  ModuleResolutionKind: { NodeJs: number };
  JsxEmit: { Preserve: number };
};

/**
 * Build compiler options for the bundled worker, tuned for modern TS/JS
 * single-file editing (ESNext + JSX preserve + permissive resolution).
 */
export const buildCompilerOptions = (enums: TypeScriptEnums): CompilerOptionsShape => ({
  target: enums.ScriptTarget.ESNext,
  module: enums.ModuleKind.ESNext,
  moduleResolution: enums.ModuleResolutionKind.NodeJs,
  jsx: enums.JsxEmit.Preserve,
  allowJs: true,
  checkJs: false,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  noEmit: true,
  skipLibCheck: true,
});

/**
 * Build diagnostics options: keep syntax + semantic checks ON (the whole point
 * is inline errors), but ignore the module-resolution codes that are noise in
 * isolation (see {@link SINGLE_FILE_IGNORED_DIAGNOSTICS}).
 */
export const buildDiagnosticsOptions = (): DiagnosticsOptionsShape => ({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: [...SINGLE_FILE_IGNORED_DIAGNOSTICS],
});

/** Minimal structural type for the parts of the monaco API we touch. */
type MonacoTsApi = {
  languages: {
    typescript?: {
      ScriptTarget: { ESNext: number };
      ModuleKind: { ESNext: number };
      ModuleResolutionKind: { NodeJs: number };
      JsxEmit: { Preserve: number };
      typescriptDefaults: {
        setCompilerOptions: (options: CompilerOptionsShape) => void;
        setDiagnosticsOptions: (options: DiagnosticsOptionsShape) => void;
        setEagerModelSync?: (value: boolean) => void;
      };
      javascriptDefaults: {
        setCompilerOptions: (options: CompilerOptionsShape) => void;
        setDiagnosticsOptions: (options: DiagnosticsOptionsShape) => void;
        setEagerModelSync?: (value: boolean) => void;
      };
    };
  };
};

/**
 * Apply the TS/JS worker configuration to a live monaco instance. Safe to call
 * repeatedly (Monaco merges the options); a no-op when the TS language feature
 * is unavailable (e.g. a slimmed monaco build). Returns whether it configured.
 */
export const configureMonacoTypeScript = (monaco: MonacoTsApi): boolean => {
  const ts = monaco.languages.typescript;
  if (!ts) return false;
  const compilerOptions = buildCompilerOptions(ts);
  const diagnosticsOptions = buildDiagnosticsOptions();
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
    defaults.setDiagnosticsOptions(diagnosticsOptions);
    defaults.setEagerModelSync?.(true);
  }
  return true;
};
