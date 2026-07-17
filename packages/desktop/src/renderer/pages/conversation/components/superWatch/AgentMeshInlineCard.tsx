/**
 * Compact AgentMesh supervision surface. It stays inline above the composer and
 * opens one inspection drawer instead of creating a chat panel per subagent.
 */
import { Button, Drawer, Empty, Input, Message, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Delete, Down, ListView, PauseOne, Robot, Up } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { agentMeshClient } from '@/renderer/services/agentMeshClient';
import type { AgentMeshSnapshot } from '@process/agentRuntime/agentMesh/service';
import type { AgentInspection, AgentMessage } from '@process/agentRuntime/agentMesh/mesh';
import type { AgentWorklogEntry } from '@process/agentRuntime/agentMesh/controller';

const POLL_MS = 1500;
const ACTIVE_STATUSES = new Set(['queued', 'waiting_dependency', 'starting', 'working']);

type AgentMeshInlineCardProps = { conversationId: string };

const AgentMeshInlineCard: React.FC<AgentMeshInlineCardProps> = ({ conversationId }) => {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AgentMeshSnapshot | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<AgentInspection | null>(null);
  const [worklog, setWorklog] = useState<AgentWorklogEntry[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const sessions = await agentMeshClient.sessions();
      const exact = sessions.find((id) => id === conversationId || id.startsWith(`${conversationId}:`));
      const candidates = exact ? [exact] : sessions.toReversed();
      let selected: { id: string; snapshot: AgentMeshSnapshot } | null = null;
      for (const candidate of candidates) {
        const result = await agentMeshClient.snapshot(candidate);
        if (!result.ok) continue;
        const hasLiveWork = result.data.inspections.some(
          (item) =>
            ACTIVE_STATUSES.has(item.status) || item.stuck || item.queue.some((message) => message.status === 'queued')
        );
        if (exact || hasLiveWork) {
          selected = { id: candidate, snapshot: result.data };
          break;
        }
      }
      if (!selected) {
        setSessionId(null);
        setSnapshot(null);
        return;
      }
      setSessionId(selected.id);
      setSnapshot(selected.snapshot);
      setSelectedAgentId((current) =>
        current && selected.snapshot.agents.some((agent) => agent.agentId === current)
          ? current
          : (selected.snapshot.inspections.find((item) => ACTIVE_STATUSES.has(item.status))?.agent.agentId ??
            selected.snapshot.agents[0]?.agentId ??
            null)
      );
    } catch {
      // AgentMesh is optional for a normal single-agent chat. Stay invisible when unavailable.
    }
  }, [conversationId]);

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      if (alive) await refresh();
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!drawerOpen || !sessionId || !selectedAgentId) return;
    let alive = true;
    void Promise.all([
      agentMeshClient.inspect({ sessionId, agentId: selectedAgentId }),
      agentMeshClient.worklog(sessionId, selectedAgentId),
    ]).then(([inspectResult, logResult]) => {
      if (!alive) return;
      setInspection(inspectResult.ok ? inspectResult.data : null);
      setWorklog(logResult.ok ? logResult.data : []);
    });
    return () => {
      alive = false;
    };
  }, [drawerOpen, selectedAgentId, sessionId, snapshot]);

  const leaderId = useMemo(() => snapshot?.agents.find((agent) => !agent.parentAgentId)?.agentId ?? null, [snapshot]);
  const activeCount = snapshot?.inspections.filter((item) => ACTIVE_STATUSES.has(item.status)).length ?? 0;
  const queuedCount =
    snapshot?.inspections.reduce(
      (total, item) => total + item.queue.filter((message) => message.status === 'queued').length,
      0
    ) ?? 0;
  const stuckCount = snapshot?.inspections.filter((item) => item.stuck).length ?? 0;

  const mutate = useCallback(
    async (operation: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
      setBusy(true);
      try {
        const result = await operation();
        if (!result.ok) Message.error(result.error || t('ide.agentMesh.actionFailed'));
        await refresh();
      } catch {
        Message.error(t('ide.agentMesh.actionFailed'));
      } finally {
        setBusy(false);
      }
    },
    [refresh, t]
  );

  const removeMessage = (message: AgentMessage): void => {
    if (!sessionId || !leaderId || !inspection) return;
    void mutate(() =>
      agentMeshClient.removeQueue({
        sessionId,
        actorId: leaderId,
        targetId: inspection.agent.agentId,
        messageId: message.messageId,
      })
    );
  };

  const moveMessage = (message: AgentMessage, direction: -1 | 1): void => {
    if (!sessionId || !leaderId || !inspection) return;
    const queue = inspection.queue.filter((item) => item.status === 'queued');
    const index = queue.findIndex((item) => item.messageId === message.messageId);
    if (index < 0 || index + direction < 0 || index + direction >= queue.length) return;
    const beforeMessageId = direction < 0 ? queue[index - 1]?.messageId : queue[index + 2]?.messageId;
    void mutate(() =>
      agentMeshClient.reorderQueue({
        sessionId,
        actorId: leaderId,
        targetId: inspection.agent.agentId,
        messageId: message.messageId,
        beforeMessageId,
      })
    );
  };

  const stopTask = (mode: 'graceful' | 'interrupt' | 'cancel'): void => {
    if (!sessionId || !leaderId || !inspection?.task) return;
    void mutate(() => agentMeshClient.stop({ sessionId, actorId: leaderId, taskId: inspection.task!.taskId, mode }));
  };

  if (!snapshot || snapshot.agents.length === 0) return null;

  return (
    <>
      <div
        className='mb-8px flex items-center gap-10px rd-10px border border-arco-2 bg-fill-1 px-12px py-8px shadow-sm'
        data-testid='agent-mesh-inline-card'
      >
        <span className='size-28px shrink-0 flex-center rd-8px bg-primary-light-1 text-primary'>
          <Robot theme='outline' size={16} />
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-6px'>
            <span className='truncate text-12px font-600 text-t-primary'>{t('ide.agentMesh.title')}</span>
            {stuckCount > 0 ? (
              <Tag size='small' color='red'>
                {t('ide.agentMesh.stuck', { count: stuckCount })}
              </Tag>
            ) : null}
          </div>
          <div className='truncate text-11px text-t-secondary'>
            {t('ide.agentMesh.summary', {
              agents: snapshot.agents.length,
              active: activeCount,
              queued: queuedCount,
            })}
          </div>
        </div>
        <Button
          size='mini'
          type='text'
          icon={<ListView theme='outline' size={14} />}
          onClick={() => setDrawerOpen(true)}
        >
          {t('ide.agentMesh.inspect')}
        </Button>
      </div>

      <Drawer
        width={460}
        visible={drawerOpen}
        title={t('ide.agentMesh.drawerTitle')}
        footer={null}
        onCancel={() => setDrawerOpen(false)}
        unmountOnExit
      >
        <div className='flex flex-col gap-14px'>
          <div className='flex flex-wrap gap-6px'>
            {snapshot.inspections.map((item) => (
              <Button
                key={item.agent.agentId}
                size='small'
                type={selectedAgentId === item.agent.agentId ? 'primary' : 'secondary'}
                status={item.stuck ? 'danger' : 'default'}
                onClick={() => setSelectedAgentId(item.agent.agentId)}
              >
                {item.agent.agentId}
              </Button>
            ))}
          </div>

          {!inspection ? (
            <div className='py-24px flex-center'>
              <Spin />
            </div>
          ) : (
            <>
              <section className='rd-10px border border-arco-2 bg-fill-1 p-12px'>
                <div className='flex items-start justify-between gap-12px'>
                  <div className='min-w-0'>
                    <div className='text-13px font-600 text-t-primary'>{inspection.agent.agentId}</div>
                    <div className='mt-3px text-11px text-t-secondary'>
                      {inspection.task?.objective ?? t('ide.agentMesh.idle')}
                    </div>
                  </div>
                  <Tag size='small' color={inspection.stuck ? 'red' : 'arcoblue'}>
                    {inspection.status}
                  </Tag>
                </div>
                {inspection.currentAction ? (
                  <div className='mt-10px rd-8px bg-2 px-10px py-8px'>
                    <div className='text-11px font-600 text-t-primary'>{inspection.currentAction.name}</div>
                    {inspection.currentAction.detail ? (
                      <div className='mt-2px max-h-72px overflow-y-auto whitespace-pre-wrap text-11px text-t-secondary'>
                        {inspection.currentAction.detail}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {inspection.task && ACTIVE_STATUSES.has(inspection.status) ? (
                  <div className='mt-10px flex flex-wrap gap-6px'>
                    <Button
                      size='mini'
                      loading={busy}
                      icon={<PauseOne size={13} />}
                      onClick={() => stopTask('graceful')}
                    >
                      {t('ide.agentMesh.finishStep')}
                    </Button>
                    <Button size='mini' status='warning' loading={busy} onClick={() => stopTask('interrupt')}>
                      {t('ide.agentMesh.stopNow')}
                    </Button>
                    <Button size='mini' status='danger' loading={busy} onClick={() => stopTask('cancel')}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : null}
              </section>

              <section>
                <div className='mb-6px text-12px font-600 text-t-primary'>{t('ide.agentMesh.queueTitle')}</div>
                {inspection.queue.filter((message) => message.status === 'queued').length === 0 ? (
                  <Empty description={t('ide.agentMesh.queueEmpty')} />
                ) : (
                  <div className='flex flex-col gap-6px'>
                    {inspection.queue
                      .filter((message) => message.status === 'queued')
                      .map((message, index, queue) => (
                        <div
                          key={message.messageId}
                          className='flex items-start gap-6px rd-8px border border-arco-2 p-8px'
                        >
                          <Input.TextArea
                            autoSize={{ minRows: 1, maxRows: 4 }}
                            defaultValue={message.content}
                            onBlur={(value) => {
                              if (!sessionId || !leaderId || value.target.value === message.content) return;
                              void mutate(() =>
                                agentMeshClient.updateQueue({
                                  sessionId,
                                  actorId: leaderId,
                                  targetId: inspection.agent.agentId,
                                  messageId: message.messageId,
                                  patch: { content: value.target.value },
                                })
                              );
                            }}
                          />
                          <div className='flex shrink-0 flex-col gap-2px'>
                            <Tooltip content={t('ide.agentMesh.moveUp')} mini>
                              <Button
                                type='text'
                                size='mini'
                                disabled={index === 0 || busy}
                                icon={<Up size={12} />}
                                onClick={() => moveMessage(message, -1)}
                              />
                            </Tooltip>
                            <Tooltip content={t('ide.agentMesh.moveDown')} mini>
                              <Button
                                type='text'
                                size='mini'
                                disabled={index === queue.length - 1 || busy}
                                icon={<Down size={12} />}
                                onClick={() => moveMessage(message, 1)}
                              />
                            </Tooltip>
                            <Tooltip content={t('common.delete')} mini>
                              <Button
                                type='text'
                                size='mini'
                                status='danger'
                                disabled={busy}
                                icon={<Delete size={12} />}
                                onClick={() => removeMessage(message)}
                              />
                            </Tooltip>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </section>

              <section>
                <div className='mb-6px text-12px font-600 text-t-primary'>{t('ide.agentMesh.worklogTitle')}</div>
                {worklog.length === 0 ? (
                  <Empty description={t('ide.agentMesh.worklogEmpty')} />
                ) : (
                  <div className='max-h-260px overflow-y-auto rd-8px border border-arco-2'>
                    {worklog.toReversed().map((entry) => (
                      <div key={entry.sequence} className='border-b border-b-1 px-10px py-7px last:border-b-0'>
                        <div className='flex items-center justify-between gap-8px text-10px text-t-tertiary'>
                          <span>{entry.kind}</span>
                          <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div className='mt-2px whitespace-pre-wrap text-11px text-t-secondary'>{entry.summary}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </Drawer>
    </>
  );
};

export default AgentMeshInlineCard;
