#!/usr/bin/env node
/**
 * Every deposit, private send and cash out the live Base vault has ever taken, in
 * order, with the exact proofs from chain, written to
 * contracts/test/fixtures/next-vault-base-replay.json for
 * contracts/test/fork/NextVaultFork.t.sol. It replays them on the next vault
 * (not deployed, not audited), which must reach the live vault's root.
 *
 * All of it is public calldata. Read only: eth_getLogs and eth_getTransactionByHash.
 * Most calls go straight to the vault. A deposit that came through a bridge has its
 * shieldBound call inside a larger call, so it is found by its selector.
 *
 *   node contracts/circuits/scripts/gen-next-vault-replay.mjs [block]
 *
 * BASE_LOG_RPC picks the RPC. With no block it uses the latest.
 */
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = here("../../test/fixtures/next-vault-base-replay.json");

const RPC = process.env.BASE_LOG_RPC ?? "https://base-rpc.publicnode.com";
const VAULT = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const DEPLOY_BLOCK = 53109632;
const STEP = 49_000;

// keccak256 of the live vault's event signatures
const SHIELDED = "0xa62fccfa0df3541b7c26481cbd724886972b92ab03ae368245d0205e15a3bf5c";
const TRANSFERRED = "0x7d0529e14b7b9334d09ea4cab104d257b379adb791dfbeebcd8cbe13eac822cb";
const UNSHIELDED = "0x30b76ac0da56cfe7d189cac50fddb8605587482a710e09bbf79ef47e5ef8c300";
const SHIELD_BOUND = "67e763e0"; // shieldBound(address,uint256,bytes32,bytes)
const CURRENT_ROOT = "0xfdab463d"; // currentRoot()
const NEXT_INDEX = "0xfc7e9c6f"; // nextIndex()

async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

const word = (hex, i) => hex.slice(i * 64, (i + 1) * 64);
const uint = (hex, i) => BigInt(`0x${word(hex, i)}`);
const b32 = (hex, i) => `0x${word(hex, i)}`;
const addr = (hex, i) => `0x${word(hex, i).slice(24)}`;
function bytesAt(hex, offset) {
  const start = Number(offset) * 2;
  const len = Number(BigInt(`0x${hex.slice(start, start + 64)}`));
  return `0x${hex.slice(start + 64, start + 64 + len * 2)}`;
}

/** shieldBound's arguments: direct, or found by selector inside a bridge's call. */
function decodeShield(input, commitment) {
  const hex = input.slice(2);
  for (let at = hex.indexOf(SHIELD_BOUND); at !== -1; at = hex.indexOf(SHIELD_BOUND, at + 1)) {
    const args = hex.slice(at + 8);
    if (b32(args, 2) !== commitment) continue;
    return { asset: addr(args, 0), amount: String(uint(args, 1)), commitment, proof: bytesAt(args, uint(args, 3)) };
  }
  throw new Error(`no shieldBound call for ${commitment}`);
}

function decodeTransfer(input) {
  const args = input.slice(10);
  return {
    proof: bytesAt(args, uint(args, 0)),
    root: b32(args, 1),
    nullifier: b32(args, 2),
    payment: b32(args, 3),
    change: b32(args, 4),
  };
}

function decodeUnshield(input) {
  const args = input.slice(10);
  return {
    proof: bytesAt(args, uint(args, 0)),
    root: b32(args, 1),
    nullifier: b32(args, 2),
    asset: addr(args, 3),
    to: addr(args, 4),
    amount: String(uint(args, 5)),
  };
}

const block = Number(process.argv[2] ?? BigInt(await rpc("eth_blockNumber", [])));
const logs = [];
for (let from = DEPLOY_BLOCK; from <= block; from += STEP) {
  const to = Math.min(from + STEP - 1, block);
  logs.push(...(await rpc("eth_getLogs", [{ address: VAULT, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])));
}

const ops = [];
for (const log of logs) {
  const topic = log.topics[0];
  if (topic !== SHIELDED && topic !== TRANSFERRED && topic !== UNSHIELDED) continue;
  const tx = await rpc("eth_getTransactionByHash", [log.transactionHash]);
  const op =
    topic === SHIELDED
      ? { kind: "shield", ...decodeShield(tx.input, log.topics[1]) }
      : topic === TRANSFERRED
        ? { kind: "transfer", ...decodeTransfer(tx.input) }
        : { kind: "unshield", ...decodeUnshield(tx.input) };
  ops.push({ tx: log.transactionHash, block: Number(BigInt(log.blockNumber)), ...op });
}

const call = (data) => rpc("eth_call", [{ to: VAULT, data }, `0x${block.toString(16)}`]);
const out = {
  note: "Public calldata of the live Base vault, in order. See circuits/scripts/gen-next-vault-replay.mjs.",
  chainId: 8453,
  block,
  vault: VAULT,
  root: await call(CURRENT_ROOT),
  nextIndex: Number(BigInt(await call(NEXT_INDEX))),
  ops,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${ops.length} operations to block ${block}`);
