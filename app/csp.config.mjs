import { readFileSync } from "node:fs";

/**
 * The Content-Security-Policy Gloam is moving towards. It is sent as
 * Content-Security-Policy-Report-Only (next.config.ts): browsers report what it
 * would block but block nothing, so wallets, WalletConnect, the RPCs, the
 * prover's WebAssembly and analytics keep working while the list is checked
 * against real use. Once the reports stay clean it can be enforced.
 *
 * Two groups of pages enforce a policy already: /app and the partner portal
 * with Gloam wallets on (CSP_APP_ENFORCED), and the pages that read a claim
 * code, a payment request or a proof from the address (CSP_CLAIM_ENFORCED).
 *
 * Every policy names a report endpoint (/api/csp-report, through both
 * report-uri and report-to), so violations reach the server's log instead of
 * only the visitor's console.
 *
 * connect-src must cover every RPC the app or a wallet connector calls from the
 * browser: scripts/selftest-csp.mts and scripts/selftest-claim-csp.mts fail if
 * a network or bridge origin chain uses a host that is missing here.
 */

/** Where browsers send violation reports (app/src/app/api/csp-report), and the report-to group that names it. */
export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp";
/** The Reporting-Endpoints header behind report-to (a path, read against the page's own origin). */
export const REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
/** report-uri for browsers without the Reporting API (Firefox, Safari); report-to for the rest. */
const REPORTING = [`report-uri ${CSP_REPORT_PATH}`, `report-to ${CSP_REPORT_GROUP}`];

/**
 * Every RPC a Gloam network reads from the browser (lib/networks, lib/chain):
 * each chain's RPC list, mainnet and testnet, hidden mainnets too, and Ethereum
 * Sepolia's history RPC. Elysium's come from elysiumConnectSources and
 * elysiumTestnetConnectSources below, while their switches are on.
 * scripts/selftest-claim-csp.mts loads lib/networks and fails when a network
 * reads from a host that is missing here, so a new chain cannot quietly break
 * the claim pages, which enforce this list.
 */
const GLOAM_NETWORK_RPCS = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc.testnet.chain.robinhood.com",
  "https://rpc.tempo.xyz",
  "https://rpc.moderato.tempo.xyz",
  "https://base-sepolia-rpc.publicnode.com",
  "https://sepolia.base.org",
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  // Ethereum mainnet reads through MEV Blocker, with publicnode behind it
  "https://rpc.mevblocker.io",
  "https://ethereum-rpc.publicnode.com",
  // Ethereum Sepolia reads through publicnode (at the head), and logs and state
  // older than 9,000 blocks through Tenderly's gateway (it keeps the whole history)
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.gateway.tenderly.co",
];

/** Gloam's own networks and Tempo testnet's fee sponsor (the app's sends). */
const GLOAM_RPCS = [...GLOAM_NETWORK_RPCS, "https://sponsor.moderato.tempo.xyz"];

/** Default RPCs of the chains a private bridge order can be paid from (lib/originChains). */
const ORIGIN_RPCS = [
  "https://56.rpc.thirdweb.com",
  "https://api.avax.network",
  "https://arb1.arbitrum.io",
  "https://ethereum.reth.rs",
  "https://forno.celo.org",
  "https://mainnet.base.org",
  "https://mainnet.era.zksync.io",
  "wss://mainnet.era.zksync.io",
  "https://mainnet.optimism.io",
  "https://mainnet.unichain.org",
  "https://polygon.drpc.org",
  "https://rpc-gel.inkonchain.com",
  "wss://rpc-gel.inkonchain.com",
  "https://rpc-qnd.inkonchain.com",
  "wss://rpc-qnd.inkonchain.com",
  "https://rpc.berachain.com",
  "https://rpc.blast.io",
  "https://rpc.gnosischain.com",
  "wss://rpc.gnosischain.com",
  "https://rpc.hyperliquid.xyz",
  "https://rpc.linea.build",
  "wss://rpc.linea.build",
  "https://rpc.mantle.xyz",
  "https://rpc.monad.xyz",
  "wss://rpc.monad.xyz",
  "https://rpc1.monad.xyz",
  "wss://rpc1.monad.xyz",
  "https://rpc.scroll.io",
  "wss://wss-rpc.scroll.io",
  "https://rpc.soniclabs.com",
  "https://worldchain-mainnet.g.alchemy.com",
  "https://xlayerrpc.okx.com",
];

/** Solana, for bridge deposits paid from a Solana wallet. */
const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];

/** Wallet connectors and the services the app reads from the browser. */
const SERVICES = [
  "https://*.walletconnect.org",
  "https://*.walletconnect.com",
  "wss://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "https://api.web3modal.org",
  "https://*.reown.com",
  // Gloam wallets (Turnkey): api, authproxy, and the success animation the sign-in sheet loads.
  // Continue with Google needs no entry of its own: accounts.google.com only ever opens
  // as a popup window (a navigation, which no directive here covers), Google hands the
  // token back in the popup's address on our own origin, and the
  // token goes to Turnkey's authproxy, which is listed here. The page never fetches from,
  // frames or loads a script from Google. Add a Google host only if that changes.
  "https://*.turnkey.com",
  "https://lottie.host",
  "https://wallet.tempo.xyz",
  "https://tokenlist.tempo.xyz",
  "https://api.relay.link",
  "https://api.dexscreener.com",
  "https://va.vercel-scripts.com",
];

/**
 * Elysium mainnet's RPC, while NEXT_PUBLIC_ELYSIUM_ENABLED is on, which it is
 * unless set to "0", "false", "off" or "no" (lib/elysium.ts elysiumFlagFrom):
 * from NEXT_PUBLIC_ELYSIUM_RPC_URL, else the rpcUrl written in the SDK's config
 * (packages/sdk/src/elysium.ts), the same order lib/elysium.ts reads them in.
 * Its origin only. Empty while the flag is off or no RPC is set.
 */
export function elysiumConnectSources(env = process.env) {
  if (/^(0|false|off|no)$/i.test((env.NEXT_PUBLIC_ELYSIUM_ENABLED ?? "").trim())) return [];
  let url = env.NEXT_PUBLIC_ELYSIUM_RPC_URL?.trim() || null;
  if (!url) {
    try {
      // Only ELYSIUM_MAINNET's block: the file's ELYSIUM_TESTNET has an rpcUrl too.
      const src = readFileSync(new URL("../packages/sdk/src/elysium.ts", import.meta.url), "utf8");
      const block = /export const ELYSIUM_MAINNET\b[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
      url = /^\s*rpcUrl:\s*"(https:\/\/[^"]+)",\s*$/m.exec(block)?.[1] ?? null;
    } catch {
      url = null;
    }
  }
  try {
    const u = url ? new URL(url) : null;
    return u && u.protocol === "https:" ? [u.origin] : [];
  } catch {
    return [];
  }
}

/**
 * Elysium testnet's RPCs, only while NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED is on:
 * Kinetiq's and Conduit's (packages/sdk/src/elysium.ts), and
 * NEXT_PUBLIC_ELYSIUM_TESTNET_RPC_URL's origin if it is set.
 */
export function elysiumTestnetConnectSources(env = process.env) {
  if (!/^(1|true|on|yes)$/i.test((env.NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED ?? "").trim())) return [];
  const out = ["https://testnet-rpc.elysium.kinetiq.xyz", "https://rpc-elysium-testnet.t.conduit.xyz"];
  try {
    const custom = env.NEXT_PUBLIC_ELYSIUM_TESTNET_RPC_URL?.trim();
    const u = custom ? new URL(custom) : null;
    if (u && u.protocol === "https:" && !out.includes(u.origin)) out.push(u.origin);
  } catch {
    // not a URL: lib/elysium.ts fails the build on it
  }
  return out;
}

/**
 * The origin of every NEXT_PUBLIC_*_RPC_URL set for this build: an RPC an
 * environment variable points the browser at (NEXT_PUBLIC_ELYSIUM_RPC_URL with
 * a keyed provider, say), so an override set on Vercel cannot break a page
 * that enforces connect-src. The origin only: a key in the path never reaches
 * the header. Values that are not https or wss URLs are left out (the app's own
 * config check refuses them).
 */
export function rpcOverrideSources(env = process.env) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (!/^NEXT_PUBLIC_[A-Z0-9_]*RPC_URL$/.test(name) || typeof value !== "string" || !value.trim()) continue;
    try {
      const u = new URL(value.trim());
      if (u.protocol === "https:" || u.protocol === "wss:") out.push(u.origin);
    } catch {
      // not a URL
    }
  }
  return out.sort();
}

const unique = (list) => [...new Set(list)];

export const CSP_CONNECT_SOURCES = unique([
  "'self'",
  ...GLOAM_RPCS,
  ...elysiumConnectSources(),
  ...elysiumTestnetConnectSources(),
  ...rpcOverrideSources(),
  ...ORIGIN_RPCS,
  ...SOLANA_RPCS,
  ...SERVICES,
]);

const FRAMES = ["'self'", "https://*.walletconnect.org", "https://*.walletconnect.com", "https://*.turnkey.com", "https://wallet.tempo.xyz"];

export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  // Next's inline bootstrap scripts need 'unsafe-inline' until nonces are wired; the prover needs WebAssembly
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${CSP_CONNECT_SOURCES.join(" ")}`,
  `frame-src ${FRAMES.join(" ")}`,
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...REPORTING,
].join("; ");

/**
 * Enforced on /app while Gloam wallets are on (NEXT_PUBLIC_TURNKEY_ENABLED with both
 * ids, production builds only: dev reloads code with eval). A Gloam wallet signs with
 * no prompt, so a script that got into the page could send from it; this policy
 * stops the page loading scripts, frames or workers from any host not listed, and
 * talking to any host not listed.
 *
 * Still open, until Next's inline scripts carry nonces: 'unsafe-inline' for scripts,
 * so markup injected into the page could still run inline code. Styles, images and
 * fonts stay as they are (the Report-Only policy covers them).
 */
export const CSP_APP_ENFORCED = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://va.vercel-scripts.com",
  `connect-src ${CSP_CONNECT_SOURCES.join(" ")}`,
  `frame-src ${FRAMES.join(" ")}`,
  "worker-src 'self' blob:",
  ...REPORTING,
].join("; ");

/**
 * The pages that read a bearer secret, or something close to one, from their
 * own address: /c and /claim (a claim code in the fragment: whoever holds it
 * can take the payment), /r (a payment request) and /verify (a proof). Whatever
 * runs there can read the fragment, so these pages enforce the tightest policy
 * they work under, in production builds, with or without Gloam wallets.
 *
 * What the pages load (checked in a browser against a production build):
 * their own scripts, styles, fonts and images, Gloam's API (/api/relay,
 * /api/funnel, /api/collect) and Vercel Analytics (/_vercel, same origin, after
 * consent); /verify also reads the vault on every Gloam network over RPC and
 * checks a proof with snarkjs, which compiles WebAssembly and runs it in
 * workers made from blob: URLs. No wallet connector, no frame, no other host.
 * The claim itself (proving, signing) happens in /app, under its own policy.
 *
 * connect-src is the Gloam networks' RPCs only (GLOAM_NETWORK_RPCS, Elysium's
 * while its switches are on, and any NEXT_PUBLIC_*_RPC_URL override), never
 * the bridge chains, Solana, WalletConnect or Turnkey. /c, /claim and /r read
 * no RPC today; they keep the list so a check added to the claim page later
 * (is this payment still unclaimed?) does not break a claim.
 *
 * Still open, as on /app: 'unsafe-inline' for scripts. Next's App Router
 * writes its bootstrap and page data as inline scripts, and they would need a
 * nonce on every request (dynamic rendering, through a proxy). What the policy
 * does stop: a script from any other host, a connection to any host not
 * listed, an image, font or stylesheet from another host (CSS can read an
 * attribute such as the Claim link's href and send it out as an image
 * request), framing, plugins, <base> and form posts elsewhere. No policy stops
 * a script that already runs from sending the tab to another site.
 */
export function claimPagesCsp(env = process.env) {
  const connect = unique([
    "'self'",
    ...GLOAM_NETWORK_RPCS,
    ...elysiumConnectSources(env),
    ...elysiumTestnetConnectSources(env),
    ...rpcOverrideSources(env),
  ]);
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    ...REPORTING,
  ].join("; ");
}

export const CSP_CLAIM_ENFORCED = claimPagesCsp();

/** The pages CSP_CLAIM_ENFORCED covers, each with everything under it (next.config.ts). */
export const CLAIM_PAGE_SOURCES = ["/c/:path*", "/claim/:path*", "/r/:path*", "/verify/:path*"];

/** Gloam wallets are switched on for this build (the same rule as lib/embeddedWallet). */
export function embeddedWalletsBuild(env = process.env) {
  return (
    env.NEXT_PUBLIC_TURNKEY_ENABLED?.trim() === "true" &&
    Boolean(env.NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID?.trim()) &&
    Boolean(env.NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID?.trim())
  );
}
