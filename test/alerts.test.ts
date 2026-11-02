import { describe, it, expect } from "vitest";
import { evaluate } from "../src/alerts";
import { blankStock, ny, stamp } from "../src/model";
const start = Date.parse("2026-10-12T14:00:00Z");
function setup() {
  const s = blankStock();
  s.mode = "manual";
  s.zones = [{ id: "s", side: "support", low: 99, high: 101, dates: [] }];
  return s;
}
describe("sampled alerts", () => {
  it("baselines, enters support, and detects a breakdown without repeating while beyond", () => {
    const s = setup();
    const tick = (p: number, m: number) =>
      evaluate(
        "AAPL",
        s,
        { p, t: new Date(start + m * 60000).toISOString() },
        start + m * 60000,
        "2026-10-12",
      );
    expect(tick(102, 0)).toHaveLength(0);
    expect(tick(100, 1)[0].body).toContain("ZONE ENTRY");
    expect(tick(98, 2)[0].body).toContain("BREAKDOWN");
    expect(tick(97, 3)).toHaveLength(0);
  });
  it("reports a skipped-over zone as breakdown only", () => {
    const s = setup();
    evaluate("A", s, { p: 102, t: new Date(start).toISOString() }, start, "d");
    const events = evaluate(
      "A",
      s,
      { p: 98, t: new Date(start + 60000).toISOString() },
      start + 60000,
      "d",
    );
    expect(events).toHaveLength(1);
    expect(events[0].body).toContain("BREAKDOWN");
  });
  it("enforces cooldown and requires a return crossing to rearm", () => {
    const s = setup();
    const tick = (p: number, m: number) =>
      evaluate(
        "A",
        s,
        { p, t: new Date(start + m * 60000).toISOString() },
        start + m * 60000,
        "d",
      );
    tick(102, 0);
    expect(tick(98, 1)).toHaveLength(1);
    tick(100, 2);
    expect(tick(98, 3)).toHaveLength(0);
    for (let m = 4; m <= 31; m++) tick(98, m);
    expect(tick(98, 32)).toHaveLength(0);
    tick(100, 33);
    expect(tick(98, 34)).toHaveLength(1);
  });
  it("suppresses stale, duplicate, out-of-order, new-session and gap crossings", () => {
    const s = setup();
    evaluate("A", s, { p: 102, t: new Date(start).toISOString() }, start, "d");
    expect(
      evaluate(
        "A",
        s,
        { p: 98, t: new Date(start).toISOString() },
        start + 60000,
        "d",
      ),
    ).toEqual([]);
    expect(() =>
      evaluate(
        "A",
        s,
        { p: 98, t: new Date(start).toISOString() },
        start + 121000,
        "d",
      ),
    ).toThrow("stale");
    expect(
      evaluate(
        "A",
        s,
        { p: 98, t: new Date(start + 180000).toISOString() },
        start + 180000,
        "d",
      ),
    ).toEqual([]);
    expect(
      evaluate(
        "A",
        s,
        { p: 102, t: new Date(start + 240000).toISOString() },
        start + 240000,
        "next",
      ),
    ).toEqual([]);
  });
  it("uses New York DST and Bangkok display time", () => {
    expect(ny(Date.parse("2026-07-01T13:30:00Z")).minute).toBe(570);
    expect(ny(Date.parse("2026-12-01T14:30:00Z")).minute).toBe(570);
    expect(stamp(Date.parse("2026-12-01T14:30:00Z"))).toContain("21:30:00");
  });
});
