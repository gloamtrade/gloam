import type { NextConfig } from "next";
import path from "node:path";
import { CSP_APP_ENFORCED, CSP_REPORT_ONLY, embeddedWalletsBuild } from "./csp.config.mjs";

/**
 * When this package is the Vercel Root Directory (`app`), keep tracing
 * inside the monorepo without pointing output at a broken `.next` path.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, ".."),
  // Compile the workspace SDK from source so there is no build-order dependency
  // (Vercel builds only `app`). @gloamtrade/sdk exports TS source; Next transpiles it.
  transpilePackages: ["@gloamtrade/sdk"],
  // no "X-Powered-By: Next.js" on responses
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
  },
  // Every response gets the basics. Framing is refused everywhere but the pitch
  // deck (a static page that may be embedded). The enforced CSP only covers
  // framing, plugins, <base> and form targets. The fuller policy (script and
  // connect sources, csp.config.mjs) is sent Report-Only first: browsers log what
  // it would block without blocking anything, so wallet connectors, the
  // prover's WebAssembly and analytics keep working while it is checked.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
        ],
      },
      {
        // A Wallet X-ray page has the wallet in its path. Search engines stay out of
        // the page and its preview image, and nothing it links to learns the address.
        // Not a robots.txt rule: that would stop X's crawler reading the preview card.
        source: "/xray/:wallet+",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // proving files: a day in the browser and on the CDN. The integrity check
        // revalidates each one (lib/circuitArtifacts), so a regenerated file is still caught.
        source: "/circuits/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        source: "/((?!pitch).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
          },
          // production only: dev builds evaluate code for hot reload and would flood the console
          ...(process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY }] : []),
        ],
      },
      // Gloam wallets sign with no prompt: with them on, /app and the partner portal
      // (email sign-in) enforce where scripts, frames, workers and connections may
      // come from (csp.config.mjs). Last, so it replaces the framing-only policy above
      // on these pages.
      ...(process.env.NODE_ENV === "production" && embeddedWalletsBuild()
        ? [
            { source: "/app/:path*", headers: [{ key: "Content-Security-Policy", value: CSP_APP_ENFORCED }] },
            { source: "/partners/dashboard/:path*", headers: [{ key: "Content-Security-Policy", value: CSP_APP_ENFORCED }] },
          ]
        : []),
    ];
  },
  // The pitch deck is one static page in public/pitch.
  async rewrites() {
    return [
      { source: "/pitch", destination: "/pitch/index.html" },
      { source: "/pitch/report", destination: "/pitch/report.html" },
    ];
  },
  webpack: (config) => {
    // WalletConnect optional deps — silence missing optional modules
    config.externals.push("pino-pretty", "encoding");
    // Two libraries import a module by a computed name: web-worker's Node shim
    // (under snarkjs) and ox's Tempo address miner (worker_threads). Webpack can't
    // follow either and says so on every build; dropping the notice changes nothing
    // in the output. Only these two are dropped, so a new one from anywhere else shows.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /node_modules[\\/](web-worker[\\/]cjs[\\/]node\.js|ox[\\/]_esm[\\/]tempo[\\/]internal[\\/]virtualMasterPool\.js)/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ];
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    // @gloamtrade/sdk ships NodeNext TS source (".js" import specifiers). Let webpack
    // resolve those to the ".ts" sources when transpiling the workspace package.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
