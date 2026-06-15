/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Realtime bots (news + trading).
 *
 * Two bot kinds live on the two Realtime tabs and consume different data:
 *   - `news`    — watches the news/social streams, scores relevance + sentiment,
 *                 raises alerts and digests. No money involved.
 *   - `trading` — consumes market quotes (+ optional news sentiment), runs a
 *                 risk-managed strategy, and executes orders. **Paper** mode is
 *                 the default and uses live prices with simulated cash; **live**
 *                 mode requires explicit opt-in + user-supplied exchange creds
 *                 and is hard-gated by the risk manager and a kill switch.
 *
 * Everything here is plain data (no Node/DOM) so it can be shared by the
 * Main-process engine and (as types) the renderer.
 */

// ---------------------------------------------------------------------------
// Market primitives
// ---------------------------------------------------------------------------

/** A daily/interval OHLC bar used for backtesting + indicators. */
export type OHLCBar = {
  /** Epoch ms of the bar open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** A strategy decision for one symbol at one point in time. */
export type Signal = {
  action: 'buy' | 'sell' | 'hold';
  /** Conviction in [0, 1]; drives position sizing. */
  strength: number;
  /** Human-readable rationale (shown in the trade log for transparency). */
  reason: string;
};

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export type StrategyId = 'sma_crossover' | 'rsi_reversion' | 'breakout' | 'news_sentiment' | 'ensemble';

/** Tunable parameters for the built-in strategies (all optional; sane defaults). */
export type StrategyParams = {
  /** SMA crossover: fast/slow window lengths. */
  fastPeriod?: number;
  slowPeriod?: number;
  /** RSI reversion: period + oversold/overbought thresholds. */
  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  /** Breakout: lookback window for the high/low channel. */
  breakoutPeriod?: number;
  /** News sentiment: minimum |score| to act on. */
  sentimentThreshold?: number;
  /** Ensemble: minimum net agreement in [0,1] to act. */
  ensembleThreshold?: number;
};

/** Extra, non-price context a strategy may use (e.g. news sentiment per symbol). */
export type StrategyContext = {
  /** Aggregate news sentiment for the symbol in [-1, 1], if available. */
  newsSentiment?: number;
};

// ---------------------------------------------------------------------------
// Risk management
// ---------------------------------------------------------------------------

/**
 * Hard risk limits enforced by the engine on EVERY order — the real source of
 * "production-grade" behaviour. Percentages are fractions of equity (0.1 = 10%).
 */
export type RiskLimits = {
  /** Max fraction of equity in a single position. */
  maxPositionPct: number;
  /** Per-position stop-loss (fraction below entry). 0 disables. */
  stopLossPct: number;
  /** Per-position take-profit (fraction above entry). 0 disables. */
  takeProfitPct: number;
  /** Halt new buys for the day once realized+unrealized loss hits this fraction. */
  dailyLossLimitPct: number;
  /** Max number of simultaneously open positions. */
  maxOpenPositions: number;
  /** Max executed trades per UTC day (anti-overtrading). */
  maxTradesPerDay: number;
};

export const defaultRiskLimits = (): RiskLimits => ({
  maxPositionPct: 0.1,
  stopLossPct: 0.05,
  takeProfitPct: 0.12,
  dailyLossLimitPct: 0.05,
  maxOpenPositions: 5,
  maxTradesPerDay: 10,
});

// ---------------------------------------------------------------------------
// Portfolio + execution
// ---------------------------------------------------------------------------

export type OrderSide = 'buy' | 'sell';

/** An executed fill. */
export type Trade = {
  id: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  time: number;
  /** Realized PnL booked by this fill (sells only); 0 for buys. */
  realizedPnl: number;
  reason: string;
  mode: TradingMode;
};

/** An open position. */
export type Position = {
  symbol: string;
  qty: number;
  avgPrice: number;
  openedAt: number;
};

/** The bot's portfolio snapshot. */
export type Portfolio = {
  startingCash: number;
  cash: number;
  positions: Position[];
  realizedPnl: number;
  /** Highest equity seen (for drawdown). */
  peakEquity: number;
  trades: Trade[];
};

export const emptyPortfolio = (startingCash: number): Portfolio => ({
  startingCash,
  cash: startingCash,
  positions: [],
  realizedPnl: 0,
  peakEquity: startingCash,
  trades: [],
});

export type TradingMode = 'paper' | 'live';

// ---------------------------------------------------------------------------
// Bot config + state
// ---------------------------------------------------------------------------

export type BotKind = 'news' | 'trading';

export type TradingBotConfig = {
  id: string;
  kind: 'trading';
  enabled: boolean;
  mode: TradingMode;
  /** Tickers to trade (must exist in the market watchlist). */
  symbols: string[];
  strategy: StrategyId;
  params: StrategyParams;
  risk: RiskLimits;
  /** Decision cadence in seconds. */
  intervalSec: number;
  /** Paper starting cash (USD). */
  startingCash: number;
  /** Live-trading is only attempted when BOTH enabled and this explicit flag are set. */
  liveArmed: boolean;
};

export type NewsBotConfig = {
  id: string;
  kind: 'news';
  enabled: boolean;
  /** Lower-cased keywords/topics to watch. Empty = all. */
  watchKeywords: string[];
  /** Min |sentiment| (0..1) or trend strength to raise an alert. */
  alertThreshold: number;
  /** Max alerts kept. */
  maxAlerts: number;
};

export type BotConfig = TradingBotConfig | NewsBotConfig;

/** A news-bot alert. */
export type NewsAlert = {
  id: string;
  time: number;
  title: string;
  link: string;
  /** Sentiment in [-1, 1]. */
  sentiment: number;
  /** Distinct sources covering the story (trend strength). */
  sourceCount: number;
  matchedKeywords: string[];
};

/** Live trading-bot runtime state (persisted + pushed to the renderer). */
export type TradingBotState = {
  config: TradingBotConfig;
  portfolio: Portfolio;
  /** Current equity = cash + mark-to-market positions. */
  equity: number;
  /** Realized + unrealized PnL vs starting cash, as a fraction. */
  returnPct: number;
  /** Peak-to-trough drawdown, as a fraction. */
  drawdownPct: number;
  /** Set when the kill switch / daily loss limit halted trading. */
  haltedReason: string | null;
  lastTickAt: number | null;
  lastSignals: Record<string, Signal>;
};

export type NewsBotState = {
  config: NewsBotConfig;
  alerts: NewsAlert[];
  lastTickAt: number | null;
};

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------

export type BacktestResult = {
  symbol: string;
  strategy: StrategyId;
  startingCash: number;
  finalEquity: number;
  totalReturnPct: number;
  /** Buy-and-hold return over the same window, for honest comparison. */
  buyHoldReturnPct: number;
  maxDrawdownPct: number;
  winRate: number;
  numTrades: number;
  /** Annualised Sharpe-like ratio (daily bars). */
  sharpe: number;
  /** Equity sampled per bar (for charting). */
  equityCurve: Array<{ time: number; equity: number }>;
};
