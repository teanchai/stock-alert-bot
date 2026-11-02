import type { Bar, Stock } from "./model";

// Wilder smoothing, seeded with the first 14 close-to-close changes.
export function calculateRsi(input: Bar[]): number {
  const bars = [...new Map(input.map((b) => [b.t, b])).values()]
    .sort((a, b) => a.t.localeCompare(b.t))
    .slice(-120);
  if (bars.length < 15) throw new Error("RSI needs 15 completed daily bars.");
  if (bars.some((b) => !Number.isFinite(b.c) || b.c <= 0))
    throw new Error("Invalid closing prices for RSI.");
  let gain = 0,
    loss = 0;
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].c - bars[i - 1].c;
    const up = Math.max(change, 0),
      down = Math.max(-change, 0);
    if (i <= 14) {
      gain += up / 14;
      loss += down / 14;
    } else {
      gain = (gain * 13 + up) / 14;
      loss = (loss * 13 + down) / 14;
    }
  }
  // Explicit neutral convention when the whole window is flat.
  if (gain === 0 && loss === 0) return 50;
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

export function rsiText(stock: Stock): string {
  const rsi = stock.rsi;
  return (
    (rsi
      ? `RSI(14, daily, Wilder): ${rsi.value.toFixed(2)}; through ${rsi.session} (completed bars)`
      : "RSI(14, daily, Wilder): pending historical calculation") +
    (stock.rsiError ? `; refresh failed: ${stock.rsiError}` : "")
  );
}
