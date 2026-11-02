// Run locally with Node's --env-file=.dev.vars. Never prints the bot token.
const { TELEGRAM_TOKEN, TELEGRAM_WEBHOOK_SECRET } = process.env;
const origin = process.argv[2];
if (!TELEGRAM_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !origin)
  throw new Error(
    "Usage: node --env-file=.dev.vars scripts/register-webhook.mjs https://YOUR-WORKER.workers.dev",
  );
const url = new URL("/telegram/webhook", origin);
if (url.protocol !== "https:" || url.username || url.password)
  throw new Error("Use a plain HTTPS Worker origin.");
let response, result;
try {
  response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.href,
        secret_token: TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
        max_connections: 1,
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  result = await response.json();
} catch {
  throw new Error(
    "Webhook registration could not reach Telegram. Check connectivity; credentials were not logged.",
  );
}
if (!response.ok || !result.ok)
  throw new Error(
    `Webhook registration failed (HTTP ${response.status}). Check credentials and URL.`,
  );
console.log("Webhook registered for", url.origin);
