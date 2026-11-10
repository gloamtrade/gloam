/**
 * Self-test: the contract list on /verify and its CSV (lib/contractDirectory).
 *
 * Two runs of this file:
 *
 *  - as committed: every network with a pool is listed with its vault, deploy
 *    block, memo board and routers from the app's own network data, the
 *    accounts match the deployment records, Base and Ethereum mainnet show as
 *    next while their pools are empty, and the CSV holds exactly those rows.
 *  - with placeholder pools put into MAINNET_POOLS[8453] and MAINNET_POOLS[1]
 *    before anything else loads (a child process of this one): both join the
 *    list and the CSV as mainnets, in order, with their own explorers, with no
 *    other edit. That is what the after-deploy switch-on does.
 *
 * The reads /verify makes from each vault are given here as fixtures (what
 * Robinhood Chain mainnet answered on 26 Oct 2026), so nothing reaches any
 * host: fetch fails the run if anything tries.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-contract-directory.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recoverMessageAddress, type Address } from "viem";

globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-contract-directory: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const mainnet = await import("../src/lib/mainnet");
const CONFIGURED = process.env.GLOAM_SELFTEST_DIRECTORY === "configured";
const PLACEHOLDER = {
  8453: { pool: "0x00000000000000000000000000000000000BA5E2", deployBlock: 2_000_000 },
  1: { pool: "0x000000000000000000000000000000000000E7E1", deployBlock: 3_000_000 },
} as const;
if (CONFIGURED) {
  for (const id of [8453, 1] as const) {
    if (!mainnet.mainnetPool(id)) mainnet.MAINNET_POOLS[id] = { ...PLACEHOLDER[id] };
  }
}

const nets = await import("../src/lib/networks");
const dir = await import("../src/lib/contractDirectory");
const { VAULT_SWAP_ROUTERS, swapV3Live } = await import("../src/lib/vaultSwap");
/** Elysium mainnet is listed, after Ethereum, while NEXT_PUBLIC_ELYSIUM_ENABLED is on (as production builds it). */
const { ELYSIUM_FLAG } = await import("../src/lib/elysium");
const ELYSIUM_ROW = ELYSIUM_FLAG ? 1 : 0;

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks++;
  void name;
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  void name;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What Robinhood Chain mainnet's vault answers (cast call, read only), its fee as of 3 November 2026. */
const RH_READ: import("../src/lib/contractDirectory").VaultRead = {
  owner: "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8",
  pendingOwner: "0x0000000000000000000000000000000000000000",
  setupMode: false,
  changeDelay: 259_200n,
  verifier: "0x1421353d471dF6C847713aee391Db38978fE714a",
  shieldVerifier: "0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465",
  poseidon: "0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4",
  feeRecipient: "0xB3900ac9350903218e4c7597bAb0f008F01B30B8",
  withdrawFeeBps: 50,
  cashOutVerifier: "0x35de99bcD26B0F25E5a3a3b1e76FA5a708a01DF1",
  sendVerifier: "0x4dCac25a820D0C9Ede8f056378C08e31042AB7b1",
};
/** Robinhood Chain testnet's older vault: its own owner, no fee calls. */
const RH_TESTNET_READ: import("../src/lib/contractDirectory").VaultRead = {
  owner: "0x7dB545c4f0247888b832644EA7165eAaC04635a9",
  pendingOwner: "0x0000000000000000000000000000000000000000",
  setupMode: false,
  changeDelay: 259_200n,
  verifier: "0xB077c620384813bB31Bb82Cd55b63608Ac20f7eF",
  shieldVerifier: "0x28E6d0D02568EE634f9596645775275DE76b2847",
  poseidon: "0x46b33ced153199036F267CD19f45E246767a0540",
  feeRecipient: null,
  withdrawFeeBps: null,
  cashOutVerifier: null,
  sendVerifier: null,
};

const entries = dir.contractDirectory();
const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));

// ---------------------------------------------------------------- both runs

check("every network is listed once, mainnets first in Gloam's order", () => {
  assert.deepEqual(
    entries.map((e) => e.key),
    ["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet", ...(ELYSIUM_ROW ? ["elysium-mainnet"] : []), "robinhood", "tempo", "base", "ethereum"]
  );
  assert.deepEqual(
    entries.map((e) => e.kind),
    [...Array<string>(4 + ELYSIUM_ROW).fill("mainnet"), "testnet", "testnet", "testnet", "testnet"]
  );
  assert.deepEqual(
    entries.map((e) => e.name),
    [
      "Robinhood Chain",
      "Tempo",
      "Base",
      "Ethereum",
      ...(ELYSIUM_ROW ? ["Elysium"] : []),
      "Robinhood Chain testnet",
      "Tempo Moderato testnet",
      "Base Sepolia testnet",
      "Ethereum Sepolia",
    ]
  );
});

check("a network is live here exactly when the app runs on it", () => {
  for (const e of entries) {
    assert.equal(e.live, nets.isNetworkKey(e.key), e.key);
    if (!e.live) assert.equal(e.rows.length, 0, `${e.key} is next, with no rows`);
  }
  // Every network the app runs on is in the list.
  for (const k of nets.NETWORK_KEYS) assert.equal(byKey[k]?.live, true, k);
});

check("each live network's vault, block and memo board come from the app's network data", () => {
  for (const e of entries.filter((x) => x.live)) {
    const n = nets.getNetwork(e.key);
    const vault = e.rows.find((r) => r.role === "vault");
    assert.ok(vault, `${e.key} vault`);
    assert.ok(same(vault.address, n.pool!), `${e.key} vault address`);
    assert.equal(vault.deployBlock, n.deployBlock);
    assert.equal(vault.contract, n.paymentsPool ? "ShieldPoolPayments" : "ShieldPoolPoseidon");
    const memo = e.rows.find((r) => r.role === "payment_messages");
    if (n.payMemo) {
      assert.ok(memo && same(memo.address, n.payMemo.address), `${e.key} memo`);
      assert.equal(memo.deployBlock, n.payMemo.deployBlock);
    } else {
      assert.equal(memo, undefined);
    }
    for (const r of e.rows) assert.equal(r.source, "app");
  }
});

check("swap routers only where swaps run, each from lib/vaultSwap", () => {
  for (const e of entries.filter((x) => x.live)) {
    const routers = e.rows.filter((r) => r.role === "swap_router");
    const current = VAULT_SWAP_ROUTERS[e.network.chainId];
    if (current) assert.ok(same(routers[0]!.address, current), e.key);
    else assert.equal(routers.length, 0, e.key);
  }
  assert.equal(byKey["robinhood-mainnet"]!.rows.find((r) => r.role === "swap_router")?.contract, swapV3Live(4663) ? "GloamVaultSwapV4c" : "GloamVaultSwapV4b");
  assert.equal(byKey["tempo-mainnet"]!.rows.find((r) => r.role === "swap_router")?.contract, swapV3Live(4217) ? "GloamVaultSwapTempo2" : "GloamVaultSwapTempo");
});

check("owner, treasury and deployer on the mainnet-pool vaults only; the relayer on every live network", () => {
  for (const e of entries.filter((x) => x.live)) {
    const roles = e.rows.map((r) => r.role);
    const payments = e.network.paymentsPool;
    // Elysium's vault was born guarded: its owner is the VaultOwnerGuard from the live read, never the owner wallet row
    assert.equal(roles.includes("owner"), payments && e.network.family !== "elysium", `${e.key} owner`);
    assert.equal(roles.includes("fee_recipient"), payments, `${e.key} treasury`);
    assert.equal(roles.includes("deployer"), payments, `${e.key} deployer`);
    assert.ok(roles.includes("relayer"), `${e.key} relayer`);
  }
});

check("the accounts match the deployment records", () => {
  const records = ["base-sepolia", "ethereum-sepolia", "base-mainnet", "ethereum-mainnet"]
    .map((name) => new URL(`../../contracts/deployments/${name}.json`, import.meta.url))
    .filter((u) => existsSync(u))
    .map((u) => JSON.parse(readFileSync(u, "utf8")));
  assert.ok(records.length >= 2, "the Sepolia records are there");
  for (const r of records) {
    assert.ok(same(r.owner, dir.GLOAM_OWNER), `${r.network} owner`);
    assert.ok(same(r.feeRecipient, dir.GLOAM_TREASURY), `${r.network} treasury`);
    assert.ok(same(r.relayer, dir.GLOAM_RELAYERS[0]!), `${r.network} relayer`);
    assert.ok(same(r.deployer, dir.GLOAM_DEPLOYER), `${r.network} deployer`);
    assert.ok(same(r.contracts.PoseidonT3, dir.MAINNET_POSEIDON_T3), `${r.network} PoseidonT3`);
    // The record and the app agree on the vault and its board.
    const e = entries.find((x) => x.network.chainId === r.chainId && x.live);
    if (e) {
      assert.ok(same(e.rows.find((x) => x.role === "vault")!.address, r.contracts.ShieldPoolPayments), `${r.network} vault`);
      assert.ok(same(e.rows.find((x) => x.role === "payment_messages")!.address, r.contracts.GloamPayMemo), `${r.network} memo`);
    }
  }
  const launch = JSON.parse(readFileSync(new URL("../../contracts/deployments/mainnet.json", import.meta.url), "utf8"));
  assert.ok(same(launch.owner, dir.GLOAM_OWNER));
  assert.ok(same(launch.deployer, dir.GLOAM_DEPLOYER));
  for (const c of Object.values(launch.chains) as { PoseidonT3: string }[]) assert.ok(same(c.PoseidonT3, dir.MAINNET_POSEIDON_T3));
});

check("what a vault answers becomes the checker rows, marked as read on chain", () => {
  const n = nets.getNetwork("robinhood-mainnet");
  const rows = dir.chainRows(n, RH_READ);
  assert.deepEqual(
    rows.map((r) => [r.role, r.contract]),
    [
      ["deposit_proof_checker", "ShieldIVerifierFinal"],
      ["proof_checker", "DualProofVerifier"],
      ["cash_out_proof_checker", "UnshieldIVerifierFinal"],
      ["send_proof_checker", "TransferIVerifierFinal"],
      ["poseidon", "PoseidonT3"],
    ]
  );
  for (const r of rows) assert.equal(r.source, "chain");
  // The older testnet vault: its owner comes from the chain, its checkers hold the dev keys.
  const t = dir.chainRows(nets.getNetwork("robinhood"), RH_TESTNET_READ);
  assert.equal(t[0]!.role, "owner");
  assert.equal(t[0]!.address, RH_TESTNET_READ.owner);
  assert.equal(t.find((r) => r.role === "deposit_proof_checker")!.contract, "ShieldIVerifier");
  assert.equal(t.some((r) => r.role === "cash_out_proof_checker"), false);
});

check("the checks pass on the vault as it stands and name what differs", () => {
  const n = nets.getNetwork("robinhood-mainnet");
  const ok = dir.vaultChecks(n, RH_READ);
  assert.deepEqual(
    ok.map((c) => c.label),
    ["Setup is over", "Rule changes wait 3 days", "Owner as listed", "No handover pending", "Fees go to the treasury", "Hash library as listed"]
  );
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  assert.equal(ok.find((c) => c.label === "Fees go to the treasury")!.detail, "Cash-out fee 0.5%.");
  const stillOld = dir.vaultChecks(nets.getNetwork("base"), { ...RH_READ, withdrawFeeBps: 25 });
  assert.equal(stillOld.find((c) => c.label === "Fees go to the treasury")!.detail, "Cash-out fee 0.25%.", "read from the vault, so a testnet at its own rate shows that rate");
  assert.equal(ok.find((c) => c.label === "Rule changes wait 3 days")!.detail, "The vault's delay is 3 days.");

  const off = dir.vaultChecks(n, {
    ...RH_READ,
    setupMode: true,
    changeDelay: 3_600n,
    owner: "0x000000000000000000000000000000000000dEaD",
    pendingOwner: "0x000000000000000000000000000000000000bEEF",
    feeRecipient: dir.GLOAM_OWNER,
  });
  const failed = off.filter((c) => !c.ok).map((c) => c.label);
  assert.deepEqual(failed, ["Setup is over", "Rule changes wait 3 days", "Owner as listed", "No handover pending", "Fees go to the treasury"]);
  assert.match(off.find((c) => c.label === "Owner as listed")!.detail, /0x000000000000000000000000000000000000dEaD/);

  // The owner guard: a vault it holds passes, one still on the wallet passes, a stranger fails.
  const guard = "0x00000000000000000000000000000000000000Aa" as Address;
  const stranger = "0x000000000000000000000000000000000000dEaD" as Address;
  assert.equal(dir.ownerCheck(dir.GLOAM_OWNER).ok, true);
  assert.equal(dir.ownerCheck(guard, null).ok, false, "not listed while the guard's address is unset");
  assert.equal(dir.ownerCheck(dir.GLOAM_OWNER, guard).ok, true, "a vault not moved yet");
  assert.match(dir.ownerCheck(dir.GLOAM_OWNER, guard).detail, /names the owner above/);
  assert.equal(dir.ownerCheck(guard, guard).ok, true, "a vault the guard holds");
  assert.match(dir.ownerCheck(guard, guard).detail, /owner guard holds this vault/);
  assert.equal(dir.ownerCheck(stranger, guard).ok, false);
  assert.equal(off.find((c) => c.label === "Rule changes wait 3 days")!.detail, "The vault's delay is 3600 seconds.");

  // The older testnet vaults have no fee or listed owner to check.
  const t = dir.vaultChecks(nets.getNetwork("robinhood"), RH_TESTNET_READ);
  assert.deepEqual(t.map((c) => c.label), ["Setup is over", "Rule changes wait 3 days", "No handover pending"]);
});

check("the CSV: one header, every app row, then what was read, with explorer links", () => {
  const csv = dir.directoryCsv(entries);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "network,chain_id,kind,role,name,contract,address,deploy_block,explorer_url,source");
  const live = entries.filter((e) => e.live);
  assert.equal(lines.length, 1 + live.reduce((s, e) => s + e.rows.length, 0));
  assert.ok(csv.endsWith("\r\n"));
  // Every line has the ten columns (no cell here needs quoting).
  for (const l of lines) assert.equal(l.split(",").length, 10, l);
  const vault = lines.find((l) => l.startsWith("Robinhood Chain,4663,mainnet,vault,"))!;
  assert.equal(
    vault,
    "Robinhood Chain,4663,mainnet,vault,Vault,ShieldPoolPayments,0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194,94194599,https://robin.etherscan.io/address/0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194,app"
  );
  // Next networks are not in the file.
  for (const e of entries.filter((x) => !x.live)) assert.ok(!lines.some((l) => l.includes(`,${e.network.chainId},`)), e.key);

  const withRead = dir.directoryCsv(entries, { "robinhood-mainnet": RH_READ });
  const extra = withRead.trimEnd().split("\r\n").length - lines.length;
  assert.equal(extra, dir.chainRows(nets.getNetwork("robinhood-mainnet"), RH_READ).length);
  assert.match(withRead, /Robinhood Chain,4663,mainnet,send_proof_checker,Private send proof checker,TransferIVerifierFinal,0x4dCac25a820D0C9Ede8f056378C08e31042AB7b1,,https:\/\/robin\.etherscan\.io\/address\/0x4dCac25a820D0C9Ede8f056378C08e31042AB7b1,chain/);
});

check("a CSV cell with a comma or a quote is quoted", () => {
  const fake = [{ ...entries[0]!, name: 'Chain, "quoted"', rows: entries[0]!.rows.slice(0, 1) }];
  const line = dir.directoryCsv(fake).split("\r\n")[1]!;
  assert.ok(line.startsWith('"Chain, ""quoted""",4663,'), line);
});

check("the download is named by its UTC day", () => {
  assert.equal(dir.csvFileName(new Date("2026-10-26T23:30:00Z")), "gloam-contracts-2026-10-26.csv");
});

check("deploy blocks link to the explorer's block page", () => {
  assert.equal(dir.explorerBlock(nets.getNetwork("tempo-mainnet"), 45_172_561n), "https://explore.tempo.xyz/block/45172561");
  assert.equal(dir.explorerBlock(nets.getNetwork("base"), 1n), "https://sepolia.basescan.org/block/1");
});

await checkAsync("a signed ownership statement, once pasted in, is signed by the owner", async () => {
  const s = dir.OWNERSHIP_STATEMENT;
  if (!s) return;
  const signer: Address = await recoverMessageAddress({ message: s.message, signature: s.signature });
  assert.ok(same(signer, dir.GLOAM_OWNER), `the statement is signed by ${signer}, not the owner`);
  assert.match(s.signedOn, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------- with Base and Ethereum filled in

if (!CONFIGURED) {
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SELFTEST_DIRECTORY: "configured" },
    encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0, "the run with Base and Ethereum filled in failed");
  console.log(`selftest-contract-directory (as shipped): ${checks} checks passed`);
} else {
  check("configured: Base and Ethereum mainnet join as live mainnets with no other edit", () => {
    for (const [key, id, explorer] of [
      ["base-mainnet", 8453, "https://basescan.org"],
      ["ethereum-mainnet", 1, "https://etherscan.io"],
    ] as const) {
      const e = byKey[key]!;
      assert.equal(e.live, true, key);
      assert.equal(e.kind, "mainnet");
      const pool = mainnet.mainnetPool(id)!;
      const vault = e.rows.find((r) => r.role === "vault")!;
      assert.ok(same(vault.address, pool.pool));
      assert.equal(vault.deployBlock, pool.deployBlock);
      assert.deepEqual(
        e.rows.filter((r) => r.role !== "payment_messages" && r.role !== "swap_router").map((r) => r.role),
        ["vault", "owner", "fee_recipient", "relayer", "deployer"]
      );
      const csv = dir.directoryCsv(dir.contractDirectory());
      assert.ok(csv.includes(`,${id},mainnet,vault,Vault,ShieldPoolPayments,${vault.address},${pool.deployBlock},${explorer}/address/${vault.address},app`), key);
    }
    // Still mainnets first, in order.
    assert.deepEqual(
      dir.contractDirectory().filter((e) => e.live).map((e) => e.key).slice(0, 4),
      ["robinhood-mainnet", "tempo-mainnet", "base-mainnet", "ethereum-mainnet"]
    );
  });
  console.log(`selftest-contract-directory (Base and Ethereum mainnet filled in): ${checks} checks passed`);
}
