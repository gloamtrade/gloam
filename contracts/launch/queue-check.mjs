// Reads each mainnet vault's whole timelock history and prints what is still
// queued. Reads only, no key, nothing sent. The vault has no list of its queue:
// the logs are the list, so this rebuilds it from ChangeQueued, ChangeExecuted
// and ChangeCancelled, then checks each entry against changeEta on chain.
//
//   node launch/queue-check.mjs            all five chains
//   node launch/queue-check.mjs tempo base some of them
//
// Exits 1 if a change other than setDepositLimit or setWithdrawFee is queued on
// any chain: the guard could never run it, and neither could anyone else, but
// its owner should cancel it BEFORE the handover, because after it nobody can.
// Takes a few minutes on Robinhood Chain: its RPC caps a log query's range.
// Elysium's vault has its own address (packages/sdk/src/elysium.ts, ELYSIUM_MAINNET)
// and is owned by its VaultOwnerGuard from the deploy; its RPC caps a log query at
// 10,000 logs, not at a block range, so it reads a million blocks (about 28 hours) a call.
const VAULT = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const QUEUED = "0x1a18849b91d03bb42f289e0bf0222c3e98a9ff96d288fa2b496f5bd28b3339fa";
const EXECUTED = "0xacba7db33afd41cd69adcb9749e50b9fd484953f306d98d2d6e0a8ce0adb7d5c";
const CANCELLED = "0xef2393afd41f32c607a123de95d703349edd33ea1d86af21535ea8040ec7d984";
const GRACE = 14 * 24 * 60 * 60;

const SETTERS = {
  a6c1660a: "setDepositLimit",
  "9bf263a7": "setWithdrawFee",
  "5437988d": "setVerifier",
  "8d98415d": "setShieldVerifier",
};
const ALLOWED = new Set(["setDepositLimit", "setWithdrawFee"]);

const CHAINS = {
  tempo: { rpcs: ["https://rpc.tempo.xyz"], from: 45172561, step: 50_000 },
  ethereum: { rpcs: ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com"], from: 26276183, step: 10_000 },
  base: { rpcs: ["https://base-rpc.publicnode.com"], from: 53109632, step: 10_000 },
  robinhood: { rpcs: ["https://rpc.mainnet.chain.robinhood.com"], from: 94194599, step: 50_000 },
  elysium: { rpcs: ["https://rpc.elysium.kinetiq.xyz"], vault: "0x89d3042390204f57b8b4F8949D3c2203E4002164", from: 3248495, step: 1_000_000 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(urls, method, params) {
  let last;
  for (let t = 0; t < 8; t++) {
    try {
      const res = await fetch(urls[t % urls.length], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await res.json();
      if (j.result !== undefined) return j.result;
      last = j.error?.message ?? "no result";
    } catch (e) {
      last = e?.message ?? e;
    }
    await sleep(1000 * (t + 1));
  }
  throw new Error(`${method}: ${last}`);
}

/** Every timelock log in order: the queue is rebuilt from these. */
async function history(c) {
  const head = Number(await rpc(c.rpcs, "eth_blockNumber", []));
  const logs = [];
  for (let b = c.from; b <= head; b += c.step) {
    const to = Math.min(b + c.step - 1, head);
    const part = await rpc(c.rpcs, "eth_getLogs", [
      { address: c.vault ?? VAULT, fromBlock: "0x" + b.toString(16), toBlock: "0x" + to.toString(16), topics: [[QUEUED, EXECUTED, CANCELLED]] },
    ]);
    logs.push(...part);
    await sleep(200);
  }
  return logs.sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber) || Number(x.logIndex) - Number(y.logIndex));
}

/** data = offset, eta, then the call's length and bytes. */
function decodeQueued(log) {
  const d = log.data.slice(2);
  const offset = Number(BigInt("0x" + d.slice(0, 64))) * 2;
  const eta = Number(BigInt("0x" + d.slice(64, 128)));
  const length = Number(BigInt("0x" + d.slice(offset, offset + 64)));
  return { eta, call: d.slice(offset + 64, offset + 64 + length * 2) };
}

function describe(call) {
  const name = SETTERS[call.slice(0, 8)] ?? `unknown selector 0x${call.slice(0, 8)}`;
  const w = (i) => call.slice(8 + i * 64, 8 + (i + 1) * 64);
  if (name === "setDepositLimit") return `${name}(0x${w(0).slice(-40)}, ${BigInt("0x" + w(1))}, ${BigInt("0x" + w(2))})`;
  if (name === "setWithdrawFee") return `${name}(${BigInt("0x" + w(0))} bps, 0x${w(1).slice(-40)})`;
  return `${name}(0x${call.slice(8)})`;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHAINS);
const now = Math.floor(Date.now() / 1000);
let bad = 0;

await Promise.all(
  names.map(async (name) => {
    const c = CHAINS[name];
    if (!c) throw new Error(`unknown chain ${name}: use ${Object.keys(CHAINS).join(", ")}`);
    const queue = new Map();
    let total = 0;
    for (const log of await history(c)) {
      const id = log.topics[1];
      if (log.topics[0] === QUEUED) {
        queue.set(id, decodeQueued(log));
        total++;
      } else queue.delete(id);
    }
    const lines = [];
    for (const [id, { eta, call }] of [...queue].sort((a, b) => a[1].eta - b[1].eta)) {
      const live = Number(BigInt(await rpc(c.rpcs, "eth_call", [{ to: c.vault ?? VAULT, data: "0x1bed985d" + id.slice(2) }, "latest"])));
      const setter = SETTERS[call.slice(0, 8)];
      const state = now > eta + GRACE ? "expired" : now >= eta ? "ready" : "waiting";
      const flag = ALLOWED.has(setter) ? "" : "  <- NOT A LIMIT OR FEE CHANGE";
      if (live !== eta) throw new Error(`${name}: the logs and changeEta disagree on ${id}`);
      if (!ALLOWED.has(setter)) bad++;
      lines.push(`  ${state.padEnd(7)} ${new Date(eta * 1000).toISOString()} ${describe(call)}${flag}`);
    }
    console.log(`${name}: ${total} queued since deploy, ${queue.size} still pending`);
    for (const l of lines) console.log(l);
  })
);

if (bad) {
  console.log(`\n${bad} pending change(s) the guard would refuse. Cancel them with the owner wallet before any handover.`);
  process.exit(1);
}
console.log("\nNothing pending but deposit limit and fee changes.");
