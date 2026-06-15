/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `BinaryInspectAdapter` — read-only structure/analysis view for binary &
 * packaged files (Yêu cầu 2a, criterion 2.8: "tệp nén, tệp đóng gói, .npz… mở ở
 * chế độ xem/phân tích cấu trúc, không sửa thẳng bằng tay").
 *
 * Shows the file size, a guessed type, and a bounded hex/ASCII dump of the
 * leading bytes (decoded from the base64 content). Never editable. Renderer-only.
 */

import { Alert, Descriptions } from '@arco-design/web-react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getFileExtension } from '../editorRegistry';
import type { EditorAdapterProps } from '../adapterRegistry';

/** Max bytes to render in the hex dump (keeps the DOM small for big files). */
const HEX_DUMP_BYTES = 1024;

/** Decode a base64 string into a byte array (best-effort, browser `atob`). */
const decodeBase64 = (b64: string): Uint8Array => {
  try {
    const raw = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
};

/** Render a classic 16-bytes-per-row hex + ASCII dump of `bytes`. */
const hexDump = (bytes: Uint8Array): string => {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.subarray(offset, offset + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(slice, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`);
  }
  return lines.join('\n');
};

/** Human-readable byte size. */
const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Inspect a binary/packaged file: metadata + a bounded hex preview. Read-only.
 */
const BinaryInspectAdapter: React.FC<EditorAdapterProps> = ({ filePath, content }) => {
  const { t } = useTranslation();

  const { bytes, dump, truncated } = useMemo(() => {
    const decoded = decodeBase64(content);
    const head = decoded.subarray(0, HEX_DUMP_BYTES);
    return { bytes: decoded, dump: hexDump(head), truncated: decoded.length > HEX_DUMP_BYTES };
  }, [content]);

  const ext = getFileExtension(filePath) || t('editor.binary.unknownType');

  return (
    <div className='flex flex-col h-full w-full gap-12px'>
      <Alert type='info' content={t('editor.binary.readOnlyNotice')} />
      <Descriptions
        column={1}
        size='small'
        data={[
          { label: t('editor.binary.type'), value: ext },
          { label: t('editor.binary.size'), value: formatBytes(bytes.length) },
        ]}
      />
      <div className='flex-1 min-h-0 overflow-auto border border-border-base rd-6px bg-bg-2'>
        <pre className='m-0 p-12px font-mono text-12px text-t-secondary whitespace-pre'>
          {dump || t('editor.binary.empty')}
        </pre>
        {truncated ? (
          <p className='m-0 px-12px pb-12px text-12px text-t-tertiary'>
            {t('editor.binary.truncated', { count: HEX_DUMP_BYTES })}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export default BinaryInspectAdapter;
