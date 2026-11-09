#!/usr/bin/env node
/**
 * What an agent's E2B payment looks like today, read from the live endpoint.
 *
 *   node public-402.mjs
 *
 * Calls the real https://mpp.e2b.dev/sandboxes without paying, decodes the
 * 402 challenges, and prints what a payment would put on Tempo mainnet in the
 * clear: the payer's wallet, E2B's receiving wallet and the amount. Then it
 * reads the last few payments into that wallet straight from the public RPC,
 * the way anyone can. No payment is made and no key is used.
 *
 * No dependencies: Node 18+ only.
 */

const E2B = process.env.E2B_MPP_URL ?? "https://mpp.e2b.dev";
const TEMPO_RPC = process.env.TEMPO_RPC ?? "https://rpc.tempo.xyz";
const EXPLORER = "https://explore.tempo.xyz";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKENS = {
  "0x20c000000000000000000000b9537d11c60e8b50": "USDC.e",
  "0x20c0000000000000000000006a37da5c996874be": "OUSD",
  "0x20c0000000000000000000000000000000000000": "pathUSD",
};
const tokenName = (a) => TOKENS[a.toLowerCase()] ?? a;
const usd = (base) => `$${(Number(base) / 1e6).toFixed(6)}`;
const short = (a) => `${a.slice(0, 8)}...${a.slice(-4)}`;

/** Split a WWW-Authenticate value into its `Payment k="v", ...` challenges. */
function parseChallenges(header) {
  const out = [];
  const re = /Payment\s+((?:[a-zA-Z]+="[^"]*"(?:,\s*)?)+)/g;
  for (const m of header.matchAll(re)) {
    const params = {};
    for (const p of m[1].matchAll(/([a-zA-Z]+)="([^"]*)"/g)) params[p[1]] = p[2];
    out.push(params);
  }
  return out;
}
const b64url = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

async function rpc(method, params) {
  const res = await fetch(TEMPO_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const body = { templateID: "base", timeout: 300 };
console.log(`POST ${E2B}/sandboxes ${JSON.stringify(body)}   (no payment attached)\n`);
const res = await fetch(`${E2B}/sandboxes`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
console.log(`HTTP ${res.status} ${res.statusText || ""}`.trim());
const header = res.headers.get("www-authenticate") ?? "";
const challenges = parseChallenges(header);
if (res.status !== 402 || challenges.length === 0) {
  console.log("No Payment challenge came back. Nothing to decode.");
  process.exit(1);
}

console.log(`WWW-Authenticate offers ${challenges.length} ways to pay:\n`);
let recipient = null;
const currencies = new Set();
for (const c of challenges) {
  const r = b64url(c.request);
  recipient = r.recipient;
  currencies.add(r.currency.toLowerCase());
  console.log(`  method="${c.method}" intent="${c.intent}"`);
  console.log(`    description  ${c.description}`);
  console.log(`    amount       ${r.amount} base units = ${usd(r.amount)}`);
  console.log(`    currency     ${tokenName(r.currency)} (${r.currency})`);
  console.log(`    recipient    ${r.recipient}`);
  console.log(`    chainId      ${r.methodDetails?.chainId} (Tempo mainnet)`);
  console.log("");
}

console.log("Decoded challenge `request` (the first one, verbatim):");
console.log(`  ${JSON.stringify(b64url(challenges[0].request))}\n`);

console.log("If the agent pays this, Tempo mainnet records in the clear:");
console.log("  from     the agent's wallet address");
console.log(`  to       ${recipient}  (E2B's receiving wallet, the same on every charge)`);
console.log(`  amount   ${usd(b64url(challenges[0].request).amount)} in ${[...currencies].map(tokenName).join(" or ")}`);
console.log("  when     the block time");
console.log("Anyone can list every agent paying E2B, how much and how often, from one RPC query.\n");

// Read the public record the way anyone can: Transfer logs into E2B's wallet.
try {
  const latest = BigInt(await rpc("eth_blockNumber", []));
  const from = latest - 90_000n; // the public RPC caps eth_getLogs at 100,000 blocks
  const logs = await rpc("eth_getLogs", [
    {
      fromBlock: `0x${from.toString(16)}`,
      toBlock: "latest",
      address: [...currencies],
      topics: [TRANSFER_TOPIC, null, `0x${recipient.slice(2).toLowerCase().padStart(64, "0")}`],
    },
  ]);
  const payers = new Set(logs.map((l) => l.topics[1]));
  const total = logs.reduce((s, l) => s + BigInt(l.data), 0n);
  console.log(`The public record, last ~90,000 blocks of Tempo mainnet (eth_getLogs, no key, no account):`);
  console.log(`  ${logs.length} payments into ${short(recipient)} from ${payers.size} distinct payer wallets, ${usd(total)} in total`);
  for (const l of logs.slice(-5)) {
    const payer = `0x${l.topics[1].slice(26)}`;
    const when = l.blockTimestamp ? new Date(Number(BigInt(l.blockTimestamp)) * 1000).toISOString() : `block ${BigInt(l.blockNumber)}`;
    console.log(`  ${when}  ${short(payer)} -> E2B  ${usd(BigInt(l.data))} ${tokenName(l.address)}  ${EXPLORER}/tx/${l.transactionHash}`);
  }
  console.log("  (payer addresses shortened here; the chain shows them in full)");
} catch (e) {
  console.log(`Could not read the public record from ${TEMPO_RPC}: ${e.message}`);
}

console.log("\nNo payment was made.");
