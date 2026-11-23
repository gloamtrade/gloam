/**
 * Self-test: a Solana wallet that opened a Gloam private account before is
 * asked to open it again, not to set one up; staying signed in on this device
 * and signing out; and Solana's place in the network lists.
 *
 *  - lib/solanaRings/opened: a wallet never seen is new; once it opens account
 *    `index` it reads as seen, with that index, on that network only. Another
 *    wallet stays new. A browser that opened an account before the record
 *    existed (its sealed snapshot is there, nothing recorded) counts as seen,
 *    until the first record is written. Malformed or blocked storage reads as
 *    new and never throws. Only the wallet's address and the index are stored.
 *  - lib/solanaRings/keep: the wallet to reconnect (name and address, public)
 *    is remembered and forgotten; the open account's seed is sealed under a
 *    non-extractable AES-GCM key and comes back only for the same network,
 *    wallet and account index, before KEEP_DAYS end; anything else, a changed
 *    record or an ended one, is removed. One account at a time, and forgetting
 *    removes the record and its key. The record never holds the seed in clear.
 *  - The provider, the gate and the menu (source): the open account is kept in
 *    memory for the visit, never in localStorage; the gate says "Open your
 *    private account" and "Sign to open" to a returning wallet, "Set up" to a
 *    new one; the wallet reconnects silently and the account reopens from the
 *    kept seed; Sign out forgets both; a wallet that switches accounts signs out.
 *  - lib/networks: the mainnets in the order the menu lists them (Robinhood
 *    Chain, Base, BNB Chain, Tempo, Ethereum, Elysium), Solana's slot right
 *    after Base, and the menu putting it there.
 *
 * BNB Chain is switched on for this run with placeholder values; nothing reaches a host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-opened.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_BNB_")) delete process.env[k];
process.env.NEXT_PUBLIC_BNB_ENABLED = "1";
process.env.NEXT_PUBLIC_BNB_POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
process.env.NEXT_PUBLIC_BNB_DEPLOY_BLOCK = "134300000";
process.env.NEXT_PUBLIC_BNB_LIVE_SINCE = "21 November 2026";
delete process.env.NEXT_PUBLIC_SHOW_TESTNETS;

const opened = await import("../src/lib/solanaRings/opened");
const keep = await import("../src/lib/solanaRings/keep");
const nets = await import("../src/lib/networks");

let pass = 0;
const ok = (cond: unknown, what: string) => {
  assert.ok(cond, what);
  pass++;
  console.log(`  ok  ${what}`);
};

/** A stand-in for localStorage, with key() and length like the real one. */
function memory(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const A = "9wPkC6bZ3mWtq8FxVhN2sRj4LdYa7GuE5oTcKpB1iHzX";
const B = "4nQe8RtV2yJxW7aLmK3sPdF9cHbU6gZoN1iTqEvA5wYr";
const PRIVATE = "7Gh4kLmN2pQrStUvWxYz3aBcDeFgHiJkMnPqRsTuVwXy";

// ---------------------------------------------------------------- seen before

{
  const s = memory();
  ok(!opened.openedBefore(s, "mainnet", A).seen, "a wallet never seen is new");
  opened.rememberOpened(s, "mainnet", A, 0);
  ok(opened.openedBefore(s, "mainnet", A).seen, "after it opens its account, it reads as seen");
  ok(opened.openedBefore(s, "mainnet", A).index === 0, "with the index it opened");
  ok(!opened.openedBefore(s, "devnet", A).seen, "on that network only");
  ok(!opened.openedBefore(s, "mainnet", B).seen, "another wallet stays new");
  opened.rememberOpened(s, "mainnet", B, 3);
  ok(opened.openedBefore(s, "mainnet", B).index === 3 && opened.openedBefore(s, "mainnet", A).seen, "a second wallet keeps its own index, and the first stays seen");

  // Only public facts are stored: addresses and account numbers, under one key.
  ok([...s.map.keys()].every((k) => k === opened.OPENED_KEY), "one storage key");
  const stored = JSON.parse(s.map.get(opened.OPENED_KEY)!);
  ok(JSON.stringify(stored) === JSON.stringify({ mainnet: { [A]: 0, [B]: 3 } }), "it holds the wallet addresses and their account index, nothing else");
}

{
  // Opened before the record existed: the sealed snapshot is there, nothing recorded.
  const s = memory({ [`${opened.SNAPSHOT_PREFIX}mainnet:${PRIVATE}`]: "sealed" });
  ok(opened.openedBefore(s, "mainnet", A).seen, "a browser that opened an account before the record counts as seen");
  ok(!opened.openedBefore(s, "devnet", A).seen, "but not on another network");
  opened.rememberOpened(s, "mainnet", A, 0);
  ok(!opened.openedBefore(s, "mainnet", B).seen, "once a record is written, only recorded wallets count");
  ok(!opened.openedBefore(memory({ "gloam:solana-payroll:v1:mainnet:x": "{}" }), "mainnet", A).seen, "a payroll list alone is not an account");
}

{
  // Bad input and bad storage: read as new, never throw.
  const junk = memory({ [opened.OPENED_KEY]: "{not json" });
  ok(!opened.openedBefore(junk, "mainnet", A).seen, "malformed storage reads as new");
  opened.rememberOpened(junk, "mainnet", A, 1);
  ok(opened.openedBefore(junk, "mainnet", A).index === 1, "and the next open writes a clean record");

  const odd = memory({ [opened.OPENED_KEY]: JSON.stringify({ mainnet: { [A]: -1, "not-an-address": 0, [B]: "2" } }) });
  ok(!opened.openedBefore(odd, "mainnet", A).seen && !opened.openedBefore(odd, "mainnet", B).seen, "a bad index or address is ignored");

  const s = memory();
  opened.rememberOpened(s, "mainnet", "not-an-address", 0);
  opened.rememberOpened(s, "mainnet", A, 1.5);
  opened.rememberOpened(s, "mainnet", A, 2_000_000);
  ok(s.map.size === 0, "nothing is written for a bad address or index");

  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    key: () => {
      throw new Error("blocked");
    },
    get length(): number {
      throw new Error("blocked");
    },
  };
  ok(!opened.openedBefore(blocked, "mainnet", A).seen, "blocked storage reads as new");
  opened.rememberOpened(blocked, "mainnet", A, 0);
  ok(!opened.openedBefore(null, "mainnet", A).seen, "no storage reads as new");
  opened.rememberOpened(null, "mainnet", A, 0);
  ok(true, "and writing to it never throws");
}

// ---------------------------------------------------------------- staying signed in

{
  // The wallet to reconnect: public facts only, in localStorage.
  const s = memory();
  ok(keep.keptWallet(s) === null, "no wallet to reconnect at first");
  keep.keepWallet(s, { name: "OKX Wallet", address: A });
  ok(JSON.stringify(keep.keptWallet(s)) === JSON.stringify({ name: "OKX Wallet", address: A }), "the wallet's name and address are remembered");
  ok(s.map.get(keep.WALLET_KEY) === JSON.stringify({ name: "OKX Wallet", address: A }), "and nothing else");
  keep.forgetWallet({ removeItem: (k: string) => void s.map.delete(k) });
  ok(keep.keptWallet(s) === null, "Sign out forgets it");
  keep.keepWallet(s, { name: "OKX Wallet", address: "not-an-address" });
  ok(keep.keptWallet(s) === null, "a bad address is never remembered");
  ok(keep.keptWallet(memory({ [keep.WALLET_KEY]: "{oops" })) === null, "malformed storage reconnects nothing");
}

/** A stand-in for IndexedDB: structured values by id. */
function idb() {
  const m = new Map<string, unknown>();
  return { map: m, get: async (id: string) => m.get(id), put: async (id: string, v: unknown) => void m.set(id, v), del: async (id: string) => void m.delete(id) };
}

{
  const db = idb();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const now = Date.UTC(2026, 10, 23, 12);
  await keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed, now });
  const back = await keep.keptAccount(db, { network: "mainnet", owner: A, index: 0, now: now + 60_000 });
  ok(back !== null && Buffer.from(back).equals(Buffer.from(seed)), "the kept seed comes back for the same wallet and account");

  // Sealed: the key can't leave, and the record never holds the seed in the clear.
  const key = db.map.get("wrap") as CryptoKey;
  ok(key instanceof CryptoKey && key.extractable === false && key.algorithm.name === "AES-GCM", "sealed under a non-extractable AES-GCM key");
  await assert.rejects(crypto.subtle.exportKey("raw", key));
  pass++;
  const record = db.map.get("account") as { data: ArrayBuffer; owner: string; index: number; expires: number };
  const hex = Buffer.from(record.data).toString("hex");
  ok(!hex.includes(Buffer.from(seed.subarray(0, 8)).toString("hex")), "the record holds no part of the seed in the clear");
  ok(record.owner === A && record.index === 0 && record.expires === now + keep.KEEP_DAYS * 86_400_000, `bound to its wallet and account, for ${keep.KEEP_DAYS} days`);
  ok([...db.map.keys()].sort().join(",") === "account,wrap", "two entries: the sealed record and its key");

  ok((await keep.keptAccount(db, { network: "mainnet", owner: A, index: 0, now: now + keep.KEEP_DAYS * 86_400_000 + 1 })) === null, `it ends after ${keep.KEEP_DAYS} days`);
  ok(db.map.size === 0, "and an ended record is removed with its key");

  await keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed, now });
  ok((await keep.keptAccount(db, { network: "mainnet", owner: B, index: 0, now })) === null && db.map.size === 0, "another wallet gets nothing, and the record goes");
  await keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed, now });
  ok((await keep.keptAccount(db, { network: "mainnet", owner: A, index: 1, now })) === null, "another account index gets nothing");
  await keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed, now });
  ok((await keep.keptAccount(db, { network: "devnet", owner: A, index: 0, now })) === null, "another network gets nothing");

  // A record relabelled to another wallet fails to open: the scope is the cipher's additional data.
  await keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed, now });
  (db.map.get("account") as { owner: string }).owner = B;
  ok((await keep.keptAccount(db, { network: "mainnet", owner: B, index: 0, now })) === null && db.map.size === 0, "a record moved to another wallet does not open, and is removed");

  // A changed byte fails to open.
  await keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed, now });
  const sealed = db.map.get("account") as { data: ArrayBuffer };
  const bytes = new Uint8Array(sealed.data.slice(0));
  bytes[0] ^= 1;
  sealed.data = bytes.buffer;
  ok((await keep.keptAccount(db, { network: "mainnet", owner: A, index: 0, now })) === null && db.map.size === 0, "a changed record does not open, and is removed");

  // One account at a time; Sign out removes it and its key.
  await keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed, now });
  const other = crypto.getRandomValues(new Uint8Array(32));
  await keep.keepAccount(db, { network: "mainnet", owner: B, index: 2, seed: other, now });
  ok((await keep.keptAccount(db, { network: "mainnet", owner: A, index: 0, now })) === null, "keeping another account replaces the first");
  await keep.keepAccount(db, { network: "mainnet", owner: B, index: 2, seed: other, now });
  const second = await keep.keptAccount(db, { network: "mainnet", owner: B, index: 2, now });
  ok(second !== null && Buffer.from(second).equals(Buffer.from(other)), "and the second comes back");
  await keep.forgetAccount(db);
  ok(db.map.size === 0 && (await keep.keptAccount(db, { network: "mainnet", owner: B, index: 2, now })) === null, "forgetting removes the record and its key");

  await assert.rejects(keep.keepAccount(db, { network: "mainnet", owner: A, index: 0, seed: new Uint8Array(31), now }));
  pass++;
  const broken = { get: async () => Promise.reject(new Error("blocked")), put: async () => {}, del: async () => {} };
  ok((await keep.keptAccount(broken, { network: "mainnet", owner: A, index: 0, now })) === null, "storage that refuses reads as nothing kept");
}

// ---------------------------------------------------------------- the provider and the gate

{
  const provider = readFileSync(new URL("../src/components/app/SolanaAccount.tsx", import.meta.url), "utf8");
  const gate = readFileSync(new URL("../src/components/app/SolanaParts.tsx", import.meta.url), "utf8");
  const code = provider.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  ok(!/localStorage|sessionStorage|indexedDB/.test(code), "the provider never puts the account in browser storage");
  ok(/useState<RingsSession \| null>\(\(\) => kept\.session\)/.test(code), "a new provider starts from the visit's open account");
  ok(/Object\.assign\(kept, \{ main, session,/.test(code), "and the visit's account follows every change");
  ok(!/closeRingsAccount\(session\)/.test(code), "the account is not closed when a provider goes, only on Disconnect");
  ok(/rememberOpened\(browserStorage\(\), network, owner, index\)/.test(code), "an open remembers the wallet and its index");
  ok(/openRingsAccount\(\{ wallet: watched, account: m\.account, index, network, onSeed/.test(code), "and reopens the index it remembered");
  ok(gate.includes('"Open your private account"') && gate.includes('"Sign to open"'), "a returning wallet is asked to open its account");
  ok(gate.includes("signs one message to open it. Nothing new is created."), "with one line that nothing new is made");
  ok(gate.includes('"Set up your private account"') && gate.includes('"Sign and set up"'), "a new wallet still sets one up");
  const menu = readFileSync(new URL("../src/components/app/SolanaWalletMenu.tsx", import.meta.url), "utf8");
  const signOut = code.slice(code.indexOf("const signOut = useCallback"), code.indexOf("const disconnect = useCallback"));
  ok(/forgetWallet\(browserStorage\(\)\)/.test(signOut) && /forgetAccount\(db\)/.test(signOut) && /closeRingsAccount/.test(signOut), "Sign out closes the account and forgets the wallet and the kept account");
  ok(/const disconnect = useCallback\(\(\) => signOut\(true\)/.test(code), "Disconnect is the same sign out");
  ok(/watchSolanaAccount\(main\.wallet, \(address\) => \{\s*if \(address && address !== mine\) signOut\(false\)/.test(code), "a wallet that switches accounts signs out");
  ok(/reconnectSolana\(w\)/.test(code) && /keptWallet\(browserStorage\(\)\)/.test(code), "on load the remembered wallet reconnects without a prompt");
  ok(/reopenRingsAccount\(/.test(code) && /seed\.fill\(0\)/.test(code), "the account reopens from the kept seed, and the copy is wiped");
  ok(/held\.seed\?\.fill\(0\)/.test(code) && code.indexOf("keepAccount(db") > code.indexOf("await l.syncRings(s);"), "a new seed is kept only once the account is open, then wiped");
  ok(/>\s*Sign out\s*</.test(menu), "the Solana wallet menu says Sign out");
  ok(!/\u2014/.test(menu) && !/happy to/i.test(menu), "no em dash or 'happy to' in the menu");
  for (const t of [provider, gate]) ok(!/\u2014/.test(t) && !/happy to/i.test(t), "no em dash or 'happy to' in the copy");
}

// ---------------------------------------------------------------- the network lists

{
  const mainnets = nets.shownNetworks().filter((n) => !n.testnet).map((n) => n.key);
  const want = ["robinhood-mainnet", "base-mainnet", "bnb-mainnet", "tempo-mainnet", "ethereum-mainnet", "elysium-mainnet"].filter((k) => mainnets.includes(k as never));
  ok(mainnets.length >= 5 && JSON.stringify(mainnets) === JSON.stringify(want), `the mainnets in menu order: ${mainnets.join(", ")}`);
  ok(mainnets[0] === "robinhood-mainnet" && nets.FIRST_PAINT_NETWORK_KEY === "robinhood-mainnet", "Robinhood Chain first, and still where a new visitor lands");
  ok(nets.solanaSlot(mainnets as never) === 2, "Solana right after Base");
  ok(nets.solanaSlot(["robinhood-mainnet", "tempo-mainnet"]) === 1 && nets.solanaSlot(["tempo-mainnet"]) === 0, "after Robinhood Chain without Base, first without either");
  const picker = readFileSync(new URL("../src/components/app/NetworkSelector.tsx", import.meta.url), "utf8");
  ok(/solanaSlot\(list\.map\(\(n\) => n\.key\)\)/.test(picker) && /groupRows\(group\.title, group\.list\)/.test(picker), "the menu puts Solana's row at its slot");
}

console.log(`\nselftest-solana-opened: ${pass} checks passed`);
