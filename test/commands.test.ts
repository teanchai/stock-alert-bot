import { describe, it, expect } from "vitest";
import { applyCommand, parseZones } from "../src/commands";
import type { State } from "../src/model";
describe("owner commands", () => {
  it("shows pending and dated RSI in commands, preserving it in manual mode", () => {
    const s: State = { stocks: {}, paused: false };
    applyCommand(s, "/add MRVL", 1, true);
    expect(applyCommand(s, "/rsi MRVL", 2, true)).toContain("pending");
    s.stocks.MRVL.rsi = { value: 0, session: "2026-10-14" };
    applyCommand(s, "/setlevels MRVL support=99-101 resistance=none", 3, true);
    for (const command of ["/list", "/levels MRVL", "/rsi MRVL"]) {
      const reply = applyCommand(s, command, 4, true);
      expect(reply).toContain("0.00");
      expect(reply).toContain("2026-10-14");
    }
    s.stocks.MRVL.rsiError = "Historical data unavailable.";
    expect(applyCommand(s, "/rsi MRVL", 5, true)).toContain("refresh failed");
  });
  it("replaces auto levels with validated manual zones and restores auto on request", () => {
    const s: State = { stocks: {}, paused: false };
    applyCommand(s, "/add AAPL", 1, true);
    applyCommand(
      s,
      "/setlevels AAPL support=99-101 resistance=110-112",
      2,
      true,
    );
    expect(s.stocks.AAPL.mode).toBe("manual");
    expect(s.stocks.AAPL.zones).toHaveLength(2);
    applyCommand(s, "/auto AAPL", 3, true);
    expect(s.stocks.AAPL.zones).toHaveLength(0);
    expect(s.stocks.AAPL.refresh).toBe(true);
  });
  it("rejects overlaps, invalid boundaries, too many levels, and empty sets", () => {
    for (const input of [
      "support=99-101 resistance=100-112",
      "support=0-1 resistance=none",
      "support=1-2,3-4,5-6 resistance=none",
      "support=none resistance=none",
    ])
      expect(() => parseZones(input)).toThrow();
  });
  it("keeps individual pauses on global resume and resets baselines", () => {
    const s: State = { stocks: {}, paused: false };
    applyCommand(s, "/add AAPL", 1, true);
    applyCommand(s, "/pause AAPL", 2, true);
    applyCommand(s, "/pause all", 3, true);
    applyCommand(s, "/resume all", 4, true);
    expect(s.paused).toBe(false);
    expect(s.stocks.AAPL.paused).toBe(true);
    applyCommand(s, "/remove AAPL", 5, true);
    expect(s.stocks).toEqual({});
  });
});
