import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { KvUnavailableError } from "@/lib/partnersKv";
import { unsubscribeToken } from "@/lib/updatesList";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};

/**
 * The link at the bottom of every Gloam update: opening it takes that email off
 * the updates list (lib/updatesList). A link that was used already, or never
 * existed, says the same thing, so the page tells nobody who is on the list.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  const t = typeof token === "string" ? token : "";
  let state: "done" | "missing" | "error" = t ? "done" : "missing";
  if (t) {
    try {
      await unsubscribeToken(t);
    } catch (e) {
      state = "error";
      if (!(e instanceof KvUnavailableError)) console.warn("gloam_unsubscribe_failed");
    }
  }

  return (
    <div className="min-h-screen bg-panel text-foreground">
      <Header />
      <main className="mx-auto max-w-[720px] px-6 pb-8 pt-16 sm:pt-24">
        <h1 className="t-display-m">
          {state === "done" ? "You're unsubscribed" : state === "error" ? "That didn't go through" : "Unsubscribe"}
        </h1>
        <p className="mt-5 max-w-[52ch] text-[16px] leading-relaxed text-soft">
          {state === "done"
            ? "This email is off the Gloam updates list. You won't get any more updates from us."
            : state === "error"
              ? "We couldn't reach the list just now. Open the link again in a minute, or write to hello@gloam.trade and we'll take you off."
              : "Open the unsubscribe link from any Gloam update to leave the list. You can also leave it in the app under Settings."}
        </p>
        <div className="mt-8 flex flex-wrap gap-2">
          <Link href="/" className="btn btn-ghost">
            Back to home
          </Link>
          <Link href="/privacy" className="btn btn-quiet text-mute">
            Privacy Policy
          </Link>
        </div>
      </main>
    </div>
  );
}
