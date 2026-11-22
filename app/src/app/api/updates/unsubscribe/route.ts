import { NextResponse } from "next/server";
import { KvUnavailableError } from "@/lib/partnersKv";
import { unsubscribeToken } from "@/lib/updatesList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A form this size or bigger isn't an unsubscribe: the body is skipped. */
const MAX_FORM = 4_000;

const noStore = { "Cache-Control": "no-store" };

/**
 * One-click unsubscribe (RFC 8058). Every update carries
 *   List-Unsubscribe: <https://www.gloam.trade/api/updates/unsubscribe?token=...>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * and a mail app's own Unsubscribe button POSTs here with the body
 * List-Unsubscribe=One-Click: the person is off the list, no page, no login.
 *
 * The /unsubscribe page's button posts here too, with `token` and `from=page`
 * in the form, and is sent back to the page. A GET (a link checker, or a mail
 * app that opens the address) never unsubscribes: it goes to the page, which asks.
 *
 * Every answer is the same whether the token was live, so nothing here tells
 * anyone who is on the list.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  let token = url.searchParams.get("token") ?? url.searchParams.get("t") ?? "";
  let fromPage = false;

  const type = req.headers.get("content-type") ?? "";
  const size = Number(req.headers.get("content-length") ?? "0");
  if (/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type) && size < MAX_FORM) {
    try {
      const form = await req.formData();
      fromPage = form.get("from") === "page";
      const t = form.get("token");
      if (!token && typeof t === "string") token = t;
    } catch {
      // a body we can't read: the token in the address is enough
    }
  }

  try {
    if (token) await unsubscribeToken(token);
  } catch (e) {
    if (!(e instanceof KvUnavailableError)) console.warn("gloam_unsubscribe_failed");
    if (fromPage) {
      const back = new URL("/unsubscribe", req.url);
      back.searchParams.set("token", token);
      back.searchParams.set("error", "1");
      return NextResponse.redirect(back, { status: 303, headers: noStore });
    }
    return new Response("We couldn't reach the list. Try again in a minute.\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60", ...noStore },
    });
  }

  if (fromPage) return NextResponse.redirect(new URL("/unsubscribe?done=1", req.url), { status: 303, headers: noStore });
  return new Response("You're unsubscribed from Gloam updates.\n", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...noStore },
  });
}

/** Opening the address in a browser: the page asks before anything changes. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? url.searchParams.get("t") ?? "";
  const page = new URL("/unsubscribe", req.url);
  if (token) page.searchParams.set("token", token);
  return NextResponse.redirect(page, { status: 303, headers: noStore });
}
