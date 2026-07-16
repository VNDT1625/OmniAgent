/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FeedList — sidebar panel showing subscribed feeds with add/edit/remove/refresh.
 *
 * "Add feed" opens a 2-tab modal:
 *   Tab 1 — Library: curated presets grouped by language, filterable by topic.
 *            One click subscribes. Already-subscribed feeds are greyed out.
 *   Tab 2 — Custom URL: for power users who know the RSS endpoint.
 *
 * Process boundary: Renderer. No Node.js APIs.
 */

import {
  Button,
  Divider,
  Dropdown,
  Form,
  Input,
  Menu,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from '@arco-design/web-react';
import { Add, CheckOne, Delete, More, Refresh, SettingTwo } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NEWS_CATEGORY_IDS, type NewsCategoryId, type NewsFeed } from '@process/news/newsTypes';
import type { NewFeedInput } from '@process/news/newsStore';
import { ALL_PRESETS, PRESET_GROUPS, type FeedPreset } from '../feedPresets';

const { Text } = Typography;
const FormItem = Form.Item;

// ---------------------------------------------------------------------------
// Preset library tab
// ---------------------------------------------------------------------------

type LibraryTabProps = {
  subscribedUrls: Set<string>;
  onSubscribe: (preset: FeedPreset) => Promise<void>;
};

const LibraryTab: React.FC<LibraryTabProps> = ({ subscribedUrls, onSubscribe }) => {
  const { t } = useTranslation();
  const [activeLang, setActiveLang] = useState<'vi' | 'en'>('vi');
  const [activeCategory, setActiveCategory] = useState<NewsCategoryId | 'all'>('all');
  const [loading, setLoading] = useState<string | null>(null);

  const group = PRESET_GROUPS.find((g) =>
    activeLang === 'vi' ? g.labelKey.includes('Vi') : g.labelKey.includes('En')
  );

  const filtered = useMemo(() => {
    if (!group) return [];
    return activeCategory === 'all' ? group.presets : group.presets.filter((p) => p.category === activeCategory);
  }, [group, activeCategory]);

  // Category tabs that have at least one preset in the active lang group.
  const availableCategories = useMemo(() => {
    if (!group) return [];
    const seen = new Set(group.presets.map((p) => p.category));
    return NEWS_CATEGORY_IDS.filter((c) => seen.has(c));
  }, [group]);

  const handleSubscribe = async (preset: FeedPreset) => {
    if (subscribedUrls.has(preset.url)) return;
    setLoading(preset.url);
    try {
      await onSubscribe(preset);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className='flex flex-col gap-12px'>
      {/* Language toggle */}
      <Radio.Group
        type='button'
        value={activeLang}
        onChange={(v) => {
          setActiveLang(v as 'vi' | 'en');
          setActiveCategory('all');
        }}
        size='small'
      >
        <Radio value='vi'>{t('news.presets.langVi')}</Radio>
        <Radio value='en'>{t('news.presets.langEn')}</Radio>
      </Radio.Group>

      {/* Category filter */}
      <div className='flex flex-wrap gap-6px'>
        <button
          type='button'
          className={`px-10px py-3px rd-12px text-12px font-500 border-none cursor-pointer transition-colors ${
            activeCategory === 'all' ? 'bg-primary-6 text-white' : 'bg-fill-2 text-t-secondary hover:bg-fill-3'
          }`}
          onClick={() => setActiveCategory('all')}
        >
          {t('news.category.all')}
        </button>
        {availableCategories.map((cat) => (
          <button
            key={cat}
            type='button'
            className={`px-10px py-3px rd-12px text-12px font-500 border-none cursor-pointer transition-colors ${
              activeCategory === cat ? 'bg-primary-6 text-white' : 'bg-fill-2 text-t-secondary hover:bg-fill-3'
            }`}
            onClick={() => setActiveCategory(cat)}
          >
            {t(`news.category.${cat}`)}
          </button>
        ))}
      </div>

      {/* Preset list */}
      <div className='flex flex-col gap-6px max-h-320px overflow-y-auto pr-4px'>
        {filtered.map((preset) => {
          const subscribed = subscribedUrls.has(preset.url);
          const isLoading = loading === preset.url;
          return (
            <div
              key={preset.url}
              className={`flex items-center gap-10px px-12px py-10px rd-8px border border-solid transition-all ${
                subscribed
                  ? 'border-border-2 bg-fill-1 opacity-60'
                  : 'border-border-2 bg-bg-2 hover:border-primary-4 hover:bg-primary-1 cursor-pointer'
              }`}
              onClick={() => !subscribed && void handleSubscribe(preset)}
            >
              {/* Category dot */}
              <span className='shrink-0 w-8px h-8px rd-full bg-primary-5' />

              {/* Info */}
              <div className='flex-1 min-w-0'>
                <div className='text-13px font-500 text-t-primary truncate'>{preset.name}</div>
                <div className='text-11px text-t-tertiary truncate'>{preset.url}</div>
              </div>

              {/* Category tag */}
              <Tag size='small' color='arcoblue' className='shrink-0 text-11px'>
                {t(`news.category.${preset.category}`)}
              </Tag>

              {/* Status */}
              {subscribed ? (
                <CheckOne theme='filled' size='16' className='text-success shrink-0' />
              ) : (
                <Button
                  type='primary'
                  size='mini'
                  loading={isLoading}
                  className='shrink-0'
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleSubscribe(preset);
                  }}
                >
                  {t('news.presets.add')}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Custom URL tab
// ---------------------------------------------------------------------------

type CustomUrlTabProps = {
  onSave: (values: CustomFormValues) => Promise<void>;
  onValidate: (url: string) => Promise<{ ok: true; title: string } | { ok: false; error: string }>;
};

type CustomFormValues = {
  url: string;
  title?: string;
  category: NewsCategoryId | 'auto';
};

const CustomUrlTab: React.FC<CustomUrlTabProps> = ({ onSave, onValidate }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm<CustomFormValues>();
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState('');
  const [detectedTitle, setDetectedTitle] = useState('');

  const handleValidate = async () => {
    const url = form.getFieldValue('url') as string;
    if (!url) return;
    setValidating(true);
    setValidateError('');
    setDetectedTitle('');
    try {
      const result = await onValidate(url);
      if (result.ok) {
        setDetectedTitle(result.title || url);
        if (result.title && !form.getFieldValue('title')) {
          form.setFieldValue('title', result.title);
        }
      } else {
        // Root tsconfig disables strictNullChecks, so the `else` branch is not
        // narrowed to the failure member; name it explicitly to read `error`.
        setValidateError((result as { ok: false; error: string }).error);
      }
    } catch (error) {
      setValidateError(error instanceof Error ? error.message : String(error));
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validate();
      setSaving(true);
      await onSave(values);
      form.resetFields();
      setDetectedTitle('');
      setValidateError('');
    } catch {
      // validation error — stay open
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions = [
    { label: t('news.feeds.feedCategoryAuto'), value: 'auto' },
    ...NEWS_CATEGORY_IDS.filter((id) => id !== 'general').map((id) => ({
      label: t(`news.category.${id}`),
      value: id,
    })),
  ];

  return (
    <Form form={form} layout='vertical' autoComplete='off'>
      <FormItem
        field='url'
        label={t('news.feeds.url')}
        rules={[
          { required: true, message: t('news.feeds.invalidUrl') },
          {
            validator: (value, cb) => {
              try {
                const u = new URL(value as string);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') cb(t('news.feeds.invalidUrl'));
                else cb();
              } catch {
                cb(t('news.feeds.invalidUrl'));
              }
            },
          },
        ]}
        extra={
          validateError ? (
            <span className='text-danger text-12px'>{validateError}</span>
          ) : detectedTitle ? (
            <span className='text-success text-12px'>✓ {detectedTitle}</span>
          ) : null
        }
      >
        <Input.Search
          placeholder={t('news.feeds.urlPlaceholder')}
          searchButton={t('news.feeds.testUrl')}
          loading={validating}
          onSearch={() => void handleValidate()}
        />
      </FormItem>
      <FormItem field='title' label={t('news.feeds.name')}>
        <Input placeholder={t('news.feeds.namePlaceholder')} />
      </FormItem>
      <FormItem field='category' label={t('news.feeds.feedCategory')} initialValue='auto'>
        <Select options={categoryOptions} />
      </FormItem>
      <Button type='primary' long loading={saving} onClick={() => void handleSubmit()}>
        {t('news.feeds.save')}
      </Button>
    </Form>
  );
};

// ---------------------------------------------------------------------------
// Edit feed modal (separate, simpler)
// ---------------------------------------------------------------------------

type EditFeedModalProps = {
  feed: NewsFeed | null;
  onSave: (id: string, patch: Partial<Omit<NewsFeed, 'id' | 'createdAt'>>) => Promise<boolean>;
  onClose: () => void;
};

const EditFeedModal: React.FC<EditFeedModalProps> = ({ feed, onSave, onClose }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm<{ title: string; category: NewsCategoryId | 'auto'; enabled: boolean }>();
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (feed) {
      form.setFieldsValue({
        title: feed.title !== feed.url ? feed.title : '',
        category: feed.category ?? 'auto',
        enabled: feed.enabled,
      });
    }
  }, [feed, form]);

  const handleOk = async () => {
    if (!feed) return;
    try {
      const values = await form.validate();
      setSaving(true);
      await onSave(feed.id, {
        title: values.title || feed.url,
        category: values.category === 'auto' ? null : (values.category as NewsCategoryId),
        enabled: values.enabled,
      });
      onClose();
    } catch {
      // validation error
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions = [
    { label: t('news.feeds.feedCategoryAuto'), value: 'auto' },
    ...NEWS_CATEGORY_IDS.filter((id) => id !== 'general').map((id) => ({
      label: t(`news.category.${id}`),
      value: id,
    })),
  ];

  return (
    <Modal
      title={t('news.feeds.editTitle')}
      visible={Boolean(feed)}
      onOk={() => void handleOk()}
      onCancel={onClose}
      confirmLoading={saving}
      okText={t('news.feeds.save')}
      unmountOnExit
    >
      <Form form={form} layout='vertical'>
        <FormItem field='title' label={t('news.feeds.name')}>
          <Input placeholder={t('news.feeds.namePlaceholder')} />
        </FormItem>
        <FormItem field='category' label={t('news.feeds.feedCategory')}>
          <Select options={categoryOptions} />
        </FormItem>
      </Form>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Add feed modal (library + custom tabs)
// ---------------------------------------------------------------------------

type AddFeedModalProps = {
  visible: boolean;
  subscribedUrls: Set<string>;
  onSubscribePreset: (preset: FeedPreset) => Promise<void>;
  onAddCustom: (values: CustomFormValues) => Promise<void>;
  onValidate: (url: string) => Promise<{ ok: true; title: string } | { ok: false; error: string }>;
  onClose: () => void;
};

const AddFeedModal: React.FC<AddFeedModalProps> = ({
  visible,
  subscribedUrls,
  onSubscribePreset,
  onAddCustom,
  onValidate,
  onClose,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'library' | 'custom'>('library');

  return (
    <Modal
      title={t('news.feeds.addTitle')}
      visible={visible}
      onCancel={onClose}
      footer={null}
      style={{ width: 560 }}
      unmountOnExit
    >
      {/* Tab switcher */}
      <Radio.Group
        type='button'
        value={tab}
        onChange={(v) => setTab(v as 'library' | 'custom')}
        size='small'
        className='mb-16px'
      >
        <Radio value='library'>{t('news.presets.tabLibrary')}</Radio>
        <Radio value='custom'>{t('news.presets.tabCustom')}</Radio>
      </Radio.Group>

      {tab === 'library' ? (
        <LibraryTab subscribedUrls={subscribedUrls} onSubscribe={onSubscribePreset} />
      ) : (
        <CustomUrlTab onSave={onAddCustom} onValidate={onValidate} />
      )}
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Main FeedList component
// ---------------------------------------------------------------------------

type FeedListProps = {
  feeds: NewsFeed[];
  selectedFeedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (input: NewFeedInput) => Promise<boolean>;
  onUpdate: (id: string, patch: Partial<Omit<NewsFeed, 'id' | 'createdAt'>>) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onRefresh: (id: string) => Promise<boolean>;
  onValidate: (url: string) => Promise<{ ok: true; title: string } | { ok: false; error: string }>;
};

const FeedList: React.FC<FeedListProps> = ({
  feeds,
  selectedFeedId,
  onSelect,
  onAdd,
  onUpdate,
  onRemove,
  onRefresh,
  onValidate,
}) => {
  const { t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const [editFeed, setEditFeed] = useState<NewsFeed | null>(null);

  const subscribedUrls = useMemo(() => new Set(feeds.map((f) => f.url)), [feeds]);

  const handleSubscribePreset = async (preset: FeedPreset) => {
    await onAdd({
      url: preset.url,
      title: preset.name,
      category: preset.category,
      enabled: true,
      lang: preset.lang === 'multi' ? null : preset.lang,
    });
  };

  const handleAddCustom = async (values: CustomFormValues) => {
    await onAdd({
      url: values.url,
      title: values.title || undefined,
      category: values.category === 'auto' ? null : (values.category as NewsCategoryId),
      enabled: true,
    });
  };

  return (
    <div className='flex flex-col' style={{ maxHeight: 460 }}>
      {/* Header */}
      <div className='flex items-center justify-between px-14px py-10px shrink-0'>
        <Text className='text-13px font-600 text-t-secondary uppercase tracking-wider'>{t('news.feeds.title')}</Text>
        <Tooltip content={t('news.feeds.add')}>
          <Button type='text' size='small' icon={<Add theme='outline' size='14' />} onClick={() => setAddOpen(true)} />
        </Tooltip>
      </div>

      <Divider className='my-0' />

      {/* Feed items */}
      <div className='flex-1 overflow-y-auto py-4px'>
        {/* "All sources" option */}
        <div
          className={`flex items-center gap-8px px-12px py-8px mx-4px rd-6px cursor-pointer transition-colors ${
            selectedFeedId === null ? 'bg-fill-3' : 'hover:bg-fill-2'
          }`}
          onClick={() => onSelect(null)}
        >
          <span className='shrink-0 w-6px h-6px rd-full bg-primary-5' />
          <Text className='flex-1 text-13px font-500 text-t-primary'>{t('news.allSources')}</Text>
        </div>

        {feeds.length === 0 ? (
          <div className='px-16px py-24px text-center flex flex-col items-center gap-10px'>
            <Text className='text-12px text-t-tertiary'>{t('news.feeds.empty')}</Text>
            <Button
              type='primary'
              size='small'
              icon={<Add theme='outline' size='13' />}
              onClick={() => setAddOpen(true)}
            >
              {t('news.feeds.add')}
            </Button>
          </div>
        ) : (
          feeds.map((feed) => {
            const isSelected = feed.id === selectedFeedId;
            return (
              <div
                key={feed.id}
                className={`group flex items-center gap-8px px-12px py-8px mx-4px rd-6px cursor-pointer transition-colors ${
                  isSelected ? 'bg-fill-3' : 'hover:bg-fill-2'
                }`}
                onClick={() => onSelect(isSelected ? null : feed.id)}
              >
                {/* Status dot */}
                <span
                  className={`shrink-0 w-6px h-6px rd-full ${
                    feed.lastError ? 'bg-danger' : feed.enabled ? 'bg-success' : 'bg-fill-4'
                  }`}
                />

                {/* Title */}
                <div className='flex-1 min-w-0'>
                  <div className='text-13px font-500 text-t-primary truncate leading-20px'>
                    {feed.title || feed.url}
                  </div>
                  {feed.lastError && (
                    <div className='text-11px text-danger truncate leading-16px'>{feed.lastError}</div>
                  )}
                </div>

                {/* Category tag */}
                {feed.category && (
                  <Tag size='small' color='arcoblue' className='shrink-0 text-11px'>
                    {t(`news.category.${feed.category}`)}
                  </Tag>
                )}

                {/* Actions (visible on hover) */}
                <Dropdown
                  trigger='click'
                  droplist={
                    <Menu>
                      <Menu.Item key='refresh' onClick={() => void onRefresh(feed.id)}>
                        <Space size={6}>
                          <Refresh theme='outline' size='13' />
                          {t('news.feeds.refresh')}
                        </Space>
                      </Menu.Item>
                      <Menu.Item key='edit' onClick={() => setEditFeed(feed)}>
                        <Space size={6}>
                          <SettingTwo theme='outline' size='13' />
                          {t('news.feeds.editTitle')}
                        </Space>
                      </Menu.Item>
                      <Divider className='my-4px' />
                      <Popconfirm
                        title={t('news.feeds.removeConfirm')}
                        onOk={() => void onRemove(feed.id)}
                        okButtonProps={{ status: 'danger' }}
                      >
                        <Menu.Item key='remove' className='text-danger'>
                          <Space size={6}>
                            <Delete theme='outline' size='13' />
                            {t('news.feeds.remove')}
                          </Space>
                        </Menu.Item>
                      </Popconfirm>
                    </Menu>
                  }
                >
                  <Button
                    type='text'
                    size='mini'
                    className='opacity-0 group-hover:opacity-100 transition-opacity shrink-0'
                    icon={<More theme='outline' size='14' />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Dropdown>
              </div>
            );
          })
        )}
      </div>

      {/* Add modal */}
      <AddFeedModal
        visible={addOpen}
        subscribedUrls={subscribedUrls}
        onSubscribePreset={handleSubscribePreset}
        onAddCustom={handleAddCustom}
        onValidate={onValidate}
        onClose={() => setAddOpen(false)}
      />

      {/* Edit modal */}
      <EditFeedModal feed={editFeed} onSave={onUpdate} onClose={() => setEditFeed(null)} />
    </div>
  );
};

export default FeedList;
/** Alias used by the toolbar Sources dropdown. */
export { FeedList as FeedManager };
