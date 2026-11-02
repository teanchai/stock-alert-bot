// Read-only diagnostics. Outputs configuration checks, never credentials.
const names = [
  "ALPACA_KEY",
  "ALPACA_SECRET",
  "TELEGRAM_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "OWNER_USER_ID",
  "OWNER_CHAT_ID",
];
const env = process.env;
function output(value) {
  let text = JSON.stringify(value);
  for (const name of names)
    if (env[name]) text = text.split(env[name]).join("[redacted]");
  console.log(text);
}
output({
  configuration: Object.fromEntries(
    names.map((name) => [
      name,
      {
        present: Boolean(env[name]),
        whitespace: env[name] !== env[name]?.trim(),
        placeholder: /your-|ใส่|generate-a-long/.test(env[name] ?? ""),
      },
    ]),
  ),
});
output({
  ownerUserNumeric: /^\d+$/.test(env.OWNER_USER_ID ?? ""),
  ownerChatNumeric: /^\d+$/.test(env.OWNER_CHAT_ID ?? ""),
  webhookSecretValid: /^[A-Za-z0-9_-]{1,256}$/.test(
    env.TELEGRAM_WEBHOOK_SECRET ?? "",
  ),
});
async function telegram(method, body = {}) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await response.json();
    if (!data.ok) {
      output({ method, status: response.status, error: data.description });
      return null;
    }
    return data.result;
  } catch {
    output({ method, error: "network_or_response_error" });
    return null;
  }
}
if (env.TELEGRAM_TOKEN) {
  const bot = await telegram("getMe");
  if (bot)
    output({
      botUsername: bot.username,
      botTokenValid: true,
      ownerUserIsBotId: String(bot.id) === env.OWNER_USER_ID,
    });
  const webhook = await telegram("getWebhookInfo");
  if (webhook)
    output({
      webhookUrl: webhook.url,
      pendingUpdates: webhook.pending_update_count,
      lastError: webhook.last_error_message,
      lastErrorDate: webhook.last_error_date,
      allowedUpdates: webhook.allowed_updates,
    });
  if (env.OWNER_CHAT_ID) {
    const chat = await telegram("getChat", { chat_id: env.OWNER_CHAT_ID });
    if (chat)
      output({
        configuredChatExists: true,
        chatType: chat.type,
        chatName: chat.first_name,
        chatUsername: chat.username,
        configuredOwnerMatchesPrivateChat:
          chat.type === "private" && String(chat.id) === env.OWNER_USER_ID,
      });
  }
  if (env.OWNER_USER_ID && env.OWNER_USER_ID !== env.OWNER_CHAT_ID) {
    const owner = await telegram("getChat", { chat_id: env.OWNER_USER_ID });
    if (owner)
      output({
        configuredOwnerChatExists: true,
        ownerChatType: owner.type,
        ownerName: owner.first_name,
        ownerUsername: owner.username,
      });
  }
}
