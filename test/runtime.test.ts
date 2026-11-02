import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { scan } from "../src/index";
import { read, commit } from "../src/storage";
import { deliver } from "../src/telegram";
import { history } from "../src/providers";
import { blankStock, type Env, type State } from "../src/model";
let mf: Miniflare;
let env: Env;
const time = Date.parse("2026-10-12T14:00:00Z");
beforeAll(async () => {
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      cf: false,
    }),
    telemetry: { enabled: false },
  });
  env = {
    DB: (await mf.getD1Database("DB")) as unknown as D1Database,
    ALPACA_KEY: "test",
    ALPACA_SECRET: "test",
    TELEGRAM_TOKEN: "test",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    OWNER_USER_ID: "1",
    OWNER_CHAT_ID: "1",
    DRY_RUN: "true",
  };
  for (const statement of readFileSync("migrations/0001_initial.sql", "utf8")
    .split(";")
    .filter((s) => s.trim()))
    await env.DB.prepare(statement).run();
}, 30000);
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM outbox",
      "DELETE FROM leases",
      "DELETE FROM updates",
      `UPDATE state SET revision=0,value='{"stocks":{},"paused":false}'`,
    ].map((s) => env.DB.prepare(s)),
  );
  env.DRY_RUN = "true";
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await mf.dispose();
});
async function seed() {
  const snapshot = await read(env),
    s = blankStock();
  s.mode = "manual";
  s.refresh = false;
  s.rsi = { value: 50, session: "2026-10-09" };
  s.zones = [{ id: "s", side: "support", low: 99, high: 101, dates: [] }];
  snapshot.value.stocks.AAPL = s;
  snapshot.value.dailyReport = {
    session: "2026-10-09",
    attempted: [],
    sent: true,
  };
  await commit(env, snapshot, [], time);
}
function api(
  now: number,
  price = 102,
  days = [
    { date: "2026-10-09", open: "09:30", close: "16:00" },
    { date: "2026-10-12", open: "09:30", close: "16:00" },
  ],
  marketOpen = true,
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/clock"))
      return Response.json({
        is_open: marketOpen,
        timestamp: new Date(now).toISOString(),
      });
    if (url.includes("/calendar")) return Response.json(days);
    if (url.includes("/trades/latest"))
      return Response.json({
        trades: { AAPL: { p: price, t: new Date(now).toISOString() } },
      });
    throw new Error("Unexpected upstream call");
  });
}
describe("scheduled provider-to-outbox flow", () => {
  it("collects success and failure across scans into one persisted daily summary", async () => {
    const snapshot = await read(env);
    snapshot.value.stocks.AAPL = blankStock();
    snapshot.value.stocks.AMD = blankStock();
    await commit(env, snapshot, [], time);
    const bars = Array.from({ length: 120 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 9, 9) - i * 86400000).toISOString(),
      h: 110,
      l: 100,
      c: 105,
    }));
    const count = () =>
      env.DB.prepare(
        "SELECT count(*) AS n FROM outbox WHERE kind='system'",
      ).first("n");
    for (let i = 0; i < 3; i++) {
      const now = time + i * 60000;
      const normal = api(now, 102, undefined, false);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).includes("/AMD/bars?"))
            return new Response("denied", { status: 403 });
          if (String(input).includes("/bars?")) return Response.json({ bars });
          return normal(input);
        }),
      );
      await scan(env, now);
      expect(await count()).toBe(i === 0 ? 0 : 1);
    }
    const body = await env.DB.prepare(
      "SELECT body FROM outbox WHERE kind='system'",
    ).first<string>("body");
    expect(body).toContain("AAPL: 0 zones | RSI(14): 50.00");
    expect(body).toContain("AMD: update failed");
    // A successful retry must not generate another completion notification.
    const later = time + 7 * 3600000;
    const normal = api(later, 102, undefined, false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/bars?")
          ? Response.json({ bars })
          : normal(input),
      ),
    );
    await scan(env, later);
    expect((await read(env)).value.stocks.AMD.rsi?.value).toBe(50);
    expect(await count()).toBe(1);
  });
  it("publishes historical levels before baselining a newly added symbol", async () => {
    const snapshot = await read(env);
    snapshot.value.stocks.AAPL = blankStock();
    await commit(env, snapshot, [], time);
    const bars = Array.from({ length: 120 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 9, 9) - i * 86400000).toISOString(),
      h: 108,
      l: 105,
      c: 106,
    }));
    bars[10].l = 100;
    bars[20].l = 100.3;
    const normal = api(time);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/bars?")
          ? Response.json({ bars })
          : normal(input),
      ),
    );
    await scan(env, time);
    const stock = (await read(env)).value.stocks.AAPL;
    expect(stock.session).toBe("2026-10-09");
    expect(stock.zones).toHaveLength(1);
    expect(stock.previous).toBeUndefined();
    expect(stock.refresh).toBe(false);
    expect(stock.rsi).toEqual({ value: 50, session: "2026-10-09" });
  });
  it("backfills RSI for manual stocks without changing zones or alert generation", async () => {
    await seed();
    const snapshot = await read(env);
    delete snapshot.value.stocks.AAPL.rsi;
    const original = structuredClone(snapshot.value.stocks.AAPL);
    await commit(env, snapshot, [], time);
    const normal = api(time, 102, undefined, false);
    const bars = Array.from({ length: 120 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 9, 9) - i * 86400000).toISOString(),
      h: 110,
      l: 100,
      c: 105,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/bars?")
          ? Response.json({ bars })
          : normal(input),
      ),
    );
    await scan(env, time);
    const stock = (await read(env)).value.stocks.AAPL;
    expect(stock.rsi).toEqual({ value: 50, session: "2026-10-09" });
    expect(stock.zones).toEqual(original.zones);
    expect(stock.generation).toBe(original.generation);
    expect(stock.mode).toBe("manual");
  });
  it("keeps failed historical jobs queued without silently changing the source feed", async () => {
    const snapshot = await read(env);
    snapshot.value.stocks.AAPL = blankStock();
    await commit(env, snapshot, [], time);
    const normal = api(time);
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/bars?")
        ? new Response("denied", { status: 403 })
        : normal(input),
    );
    vi.stubGlobal("fetch", fetcher);
    await scan(env, time);
    const stock = (await read(env)).value.stocks.AAPL;
    expect(stock.refresh).toBe(true);
    expect(stock.zones).toEqual([]);
    expect(stock.error).toContain("403");
    expect(stock.retryRefreshAt).toBe(time + 6 * 3600000);
    const historical = fetcher.mock.calls.filter(([u]) =>
      String(u).includes("/bars?"),
    );
    expect(historical).toHaveLength(1);
    expect(String(historical[0][0])).toContain("feed=sip");
  });
  it("baselines then persists an alert and suppresses sending in dry-run", async () => {
    await seed();
    vi.stubGlobal("fetch", api(time));
    await scan(env, time);
    const fetcher = api(time + 60000, 100);
    vi.stubGlobal("fetch", fetcher);
    await scan(env, time + 60000);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox WHERE kind='price'",
      ).first("n"),
    ).toBe(1);
    await deliver(env, time + 60000);
    expect(
      await env.DB.prepare(
        "SELECT status FROM outbox WHERE kind='price'",
      ).first("status"),
    ).toBe("dry_run");
    expect(
      fetcher.mock.calls.every(([u]) => !String(u).includes("telegram.org")),
    ).toBe(true);
  });
  it("does not fetch prices on holidays or after an early close even if clock says open", async () => {
    await seed();
    const holiday = api(time, 100, []);
    vi.stubGlobal("fetch", holiday);
    await scan(env, time);
    expect(
      holiday.mock.calls.some(([u]) => String(u).includes("/trades/latest")),
    ).toBe(false);
    const later = Date.parse("2026-10-12T18:00:00Z");
    const early = api(later, 100, [
      { date: "2026-10-12", open: "09:30", close: "13:00" },
    ]);
    vi.stubGlobal("fetch", early);
    await scan(env, later);
    expect(
      early.mock.calls.some(([u]) => String(u).includes("/trades/latest")),
    ).toBe(false);
  });
  it("fails closed when session checks fail and does not repeat incident notices", async () => {
    await seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await scan(env, time);
    await scan(env, time + 16 * 60000);
    await scan(env, time + 17 * 60000);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox WHERE kind='system'",
      ).first("n"),
    ).toBe(1);
    expect((await read(env)).value.marketOpen).toBeUndefined();
  });
  it("handles partial price responses as a per-symbol data incident", async () => {
    await seed();
    for (const minute of [0, 16, 17]) {
      const now = time + minute * 60000,
        normal = api(now);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) =>
          String(input).includes("/trades/latest")
            ? Response.json({ trades: {} })
            : normal(input),
        ),
      );
      await scan(env, now);
    }
    expect((await read(env)).value.stocks.AAPL.incident).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox WHERE kind='system'",
      ).first("n"),
    ).toBe(1);
  });
  it("preserves a concurrent command rather than committing a stale scan", async () => {
    await seed();
    const normal = api(time);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("/trades/latest")) {
          const snapshot = await read(env);
          snapshot.value.paused = true;
          await commit(env, snapshot, [], time);
        }
        return normal(input);
      }),
    );
    await scan(env, time);
    expect((await read(env)).value.paused).toBe(true);
    expect((await read(env)).value.stocks.AAPL.previous).toBeUndefined();
  });
});
describe("delivery recovery", () => {
  it("honours retry_after then marks a successful response sent", async () => {
    await commit(
      env,
      await read(env),
      [{ id: "retry", kind: "command", body: "hello" }],
      Date.now(),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: false, parameters: { retry_after: 120 } },
          { status: 429 },
        ),
      ),
    );
    const before = Date.now();
    await deliver(env, before);
    const row = await env.DB.prepare(
      "SELECT next_at,status FROM outbox WHERE id='retry'",
    ).first<{ next_at: number; status: string }>();
    expect(row!.status).toBe("pending");
    expect(row!.next_at).toBeGreaterThanOrEqual(before + 120000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    await deliver(env, row!.next_at + 1);
    expect(
      await env.DB.prepare("SELECT status FROM outbox WHERE id='retry'").first(
        "status",
      ),
    ).toBe("sent");
  });
  it("cancels queued alerts after removal and never sends expired alerts", async () => {
    await commit(
      env,
      await read(env),
      [
        {
          id: "removed",
          kind: "price",
          symbol: "AAPL",
          generation: "old",
          body: "alert",
        },
        { id: "expired", kind: "command", body: "old", expires: 1 },
      ],
      Date.now(),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await deliver(env, Date.now());
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT status FROM outbox WHERE id='removed'",
      ).first("status"),
    ).toBe("cancelled");
  });
});
describe("historical data", () => {
  it("paginates using explicit free-compatible SIP and split adjustments", async () => {
    const bar = (day: number) => ({
      t: `2026-10-${day}T04:00:00Z`,
      h: 110,
      l: 100,
      c: 105,
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("feed")).toBe("sip");
      expect(url.searchParams.get("adjustment")).toBe("split");
      return Response.json(
        url.searchParams.has("page_token")
          ? { bars: [bar(8)] }
          : { bars: [bar(9)], next_page_token: "next" },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await history(env, "AAPL", "2026-10-12", time)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
