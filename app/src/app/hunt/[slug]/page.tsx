import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { HuntGate } from "@/components/hunt/HuntGate";
import { countHuntStep, huntPagePath, huntRiddle, huntSubject } from "@/lib/hunt";
import { hitRateLimit } from "@/lib/mcpRemote/rateLimit";

/**
 * The treasure hunt's hidden page (lib/hunt). It answers only at the one path set
 * in the server environment, read on each request, so the path is never in a
 * build file or a script sent to the browser. Every other path here is a plain
 * 404, and with the hunt off so is that one.
 */
export const dynamic = "force-dynamic";

const VISITS_PER_MINUTE = 20;

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function HuntPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const riddle = huntRiddle();
  if (!riddle || slug !== huntPagePath()) notFound();
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "local";
  if ((await hitRateLimit(ip, "hunt-visit", VISITS_PER_MINUTE)).allowed) await countHuntStep("page", huntSubject("ip", ip));
  return (
    <div className="min-h-screen bg-panel text-foreground">
      <Header />
      <main className="mx-auto max-w-[640px] px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
        <HuntGate title={riddle.title} riddle={riddle.riddle} />
      </main>
    </div>
  );
}
