/**
 * A real receipt for a payment VEYA allowed: the real receipt circuit and the
 * pinned files, through the server's own prover, checked with the real checking
 * keys. The pool is a mock and the transfer proof a stub, as in test-veya.mts.
 *
 *   pnpm --filter @gloamtrade/mcp exec tsx --test scripts/test-veya-proof.mts
 *
 * The files come from app/public/circuits through a local stand-in for
 * gloam.trade/circuits, so the server's download and SHA-256 check are on the
 * path. Skipped when the circuit files are not in the checkout.
 *
 * Covers: dev keys on a dev network and final keys on a mainnet, and on a testnet
 * whose verifiers hold the final keys; the proof verifies under its own key set
 * and no other; a changed signal or verifier fails; and the full record check
 * passes, including that the transaction created this note as the payment.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Address, Hex } from "viem";
import {
  IncrementalMerkleTreePoseidon,
  RECEIPT_PUBLIC_SIGNALS,
  checkPaymentReceipt,
  fieldToHex,
  hexToField,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  verifyGroth16,
  type PaymentReceiptRecord,
  type ReceiptChainReader,
} from "@gloamtrade/sdk";
import { TRANSFERRED_TOPIC } from "@gloamtrade/mppx-gloam/core";

type Env = Record<string, string | undefined>;
const lc = (h: string) => h.toLowerCase();
const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "public", "circuits");
const present = existsSync(join(CIRCUITS, "receipt.wasm"));

// ── local stand-ins: the circuit files, VEYA's check and its anchor ──────────
const served: string[] = [];
const files = http.createServer((req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url!, "http://x").pathname)).replace(/^\/+/, "");
  const path = join(CIRCUITS, rel);
  if (rel.startsWith("..") || !existsSync(path)) {
    res.writeHead(404).end();
    return;
  }
  served.push(rel);
  res.writeHead(200).end(readFileSync(path));
});
const CHECK_ID = "veya-check-00112233445566778899aabbccddeeff";
const anchored: string[] = [];
const veya = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/anchor") anchored.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    const leaf = req.url === "/anchor" ? (JSON.parse(body) as { leaf: string }).leaf : "";
    res.end(JSON.stringify(req.url === "/anchor" ? { status: "anchored", leaf, tx_hash: `0x${"ab".repeat(32)}`, duplicate: false } : { decision: "allow", attestation: CHECK_ID }));
  });
});
const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const filesPort = await listen(files);
const veyaPort = await listen(veya);
after(async () => {
  for (const s of [files, veya]) {
    s.closeAllConnections();
    s.close();
  }
  // snarkjs keeps its worker threads until told otherwise.
  await (globalThis as unknown as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

// Read when artifacts.ts loads, so these come before the server is imported.
process.env.GLOAM_ARTIFACTS_SOURCE = `http://127.0.0.1:${filesPort}`;
process.env.GLOAM_ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), "gloam-veya-circuits-"));
const { createGloamServer } = await import("../src/server.js");
const { allNetworks } = await import("../src/networks.js");
const { openNoteStore } = await import("../src/noteStore.js");
type ServerDeps = import("../src/server.js").ServerDeps;
type ReceiptOutcome = import("../src/veyaReceipt.js").ReceiptOutcome;
type Signer = import("../src/signer.js").Signer;
type McpNetwork = import("../src/networks.js").McpNetwork;

/** A pool that follows the contract's rules for transfer and keeps its tree, roots and events (as in test-veya). */
function mockChain(pool: Address) {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const roots = new Set<string>();
  const spent = new Set<string>();
  const receipts = new Map<string, { status: "success" | "reverted"; logs: { address: Address; topics: Hex[]; data: Hex }[] }>();
  let n = 0;
  const insert = async (c: string) => {
    index.set(lc(c), await tree.insert(hexToField(c)));
    roots.add(lc(fieldToHex(tree.currentRoot)));
  };
  const receiptOf = (hash: Hex) => {
    const r = receipts.get(hash);
    if (!r) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
    return { ...r, from: "0x0000000000000000000000000000000000000abc" };
  };
  const publicClient = {
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => receiptOf(hash),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => receiptOf(hash),
    readContract: async ({ functionName, args }: { functionName: string; args: [Hex] }) =>
      functionName === "isSpent" ? spent.has(lc(args[0])) : functionName === "isKnownRoot" ? roots.has(lc(args[0])) : index.has(lc(args[0])),
  };
  const walletClient = {
    writeContract: async ({ args }: { args: readonly unknown[] }) => {
      const hash = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
      const [, root, nullifier, outs] = args as [Hex, Hex, Hex, Hex[]];
      assert.ok(roots.has(lc(root)) && !spent.has(lc(nullifier)));
      spent.add(lc(nullifier));
      for (const c of outs) await insert(c);
      receipts.set(hash, {
        status: "success",
        logs: [{ address: pool, topics: [TRANSFERRED_TOPIC, lc(nullifier) as Hex], data: `0x${outs.map((c) => lc(c).slice(2)).join("")}` as Hex }],
      });
      return hash;
    },
  };
  const syncTree = async () => {
    const seen = new Map(index);
    return { pathForCommitment: async (c: Hex) => (seen.has(lc(c)) ? tree.path(seen.get(lc(c))!) : null) };
  };
  return { publicClient, walletClient, syncTree, insert };
}

async function connect(chain: ReturnType<typeof mockChain>, env: Env, receiptWork?: ServerDeps["receiptWork"]) {
  const prover = async () => ({ proofBytes: "0xdeadbeef" as Hex });
  // No receiptProver here: this is the server's own, on the real circuit.
  const deps: Partial<ServerDeps> = {
    env,
    signer: (net) =>
      ({ account: { address: "0x0000000000000000000000000000000000000abc" }, network: net, walletClient: chain.walletClient, publicClient: chain.publicClient }) as unknown as Signer,
    publicClient: () => chain.publicClient as unknown as Signer["publicClient"],
    transferProver: async () => prover,
    syncTree: chain.syncTree as unknown as ServerDeps["syncTree"],
    ...(receiptWork ? { receiptWork } : {}),
  };
  const server = createGloamServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gloam-veya-proof-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
  };
}

function party(name: string, dir: string, over: Env = {}): Env {
  return {
    GLOAM_AGENT_ID: name,
    GLOAM_AGENT_PRIVATE_KEY: `0x${(name === "payer" ? "11" : "22").repeat(32)}`,
    GLOAM_NOTE_STORE: join(dir, `${name}-notes.json`),
    GLOAM_SPEND_LOG: join(dir, `${name}-log.json`),
    GLOAM_LIMITS: "off",
    ...over,
  };
}

/** Pay one unit on `net` through the real tools, with receipts on; returns the record kept on the payment's note. */
async function pay(net: McpNetwork) {
  const dir = mkdtempSync(join(tmpdir(), "gloam-veya-proof-"));
  const chain = mockChain(net.pool);
  const payerEnv = party("payer", dir, {
    GLOAM_VEYA_KEY: "veya_test_key_not_real",
    GLOAM_VEYA_URL: `http://127.0.0.1:${veyaPort}/check`,
    GLOAM_VEYA_AGENT_ID: "agent-7f3a",
    GLOAM_VEYA_ANCHOR_URL: `http://127.0.0.1:${veyaPort}/anchor`,
  });
  // A note in the vault to pay from.
  const asset = net.defaultAsset as Address;
  const amountWei = 10n ** BigInt(net.defaultAssetDecimals) * 5n;
  const secret = fieldToHex(BigInt(`0x${randomBytes(30).toString("hex")}`));
  const commitment = fieldToHex(await noteCommitmentPoseidon(hexToField(secret), amountWei, asset));
  await chain.insert(commitment);
  openNoteStore(payerEnv).add({
    network: net.key,
    chainId: net.chainId,
    pool: net.pool,
    asset,
    symbol: "TEST",
    decimals: net.defaultAssetDecimals,
    amountWei: amountWei.toString(),
    secret,
    commitment,
    nullifier: fieldToHex(await noteNullifierPoseidon(hexToField(secret), hexToField(commitment))),
    status: "unspent",
    origin: "shield",
    createdTx: null,
  });
  const S = await connect(chain, party("payee", dir));
  const work = new Map<string, Promise<ReceiptOutcome>>();
  const P = await connect(chain, payerEnv, (handle, w) => work.set(handle, w));
  const priced = await S("gloam_payment_requirements", { amount: 1, resource: "https://api.example.com/answer", network: net.key });
  const paid = await P("gloam_execute_private_pay", { requirements: priced.encoded });
  assert.equal(paid.status, "paid", JSON.stringify(paid));
  // The answer comes back first; the receipt is proved and anchored after it.
  assert.equal(paid.veya.receipt.status, "pending", JSON.stringify(paid.veya));
  const receipt = await work.get(paid.veya.receipt.note)!;
  const note = openNoteStore(payerEnv).list().find((n) => n.origin === "payment")!;
  const client = { getChainId: async () => net.chainId, ...chain.publicClient } as unknown as ReceiptChainReader;
  return { receipt, record: note.receipt!.record as PaymentReceiptRecord, client };
}

const vkeyOf = (ceremony: string) => JSON.parse(readFileSync(join(CIRCUITS, ceremony === "production" ? "final" : "", "receipt_vkey.json"), "utf8"));

const cases: [string, "dev" | "production", string][] = [
  ["tempo", "dev", "receipt_final.zkey"],
  ["tempo-mainnet", "production", "final/receipt_final.zkey"],
  ["base", "production", "final/receipt_final.zkey"],
];

for (const [key, ceremony, zkey] of cases) {
  test(`${key}: a real proof, on the ${ceremony} keys, checks out end to end`, { skip: !present && "the circuit files are not in this checkout" }, async () => {
    const net = allNetworks().find((n) => n.key === key)!;
    assert.ok(net, `${key} is a network here`);
    assert.equal(net.ceremony, ceremony);
    served.length = 0;
    anchored.length = 0;
    const { receipt, record, client } = await pay(net);
    assert.equal(receipt.status, "anchored", JSON.stringify(receipt));
    assert.equal(record.verifier, CHECK_ID);
    assert.deepEqual(JSON.parse(anchored[0]!), { leaf: record.leaf, agent_id: "agent-7f3a" });
    if (served.length) assert.ok(served.includes(zkey), `fetched ${served.join(", ")}`);

    const vkey = vkeyOf(ceremony);
    assert.equal(await verifyGroth16(vkey, record.publicSignals, record.proof), true, "the proof verifies under the real checking key");
    assert.equal(await verifyGroth16(vkeyOf(ceremony === "dev" ? "production" : "dev"), record.publicSignals, record.proof), false, "and under no other key set");

    const at = RECEIPT_PUBLIC_SIGNALS.indexOf("minAmount");
    const lowered = record.publicSignals.map((s, i) => (i === at ? (BigInt(s) - 1n).toString() : s));
    assert.equal(await verifyGroth16(vkey, lowered, record.proof), false, "a changed signal fails");

    // All eight checks: leaf, fields, context, vault, snark, chain, root and that this transaction made this payment.
    const verifySnark = (signals: string[], proof: unknown) => verifyGroth16(vkey, signals, proof);
    // Testnet cases opt in to test value; by default a testnet receipt is never ok. Mainnet needs no opt-in.
    const check = await checkPaymentReceipt(record, { leaf: receipt.leaf!, verifySnark, client, allowTestnet: net.testnet });
    assert.ok(check.ok, JSON.stringify(check.checks.filter((c) => c.state !== "pass")));
    assert.equal(check.expired, false);
    assert.equal(check.testnet, net.testnet, "the result says whether the record is from a testnet");
    assert.equal(check.network, net.key);
    const byDefault = await checkPaymentReceipt(record, { leaf: receipt.leaf!, verifySnark, client });
    assert.equal(byDefault.ok, !net.testnet, net.testnet ? "without allowTestnet a testnet receipt is refused" : "a mainnet receipt needs no opt-in");
    assert.equal(byDefault.checks.find((c) => c.id === "vault")?.state, net.testnet ? "fail" : "pass");

    const relabelled = await checkPaymentReceipt({ ...record, verifier: "someone-else" }, { verifySnark, client, allowTestnet: true });
    assert.equal(relabelled.ok, false);
    assert.equal(relabelled.checks.find((c) => c.id === "context")?.state, "fail", "the check id is sealed into the proof");
  });
}
