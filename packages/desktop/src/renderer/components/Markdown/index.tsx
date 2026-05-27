/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import ReactMarkdown from 'react-markdown';

import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

// Import KaTeX CSS to make it available in the document
import 'katex/dist/katex.min.css';

import { openExternalUrl } from '@/renderer/utils/platform';
import classNames from 'classnames';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertLatexDelimiters } from '@renderer/utils/chat/latexDelimiters';
import LocalImageView from '@renderer/components/media/LocalImageView';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { resolveMessageFilePath } from '@renderer/pages/conversation/Messages/components/MessageText';
import { usePreviewContextSafe } from '@renderer/pages/conversation/Preview/context/PreviewContext';
import { getFileTypeInfo } from '@renderer/utils/file/fileType';
import CodeBlock from './CodeBlock';
import ShadowView from './ShadowView';

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBreaks];

const isLocalFilePath = (src: string): boolean => {
  if (src.startsWith('http://') || src.startsWith('https://')) return false;
  if (src.startsWith('data:')) return false;
  return true;
};

type MarkdownViewProps = {
  children: string;
  hiddenCodeCopyButton?: boolean;
  codeStyle?: React.CSSProperties;
  className?: string;
  onRef?: (el?: HTMLDivElement | null) => void;
  /** Enable raw HTML rendering in markdown content. Use with caution — only for trusted sources. */
  allowHtml?: boolean;
};

const MarkdownView: React.FC<MarkdownViewProps> = React.memo(
  ({ hiddenCodeCopyButton, codeStyle, className, onRef, allowHtml, children: childrenProp }) => {
    const { t } = useTranslation();
    const conversationCtx = useConversationContextSafe();
    const previewCtx = usePreviewContextSafe();
    const workspace = conversationCtx?.workspace;

    const normalizedChildren = useMemo(() => {
      if (typeof childrenProp === 'string') {
        let text = childrenProp.replace(/file:\/\//g, '');
        text = convertLatexDelimiters(text);
        return text;
      }
      return childrenProp;
    }, [childrenProp]);

    const handleLinkClick = useCallback(
      (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        e.stopPropagation();
        // Use getAttribute to get the raw href from markdown, not browser-resolved URL.
        // react-markdown URL-encodes non-ASCII chars in href, so decode first.
        const rawHref = (e.currentTarget as HTMLAnchorElement).getAttribute('href');
        if (!rawHref) return;
        let href: string;
        try {
          href = decodeURIComponent(rawHref);
        } catch {
          href = rawHref;
        }

        // Rule 1: external URL (has scheme) → openExternal
        if (href.includes('://') || href.startsWith('mailto:')) {
          openExternalUrl(href).catch((error: unknown) => {
            console.error(t('messages.openLinkFailed'), error);
          });
          return;
        }

        // Rule 2: anchor or query-only → let browser handle (already prevented default, so do nothing special)
        if (href.startsWith('#') || href.startsWith('?')) {
          return;
        }

        // Rules 3-4: local file candidate (absolute path, or relative with `/` or file extension)
        const hasExtension = /\.[a-zA-Z0-9]+$/.test(href);
        const isAbsolute = href.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(href);
        const isRelativeFilePath = href.includes('/') || hasExtension;

        if (workspace && previewCtx && (isAbsolute || isRelativeFilePath)) {
          const resolvedPath = resolveMessageFilePath(href, workspace);

          // Sandbox check: must stay within workspace
          const normalizedWorkspace = workspace.replace(/[\\/]+$/, '').replace(/\\/g, '/');
          const normalizedResolved = resolvedPath.replace(/\\/g, '/');
          if (!normalizedResolved.startsWith(normalizedWorkspace + '/') && normalizedResolved !== normalizedWorkspace) {
            console.error(t('messages.openLinkFailed'), 'Path outside workspace');
            return;
          }

          const fileName = resolvedPath.split('/').pop() ?? resolvedPath;
          const { contentType } = getFileTypeInfo(fileName);
          previewCtx.openPreview('', contentType, {
            file_path: resolvedPath,
            file_name: fileName,
            title: fileName,
            workspace,
            editable: false,
          });
          return;
        }

        // Rule 5: fallback → openExternal
        openExternalUrl(href).catch((error: unknown) => {
          console.error(t('messages.openLinkFailed'), error);
        });
      },
      [t, workspace, previewCtx]
    );

    // Memoize components so React preserves component identity across re-renders.
    // Without this, every streaming update creates new function references → React
    // unmounts/remounts all custom components → hooks & DOM state are lost.
    const components = useMemo(
      () => ({
        span: ({ node: _node, className: cn, children: ch, ...rest }: Record<string, unknown>) => (
          <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)} className={cn as string}>
            {ch as React.ReactNode}
          </span>
        ),
        code: (props: Record<string, unknown>) => (
          <CodeBlock
            {...(props as Parameters<typeof CodeBlock>[0])}
            codeStyle={codeStyle}
            hiddenCodeCopyButton={hiddenCodeCopyButton}
          />
        ),
        a: ({ node: _node, ...rest }: Record<string, unknown>) => (
          <a
            {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
            target='_blank'
            rel='noreferrer'
            onClick={handleLinkClick}
          />
        ),
        table: ({ node: _node, ...rest }: Record<string, unknown>) => (
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
            <table
              {...(rest as React.TableHTMLAttributes<HTMLTableElement>)}
              style={{
                ...(rest as { style?: React.CSSProperties }).style,
                borderCollapse: 'collapse',
                border: '1px solid var(--bg-3)',
                minWidth: '100%',
              }}
            />
          </div>
        ),
        td: ({ node: _node, ...rest }: Record<string, unknown>) => (
          <td
            {...(rest as React.TdHTMLAttributes<HTMLTableCellElement>)}
            style={{
              ...(rest as { style?: React.CSSProperties }).style,
              padding: '8px',
              border: '1px solid var(--bg-3)',
              minWidth: '120px',
            }}
          />
        ),
        img: ({ node: _node, ...rest }: Record<string, unknown>) => {
          const imgProps = rest as React.ImgHTMLAttributes<HTMLImageElement>;
          if (isLocalFilePath(imgProps.src || '')) {
            const src = decodeURIComponent(imgProps.src || '');
            return <LocalImageView src={src} alt={imgProps.alt || ''} className={imgProps.className} />;
          }
          return <img {...imgProps} />;
        },
      }),
      [codeStyle, hiddenCodeCopyButton, handleLinkClick]
    );

    const rehypePlugins = useMemo(() => (allowHtml ? [rehypeRaw, rehypeKatex] : [rehypeKatex]), [allowHtml]);

    return (
      <div className={classNames('relative w-full', className)}>
        <ShadowView>
          <div ref={onRef} className='markdown-shadow-body'>
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={components}>
              {normalizedChildren}
            </ReactMarkdown>
          </div>
        </ShadowView>
      </div>
    );
  }
);

MarkdownView.displayName = 'MarkdownView';

export default MarkdownView;
