/**
 * Provers run server-side in node, which needs the circuit artifacts as local
 * file paths (snarkjs cannot prove from a URL in node). This downloads each
 * circuit's wasm + zkey once into a cache dir and returns their paths.
 *
 * Two key sets: the testnet pools verify the dev keys, the mainnet pools the
 * trusted setup's final keys (served under /circuits/final and cached under
 * final/ here, so the two never mix). Every file is checked against the SHA-256
 * the SDK pins before it is used; a file that does not match is deleted and
 * fetched again once, then refused.
 *
 * shield backs gloam_execute_shield. transfer backs the private send that
 * settles an x402 or MPP payment and the payee's sweep; unshield backs cash out;
 * receipt backs the proof of a payment that VEYA anchors.
 */
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GLOAM_ARTIFACTS_URL, circuitArtifactFiles, type CeremonyKind, type GloamCircuit } from "@gloamtrade/sdk";

const SOURCE = (process.env.GLOAM_ARTIFACTS_SOURCE || GLOAM_ARTIFACTS_URL).replace(/\/+$/, "");
const CACHE = process.env.GLOAM_ARTIFACTS_DIR || join(tmpdir(), "gloam-mcp-circuits");

export type CircuitName = GloamCircuit;

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const checked = new Set<string>();

async function ensure(file: string, expected: string): Promise<string> {
  const dest = join(CACHE, file);
  if (checked.has(dest)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existsSync(dest) || statSync(dest).size === 0) {
      const res = await fetch(`${SOURCE}/${file}`);
      if (!res.ok) throw new Error(`Failed to fetch ${file} from ${SOURCE}: HTTP ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
    if (sha256(dest) === expected) {
      checked.add(dest);
      return dest;
    }
    rmSync(dest, { force: true });
  }
  throw new Error(`${file} from ${SOURCE} does not match its pinned SHA-256. Refusing to prove with it.`);
}

/** Local wasm + zkey paths for a circuit and key set, downloading and checking on first use. */
export async function circuitArtifacts(
  name: CircuitName,
  ceremony: CeremonyKind = "dev"
): Promise<{ wasm: string; zkey: string }> {
  const f = circuitArtifactFiles(name, ceremony);
  const [wasm, zkey] = await Promise.all([ensure(f.wasm, f.sha256.wasm), ensure(f.zkey, f.sha256.zkey)]);
  return { wasm, zkey };
}

/** Shield circuit artifacts (deposit proof). */
export function shieldArtifacts(ceremony: CeremonyKind = "dev") {
  return circuitArtifacts("shield", ceremony);
}

/** Transfer circuit artifacts (private send; settles an x402 or MPP payment, and sweeps). */
export function transferArtifacts(ceremony: CeremonyKind = "dev") {
  return circuitArtifacts("transfer", ceremony);
}

/** Unshield circuit artifacts (cash out). */
export function unshieldArtifacts(ceremony: CeremonyKind = "dev") {
  return circuitArtifacts("unshield", ceremony);
}

/** Receipt circuit artifacts (the proof of a payment, checked off chain). */
export function receiptArtifacts(ceremony: CeremonyKind = "dev") {
  return circuitArtifacts("receipt", ceremony);
}
