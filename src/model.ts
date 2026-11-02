export interface Env {
  DB: D1Database;
  ALPACA_KEY: string;
  ALPACA_SECRET: string;
  TELEGRAM_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_USER_ID: string;
  OWNER_CHAT_ID: string;
  DRY_RUN: string;
}
export interface Bar {
  t: string;
  h: number;
  l: number;
  c: number;
}
export interface Trade {
  t: string;
  p: number;
}
export interface Zone {
  id: string;
  side: "support" | "resistance";
  low: number;
  high: number;
  dates: string[];
}
export interface EventState {
  armed: boolean;
  last?: number;
}
export interface Stock {
  rsi?: { value: number; session: string };
  rsiError?: string;
  mode: "auto" | "manual";
  paused: boolean;
  zones: Zone[];
  generation: string;
  refresh: boolean;
  calculated?: string;
  session?: string;
  error?: string;
  retryRefreshAt?: number;
  previous?: Trade;
  baselineSession?: string;
  events: Record<string, EventState>;
  failureSince?: number;
  failureSession?: string;
  incident?: boolean;
  lastCheck?: number;
}
export interface State {
  dailyReport?: { session: string; attempted: string[]; sent: boolean };
  stocks: Record<string, Stock>;
  paused: boolean;
  lastRun?: number;
  lastMarketCheck?: number;
  marketOpen?: boolean;
  marketFailure?: number;
  marketIncident?: boolean;
  cleanupDate?: string;
}
export interface Notice {
  id: string;
  body: string;
  symbol?: string;
  generation?: string;
  kind: "price" | "command" | "system";
  expires?: number;
}
export interface Snapshot {
  revision: number;
  value: State;
}
export interface Session {
  date: string;
  open: string;
  close: string;
}
export const stamp = (now: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(now) + " Bangkok";
export function ny(now: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minute: +get("hour") * 60 + +get("minute"),
  };
}
export const blankStock = (): Stock => ({
  mode: "auto",
  paused: false,
  zones: [],
  generation: crypto.randomUUID(),
  refresh: true,
  events: {},
});
export function reset(stock: Stock) {
  delete stock.previous;
  stock.events = {};
  stock.generation = crypto.randomUUID();
}
