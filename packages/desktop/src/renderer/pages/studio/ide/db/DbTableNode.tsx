/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DbTableNode` — the custom React Flow node for the schema (ER) diagram. Renders
 * a table as a card: a header (table name + a "view" tag when applicable) and a
 * list of columns, each marked with a key icon for primary keys and a link icon
 * for foreign-key source columns. Focus / neighbour / dimmed states are driven
 * by the `highlight` flag so the diagram reads clearly when a table is hovered.
 *
 * Styling: Arco-compatible UnoCSS semantic tokens only (surface/border/text);
 * no raw colours, no raw interactive HTML. The two `Handle`s are hidden edge
 * connectors — the diagram is not user-editable. Renderer-only.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Key, Link, TableFile } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NODE_W, type DbFlowNode } from './dbSchemaLayout';

/** Hidden handle style — present for edge attachment, invisible to the user. */
const HANDLE_STYLE: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 'none',
  background: 'transparent',
};

const DbTableNode: React.FC<NodeProps<DbFlowNode>> = ({ data, selected }) => {
  const { t } = useTranslation();
  const { name, type, columns, hiddenColumns, fkColumns, highlight } = data;
  const dimmed = highlight === 'dim';
  const emphasized = highlight === 'focus' || highlight === 'neighbor' || selected;
  const fkSet = new Set(fkColumns);

  return (
    <div
      style={{ width: NODE_W, opacity: dimmed ? 0.35 : 1 }}
      className={`flex flex-col rd-8px overflow-hidden border bg-2 transition-all duration-150 ${emphasized ? 'border-primary shadow-[0_0_0_2px_var(--primary)]' : 'border-arco-2 shadow-sm'}`}
    >
      <Handle type='target' position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <div className='flex items-center gap-6px px-10px h-30px bg-fill-2 border-b border-b-1'>
        <TableFile theme='outline' size={13} className='shrink-0 text-primary' />
        <span className='flex-1 truncate text-12px font-600 text-t-primary'>{name}</span>
        {type === 'view' ? (
          <span className='shrink-0 text-9px text-t-tertiary uppercase tracking-wide'>view</span>
        ) : null}
      </div>
      <div className='flex flex-col py-2px'>
        {columns.map((col) => (
          <div key={col.name} className='flex items-center gap-5px px-10px h-20px text-10px'>
            {col.primaryKey ? (
              <Key theme='outline' size={10} className='shrink-0 text-primary' />
            ) : fkSet.has(col.name) ? (
              <Link theme='outline' size={10} className='shrink-0 text-warning' />
            ) : (
              <span className='shrink-0 inline-block size-10px' aria-hidden />
            )}
            <span className={`flex-1 truncate ${col.primaryKey ? 'text-t-primary font-500' : 'text-t-secondary'}`}>
              {col.name}
            </span>
            <span className='shrink-0 text-t-tertiary'>{col.type}</span>
          </div>
        ))}
        {hiddenColumns > 0 ? (
          <div className='px-10px h-18px flex items-center text-9px text-t-tertiary italic'>
            {t('ide.db.moreColumns', { n: hiddenColumns })}
          </div>
        ) : null}
      </div>
      <Handle type='source' position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
};

export default React.memo(DbTableNode);
