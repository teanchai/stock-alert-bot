import type { Bar, Zone } from "./model";
export const ALGORITHM_VERSION = "daily-pivots-v1";
export function calculate(input: Bar[]): Zone[] {
  const bars = [...new Map(input.map((b) => [b.t, b])).values()]
    .sort((a, b) => a.t.localeCompare(b.t))
    .slice(-120);
  if (bars.length < 60)
    throw new Error("Insufficient history: need 60 completed daily bars.");
  if (
    bars.some(
      (b) =>
        ![b.h, b.l, b.c].every((n) => Number.isFinite(n) && n > 0) || b.l > b.h,
    )
  )
    throw new Error("Invalid historical bars.");
  const close = bars.at(-1)!.c;
  const result: Zone[] = [];
  for (const side of ["support", "resistance"] as const) {
    const key = side === "support" ? "l" : "h";
    const pivots: { price: number; date: string }[] = [];
    for (let i = 2; i < bars.length - 2; i++) {
      const p = bars[i][key];
      if (
        [-2, -1, 1, 2].every((offset) =>
          side === "support"
            ? p < bars[i + offset][key]
            : p > bars[i + offset][key],
        )
      )
        pivots.push({ price: p, date: bars[i].t.slice(0, 10) });
    }
    pivots.sort((a, b) => a.price - b.price || a.date.localeCompare(b.date));
    const groups: (typeof pivots)[] = [];
    for (const p of pivots) {
      const last = groups.at(-1);
      if (last && p.price <= last[0].price * 1.005) last.push(p);
      else groups.push([p]);
    }
    const zones: Zone[] = [];
    for (const group of groups) {
      const dates = [...new Set(group.map((p) => p.date))].sort();
      if (dates.length < 2) continue;
      let low = group[0].price,
        high = group.at(-1)!.price;
      const mid = (low + high) / 2;
      if (high - low < mid * 0.002) {
        low = mid * 0.999;
        high = mid * 1.001;
      }
      if (side === "support" ? high >= close : low <= close) continue;
      zones.push({ id: `${side}:${dates.join(",")}`, side, low, high, dates });
    }
    zones.sort((a, b) =>
      side === "support" ? b.high - a.high : a.low - b.low,
    );
    result.push(...zones.slice(0, 2));
  }
  return result;
}
