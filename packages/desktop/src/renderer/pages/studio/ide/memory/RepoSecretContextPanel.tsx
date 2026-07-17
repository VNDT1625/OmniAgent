/** Repository secret vault editor. Values are accepted only for Main-process encryption and never read back. */
import { Alert, Button, Empty, Input, Message, Popconfirm, Spin, Tag } from '@arco-design/web-react';
import { Delete, Lock, PreviewOpen, Refresh, Save } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RepoSecretContext } from '@process/ide/memory/repoSecretStore';
import { ideClient } from '../ideClient';

type RepoSecretContextPanelProps = { repository: string; active: boolean };

const RepoSecretContextPanel: React.FC<RepoSecretContextPanelProps> = ({ repository, active }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<RepoSecretContext[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alias, setAlias] = useState('');
  const [description, setDescription] = useState('');
  const [value, setValue] = useState('');
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [revealingAlias, setRevealingAlias] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!repository) return;
    setLoading(true);
    const response = await ideClient.repoSecretList(repository).catch((cause): { ok: false; error: string } => ({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }));
    setLoading(false);
    if ('error' in response) {
      setError(response.error);
      return;
    }
    setError(null);
    setItems(response.data);
    setRevealedValues({});
  }, [repository]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const save = async (): Promise<void> => {
    if (!alias.trim() || !description.trim() || !value.trim() || saving) return;
    setSaving(true);
    const response = await ideClient
      .repoSecretSave(repository, alias, description, value)
      .catch((cause): { ok: false; error: string } => ({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    setSaving(false);
    if ('error' in response) {
      Message.error(response.error);
      return;
    }
    setAlias('');
    setDescription('');
    setValue('');
    Message.success(t('ide.memory.secret.saved'));
    await refresh();
  };

  const remove = async (item: RepoSecretContext): Promise<void> => {
    const response = await ideClient.repoSecretRemove(repository, item.alias);
    if ('error' in response) {
      Message.error(response.error);
      return;
    }
    Message.success(t('ide.memory.secret.removed'));
    setRevealedValues((current) => {
      const next = { ...current };
      delete next[item.alias];
      return next;
    });
    await refresh();
  };

  const reveal = async (item: RepoSecretContext): Promise<void> => {
    if (revealedValues[item.alias] !== undefined) {
      setRevealedValues((current) => {
        const next = { ...current };
        delete next[item.alias];
        return next;
      });
      return;
    }
    setRevealingAlias(item.alias);
    const response = await ideClient.repoSecretReveal(repository, item.alias).catch((cause): { ok: false; error: string } => ({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }));
    setRevealingAlias(null);
    if ('error' in response) {
      Message.error(response.error);
      return;
    }
    setRevealedValues((current) => ({ ...current, [item.alias]: response.data }));
  };

  return (
    <div className='h-full min-h-0 flex flex-col gap-14px'>
      <div className='shrink-0 p-12px rd-12px bg-primary-light-1 border border-primary-light-3'>
        <div className='flex items-start gap-10px'>
          <span className='size-30px rd-9px flex-center bg-primary text-white shrink-0'>
            <Lock theme='outline' size={16} />
          </span>
          <div className='min-w-0'>
            <div className='text-13px font-600 text-t-primary'>{t('ide.memory.secret.title')}</div>
            <div className='mt-2px text-11px leading-relaxed text-t-secondary'>{t('ide.memory.secret.hint')}</div>
          </div>
        </div>
      </div>
      {error ? <Alert type='error' content={error} /> : null}
      <div className='shrink-0 flex flex-col gap-8px'>
        <Input
          value={alias}
          onChange={setAlias}
          placeholder={t('ide.memory.secret.aliasPlaceholder')}
          addAfter={t('ide.memory.secret.alias')}
        />
        <Input
          value={description}
          onChange={setDescription}
          placeholder={t('ide.memory.secret.descriptionPlaceholder')}
          addAfter={t('ide.memory.secret.description')}
        />
        <Input.Password value={value} onChange={setValue} placeholder={t('ide.memory.secret.valuePlaceholder')} />
        <Button
          type='primary'
          size='small'
          icon={<Save theme='outline' size={14} />}
          loading={saving}
          onClick={() => void save()}
        >
          {t('ide.memory.secret.save')}
        </Button>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto flex flex-col gap-7px pr-2px'>
        {loading ? <Spin /> : null}
        {!loading && items.length === 0 ? <Empty description={t('ide.memory.secret.empty')} /> : null}
        {items.map((item) => (
          <div key={item.alias} className='flex items-start gap-8px p-10px rd-8px bg-2 border border-arco-2'>
            <Lock theme='outline' size={15} className='shrink-0 mt-2px text-t-tertiary' />
            <div className='min-w-0 flex-1'>
              <div className='flex items-center gap-6px'>
                <span className='font-mono text-12px font-600 text-t-primary'>{item.alias}</span>
                <Tag size='small' color={item.status === 'set' ? 'green' : 'orange'}>
                  {item.status === 'set' ? t('ide.memory.secret.set') : t('ide.memory.secret.needsValue')}
                </Tag>
              </div>
              <div className='mt-3px text-11px leading-relaxed text-t-secondary'>{item.description}</div>
              {revealedValues[item.alias] !== undefined ? (
                <Input className='mt-7px' value={revealedValues[item.alias]} readOnly aria-label={item.alias} />
              ) : null}
            </div>
            {item.status === 'set' ? (
              <Button
                size='mini'
                icon={<PreviewOpen theme='outline' size={13} />}
                loading={revealingAlias === item.alias}
                onClick={() => void reveal(item)}
              >
                {revealedValues[item.alias] !== undefined ? t('ide.memory.secret.hide') : t('ide.memory.secret.reveal')}
              </Button>
            ) : null}
            <Popconfirm focusLock title={t('ide.memory.secret.deleteConfirm')} onOk={() => void remove(item)}>
              <Button
                size='mini'
                status='danger'
                icon={<Delete theme='outline' size={13} />}
                aria-label={t('ide.memory.secret.delete')}
              />
            </Popconfirm>
          </div>
        ))}
      </div>
      <div className='shrink-0 flex items-center justify-between gap-8px border-t border-t-1 pt-8px'>
        <span className='text-11px text-t-tertiary leading-relaxed'>{t('ide.memory.secret.usage')}</span>
        <Button size='small' icon={<Refresh theme='outline' size={14} />} onClick={() => void refresh()}>
          {t('ide.memory.refresh')}
        </Button>
      </div>
    </div>
  );
};

export default RepoSecretContextPanel;
