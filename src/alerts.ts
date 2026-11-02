import { stamp, type Stock, type Trade, type Notice } from "./model";
export function evaluate(
  symbol: string,
  stock: Stock,
  trade: Trade,
  now: number,
  session: string,
): Notice[] {
  const time = Date.parse(trade.t);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(trade.p) ||
    trade.p <= 0 ||
    time > now + 5000 ||
    now - time > 120_000
  )
    throw new Error("Missing or stale trade.");
  stock.lastCheck = now;
  const previous = stock.previous;
  if (previous && time <= Date.parse(previous.t)) return [];
  stock.previous = trade;
  if (
    !previous ||
    stock.baselineSession !== session ||
    time - Date.parse(previous.t) > 120_000
  ) {
    stock.baselineSession = session;
    stock.events = {};
    return [];
  }
  const output: Notice[] = [];
  for (const zone of stock.zones) {
    const prefix = zone.id;
    const entryKey = `${prefix}:entry`,
      breakKey = `${prefix}:break`;
    const entry = (stock.events[entryKey] ??= { armed: true });
    const brk = (stock.events[breakKey] ??= { armed: true });
    if (trade.p < zone.low * 0.998 || trade.p > zone.high * 1.002)
      entry.armed = true;
    if (
      zone.side === "support"
        ? trade.p >= zone.low * 1.002
        : trade.p <= zone.high * 0.998
    )
      brk.armed = true;
    const breaks =
      zone.side === "support"
        ? previous.p >= zone.low && trade.p < zone.low
        : previous.p <= zone.high && trade.p > zone.high;
    const enters =
      trade.p >= zone.low &&
      trade.p <= zone.high &&
      (previous.p < zone.low || previous.p > zone.high);
    const state = breaks ? brk : entry;
    if (
      !(breaks || enters) ||
      !state.armed ||
      (state.last !== undefined && now - state.last < 30 * 60_000)
    )
      continue;
    state.armed = false;
    state.last = now;
    const event = breaks
      ? zone.side === "support"
        ? "BREAKDOWN"
        : "BREAKOUT"
      : `${zone.side.toUpperCase()} ZONE ENTRY`;
    output.push({
      id: `${symbol}:${stock.generation}:${zone.id}:${event}:${trade.t}`,
      symbol,
      generation: stock.generation,
      kind: "price",
      body: `${symbol} — ${event}\nPrice: $${trade.p.toFixed(4)}\n${zone.side}: $${zone.low.toFixed(4)}–$${zone.high.toFixed(4)} (${stock.mode})\nTrade: ${stamp(time)}\nLive source: IEX; partial US market coverage.\nSampled-price heads-up, not a confirmed trading signal.`,
    });
  }
  return output;
}
