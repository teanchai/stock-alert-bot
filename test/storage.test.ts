import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { read, commit, lease, release } from "../src/storage";
import { webhook } from "../src/index";
import type { Env } from "../src/model";
let mf: Miniflare;
let env: Env;
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
  const sql = readFileSync("migrations/0001_initial.sql", "utf8");
  for (const statement of sql.split(";").filter((s) => s.trim()))
    await env.DB.prepare(statement).run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
describe("transactional D1 integration", () => {
  it("rejects stale snapshots without creating an outbox event", async () => {
    const a = await read(env),
      b = await read(env);
    a.value.paused = true;
    expect(
      await commit(env, a, [{ id: "a", kind: "system", body: "a" }], 1),
    ).toBe(true);
    expect(
      await commit(env, b, [{ id: "b", kind: "system", body: "b" }], 2),
    ).toBe(false);
    expect(
      await env.DB.prepare("SELECT id FROM outbox WHERE id='b'").first(),
    ).toBeNull();
    expect((await read(env)).value.paused).toBe(true);
  });
  it("deduplicates updates even with a fresh state revision", async () => {
    expect(
      await commit(
        env,
        await read(env),
        [{ id: "u", kind: "command", body: "reply" }],
        3,
        42,
      ),
    ).toBe(true);
    expect(
      await commit(
        env,
        await read(env),
        [{ id: "u2", kind: "command", body: "duplicate" }],
        4,
        42,
      ),
    ).toBe(false);
    expect(
      await env.DB.prepare("SELECT id FROM outbox WHERE id='u2'").first(),
    ).toBeNull();
  });
  it("allows one scan lease and fences release by owner", async () => {
    const a = await lease(env, "scan", 100);
    expect(a).toBeTruthy();
    expect(await lease(env, "scan", 101)).toBeNull();
    await release(env, "scan", "wrong");
    expect(await lease(env, "scan", 102)).toBeNull();
    await release(env, "scan", a!);
    expect(await lease(env, "scan", 103)).toBeTruthy();
  });
  it("prevents a superseded or expired scan owner from committing state or notifications", async () => {
    const owner = await lease(env, "scan", 100000);
    const snapshot = await read(env);
    expect(
      await commit(
        env,
        snapshot,
        [{ id: "fenced", kind: "system", body: "no" }],
        100000,
        undefined,
        { owner: "wrong", now: 100001 },
      ),
    ).toBe(false);
    expect(
      await commit(env, snapshot, [], 100000, undefined, {
        owner: owner!,
        now: 160000,
      }),
    ).toBe(false);
    expect(
      await env.DB.prepare("SELECT id FROM outbox WHERE id='fenced'").first(),
    ).toBeNull();
    await release(env, "scan", owner!);
  });
  it("rejects wrong secrets and ignores non-owner messages", async () => {
    const request = (secret: string, user: number) =>
      new Request("https://bot/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify({
          update_id: 100,
          message: {
            text: "/pause all",
            from: { id: user },
            chat: { id: 1, type: "private" },
          },
        }),
      });
    expect((await webhook(request("bad", 1), env)).status).toBe(403);
    expect((await webhook(request("secret", 2), env)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM updates WHERE id=100").first(),
    ).toBeNull();
    expect((await webhook(request("secret", 1), env)).status).toBe(200);
    const revision = (await read(env)).revision;
    await webhook(request("secret", 1), env);
    expect((await read(env)).revision).toBe(revision);
  });
});
