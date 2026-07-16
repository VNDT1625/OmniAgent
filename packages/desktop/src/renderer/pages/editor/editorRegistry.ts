/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Universal Editor adapter registry.
 *
 * This module is the central decision layer for the Universal Editor (Yêu cầu 2a).
 * It classifies a file (by extension and/or MIME type) into an {@link EditorAdapterKind},
 * which the {@link UniversalEditor} (task 8.3) maps to a concrete adapter component.
 *
 * Design goals (see `.kiro/specs/aionui-enhancements/design.md`, "Yêu cầu 2a"):
 * - **Never stuck (criterion 2.9):** every file resolves to *some* adapter kind. When no
 *   specific adapter matches, classification falls back to `'raw-text'` so a file can always
 *   be opened, even if only as plain text.
 * - **Binary inspection (criterion 2.8):** archives and packaged/binary formats
 *   (zip, npz, package, ...) resolve to `'binary-inspect'` (view structure, no manual edit).
 * - **Data-driven (criterion 2.1):** classification is driven by lookup tables
 *   ({@link ADAPTER_EXTENSIONS}, {@link ADAPTER_MIME_TYPES}) so it is easy to extend and to
 *   property-test ("always returns an adapter", task 8.2).
 *
 * Renderer-only module: no Node.js APIs, no React component imports (adapter components are
 * created in tasks 8.4–8.9). It only exposes pure classification logic plus a generic
 * registration-map type that the UniversalEditor can use to associate kinds → lazy components.
 */

/**
 * The set of editor adapters the Universal Editor can dispatch to.
 *
 * Each kind corresponds to one adapter component (created in later tasks):
 * - `text-code` — Monaco editor for text/code (json, xml, yaml, csv, markdown, html, ini, log, ...).
 * - `docx` — Word documents (content + basic formatting).
 * - `spreadsheet` — Excel-like tabular editing.
 * - `slide` — Slide deck content editing.
 * - `pdf` — PDF view + edit via ONLYOFFICE (annotate, add text, sign, fill forms); read-only viewer fallback.
 * - `image` — Image view + basic edits (crop/rotate/resize).
 * - `media` — Audio/video playback + transcription/summary.
 * - `binary-inspect` — Structure inspection for archives/binaries (no manual edit).
 * - `raw-text` — Plain-text fallback so the editor never gets stuck (criterion 2.9).
 */
export type EditorAdapterKind =
  | 'text-code'
  | 'docx'
  | 'spreadsheet'
  | 'slide'
  | 'pdf'
  | 'image'
  | 'media'
  | 'binary-inspect'
  | 'raw-text';

/**
 * The fallback adapter kind used when no specific adapter matches (criterion 2.9).
 */
export const RAW_TEXT_ADAPTER_KIND: EditorAdapterKind = 'raw-text';

/**
 * All adapter kinds, in dispatch priority order (most specific first, fallback last).
 * Useful for exhaustive iteration in tests and for building component registries.
 */
export const ALL_EDITOR_ADAPTER_KINDS: readonly EditorAdapterKind[] = [
  'text-code',
  'docx',
  'spreadsheet',
  'slide',
  'pdf',
  'image',
  'media',
  'binary-inspect',
  'raw-text',
];

/**
 * Adapter kinds that have explicit extension/MIME mappings (everything except the fallback).
 */
type SpecificAdapterKind = Exclude<EditorAdapterKind, 'raw-text'>;

/**
 * A minimal description of a file used for classification.
 *
 * `fileName` may be a bare name (`report.pdf`) or a full path (`/a/b/report.pdf`);
 * only the basename and extension are inspected. `mime` is an optional MIME type hint
 * (e.g. from an HTTP response or the OS), used when the extension is missing or unknown.
 */
export type FileTypeDescriptor = {
  fileName: string;
  mime?: string;
};

/**
 * Extension → adapter kind table (lowercase extensions, without the leading dot).
 *
 * Extensions are disjoint across kinds. Per criterion 2.1, `csv`/`tsv` are treated as
 * text (Monaco), not spreadsheets. The fallback `raw-text` kind has no explicit table.
 */
export const ADAPTER_EXTENSIONS: Record<SpecificAdapterKind, readonly string[]> = {
  'text-code': [
    // Plain text + common data/markup formats (criterion 2.1)
    'txt',
    'text',
    'json',
    'json5',
    'jsonc',
    'xml',
    'yaml',
    'yml',
    'toml',
    'csv',
    'tsv',
    'ini',
    'cfg',
    'conf',
    'config',
    'properties',
    'env',
    'log',
    'md',
    'markdown',
    'mdown',
    'mkd',
    'mdx',
    'rst',
    'html',
    'htm',
    'xhtml',
    'diff',
    'patch',
    // Programming languages (criterion 2.1: "mọi ngôn ngữ lập trình")
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'mts',
    'cts',
    'py',
    'pyw',
    'pyi',
    'rb',
    'php',
    'java',
    'kt',
    'kts',
    'c',
    'h',
    'cpp',
    'cc',
    'cxx',
    'hpp',
    'hh',
    'hxx',
    'cs',
    'go',
    'rs',
    'swift',
    'm',
    'mm',
    'scala',
    'sh',
    'bash',
    'zsh',
    'fish',
    'ps1',
    'psm1',
    'bat',
    'cmd',
    'pl',
    'pm',
    'lua',
    'r',
    'dart',
    'sql',
    'graphql',
    'gql',
    'vue',
    'svelte',
    'astro',
    'css',
    'scss',
    'sass',
    'less',
    'styl',
    'gradle',
    'groovy',
    'clj',
    'cljs',
    'cljc',
    'ex',
    'exs',
    'erl',
    'hrl',
    'hs',
    'ml',
    'mli',
    'fs',
    'fsx',
    'fsi',
    'vb',
    'asm',
    's',
    'proto',
    'tf',
    'tfvars',
    'hcl',
    'nix',
    'zig',
    'jl',
    'elm',
  ],
  docx: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf'],
  spreadsheet: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'ods', 'ots'],
  slide: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'odp', 'otp'],
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'avif', 'heic', 'heif'],
  media: [
    'mp4',
    'm4v',
    'mov',
    'mkv',
    'webm',
    'avi',
    'flv',
    'wmv',
    'mpeg',
    'mpg',
    '3gp',
    'ogv',
    'mp3',
    'wav',
    'ogg',
    'oga',
    'm4a',
    'aac',
    'flac',
    'wma',
    'opus',
  ],
  // Archives + packaged/binary formats — inspect structure only (criterion 2.8)
  'binary-inspect': [
    'zip',
    'tar',
    'gz',
    'tgz',
    'bz2',
    'tbz2',
    'xz',
    '7z',
    'rar',
    'npz',
    'npy',
    'pkl',
    'pickle',
    'h5',
    'hdf5',
    'pb',
    'onnx',
    'safetensors',
    'ckpt',
    'pt',
    'pth',
    'bin',
    'dat',
    'dll',
    'so',
    'dylib',
    'exe',
    'jar',
    'war',
    'ear',
    'whl',
    'deb',
    'rpm',
    'dmg',
    'iso',
    'apk',
    'aab',
    'msi',
    'wasm',
    'class',
    'pack',
  ],
};

/**
 * Known extensionless filenames (lowercase basename) → adapter kind.
 *
 * Lets common config/doc files without an extension still open in a real editor instead of
 * the bare fallback. Matched on the full lowercased basename when no extension is present.
 */
export const ADAPTER_FILENAMES: Record<string, EditorAdapterKind> = {
  dockerfile: 'text-code',
  containerfile: 'text-code',
  makefile: 'text-code',
  gnumakefile: 'text-code',
  gemfile: 'text-code',
  rakefile: 'text-code',
  procfile: 'text-code',
  brewfile: 'text-code',
  vagrantfile: 'text-code',
  jenkinsfile: 'text-code',
  license: 'text-code',
  readme: 'text-code',
  changelog: 'text-code',
  authors: 'text-code',
  notice: 'text-code',
  '.gitignore': 'text-code',
  '.gitattributes': 'text-code',
  '.npmrc': 'text-code',
  '.editorconfig': 'text-code',
  '.env': 'text-code',
  '.bashrc': 'text-code',
  '.zshrc': 'text-code',
};

/**
 * Exact MIME type → adapter kind table (lowercase, without parameters).
 *
 * Used when the extension is missing or unmatched. Prefix-based rules
 * ({@link ADAPTER_MIME_PREFIXES}) cover broad families like `image/*`.
 */
export const ADAPTER_MIME_TYPES: Record<SpecificAdapterKind, readonly string[]> = {
  'text-code': [
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/typescript',
    'application/x-sh',
    'application/x-httpd-php',
    'application/sql',
    'application/toml',
    'application/x-toml',
  ],
  docx: [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
    'application/rtf',
    'text/rtf',
  ],
  spreadsheet: [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
  ],
  slide: [
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
  ],
  pdf: ['application/pdf'],
  image: [],
  media: [],
  'binary-inspect': [
    'application/zip',
    'application/x-zip-compressed',
    'application/x-tar',
    'application/gzip',
    'application/x-gzip',
    'application/x-bzip2',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    'application/vnd.rar',
    'application/vnd.android.package-archive',
    'application/java-archive',
    'application/wasm',
    'application/octet-stream',
    'application/x-msdownload',
  ],
};

/**
 * A MIME prefix rule: any MIME type starting with `prefix` maps to `kind`.
 */
export type MimePrefixRule = {
  prefix: string;
  kind: SpecificAdapterKind;
};

/**
 * Prefix-based MIME rules for broad families. Checked after exact MIME matches.
 */
export const ADAPTER_MIME_PREFIXES: readonly MimePrefixRule[] = [
  { prefix: 'image/', kind: 'image' },
  { prefix: 'video/', kind: 'media' },
  { prefix: 'audio/', kind: 'media' },
  { prefix: 'text/', kind: 'text-code' },
];

/**
 * Build a flat lookup map (key → kind) from an adapter table. Internal helper used to
 * derive O(1) lookup structures from the human-readable {@link ADAPTER_EXTENSIONS} /
 * {@link ADAPTER_MIME_TYPES} tables.
 */
const buildLookup = (table: Record<SpecificAdapterKind, readonly string[]>): ReadonlyMap<string, EditorAdapterKind> => {
  const lookup = new Map<string, EditorAdapterKind>();
  for (const kind of Object.keys(table) as SpecificAdapterKind[]) {
    for (const key of table[kind]) {
      lookup.set(key, kind);
    }
  }
  return lookup;
};

const EXTENSION_TO_KIND: ReadonlyMap<string, EditorAdapterKind> = buildLookup(ADAPTER_EXTENSIONS);
const MIME_TO_KIND: ReadonlyMap<string, EditorAdapterKind> = buildLookup(ADAPTER_MIME_TYPES);

/**
 * Extract the lowercase basename of a file path (the part after the last `/` or `\`).
 *
 * @param fileName - A bare file name or a full path.
 * @returns The lowercased basename, or an empty string for an empty input.
 *
 * @example
 * getBaseName('/a/b/Report.PDF') // => 'report.pdf'
 * getBaseName('C:\\docs\\Notes.txt') // => 'notes.txt'
 */
export const getBaseName = (fileName: string): string => {
  if (!fileName) return '';
  const lastSlash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const base = lastSlash === -1 ? fileName : fileName.slice(lastSlash + 1);
  return base.toLowerCase();
};

/**
 * Extract the file extension (lowercase, without the dot) from a file path.
 *
 * @param fileName - A bare file name or a full path.
 * @returns The extension, or an empty string when there is none.
 *
 * @example
 * getFileExtension('document.pdf') // => 'pdf'
 * getFileExtension('archive.tar.gz') // => 'gz'
 * getFileExtension('noextension') // => ''
 * getFileExtension('image.PNG') // => 'png'
 */
export const getFileExtension = (fileName: string): string => {
  const base = getBaseName(fileName);
  const lastDot = base.lastIndexOf('.');
  // No dot, a leading-dot dotfile (e.g. ".env"), or a trailing dot ("file.") → no extension.
  if (lastDot <= 0 || lastDot === base.length - 1) {
    return '';
  }
  return base.slice(lastDot + 1);
};

/**
 * Normalize a MIME type for lookup: trim, lowercase, and drop parameters.
 *
 * @param mime - A raw MIME type, possibly with parameters (e.g. `text/html; charset=utf-8`).
 * @returns The normalized MIME type (e.g. `text/html`), or an empty string when absent.
 */
export const normalizeMime = (mime: string | undefined): string => {
  if (!mime) return '';
  const semicolon = mime.indexOf(';');
  const base = semicolon === -1 ? mime : mime.slice(0, semicolon);
  return base.trim().toLowerCase();
};

/**
 * Resolve an adapter kind from a normalized MIME type, or `undefined` when nothing matches.
 * Exact matches take precedence over prefix-family rules.
 */
const classifyByMime = (normalizedMime: string): EditorAdapterKind | undefined => {
  if (!normalizedMime) return undefined;
  const exact = MIME_TO_KIND.get(normalizedMime);
  if (exact) return exact;
  for (const rule of ADAPTER_MIME_PREFIXES) {
    if (normalizedMime.startsWith(rule.prefix)) {
      return rule.kind;
    }
  }
  return undefined;
};

/**
 * Classify a file into an {@link EditorAdapterKind}.
 *
 * Resolution order (most specific first):
 * 1. File extension ({@link ADAPTER_EXTENSIONS}).
 * 2. Known extensionless filename ({@link ADAPTER_FILENAMES}).
 * 3. MIME type — exact then prefix family ({@link ADAPTER_MIME_TYPES} / {@link ADAPTER_MIME_PREFIXES}).
 * 4. Fallback to `'raw-text'` so the editor never gets stuck (criterion 2.9).
 *
 * This function is pure and **always** returns a kind.
 *
 * @param fileName - A bare file name or a full path.
 * @param mime - Optional MIME type hint, used when the name/extension is inconclusive.
 * @returns The resolved adapter kind (never throws, never returns `undefined`).
 */
export const classifyFileType = (fileName: string, mime?: string): EditorAdapterKind => {
  const extension = getFileExtension(fileName);
  if (extension) {
    const byExtension = EXTENSION_TO_KIND.get(extension);
    if (byExtension) return byExtension;
  } else {
    const byFilename = ADAPTER_FILENAMES[getBaseName(fileName)];
    if (byFilename) return byFilename;
  }

  const byMime = classifyByMime(normalizeMime(mime));
  if (byMime) return byMime;

  return RAW_TEXT_ADAPTER_KIND;
};

/**
 * Resolve the adapter kind for a {@link FileTypeDescriptor}.
 *
 * Thin wrapper over {@link classifyFileType} that accepts a descriptor object. It **always**
 * returns a kind, falling back to `'raw-text'` when nothing matches (criterion 2.9).
 *
 * @param file - The file descriptor (name + optional MIME).
 * @returns The resolved adapter kind (never throws, never returns `undefined`).
 */
export const resolveAdapterKind = (file: FileTypeDescriptor): EditorAdapterKind =>
  classifyFileType(file.fileName, file.mime);

/**
 * A registration map associating every adapter kind with a value of type `TComponent`.
 *
 * The Universal Editor (task 8.3) uses this to map kinds → lazily-loaded adapter components,
 * for example `AdapterComponentRegistry<LazyExoticComponent<AdapterProps>>`. This type is
 * generic so this module does not need to import React or any adapter component.
 *
 * Being a `Record` over the full {@link EditorAdapterKind} union, TypeScript enforces that a
 * registry covers every kind — including the `'raw-text'` fallback.
 */
export type AdapterComponentRegistry<TComponent> = Record<EditorAdapterKind, TComponent>;
