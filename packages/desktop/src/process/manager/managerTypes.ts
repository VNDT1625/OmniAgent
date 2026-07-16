/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared data model for the Personal Manager feature (Tasks + Note + Schedule).
 *
 * These types are the single source of truth persisted to `manager-data.json`
 * in the Electron `userData` directory by {@link import('./managerStore')}. They
 * are intentionally plain serialisable shapes (no class instances, no `Date`
 * objects — timestamps are `ms` epoch numbers) so the on-disk JSON round-trips
 * cleanly and a corrupt/partial file can be loaded defensively.
 *
 * Process boundary: imported by Main-process services and the renderer (type
 * only). No runtime Node/DOM dependency lives here.
 */

// ---------------------------------------------------------------------------
// Tasks (Requirement 1)
// ---------------------------------------------------------------------------

/**
 * The kind of a task (criterion 1.3). Each kind gets its own icon/label in the
 * UI and is filterable.
 * - `oneoff`    — done once, then closed.
 * - `recurring` — repeats on a {@link RecurrenceRule}; completing the current
 *   occurrence spawns the next.
 * - `habit`     — light, fast, groupable micro-task.
 * - `milestone` — a large item with no direct action; groups subtasks.
 */
export type TaskKind = 'oneoff' | 'recurring' | 'habit' | 'milestone';

/** Visual + sorting priority of a task. */
export type Priority = 'low' | 'medium' | 'high' | 'urgent';

/** Lifecycle status of a task. */
export type TaskStatus = 'todo' | 'in_progress' | 'done';

/** How a recurring task/event repeats. */
export type RecurrenceRule = {
  freq: 'daily' | 'weekly' | 'monthly';
  /** Repeat every `interval` units (default 1). */
  interval?: number;
  /** For weekly: weekdays 0(Sun)–6(Sat) the occurrence falls on. */
  byWeekday?: number[];
};

/** A reminder attached to a task. */
export type Reminder = {
  id: string;
  /** Absolute moment (ms epoch) the notification should fire. */
  fireAt: number;
  /** When it actually fired (ms). `null`/absent means not fired yet. */
  firedAt?: number | null;
  /** Snoozed until this moment (ms); the scheduler skips it until then. */
  snoozedTo?: number | null;
};

/** A checkable child item of a task. */
export type Subtask = { id: string; title: string; done: boolean };

/** A single task (todo item). */
export type Task = {
  id: string;
  title: string;
  description?: string;
  kind: TaskKind;
  priority: Priority;
  status: TaskStatus;
  /** Deadline (ms epoch). */
  dueAt?: number | null;
  /** Estimated duration in minutes. */
  estimateMinutes?: number | null;
  tags: string[];
  subtasks: Subtask[];
  /** Set when `kind === 'recurring'`. */
  recurrence?: RecurrenceRule | null;
  reminders: Reminder[];
  createdAt: number;
  updatedAt: number;
  /** When the task was marked done (ms epoch). */
  completedAt?: number | null;
};

// ---------------------------------------------------------------------------
// Notes (Requirement 5) — three categories: daily / learn / data
// ---------------------------------------------------------------------------

/**
 * Category of a note (criterion 5.1):
 * - `daily` — day-to-day notes / journal, grouped by date.
 * - `learn` — Obsidian-style study notes with `[[wiki]]` links + AI web research.
 * - `data`  — a library entry for a study document (file path or URL) with
 *   AI-assisted summary + tagging ("smart management").
 */
export type NoteCategory = 'daily' | 'learn' | 'data';

/** A source cited by an AI web-research note (criterion 5.9). */
export type NoteSource = { title: string; url: string };

/** A free-form note (Markdown body). */
export type Note = {
  id: string;
  /** Which section the note belongs to. Defaults to `daily` for legacy notes. */
  category: NoteCategory;
  title?: string;
  /** Markdown content. */
  body: string;
  tags: string[];
  /** Optional link to a task. */
  linkedTaskId?: string | null;
  /** Optional link to a calendar event. */
  linkedEventId?: string | null;
  // --- daily ---------------------------------------------------------------
  /** Reference day (ms epoch) for `daily` notes. Defaults to createdAt. */
  dayAt?: number | null;
  // --- learn ---------------------------------------------------------------
  /** Sources cited when this note was produced by AI web research. */
  sources?: NoteSource[];
  /**
   * Optional cover banner (Notion-style) — an image/gif/video URL shown full
   * width at the top of the reading page. Renderer-only decoration.
   */
  cover?: string | null;
  /** Optional page icon/emoji shown overlapping the cover (Notion-style). */
  icon?: string | null;
  // --- data ----------------------------------------------------------------
  /** For `data` notes: a local file path the entry references. */
  filePath?: string | null;
  /** For `data` notes: a URL the entry references. */
  url?: string | null;
  createdAt: number;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Calendar / Schedule (Requirements 6, 7)
// ---------------------------------------------------------------------------

/**
 * Whether a calendar event is fixed (the AI optimiser must NOT move it) or
 * flexible (the optimiser may reschedule it). Events parsed from a school
 * timetable image default to `fixed` (criterion 6.6, 7.1).
 */
export type EventLockKind = 'fixed' | 'flexible';

/** How an event was created — useful for display and analytics. */
export type EventSource = 'manual' | 'prompt' | 'image' | 'optimizer';

/** A calendar event (time block). */
export type CalendarEvent = {
  id: string;
  title: string;
  /** Start (ms epoch). */
  startAt: number;
  /** End (ms epoch). */
  endAt: number;
  lockKind: EventLockKind;
  location?: string | null;
  /** Optional link to a task. */
  linkedTaskId?: string | null;
  note?: string | null;
  recurrence?: RecurrenceRule | null;
  source: EventSource;
  createdAt: number;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Settings + root document
// ---------------------------------------------------------------------------

/** Travel mode used when estimating commute time between located events. */
export type TravelMode = 'driving' | 'walking' | 'bicycling' | 'transit';

/** User-tunable Manager settings. */
export type ManagerSettings = {
  /** Whether the AI schedule optimiser should factor in weather (criterion 8.3). */
  weatherEnabled: boolean;
  /** Default location used for weather when an event has none. */
  defaultLocation?: string | null;
  /**
   * Whether the AI schedule optimiser should factor in travel time between
   * consecutive located events (world-class "leave time to get there" planning).
   */
  travelTimeEnabled: boolean;
  /** Preferred travel mode for commute estimates. Defaults to `driving`. */
  travelMode: TravelMode;
  /**
   * Optional Google Maps Platform API key. When present, geocoding + travel time
   * use Google (Geocoding + Distance Matrix) for accuracy; when absent the
   * provider degrades to a keyless OSM/OSRM estimate, then a straight-line
   * fallback — so the feature works without a key, just less precisely.
   */
  googleMapsApiKey?: string | null;
  /** Optional home/base location used as the trip origin for the first event of a day. */
  homeLocation?: string | null;
  /** Visual appearance customisation (Notion-style). */
  appearance?: ManagerAppearance;
};

/** Accent colour choices for the Manager UI (semantic, applied via CSS vars). */
export type AccentColor = 'blue' | 'violet' | 'green' | 'orange' | 'red' | 'pink' | 'teal';
/** Body font family choices. */
export type FontChoice = 'default' | 'serif' | 'mono' | 'rounded';
/** Layout density. */
export type Density = 'comfortable' | 'compact';

/** Notion-style appearance settings for the Manager workspace. */
export type ManagerAppearance = {
  accent: AccentColor;
  font: FontChoice;
  density: Density;
  /** Base font size in px (13–18). */
  fontSize: number;
  /** Show a soft tinted page background derived from the accent. */
  tintedBackground: boolean;
};

/** Default appearance — calm blue, system font, comfortable density. */
export const defaultManagerAppearance = (): ManagerAppearance => ({
  accent: 'blue',
  font: 'default',
  density: 'comfortable',
  fontSize: 14,
  tintedBackground: false,
});

/** A single estimated travel leg between two located events (criterion 8.3c). */
export type TravelLeg = {
  /** Origin event id (or `'home'` for the day's first leg from home). */
  fromId: string;
  /** Destination event id. */
  toId: string;
  fromLocation: string;
  toLocation: string;
  /** Estimated travel distance in metres. */
  distanceMeters: number;
  /** Estimated travel duration in seconds. */
  durationSeconds: number;
  mode: TravelMode;
  /** Which backend produced the estimate (for transparency in the UI). */
  source: 'google' | 'osrm' | 'estimate';
};

/** Current persisted-document version. Bumped on breaking shape changes. */
export const MANAGER_DATA_VERSION = 1 as const;

/** The full Manager document persisted to `manager-data.json`. */
export type ManagerData = {
  version: typeof MANAGER_DATA_VERSION;
  tasks: Task[];
  notes: Note[];
  events: CalendarEvent[];
  settings: ManagerSettings;
};

/** Default empty settings. */
export const defaultManagerSettings = (): ManagerSettings => ({
  weatherEnabled: false,
  defaultLocation: null,
  travelTimeEnabled: false,
  travelMode: 'driving',
  googleMapsApiKey: null,
  homeLocation: null,
  appearance: defaultManagerAppearance(),
});

/** A fresh, valid, empty {@link ManagerData}. Used as the defensive fallback. */
export const emptyManagerData = (): ManagerData => ({
  version: MANAGER_DATA_VERSION,
  tasks: [],
  notes: [],
  events: [],
  settings: defaultManagerSettings(),
});

// ---------------------------------------------------------------------------
// AI suggestion shapes (Requirements 2, 3, 8) — proposals, never auto-applied
// ---------------------------------------------------------------------------

/** A suggestion the "AI review tasks" action returns (criterion 3.4). */
export type TaskSuggestion = {
  /** Short human-readable suggestion (e.g. "Bump priority of X to high"). */
  message: string;
  /** Task id the suggestion refers to, when applicable. */
  taskId?: string;
  /** Suggestion category for grouping/icons. */
  kind: 'priority' | 'order' | 'merge' | 'split' | 'overdue' | 'other';
};

/** Result of an AI schedule optimisation (criterion 8.1, 8.4, 8.5). */
export type OptimizeResult = {
  /** The proposed event set. Fixed events are preserved unchanged (Property 1). */
  proposed: CalendarEvent[];
  /** Short human-readable reasons for the main changes. */
  rationale: string[];
  /** Whether weather data was actually factored in (false when degraded). */
  weatherUsed: boolean;
  /** Whether travel-time data was actually factored in (false when degraded). */
  travelUsed?: boolean;
  /** Estimated travel legs between consecutive located events (for display). */
  travelLegs?: TravelLeg[];
};

/** A proposed study note from AI web research (criterion 5.9), shown for review. */
export type ResearchResult = {
  /** Suggested note title. */
  title: string;
  /** Markdown body: summary + key points. */
  body: string;
  /** Suggested tags. */
  tags: string[];
  /** Sources used, with links. */
  sources: NoteSource[];
  /** Whether web search actually contributed (false when degraded to model-only). */
  webUsed: boolean;
};

/** A proposed summary + tags for a `data` library entry (criterion 5.13). */
export type DataInsight = {
  /** Short Markdown summary of the document. */
  summary: string;
  /** Suggested tags / classification. */
  tags: string[];
};
