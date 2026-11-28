/**
 * Makes Gloam's Starknet relay account: the account that sends every pool
 * transaction and pays the pool's STRK fee and the gas. Mainnet unless
 * STARKNET_NETWORK says otherwise.
 *
 * Run it on your own machine. The key is made here, saved to a file only you
 * can read, and never printed.
 *
 * From app/:
 *   ../mcp/node_modules/.bin/tsx scripts/starknet-relay-account.mts new
 *     Makes the key, saves it, prints the account's address. Send STRK there.
 *   ../mcp/node_modules/.bin/tsx scripts/starknet-relay-account.mts deploy
 *     Once the STRK has landed: deploys the account, paid from that STRK.
 *     Shows the fee and asks before it sends.
 *   ../mcp/node_modules/.bin/tsx scripts/starknet-relay-account.mts status
 *     Address, STRK balance, deployed or not.
 *   ../mcp/node_modules/.bin/tsx scripts/starknet-relay-account.mts vercel
 *     Prints the two commands that put the address and the key in Vercel
 *     straight from the file (the key never shows on screen).
 *
 * The account is an OpenZeppelin account (constructor [public key], salt =
 * public key), the same class as every Gloam Starknet account.
 *
 * Environment (optional):
 *  - STARKNET_NETWORK: mainnet (default), sepolia or devnet.
 *  - STARKNET_RPC_URL: the node to use (default: the network's public node).
 *  - GLOAM_RELAY_KEY_FILE: where the key lives (default ~/.gloam/starknet-relay-<network>.json).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Account, CallData, RpcProvider, addAddressPadding, ec, hash, num } from "starknet";
import { STARKNET_ACCOUNT_CLASS_HASH, STARKNET_STRK, starknetConfig, type StarknetNetwork } from "../src/lib/starknetPrivacy/config";

const env = process.env as Record<string, string | undefined>;
const raw = (env.STARKNET_NETWORK ?? "mainnet").trim();
if (raw !== "mainnet" && raw !== "sepolia" && raw !== "devnet") {
  console.error(`STARKNET_NETWORK must be mainnet, sepolia or devnet (got "${raw}").`);
  process.exit(1);
}
const network = raw as StarknetNetwork;
const cfg = starknetConfig(network);
const rpcUrl = (env.STARKNET_RPC_URL ?? "").trim() || cfg.rpcUrl;
const keyFile = (env.GLOAM_RELAY_KEY_FILE ?? "").trim() || join(homedir(), ".gloam", `starknet-relay-${network}.json`);
const node = new RpcProvider({ nodeUrl: rpcUrl, batch: 0 });

type KeyFile = { network: StarknetNetwork; address: string; publicKey: string; secret: string; classHash: string; created: string };

const CURVE_ORDER: bigint = ec.starkCurve.CURVE.n;

/** A uniform Stark private key in [1, n). */
function newSecret(): string {
  for (;;) {
    const k = BigInt("0x" + randomBytes(32).toString("hex"));
    if (k > 0n && k < CURVE_ORDER) return num.toHex(k);
  }
}

/** The account's address, padded to 64 hex digits (some exchanges refuse a shorter one). */
function addressFor(publicKey: string): string {
  return addAddressPadding(num.toHex(hash.calculateContractAddressFromHash(publicKey, STARKNET_ACCOUNT_CLASS_HASH, CallData.compile([publicKey]), 0)));
}

function load(): KeyFile {
  if (!existsSync(keyFile)) {
    console.error(`No relay key at ${keyFile}. Run "new" first.`);
    process.exit(1);
  }
  const k = JSON.parse(readFileSync(keyFile, "utf8")) as KeyFile;
  if (k.network !== network) {
    console.error(`${keyFile} is for ${k.network}, not ${network}.`);
    process.exit(1);
  }
  // The file must still describe itself: the address comes from the key.
  const pub = ec.starkCurve.getStarkKey(k.secret);
  if (BigInt(pub) !== BigInt(k.publicKey) || BigInt(addressFor(pub)) !== BigInt(k.address)) {
    console.error(`${keyFile} doesn't match itself (key, public key and address disagree). Not using it.`);
    process.exit(1);
  }
  return k;
}

async function strkBalance(address: string): Promise<bigint> {
  const r = await node.callContract({ contractAddress: STARKNET_STRK, entrypoint: "balance_of", calldata: [address] });
  return BigInt(r[0] ?? 0) + (BigInt(r[1] ?? 0) << 128n);
}

async function deployed(address: string): Promise<boolean> {
  try {
    await node.getClassHashAt(address);
    return true;
  } catch {
    return false;
  }
}

const strk = (wei: bigint): string => {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) * 10_000n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(4, "0")} STRK`;
};

async function cmdNew(): Promise<void> {
  if (existsSync(keyFile)) {
    const k = load();
    console.log(`A relay key already exists at ${keyFile}. Not making another.`);
    console.log(`Address: ${k.address}`);
    return;
  }
  const secret = newSecret();
  const publicKey = ec.starkCurve.getStarkKey(secret);
  const address = addressFor(publicKey);
  const file: KeyFile = { network, address, publicKey, secret, classHash: STARKNET_ACCOUNT_CLASS_HASH, created: new Date().toISOString() };
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Saved the relay key to ${keyFile} (only you can read it).`);
  console.log(`Back that file up somewhere safe, a password manager for example. Lose it and the STRK in the account is lost.`);
  console.log("");
  console.log(`Relay address on Starknet ${network}:`);
  console.log(address);
  console.log("");
  console.log(`Next: send STRK to that address (on Starknet, not Ethereum), then run "deploy".`);
}

async function cmdStatus(): Promise<void> {
  const k = load();
  const [bal, live] = await Promise.all([strkBalance(k.address), deployed(k.address)]);
  console.log(`Network:  ${network}`);
  console.log(`Address:  ${k.address}`);
  console.log(`STRK:     ${strk(bal)}`);
  console.log(`Deployed: ${live ? "yes" : "no"}`);
}

async function cmdDeploy(): Promise<void> {
  const k = load();
  if (await deployed(k.address)) {
    console.log(`Already deployed: ${k.address}`);
    return;
  }
  const bal = await strkBalance(k.address);
  if (bal === 0n) {
    console.error(`No STRK at ${k.address} yet. Send some, then run "deploy" again.`);
    process.exit(1);
  }
  const account = new Account({ provider: node, address: k.address, signer: k.secret, cairoVersion: "1" });
  const payload = { classHash: STARKNET_ACCOUNT_CLASS_HASH, constructorCalldata: CallData.compile([k.publicKey]), addressSalt: k.publicKey, contractAddress: k.address };
  const est = await account.estimateAccountDeployFee(payload);
  const fee = BigInt((est as { overall_fee: bigint | string | number }).overall_fee);
  console.log(`Network: ${network}`);
  console.log(`Address: ${k.address}`);
  console.log(`STRK:    ${strk(bal)}`);
  console.log(`Fee:     about ${strk(fee)}`);
  if (fee >= bal) {
    console.error(`Not enough STRK to deploy. Send more, then run "deploy" again.`);
    process.exit(1);
  }
  if (network !== "devnet" || !env.GLOAM_RELAY_YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`Deploy the relay account on ${network}? Type yes to send: `)).trim().toLowerCase();
    rl.close();
    if (a !== "yes") {
      console.log("Not sent.");
      return;
    }
  }
  const r = await account.deployAccount(payload);
  console.log(`Sent: ${r.transaction_hash}`);
  const receipt = (await node.waitForTransaction(r.transaction_hash)) as { execution_status?: string; isSuccess?: () => boolean };
  const ok = typeof receipt.isSuccess === "function" ? receipt.isSuccess() : receipt.execution_status === "SUCCEEDED";
  if (!ok || !(await deployed(k.address))) {
    console.error(`The deploy didn't land. Check ${r.transaction_hash} on Voyager or Starkscan.`);
    process.exit(1);
  }
  console.log(`Deployed. STRK left: ${strk(await strkBalance(k.address))}`);
  console.log(`Next: run "vercel" for the two commands that set it in Vercel.`);
}

async function cmdVercel(): Promise<void> {
  const k = load();
  if (!(await deployed(k.address))) console.log(`Note: the account isn't deployed yet. Run "deploy" first.\n`);
  const read = (field: "address" | "secret") =>
    `node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).${field})' ${JSON.stringify(keyFile)}`;
  console.log(`From the gloam folder (the one linked to the gloam-trade Vercel project), run:\n`);
  console.log(`${read("address")} | vercel env add GLOAM_STARKNET_RELAYER_ADDRESS --environment production`);
  console.log("");
  console.log(`${read("secret")} | vercel env add GLOAM_STARKNET_RELAYER_SECRET --environment production --sensitive`);
  console.log("");
  console.log(`The key goes from the file into Vercel without showing on screen. Redeploy for it to take effect.`);
}

const cmd = process.argv[2];
const run: Record<string, () => Promise<void>> = { new: cmdNew, status: cmdStatus, deploy: cmdDeploy, vercel: cmdVercel };
if (!cmd || !run[cmd]) {
  console.log("Usage: starknet-relay-account.mts new | deploy | status | vercel");
  process.exit(cmd ? 1 : 0);
}
await run[cmd]!();
