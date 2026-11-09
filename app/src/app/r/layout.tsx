import type { Metadata } from "next";

// Short payment request links (gloam.trade/r#...). The request is in the
// fragment, so link previews and the server never see it.
export const metadata: Metadata = {
  title: "A payment request on Gloam",
  description: "Open it in Gloam to pay privately.",
  robots: { index: false, follow: false },
};

export default function ShortRequestLayout({ children }: { children: React.ReactNode }) {
  return children;
}
