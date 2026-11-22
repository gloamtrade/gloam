import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { listPublishedUpdates, type PublicUpdate } from "@/lib/updatesMail";
import { fmtDay, parseMarkdown, summaryOf } from "@/lib/updatesMailRender";

export const dynamic = "force-dynamic";

const title = "Updates";
const description = "Every Gloam update we've emailed to the updates list, to read on the web.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/updates" },
  openGraph: { title: "Gloam updates", description, url: "/updates", siteName: "Gloam", type: "website" },
};

/** The updates sent to the email list, newest first (lib/updatesMail). */
export default async function UpdatesPage() {
  let updates: PublicUpdate[] | null;
  try {
    updates = await listPublishedUpdates();
  } catch {
    updates = null;
  }

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[720px] px-6">
        <header className="pt-12 sm:pt-20">
          <h1 className="t-display-l">Updates</h1>
          <p className="mt-5 max-w-[52ch] text-[18px] leading-relaxed text-soft">
            What we&apos;ve sent to the Gloam updates list. To get the next one by email, add yours at the bottom of this page.
          </p>
        </header>

        <section aria-label="All updates" className="mt-12 sm:mt-16">
          {updates === null ? (
            <p className="rounded-[14px] bg-surface px-4 py-3 text-[15px] text-mute" role="status">
              The updates couldn&apos;t load just now. Try again in a moment.
            </p>
          ) : updates.length === 0 ? (
            <p className="border-t border-line py-6 text-[15px] text-mute">No updates yet. The first one will show up here once it goes out.</p>
          ) : (
            <ul>
              {updates.map((u) => (
                <li key={u.id} className="border-t border-line last:border-b">
                  <Link href={`/updates/${u.id}`} className="group block py-6">
                    <time dateTime={u.day} className="tnum text-[13px] text-mute">
                      {fmtDay(u.day)}
                    </time>
                    <span className="mt-1.5 block text-[19px] leading-snug text-foreground group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-4">
                      {u.subject}
                    </span>
                    <span className="mt-1.5 block max-w-[60ch] text-[15px] leading-relaxed text-mute">{summaryOf(parseMarkdown(u.body))}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
