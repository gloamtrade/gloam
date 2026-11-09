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
import { createPublicClient, http, type Chain, type Hex, type Transport } from "viem";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  artifactProver,
  circuitArtifactFiles,
  circuitArtifactUrls,
  gloamLeafSeed,
  GLOAM_NETWORKS,
  syncTree,
  TEMPO_PATHUSD,
  type PoolCircuit,
  type Prover,
  type ReceiveKey,
  type TreeStore,
  type TreeSyncParams,
} from "@gloamtrade/sdk";

export const HERE = dirname(fileURLToPath(import.meta.url));

/** Tempo Moderato testnet (42431): Gloam's testnet pool, PathUSD, the dev keys, the Gloam relay. */
export const NET = GLOAM_NETWORKS.tempo;
export const ASSET = { symbol: "PathUSD", address: TEMPO_PATHUSD, decimals: 6 } as const;
export const RPC = process.env.GLOAM_RPC?.trim() || NET.rpcUrl;
export const EXPLORER = NET.explorerUrl;
export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;

/**
 * The pool's tree, kept between runs. Each side keeps its own copy in
 * .cache/ (gitignored, public chain data only) and reads only the blocks since
 * the last run. A cold start loads Gloam's public leaf list in one request
 * instead of walking ~6M blocks of logs; the SDK checks the rebuilt root
 * against the pool before using it, and walks the chain itself on a mismatch.
 */
export const treeCacheFile = (who: "agent" | "server") => join(HERE, ".cache", `${who}-tree-${NET.chainId}.json`);
export function treeParams(who: "agent" | "server"): TreeSyncParams {
  return {
    pool: NET.pool,
    fromBlock: NET.deployBlock,
    chunkSize: 99_000n, // the public RPC caps eth_getLogs at 100,000 blocks
    concurrency: 3, // only used if the chain has to be walked
    seed: gloamLeafSeed(NET.key),
    store: fileTreeStore(treeCacheFile(who)),
  };
}

/** A TreeStore in a JSON file (written to a temp file, then renamed). */
export function fileTreeStore(path: string): TreeStore {
  return {
    load: async () => JSON.parse(await readFile(path, "utf8")),
    save: async (snapshot) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(snapshot));
      await rename(`${path}.tmp`, path);
    },
  };
}

/** The SDK's chain object, typed for this package's viem (the SDK is built against an older one). */
export const CHAIN = NET.chain as unknown as Chain;
/**
 * Reads that have not answered in HEDGE_MS are sent a second time, and the
 * first answer wins. The public testnet RPC answers most calls in under a
 * second but stalls one now and then for several, and a payment makes a dozen
 * calls in a row. Reads only: nothing here sends a transaction (the relay does).
 */
const HEDGE_MS = 1_200;
const HEDGED = new Set(["eth_blockNumber", "eth_call", "eth_chainId", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber"]);
function hedged(inner: Transport): Transport {
  return (opts) => {
    const t = inner(opts);
    const request = ((args: { method: string }) => {
      if (!HEDGED.has(args.method)) return t.request(args as never);
      return new Promise<unknown>((resolve, reject) => {
        let done = false;
        const settle = (f: (v: unknown) => void) => (v: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          f(v);
        };
        t.request(args as never).then(settle(resolve), settle(reject));
        const timer = setTimeout(() => t.request(args as never).then(settle(resolve), settle(reject)), HEDGE_MS);
      });
    }) as typeof t.request;
    return { ...t, request };
  };
}

/** Tempo makes a block about every half second: poll receipts at that pace, not viem's 4 s default. */
export const publicClient = createPublicClient({ chain: CHAIN, transport: hedged(http(RPC)), pollingInterval: 250 });
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

/** Wall-clock time per phase of one purchase, printed after it. Overlapping calls in one phase count once. */
export class Phases {
  readonly start = Date.now();
  private rows: [string, number][] = [];
  private open = new Map<string, { n: number; since: number }>();
  add(name: string, ms: number) {
    const row = this.rows.find((r) => r[0] === name);
    if (row) row[1] += ms;
    else this.rows.push([name, ms]);
  }
  total(name: string): number {
    return this.rows.find((r) => r[0] === name)?.[1] ?? 0;
  }
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const o = this.open.get(name) ?? { n: 0, since: 0 };
    if (o.n++ === 0) o.since = Date.now();
    this.open.set(name, o);
    if (!this.rows.some((r) => r[0] === name)) this.rows.push([name, 0]);
    try {
      return await fn();
    } finally {
      if (--o.n === 0) this.add(name, Date.now() - o.since);
    }
  }
  summary(): string {
    const total = Date.now() - this.start;
    const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const timed = this.rows.reduce((a, r) => a + r[1], 0);
    const rows = [...this.rows, ...(total - timed > 50 ? [["other", total - timed] as [string, number]] : [])];
    return `${rows.map(([n, ms]) => `${n} ${s(ms)}`).join(" | ")} | total ${s(total)}`;
  }
}
