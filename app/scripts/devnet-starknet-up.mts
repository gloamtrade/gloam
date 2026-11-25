/**
 * Local only: get the app's Starknet side running against a local starknet-devnet,
 * to click through it in a browser. Deploys the privacy pool (the SDK's test
 * screener key, as scripts/e2e-starknet-devnet.mts does) on a devnet you started,
 * and prints the environment for `next dev`: the flag, the network, the pool, the
 * devnet's address, and one of devnet's predeployed accounts as the relay (devnet's
 * own throwaway keys, printed here and never written anywhere).
 *
 * Start devnet with blocks on a timer, so the app's 10-block waits move on their own:
 *   starknet-devnet --lite-mode --seed 42 --block-generation-on 1 --state-archive-capacity full \
 *     --chain-id SN_DEVNET --proof-mode none --port 5081
 * Then, from app/:
 *   STARKNET_DEVNET_URL=http://127.0.0.1:5081 STARKNET_POOL_ARTIFACTS=<starknet-privacy>/target/dev \
 *     ../mcp/node_modules/.bin/tsx scripts/devnet-starknet-up.mts
 * Optionally FUND=<address> sends 5.0 of devnet's test token to that address.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, CallData, RpcProvider, ec, hash, num } from "starknet";

const URL = process.env.STARKNET_DEVNET_URL ?? "http://127.0.0.1:5081";
const ART = process.env.STARKNET_POOL_ARTIFACTS ?? "";
const TOKEN = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const TEST_SCREENER_KEY = "0xCAFEBABE";

const rpc = (method: string, params: unknown = []) =>
  fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result: unknown }>);

const node = new RpcProvider({ nodeUrl: URL, batch: 0 });
const pre = (await rpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
const admin = new Account({ provider: node, address: pre[0]!.address, signer: pre[0]!.private_key, cairoVersion: "1" });

if (process.env.FUND) {
  const to = process.env.FUND;
  const r = await admin.execute({ contractAddress: TOKEN, entrypoint: "transfer", calldata: CallData.compile([to, num.toHex(5n * 10n ** 18n), "0x0"]) });
  await node.waitForTransaction(r.transaction_hash);
  console.log(`funded ${to} with 5.0 test token`);
  process.exit(0);
}

if (!ART) throw new Error("Set STARKNET_POOL_ARTIFACTS to the pool's target/dev folder.");
const contract = JSON.parse(readFileSync(join(ART, "privacy_Privacy.contract_class.json"), "utf8"));
const casm = JSON.parse(readFileSync(join(ART, "privacy_Privacy.compiled_contract_class.json"), "utf8"));
const classHash = hash.computeContractClassHash(contract);
let declared = true;
try {
  await node.getClass(classHash);
} catch {
  declared = false;
}
if (!declared) {
  const d = await admin.declare({ contract, casm, compiledClassHash: hash.computeCompiledClassHash(casm) });
  await node.waitForTransaction(d.transaction_hash);
}
const deployed = await admin.deployContract({
  classHash,
  constructorCalldata: [admin.address, "0x1", ec.starkCurve.getStarkKey(TEST_SCREENER_KEY), "450"],
  salt: num.toHex(BigInt(Date.now())),
});
await node.waitForTransaction(deployed.transaction_hash);
const pool = num.toHex(BigInt(deployed.contract_address));
const relay = pre[2]!;
console.log(
  [
    "NEXT_PUBLIC_STARKNET_ENABLED=1",
    "NEXT_PUBLIC_STARKNET_NETWORK=devnet",
    `NEXT_PUBLIC_STARKNET_POOL=${pool}`,
    `NEXT_PUBLIC_STARKNET_DEVNET_RPC=${URL}`,
    `GLOAM_STARKNET_RELAYER_ADDRESS=${relay.address}`,
    `GLOAM_STARKNET_RELAYER_SECRET=${relay.private_key}`,
  ].join("\n")
);
