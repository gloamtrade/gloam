/**
 * Preview then execute, with a fake engine: a preview moves nothing and shows
 * what will happen; execute does exactly the preview, once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPaymentRequestLink, encodeNotePackage, generateReceiveKey, getGloamNetwork } from "@gloamtrade/sdk";
import { claimLinkFor } from "@gloamtrade/game-plugin-gloam/engine";
import type { Hex } from "viem";
import { GLOAM_TOOL_DEFINITIONS, createGloamToolPack } from "../src/index.ts";
import { NET, POOL, USDC, fakeEngine } from "./helpers.mts";

const TO = "0x00000000000000000000000000000000000000b2";

test("every tool has a name, a description for a model, and a closed JSON schema whose required fields exist", () => {
  const names = new Set<string>();
  for (const d of GLOAM_TOOL_DEFINITIONS) {
    assert.match(d.name, /^gloam_[a-z0-9_]+$/);
    assert.ok(!names.has(d.name), `duplicate ${d.name}`);
    names.add(d.name);
    assert.ok(d.description.length > 60, d.name);
    assert.equal(d.inputSchema.type, "object");
    assert.equal(d.inputSchema.additionalProperties, false);
    for (const r of d.inputSchema.required) assert.ok(d.inputSchema.properties[r], `${d.name}.${r}`);
    if (d.kind === "preview") assert.match(d.description, /gloam_execute/, d.name);
    // The copy rules: no em dashes, never "anonymous" or "untraceable".
    assert.ok(!/\u2014|anonymous|untraceable/i.test(JSON.stringify(d)), d.name);
  }
  assert.deepEqual(
    [...names].sort(),
    ["gloam_balance", "gloam_execute", "gloam_preview_cash_out", "gloam_preview_claim_link", "gloam_preview_pay", "gloam_preview_pay_x402", "gloam_preview_prove_funds", "gloam_preview_shield", "gloam_receive", "gloam_verify_proof"]
  );
});

test("inputs are checked before any handler: unknown and missing fields, commas, bad types", async () => {
  const { engine, calls } = fakeEngine();
  const pack = createGloamToolPack({ engine });
  const tag = (await generateReceiveKey()).tag;
  assert.equal((await pack.call("gloam_preview_pay", { to: tag, amount: "1", extra: 1 })).code, "bad_input");
  assert.equal((await pack.call("gloam_preview_cash_out", { amount: "1" })).code, "bad_input");
  assert.match(String((await pack.call("gloam_preview_pay", { to: tag, amount: "2,5" })).message), /comma/);
  assert.equal((await pack.call("gloam_balance", { refresh: "maybe" })).code, "bad_input");
  assert.equal((await pack.call("gloam_nope", {})).code, "unknown_tool");
  // A number for an amount is taken as its text.
  assert.equal((await pack.call("gloam_preview_pay", { to: tag, amount: 2.5 })).status, "preview");
  assert.deepEqual(calls, [], "nothing reached the engine");
});

test("a pay preview shows what will happen and moves nothing; execute does exactly that, once", async () => {
  const { engine, calls } = fakeEngine();
  const pack = createGloamToolPack({ engine });
  const tag = (await generateReceiveKey()).tag;
  const p = await pack.call("gloam_preview_pay", { to: tag, amount: "12.50", asset: "usdc", note: "inv 42", label: "order-9" });
  assert.equal(p.status, "preview", JSON.stringify(p));
  assert.match(String(p.previewId), /^pv_/);
  assert.match(String(p.digest), /^sha256:[0-9a-f]{64}$/);
  const d = p.details as Record<string, unknown>;
  assert.equal(d.amount, "12.5 USDC");
  assert.equal(d.amountBaseUnits, "12500000");
  assert.equal(d.to, tag);
  assert.equal(d.note, "inv 42");
  assert.match(String(d.fee), /free/);
  assert.deepEqual(p.walletSigns, [], "through the relay the wallet signs nothing");
  assert.deepEqual(p.network, { key: NET.key, name: "Base testnet", chainId: NET.chainId, testnet: true });
  assert.deepEqual(calls, [], "a preview moves nothing");

  assert.equal((await pack.call("gloam_execute", { previewId: p.previewId, digest: "sha256:" + "0".repeat(64) })).code, "digest_mismatch");
  const r = await pack.call("gloam_execute", { previewId: p.previewId, digest: p.digest });
  assert.equal(r.status, "done");
  assert.deepEqual(calls, [{ fn: "pay", args: { to: tag, amount: "12.5", asset: USDC, note: "inv 42", label: "order-9" } }]);
  const again = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(again.repeated, true);
  assert.equal(calls.length, 1, "a preview runs once");
  assert.equal((await pack.call("gloam_execute", { previewId: "pv_nothing" })).code, "unknown_preview");
});

test("a payment request link is read in the preview, and its payee, asset, amount and note are what execute pays", async () => {
  const { engine, calls } = fakeEngine();
  const pack = createGloamToolPack({ engine });
  const tag = (await generateReceiveKey()).tag;
  const link = buildPaymentRequestLink({ payTo: tag, network: NET, asset: "USDC", amount: "3", note: "agent:7" });
  const p = await pack.call("gloam_preview_pay", { to: link });
  assert.equal(p.status, "preview", JSON.stringify(p));
  await pack.call("gloam_execute", { previewId: p.previewId });
  assert.deepEqual(calls[0], { fn: "pay", args: { to: tag, amount: "3", asset: USDC, note: "agent:7" } });
  assert.match(String((await pack.call("gloam_preview_pay", { to: link, amount: "4" })).message), /asks for 3 USDC/);
  const other = buildPaymentRequestLink({ payTo: tag, network: getGloamNetwork("robinhood")!, asset: "ETH", amount: "1" });
  assert.match(String((await pack.call("gloam_preview_pay", { to: other })).message), /for robinhood/);
});

test("a payment no single note covers is refused at the preview", async () => {
  const { engine } = fakeEngine({ largest: 5_000_000n });
  const pack = createGloamToolPack({ engine });
  const tag = (await generateReceiveKey()).tag;
  const p = await pack.call("gloam_preview_pay", { to: tag, amount: "6" });
  assert.equal(p.code, "no_note_covers");
  assert.match(String(p.message), /largest holds 5 USDC/);
});

test("a cash out preview shows the live fee and what arrives; a fee that changed before execute is refused", async () => {
  const { engine, calls, state } = fakeEngine({ feeBps: 50 });
  const pack = createGloamToolPack({ engine });
  const p = await pack.call("gloam_preview_cash_out", { amount: "10", to: TO });
  assert.equal(p.status, "preview", JSON.stringify(p));
  const d = p.details as { fee: { bps: number; amount: string }; receives: string };
  assert.equal(d.fee.bps, 50);
  assert.equal(d.fee.amount, "0.05 USDC");
  assert.equal(d.receives, "9.95 USDC");
  state.feeBps = 60;
  const r = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.equal(r.code, "changed");
  assert.match(String(r.message), /0\.5% to 0\.6%/);
  assert.deepEqual(calls, []);
  state.feeBps = 50;
  assert.equal((await pack.call("gloam_execute", { previewId: p.previewId })).status, "done");
  assert.deepEqual(calls, [{ fn: "cashOut", args: { amount: "10", asset: USDC, to: TO } }]);
  // An address where the money would be lost is refused before any preview.
  assert.equal((await pack.call("gloam_preview_cash_out", { amount: "1", to: POOL })).code, "lost_recipient");
});

test("a preview that expired is refused, and nothing ran", async () => {
  const { engine, calls } = fakeEngine();
  const pack = createGloamToolPack({ engine, previewTtlMs: 1 });
  const p = await pack.call("gloam_preview_prove_funds", { atLeast: "5", for: "Oak Agent Kit" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await pack.call("gloam_execute", { previewId: p.previewId })).code, "preview_expired");
  assert.deepEqual(calls, []);
});

test("a proof of funds preview says what the reader learns, and execute proves exactly that", async () => {
  const { engine, calls } = fakeEngine();
  const pack = createGloamToolPack({ engine });
  const p = await pack.call("gloam_preview_prove_funds", { atLeast: "50", for: "Killfloor", expiresInHours: 24 });
  assert.equal(p.status, "preview");
  assert.deepEqual(p.walletSigns, []);
  assert.match(JSON.stringify(p.details), /nullifiers/);
  await pack.call("gloam_execute", { previewId: p.previewId });
  assert.deepEqual(calls, [{ fn: "proveFunds", args: { atLeast: "50", asset: USDC, for: "Killfloor", expiresInHours: 24 } }]);
});

test("a shield preview names the calls the wallet signs, and refuses what the wallet cannot cover", async () => {
  const { engine, calls } = fakeEngine();
  const pack = createGloamToolPack({ engine });
  const p = await pack.call("gloam_preview_shield", { amount: "25" });
  assert.equal(p.status, "preview", JSON.stringify(p));
  const signs = p.walletSigns as { contract: string; call: string; when?: string }[];
  assert.equal(signs.length, 2);
  assert.equal(signs[0]!.contract, USDC);
  assert.equal(signs[0]!.call, `approve(${NET.pool}, 25000000)`);
  assert.match(signs[1]!.call, /^shieldBound\(/);
  await pack.call("gloam_execute", { previewId: p.previewId });
  assert.deepEqual(calls, [{ fn: "add", args: { amount: "25", asset: USDC } }]);
  const poor = createGloamToolPack({ engine: fakeEngine({ holds: 1_000_000n }).engine });
  assert.equal((await poor.call("gloam_preview_shield", { amount: "25" })).code, "wallet_short");
  const none = createGloamToolPack({ engine: fakeEngine({ wallet: null }).engine });
  assert.equal((await none.call("gloam_preview_shield", { amount: "1" })).code, "no_wallet");
  const capped = createGloamToolPack({ engine: fakeEngine({ depositProblem: async () => "Over the vault's deposit limit." }).engine });
  assert.equal((await capped.call("gloam_preview_shield", { amount: "1" })).code, "deposit_limit");
});

test("a claim link never comes back in a result, even from an engine that returns one", async () => {
  const code = encodeNotePackage({ pool: NET.pool, chainId: NET.chainId, asset: USDC, amountWei: "1000000", secret: ("0x" + "3c".repeat(32)) as Hex, commitment: ("0x" + "22".repeat(32)) as Hex });
  const link = claimLinkFor(code, NET.key);
  const { engine } = fakeEngine({ payByClaimLink: async () => ({ status: "done", claimHandle: "c-abc", leaked: link }) });
  const pack = createGloamToolPack({ engine });
  const p = await pack.call("gloam_preview_claim_link", { amount: "1" });
  assert.match(JSON.stringify(p.details), /never comes back to the model/);
  const r = await pack.call("gloam_execute", { previewId: p.previewId });
  assert.ok(!JSON.stringify(r).includes(code.slice(10, 40)), JSON.stringify(r));
});

test("an execute that errored sent nothing, so the same approved preview can run again; one that ran cannot", async () => {
  let n = 0;
  const { engine } = fakeEngine({ pay: async () => (++n === 1 ? { status: "error", message: "The relay refused it." } : { status: "done" }) });
  const pack = createGloamToolPack({ engine });
  const p = await pack.call("gloam_preview_pay", { to: (await generateReceiveKey()).tag, amount: "1" });
  assert.equal((await pack.call("gloam_execute", { previewId: p.previewId })).status, "error");
  assert.equal((await pack.call("gloam_execute", { previewId: p.previewId })).status, "done");
  assert.equal((await pack.call("gloam_execute", { previewId: p.previewId })).repeated, true);
  assert.equal(n, 2);
});
