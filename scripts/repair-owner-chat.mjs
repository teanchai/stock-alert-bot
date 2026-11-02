// Repair only the verified setup mistake: destination chat was the bot itself.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const { TELEGRAM_TOKEN, OWNER_USER_ID, OWNER_CHAT_ID } = process.env;
async function lookup(method, body = {}) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = await response.json();
    if (!result.ok) throw new Error();
    return result.result;
  } catch {
    throw new Error("Telegram verification failed; no changes made.");
  }
}
const bot = await lookup("getMe");
const owner = await lookup("getChat", { chat_id: OWNER_USER_ID });
if (
  !/^\d+$/.test(OWNER_USER_ID ?? "") ||
  String(bot.id) !== OWNER_CHAT_ID ||
  String(owner.id) !== OWNER_USER_ID ||
  owner.type !== "private" ||
  owner.id === bot.id
)
  throw new Error(
    "Expected bot-as-destination mistake not verified; no changes made.",
  );
const path = ".dev.vars";
const contents = readFileSync(path, "utf8");
if ((contents.match(/^OWNER_CHAT_ID=.*$/gm) ?? []).length !== 1)
  throw new Error(
    "Expected exactly one OWNER_CHAT_ID assignment; no changes made.",
  );
writeFileSync(
  path,
  contents.replace(/^OWNER_CHAT_ID=.*$/m, `OWNER_CHAT_ID=${OWNER_USER_ID}`),
);
console.log(
  "Local destination corrected to the existing owner; owner authorization unchanged.",
);
const result = spawnSync(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "secret", "put", "OWNER_CHAT_ID"],
  {
    input: OWNER_USER_ID + "\n",
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
let log = (result.stdout ?? "") + (result.stderr ?? "");
for (const key of [
  "ALPACA_KEY",
  "ALPACA_SECRET",
  "TELEGRAM_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "OWNER_USER_ID",
  "OWNER_CHAT_ID",
])
  if (process.env[key]) log = log.split(process.env[key]).join("[redacted]");
console.log(log);
if (result.status !== 0) {
  console.error(
    "Remote update failed; local correction remains. Re-run wrangler secret put OWNER_CHAT_ID securely.",
  );
  process.exit(1);
}
