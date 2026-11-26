/**
 * Local check (not in CI): the page's discovery path on mainnet, end to end.
 * The SDK's IndexerDiscoveryProvider seals its requests (OHTTP) and sends them
 * to Gloam's routes (/api/starknet/discovery and its /ohttp-keys), run here
 * in-process, which relay them to Starknet's hosted discovery service. It asks
 * for the notes of an account nobody has, so the answer is empty. Read only:
 * no transaction, no proof, no key.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-discovery.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stubs: Record<string, string> = { "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)) };
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "mainnet";
delete env.NEXT_PUBLIC_STARKNET_POOL;

const ORIGIN = "https://gloam.selftest";
const relayRoute = await import("../src/app/api/starknet/discovery/route");
const keysRoute = await import("../src/app/api/starknet/discovery/ohttp-keys/route");
const config = await import("../src/lib/starknetPrivacy/config");
const { IndexerDiscoveryProvider } = await import("@starkware-libs/starknet-privacy-sdk");

let relayed = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === `${ORIGIN}${config.STARKNET_PROXY_PATHS.discovery}/ohttp-keys`) return keysRoute.GET();
  if (url === `${ORIGIN}${config.STARKNET_PROXY_PATHS.discovery}`) {
    relayed++;
    return relayRoute.POST(new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.9" } }));
  }
  if (url.startsWith(ORIGIN)) throw new Error(`unexpected ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;

const cfg = config.starknetConfig("mainnet", {});
const d = new IndexerDiscoveryProvider(`${ORIGIN}${config.STARKNET_PROXY_PATHS.discovery}`, cfg.pool!, { ohttp: true });
assert.equal(await d.isHealthy(), true, "the service answers through Gloam");
const r = await d.discoverNotes(0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdn, 12345n);
assert.equal(r.notes.size, 0, "an account nobody has has no notes");
assert.ok(relayed >= 2, "every request went through Gloam's relay");
globalThis.fetch = realFetch;
console.log(`e2e-starknet-discovery: through Gloam's OHTTP relay to mainnet discovery, ${relayed} sealed requests, ok`);
