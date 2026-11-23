/*
 * Recording demo: stand-ins for the chain and the relay (switch in
 * lib/demoFlag.ts). Each lib that would touch the network checks the switch
 * once and lands here instead, so the app's own code (witnesses, tickets,
 * notes) runs end to end against the pretend wallet in ./store.
 */

import { MERKLE_DEPTH } from "@gloamtrade/sdk";
import { parseUnits, zeroAddress, type Address, type Hex } from "viem";
import type { GloamContact } from "@/lib/contacts";
import type { PoseidonMerklePath } from "@/lib/merklePoseidon";
import { getActiveNetwork, getNetwork, NETWORK_KEYS } from "@/lib/networks";
import { noteCommitmentPoseidon } from "@/lib/notePoseidon";
import type { ScannedMemo } from "@/lib/payMemo";
import { hexToField } from "@/lib/poseidon";
import type { RelayNetworkStatus } from "@/lib/relay/client";
import { TEMPO_STABLE_TOKENS } from "@/lib/tokens";
import type { SyncedTree } from "@/lib/treeSync";
import { DATED_OFF_MESSAGE, datedOff, drawSendAfter, drawSendOn, type DelayWindow } from "@/lib/relay/scheduled";
import {
  DEMO_MS,
  creditDemoWallet,
  demoCashOutJob,
  demoCashOutJobs,
  demoIncoming,
  demoLeafCount,
  demoLeafOpening,
  demoNotes,
  demoPoolDeposited,
  demoSentLeaves,
  demoTxStatus,
  jitter,
  putDemoCashOutJob,
  randomField,
  randomHex,
  setDemoIncomingTicket,
  settleDueDemoCashOut,
  sleep,
  submitDemoTx,
  type DemoCashOutJob,
} from "./store";

// ------------------------------------------------------------------ relay

const RELAYER: Address = "0x51c4e3A0B7D29f86A10083D08b6f2a947e0C1D35";

/** The relay is up on every network, memos included. */
export function demoRelayStatus(): RelayNetworkStatus[] {
  return NETWORK_KEYS.map((key) => ({
    chainId: getNetwork(key).chainId,
    key,
    enabled: true,
    relayer: RELAYER,
    memo: true,
    lowBalance: false,
    gasHigh: false,
    maxGasGwei: null,
    gasGwei: null,
    topUps: !datedOff(getNetwork(key).chainId),
  }));
}

/** The relay taking a proven action. It lands like any other transaction, minus the wallet. */
export async function demoRelay(body: Record<string, unknown>): Promise<Hex> {
  await sleep(jitter(DEMO_MS.relay));
  // A cash out pays the wallet; sends and memos only touch the vault.
  const wallet: [Address, bigint][] =
    body.action === "unshield" ? [[body.asset as Address, BigInt(body.amount as bigint)]] : [];
  // A transfer's two notes take leaves, as the pool gives them: the payment's
  // (so its claim link can be claimed) and the change (so a split's change can
  // be split again before this tab saves its leaf).
  const sent =
    body.action === "transfer"
      ? [...(body.commitments as readonly Hex[])]
      : body.action === "transferBatch"
        ? (body.parts as { commitments: readonly Hex[] }[]).flatMap((p) => [...p.commitments])
        : [];
  return submitDemoTx(Number(body.chainId), { wallet, sent });
}

/** Waits for a pretend transaction to land, like the app's receipt wait. */
export async function demoWaitForTx(hash: Hex, timeoutMs: number): Promise<"success"> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (demoTxStatus(hash) === "confirmed") return "success";
    await sleep(150);
  }
  throw new Error("demo: the transaction did not land in time");
}

// ------------------------------------------------------------------ cash out later

type DemoOwnedJob = { id: string; chainId: number; sendAfter: number; status: DemoCashOutJob["status"]; updatedAt: number; hash?: Hex; to: Address };

function owned(j: DemoCashOutJob): DemoOwnedJob {
  return { id: j.id, chainId: j.chainId, sendAfter: j.sendAfter, status: j.status, updatedAt: j.updatedAt, to: j.to, ...(j.hash ? { hash: j.hash } : {}) };
}

/**
 * The pretend relay taking a proven cash out for later, by the relay's own
 * rules (lib/relay/scheduled): a random send time inside the window or the
 * day, and one live job per spend (the same cash out comes back, another address is refused).
 */
export async function demoScheduleCashOut(p: {
  chainId: number;
  nullifier: Hex;
  asset: Address;
  to: Address;
  amount: bigint;
  window?: DelayWindow;
  day?: number;
}): Promise<{ ok: true; job: DemoOwnedJob } | { ok: false; code: string; error: string; job?: DemoOwnedJob }> {
  await sleep(jitter(DEMO_MS.relay));
  if (p.day !== undefined && datedOff(p.chainId)) return { ok: false, code: "dated_off", error: DATED_OFF_MESSAGE };
  const live = demoCashOutJobs().find(
    (j) => j.chainId === p.chainId && j.nullifier.toLowerCase() === p.nullifier.toLowerCase() && j.status === "scheduled"
  );
  if (live) {
    const same = live.to.toLowerCase() === p.to.toLowerCase() && live.amount === p.amount.toString();
    return same
      ? { ok: true, job: owned(live) }
      : { ok: false, code: "already_scheduled", error: "Already scheduled to another address. Cancel it first.", job: owned(live) };
  }
  const now = Date.now();
  const job: DemoCashOutJob = {
    id: crypto.randomUUID(),
    chainId: p.chainId,
    nullifier: p.nullifier,
    asset: p.asset,
    to: p.to,
    amount: p.amount.toString(),
    sendAfter: p.day !== undefined ? drawSendOn(now, p.day) : drawSendAfter(now, p.window ?? "day"),
    status: "scheduled",
    updatedAt: now,
  };
  putDemoCashOutJob(job);
  return { ok: true, job: owned(job) };
}

/** Where a pretend job stands; one that is due goes out now. */
export function demoCashOutStatus(id: string): DemoOwnedJob | "gone" {
  const job = settleDueDemoCashOut(id) ?? demoCashOutJob(id);
  return job ? owned(job) : "gone";
}

/** The pretend relay taking a newer proof of a waiting job, by the relay's rules (lib/relay/scheduled replaceRefusal). */
export async function demoReplaceCashOutProof(
  id: string,
  p: { chainId: number; nullifier: Hex; asset: Address; to: Address; amount: bigint }
): Promise<{ status: "replaced"; job: DemoOwnedJob } | { status: "kept"; code: string }> {
  await sleep(jitter(DEMO_MS.relay));
  const job = demoCashOutJob(id);
  if (!job) return { status: "kept", code: "not_found" };
  if (job.status !== "scheduled") return { status: "kept", code: "not_live" };
  if (job.sendAfter - Date.now() < 60_000) return { status: "kept", code: "too_late" };
  const same =
    job.chainId === p.chainId &&
    job.nullifier.toLowerCase() === p.nullifier.toLowerCase() &&
    job.to.toLowerCase() === p.to.toLowerCase() &&
    job.asset.toLowerCase() === p.asset.toLowerCase() &&
    job.amount === p.amount.toString();
  if (!same) return { status: "kept", code: "mismatch" };
  const next = { ...job, updatedAt: Date.now() };
  putDemoCashOutJob(next);
  return { status: "replaced", job: owned(next) };
}

/** Cancels a pretend job that has not gone out. */
export function demoCancelCashOut(id: string): "cancelled" | "going" | "over" | "gone" {
  const job = demoCashOutJob(id);
  if (!job) return "gone";
  if (job.status === "sent") return "going";
  if (job.status === "cancelled") return "over";
  putDemoCashOutJob({ ...job, status: "cancelled", updatedAt: Date.now() });
  return "cancelled";
}

// ------------------------------------------------------------------ vault

/** The vault tree as the app's own sync would build it for the pretend wallet. */
export function demoSyncedTree(): SyncedTree | null {
  const net = getActiveNetwork();
  if (!net.pool) return null;
  const indexByCommitment = new Map<string, number>();
  for (const n of demoNotes()) {
    if (n.chainId === net.chainId && n.leafIndex != null) {
      indexByCommitment.set(n.commitment.toLowerCase(), n.leafIndex);
    }
  }
  const incoming = demoIncoming(net.chainId);
  if (incoming) indexByCommitment.set(incoming.commitment.toLowerCase(), incoming.leafIndex);
  for (const [commitment, leaf] of demoSentLeaves(net.chainId)) indexByCommitment.set(commitment, leaf);
  return {
    scheme: "poseidon",
    leaves: [],
    root: randomField(),
    leafCount: demoLeafCount(net.chainId),
    indexByCommitment,
    pathForLeaf: (leafIndex) => demoPath(net.chainId, leafIndex),
  };
}

/** A path whose leaf is exactly what the note's secret opens, so the app's own witness checks pass. */
async function demoPath(chainId: number, leafIndex: number): Promise<PoseidonMerklePath | null> {
  const opening = demoLeafOpening(chainId, leafIndex);
  if (!opening) return null;
  const leaf = await noteCommitmentPoseidon(
    hexToField(opening.secret),
    BigInt(opening.amountWei),
    opening.asset
  );
  return {
    leafIndex,
    leaf,
    pathElements: Array.from({ length: MERKLE_DEPTH }, () => 0n),
    pathIndices: Array.from({ length: MERKLE_DEPTH }, (_, i) => (leafIndex >> i) & 1),
    root: hexToField(randomField()),
  };
}

export function demoPoolInventory(asset: Address): bigint {
  return demoPoolDeposited(getActiveNetwork().chainId, asset);
}

// ------------------------------------------------------------------ receive

/** The memo board as this wallet would scan it: the payment waiting for it, sealed to this browser's Gloam address. */
export async function demoPaymentMemos(): Promise<ScannedMemo[]> {
  const net = getActiveNetwork();
  const incoming = demoIncoming(net.chainId);
  await sleep(jitter(DEMO_MS.lookup));
  if (!incoming || !net.pool) return [];
  const { encryptTicketForTag, getOrCreateReceiveIdentity } = await import("@/lib/receiveTag");
  const { buildNotePackage, encodeNotePackage } = await import("@/lib/notePackage");
  const { tag } = await getOrCreateReceiveIdentity();
  let ticket = incoming.tag === tag ? incoming.ticket : undefined;
  if (!ticket) {
    const pack = buildNotePackage({
      pool: net.pool,
      asset: incoming.asset,
      amountWei: incoming.amountWei,
      secret: incoming.secret,
      commitment: incoming.commitment,
      note: incoming.note,
      chainId: net.chainId,
    });
    ticket = await encryptTicketForTag(encodeNotePackage(pack), tag);
    setDemoIncomingTicket(net.chainId, tag, ticket);
  }
  return [{ paymentCommitment: incoming.commitment, poster: zeroAddress, ticket, txHash: randomHex(32) }];
}

/** People the pretend wallet pays (their Gloam addresses are real keys, so tickets seal properly). */
export const DEMO_CONTACTS: GloamContact[] = [
  {
    id: "demo-yomi",
    label: "Yomi",
    tag: "gloamr1.MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkMUNu5NN3FOsOG3Z0pvzYSQ_drriwWSh1iEL8utrczEhpgvn82l6aQTNS5Gb1lgSTp6CcHyN_Kt-99sBkfxZcQ",
    createdAt: Date.UTC(2026, 7, 20),
  },
  {
    id: "demo-robin",
    label: "Robin",
    tag: "gloamr1.MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMnv8F155ZLPr2-tjkzzDkkCQAGKW6e7glwei2RslxV80tmsWjAxyNCwgwMOCYTX5K-NLfzBuPywTi8pKZILhCQ",
    createdAt: Date.UTC(2026, 7, 22),
  },
  {
    id: "demo-kris",
    label: "Kris",
    tag: "gloamr1.MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWVpX3EE43uHltrRhrsfNqaoKWb2rBrt_JpE4uCI7sLHzZrUT8ceUibdpjv3GyGIVh_rsySrSDuivDgc3Y_06UA",
    createdAt: Date.UTC(2026, 8, 2),
  },
];

// ------------------------------------------------------------------ faucet

/** Tempo's faucet: a short wait, then 1,000 of each test stablecoin lands in the wallet. */
export async function demoFundTempo(): Promise<string[]> {
  await sleep(jitter(DEMO_MS.faucet));
  creditDemoWallet(
    getNetwork("tempo").chainId,
    TEMPO_STABLE_TOKENS.map((t) => [t.address, parseUnits("1000", t.decimals)])
  );
  return [];
}
