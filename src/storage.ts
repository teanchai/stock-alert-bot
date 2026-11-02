import type { Env, Snapshot, Notice } from "./model";
export async function read(env: Env): Promise<Snapshot> {
  const row = await env.DB.prepare(
    "SELECT revision,value FROM state WHERE id=1",
  ).first<{ revision: number; value: string }>();
  if (!row) throw new Error("Database migrations have not been applied.");
  return { revision: row.revision, value: JSON.parse(row.value) };
}
export async function commit(
  env: Env,
  snapshot: Snapshot,
  notices: Notice[],
  now: number,
  updateId?: number,
  fence?: { owner: string; now: number },
): Promise<boolean> {
  // A unique transaction token ties outbox/update writes to this exact successful CAS.
  const token = crypto.randomUUID();
  const value = JSON.stringify({ ...snapshot.value, commitToken: token });
  const conditions = ["id=1", "revision=?"];
  const bindings: (string | number)[] = [value, snapshot.revision];
  if (updateId !== undefined) {
    conditions.push("NOT EXISTS(SELECT 1 FROM updates WHERE id=?)");
    bindings.push(updateId);
  }
  if (fence) {
    conditions.push(
      "EXISTS(SELECT 1 FROM leases WHERE id='scan' AND owner=? AND until_at>?)",
    );
    bindings.push(fence.owner, fence.now);
  }
  const statements = [
    env.DB.prepare(
      `UPDATE state SET value=?,revision=revision+1 WHERE ${conditions.join(" AND ")}`,
    ).bind(...bindings),
  ];
  if (updateId !== undefined)
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO updates SELECT ?,? WHERE EXISTS(SELECT 1 FROM state WHERE json_extract(value,'$.commitToken')=?)",
      ).bind(updateId, now, token),
    );
  for (const notice of notices)
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO outbox(id,body,symbol,generation,kind,created_at,expires_at,next_at)
 SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM state WHERE json_extract(value,'$.commitToken')=?)`,
      ).bind(
        notice.id,
        notice.body,
        notice.symbol ?? null,
        notice.generation ?? null,
        notice.kind,
        now,
        notice.expires ?? now + (notice.kind === "price" ? 600_000 : 86400_000),
        now,
        token,
      ),
    );
  const results = await env.DB.batch(statements);
  return results[0].meta.changes === 1;
}
export async function lease(
  env: Env,
  id: string,
  now: number,
): Promise<string | null> {
  const owner = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO leases(id,owner,until_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_at=excluded.until_at WHERE leases.until_at<? RETURNING owner`,
  )
    .bind(id, owner, now + 55_000, now)
    .first<{ owner: string }>();
  return result?.owner ?? null;
}
export async function release(env: Env, id: string, owner: string) {
  await env.DB.prepare("DELETE FROM leases WHERE id=? AND owner=?")
    .bind(id, owner)
    .run();
}
export async function cleanup(env: Env, now: number) {
  const before = now - 7 * 86400_000;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM updates WHERE id IN (SELECT id FROM updates WHERE created_at<? LIMIT 500)",
    ).bind(before),
    env.DB.prepare(
      "DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE created_at<? LIMIT 500)",
    ).bind(before),
    env.DB.prepare(
      "UPDATE outbox SET status='expired' WHERE status IN ('pending','sending') AND expires_at<?",
    ).bind(now),
  ]);
}
