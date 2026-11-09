/**
 * Shared bits for the E2B demo: the network (Gloam's Tempo testnet pool), the
 * local .env and note files, and the transfer prover. Nothing here prints a
 * key or a note secret.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Chain, type Hex } from "viem";
import {
  artifactProver,
  circuitArtifactFiles,
  circuitArtifactUrls,
  GLOAM_NETWORKS,
  syncTree,
  TEMPO_PATHUSD,
  type PoolCircuit,
  type Prover,
  type ReceiveKey,
} from "@gloamtrade/sdk";

export const HERE = dirname(fileURLToPath(import.meta.url));

/** Tempo Moderato testnet (42431): Gloam's testnet pool, PathUSD, the dev keys, the Gloam relay. */
export const NET = GLOAM_NETWORKS.tempo;
export const ASSET = { symbol: "PathUSD", address: TEMPO_PATHUSD, decimals: 6 } as const;
export const RPC = process.env.GLOAM_RPC?.trim() || NET.rpcUrl;
export const EXPLORER = NET.explorerUrl;
export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
/** The public RPC caps eth_getLogs at 100,000 blocks. */
export const TREE = { pool: NET.pool, fromBlock: NET.deployBlock, chunkSize: 99_000n };

/** The SDK's chain object, typed for this package's viem (the SDK is built against an older one). */
export const CHAIN = NET.chain as unknown as Chain;
export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
/**
 * The same client, typed for the SDK. mppx 0.13 needs a newer viem than the
 * SDK in this repo was built against; the client is the same at runtime.
 */
export const sdkClient = publicClient as unknown as Parameters<typeof syncTree>[0];

export const SERVER_PORT = Number(process.env.PORT ?? 4402);
export const SERVER_URL = process.env.E2B_DEMO_URL ?? `http://127.0.0.1:${SERVER_PORT}`;

// ── .env (gitignored): the throwaway testnet key, the seller's receive key, the MPP secret ──
const ENV_FILE = join(HERE, ".env");
export function loadEnv() {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}
export function appendEnv(name: string, value: string) {
  appendFileSync(ENV_FILE, `${name}=${value}\n`, { mode: 0o600 });
  process.env[name] = value;
}
export function sellerReceiveKey(): ReceiveKey {
  const raw = process.env.SELLER_RECEIVE_KEY;
  if (!raw) throw new Error("No SELLER_RECEIVE_KEY in .env. Run `pnpm fund` first.");
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ReceiveKey;
}

// ── note files (gitignored): note secrets are money ──
const WALLET_DIR = join(HERE, ".wallet");
export interface HeldNote {
  secret: Hex;
  commitment: Hex;
  amountWei: string;
  status: "unspent" | "pending" | "spent";
  createdAt: string;
}
function readJson<T>(name: string, fallback: T): T {
  const p = join(WALLET_DIR, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
}
function writeJson(name: string, value: unknown) {
  mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(WALLET_DIR, name), JSON.stringify(value, null, 2), { mode: 0o600 });
}
export const agentNotes = {
  all: () => readJson<HeldNote[]>("agent-notes.json", []),
  save: (notes: HeldNote[]) => writeJson("agent-notes.json", notes),
};
export const sellerNotes = {
  all: () => readJson<HeldNote[]>("seller-notes.json", []),
  add: (n: HeldNote) => writeJson("seller-notes.json", [...sellerNotes.all(), n]),
};

// ── circuit files: the dev keys the testnet verifies, checked against their SHA-256 ──
const REPO_CIRCUITS = resolve(HERE, "../../app/public/circuits");
const CACHE = process.env.GLOAM_CIRCUITS_CACHE?.trim() || join(homedir(), ".cache", "gloam", "circuits");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function artifact(rel: string, url: string, expected: string): Promise<string> {
  for (const dir of [REPO_CIRCUITS, CACHE]) {
    const p = join(dir, rel);
    if (existsSync(p) && sha256(readFileSync(p)) === expected) return p;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url} does not match its published SHA-256. Not proving with it.`);
  const p = join(CACHE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

export async function proverFor(circuit: PoolCircuit): Promise<Prover> {
  const files = circuitArtifactFiles(circuit, NET.ceremony);
  const urls = circuitArtifactUrls(circuit, NET.chainId);
  return artifactProver({
    wasm: await artifact(files.wasm, urls.wasm, files.sha256.wasm),
    zkey: await artifact(files.zkey, urls.zkey, files.sha256.zkey),
  });
}

export const short = (s: string, n = 10) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}...${s.slice(-6)}` : s);
export const stamp = () => new Date().toISOString().slice(11, 19);
