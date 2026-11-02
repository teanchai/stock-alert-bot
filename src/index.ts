import { applyCommand, commandName, symbolOf } from "./commands";
import { evaluate } from "./alerts";
import { calculate } from "./levels";
import { calculateRsi } from "./rsi";
import { dailyReady, dailySummary } from "./daily-summary";
import {
  clock,
  calendar,
  trades,
  history,
  validateSymbol,
  ProviderError,
} from "./providers";
import { read, commit, lease, release, cleanup } from "./storage";
import { chunks, deliver } from "./telegram";
import { ny, reset, type Env, type Notice, type Stock } from "./model";

function notices(items: Notice[]): Notice[] {
  const grouped: Notice[] = [];
  for (const n of items) {
    const existing =
      n.kind === "price"
        ? grouped.find(
            (p) =>
              p.kind === "price" &&
              p.symbol === n.symbol &&
              p.generation === n.generation,
          )
        : undefined;
    if (existing) {
      existing.id += "|" + n.id;
      existing.body += "\n\n" + n.body;
    } else grouped.push({ ...n });
  }
  return grouped.flatMap((n) =>
    chunks(n.body).map((body, i) => ({ ...n, id: `${n.id}:${i}`, body })),
  );
}
function system(body: string): Notice {
  return { id: crypto.randomUUID(), kind: "system", body };
}
function configured(env: Env) {
  return [
    "ALPACA_KEY",
    "ALPACA_SECRET",
    "TELEGRAM_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "OWNER_USER_ID",
    "OWNER_CHAT_ID",
  ].every(
    (k) =>
      typeof env[k as keyof Env] === "string" && Boolean(env[k as keyof Env]),
  );
}
interface Update {
  update_id: number;
  message?: {
    text?: string;
    from?: { id: number };
    chat?: { id: number; type: string };
  };
}
export async function webhook(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) return new Response("Not configured", { status: 503 });
  if (
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
    env.TELEGRAM_WEBHOOK_SECRET
  )
    return new Response("Forbidden", { status: 403 });
  if (Number(request.headers.get("content-length")) > 16_384)
    return new Response("Too large", { status: 413 });
  const body = await request.text();
  if (body.length > 16_384) return new Response("Too large", { status: 413 });
  let update: Update;
  try {
    update = JSON.parse(body);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0)
    return new Response("Bad update", { status: 400 });
  const msg = update.message;
  if (
    String(msg?.from?.id) !== env.OWNER_USER_ID ||
    String(msg?.chat?.id) !== env.OWNER_CHAT_ID ||
    msg?.chat?.type !== "private"
  )
    return new Response("OK");
  if (typeof msg.text !== "string" || !msg.text.startsWith("/"))
    return new Response("OK");
  if (
    await env.DB.prepare("SELECT id FROM updates WHERE id=?")
      .bind(update.update_id)
      .first()
  )
    return new Response("OK");
  let validationError: string | undefined;
  if (commandName(msg.text) === "/add") {
    try {
      await validateSymbol(env, symbolOf(msg.text.trim().split(/\s+/)[1]));
    } catch (error) {
      validationError =
        error instanceof ProviderError
          ? `Symbol lookup failed (HTTP ${error.status}); try again later.`
          : error instanceof Error && error.name !== "TimeoutError"
            ? error.message
            : "Symbol lookup unavailable; try again later.";
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await read(env);
    let reply: string;
    try {
      reply =
        validationError ??
        applyCommand(
          snapshot.value,
          msg.text,
          Date.now(),
          env.DRY_RUN !== "false",
        );
    } catch (error) {
      reply = error instanceof Error ? error.message : "Invalid command.";
    }
    if (commandName(msg.text) === "/status") {
      const count = await env.DB.prepare(
        "SELECT SUM(CASE WHEN status IN ('pending','sending') AND expires_at>? THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM outbox",
      )
        .bind(Date.now())
        .first<{ pending: number; failed: number }>();
      reply += `\nDelivery backlog: ${count?.pending ?? 0}; failed deliveries retained: ${count?.failed ?? 0}`;
    }
    if (
      await commit(
        env,
        snapshot,
        notices([
          { id: `command:${update.update_id}`, kind: "command", body: reply },
        ]),
        Date.now(),
        update.update_id,
      )
    )
      return new Response("OK");
    if (
      await env.DB.prepare("SELECT id FROM updates WHERE id=?")
        .bind(update.update_id)
        .first()
    )
      return new Response("OK");
  }
  return new Response("Busy; retry", { status: 503 });
}
function failed(stock: Stock, symbol: string, now: number, output: Notice[]) {
  stock.failureSince ??= now;
  if (now - stock.failureSince >= 15 * 60_000 && !stock.incident) {
    stock.incident = true;
    output.push(
      system(
        `${symbol}: no usable live IEX data for 15 minutes. Price alerts are suppressed until fresh data returns.`,
      ),
    );
  }
}
export async function scan(env: Env, now = Date.now()) {
  if (!configured(env)) {
    console.error(JSON.stringify({ event: "missing_configuration" }));
    return;
  }
  const owner = await lease(env, "scan", now);
  if (!owner) return;
  const started = Date.now();
  try {
    const snapshot = await read(env),
      state = snapshot.value,
      output: Notice[] = [];
    state.lastRun = now;
    const local = ny(now);
    const from = new Date(now - 21 * 86400_000).toISOString().slice(0, 10);
    let sessions: Awaited<ReturnType<typeof calendar>> = [];
    let open = false;
    try {
      const [market, days] = await Promise.all([
        clock(env),
        calendar(env, from, local.date),
      ]);
      if (
        Math.abs(Date.parse(market.timestamp) - now) > 120_000 ||
        !Number.isFinite(Date.parse(market.timestamp))
      )
        throw new Error("Stale clock");
      sessions = days.sort((a, b) => a.date.localeCompare(b.date));
      const today = sessions.find((s) => s.date === local.date);
      const minutes = (s: string) => {
        const [h, m] = s.split(":").map(Number);
        return h * 60 + m;
      };
      open =
        market.is_open &&
        !!today &&
        local.minute >= minutes(today.open) &&
        local.minute < minutes(today.close);
      state.marketOpen = open;
      state.lastMarketCheck = now;
      delete state.marketFailure;
      if (state.marketIncident) {
        state.marketIncident = false;
        output.push(system("Market session checks recovered."));
      }
    } catch {
      delete state.marketOpen;
      state.marketFailure ??= now;
      if (now - state.marketFailure >= 15 * 60_000 && !state.marketIncident) {
        state.marketIncident = true;
        output.push(
          system(
            "Market session checks unavailable for 15 minutes. Monitoring is paused until session status is verified.",
          ),
        );
      }
      await commit(env, snapshot, notices(output), now, undefined, {
        owner,
        now: now + Date.now() - started,
      });
      return;
    }
    const prior = sessions.filter((s) => s.date < local.date);
    const latest = prior.at(-1)?.date,
      oldestAllowed = prior.at(-2)?.date ?? latest;
    if (open && !state.paused) {
      const active = Object.entries(state.stocks).filter(([, s]) => !s.paused);
      let quotes: Record<string, import("./model").Trade> = {};
      if (active.length) {
        try {
          quotes =
            (
              await trades(
                env,
                active.map(([s]) => s),
              )
            ).trades ?? {};
        } catch {
          /* Per-symbol incident tracking below. */
        }
      }
      for (const [symbol, stock] of active) {
        if (stock.failureSession !== local.date) {
          stock.failureSession = local.date;
          delete stock.failureSince;
        }
        if (
          stock.mode === "auto" &&
          (!stock.session || !oldestAllowed || stock.session < oldestAllowed)
        ) {
          delete stock.previous;
          stock.error =
            "Automatic levels are missing or more than one trading session behind.";
          continue;
        }
        try {
          if (!quotes[symbol]) throw new Error("Missing trade");
          output.push(
            ...evaluate(symbol, stock, quotes[symbol], now, local.date),
          );
          if (stock.incident)
            output.push(system(`${symbol}: fresh IEX data recovered.`));
          delete stock.failureSince;
          stock.incident = false;
        } catch {
          failed(stock, symbol, now, output);
        }
      }
    }
    // Spread daily historical work across invocations to fit the free CPU budget.
    if (local.minute >= 420 && latest && state.dailyReport?.session !== latest)
      state.dailyReport = { session: latest, attempted: [], sent: false };
    const next =
      local.minute >= 420 && latest
        ? Object.entries(state.stocks).find(
            ([, s]) => !dailyReady(s, latest) && (s.retryRefreshAt ?? 0) <= now,
          )
        : undefined;
    if (next && Date.now() - started < 15_000) {
      const [symbol, stock] = next;
      try {
        const bars = (await history(env, symbol, local.date, now)).filter(
          (b) => b.t.slice(0, 10) <= latest!,
        );
        if (!bars.some((b) => b.t.slice(0, 10) === latest))
          throw new Error(
            "Latest completed session is absent from historical data.",
          );
        const value = calculateRsi(bars);
        if (stock.mode === "auto") {
          stock.zones = calculate(bars);
          stock.session = latest;
          stock.calculated = new Date(now).toISOString();
          stock.refresh = false;
          delete stock.error;
          reset(stock);
        }
        stock.rsi = { value, session: latest! };
        delete stock.rsiError;
        delete stock.retryRefreshAt;
      } catch (error) {
        stock.rsiError =
          error instanceof ProviderError
            ? `Historical data unavailable (HTTP ${error.status}).`
            : error instanceof Error
              ? error.message
              : "Historical data unavailable.";
        if (stock.mode === "auto") stock.error = stock.rsiError;
        stock.retryRefreshAt = now + 6 * 60 * 60_000;
      }
      if (state.dailyReport && !state.dailyReport.attempted.includes(symbol))
        state.dailyReport.attempted.push(symbol);
    }
    if (local.minute >= 420 && latest) {
      const summary = dailySummary(state, latest);
      if (summary) output.push(summary);
    }
    if (Date.now() - started > 48_000) {
      console.warn(JSON.stringify({ event: "scan_deadline_exceeded" }));
      return;
    }
    if (
      await commit(env, snapshot, notices(output), now, undefined, {
        owner,
        now: now + Date.now() - started,
      })
    ) {
      // Small, bounded housekeeping; operational history is retained for seven days.
      if (local.minute === 360) await cleanup(env, now);
      console.log(
        JSON.stringify({
          event: "scan_complete",
          open,
          symbols: Object.keys(state.stocks).length,
          events: output.length,
        }),
      );
    } else console.log(JSON.stringify({ event: "scan_conflict_skipped" }));
  } finally {
    await release(env, "scan", owner);
  }
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET")
      return Response.json({
        service: "stock-alert-bot",
        configured: configured(env),
      });
    if (url.pathname !== "/telegram/webhook" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    try {
      const response = await webhook(request, env);
      if (response.ok) ctx.waitUntil(deliver(env, Date.now()));
      return response;
    } catch {
      console.error(JSON.stringify({ event: "webhook_failed" }));
      return new Response("Temporary failure", { status: 503 });
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      await scan(env);
    } catch {
      console.error(JSON.stringify({ event: "scan_failed" }));
    }
    try {
      if (configured(env)) await deliver(env, Date.now());
    } catch {
      console.error(JSON.stringify({ event: "delivery_failed" }));
    }
  },
};
