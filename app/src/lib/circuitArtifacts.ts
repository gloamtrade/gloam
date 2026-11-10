/**
 * Circuit artifacts in /public/circuits, with SHA-256 fingerprints checked
 * before every proof (tamper detection).
 *
 * Two key sets. The testnet pools verify the single-party **dev** keys
 * (/circuits/*_final.zkey). Mainnet verifies the trusted setup's **final** keys
 * (/circuits/final/*, release ceremony-final: 13 contributors, drand round
 * 6561386). The circuits, and so the .wasm files, are the same for both. Each
 * network says which set it uses (GloamNetwork.ceremony).
 */
import { getActiveNetwork } from "./networks";

export type CeremonyKind = "dev" | "production";

/** The key set of the network the app is on. */
export function activeCeremony(): CeremonyKind {
  return getActiveNetwork().ceremony;
}

/** @deprecated the key set depends on the network; use activeCeremony(). */
export const PROVING_CEREMONY: CeremonyKind = "dev";

export const CIRCUIT_ARTIFACTS = {
  unshieldWasm: {
    path: "/circuits/unshield.wasm",
    sha256:
      "84ac0942b1618c6112a10bfe82ff0a62a80b7a14881565781eb513e9e581c480",
  },
  unshieldZkey: {
    path: "/circuits/unshield_final.zkey",
    sha256:
      "f4b4c5bfa315cef38634eec1b64b8d9ad1d28725f61fde5e169fef1896360b63",
  },
  transferWasm: {
    path: "/circuits/transfer.wasm",
    sha256:
      "081929509c3477ee264cb2422183018c23122d59952ed4a61c4932c95d360872",
  },
  transferZkey: {
    path: "/circuits/transfer_final.zkey",
    sha256:
      "f75bc324f12e1f467f5779a7275737aa0fa514a6c317e3d775f1dba8f0234666",
  },
  shieldWasm: {
    path: "/circuits/shield.wasm",
    sha256:
      "58157ec90f8af891acfa998bd599511b4d5cd06803cea32ab28a6eea8a9b2336",
  },
  shieldZkey: {
    path: "/circuits/shield_final.zkey",
    sha256:
      "e4d42271b99faa218faebb38a06f69b5ccf01e328d3dea4381ab567e9fbd2481",
  },
  /** Only for checking an older balance disclosure (lib/disclosure). */
  shieldVkey: {
    path: "/circuits/shield_vkey.json",
    sha256:
      "f4c3de52c35689296b6d2253d0368fdec47648744c28a97fa013a1bb25445986",
  },
} as const;

function hexSha256(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

const verified = new Set<string>();

/** Fetch artifact and check SHA-256. Cached per session path. */
export async function assertArtifactIntegrity(
  path: string,
  expectedSha256: string
): Promise<void> {
  const key = `${path}:${expectedSha256}`;
  if (verified.has(key)) return;

  // revalidate (a 304 when unchanged), so a copy cached before a regeneration can't fail the check forever
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Missing circuit file ${path} (${res.status}).`);
  }
  const data = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", data);
  const got = hexSha256(digest);
  if (got !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Circuit artifact hash mismatch for ${path}. Expected ${expectedSha256.slice(0, 12)}… got ${got.slice(0, 12)}…, refuse to prove.`
    );
  }
  verified.add(key);
}

export async function assertUnshieldArtifacts(): Promise<void> {
  const a = activeCircuitArtifacts();
  await assertArtifactIntegrity(a.unshieldWasm.path, a.unshieldWasm.sha256);
  await assertArtifactIntegrity(a.unshieldZkey.path, a.unshieldZkey.sha256);
}

export async function assertTransferArtifacts(): Promise<void> {
  const a = activeCircuitArtifacts();
  await assertArtifactIntegrity(a.transferWasm.path, a.transferWasm.sha256);
  await assertArtifactIntegrity(a.transferZkey.path, a.transferZkey.sha256);
}

export async function assertShieldArtifacts(): Promise<void> {
  const a = activeCircuitArtifacts();
  await assertArtifactIntegrity(a.shieldWasm.path, a.shieldWasm.sha256);
  await assertArtifactIntegrity(a.shieldZkey.path, a.shieldZkey.sha256);
}

export function isDevCeremony(): boolean {
  return activeCeremony() === "dev";
}

/** The ceremony's final proving keys (mainnet). The .wasm files are shared. */
const FINAL_ZKEYS = {
  unshieldZkey: {
    path: "/circuits/final/unshield_final.zkey",
    sha256: "5a12073f3f84b52f794feaf862fb1d48301124319db95a9c6d0dc58277fa54ed",
  },
  transferZkey: {
    path: "/circuits/final/transfer_final.zkey",
    sha256: "bdbae966705bc85e76571b4945da74a43fc4503a955fd4e3799358bcff749cdb",
  },
  shieldZkey: {
    path: "/circuits/final/shield_final.zkey",
    sha256: "3054877c35e2e0e9f76c43aa4791ac2b3ac51b8967d51be2215e89c0a5fbb512",
  },
  shieldVkey: {
    path: "/circuits/final/shield_vkey.json",
    sha256: "b2e9571b7869b77b170d5e53a8f36bd94da2db6d30bc860b40e2db85ea328313",
  },
} as const;

type ArtifactSet = { [K in keyof typeof CIRCUIT_ARTIFACTS]: { path: string; sha256: string } };

/** The files for one key set. */
export function circuitArtifactsFor(ceremony: CeremonyKind): ArtifactSet {
  return ceremony === "production" ? { ...CIRCUIT_ARTIFACTS, ...FINAL_ZKEYS } : CIRCUIT_ARTIFACTS;
}

/** The files for the network the app is on. */
export function activeCircuitArtifacts(): ArtifactSet {
  return circuitArtifactsFor(activeCeremony());
}
