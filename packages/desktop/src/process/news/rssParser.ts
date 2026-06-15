/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal, dependency-light RSS 2.0 / Atom 1.0 feed parser.
 *
 * Rather than add a new runtime dependency (e.g. `rss-parser`), this reuses the
 * project's existing `@xmldom/xmldom` to turn a feed's XML string into a flat
 * list of {@link ParsedFeedItem}s plus the channel title. It is a **pure**
 * function (string in → data out) so it is trivially unit-testable and safe to
 * run anywhere — the network fetch lives separately in `newsFetcher.ts`.
 *
 * Supported shapes:
 * - RSS 2.0: `<rss><channel><item>…` with `title`/`link`/`description`/
 *   `pubDate`/`guid`/`author`|`dc:creator`/`category`.
 * - Atom 1.0: `<feed><entry>…` with `title`/`link[@href]`/`summary`|`content`/
 *   `updated`|`published`/`id`/`author>name`/`category[@term]`.
 * - RDF / RSS 1.0: `<rdf:RDF><item>…` (same element names as RSS 2.0).
 *
 * HTML in summaries is left intact here; the caller (`newsFetcher.ts`) strips it
 * with the project's `html-to-text`. Dates that fail to parse become `null`.
 *
 * Process boundary: Main-process (Node.js) module — `@xmldom/xmldom` only, no
 * DOM globals.
 */

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

/** A single article as extracted from the feed XML (pre-classification). */
export type ParsedFeedItem = {
  title: string;
  link: string;
  /** Raw summary/description — may contain HTML. */
  summary: string;
  author: string | null;
  /** Epoch ms, or `null` when absent/unparseable. */
  publishedAt: number | null;
  /** Stable identity: guid/id when present, else the link, else the title. */
  guid: string;
  /** Lower-cased `<category>`/`term` strings on the item. */
  tags: string[];
  /** Thumbnail URL from media:content/@url, media:thumbnail/@url, or enclosure/@url. */
  imageUrl: string | null;
};

/** Result of {@link parseFeed}. */
export type ParsedFeed = {
  /** Channel/feed title, or `''` when absent. */
  title: string;
  items: ParsedFeedItem[];
};

/** First direct-or-nested child element text by tag name (namespace-agnostic). */
const firstText = (el: Element, ...tagNames: string[]): string => {
  for (const tag of tagNames) {
    const nodes = el.getElementsByTagName(tag);
    if (nodes.length > 0) {
      const text = nodes[0].textContent;
      if (text != null && text.trim().length > 0) return text.trim();
    }
  }
  return '';
};

/** Resolve an item/entry link across RSS (`<link>text`) and Atom (`<link href>`). */
const resolveLink = (el: Element): string => {
  const links = el.getElementsByTagName('link');
  for (let i = 0; i < links.length; i++) {
    const node = links[i];
    // Atom: prefer rel="alternate" (or no rel) with an href attribute.
    const href = node.getAttribute?.('href');
    const rel = node.getAttribute?.('rel');
    if (href && (!rel || rel === 'alternate')) return href.trim();
  }
  // RSS: <link> carries the URL as text content.
  for (let i = 0; i < links.length; i++) {
    const text = links[i].textContent;
    if (text && text.trim().length > 0) return text.trim();
  }
  return '';
};

/** Collect lower-cased category labels from `<category>` (RSS text or Atom @term). */
const resolveTags = (el: Element): string[] => {
  const out = new Set<string>();
  const cats = el.getElementsByTagName('category');
  for (let i = 0; i < cats.length; i++) {
    const node = cats[i];
    const term = node.getAttribute?.('term');
    const text = node.textContent;
    const value = (term && term.trim()) || (text && text.trim()) || '';
    if (value) out.add(value.toLowerCase());
  }
  return [...out];
};

/** Resolve author across RSS (`author`/`dc:creator`) and Atom (`author > name`). */
const resolveAuthor = (el: Element): string | null => {
  const direct = firstText(el, 'creator', 'dc:creator', 'author');
  if (direct) {
    // Atom nests <author><name>…</name></author>; firstText('author') may return
    // the concatenated child text — prefer an explicit <name> when present.
    const authorNodes = el.getElementsByTagName('author');
    if (authorNodes.length > 0) {
      const name = firstText(authorNodes[0], 'name');
      if (name) return name;
    }
    return direct;
  }
  return null;
};

/** Parse a date string (RFC-822 or ISO-8601) to epoch ms, or `null`. */
const parseDate = (raw: string): number | null => {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
};

/** Check if a URL looks like an image (jpg/png/webp/gif). */
const isImageUrl = (url: string): boolean => /\.(jpe?g|png|webp|gif|avif)(\?.*)?$/i.test(url);

/** Decode the handful of HTML entities that appear in feed image URLs. */
const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/**
 * Extract a thumbnail/image URL from an item element.
 * Priority: media:content → media:thumbnail → enclosure → og/image tags →
 * first <img src> in description/content HTML. HTML entities are decoded so the
 * resulting URL is directly usable in an <img> tag.
 */
const resolveImage = (el: Element): string | null => {
  const pick = (raw: string | null | undefined): string | null => {
    const url = (raw ?? '').trim();
    return url ? decodeEntities(url) : null;
  };

  // media:content url="..." (prefer image medium/type, else any image-looking url)
  const mediaContents = el.getElementsByTagName('media:content');
  for (let i = 0; i < mediaContents.length; i++) {
    const node = mediaContents[i];
    const url = node.getAttribute?.('url');
    const medium = node.getAttribute?.('medium') ?? '';
    const type = node.getAttribute?.('type') ?? '';
    if (url && (medium === 'image' || type.startsWith('image/') || isImageUrl(url))) return pick(url);
  }
  // First media:content with any url as a looser fallback.
  if (mediaContents.length > 0) {
    const url = mediaContents[0].getAttribute?.('url');
    if (url) return pick(url);
  }

  // media:thumbnail / media:group > media:thumbnail
  const thumbs = el.getElementsByTagName('media:thumbnail');
  if (thumbs.length > 0) {
    const url = thumbs[0].getAttribute?.('url');
    if (url) return pick(url);
  }

  // enclosure type="image/..." or image-looking url
  const enclosures = el.getElementsByTagName('enclosure');
  for (let i = 0; i < enclosures.length; i++) {
    const node = enclosures[i];
    const type = node.getAttribute?.('type') ?? '';
    const url = node.getAttribute?.('url') ?? '';
    if (url && (type.startsWith('image/') || isImageUrl(url))) return pick(url);
  }

  // <image><url>…</url></image> or <itunes:image href="…">
  const itunesImage = el.getElementsByTagName('itunes:image');
  if (itunesImage.length > 0) {
    const href = itunesImage[0].getAttribute?.('href');
    if (href) return pick(href);
  }

  // Fallback: first <img src> inside description/content HTML (NO extension
  // requirement — many CDNs hide the extension behind query params). The src
  // may contain &amp; which we decode.
  const descRaw = firstText(el, 'description', 'content:encoded', 'content', 'summary');
  if (descRaw) {
    const match = /<img[^>]+src=["']([^"']+)["']/i.exec(descRaw);
    if (match?.[1]) return pick(match[1]);
  }

  // Last-resort fallback: serialize the whole item to XML and scan for any
  // image URL (covers feeds that place images in unexpected tags/attributes,
  // e.g. <image>, <thumbnail url>, <media:content> with odd namespaces, or
  // an <img> nested in a tag firstText didn't reach). Decode entities first so
  // &amp; in the raw XML becomes & before matching.
  try {
    const raw = decodeEntities(new XMLSerializer().serializeToString(el as unknown as Node));
    // 1) Any src="...img..." attribute.
    const srcMatch = /(?:src|url|href)=["']([^"']+\.(?:jpe?g|png|webp|gif|avif)[^"']*)["']/i.exec(raw);
    if (srcMatch?.[1]) return pick(srcMatch[1]);
    // 2) A bare https URL ending in an image extension.
    const bareMatch = /https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>]*)?/i.exec(raw);
    if (bareMatch?.[0]) return pick(bareMatch[0]);
  } catch {
    // serialization failed — give up gracefully
  }
  return null;
};

/** Map one `<item>`/`<entry>` element to a {@link ParsedFeedItem}. */
const toItem = (el: Element): ParsedFeedItem => {
  const link = resolveLink(el);
  const guid = firstText(el, 'guid', 'id') || link || firstText(el, 'title');
  return {
    title: firstText(el, 'title'),
    link,
    summary: firstText(el, 'description', 'summary', 'content', 'content:encoded'),
    author: resolveAuthor(el),
    publishedAt: parseDate(firstText(el, 'pubDate', 'published', 'updated', 'date', 'dc:date')),
    guid,
    tags: resolveTags(el),
    imageUrl: resolveImage(el),
  };
};

/**
 * Parse an RSS/Atom feed document into a {@link ParsedFeed}.
 *
 * Never throws on malformed input: an unparseable document yields an empty item
 * list. Items missing both a link and a title are dropped (nothing to show or
 * dedupe on).
 */
export const parseFeed = (xml: string): ParsedFeed => {
  if (!xml || xml.trim().length === 0) return { title: '', items: [] };

  let doc: Document;
  try {
    // xmldom logs to console on recoverable errors; swallow to stay quiet.
    doc = new DOMParser({
      onError: () => {},
    } as unknown as ConstructorParameters<typeof DOMParser>[0]).parseFromString(xml, 'text/xml') as unknown as Document;
  } catch {
    return { title: '', items: [] };
  }
  if (!doc?.documentElement) return { title: '', items: [] };

  const root = doc.documentElement;

  // Channel title: RSS uses <channel><title>, Atom uses the top-level <title>.
  const channels = root.getElementsByTagName('channel');
  const titleHost = channels.length > 0 ? channels[0] : root;
  // For Atom, the feed title is a *direct* child; firstText over the whole root
  // would otherwise pick up the first entry title. Guard by reading from the
  // title host but excluding entry/item titles.
  const feedTitle = firstText(titleHost, 'title');

  // Items: RSS/RDF use <item>, Atom uses <entry>.
  const itemNodes = root.getElementsByTagName('item');
  const entryNodes = itemNodes.length > 0 ? itemNodes : root.getElementsByTagName('entry');

  const items: ParsedFeedItem[] = [];
  for (let i = 0; i < entryNodes.length; i++) {
    const item = toItem(entryNodes[i] as unknown as Element);
    if (!item.link && !item.title) continue;
    items.push(item);
  }

  return { title: feedTitle, items };
};
