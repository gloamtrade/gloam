import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_COOKIE_MAX_AGE,
  createAdminSession,
  verifyAdminCode,
  adminCodeConfigured,
} from "@/lib/adminAuth";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { sameSiteJson } from "@/lib/partnersAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Code tries per IP: a few a minute, and a ceiling per hour, so the code can't be guessed. */
const TRIES_PER_MIN = 5;
const TRIES_PER_HOUR = 20;

export async function POST(req: Request) {
  // A JSON body from this site only, before any try is counted: another site can't
  // spend this IP's tries (the admin's own) or post a code here.
  if (!sameSiteJson(req)) {
    return NextResponse.json({ ok: false, error: "Sign in from the Gloam admin page." }, { status: 403 });
  }
  if (!adminCodeConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Admin sign-in is not configured." },
      { status: 503 },
    );
  }
  const ip = clientIp(req);
  const minute = await hitRateLimit(ip, "admin-login", TRIES_PER_MIN);
  const hour = minute.allowed ? await hitRateLimit(ip, "admin-login-h", TRIES_PER_HOUR, Date.now(), 3600) : minute;
  if (!minute.allowed || !hour.allowed) {
    const wait = Math.max(minute.retryAfterSec, hour.allowed ? 0 : hour.retryAfterSec);
    return NextResponse.json(
      { ok: false, error: "Too many tries. Wait and try again." },
      { status: 429, headers: { "Retry-After": String(wait) } },
    );
  }
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim().slice(0, 512) : "";
  if (!verifyAdminCode(code)) {
    return NextResponse.json({ ok: false, error: "Invalid code" }, { status: 401 });
  }
  const session = createAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Session failed" }, { status: 500 });
  }
  const res = NextResponse.json({ ok: true });
  // Secure cookies only on HTTPS; allow HTTP local preview without breaking login
  const secure =
    process.env.NODE_ENV === "production" &&
    process.env.ADMIN_COOKIE_INSECURE !== "true";
  res.cookies.set(ADMIN_COOKIE, session, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE,
  });
  return res;
}
