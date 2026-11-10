import { NextResponse, after } from "next/server";
import { logSafe } from "@/lib/logSafe";
import { botConfig, handleUpdate } from "@/lib/telegramBot/bot";
import { pollBuys } from "@/lib/telegramBot/buys";
import { webhookSecretOk } from "@/lib/telegramBot/rules";
import type { TgUpdate } from "@/lib/telegramBot/telegram";

/**
 * Telegram webhook for Glim, the helper bot in the Gloam group (t.me/gloamhq).
 * What it does with each update lives in lib/telegramBot/bot.ts.
 *
 * Setup, once:
 *  1. BotFather: /newbot, then /setprivacy, pick the bot, Disable (so it reads
 *     group messages, not only commands).
 *  2. Add the bot to the group as an admin with Delete messages and Ban users
 *     on (Ban users also covers mutes). It moderates spam silently with them;
 *     /report says when Telegram refuses one.
 *  3. Set on Vercel: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (any long
 *     random string), ANTHROPIC_API_KEY, and optionally TELEGRAM_GROUP_ID,
 *     TELEGRAM_ADMIN_HANDLES, TELEGRAM_OWNER_HANDLES (default dukedotsol),
 *     TELEGRAM_OWNER_IDS (wins over handles), TELEGRAM_BOT_MODEL,
 *     TELEGRAM_BOT_PERSONA, GLOAM_TESTING_OPEN, TELEGRAM_ADMIN_IDS,
 *     TELEGRAM_BOT_DAILY_ANSWERS / _CHECKS / _DMS (model calls a day; DMs
 *     default 200), and for the daily report
 *     TELEGRAM_DAILY_REPORT=true plus CRON_SECRET. Memory, counters, welcomes
 *     and bug reports use the Upstash Redis already set for the partner
 *     program. Redeploy.
 *  4. Point Telegram here, with the same token and secret in your shell:
 *       node app/scripts/telegram-webhook.mjs
 *  5. Owner: open a private chat with the bot and send /start. That lists the
 *     commands and lets the daily report find you. /report sends the last 24
 *     hours on demand. Admins can open one too.
 *
 * In private the bot talks only with the owner and the admins: they can just
 * chat with it (what people asked, bugs, drafts, how to answer a member),
 * using the group's live numbers. It never posts or acts from a private chat.
 * Private messages from anyone else get no reply at all.
 *
 * Telegram sends the secret in X-Telegram-Bot-Api-Secret-Token; anything
 * without it gets a 401. A real update gets a 200 straight away and is
 * handled after the response, so Telegram never waits on the model.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 200_000;

export async function POST(req: Request) {
  if (!webhookSecretOk(req.headers.get("x-telegram-bot-api-secret-token"), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const raw = await req.text();
  let update: TgUpdate | null = null;
  if (raw.length <= MAX_BODY) {
    try {
      update = JSON.parse(raw) as TgUpdate;
    } catch {
      update = null;
    }
  }
  if (update && typeof update.update_id === "number") {
    const u = update;
    after(async () => {
      // any update is also a chance to post new $GLOAM buys in the Buys topic (at most every 30 seconds).
      // Side by side, not one after the other: a slow answer never leaves a buy check cut off at 60 seconds.
      await Promise.all([
        handleUpdate(u).catch((e) => {
          console.error("telegram: update failed", logSafe(e));
        }),
        pollBuys(botConfig().groupId),
      ]);
    });
  }
  return NextResponse.json({ ok: true });
}
