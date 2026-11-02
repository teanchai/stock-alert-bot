import type { Notice, State, Stock } from "./model";

export function dailyReady(stock: Stock, session: string): boolean {
  return (
    stock.rsi?.session === session &&
    (stock.mode === "manual" || (!stock.refresh && stock.session === session))
  );
}

// Persist the report marker with the outbox message in the same state transaction.
export function dailySummary(
  state: State,
  session: string,
): Notice | undefined {
  const report = state.dailyReport;
  const stocks = Object.entries(state.stocks);
  if (!report || report.session !== session || report.sent || !stocks.length)
    return;
  if (
    stocks.some(
      ([symbol, stock]) =>
        !dailyReady(stock, session) && !report.attempted.includes(symbol),
    )
  )
    return;
  report.sent = true;
  const lines = stocks.map(([symbol, stock]) => {
    if (!dailyReady(stock, session))
      return `${symbol}: update failed; retry queued. See /levels ${symbol}.`;
    return `${symbol}: ${stock.mode === "manual" ? "manual levels" : `${stock.zones.length} zones`} | RSI(14): ${stock.rsi!.value.toFixed(2)}`;
  });
  return {
    id: `daily-summary:${session}`,
    kind: "system",
    body: `Daily levels & RSI — history through ${session}\n${lines.join("\n")}\nCompleted daily bars. Use /levels SYMBOL or /rsi SYMBOL for details.`,
  };
}
