import { NextResponse, after } from "next/server";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { recordTractionEvent } from "@/lib/tractionStore";
import { cleanPath, cleanRef } from "@/lib/analyticsClean";
import { isTrackEvent } from "@/lib/trackEvents";

/** Events per IP per minute. A busy session sends a handful; the rest is noise. */
const PER_IP_PER_MIN = 60;
const MAX_BODY = 4_000;
/** Client clocks are trusted to within a day, else the server's time is used. */
const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

type Body = {
  t?: unknown;
  path?: unknown;
  ref?: unknown;
  meta?: unknown;
  ts?: unknown;
};


/** Keys whose text or number values could carry what someone paid, who, or a secret. */
const SENSITIVE_KEY =
  /amount|value|balance|price|usd|addr|wallet|account|name|label|note|memo|message|proof|secret|key|seed|ticket|email|hash|recipient|sender|verifier|^(to|from|tag|tx|ip)$|Tag$/i;

/** Numbers are kept only for ids and counts, never for anything that could be an amount. */
const NUMERIC_KEY = /^(chainId|count|[a-z]+Count)$/;

/** Values that look like an address, hash, Gloam address, or a long hex/base64 blob. */
const SENSITIVE_VALUE = /0x[0-9a-f]{8,}|gloamr1|[A-Za-z0-9+/_-]{40,}/i;

/**
 * Meta is kinds, counts, chain ids and booleans only. Anything that could be an
 * amount, a name, an address, a label, a note or a proof is dropped here even
 * if a client sends it.
 */
function cleanMeta(raw: unknown): Record<string, string | number | boolean | null> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 12) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) continue;
    if (typeof v === "boolean" || v === null) {
      out[k] = v;
    } else if (typeof v === "number") {
      if (!NUMERIC_KEY.test(k) || !Number.isSafeInteger(v)) continue;
      out[k] = v;
    } else if (typeof v === "string") {
      if (SENSITIVE_KEY.test(k) || SENSITIVE_VALUE.test(v)) continue;
      out[k] = v.slice(0, 40);
    } else {
      continue;
    }
    n++;
  }
  return n > 0 ? out : null;
}

/**
 * First-party analytics intake.
 * Persists to traction store (memory + optional Upstash Redis).
 * Optional TRACTION_WEBHOOK_URL for Discord/Slack.
 */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "collect", PER_IP_PER_MIN);
  if (!rate.allowed) {
    return NextResponse.json({ ok: false }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
  }
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return NextResponse.json({ ok: false }, { status: 413 });
    let data: Body | null = null;
    try {
      data = JSON.parse(raw) as Body | null;
    } catch {
      data = null;
    }
    // only the events the app sends (lib/trackEvents), so the counters hold nothing else
    if (!data || typeof data !== "object" || !isTrackEvent(data.t)) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    const meta = cleanMeta(data.meta);
    // Recording demo (lib/demoFlag): track() already stays quiet there; this
    // catches any client that tags instead of skipping.
    if (meta?.demo === true) {
      return NextResponse.json({ ok: true, skipped: "demo" });
    }

    const event = {
      t: data.t,
      path: cleanPath(data.path),
      ref: cleanRef(data.ref),
      meta,
      ts:
        typeof data.ts === "number" && Number.isSafeInteger(data.ts) && Math.abs(data.ts - Date.now()) <= MAX_SKEW_MS
          ? data.ts
          : Date.now(),
      ua: req.headers.get("user-agent")?.slice(0, 160) ?? null,
    };

    console.info("gloam_traction", JSON.stringify(event));
    // stored and forwarded after the response: a pageview never waits on Redis or the webhook
    after(async () => {
      await recordTractionEvent(event).catch(() => {});

      const webhook = process.env.TRACTION_WEBHOOK_URL?.trim();
      if (webhook) {
        try {
          await fetch(webhook, {
            method: "POST",
            signal: AbortSignal.timeout(3_000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `**${event.t}** \`${event.path ?? ""}\``,
              embeds: [
                {
                  title: event.t,
                  description: event.path ?? "",
                  fields: [
                    {
                      name: "ref",
                      value: (event.ref ?? ", ").slice(0, 200),
                      inline: false,
                    },
                    {
                      name: "meta",
                      value: event.meta
                        ? JSON.stringify(event.meta).slice(0, 500)
                        : ", ",
                      inline: false,
                    },
                  ],
                  timestamp: new Date(event.ts).toISOString(),
                },
              ],
            }),
          });
        } catch {
          /* non-fatal */
        }
      }
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
