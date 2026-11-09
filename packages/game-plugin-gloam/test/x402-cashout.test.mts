/**
 * x402 scheme gloam-cashout on the engine (a fake Robinhood Chain, a stubbed
 * tree, prover and send): a quote is cashed out to its public payTo for exactly
 * its gross amount, a larger note is split privately first, and the payment
 * header carries the tx hash and the quote id. Quotes that must not be paid are
 * refused before any note is touched.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  GLOAM_CASHOUT_ASSET,
  IncrementalMerkleTreePoseidon,
  cashoutGross,
  decodeGloamCashoutHeader,
  hexToField,
  makeBoundNotePoseidon,
  parseGloamCashoutRequirement,
  type GloamIntent,
} from "@gloamtrade/sdk";
import type { Address, Hex, PublicClient } from "viem";
import { GloamAgent, shutdownProver } from "../src/index.ts";

const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "circuits");
const SPLITTER = "0x5111111111111111111111111111111111111115" as Address;
const G = cashoutGross(1_000_000n, 777, 50);
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const LIMITS = { recipients: "any" as const, assets: { USDG: { maxPerPayment: "25", maxPerDay: "100" } } };

after(() => shutdownProver());

const quote = (over: Record<string, unknown> = {}) =>
  parseGloamCashoutRequirement({ scheme: "gloam-cashout", network: "eip155:4663", asset: GLOAM_CASHOUT_ASSET, payTo: SPLITTER, amount: G.toString(), quoteId: "qt_abc123", ...over })!;

async function setup(network = "robinhood-mainnet") {
  const seen = new Set<string>();
  const spent = new Set<string>();
  const chainId = network === "robinhood-mainnet" ? 4663 : 84532;
  const client = {
    chain: { id: chainId },
    getChainId: async () => chainId,
    getBlockNumber: async () => 1_000n,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === "commitmentSeen") return seen.has(String(args![0]).toLowerCase());
      if (functionName === "isSpent") return spent.has(String(args![0]).toLowerCase());
      throw new Error(`fake chain: no ${functionName}`);
    },
    waitForTransactionReceipt: async () => ({ status: "success" as const, blockNumber: 1_000n, logs: [] }),
    getTransactionReceipt: async () => {
      throw new Error("fake chain: receipt not found");
    },
  } as unknown as PublicClient;
  const dir = mkdtempSync(join(tmpdir(), "gloam-x402-cashout-"));
  const agent = new GloamAgent({
    network,
    rpc: "http://127.0.0.1:1",
    submit: "relay",
    agentId: "unit",
    dataDir: dir,
    env: { GLOAM_NOTE_KEY: randomBytes(32).toString("hex"), GLOAM_NOTE_STORE: join(dir, "notes.json") },
    artifacts: { dir: CIRCUITS, url: "http://127.0.0.1:1/never" },
    limits: network === "robinhood-mainnet" ? LIMITS : { recipients: "any" as const, assets: { USDC: { maxPerPayment: "25", maxPerDay: "100" } } },
    publicClient: client,
  });
  const internals = agent as unknown as { tree: unknown; prover: () => Promise<unknown>; submitIntent: (i: GloamIntent) => Promise<Hex> };
  const tree = new IncrementalMerkleTreePoseidon();
  await tree.init();
  const leaves: string[] = [];
  const pathForCommitment = async (c: Hex) => {
    let i = leaves.indexOf(c.toLowerCase());
    if (i < 0) {
      await tree.insert(hexToField(c));
      i = leaves.push(c.toLowerCase()) - 1;
    }
    return tree.path(i);
  };
  internals.tree = { sync: async () => ({ pathForCommitment }) };
  internals.prover = async () => async () => ({ proofBytes: "0x00" as Hex });
  const sent: GloamIntent[] = [];
  internals.submitIntent = async (intent) => {
    sent.push(intent);
    const exec = intent.exec!;
    spent.add(String(exec.args[2]).toLowerCase());
    if (exec.fn === "transfer") for (const c of exec.args[3] as readonly Hex[]) seen.add(c.toLowerCase());
    return hashOf(sent.length);
  };
  const addNote = async (amountWei: bigint) => {
    const asset = agent.network.assets[0]!;
    const n = await makeBoundNotePoseidon(amountWei, asset.address);
    seen.add(n.commitment.toLowerCase());
    return agent.store.add({
      network: agent.network.key, chainId, pool: agent.network.pool, asset: asset.address, symbol: asset.symbol, decimals: asset.decimals,
      amountWei: amountWei.toString(), secret: n.secret, commitment: n.commitment, nullifier: n.nullifier,
      status: "unspent", origin: "shield", createdTx: null,
    } as never);
  };
  return { agent, sent, addNote };
}

test("a gloam-cashout quote is cashed out for exactly its amount to its payTo, after a private split", { timeout: 60_000 }, async () => {
  const { agent, sent, addNote } = await setup();
  await addNote(10_000_000n);
  const out = await agent.payX402Cashout({ requirement: quote(), maxAmount: "1.1" });
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.equal(out.action, "pay_x402_cashout");
  assert.deepEqual(sent.map((i) => i.exec!.fn), ["transfer", "unshield"], "split privately, then the cash out");
  const [, , , asset, to, amount] = sent[1]!.exec!.args as [Hex, Hex, Hex, Address, Address, bigint];
  assert.equal(asset.toLowerCase(), GLOAM_CASHOUT_ASSET.toLowerCase());
  assert.equal(to.toLowerCase(), SPLITTER.toLowerCase());
  assert.equal(amount, G, "exactly the gross amount");
  const header = decodeGloamCashoutHeader(String(out.paymentHeader));
  assert.deepEqual(header, { scheme: "gloam-cashout", txHash: hashOf(2), quoteId: "qt_abc123" });
  assert.match(String(out.public), /leaving the Gloam vault/);
  const left = agent.notes().filter((n) => n.status === "unspent").map((n) => n.amount);
  assert.deepEqual(left, [String((10_000_000 - Number(G)) / 1e6)], "the change stays private");
});

test("refused before any note is touched: no maxAmount, over it, wrong network or asset, no quote id; another network throws", { timeout: 60_000 }, async () => {
  const { agent, sent, addNote } = await setup();
  await addNote(10_000_000n);
  const cases: [Record<string, unknown>, string | undefined, string][] = [
    [{}, undefined, "no_max_amount"],
    [{}, "1", "over_max_amount"],
    [{ network: "eip155:1" }, "2", "wrong_network"],
    [{ asset: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }, "2", "wrong_asset"],
    [{ quoteId: undefined }, "2", "no_quote_id"],
  ];
  for (const [over, max, code] of cases) {
    const r = await agent.payX402Cashout({ requirement: quote(over), maxAmount: max as string });
    assert.equal(r.status, "refused", JSON.stringify(r));
    assert.equal(r.code, code);
  }
  assert.equal(sent.length, 0, "nothing was sent");
  const onBase = await setup("base");
  await assert.rejects(onBase.agent.payX402Cashout({ requirement: quote(), maxAmount: "2" }), /Robinhood Chain mainnet/);
});

test("the same quote asked again after it was paid presents that cash out and pays nothing new", { timeout: 60_000 }, async () => {
  const { agent, sent, addNote } = await setup();
  await addNote(10_000_000n);
  const first = await agent.payX402Cashout({ requirement: quote(), maxAmount: "1.1" });
  assert.equal(first.status, "done", JSON.stringify(first));
  assert.equal(sent.length, 2);
  const again = await agent.payX402Cashout({ requirement: quote(), maxAmount: "1.1" });
  assert.equal(again.status, "done", JSON.stringify(again));
  assert.equal(sent.length, 2, "nothing was sent the second time");
  assert.equal(again.paymentHeader, first.paymentHeader, "the first cash out is presented again");
  // a new quote for the same amount and payee is a new purchase
  const other = await agent.payX402Cashout({ requirement: quote({ quoteId: "qt_other" }), maxAmount: "1.1" });
  assert.equal(other.status, "done", JSON.stringify(other));
  assert.ok(sent.length > 2, "a different quote is paid");
});
