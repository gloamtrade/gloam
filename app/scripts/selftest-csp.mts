/**
 * Self-test: the Report-Only Content-Security-Policy (csp.config.mjs).
 *
 * connect-src must allow every RPC the browser can call: Gloam's own networks
 * and the chains a private bridge order can be paid from. A chain added to
 * lib/originChains or lib/wagmi without its host here fails this test, so the
 * policy can be enforced later without breaking a wallet.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-csp.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSP_APP_ENFORCED, CSP_CONNECT_SOURCES, CSP_REPORT_ONLY, embeddedWalletsBuild } from "../csp.config.mjs";
import { ORIGIN_CHAINS } from "../src/lib/originChains";
import { getNetwork, type NetworkKey } from "../src/lib/networks";

let n = 0;
function allowed(url: string): boolean {
  const u = new URL(url);
  return CSP_CONNECT_SOURCES.some((src: string) => {
    if (src === "'self'") return false;
    const s = new URL(src.replace("*.", "wildcard."));
    if (s.protocol !== u.protocol) return false;
    if (src.includes("*.")) return u.hostname.endsWith(s.hostname.replace(/^wildcard\./, "."));
    return s.host === u.host;
  });
}

for (const c of ORIGIN_CHAINS) {
  for (const url of [...c.rpcUrls.default.http, ...(c.rpcUrls.default.webSocket ?? [])]) {
    assert.ok(allowed(url), `${c.name} RPC ${url} is in connect-src`);
    n++;
  }
}

// every Gloam network's own RPCs, the hidden ones too (a mainnet waiting for its
// pool): lib/wagmi wires some from the chain object, http(chain.rpcUrls...),
// which the string check below cannot see
const KEYS: NetworkKey[] = ["robinhood", "tempo", "base", "ethereum", "robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet"];
for (const key of KEYS) {
  const net = getNetwork(key);
  for (const url of net.chain.rpcUrls.default.http) {
    assert.ok(allowed(url), `${key} RPC ${url} is in connect-src`);
    n++;
  }
  // old logs and state are read from the browser too (lib/readTransport)
  if (net.historyRpc) {
    assert.ok(allowed(net.historyRpc.url), `${key} history RPC ${net.historyRpc.url} is in connect-src`);
    n++;
  }
}

// every transport wired in lib/wagmi
const wagmi = readFileSync(new URL("../src/lib/wagmi.ts", import.meta.url), "utf8");
for (const [, url] of wagmi.matchAll(/http\("([^"]+)"/g)) {
  assert.ok(allowed(url!), `wagmi transport ${url} is in connect-src`);
  n++;
}

// WalletConnect relay and the services read from the browser
for (const url of ["wss://relay.walletconnect.org", "https://pulse.walletconnect.org", "https://api.relay.link/quote"]) {
  assert.ok(allowed(url), url);
  n++;
}

// prices come from the app's own server, so the browser reads no price API
assert.ok(!allowed("https://api.coingecko.com/api/v3/simple/price"), "no browser price API");
n++;

// nothing that would break the app if enforced by mistake, and nothing wide open
assert.ok(CSP_REPORT_ONLY.includes("'wasm-unsafe-eval'"), "the prover's WebAssembly is allowed");
assert.ok(!/connect-src[^;]*\s(https:|wss:|\*)(\s|;|$)/.test(CSP_REPORT_ONLY), "connect-src is a list, not every https host");
assert.ok(!CSP_REPORT_ONLY.includes("report-uri"), "no report endpoint: reports go to the browser console");
n += 3;

// next.config sends it Report-Only, next to the enforced framing policy
const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
assert.ok(config.includes('key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY'));
assert.ok(/NODE_ENV === "production" \? \[\{ key: "Content-Security-Policy-Report-Only"/.test(config), "sent in production builds only");
assert.ok(config.includes("frame-ancestors 'none'"));
n += 3;

// With Gloam wallets on, /app enforces scripts, frames, workers and connections. A Gloam
// wallet signs with no prompt, so a page that loads code from anywhere could send from it.
const directive = (name: string) => CSP_APP_ENFORCED.split("; ").find((d: string) => d.startsWith(`${name} `)) ?? "";
assert.equal(directive("script-src"), "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://va.vercel-scripts.com", "scripts only from here");
assert.ok(!CSP_APP_ENFORCED.includes("'unsafe-eval'"), "no eval");
assert.equal(directive("connect-src"), `connect-src ${CSP_CONNECT_SOURCES.join(" ")}`, "the same tested connect list");
for (const host of ["https://api.turnkey.com", "https://authproxy.turnkey.com", "https://lottie.host"]) assert.ok(allowed(host), host);
assert.ok(/frame-src [^;]*https:\/\/\*\.turnkey\.com/.test(CSP_APP_ENFORCED), "Turnkey's export and import frames");
assert.equal(directive("worker-src"), "worker-src 'self' blob:", "the prover's workers");
for (const d of ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"]) assert.ok(CSP_APP_ENFORCED.includes(d), d);
n += 9;
const ids = { NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID: "org", NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: "proxy" };
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
assert.equal(embeddedWalletsBuild(env({ NEXT_PUBLIC_TURNKEY_ENABLED: "true", ...ids })), true);
assert.equal(embeddedWalletsBuild(env({ NEXT_PUBLIC_TURNKEY_ENABLED: "1", ...ids })), false);
assert.equal(embeddedWalletsBuild(env({ NEXT_PUBLIC_TURNKEY_ENABLED: "true" })), false);
assert.ok(
  /process\.env\.NODE_ENV === "production" && embeddedWalletsBuild\(\)\s*\?\s*\[\s*\{ source: "\/app\/:path\*", headers: \[\{ key: "Content-Security-Policy", value: CSP_APP_ENFORCED \}\] \},\s*\{ source: "\/partners\/dashboard\/:path\*", headers: \[\{ key: "Content-Security-Policy", value: CSP_APP_ENFORCED \}\] \},\s*\]/.test(config),
  "enforced on /app and the partner portal in production builds with Gloam wallets on, and nowhere else",
);
assert.ok(config.indexOf("CSP_APP_ENFORCED }") > config.indexOf("frame-ancestors 'none'; base-uri"), "after the framing policy, so it replaces it on /app");
n += 5;

// Continue with Google: the token goes to Turnkey's authproxy (allowed); Google itself is
// only ever a popup window, so the enforced policy names no Google host.
assert.ok(allowed("https://authproxy.turnkey.com/v1/oauth_login"), "Google's token reaches Turnkey");
assert.ok(!/google/i.test(CSP_APP_ENFORCED), "no Google host to load scripts or frames from");
n += 2;

console.log(`csp: ${n} passed`);
