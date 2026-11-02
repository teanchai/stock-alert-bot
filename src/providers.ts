import type { Env, Bar, Trade, Session } from "./model";
export class ProviderError extends Error {
  constructor(
    public status: number,
    public retryAfter = 60,
  ) {
    super(`Provider HTTP ${status}`);
  }
}
async function json<T>(url: string, env: Env): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_SECRET,
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new ProviderError(response.status);
  return (await response.json()) as T;
}
export const clock = (env: Env) =>
  json<{ is_open: boolean; timestamp: string }>(
    "https://paper-api.alpaca.markets/v2/clock",
    env,
  );
export const calendar = (env: Env, start: string, end: string) =>
  json<Session[]>(
    `https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`,
    env,
  );
export const trades = (env: Env, symbols: string[]) =>
  json<{ trades: Record<string, Trade> }>(
    `https://data.alpaca.markets/v2/stocks/trades/latest?feed=iex&symbols=${encodeURIComponent(symbols.join(","))}`,
    env,
  );
export async function validateSymbol(env: Env, symbol: string) {
  const asset = await json<{ status: string; class: string; exchange: string }>(
    `https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(symbol)}`,
    env,
  );
  if (
    asset.status !== "active" ||
    asset.class !== "us_equity" ||
    asset.exchange === "OTC"
  )
    throw new Error("Symbol must be an active listed US equity or ETF.");
}
export async function history(
  env: Env,
  symbol: string,
  endDate: string,
  now: number,
): Promise<Bar[]> {
  // Midnight UTC at the start of the next session excludes today's unfinished daily bar.
  const end = `${endDate}T00:00:00Z`;
  if (Date.parse(end) > now - 15 * 60_000)
    throw new Error("Historical SIP cutoff must be at least 15 minutes old.");
  const start = new Date(Date.parse(end) - 370 * 86400_000).toISOString();
  const result: Bar[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({
      timeframe: "1Day",
      feed: "sip",
      adjustment: "split",
      sort: "desc",
      limit: "120",
      start,
      end,
    });
    if (token) query.set("page_token", token);
    const response = await json<{
      bars: Bar[] | null;
      next_page_token?: string;
    }>(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${query}`,
      env,
    );
    result.push(...(response.bars ?? []));
    token = response.next_page_token;
    if (result.length >= 120 || !token) return result.slice(0, 120);
  }
  throw new Error("Historical pagination limit reached.");
}
