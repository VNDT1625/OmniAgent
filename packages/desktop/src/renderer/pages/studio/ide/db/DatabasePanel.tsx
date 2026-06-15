/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DatabasePanel` — the IDE "Database" mode UI. A built-in, multi-engine SQL
 * client so the user can inspect + query the open repo's database(s) without
 * leaving the app (no DBeaver / psql / web console needed):
 *
 *   - Left rail: saved connections (sqlite / postgres / mysql) + add/edit/delete,
 *     and the active connection's table/column tree.
 *   - Main: a SQL editor (run with Ctrl/Cmd+Enter) + a results grid with timing,
 *     row count, and a read-only/affected-rows badge.
 *
 * The same connections power the agent (`db_*` MCP tools), so what the user sees
 * is what the agent queries. Renderer-only; Arco + icon-park + UnoCSS tokens;
 * all text via i18n.
 */

import { Button, Empty, Input, Message, Spin, Table, Tag, Tooltip } from '@arco-design/web-react';
import {
  Add,
  DataSheet,
  Delete,
  Download,
  Edit,
  Key,
  Lightning,
  ListView,
  Play,
  Refresh,
  Right,
  Search,
  TableFile,
} from '@icon-park/react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toCsv, toJson } from '@process/ide/db/dbExport';
import DbConnectionModal from './DbConnectionModal';
import { useDatabasePanel, type TableWithColumns } from './useDatabasePanel';
import type { DbConnectionConfig, DbConnectionState } from './dbClient';

type DatabasePanelProps = {
  rootPath: string | null;
};

const DatabasePanel: React.FC<DatabasePanelProps> = ({ rootPath }) => {
  const { t } = useTranslation();
  const db = useDatabasePanel(rootPath);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnectionConfig | null>(null);
  const [sql, setSql] = useState('');

  const openAdd = useCallback(() => {
    setEditing(null);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((conn: DbConnectionState) => {
    setEditing(conn.config as DbConnectionConfig);
    setModalOpen(true);
  }, []);

  const handleRun = useCallback(() => {
    if (!db.activeId) {
      Message.warning(t('ide.db.selectConnectionFirst'));
      return;
    }
    void db.runQuery(sql);
  }, [db, sql, t]);

  const onEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleRun();
      }
    },
    [handleRun]
  );

  return (
    <div className='size-full flex min-h-0 bg-1'>
      <ConnectionRail db={db} onAdd={openAdd} onEdit={openEdit} onSelectTable={(table) => setSql(buildSelect(table))} />
      <div className='flex-1 min-w-0 flex flex-col min-h-0'>
        <QueryHeader
          connection={db.connections.find((c) => c.config.id === db.activeId) ?? null}
          running={db.running}
          onRun={handleRun}
        />
        <div className='shrink-0 border-b border-b-1'>
          <Input.TextArea
            value={sql}
            onChange={setSql}
            onKeyDown={onEditorKeyDown}
            placeholder={t('ide.db.sqlPlaceholder')}
            autoSize={{ minRows: 4, maxRows: 10 }}
            className='!border-none !bg-transparent font-mono !text-13px !resize-none'
          />
        </div>
        <ResultArea db={db} />
      </div>

      <DbConnectionModal
        visible={modalOpen}
        initial={editing}
        onClose={() => setModalOpen(false)}
        onSave={db.saveConnection}
        onTest={db.testConnection}
      />
    </div>
  );
};

/** Build a starter SELECT for a clicked table. */
const buildSelect = (table: TableWithColumns): string => {
  const ref = table.schema ? `${table.schema}.${table.name}` : table.name;
  return `SELECT * FROM ${ref} LIMIT 100;`;
};

/** Left rail: connections list + schema tree. */
const ConnectionRail: React.FC<{
  db: ReturnType<typeof useDatabasePanel>;
  onAdd: () => void;
  onEdit: (conn: DbConnectionState) => void;
  onSelectTable: (table: TableWithColumns) => void;
}> = ({ db, onAdd, onEdit, onSelectTable }) => {
  const { t } = useTranslation();
  return (
    <div className='shrink-0 w-260px flex flex-col min-h-0 border-r border-r-1 bg-fill-1'>
      <div className='shrink-0 flex items-center gap-8px px-14px h-44px border-b border-b-1'>
        <DataSheet theme='outline' size={16} className='text-primary' />
        <span className='flex-1 text-13px font-600 text-t-primary'>{t('ide.db.connections')}</span>
        <Tooltip content={t('ide.db.refresh')}>
          <span
            className='inline-flex cursor-pointer text-t-tertiary hover:text-primary'
            onClick={() => void db.refreshConnections()}
          >
            <Refresh theme='outline' size={14} />
          </span>
        </Tooltip>
        <Tooltip content={t('ide.db.addConnection')}>
          <span className='inline-flex cursor-pointer text-t-tertiary hover:text-primary' onClick={onAdd}>
            <Add theme='outline' size={16} />
          </span>
        </Tooltip>
      </div>
      <div className='flex-1 overflow-y-auto'>
        {db.connections.length === 0 ? (
          <div className='px-14px py-24px text-center'>
            <span className='text-12px text-t-tertiary'>{t('ide.db.noConnections')}</span>
          </div>
        ) : (
          db.connections.map((conn) => (
            <ConnectionItem
              key={conn.config.id}
              conn={conn}
              active={conn.config.id === db.activeId}
              tables={conn.config.id === db.activeId ? db.tables : []}
              loadingTables={conn.config.id === db.activeId && db.loadingTables}
              onSelect={() => void db.selectConnection(conn.config.id)}
              onEdit={() => onEdit(conn)}
              onDelete={() => void db.deleteConnection(conn.config.id)}
              onExpandTable={(table) => void db.loadColumns(table)}
              onSelectTable={onSelectTable}
            />
          ))
        )}
      </div>
    </div>
  );
};

/** One connection row + (when active) its schema tree. */
const ConnectionItem: React.FC<{
  conn: DbConnectionState;
  active: boolean;
  tables: TableWithColumns[];
  loadingTables: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExpandTable: (table: TableWithColumns) => void;
  onSelectTable: (table: TableWithColumns) => void;
}> = ({ conn, active, tables, loadingTables, onSelect, onEdit, onDelete, onExpandTable, onSelectTable }) => {
  const { t } = useTranslation();
  const kindLabel = conn.config.kind === 'sqlite' ? 'SQLite' : conn.config.kind === 'postgres' ? 'Postgres' : 'MySQL';
  return (
    <div className='border-b border-b-1/40'>
      <div
        className={`group flex items-center gap-8px px-14px py-9px cursor-pointer hover:bg-fill-2 ${active ? 'bg-primary-light-1' : ''}`}
        onClick={onSelect}
      >
        <DataSheet
          theme={active ? 'filled' : 'outline'}
          size={15}
          className={active ? 'text-primary' : 'text-t-tertiary'}
        />
        <div className='flex-1 min-w-0 flex flex-col'>
          <span className='truncate text-12px font-500 text-t-primary'>{conn.config.name}</span>
          <span className='flex items-center gap-4px text-10px text-t-tertiary'>
            {kindLabel}
            {conn.config.readOnly !== false ? <span className='text-success'>· {t('ide.db.roBadge')}</span> : null}
            {conn.connected ? <span className='text-success'>· {t('ide.db.connected')}</span> : null}
          </span>
        </div>
        <span className='hidden group-hover:flex items-center gap-6px'>
          <Edit
            theme='outline'
            size={13}
            className='text-t-tertiary hover:text-primary'
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          />
          <Delete
            theme='outline'
            size={13}
            className='text-t-tertiary hover:text-danger'
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          />
        </span>
      </div>
      {active ? (
        <div className='pb-6px'>
          {loadingTables ? (
            <div className='flex items-center gap-8px px-22px py-8px text-11px text-t-tertiary'>
              <Spin size={12} /> {t('ide.db.loadingTables')}
            </div>
          ) : tables.length === 0 ? (
            <div className='px-22px py-6px text-11px text-t-tertiary'>{t('ide.db.noTables')}</div>
          ) : (
            <ActiveSchemaTree tables={tables} onExpandTable={onExpandTable} onSelectTable={onSelectTable} />
          )}
        </div>
      ) : null}
    </div>
  );
};

/** The active connection's table list, with a live filter for large schemas. */
const ActiveSchemaTree: React.FC<{
  tables: TableWithColumns[];
  onExpandTable: (table: TableWithColumns) => void;
  onSelectTable: (table: TableWithColumns) => void;
}> = ({ tables, onExpandTable, onSelectTable }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = needle ? tables.filter((tb) => tb.name.toLowerCase().includes(needle)) : tables;
  return (
    <>
      {tables.length > 8 ? (
        <div className='px-14px py-4px'>
          <Input
            size='mini'
            allowClear
            value={filter}
            onChange={setFilter}
            prefix={<Search theme='outline' size={12} className='text-t-tertiary' />}
            placeholder={t('ide.db.filterTables')}
          />
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className='px-22px py-6px text-11px text-t-tertiary'>{t('ide.db.noMatch')}</div>
      ) : (
        shown.map((table) => (
          <TableNode
            key={`${table.schema ?? ''}.${table.name}`}
            table={table}
            onExpand={onExpandTable}
            onSelect={onSelectTable}
          />
        ))
      )}
    </>
  );
};

/** One table in the schema tree, expandable to show columns. */
const TableNode: React.FC<{
  table: TableWithColumns;
  onExpand: (table: TableWithColumns) => void;
  onSelect: (table: TableWithColumns) => void;
}> = ({ table, onExpand, onSelect }) => {
  const [open, setOpen] = useState(false);
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) onExpand(table);
  };
  return (
    <div>
      <div className='group flex items-center gap-5px px-22px py-4px cursor-pointer hover:bg-fill-2' onClick={toggle}>
        <Right
          theme='outline'
          size={11}
          className={`text-t-tertiary transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <TableFile theme='outline' size={12} className='text-t-tertiary' />
        <span className='flex-1 truncate text-11px text-t-secondary'>{table.name}</span>
        <Play
          theme='outline'
          size={12}
          className='hidden group-hover:block text-t-tertiary hover:text-primary'
          onClick={(e) => {
            e.stopPropagation();
            onSelect(table);
          }}
        />
      </div>
      {open && table.columns ? (
        <div className='flex flex-col'>
          {table.columns.map((col) => (
            <div key={col.name} className='flex items-center gap-5px pl-44px pr-14px py-2px text-10px'>
              <span className={`truncate ${col.primaryKey ? 'text-primary font-500' : 'text-t-secondary'}`}>
                {col.name}
              </span>
              <span className='text-t-tertiary'>{col.type}</span>
              {col.primaryKey ? (
                <Tag size='small' color='arcoblue' className='!text-8px !px-3px !leading-tight'>
                  PK
                </Tag>
              ) : null}
            </div>
          ))}
          {table.foreignKeys && table.foreignKeys.length > 0 ? (
            <div className='flex flex-col pt-2px'>
              {table.foreignKeys.map((fk) => (
                <div
                  key={fk.name}
                  className='flex items-center gap-4px pl-44px pr-14px py-2px text-9px text-t-tertiary'
                >
                  <Key theme='outline' size={10} className='text-warning shrink-0' />
                  <span className='truncate'>
                    {fk.columns.join(', ')} → {fk.referencedSchema ? `${fk.referencedSchema}.` : ''}
                    {fk.referencedTable}({fk.referencedColumns.join(', ')})
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {table.indexes && table.indexes.length > 0 ? (
            <div className='flex flex-col pt-2px'>
              {table.indexes.map((ix) => (
                <div
                  key={ix.name}
                  className='flex items-center gap-4px pl-44px pr-14px py-2px text-9px text-t-tertiary'
                >
                  <ListView theme='outline' size={10} className='shrink-0' />
                  <span className='truncate'>
                    {ix.name} ({ix.columns.join(', ')})
                  </span>
                  {ix.unique ? (
                    <Tag size='small' color='green' className='!text-8px !px-3px !leading-tight'>
                      UQ
                    </Tag>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** Header above the editor: active connection + Run button. */
const QueryHeader: React.FC<{ connection: DbConnectionState | null; running: boolean; onRun: () => void }> = ({
  connection,
  running,
  onRun,
}) => {
  const { t } = useTranslation();
  return (
    <div className='shrink-0 flex items-center gap-10px px-16px h-44px border-b border-b-1'>
      <ListView theme='outline' size={15} className='text-t-tertiary' />
      <span className='flex-1 text-12px text-t-secondary truncate'>
        {connection ? connection.config.name : t('ide.db.noActiveConnection')}
      </span>
      {connection && connection.config.readOnly !== false ? (
        <Tag size='small' color='green'>
          {t('ide.db.readOnly')}
        </Tag>
      ) : null}
      <Button type='primary' size='small' loading={running} icon={<Play theme='outline' size={13} />} onClick={onRun}>
        {t('ide.db.run')}
      </Button>
    </div>
  );
};

/** Results grid + status line. */
const ResultArea: React.FC<{ db: ReturnType<typeof useDatabasePanel> }> = ({ db }) => {
  const { t } = useTranslation();
  if (db.error) {
    return (
      <div className='flex-1 min-h-0 flex-center flex-col gap-10px px-24px text-center'>
        <Lightning theme='outline' size={26} className='text-danger' />
        <p className='m-0 max-w-480px text-12px text-danger font-mono leading-relaxed break-words'>{db.error}</p>
        <Button size='small' type='outline' onClick={db.clearError}>
          {t('ide.db.dismiss')}
        </Button>
      </div>
    );
  }
  if (!db.result) {
    return (
      <div className='flex-1 min-h-0 flex-center'>
        <Empty description={<span className='text-12px text-t-tertiary'>{t('ide.db.runHint')}</span>} />
      </div>
    );
  }
  const { result } = db;
  if (result.columns.length === 0) {
    return (
      <div className='flex-1 min-h-0 flex flex-col'>
        <StatusLine result={result} />
        <div className='flex-1 flex-center'>
          <span className='text-13px text-success'>{t('ide.db.rowsAffected', { n: result.rowsAffected ?? 0 })}</span>
        </div>
      </div>
    );
  }
  const columns = result.columns.map((name, i) => ({
    title: name,
    dataIndex: String(i),
    ellipsis: true,
    width: 180,
    render: (value: string | number | boolean | null) =>
      value === null ? (
        <span className='text-t-tertiary italic'>NULL</span>
      ) : (
        <span className='font-mono text-12px'>{String(value)}</span>
      ),
  }));
  const data = result.rows.map((row, ri) => {
    const record: Record<string, unknown> = { key: ri };
    row.forEach((cell, ci) => {
      record[String(ci)] = cell;
    });
    return record;
  });
  return (
    <div className='flex-1 min-h-0 flex flex-col'>
      <StatusLine result={result} />
      <div className='flex-1 min-h-0 overflow-auto'>
        <Table
          columns={columns}
          data={data}
          pagination={false}
          size='small'
          border={{ cell: true }}
          scroll={{ x: true }}
          className='ide-db-result-table'
        />
      </div>
    </div>
  );
};

/** Trigger a client-side download of `content` as `filename`. */
const downloadText = (filename: string, content: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/** One-line query status: timing, row count, truncation, and export actions. */
const StatusLine: React.FC<{ result: NonNullable<ReturnType<typeof useDatabasePanel>['result']> }> = ({ result }) => {
  const { t } = useTranslation();
  const canExport = result.columns.length > 0 && result.rows.length > 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return (
    <div className='shrink-0 flex items-center gap-12px px-16px py-6px border-b border-b-1 bg-fill-1 text-11px text-t-tertiary'>
      <span>{t('ide.db.rows', { n: result.rows.length })}</span>
      <span>·</span>
      <span>{t('ide.db.tookMs', { ms: result.durationMs })}</span>
      {result.truncated ? (
        <>
          <span>·</span>
          <span className='text-warning'>{t('ide.db.truncated')}</span>
        </>
      ) : null}
      {canExport ? (
        <span className='ml-auto flex items-center gap-10px'>
          <Tooltip content={t('ide.db.exportCsv')}>
            <span
              className='inline-flex items-center gap-3px cursor-pointer hover:text-primary'
              onClick={() => downloadText(`query-${stamp}.csv`, toCsv(result), 'text/csv')}
            >
              <Download theme='outline' size={12} /> CSV
            </span>
          </Tooltip>
          <Tooltip content={t('ide.db.exportJson')}>
            <span
              className='inline-flex items-center gap-3px cursor-pointer hover:text-primary'
              onClick={() => downloadText(`query-${stamp}.json`, toJson(result), 'application/json')}
            >
              <Download theme='outline' size={12} /> JSON
            </span>
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
};

export default DatabasePanel;
