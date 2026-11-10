import type { Metadata, Viewport } from "next";
import { Analytics } from "@/components/Analytics";
import { AnnouncementBanner } from "@/components/AnnouncementBanner";
import { CookieBanner } from "@/components/CookieBanner";
import { SkipLink } from "@/components/SkipLink";
import { ThemeProvider } from "@/components/ThemeProvider";
import { VercelAnalytics } from "@/components/VercelAnalytics";
import { DEVICE_BOOT_SCRIPT } from "@/lib/device";
import { liveMainnetNames } from "@/lib/mainnet";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const siteTitle = "Gloam · Private money on public chains";
// Fixed at build time: names every mainnet with a pool in (lib/mainnet.ts).
const siteDescription = `Private stablecoin payments for people, teams and agents. Hold, pay and run payroll without putting amounts or balances on the public record, and prove only what someone needs to see. On ${liveMainnetNames()} mainnet, and on testnets to try it first.`;

/**
 * The live host is www (the apex redirects there), so absolute URLs in link
 * previews point straight at it. Open Graph and Twitter carry no title or
 * description here on purpose: Next fills them from each page's own title and
 * description, and the share image comes from opengraph-image.tsx. Pages set
 * their own canonical; one here would point every page at the home page.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://www.gloam.trade"),
  title: {
    default: siteTitle,
    template: "%s · Gloam",
  },
  description: siteDescription,
  applicationName: "Gloam",
  authors: [{ name: "Gloam", url: "https://gloam.trade" }],
  creator: "Gloam",
  keywords: [
    "Gloam",
    "private payments",
    "private payroll",
    "stablecoin privacy",
    "Robinhood Chain",
    "Tempo",
    "USDG",
    "agent payments",
    "x402",
  ],
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    siteName: "Gloam",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: "@gloamtrade",
    creator: "@gloamtrade",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090c" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <meta
          name="ory-verify"
          content="orynth-d061bf2ee92a4996b6e3121097472653"
        />
        {/* Main typeface: Aeonik, self-hosted woff2 (see globals.css @font-face). */}
        <link
          rel="preload"
          href="/fonts/Aeonik-Regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        <link
          rel="preload"
          href="/fonts/Aeonik-Light.woff2"
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        {/* The app reads these chains on every load: open the connections early. */}
        <link rel="preconnect" href="https://rpc.mainnet.chain.robinhood.com" crossOrigin="" />
        <link rel="preconnect" href="https://rpc.tempo.xyz" crossOrigin="" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: DEVICE_BOOT_SCRIPT }} />
      </head>
      <body
        className="flex min-h-full flex-col bg-background text-foreground"
        style={{ fontFamily: '"Aeonik", system-ui, sans-serif' }}
      >
        <ThemeProvider>
          <SkipLink />
          <AnnouncementBanner />
          {children}
          <CookieBanner />
          <Analytics />
        </ThemeProvider>
        <VercelAnalytics />
      </body>
    </html>
  );
}
