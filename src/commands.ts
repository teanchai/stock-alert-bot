import { blankStock, reset, stamp, type State, type Zone } from "./model";
import { ALGORITHM_VERSION } from "./levels";
import { rsiText } from "./rsi";
export const HELP = `Stock Alert Bot — daily support/resistance & RSI

Watchlist (up to 20 stocks)
/add AMD — add a stock and queue daily calculation
/remove AMD — remove a stock
/list — show all stocks, monitoring status and RSI

Levels & RSI
/levels AMD — show support/resistance, pivot dates and RSI
/rsi AMD — show daily Wilder RSI(14) and its data date
/auto AMD — restore automatic levels and queue a refresh
/setlevels AMD support=99-101,94-96 resistance=110-112
Manual zones replace all automatic zones; maximum two per side. Use none for an empty side. RSI still updates in manual mode.

Monitoring
/pause AMD — pause price alerts for one stock
/resume AMD — resume price alerts for one stock
/pause all — pause all price alerts
/resume all — clear global pause; individually paused stocks stay paused
/status — show operating mode, data health and delivery backlog
/help — show this guide

Replace AMD with your stock symbol.
Daily updates: one combined watchlist summary after all stocks have been processed, including any failures. Processing starts at 07:00 New York (18:00 Bangkok during US daylight saving, otherwise 19:00), one stock per minute. Later refreshes do not send another summary for the same historical session; use /levels or /rsi to check them.
Levels and RSI use completed split-adjusted daily SIP bars, not live intraday candles. Price alerts use IEX trades checked each minute during regular US sessions; brief touches between polls may be missed. RSI is informational and does not trigger alerts. Not trading advice.`;
export function symbolOf(raw: string | undefined) {
  const symbol = (raw ?? "").toUpperCase();
  if (
    !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ||
    ["__PROTO__", "CONSTRUCTOR", "PROTOTYPE"].includes(symbol)
  )
    throw new Error("Provide a valid US stock symbol, for example AAPL.");
  return symbol;
}
export function parseZones(text: string): Zone[] {
  const match = /^support=(\S+)\s+resistance=(\S+)$/.exec(text);
  if (!match)
    throw new Error(
      "Use: /setlevels SYMBOL support=99-101 resistance=110-112 (or none).",
    );
  const zones: Zone[] = [];
  for (const [i, side] of (["support", "resistance"] as const).entries()) {
    if (match[i + 1] === "none") continue;
    const ranges = match[i + 1].split(",");
    if (ranges.length > 2) throw new Error("Maximum two zones per side.");
    for (const range of ranges) {
      const pair = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(range);
      if (!pair) throw new Error("Zones must be positive low-high ranges.");
      const low = Number(pair[1]),
        high = Number(pair[2]);
      if (!Number.isFinite(high) || low <= 0 || high <= low || high > 1e9)
        throw new Error("Each zone requires 0 < low < high <= 1 billion.");
      zones.push({
        id: `manual:${side}:${low}:${high}`,
        side,
        low,
        high,
        dates: [],
      });
    }
  }
  const sorted = [...zones].sort((a, b) => a.low - b.low);
  if (sorted.some((z, i) => i > 0 && z.low <= sorted[i - 1].high))
    throw new Error("Zones must not overlap or touch.");
  if (!zones.length) throw new Error("Provide at least one zone.");
  return zones;
}
export function commandName(text: string) {
  return text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
}
export function applyCommand(
  state: State,
  text: string,
  now: number,
  dryRun: boolean,
): string {
  const tokens = text.trim().split(/\s+/);
  const cmd = commandName(text);
  if (cmd === "/help" || cmd === "/start") return HELP;
  if (cmd === "/list")
    return (
      Object.entries(state.stocks)
        .map(
          ([s, v]) =>
            `${s}: ${v.mode}, ${state.paused || v.paused ? "paused" : "active"}${v.refresh ? ", calculation queued" : ""}\n${rsiText(v)}`,
        )
        .join("\n") || "Watchlist is empty. Use /add SYMBOL."
    );
  if (cmd === "/status")
    return (
      `${dryRun ? "DRY RUN — price alerts are logged, not sent" : "LIVE ALERTS"}\nGlobal pause: ${state.paused}\nMarket: ${state.marketOpen === undefined ? "unknown" : state.marketOpen ? "open" : "closed"}\nLast scheduler run: ${state.lastRun ? stamp(state.lastRun) : "never"}\nLast market check: ${state.lastMarketCheck ? stamp(state.lastMarketCheck) : "never"}\n` +
      Object.entries(state.stocks)
        .map(
          ([s, v]) =>
            `${s}: last fresh check ${v.lastCheck ? stamp(v.lastCheck) : "never"}; levels ${v.session ?? "manual/not ready"}${v.error ? `; ${v.error}` : ""}${v.failureSince ? "; DATA FAILURE" : ""}`,
        )
        .join("\n")
    );
  if (
    (cmd === "/pause" || cmd === "/resume") &&
    tokens[1]?.toLowerCase() === "all"
  ) {
    state.paused = cmd === "/pause";
    for (const stock of Object.values(state.stocks)) reset(stock);
    return state.paused
      ? "All price alerts paused."
      : "Global pause cleared. Individually paused stocks remain paused; active stocks establish a new baseline.";
  }
  if (
    ![
      "/add",
      "/remove",
      "/levels",
      "/rsi",
      "/setlevels",
      "/auto",
      "/pause",
      "/resume",
    ].includes(cmd)
  )
    return HELP;
  const symbol = symbolOf(tokens[1]);
  let stock = state.stocks[symbol];
  if (cmd === "/add") {
    if (stock) return `${symbol} is already watched.`;
    if (Object.keys(state.stocks).length >= 20)
      throw new Error("Watchlist limit is 20 stocks.");
    state.stocks[symbol] = blankStock();
    return `${symbol} added. Daily levels and RSI(14) calculation queued; monitoring starts after levels are ready.`;
  }
  if (!stock) throw new Error(`${symbol} is not watched. Use /add ${symbol}.`);
  if (cmd === "/rsi") return `${symbol}\n${rsiText(stock)}`;
  if (cmd === "/remove") {
    delete state.stocks[symbol];
    return `${symbol} removed. Unsent alerts will be cancelled.`;
  }
  if (cmd === "/levels")
    return (
      `${symbol} — ${stock.mode}; ${ALGORITHM_VERSION}\nCalculated: ${stock.calculated ?? "not yet"}\nHistory through: ${stock.session ?? "n/a"}\n${stock.mode === "auto" ? "Source: historical SIP, split-adjusted daily bars" : "Source: owner-defined zones"}\n` +
      `${rsiText(stock)}\n` +
      (["support", "resistance"] as const)
        .map((side) => {
          const zones = stock.zones.filter((z) => z.side === side);
          if (!zones.length) {
            if (stock.mode === "manual") return `No ${side} zones configured.`;
            if (!stock.session) return `${side}: calculation pending.`;
            return `No ${side} zones met the criteria`;
          }
          return zones
            .map(
              (z) =>
                `${z.side}: $${z.low.toFixed(4)}–$${z.high.toFixed(4)}${z.dates.length ? `\nPivot dates: ${z.dates.join(", ")}` : ""}`,
            )
            .join("\n");
        })
        .join("\n") +
      (stock.error ? `\n${stock.error}` : "")
    );
  if (cmd === "/setlevels") {
    stock.zones = parseZones(tokens.slice(2).join(" "));
    stock.mode = "manual";
    stock.refresh = false;
    delete stock.error;
    stock.calculated = new Date(now).toISOString();
    delete stock.session;
  }
  if (cmd === "/auto") {
    stock.mode = "auto";
    stock.refresh = true;
    stock.zones = [];
    delete stock.session;
    delete stock.retryRefreshAt;
    delete stock.error;
  }
  if (cmd === "/pause" || cmd === "/resume") stock.paused = cmd === "/pause";
  reset(stock);
  return `${symbol}: ${stock.mode}, ${stock.paused ? "paused" : "active"}${stock.refresh ? ", refresh queued" : ""}. Monitoring will establish a new baseline.`;
}
