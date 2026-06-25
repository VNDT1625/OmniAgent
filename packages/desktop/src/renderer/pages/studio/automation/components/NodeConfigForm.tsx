/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NodeConfigForm` — the per-kind configuration editor for a single workflow
 * node. Renders only the fields a given {@link WorkflowNodeKind} needs (HTTP
 * verb/url, AI model/prompt, transform expression, delay ms, schedule cadence,
 * log label, plus the new app/cloud/email/social fields). All inputs are Arco
 * components; no raw HTML controls.
 *
 * Renderer-only; all text via i18n.
 */

import { Input, InputNumber, Select, Switch } from '@arco-design/web-react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useCredentials } from '../useCredentials';
import type { WorkflowNode } from '../automationClient';

const { TextArea, Password } = Input;

type NodeConfigFormProps = {
  node: WorkflowNode;
  onChange: (config: Record<string, unknown>) => void;
};

/** Read a string config value with a fallback. */
const str = (config: Record<string, unknown>, key: string, fallback = ''): string =>
  typeof config[key] === 'string' ? (config[key] as string) : fallback;

/** Read a numeric config value with a fallback. */
const numOf = (config: Record<string, unknown>, key: string, fallback: number): number =>
  typeof config[key] === 'number' && Number.isFinite(config[key]) ? (config[key] as number) : fallback;

/** Read a boolean config value with a fallback. */
const boolOf = (config: Record<string, unknown>, key: string, fallback: boolean): boolean =>
  typeof config[key] === 'boolean' ? (config[key] as boolean) : fallback;

const NodeConfigForm: React.FC<NodeConfigFormProps> = ({ node, onChange }) => {
  const { t } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();
  const vault = useCredentials();
  const config = node.config;

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const provider of providers) {
      for (const model of getAvailableModels(provider)) {
        if (seen.has(model)) continue;
        seen.add(model);
        options.push(model);
      }
    }
    return options;
  }, [providers, getAvailableModels]);

  const patch = (next: Record<string, unknown>): void => onChange({ ...config, ...next });

  /** A credential picker: select a stored credential to fill secret fields at run time. */
  const credentialPicker = (kinds: string[]): React.ReactNode => {
    const options = vault.credentials.filter((c) => kinds.includes(c.kind));
    return (
      <Field label={t('automation.config.credential')}>
        <Select
          value={str(config, 'credentialId') || undefined}
          onChange={(v) => patch({ credentialId: v })}
          placeholder={t('automation.config.credentialHint')}
          size='small'
          allowClear
        >
          {options.map((c) => (
            <Select.Option key={c.id} value={c.id}>
              {c.name}
            </Select.Option>
          ))}
        </Select>
      </Field>
    );
  };

  if (node.kind === 'action.http') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.method')}>
          <Select value={str(config, 'method', 'GET')} onChange={(v) => patch({ method: v })} size='small'>
            {['GET', 'POST', 'PUT', 'DELETE'].map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field label={t('automation.config.url')}>
          <Input
            value={str(config, 'url')}
            onChange={(v) => patch({ url: v })}
            placeholder='https://api.example.com/...'
            size='small'
          />
        </Field>
        <Field label={t('automation.config.body')}>
          <TextArea
            value={str(config, 'body')}
            onChange={(v) => patch({ body: v })}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t('automation.config.bodyHint')}
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.ai') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.model')}>
          <Select
            value={str(config, 'model') || undefined}
            onChange={(v) => patch({ model: v })}
            placeholder={t('automation.config.pickModel')}
            size='small'
            showSearch
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field label={t('automation.config.prompt')}>
          <TextArea
            value={str(config, 'prompt')}
            onChange={(v) => patch({ prompt: v })}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={t('automation.config.promptHint')}
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.transform') {
    return (
      <Field label={t('automation.config.expression')}>
        <TextArea
          value={str(config, 'expression', '{{input}}')}
          onChange={(v) => patch({ expression: v })}
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder={t('automation.config.expressionHint')}
        />
      </Field>
    );
  }

  if (node.kind === 'action.delay') {
    return (
      <Field label={t('automation.config.delayMs')}>
        <InputNumber
          value={numOf(config, 'ms', 1000)}
          onChange={(v) => patch({ ms: typeof v === 'number' ? v : 0 })}
          min={0}
          step={250}
          size='small'
          className='w-160px'
        />
      </Field>
    );
  }

  if (node.kind === 'trigger.schedule') {
    return (
      <Field label={t('automation.config.everyMinutes')}>
        <InputNumber
          value={numOf(config, 'everyMinutes', 60)}
          onChange={(v) => patch({ everyMinutes: typeof v === 'number' ? v : 0 })}
          min={1}
          step={5}
          size='small'
          className='w-160px'
        />
      </Field>
    );
  }

  if (node.kind === 'action.log') {
    return (
      <Field label={t('automation.config.label')}>
        <Input
          value={str(config, 'label')}
          onChange={(v) => patch({ label: v })}
          placeholder={t('automation.config.labelHint')}
          size='small'
        />
      </Field>
    );
  }

  if (node.kind === 'action.app.makeVideo') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.mvTopic')}>
          <Input
            value={str(config, 'topic')}
            onChange={(v) => patch({ topic: v })}
            placeholder={t('automation.config.mvTopicHint')}
            size='small'
          />
        </Field>
        <Field label={t('automation.config.mvStyle')}>
          <Input value={str(config, 'style', 'cinematic')} onChange={(v) => patch({ style: v })} size='small' />
        </Field>
        <Field label={t('automation.config.mvLanguage')}>
          <Input value={str(config, 'language', 'English')} onChange={(v) => patch({ language: v })} size='small' />
        </Field>
        <Field label={t('automation.config.mvScriptModel')}>
          <Select
            value={str(config, 'scriptModel') || undefined}
            onChange={(v) => patch({ scriptModel: v })}
            placeholder={t('automation.config.pickModel')}
            size='small'
            showSearch
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field label={t('automation.config.mvImageModel')}>
          <Select
            value={str(config, 'imageModel') || undefined}
            onChange={(v) => patch({ imageModel: v })}
            placeholder={t('automation.config.pickModel')}
            size='small'
            showSearch
            allowClear
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field label={t('automation.config.mvSceneCount')}>
          <InputNumber
            value={numOf(config, 'sceneCount', 4)}
            onChange={(v) => patch({ sceneCount: typeof v === 'number' ? v : 0 })}
            min={1}
            max={20}
            step={1}
            size='small'
            className='w-120px'
          />
        </Field>
        <SwitchField
          label={t('automation.config.mvRenderVideo')}
          value={boolOf(config, 'renderVideo', true)}
          onChange={(v) => patch({ renderVideo: v })}
        />
        <Field label={t('automation.config.mvSecondsPerScene')}>
          <InputNumber
            value={numOf(config, 'secondsPerScene', 3)}
            onChange={(v) => patch({ secondsPerScene: typeof v === 'number' ? v : 0 })}
            min={1}
            max={30}
            step={1}
            size='small'
            className='w-120px'
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.app.editor') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.editorPath')}>
          <Input
            value={str(config, 'path')}
            onChange={(v) => patch({ path: v })}
            placeholder='/path/to/file.txt'
            size='small'
          />
        </Field>
        <Field label={t('automation.config.editorOperation')}>
          <Select value={str(config, 'operation', 'create')} onChange={(v) => patch({ operation: v })} size='small'>
            <Select.Option value='create'>{t('automation.config.editorCreate')}</Select.Option>
            <Select.Option value='append'>{t('automation.config.editorAppend')}</Select.Option>
          </Select>
        </Field>
        <Field label={t('automation.config.editorContent')}>
          <TextArea
            value={str(config, 'content', '{{input}}')}
            onChange={(v) => patch({ content: v })}
            autoSize={{ minRows: 3, maxRows: 10 }}
            placeholder={t('automation.config.expressionHint')}
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.cloud.upload') {
    const provider = str(config, 'provider', 's3');
    return (
      <div className='flex flex-col gap-10px'>
        {credentialPicker(['s3', 'webdav'])}
        <Field label={t('automation.config.cloudProvider')}>
          <Select value={provider} onChange={(v) => patch({ provider: v })} size='small'>
            <Select.Option value='s3'>S3 / R2 / MinIO</Select.Option>
            <Select.Option value='webdav'>WebDAV (Nextcloud)</Select.Option>
          </Select>
        </Field>
        <Field label={t('automation.config.cloudDestination')}>
          <Input
            value={str(config, 'destination')}
            onChange={(v) => patch({ destination: v })}
            placeholder={t('automation.config.cloudDestinationHint')}
            size='small'
          />
        </Field>
        {provider === 's3' ? (
          <>
            <Field label={t('automation.config.cloudEndpoint')}>
              <Input
                value={str(config, 'endpoint')}
                onChange={(v) => patch({ endpoint: v })}
                placeholder='https://s3.amazonaws.com'
                size='small'
              />
            </Field>
            <Field label={t('automation.config.cloudRegion')}>
              <Input value={str(config, 'region', 'us-east-1')} onChange={(v) => patch({ region: v })} size='small' />
            </Field>
            <Field label={t('automation.config.cloudBucket')}>
              <Input value={str(config, 'bucket')} onChange={(v) => patch({ bucket: v })} size='small' />
            </Field>
            <Field label={t('automation.config.cloudAccessKey')}>
              <Input value={str(config, 'accessKeyId')} onChange={(v) => patch({ accessKeyId: v })} size='small' />
            </Field>
            <Field label={t('automation.config.cloudSecretKey')}>
              <Password
                value={str(config, 'secretAccessKey')}
                onChange={(v) => patch({ secretAccessKey: v })}
                size='small'
              />
            </Field>
            <SwitchField
              label={t('automation.config.cloudPublicRead')}
              value={boolOf(config, 'publicRead', true)}
              onChange={(v) => patch({ publicRead: v })}
            />
          </>
        ) : (
          <>
            <Field label={t('automation.config.cloudBaseUrl')}>
              <Input
                value={str(config, 'baseUrl')}
                onChange={(v) => patch({ baseUrl: v })}
                placeholder='https://nextcloud.example.com/remote.php/dav/files/user'
                size='small'
              />
            </Field>
            <Field label={t('automation.config.cloudUsername')}>
              <Input value={str(config, 'username')} onChange={(v) => patch({ username: v })} size='small' />
            </Field>
            <Field label={t('automation.config.cloudPassword')}>
              <Password value={str(config, 'password')} onChange={(v) => patch({ password: v })} size='small' />
            </Field>
          </>
        )}
      </div>
    );
  }

  if (node.kind === 'action.email.send') {
    return (
      <div className='flex flex-col gap-10px'>
        {credentialPicker(['smtp'])}
        <Field label={t('automation.config.emailHost')}>
          <Input
            value={str(config, 'host')}
            onChange={(v) => patch({ host: v })}
            placeholder='smtp.gmail.com'
            size='small'
          />
        </Field>
        <Field label={t('automation.config.emailPort')}>
          <InputNumber
            value={numOf(config, 'port', 587)}
            onChange={(v) => patch({ port: typeof v === 'number' ? v : 587 })}
            min={1}
            max={65535}
            size='small'
            className='w-120px'
          />
        </Field>
        <SwitchField
          label={t('automation.config.emailSecure')}
          value={boolOf(config, 'secure', false)}
          onChange={(v) => patch({ secure: v })}
        />
        <Field label={t('automation.config.emailUser')}>
          <Input value={str(config, 'username')} onChange={(v) => patch({ username: v })} size='small' />
        </Field>
        <Field label={t('automation.config.emailPassword')}>
          <Password value={str(config, 'password')} onChange={(v) => patch({ password: v })} size='small' />
        </Field>
        <Field label={t('automation.config.emailFrom')}>
          <Input
            value={str(config, 'from')}
            onChange={(v) => patch({ from: v })}
            placeholder='you@example.com'
            size='small'
          />
        </Field>
        <Field label={t('automation.config.emailTo')}>
          <Input
            value={str(config, 'to')}
            onChange={(v) => patch({ to: v })}
            placeholder='friend@example.com, other@example.com'
            size='small'
          />
        </Field>
        <Field label={t('automation.config.emailSubject')}>
          <Input value={str(config, 'subject')} onChange={(v) => patch({ subject: v })} size='small' />
        </Field>
        <Field label={t('automation.config.emailBody')}>
          <TextArea
            value={str(config, 'body', '{{input}}')}
            onChange={(v) => patch({ body: v })}
            autoSize={{ minRows: 3, maxRows: 10 }}
          />
        </Field>
        <SwitchField
          label={t('automation.config.attachArtifact')}
          value={boolOf(config, 'attachArtifact', true)}
          onChange={(v) => patch({ attachArtifact: v })}
        />
      </div>
    );
  }

  if (node.kind === 'action.social.facebook') {
    return (
      <div className='flex flex-col gap-10px'>
        {credentialPicker(['token', 'generic'])}
        <Field label={t('automation.config.fbPageId')}>
          <Input value={str(config, 'pageId')} onChange={(v) => patch({ pageId: v })} size='small' />
        </Field>
        <Field label={t('automation.config.fbAccessToken')}>
          <Password value={str(config, 'accessToken')} onChange={(v) => patch({ accessToken: v })} size='small' />
        </Field>
        <Field label={t('automation.config.fbMessage')}>
          <TextArea
            value={str(config, 'message', '{{input}}')}
            onChange={(v) => patch({ message: v })}
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
        </Field>
        <SwitchField
          label={t('automation.config.attachArtifact')}
          value={boolOf(config, 'attachArtifact', true)}
          onChange={(v) => patch({ attachArtifact: v })}
        />
        <Field label={t('automation.config.fbLink')}>
          <Input
            value={str(config, 'link')}
            onChange={(v) => patch({ link: v })}
            placeholder='https://...'
            size='small'
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.social.tiktok') {
    return (
      <div className='flex flex-col gap-10px'>
        {credentialPicker(['token', 'generic'])}
        <Field label={t('automation.config.ttAccessToken')}>
          <Password value={str(config, 'accessToken')} onChange={(v) => patch({ accessToken: v })} size='small' />
        </Field>
        <Field label={t('automation.config.ttCaption')}>
          <TextArea
            value={str(config, 'caption', '{{input}}')}
            onChange={(v) => patch({ caption: v })}
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
        </Field>
        <Field label={t('automation.config.ttPrivacy')}>
          <Select value={str(config, 'privacy', 'SELF_ONLY')} onChange={(v) => patch({ privacy: v })} size='small'>
            <Select.Option value='SELF_ONLY'>{t('automation.config.ttPrivacySelf')}</Select.Option>
            <Select.Option value='MUTUAL_FOLLOW_FRIENDS'>{t('automation.config.ttPrivacyFriends')}</Select.Option>
            <Select.Option value='PUBLIC_TO_EVERYONE'>{t('automation.config.ttPrivacyPublic')}</Select.Option>
          </Select>
        </Field>
        <Field label={t('automation.config.ttVideoPath')}>
          <Input
            value={str(config, 'videoPath')}
            onChange={(v) => patch({ videoPath: v })}
            placeholder={t('automation.config.ttVideoPathHint')}
            size='small'
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.company') {
    const mode = str(config, 'mode', 'goal');
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.companyMode')}>
          <Select value={mode} onChange={(v) => patch({ mode: v })} size='small'>
            <Select.Option value='create'>{t('automation.config.companyModeCreate')}</Select.Option>
            <Select.Option value='goal'>{t('automation.config.companyModeGoal')}</Select.Option>
            <Select.Option value='tasks'>{t('automation.config.companyModeTasks')}</Select.Option>
          </Select>
        </Field>
        <Field label={mode === 'create' ? t('automation.config.companyIdOptional') : t('automation.config.companyId')}>
          <Input
            value={str(config, 'companyId')}
            onChange={(v) => patch({ companyId: v })}
            placeholder={
              mode === 'create' ? t('automation.config.companyIdAutoHint') : t('automation.config.companyIdHint')
            }
            size='small'
          />
        </Field>
        {mode === 'create' ? (
          <Field label={t('automation.config.companyDescription')}>
            <TextArea
              value={str(config, 'description')}
              onChange={(v) => patch({ description: v })}
              autoSize={{ minRows: 3, maxRows: 8 }}
              placeholder={t('automation.config.companyDescriptionHint')}
            />
          </Field>
        ) : null}
        {mode === 'goal' ? (
          <Field label={t('automation.config.companyGoal')}>
            <TextArea
              value={str(config, 'goal', '{{input}}')}
              onChange={(v) => patch({ goal: v })}
              autoSize={{ minRows: 3, maxRows: 8 }}
              placeholder={t('automation.config.companyGoalHint')}
            />
          </Field>
        ) : null}
        {mode === 'tasks' ? (
          <>
            <Field label={t('automation.config.companyRoleId')}>
              <Input
                value={str(config, 'roleId')}
                onChange={(v) => patch({ roleId: v })}
                placeholder={t('automation.config.companyRoleIdHint')}
                size='small'
              />
            </Field>
            <Field label={t('automation.config.companyTask')}>
              <TextArea
                value={str(config, 'task', '{{input}}')}
                onChange={(v) => patch({ task: v })}
                autoSize={{ minRows: 3, maxRows: 8 }}
              />
            </Field>
          </>
        ) : null}
        <Field label={t('automation.config.companyModel')}>
          <Select
            value={str(config, 'model') || undefined}
            onChange={(v) => patch({ model: v })}
            placeholder={t('automation.config.pickModel')}
            size='small'
            showSearch
            allowClear
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field label={t('automation.config.companyMaxDelegations')}>
          <InputNumber
            value={numOf(config, 'maxDelegations', 4)}
            onChange={(v) => patch({ maxDelegations: typeof v === 'number' ? v : 4 })}
            min={1}
            max={20}
            step={1}
            size='small'
            className='w-120px'
          />
        </Field>
        <SwitchField
          label={t('automation.config.companyAutoApprove')}
          value={boolOf(config, 'autoApprove', true)}
          onChange={(v) => patch({ autoApprove: v })}
        />
      </div>
    );
  }

  // --- Trigger: webhook ---
  if (node.kind === 'trigger.webhook') {
    return (
      <Field label={t('automation.config.webhookPath')}>
        <Input
          value={str(config, 'path', '/my-hook')}
          onChange={(v) => patch({ path: v })}
          placeholder='/my-hook'
          size='small'
        />
      </Field>
    );
  }

  // --- Control flow ---
  if (node.kind === 'control.if' || node.kind === 'control.filter') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.condLeft')}>
          <Input value={str(config, 'left', '{{input}}')} onChange={(v) => patch({ left: v })} size='small' />
        </Field>
        <Field label={t('automation.config.condOperator')}>
          <Select value={str(config, 'operator', 'isNotEmpty')} onChange={(v) => patch({ operator: v })} size='small'>
            {(
              [
                'eq',
                'neq',
                'contains',
                'notContains',
                'startsWith',
                'endsWith',
                'gt',
                'gte',
                'lt',
                'lte',
                'isEmpty',
                'isNotEmpty',
                'isTrue',
                'isFalse',
                'regex',
              ] as const
            ).map((op) => (
              <Select.Option key={op} value={op}>
                {t(`automation.config.op.${op}`)}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field label={t('automation.config.condRight')}>
          <Input
            value={str(config, 'right', '')}
            onChange={(v) => patch({ right: v })}
            size='small'
            placeholder={t('automation.config.condRightHint')}
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'control.switch') {
    return (
      <Field label={t('automation.config.switchValue')}>
        <Input
          value={str(config, 'value', '{{input}}')}
          onChange={(v) => patch({ value: v })}
          size='small'
          placeholder='{{input}}'
        />
      </Field>
    );
  }

  if (node.kind === 'control.loop') {
    const mode = str(config, 'mode', 'forEach');
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.loopMode')}>
          <Select value={mode} onChange={(v) => patch({ mode: v })} size='small'>
            <Select.Option value='forEach'>{t('automation.config.loopForEach')}</Select.Option>
            <Select.Option value='times'>{t('automation.config.loopTimes')}</Select.Option>
          </Select>
        </Field>
        {mode === 'times' ? (
          <Field label={t('automation.config.loopCount')}>
            <InputNumber
              value={numOf(config, 'times', 1)}
              onChange={(v) => patch({ times: typeof v === 'number' ? v : 1 })}
              min={1}
              step={1}
              size='small'
              className='w-120px'
            />
          </Field>
        ) : (
          <Field label={t('automation.config.loopItemsPath')}>
            <Input
              value={str(config, 'itemsPath', '')}
              onChange={(v) => patch({ itemsPath: v })}
              placeholder={t('automation.config.loopItemsPathHint')}
              size='small'
            />
          </Field>
        )}
      </div>
    );
  }

  // --- Data nodes ---
  if (node.kind === 'action.set') {
    const fields = Array.isArray(config.fields) ? (config.fields as Array<{ key: string; value: string }>) : [];
    return (
      <div className='flex flex-col gap-10px'>
        <SwitchField
          label={t('automation.config.setKeepInput')}
          value={boolOf(config, 'keepInput', false)}
          onChange={(v) => patch({ keepInput: v })}
        />
        <span className='text-12px text-t-secondary font-[500]'>{t('automation.config.setFields')}</span>
        {fields.map((f, i) => (
          <div key={i} className='flex gap-6px items-center'>
            <Input
              value={f.key}
              onChange={(v) => {
                const next = [...fields];
                next[i] = { ...f, key: v };
                patch({ fields: next });
              }}
              placeholder='key'
              size='small'
              className='flex-1'
            />
            <Input
              value={f.value}
              onChange={(v) => {
                const next = [...fields];
                next[i] = { ...f, value: v };
                patch({ fields: next });
              }}
              placeholder='{{input}}'
              size='small'
              className='flex-1'
            />
          </div>
        ))}
        <button
          type='button'
          className='text-12px text-primary cursor-pointer bg-transparent border-none p-0 text-left'
          onClick={() => patch({ fields: [...fields, { key: '', value: '' }] })}
        >
          {t('automation.config.setAddField')}
        </button>
      </div>
    );
  }

  if (node.kind === 'action.code') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.codeTemplate')}>
          <TextArea
            value={str(config, 'template', '{{input}}')}
            onChange={(v) => patch({ template: v })}
            autoSize={{ minRows: 3, maxRows: 10 }}
          />
        </Field>
        <SwitchField
          label={t('automation.config.codeParseJson')}
          value={boolOf(config, 'parseJson', false)}
          onChange={(v) => patch({ parseJson: v })}
        />
      </div>
    );
  }

  if (node.kind === 'action.filesystem') {
    const op = str(config, 'operation', 'read');
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.fsOperation')}>
          <Select value={op} onChange={(v) => patch({ operation: v })} size='small'>
            <Select.Option value='read'>{t('automation.config.fsRead')}</Select.Option>
            <Select.Option value='write'>{t('automation.config.fsWrite')}</Select.Option>
            <Select.Option value='append'>{t('automation.config.fsAppend')}</Select.Option>
            <Select.Option value='list'>{t('automation.config.fsList')}</Select.Option>
          </Select>
        </Field>
        <Field label={t('automation.config.fsPath')}>
          <Input
            value={str(config, 'path')}
            onChange={(v) => patch({ path: v })}
            placeholder='/path/to/file'
            size='small'
          />
        </Field>
        {op === 'write' || op === 'append' ? (
          <Field label={t('automation.config.fsContent')}>
            <TextArea
              value={str(config, 'content', '{{input}}')}
              onChange={(v) => patch({ content: v })}
              autoSize={{ minRows: 2, maxRows: 8 }}
            />
          </Field>
        ) : null}
      </div>
    );
  }

  // --- App-reuse nodes ---
  if (node.kind === 'action.notify') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.notifyTitle')}>
          <Input value={str(config, 'title', 'Automation')} onChange={(v) => patch({ title: v })} size='small' />
        </Field>
        <Field label={t('automation.config.notifyBody')}>
          <TextArea
            value={str(config, 'body', '{{input}}')}
            onChange={(v) => patch({ body: v })}
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.manager') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.managerEntity')}>
          <Select value={str(config, 'entity', 'task')} onChange={(v) => patch({ entity: v })} size='small'>
            <Select.Option value='task'>{t('automation.config.managerTask')}</Select.Option>
            <Select.Option value='note'>{t('automation.config.managerNote')}</Select.Option>
            <Select.Option value='event'>{t('automation.config.managerEvent')}</Select.Option>
          </Select>
        </Field>
        <Field label={t('automation.config.managerTitle')}>
          <Input value={str(config, 'title', '{{input}}')} onChange={(v) => patch({ title: v })} size='small' />
        </Field>
        <Field label={t('automation.config.managerDetail')}>
          <TextArea
            value={str(config, 'detail', '')}
            onChange={(v) => patch({ detail: v })}
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
        </Field>
        <Field label={t('automation.config.managerAt')}>
          <Input
            value={str(config, 'at', '')}
            onChange={(v) => patch({ at: v })}
            placeholder='2026-01-01T09:00:00'
            size='small'
          />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.browser') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.browserTask')}>
          <TextArea
            value={str(config, 'task', '{{input}}')}
            onChange={(v) => patch({ task: v })}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={t('automation.config.browserTaskHint')}
          />
        </Field>
        <Field label={t('automation.config.browserUrl')}>
          <Input
            value={str(config, 'url', '')}
            onChange={(v) => patch({ url: v })}
            placeholder='https://...'
            size='small'
          />
        </Field>
        <Field label={t('automation.config.model')}>
          <Select
            value={str(config, 'model') || undefined}
            onChange={(v) => patch({ model: v })}
            placeholder={t('automation.config.pickModel')}
            size='small'
            showSearch
            allowClear
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.conversation') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.convMessage')}>
          <TextArea
            value={str(config, 'message', '{{input}}')}
            onChange={(v) => patch({ message: v })}
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
        </Field>
        <Field label={t('automation.config.model')}>
          <Select
            value={str(config, 'model') || undefined}
            onChange={(v) => patch({ model: v })}
            placeholder={t('automation.config.pickModel')}
            size='small'
            showSearch
            allowClear
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.cron') {
    return (
      <div className='flex flex-col gap-10px'>
        <Field label={t('automation.config.cronExpr')}>
          <Input
            value={str(config, 'cron', '0 9 * * *')}
            onChange={(v) => patch({ cron: v })}
            placeholder='0 9 * * *'
            size='small'
          />
        </Field>
        <Field label={t('automation.config.cronPrompt')}>
          <TextArea
            value={str(config, 'prompt', '{{input}}')}
            onChange={(v) => patch({ prompt: v })}
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
        </Field>
        <Field label={t('automation.config.cronName')}>
          <Input value={str(config, 'name', '')} onChange={(v) => patch({ name: v })} size='small' />
        </Field>
      </div>
    );
  }

  if (node.kind === 'action.subworkflow') {
    return (
      <Field label={t('automation.config.subworkflowId')}>
        <Input
          value={str(config, 'workflowId', '')}
          onChange={(v) => patch({ workflowId: v })}
          placeholder={t('automation.config.subworkflowIdHint')}
          size='small'
        />
      </Field>
    );
  }

  return <p className='m-0 text-12px text-t-tertiary'>{t('automation.config.noConfig')}</p>;
};

/** A small labelled field wrapper. */
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className='flex flex-col gap-4px'>
    <span className='text-12px text-t-secondary font-[500]'>{label}</span>
    {children}
  </label>
);

/** A horizontal label + Switch row (Arco Switch is small and inline). */
const SwitchField: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({
  label,
  value,
  onChange,
}) => (
  <label className='flex items-center justify-between gap-8px'>
    <span className='text-12px text-t-secondary font-[500]'>{label}</span>
    <Switch checked={value} onChange={onChange} size='small' />
  </label>
);

export default NodeConfigForm;
