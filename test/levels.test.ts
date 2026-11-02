import { describe, it, expect } from "vitest";
import { calculate } from "../src/levels";
import type { Bar } from "../src/model";
function bars(): Bar[] {
  return Array.from({ length: 120 }, (_, i) => ({
    t: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    l: 105,
    h: 108,
    c: 106,
  }));
}
describe("confirmed daily levels", () => {
  it("clusters distinct low/high pivots and selects zones around the last close", () => {
    const b = bars();
    b[10].l = 99.8;
    b[20].l = 100;
    b[30].l = 100.2;
    b[40].h = 110;
    b[50].h = 110.3;
    expect(calculate(b)).toEqual([
      expect.objectContaining({
        side: "support",
        low: 99.8,
        high: 100.2,
        dates: [
          b[10].t.slice(0, 10),
          b[20].t.slice(0, 10),
          b[30].t.slice(0, 10),
        ],
      }),
      expect.objectContaining({ side: "resistance", low: 110, high: 110.3 }),
    ]);
  });
  it("does not confirm the last two candles or accept equal neighbours", () => {
    const b = bars();
    b[10].l = 100;
    b[118].l = 100;
    b[119].l = 101;
    expect(calculate(b)).toEqual([]);
    b[20].l = 100;
    b[21].l = 100;
    expect(calculate(b)).toEqual([]);
  });
  it("uses cluster total span rather than chaining close prices", () => {
    const b = bars();
    b[10].l = 100;
    b[20].l = 100.4;
    b[30].l = 100.8;
    expect(calculate(b)[0].dates).toHaveLength(2);
    expect(calculate(b)[0].high).toBe(100.4);
  });
  it("widens narrow zones, handles descending input, and rejects insufficient history", () => {
    const b = bars();
    b[10].l = 100;
    b[20].l = 100;
    const z = calculate(b.reverse())[0];
    expect(z.low).toBeCloseTo(99.9);
    expect(z.high).toBeCloseTo(100.1);
    expect(() => calculate(b.slice(0, 59))).toThrow("Insufficient");
  });
  it("keeps only the nearest two qualifying levels and removes straddling zones", () => {
    const b = bars();
    [90, 95, 100].forEach((p, j) => {
      b[10 + j * 20].l = p;
      b[15 + j * 20].l = p;
    });
    expect(calculate(b).map((z) => z.low)).toEqual([99.9, 94.905]);
    b[119].c = 100;
    expect(calculate(b).every((z) => z.high < 100)).toBe(true);
  });
});
