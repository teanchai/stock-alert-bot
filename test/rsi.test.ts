import { expect, it } from "vitest";
import { calculateRsi } from "../src/rsi";
const bars = (closes: number[]) =>
  closes.map((c, i) => ({
    t: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    c,
    h: c,
    l: c,
  }));

it("matches a known Wilder seed and subsequent smoothed value", () => {
  const prices = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28, 46.0,
  ];
  expect(calculateRsi(bars(prices.slice(0, 15)))).toBeCloseTo(70.464135, 5);
  expect(calculateRsi(bars(prices))).toBeCloseTo(66.249619, 5);
  const input = bars(prices).reverse();
  expect(calculateRsi([...input, input[0]])).toBeCloseTo(66.249619, 5);
});
it("handles rising, falling, flat, insufficient and invalid closes", () => {
  expect(calculateRsi(bars(Array.from({ length: 20 }, (_, i) => i + 1)))).toBe(
    100,
  );
  expect(calculateRsi(bars(Array.from({ length: 20 }, (_, i) => 20 - i)))).toBe(
    0,
  );
  expect(calculateRsi(bars(Array(20).fill(100)))).toBe(50);
  expect(() => calculateRsi(bars(Array(14).fill(100)))).toThrow("15 completed");
  expect(() => calculateRsi(bars([...Array(15).fill(100), NaN]))).toThrow(
    "Invalid",
  );
});
