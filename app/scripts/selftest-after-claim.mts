/**
 * The step after a claim (lib/afterClaim, components/app/AfterClaimNext,
 * components/app/ClaimSafetyLine): full the first time in a browser and
 * compact after, Swap only where it exists, clicks counted by name only.
 * Run from app/: ../mcp/node_modules/.bin/tsx scripts/selftest-after-claim.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// a browser, enough for lib/afterClaim and lib/demoFlag
const local = new Map<string, string>();
const session = new Map<string, string>();
let storageBroken = false;
const location = { hostname: "www.gloam.trade", href: "https://www.gloam.trade/app/vault?tab=move", pathname: "/app/vault", search: "?tab=move", hash: "" };
const g = globalThis as Record<string, unknown>;
g.window = {
  localStorage: {
    getItem: (k: string) => {
      if (storageBroken) throw new Error("SecurityError");
      return local.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (storageBroken) throw new Error("SecurityError");
      local.set(k, v);
    },
  },
  sessionStorage: {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  },
  location,
  history: { state: null, replaceState: () => {} },
};

const { takeFirstClaim, canSwapAfterClaim } = await import("../src/lib/afterClaim");
const { VAULT_SWAP_ASSETS, swapV3Live } = await import("../src/lib/vaultSwap");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test("the first claim in a browser is full, every later one compact", () => {
  assert.equal(takeFirstClaim(), true);
  assert.equal(takeFirstClaim(), false);
  assert.equal(takeFirstClaim(), false);
  assert.deepEqual([...local.keys()], ["gloam.afterClaim.v1"], "one flag, nothing about the payment");
  assert.equal(local.get("gloam.afterClaim.v1"), "1");
});

test("blocked storage counts as a first claim", () => {
  storageBroken = true;
  assert.equal(takeFirstClaim(), true);
  storageBroken = false;
});

test("a recording demo keeps its own memory and never touches the real flag", () => {
  local.clear();
  location.hostname = "localhost";
  session.set("gloam_demo", "1");
  assert.equal(takeFirstClaim(), true);
  assert.equal(takeFirstClaim(), false);
  assert.equal(local.size, 0);
  session.delete("gloam_demo");
  location.hostname = "www.gloam.trade";
  assert.equal(takeFirstClaim(), true, "outside the demo it is still this browser's first claim");
});

test("Swap shows only where a router is live and the claimed token can be swapped", () => {
  const rhUsdg = VAULT_SWAP_ASSETS[4663]![0]!;
  const tempoUsdc = VAULT_SWAP_ASSETS[4217]![0]!;
  assert.equal(canSwapAfterClaim(4663, rhUsdg, undefined), true, "Robinhood Chain mainnet, USDG");
  assert.equal(canSwapAfterClaim(4663, rhUsdg.toUpperCase().replace("0X", "0x"), "0x0000000000000000000000000000000000000001"), true, "any case");
  assert.equal(canSwapAfterClaim(4217, tempoUsdc, undefined), true, "Tempo mainnet, USDC.e");
  assert.equal(canSwapAfterClaim(4663, "0x0000000000000000000000000000000000000000", undefined), swapV3Live(4663), "native ETH is a swap start only with v3");
  assert.equal(canSwapAfterClaim(46630, rhUsdg, undefined), false, "Robinhood Chain testnet has no router");
  assert.equal(canSwapAfterClaim(42431, tempoUsdc, undefined), false, "Tempo testnet has no router");
});

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const sources = {
  next: read("../src/components/app/AfterClaimNext.tsx"),
  safety: read("../src/components/app/ClaimSafetyLine.tsx"),
};

test("clicks are counted by event name only", () => {
  const calls = [...sources.next.matchAll(/track\(([^)]*)\)/g)].map((m) => m[1]!.trim());
  assert.deepEqual(calls.sort(), [
    '"after_claim_cash_out"',
    '"after_claim_get_paid"',
    '"after_claim_send"',
    '"after_claim_swap"',
    '"after_claim_swap"',
  ]);
  for (const c of calls) assert.match(c, /^"[a-z][a-z0-9_]{0,47}"$/, "a bare event name the intake accepts, no meta");
});

test("the copy stays plain: no em dashes, no slop words", () => {
  for (const [name, src] of Object.entries(sources)) {
    assert.ok(!src.includes("—"), `${name}: em dash`);
    assert.ok(!/seamless|unlock|effortless/i.test(src), `${name}: slop word`);
  }
  assert.ok(sources.safety.includes("Free to claim. No gas, no seed phrase, nothing to buy. Only on gloam.trade."));
  assert.ok(sources.next.includes("This balance is private. Only you can see or spend it."));
});

console.log(`\nafter claim: ${passed} passed`);
