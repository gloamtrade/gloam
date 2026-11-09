/**
 * Self-test: the private-balance backup for a Gloam wallet (lib/embeddedRecovery
 * over lib/recovery).
 *
 * A Gloam wallet's signatures are made by Turnkey and kept as activity results,
 * which Gloam's Turnkey account can also read. A backup keyed by one could be
 * opened without the person. So:
 *  - the offer is a passkey (WebAuthn PRF), whose secret never leaves the device;
 *    holding every signature Turnkey ever made for the wallet opens nothing
 *  - the wallet-signature backup is offered only where there is no passkey
 *    backup, and only by the person's choice: nothing turns on by itself
 *  - it is offered once per wallet per browser, only while the Gloam wallet is
 *    the connected one, never when recovery is on or was turned off here, and a
 *    browser holding other wallets' notes is told they would go in too
 *  - a new device brings the notes back with the same passkey
 *  - turning recovery off survives storage that refuses writes
 *
 * Uses the real /api/recovery route and store in-process, the app's browser shim,
 * a fake PRF authenticator, and throwaway local keys. Nothing leaves the process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-embedded-recovery.mts
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { hexToBytes, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { localStorage, resetBrowser } from "./browser-shim.mjs";
import type { LocalNote } from "../src/lib/shield";

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const win = globalThis.window as unknown as Record<string, unknown> & { dispatchEvent: (e: unknown) => boolean };
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
win.location = new URL("https://www.gloam.trade/app");

/**
 * A passkey authenticator that syncs across the person's devices: each credential
 * holds a secret, and PRF answers HMAC(secret, salt). Nothing outside it sees the secret.
 */
const credentials = new Map<string, Buffer>();
let lastCreated: string | null = null;
const toAb = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
function credential(id: string, salt: ArrayBuffer | Uint8Array | undefined) {
  const secret = credentials.get(id)!;
  const first = salt ? toAb(createHmac("sha256", secret).update(Buffer.from(salt instanceof Uint8Array ? salt : new Uint8Array(salt))).digest()) : undefined;
  return { rawId: toAb(Buffer.from(id, "hex")), getClientExtensionResults: () => ({ prf: first ? { results: { first } } : { enabled: true } }) };
}
type PrfOpts = { publicKey: { extensions?: { prf?: { eval?: { first?: Uint8Array } } }; allowCredentials?: { id: ArrayBuffer }[] } };
win.PublicKeyCredential = function PublicKeyCredential() {};
Object.defineProperty(globalThis.navigator, "credentials", {
  configurable: true,
  value: {
    async create(o: PrfOpts) {
      const id = randomBytes(16).toString("hex");
      credentials.set(id, randomBytes(32));
      lastCreated = id;
      return credential(id, o.publicKey.extensions?.prf?.eval?.first);
    },
    async get(o: PrfOpts) {
      // the person picks the passkey they made (the last one, here)
      const allowed = o.publicKey.allowCredentials?.[0]?.id;
      const id = allowed ? Buffer.from(allowed).toString("hex") : lastCreated;
      if (!id || !credentials.has(id)) throw Object.assign(new Error("no passkey"), { name: "NotAllowedError" });
      return credential(id, o.publicKey.extensions?.prf?.eval?.first);
    },
  },
});

const route = await import("../src/app/api/recovery/route");
const { readBackup } = await import("../src/lib/recoveryStore");
const { resetMemoryKv } = await import("../src/lib/partnersKv");

const puts: string[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const full = new URL(String(url), "https://www.gloam.trade");
  const body = init?.body ? String(init.body) : undefined;
  if (method === "PUT") puts.push((JSON.parse(body!) as { id: string }).id);
  const req = new Request(full, { method, body, headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" } });
  return route[method as "GET" | "PUT" | "DELETE"](req);
}) as typeof fetch;

const recovery = await import("../src/lib/recovery");
const vault = await import("../src/lib/noteVault");
const er = await import("../src/lib/embeddedRecovery");
const { makeEmbeddedProvider } = await import("../src/lib/embeddedProvider");
const { robinhood } = await import("../src/lib/chain");
const { custom } = await import("viem");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

/** Stands in for the Turnkey account: a real secp256k1 key whose signatures are deterministic (RFC 6979). */
const GLOAM_WALLET = privateKeyToAccount(`0x${"7a".repeat(32)}`);
const NEIGHBOUR = privateKeyToAccount(`0x${"7c".repeat(32)}`);

/** Every SIGN_RAW_PAYLOAD result Turnkey keeps for the wallet: what its records hold. */
const turnkeyRecords: Hex[] = [];
/** The wallet as recovery sees it: signing through the Gloam wallet's provider, as personal_sign. */
function gloamWallet() {
  const provider = makeEmbeddedProvider({
    chains: [robinhood],
    transportFor: () => custom({ request: async () => null }),
    signer: () => ({ account: GLOAM_WALLET }),
  });
  return {
    address: GLOAM_WALLET.address as string,
    sign: async (message: string): Promise<Hex> => {
      const sig = (await provider.request({ method: "personal_sign", params: [toHex(message), GLOAM_WALLET.address] })) as Hex;
      turnkeyRecords.push(sig);
      return sig;
    },
  };
}

const note = (name: string, from?: string) =>
  ({
    id: `note-${name}`,
    chainId: 4663,
    pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194",
    asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    amountWei: "1000000",
    commitment: keccak256(toHex(`commitment ${name}`)),
    secret: keccak256(toHex(`secret ${name}`)),
    nullifier: keccak256(toHex(`nullifier ${name}`)),
    bound: true,
    scheme: "poseidon",
    createdAt: 1,
    status: "open",
    source: "local",
    ...(from ? { from } : {}),
  }) as unknown as LocalNote;

const ids = () => vault.getAllNotes().map((x) => x.id).sort();

async function newDevice() {
  await recovery.turnOffRecovery({ deleteBackup: false });
  await vault.setAllNotes([]);
  resetBrowser();
  win.dispatchEvent({ type: "storage", key: "gloam.recovery.v1" });
  await new Promise((r) => setTimeout(r, 20));
  puts.length = 0;
}
async function freshWorld() {
  await newDevice();
  resetMemoryKv();
  turnkeyRecords.length = 0;
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
}

const base = { on: false, turnedOff: false, asked: false, embeddedConnected: true, otherNotes: 0, passkey: "yes" as const };

await test("the offer: a passkey; the wallet signature only where there is no passkey backup", () => {
  assert.deepEqual(er.backupOffer(base), { kind: "passkey", shared: false });
  assert.deepEqual(er.backupOffer({ ...base, passkey: "maybe" }), { kind: "passkey", shared: false });
  assert.deepEqual(er.backupOffer({ ...base, passkey: "no" }), { kind: "signature", shared: false });
});

await test("nothing is offered while recovery is on, after it was turned off here, after it was asked, or with a browser wallet connected", () => {
  assert.deepEqual(er.backupOffer({ ...base, on: true }), { kind: "none", why: "on" });
  assert.deepEqual(er.backupOffer({ ...base, turnedOff: true }), { kind: "none", why: "declined" });
  assert.deepEqual(er.backupOffer({ ...base, asked: true }), { kind: "none", why: "asked" });
  assert.deepEqual(er.backupOffer({ ...base, embeddedConnected: false }), { kind: "none", why: "not-connected" });
});

await test("a browser holding other wallets' notes is told they go in too", () => {
  const notes = [note("mine", GLOAM_WALLET.address.toLowerCase()), note("theirs", NEIGHBOUR.address), note("unnamed")];
  assert.equal(er.otherWalletNotes(notes, GLOAM_WALLET.address), 2);
  assert.equal(er.otherWalletNotes([note("mine", GLOAM_WALLET.address)], GLOAM_WALLET.address.toLowerCase()), 0);
  assert.deepEqual(er.backupOffer({ ...base, otherNotes: 2 }), { kind: "passkey", shared: true });
});

await test("asked once per wallet per browser", () => {
  resetBrowser();
  assert.equal(er.backupAsked(GLOAM_WALLET.address), false);
  er.markBackupAsked(GLOAM_WALLET.address.toLowerCase());
  assert.equal(er.backupAsked(GLOAM_WALLET.address), true);
  assert.equal(er.backupAsked(NEIGHBOUR.address), false);
});

await test("nothing turns on by itself: the module has no automatic path, and a sign-in writes nothing", async () => {
  await freshWorld();
  await vault.setAllNotes([note("a")]);
  assert.equal("syncEmbeddedRecovery" in er, false);
  gloamWallet(); // a sign-in builds the wallet; nothing else runs
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(recovery.recoveryState().on, false);
  assert.equal(puts.length, 0);
  assert.equal(turnkeyRecords.length, 0, "no signature was asked for");
});

await test("a passkey backup, then a new device with the same passkey brings the notes back", async () => {
  await freshWorld();
  await vault.setAllNotes([note("a", GLOAM_WALLET.address), note("b", GLOAM_WALLET.address)]);
  assert.equal(await er.backUpWithPasskey(GLOAM_WALLET.address, "create"), 0);
  assert.ok(recovery.recoveryState().on);
  assert.equal(recovery.recoveryState().source, "passkey");
  assert.equal(turnkeyRecords.length, 0, "Turnkey signed nothing for it");
  await newDevice();
  assert.deepEqual(ids(), []);
  assert.equal(await er.backUpWithPasskey(GLOAM_WALLET.address, "use"), 2);
  assert.deepEqual(ids(), ["note-a", "note-b"]);
  assert.equal(vault.getAllNotes().find((n) => n.id === "note-a")?.secret, note("a").secret, "the note's secret came back whole");
});

await test("everything Turnkey keeps for the wallet doesn't open a passkey backup", async () => {
  await freshWorld();
  await vault.setAllNotes([note("c", GLOAM_WALLET.address)]);
  await er.backUpWithPasskey(GLOAM_WALLET.address, "create");
  const backupId = puts[0]!;
  // Turnkey's records: the wallet signs the recovery message as often as anyone asks.
  const w = gloamWallet();
  for (let i = 0; i < 3; i++) await w.sign(recovery.recoveryMessageV2(GLOAM_WALLET.address));
  for (const sig of turnkeyRecords) {
    const bytes = hexToBytes(sig);
    const keys = await recovery.keysFromSecret("wallet", hexToBytes(keccak256(bytes.slice(0, 64))));
    assert.notEqual(keys.id, backupId, "a key from a Turnkey signature is not the backup's key");
    assert.equal(await readBackup(keys.id), null, "and finds no backup");
  }
});

await test("the wallet-signature backup works when chosen, and is the one Turnkey's records could open", async () => {
  await freshWorld();
  await vault.setAllNotes([note("d", GLOAM_WALLET.address)]);
  assert.equal(await er.backUpWithWalletSignature(gloamWallet()), 0);
  assert.ok(recovery.recoveryState().on && recovery.recoveryState().source === "wallet");
  // which is why the sheet, Settings and /privacy say so before it is chosen
  const keys = await recovery.keysFromSecret("wallet", hexToBytes(keccak256(hexToBytes(turnkeyRecords[0]!).slice(0, 64))));
  assert.ok(await readBackup(keys.id), "a key rebuilt from Turnkey's record finds this backup");
  assert.match(er.TURNKEY_CAN_OPEN_TEXT, /Turnkey, and anyone with access to Gloam's Turnkey account, could open a backup made with one/);
  assert.ok(!/—/.test(er.TURNKEY_CAN_OPEN_TEXT));
});

await test("'I backed up before' needs a backup: the sign-in passkey alone finds none and starts nothing", async () => {
  await freshWorld();
  await vault.setAllNotes([note("e", GLOAM_WALLET.address)]);
  // a passkey with no backup behind it: the one made for signing in, say
  const signIn = randomBytes(16).toString("hex");
  credentials.set(signIn, randomBytes(32));
  lastCreated = signIn;
  const e = await er.backUpWithPasskey(GLOAM_WALLET.address, "use").catch((x: unknown) => x);
  assert.ok(e instanceof recovery.RecoveryError && e.code === "notfound", "no backup found");
  assert.equal(recovery.recoveryState().on, false, "recovery stays off");
  assert.equal(puts.length, 0, "no empty backup was started");
  // with the passkey a backup was made with, it restores
  await er.backUpWithPasskey(GLOAM_WALLET.address, "create");
  await newDevice();
  assert.equal(await er.backUpWithPasskey(GLOAM_WALLET.address, "use"), 1);
});

await test("a passkey prompt closed fast is a cancel: the passkey stays offered; only no PRF moves to the signature", async () => {
  const create = (navigator.credentials as { create: unknown }).create;
  const nav = navigator.credentials as unknown as { create: () => Promise<unknown> };
  // closed at once (NotAllowedError within a second)
  nav.create = async () => {
    throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
  };
  const fast = await recovery.passkeySecret("create").catch((x: unknown) => x);
  assert.ok(fast instanceof recovery.RecoveryError && fast.code === "unsupported", "the fast close the app reads as 'didn't open'");
  assert.equal(er.passkeyBackupUnavailable(fast), false, "a fast close is not 'no passkey backup here'");
  // an authenticator with no PRF at all
  nav.create = async () => ({ rawId: new ArrayBuffer(16), getClientExtensionResults: () => ({ prf: { enabled: false } }) });
  const noPrf = await recovery.passkeySecret("create").catch((x: unknown) => x);
  assert.equal(er.passkeyBackupUnavailable(noPrf), true);
  nav.create = async () => {
    throw new DOMException("not supported", "NotSupportedError");
  };
  assert.equal(er.passkeyBackupUnavailable(await recovery.passkeySecret("create").catch((x: unknown) => x)), true);
  assert.equal(er.passkeyBackupUnavailable(new Error("anything else")), false);
  (navigator.credentials as { create: unknown }).create = create;
});

await test("turning recovery off is remembered, and storage that refuses writes doesn't stop it", async () => {
  await freshWorld();
  await er.backUpWithPasskey(GLOAM_WALLET.address, "create");
  const setItem = localStorage.setItem.bind(localStorage);
  const removeItem = localStorage.removeItem.bind(localStorage);
  // only the off mark is refused: the settings themselves still save
  localStorage.setItem = (k: string, v: string) => {
    if (k === "gloam.recovery.off.v1") throw new Error("QuotaExceededError");
    setItem(k, v);
  };
  await recovery.turnOffRecovery({ deleteBackup: true });
  assert.equal(recovery.recoveryState().on, false);
  localStorage.setItem = setItem;
  await recovery.turnOffRecovery({ deleteBackup: false });
  assert.equal(recovery.recoveryTurnedOffHere(), true);
  localStorage.removeItem = (k: string) => {
    if (k === "gloam.recovery.off.v1") throw new Error("SecurityError");
    removeItem(k);
  };
  await er.backUpWithPasskey(GLOAM_WALLET.address, "create");
  assert.equal(recovery.recoveryState().on, true, "turning on still works");
  localStorage.removeItem = removeItem;
});

console.log(`selftest-embedded-recovery: ${passed} passed`);
process.exit(0);
