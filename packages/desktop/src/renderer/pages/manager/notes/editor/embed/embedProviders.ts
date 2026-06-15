/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Embed-provider detection for the note editor's Notion-style "embed" block.
 *
 * Given an arbitrary URL the user pastes, {@link resolveEmbed} returns an
 * {@link EmbedInfo} describing how to render it:
 *  - `kind: 'iframe'` — a trusted provider (YouTube, Spotify, Vimeo, …) with a
 *    safe official **embed** URL to load in a sandboxed iframe + a sensible
 *    aspect ratio.
 *  - `kind: 'bookmark'` — anything else: we DON'T iframe untrusted pages, we show
 *    a clickable bookmark card opened in the system browser instead.
 *
 * Security: only an allow-list of providers is ever placed in an iframe, and the
 * iframe src is rebuilt from parsed ids (never the raw pasted URL), so a crafted
 * URL can't smuggle a different origin into the frame. Pure + renderer-safe (no
 * DOM/Node), so it is unit-testable in isolation.
 */

/** Which provider an embeddable URL belongs to (for icon/label + ratio). */
export type EmbedProvider =
  | 'youtube'
  | 'vimeo'
  | 'spotify'
  | 'soundcloud'
  | 'googlemaps'
  | 'figma'
  | 'codepen'
  | 'codesandbox'
  | 'loom'
  | 'generic';

/** A resolved embed: either an iframe (trusted) or a bookmark (fallback). */
export type EmbedInfo =
  | {
      kind: 'iframe';
      provider: EmbedProvider;
      /** Safe official embed URL, rebuilt from parsed ids. */
      src: string;
      /** The original page URL (for "open in browser"). */
      url: string;
      /** width / height ratio used to size the frame (e.g. 16/9). */
      ratio: number;
      /** Allow fullscreen for video providers. */
      allowFullScreen: boolean;
    }
  | {
      kind: 'bookmark';
      provider: 'generic';
      url: string;
    };

const VIDEO_RATIO = 16 / 9;

/** Parse a URL string, returning `null` when it isn't a valid http(s) URL. */
const parse = (raw: string): URL | null => {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
};

/** Strip a leading `www.` so host checks are simple. */
const host = (u: URL): string => u.hostname.replace(/^www\./, '').toLowerCase();

const iframe = (
  provider: EmbedProvider,
  src: string,
  url: string,
  ratio = VIDEO_RATIO,
  allowFullScreen = true
): EmbedInfo => ({ kind: 'iframe', provider, src, url, ratio, allowFullScreen });

const bookmark = (url: string): EmbedInfo => ({ kind: 'bookmark', provider: 'generic', url });

/** YouTube: watch / youtu.be / shorts / embed → official embed. */
const youtube = (u: URL): EmbedInfo | null => {
  let id = '';
  const h = host(u);
  if (h === 'youtu.be') id = u.pathname.slice(1);
  else if (u.pathname.startsWith('/watch')) id = u.searchParams.get('v') ?? '';
  else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] ?? '';
  else if (u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2] ?? '';
  id = id.split('?')[0];
  if (!/^[\w-]{6,}$/.test(id)) return null;
  return iframe('youtube', `https://www.youtube-nocookie.com/embed/${id}`, u.href);
};

/** Vimeo: vimeo.com/<id> → player.vimeo.com/video/<id>. */
const vimeo = (u: URL): EmbedInfo | null => {
  const id = u.pathname.split('/').filter(Boolean)[0] ?? '';
  if (!/^\d{6,}$/.test(id)) return null;
  return iframe('vimeo', `https://player.vimeo.com/video/${id}`, u.href);
};

/** Spotify: open.spotify.com/<type>/<id> → /embed/<type>/<id>. */
const spotify = (u: URL): EmbedInfo | null => {
  const parts = u.pathname.split('/').filter(Boolean);
  // Handle locale prefix like /intl-vi/track/<id>.
  const typeIdx = parts.findIndex((p) => ['track', 'album', 'playlist', 'artist', 'show', 'episode'].includes(p));
  if (typeIdx === -1 || !parts[typeIdx + 1]) return null;
  const type = parts[typeIdx];
  const id = parts[typeIdx + 1].split('?')[0];
  if (!/^[\w]+$/.test(id)) return null;
  // Compact players for music; tracks ~152px, others taller — caller uses ratio.
  const ratio = type === 'track' || type === 'episode' ? 4 / 1 : 3 / 4;
  return iframe('spotify', `https://open.spotify.com/embed/${type}/${id}`, u.href, ratio, false);
};

/** SoundCloud: use the official player with the page URL as `url` param. */
const soundcloud = (u: URL): EmbedInfo => {
  const src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(u.href)}&color=%23ff5500&visual=false`;
  return iframe('soundcloud', src, u.href, 5 / 1, false);
};

/** Loom: loom.com/share/<id> → loom.com/embed/<id>. */
const loom = (u: URL): EmbedInfo | null => {
  const parts = u.pathname.split('/').filter(Boolean);
  const id = parts[1] ?? '';
  if (parts[0] !== 'share' || !/^[\w-]{8,}$/.test(id)) return null;
  return iframe('loom', `https://www.loom.com/embed/${id}`, u.href);
};

/** CodePen: codepen.io/<user>/pen/<id> → /embed/<id>. */
const codepen = (u: URL): EmbedInfo | null => {
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'pen' || !parts[2]) return null;
  const src = `https://codepen.io/${parts[0]}/embed/${parts[2]}?default-tab=result`;
  return iframe('codepen', src, u.href, 4 / 3, true);
};

/** CodeSandbox: sandbox/<id> → /embed/<id>. */
const codesandbox = (u: URL): EmbedInfo | null => {
  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('s');
  const seg = idx >= 0 ? parts[idx + 1] : parts[parts.indexOf('embed') + 1];
  const id = (seg ?? '').split('?')[0];
  if (!id) return null;
  return iframe('codesandbox', `https://codesandbox.io/embed/${id}`, u.href, 4 / 3, true);
};

/** Figma: official embed endpoint wraps the file/proto URL. */
const figma = (u: URL): EmbedInfo => {
  const src = `https://www.figma.com/embed?embed_host=aionui&url=${encodeURIComponent(u.href)}`;
  return iframe('figma', src, u.href, 16 / 10, true);
};

/** Google Maps: place/dir links → the keyless `output=embed` map. */
const googlemaps = (u: URL): EmbedInfo => {
  // The keyless embed accepts the same query via `output=embed`.
  const src = `https://maps.google.com/maps?output=embed&q=${encodeURIComponent(u.href)}`;
  return iframe('googlemaps', src, u.href, 16 / 10, false);
};

/**
 * Resolve a pasted URL into render instructions. Unknown/invalid URLs become a
 * bookmark card (never iframed). Trusted providers get a rebuilt embed src.
 */
export const resolveEmbed = (raw: string): EmbedInfo => {
  const u = parse(raw);
  if (!u) return bookmark(raw.trim());
  const h = host(u);

  if (h === 'youtube.com' || h === 'youtu.be' || h === 'youtube-nocookie.com') return youtube(u) ?? bookmark(u.href);
  if (h === 'vimeo.com' || h === 'player.vimeo.com') return vimeo(u) ?? bookmark(u.href);
  if (h === 'spotify.com' || h === 'open.spotify.com') return spotify(u) ?? bookmark(u.href);
  if (h === 'soundcloud.com') return soundcloud(u);
  if (h === 'loom.com') return loom(u) ?? bookmark(u.href);
  if (h === 'codepen.io') return codepen(u) ?? bookmark(u.href);
  if (h === 'codesandbox.io') return codesandbox(u) ?? bookmark(u.href);
  if (h === 'figma.com') return figma(u);
  if (h === 'google.com' && u.pathname.startsWith('/maps')) return googlemaps(u);
  if (h === 'maps.google.com') return googlemaps(u);

  return bookmark(u.href);
};

/** Whether a URL is something we can embed as an iframe (vs. only bookmark). */
export const isEmbeddable = (raw: string): boolean => resolveEmbed(raw).kind === 'iframe';

/** i18n key suffix for a provider label (under `manager.notes.embed.provider.*`). */
export const providerLabelKey = (provider: EmbedProvider): string => `manager.notes.embed.provider.${provider}`;
