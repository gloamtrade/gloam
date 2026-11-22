import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};

type Params = { token?: string | string[]; t?: string | string[]; done?: string | string[]; error?: string | string[] };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * The link at the bottom of every Gloam update. Opening it asks first, and the
 * button takes that email off the updates list (api/updates/unsubscribe): mail
 * scanners open links in emails, so a page that unsubscribed on opening would
 * take people off who never asked. Mail apps' own Unsubscribe buttons skip this
 * page (one-click, RFC 8058). A link that was used already, or never existed,
 * gets the same answer, so the page tells nobody who is on the list.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const token = (one(sp.token) || one(sp.t)).slice(0, 200);
  const state: "ask" | "done" | "error" | "missing" = one(sp.done) ? "done" : !token ? "missing" : one(sp.error) ? "error" : "ask";

  const title = {
    ask: "Unsubscribe from Gloam updates?",
    done: "You're unsubscribed",
    error: "That didn't go through",
    missing: "Unsubscribe",
  }[state];
  const line = {
    ask: "This takes your email off the Gloam updates list. We won't send you any more updates.",
    done: "This email is off the Gloam updates list. You won't get any more updates from us.",
    error: "We couldn't reach the list just now. Try again in a minute, or write to hello@gloam.trade and we'll take you off.",
    missing: "Open the unsubscribe link from any Gloam update to leave the list, or write to hello@gloam.trade and we'll take you off.",
  }[state];

  return (
    <div className="min-h-screen bg-panel text-foreground">
      <Header />
      <main className="mx-auto max-w-[720px] px-6 pb-8 pt-16 sm:pt-24">
        <h1 className="t-display-m">{title}</h1>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-relaxed text-soft">{line}</p>
        <div className="mt-8 flex flex-wrap gap-2">
          {(state === "ask" || state === "error") && (
            <form method="post" action="/api/updates/unsubscribe">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="from" value="page" />
              <button type="submit" className="btn btn-ink">
                {state === "error" ? "Try again" : "Unsubscribe"}
              </button>
            </form>
          )}
          <Link href="/" className="btn btn-ghost">
            {state === "ask" ? "Keep getting updates" : "Back to home"}
          </Link>
          <Link href="/privacy" className="btn btn-quiet text-mute">
            Privacy Policy
          </Link>
        </div>
      </main>
    </div>
  );
}
