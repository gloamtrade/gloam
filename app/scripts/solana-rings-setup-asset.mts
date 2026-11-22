/**
 * One-time setup of an SPL token for Gloam on Solana (Helius Solana Privacy
 * Rings): creates the pool's SPL interface for a mint, its registry entry and
 * its vault. Until it exists the app shows that token as "not set up yet".
 * Anyone may create it (the protocol config says so); whoever signs pays the
 * rent, once, for everyone.
 *
 * Read on 2026-11-22: USDC and USDT are already set up on mainnet, and Circle's
 * devnet USDC on devnet. This script is for the next token.
 *
 * It reads the chain, prints the exact rent (from a simulation of the
 * transaction), and only sends with --send. It never writes a key anywhere:
 * --keypair is read once from the path given, in memory.
 *
 * RPC: SOLANA_RPC_URL, else https://<network>.helius-rpc.com with HELIUS_API_KEY,
 * both from the shell environment. Never put either in a file.
 *
 * Run from app/:
 *   ../mcp/node_modules/.bin/tsx scripts/solana-rings-setup-asset.mts --mint <MINT> [--network mainnet|devnet]
 *       [--keypair ~/.config/solana/id.json [--send]]   sign with a Solana CLI keypair file
 *       [--authority <ADDRESS>]                          or print an unsigned transaction for a wallet to sign
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getProtocolConfigAddress, getSplAssetRegistryAddress, getSplAssetVaultAddress } from "@heliuslabs/spr/addresses";
import { getCreateSplInterfaceInstructionAsync } from "@heliuslabs/spr/instructions";
import { decodeProtocolConfig, SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "@heliuslabs/spr/interface";

const TOKEN: string = SPL_TOKEN_PROGRAM_ID;
const TOKEN_2022: string = SPL_TOKEN_2022_PROGRAM_ID;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const network = arg("network") ?? "mainnet";
if (network !== "mainnet" && network !== "devnet") fail("--network is mainnet or devnet.");
const mint = arg("mint");
if (!mint || !BASE58.test(mint)) fail("Pass --mint <the token's mint address>.");
const keypairPath = arg("keypair");
const authorityArg = arg("authority");
if (!keypairPath && !authorityArg) fail("Pass --keypair <path> to sign, or --authority <address> for an unsigned transaction.");
if (authorityArg && !BASE58.test(authorityArg)) fail("--authority is a Solana address.");

const rpcUrl = (() => {
  const explicit = process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) fail("Set SOLANA_RPC_URL or HELIUS_API_KEY in the shell environment.");
  return `https://${network}.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
})();

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) fail(`${method}: ${json.error.message ?? "RPC error"}`); // the URL (and its key) is never printed
  return json.result as T;
}
type Account = { owner: string; lamports: number; data: [string, string] } | null;
const account = async (a: string) => (await rpc<{ value: Account }>("getAccountInfo", [a, { encoding: "base64", commitment: "confirmed" }])).value;
const sol = (lamports: bigint | number) => `${(Number(lamports) / 1e9).toFixed(9)} SOL`;

const registry = await getSplAssetRegistryAddress(mint as Address);
const vault = await getSplAssetVaultAddress(mint as Address);
console.log(`network        ${network}`);
console.log(`mint           ${mint}`);
console.log(`registry       ${registry}`);
console.log(`vault          ${vault}`);

if (await account(registry)) {
  console.log("\nAlready set up: the registry entry exists. Nothing to do.");
  process.exit(0);
}

const mintAccount = await account(mint);
if (!mintAccount) fail("That mint does not exist on this network.");
if (mintAccount.owner !== TOKEN && mintAccount.owner !== TOKEN_2022) fail(`That account is not a token mint (owner ${mintAccount.owner}).`);
const tokenProgram = mintAccount.owner as Address;
console.log(`token program  ${tokenProgram === TOKEN ? "SPL Token" : "Token-2022"}`);

const config = await account(await getProtocolConfigAddress());
if (!config) fail("The Privacy Rings protocol config is missing on this network.");
const protocol = decodeProtocolConfig(new Uint8Array(Buffer.from(config.data[0], "base64")));
const open = (protocol as { splInterfaceCreationIsPermissionless?: boolean }).splInterfaceCreationIsPermissionless;
if (!open) console.log("\nNote: SPL interface creation is restricted on this network; only the protocol authority can create it.");

const signer = keypairPath
  ? await (async () => {
      const path = keypairPath.replace(/^~(?=\/)/, homedir());
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(raw) || raw.length !== 64) fail("The keypair file is not a 64-byte Solana CLI keypair.");
      const bytes = Uint8Array.from(raw as number[]);
      try {
        return await createKeyPairSignerFromBytes(bytes);
      } finally {
        bytes.fill(0);
      }
    })()
  : null;
const authority = (signer?.address ?? authorityArg) as Address;
console.log(`pays           ${authority}`);

const ix = (await getCreateSplInterfaceInstructionAsync({ authority: signer ?? authority, mint: mint as Address, tokenProgram })) as Instruction;
const { value: lifetime } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
const life = { blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) } as never;

const unsignedMessage = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayer(authority, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(life, m),
  (m) => appendTransactionMessageInstructions([ix], m),
);
const unsigned = compileTransaction(unsignedMessage as never) as unknown as { messageBytes: Uint8Array; signatures: Record<string, Uint8Array | null> };
const unsignedB64 = getBase64Decoder().decode(getTransactionEncoder().encode(unsigned as never));

// The exact cost: simulate, and read the payer's balance after it
const before = (await rpc<{ value: number }>("getBalance", [authority, { commitment: "confirmed" }])).value;
const sim = await rpc<{ value: { err: unknown; logs?: string[]; accounts?: ({ lamports: number } | null)[] } }>("simulateTransaction", [
  unsignedB64,
  { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [authority] } },
]);
const fee = (await rpc<{ value: number | null }>("getFeeForMessage", [getBase64Decoder().decode(unsigned.messageBytes), { commitment: "confirmed" }])).value ?? 5000;
if (sim.value.err) {
  console.log(`\nThe simulation failed: ${JSON.stringify(sim.value.err)}`);
  for (const l of sim.value.logs ?? []) console.log(`  ${l}`);
  if (before === 0) console.log(`(${authority} holds no SOL.)`);
  process.exit(1);
}
const after = sim.value.accounts?.[0]?.lamports;
if (after === undefined) fail("The simulation did not report the payer's balance.");
const spent = before - after;
console.log(`\nrent           ${sol(spent - fee)} (${spent - fee} lamports, kept in the new accounts)`);
console.log(`network fee    ${sol(fee)}`);
console.log(`payer holds    ${sol(before)}`);

if (!signer) {
  console.log("\nUnsigned transaction (base64, version 0). Sign and send it from the wallet that holds the --authority address within a minute or so:");
  console.log(unsignedB64);
  process.exit(0);
}
if (!flag("send")) {
  console.log("\nDry run. Add --send to sign and send it.");
  process.exit(0);
}
const signedMessage = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(signer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(life, m),
  (m) => appendTransactionMessageInstructions([ix], m),
);
const signed = await signTransactionMessageWithSigners(signedMessage as never);
const wire = getBase64Decoder().decode(getTransactionEncoder().encode(signed as never));
const signature = await rpc<string>("sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed" }]);
console.log(`\nsent           ${signature}`);
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  if (await account(registry)) {
    console.log("Set up: the registry entry exists. The app lists this token now.");
    process.exit(0);
  }
}
console.log("Sent, but the registry entry is not visible yet. Check the signature in an explorer.");
