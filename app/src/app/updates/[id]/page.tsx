import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { UpdateBody } from "@/components/updates/UpdateBody";
import { UPDATE_ID, getPublishedUpdate, type PublicUpdate } from "@/lib/updatesMail";
import { fmtDay, parseMarkdown, summaryOf } from "@/lib/updatesMailRender";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** The update, or null when there is none, or undefined when the store didn't answer. */
async function load(id: string): Promise<PublicUpdate | null | undefined> {
  if (!UPDATE_ID.test(id)) return null;
  try {
    return await getPublishedUpdate(id);
  } catch {
    return undefined;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const u = await load(id);
  if (!u) return { title: "Update", robots: { index: false, follow: true } };
  const description = summaryOf(parseMarkdown(u.body));
  return {
    title: u.subject,
    description,
    alternates: { canonical: `/updates/${u.id}` },
    openGraph: { title: u.subject, description, url: `/updates/${u.id}`, siteName: "Gloam", type: "article", publishedTime: u.day },
  };
}

/**
 * The web version of one update, linked from the footer of the email. The
 * subject, the day and the body: nothing about who it went to.
 */
export default async function UpdatePage({ params }: Props) {
  const { id } = await params;
  const u = await load(id);
  if (u === null) notFound();

  return (
    <>
      <Header />
      <main className="mx-auto max-w-[720px] px-6">
        <article className="pt-8 sm:pt-14">
          <Link
            href="/updates"
            className="-ml-2 inline-flex h-10 items-center gap-1.5 rounded-full px-2 text-[14px] text-mute transition-colors hover:text-foreground"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M9.5 3.5L5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Updates
          </Link>
          {u === undefined ? (
            <p className="mt-8 rounded-[14px] bg-surface px-4 py-3 text-[15px] text-mute" role="status">
              This update couldn&apos;t load just now. Try again in a moment.
            </p>
          ) : (
            <>
              <time dateTime={u.day} className="tnum mt-8 block text-[14px] text-mute">
                {fmtDay(u.day)}
              </time>
              <h1 className="t-display-l mt-3 text-balance">{u.subject}</h1>
              <div className="mt-10">
                <UpdateBody body={u.body} />
              </div>
              <p className="mt-14 border-t border-line pt-6 text-[14px] leading-relaxed text-mute">
                This went to everyone on the Gloam updates list. To get the next one, add your email at the bottom of this page.
              </p>
            </>
          )}
        </article>
      </main>
      <Footer />
    </>
  );
}
