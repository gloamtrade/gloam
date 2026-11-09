import type { Metadata } from "next";

// Short claim links (gloam.trade/c#...). The payment is in the fragment, so
// link previews and the server never see it; the page is /claim's.
export const metadata: Metadata = {
  title: "You've been sent a private payment",
  description: "Open it in Gloam to claim it. Only you will see the amount.",
  alternates: { canonical: "/claim" },
  robots: { index: false, follow: false },
  openGraph: {
    title: "You've been sent a private payment",
    description: "Open it in Gloam to claim it. Only you will see the amount.",
  },
  twitter: {
    card: "summary_large_image",
    title: "You've been sent a private payment",
    description: "Open it in Gloam to claim it. Only you will see the amount.",
  },
};

export default function ShortClaimLayout({ children }: { children: React.ReactNode }) {
  return children;
}
