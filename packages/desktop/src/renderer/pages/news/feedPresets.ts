/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in feed presets — curated RSS/Atom URLs grouped by topic and region.
 *
 * These are public, free, no-key-required feeds from reputable outlets.
 * The user can subscribe to any of them with one click, or add their own URL.
 *
 * Process boundary: Renderer module (pure data, no Node/DOM APIs).
 */

import type { NewsCategoryId } from '@process/news/newsTypes';

export type FeedPreset = {
  /** Display name shown in the picker. */
  name: string;
  url: string;
  category: NewsCategoryId;
  /** ISO 639-1 language tag — used to group presets in the picker. */
  lang: 'vi' | 'en' | 'zh' | 'ja' | 'ko' | 'multi';
  /** Short description shown as a subtitle. */
  description?: string;
};

export type PresetGroup = {
  /** i18n key for the group label, e.g. 'news.presets.groupVi' */
  labelKey: string;
  presets: FeedPreset[];
};

// ---------------------------------------------------------------------------
// Vietnamese sources
// ---------------------------------------------------------------------------

const VI_PRESETS: FeedPreset[] = [
  // General / top news
  {
    name: 'VnExpress — Tin mới nhất',
    url: 'https://vnexpress.net/rss/tin-moi-nhat.rss',
    category: 'general',
    lang: 'vi',
  },
  { name: 'Tuổi Trẻ — Tin tức', url: 'https://tuoitre.vn/rss/tin-moi-nhat.rss', category: 'general', lang: 'vi' },
  { name: 'Thanh Niên — Tin tức', url: 'https://thanhnien.vn/rss/home.rss', category: 'general', lang: 'vi' },
  { name: 'Dân Trí — Tin tức', url: 'https://dantri.com.vn/rss/home.rss', category: 'general', lang: 'vi' },
  { name: 'Zing News — Tin tức', url: 'https://zingnews.vn/tin-tuc.rss', category: 'general', lang: 'vi' },
  { name: 'VietnamNet — Tin tức', url: 'https://vietnamnet.vn/rss/home.rss', category: 'general', lang: 'vi' },
  // Technology
  {
    name: 'VnExpress — Công nghệ',
    url: 'https://vnexpress.net/rss/khoa-hoc-cong-nghe.rss',
    category: 'technology',
    lang: 'vi',
  },
  { name: 'Tuổi Trẻ — Công nghệ', url: 'https://tuoitre.vn/rss/nhip-song-so.rss', category: 'technology', lang: 'vi' },
  { name: 'ICTNews', url: 'https://ictnews.vietnamnet.vn/rss/home.rss', category: 'technology', lang: 'vi' },
  // Business / Economy
  { name: 'VnExpress — Kinh doanh', url: 'https://vnexpress.net/rss/kinh-doanh.rss', category: 'business', lang: 'vi' },
  { name: 'Tuổi Trẻ — Kinh tế', url: 'https://tuoitre.vn/rss/kinh-te.rss', category: 'business', lang: 'vi' },
  { name: 'CafeF — Tài chính', url: 'https://cafef.vn/rss/home.rss', category: 'business', lang: 'vi' },
  { name: 'CafeF — Chứng khoán', url: 'https://cafef.vn/thi-truong-chung-khoan.rss', category: 'business', lang: 'vi' },
  { name: 'VnEconomy', url: 'https://vneconomy.vn/rss/home.rss', category: 'business', lang: 'vi' },
  // Sports
  { name: 'VnExpress — Thể thao', url: 'https://vnexpress.net/rss/the-thao.rss', category: 'sports', lang: 'vi' },
  { name: 'Tuổi Trẻ — Thể thao', url: 'https://tuoitre.vn/rss/the-thao.rss', category: 'sports', lang: 'vi' },
  { name: 'Bóng Đá — Tin tức', url: 'https://bongda.com.vn/rss/home.rss', category: 'sports', lang: 'vi' },
  // Entertainment
  {
    name: 'VnExpress — Giải trí',
    url: 'https://vnexpress.net/rss/giai-tri.rss',
    category: 'entertainment',
    lang: 'vi',
  },
  { name: 'Tuổi Trẻ — Giải trí', url: 'https://tuoitre.vn/rss/giai-tri.rss', category: 'entertainment', lang: 'vi' },
  // Health
  { name: 'VnExpress — Sức khỏe', url: 'https://vnexpress.net/rss/suc-khoe.rss', category: 'health', lang: 'vi' },
  { name: 'Tuổi Trẻ — Sức khỏe', url: 'https://tuoitre.vn/rss/suc-khoe.rss', category: 'health', lang: 'vi' },
  // World
  { name: 'VnExpress — Thế giới', url: 'https://vnexpress.net/rss/the-gioi.rss', category: 'world', lang: 'vi' },
  { name: 'Tuổi Trẻ — Thế giới', url: 'https://tuoitre.vn/rss/the-gioi.rss', category: 'world', lang: 'vi' },
];

// ---------------------------------------------------------------------------
// English sources
// ---------------------------------------------------------------------------

const EN_PRESETS: FeedPreset[] = [
  // General / World
  { name: 'BBC News — Top Stories', url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'general', lang: 'en' },
  { name: 'Reuters — Top News', url: 'https://feeds.reuters.com/reuters/topNews', category: 'general', lang: 'en' },
  { name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', category: 'general', lang: 'en' },
  { name: 'The Guardian — World', url: 'https://www.theguardian.com/world/rss', category: 'world', lang: 'en' },
  { name: 'Al Jazeera — News', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world', lang: 'en' },
  // Technology
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'technology', lang: 'en' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'technology', lang: 'en' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'technology', lang: 'en' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'technology', lang: 'en' },
  { name: 'Hacker News — Top', url: 'https://hnrss.org/frontpage', category: 'technology', lang: 'en' },
  // Business
  {
    name: 'Bloomberg — Markets',
    url: 'https://feeds.bloomberg.com/markets/news.rss',
    category: 'business',
    lang: 'en',
  },
  { name: 'Financial Times', url: 'https://www.ft.com/rss/home', category: 'business', lang: 'en' },
  { name: 'Forbes', url: 'https://www.forbes.com/real-time/feed2/', category: 'business', lang: 'en' },
  // Science
  { name: 'NASA News', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', category: 'science', lang: 'en' },
  { name: 'New Scientist', url: 'https://www.newscientist.com/feed/home/', category: 'science', lang: 'en' },
  { name: 'Science Daily', url: 'https://www.sciencedaily.com/rss/all.xml', category: 'science', lang: 'en' },
  // Health
  { name: 'WHO News', url: 'https://www.who.int/rss-feeds/news-english.xml', category: 'health', lang: 'en' },
  {
    name: 'WebMD Health',
    url: 'https://rssfeeds.webmd.com/rss/rss.aspx?RSSSource=RSS_PUBLIC',
    category: 'health',
    lang: 'en',
  },
  // Sports
  { name: 'ESPN — Top Headlines', url: 'https://www.espn.com/espn/rss/news', category: 'sports', lang: 'en' },
  { name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'sports', lang: 'en' },
  // Entertainment
  { name: 'Variety', url: 'https://variety.com/feed/', category: 'entertainment', lang: 'en' },
  { name: 'Hollywood Reporter', url: 'https://www.hollywoodreporter.com/feed/', category: 'entertainment', lang: 'en' },
  // Specialized AI / tech channels
  { name: 'Hugging Face — Blog', url: 'https://huggingface.co/blog/feed.xml', category: 'technology', lang: 'en' },
  { name: 'arXiv — cs.AI', url: 'http://export.arxiv.org/rss/cs.AI', category: 'technology', lang: 'en' },
  { name: 'arXiv — cs.LG (ML)', url: 'http://export.arxiv.org/rss/cs.LG', category: 'technology', lang: 'en' },
  { name: 'OpenAI — News', url: 'https://openai.com/news/rss.xml', category: 'technology', lang: 'en' },
  { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', category: 'technology', lang: 'en' },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', category: 'technology', lang: 'en' },
  { name: 'VentureBeat — AI', url: 'https://venturebeat.com/category/ai/feed/', category: 'technology', lang: 'en' },
  // Major countries (English editions)
  { name: 'The Hill — US Politics', url: 'https://thehill.com/feed/', category: 'politics', lang: 'en' },
  { name: 'China Daily', url: 'http://www.chinadaily.com.cn/rss/china_rss.xml', category: 'world', lang: 'en' },
  { name: 'SCMP — China', url: 'https://www.scmp.com/rss/91/feed', category: 'world', lang: 'en' },
  {
    name: 'The Hindu — National',
    url: 'https://www.thehindu.com/news/national/feeder/default.rss',
    category: 'world',
    lang: 'en',
  },
  {
    name: 'Times of India — Top',
    url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    category: 'world',
    lang: 'en',
  },
  { name: 'Yonhap — Korea (EN)', url: 'https://en.yna.co.kr/RSS/news.xml', category: 'world', lang: 'en' },
  {
    name: 'NHK World — Japan (EN)',
    url: 'https://www3.nhk.or.jp/nhkworld/en/news/rss/',
    category: 'world',
    lang: 'en',
  },
  { name: 'The Japan Times', url: 'https://www.japantimes.co.jp/feed/', category: 'world', lang: 'en' },
  { name: 'The Moscow Times', url: 'https://www.themoscowtimes.com/rss/news', category: 'world', lang: 'en' },
];

// ---------------------------------------------------------------------------
// Grouped export
// ---------------------------------------------------------------------------

export const PRESET_GROUPS: PresetGroup[] = [
  { labelKey: 'news.presets.groupVi', presets: VI_PRESETS },
  { labelKey: 'news.presets.groupEn', presets: EN_PRESETS },
];

/** Flat list of all presets (for dedup checks). */
export const ALL_PRESETS: FeedPreset[] = [...VI_PRESETS, ...EN_PRESETS];
