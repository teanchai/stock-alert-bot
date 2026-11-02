import type { Env } from "./model";
import { read } from "./storage";
interface Row {
  id: string;
  body: string;
  symbol: string | null;
  generation: string | null;
  kind: string;
  attempts: number;
  expires_at: number;
}
// Keep each persisted message under Telegram's limit, breaking at newlines when possible.
export function chunks(body: string): string[] {
  const result: string[] = [];
  while (body.length > 3500) {
    let i = body.lastIndexOf("\n", 3500);
    if (i < 1) i = 3500;
    result.push(body.slice(0, i));
    body = body.slice(i).trimStart();
  }
  if (body) result.push(body);
  return result;
}
export async function deliver(env: Env, now: number) {
  const started = Date.now();
  for (let i = 0; i < 5 && Date.now() - started < 30_000; i++) {
    const claim = crypto.randomUUID();
    const row = await env.DB.prepare(
      `UPDATE outbox SET status='sending',claim=?,lease_until=?,attempts=attempts+1
   WHERE id=(SELECT id FROM outbox WHERE expires_at>? AND next_at<=? AND (status='pending' OR (status='sending' AND lease_until<?)) ORDER BY created_at LIMIT 1) RETURNING *`,
    )
      .bind(claim, Date.now() + 60_000, now, now, now)
      .first<Row>();
    if (!row) return;
    const finish = async (status: string) => {
      await env.DB.prepare(
        "UPDATE outbox SET status=?,claim=NULL,lease_until=NULL WHERE id=? AND claim=?",
      )
        .bind(status, row.id, claim)
        .run();
    };
    if (row.kind === "price") {
      const { value } = await read(env);
      const stock = row.symbol ? value.stocks[row.symbol] : undefined;
      if (
        value.paused ||
        !stock ||
        stock.paused ||
        stock.generation !== row.generation
      ) {
        await finish("cancelled");
        continue;
      }
      if (env.DRY_RUN !== "false") {
        console.log(
          JSON.stringify({
            event: "dry_run_alert",
            id: row.id,
            body: row.body,
          }),
        );
        await finish("dry_run");
        continue;
      }
    }
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.OWNER_CHAT_ID, text: row.body }),
          signal: AbortSignal.timeout(7000),
        },
      );
      const data = (await response.json()) as {
        ok: boolean;
        parameters?: { retry_after?: number };
      };
      if (response.ok && data.ok) {
        await finish("sent");
        continue;
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        await finish("failed");
        console.error(
          JSON.stringify({
            event: "telegram_permanent_failure",
            status: response.status,
          }),
        );
        continue;
      }
      await retry(env, row, claim, Date.now(), data.parameters?.retry_after);
    } catch {
      await retry(env, row, claim, Date.now());
    }
  }
}
async function retry(
  env: Env,
  row: Row,
  claim: string,
  now: number,
  delay?: number,
) {
  const next =
    now +
    1000 *
      Math.max(delay ?? 0, Math.min(300, 2 ** Math.min(row.attempts, 8) * 5));
  await env.DB.prepare(
    "UPDATE outbox SET status=?,next_at=?,claim=NULL,lease_until=NULL,error='delivery_failed' WHERE id=? AND claim=?",
  )
    .bind(row.attempts >= 10 ? "failed" : "pending", next, row.id, claim)
    .run();
}
