import { expect, it } from "vitest";
import { dailySummary } from "../src/daily-summary";
import { blankStock, type State } from "../src/model";
import { chunks } from "../src/telegram";

it("fits the entire 20-stock watchlist in one message including failures", () => {
  const state: State = {
    stocks: {},
    paused: false,
    dailyReport: { session: "2026-10-14", attempted: [], sent: false },
  };
  for (let i = 0; i < 20; i++) {
    const symbol = `LONGNAME${i}`;
    state.stocks[symbol] = blankStock();
    state.dailyReport!.attempted.push(symbol);
  }
  const notice = dailySummary(state, "2026-10-14")!;
  expect(chunks(notice.body)).toHaveLength(1);
  expect(notice.body.match(/update failed/g)).toHaveLength(20);
  expect(dailySummary(state, "2026-10-14")).toBeUndefined();
  expect(dailySummary(state, "2026-10-15")).toBeUndefined();
});

it("waits for pending stocks and handles removals, manual mode and empty watchlists", () => {
  const state: State = {
    stocks: {},
    paused: false,
    dailyReport: { session: "2026-10-14", attempted: [], sent: false },
  };
  expect(dailySummary(state, "2026-10-14")).toBeUndefined();
  state.stocks.AMD = blankStock();
  state.stocks.AAPL = {
    ...blankStock(),
    mode: "manual",
    rsi: { value: 60, session: "2026-10-14" },
  };
  expect(dailySummary(state, "2026-10-14")).toBeUndefined();
  delete state.stocks.AMD;
  expect(dailySummary(state, "2026-10-14")!.body).toContain(
    "AAPL: manual levels | RSI(14): 60.00",
  );
});
