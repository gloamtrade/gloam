/**
 * Payments to your Gloam address land in your private balance on their own.
 *
 * Someone who pays a Gloam address (gloamr1…, or a name that points to one)
 * posts the payment's code, encrypted to that address, on the network's
 * payment-memo board. Only the browser holding the address's receive key can
 * open it. This reads the board and, for every payment that opens with this
 * account's key, is in the vault and is still unspent, saves it to the balance
 * as a claimed payment, the same as Receive > Claim does.
 *
 * The payer made that payment's secret, so it is then secured: moved through
 * the relay into a fresh note only this browser knows (secureClaimsInBackground,
 * which hooks/useLocalShieldNotes runs right after). Nobody taps anything.
 *
 * Each network is read from where the last read stopped (a cursor per signed-in
 * account and vault), a few blocks back in case of a reorg, and at most once a
 * minute. Nothing is sent anywhere: the board is read like any other log, and
 * every payment is checked against the vault before it is counted.
 */
import type { Address, Hex, PublicClient } from "viem";
import { keepStorage } from "./backupGate";
import { CLAIM_PREFIX } from "./claimSweep";
import { accountShown } from "./accountSlot";
import { receiveCursorEpoch, receiveCursorKey } from "./receiveCursor";
import { knownTokens } from "./tokens";
import { readDemo } from "./demoFlag";
import { decodeNotePackage } from "./notePackage";
import { noteCommitmentPoseidon, noteNullifierPoseidon } from "./notePoseidon";
import { fetchPaymentMemos } from "./payMemo";
import { fieldToHex, hexToField } from "./poseidon";
import { claimNetworkProblem } from "./paymentRequest";
import { publicClientFor } from "./rhClient";
import { dataKeyLocked, getAllNotes } from "./noteVault";
import { isNativeAsset, saveLocalNote, shieldPoolAbi, type LocalNote } from "./shield";
import { displayAmount } from "./amountShort";
import { syncShieldTree } from "./treeSync";
import type { GloamNetwork, NetworkKey } from "./networks";

/** Fired on window with the payments that just landed, so the page can say so. */
export const PAYMENTS_RECEIVED_EVENT = "gloam:payments-received";

export type ReceivedPayment = {
  label: string;
  note?: string;
  /** The network's name ("Ethereum") and key, to show it and switch to it. */
  network: string;
  networkKey: NetworkKey;
  asset: Address;
  amountWei: string;
};

/** Blocks read again each time, in case the last ones were reorganised away. */
const REORG_BLOCKS = 64n;
/** At most one read of a network's board this often, ms. */
export const RECEIVE_EVERY_MS = 60_000;

const lastRun = new Map<string, number>();
const running = new Set<string>();

function cursorKey(net: GloamNetwork): string | null {
  if (!net.pool) return null;
  return receiveCursorKey(net.chainId, net.pool);
}

/**
 * "0.50 BNB" read on the network the payment landed on, not the one shown:
 * its native coin's name (ETH, BNB, HYPE) and its token's decimals (USDT and
 * USDC have 18 on BNB Chain, 6 elsewhere).
 */
export function receivedLabel(net: Pick<GloamNetwork, "chainId" | "primaryAsset">, amountWei: string, asset: string): string {
  const token = isNativeAsset(asset) ? null : knownTokens(net.chainId).find((t) => t.address.toLowerCase() === asset.toLowerCase());
  const symbol = isNativeAsset(asset) ? net.primaryAsset.symbol : (token?.symbol ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`);
  const decimals = isNativeAsset(asset) ? 18 : (token?.decimals ?? 18);
  let raw: bigint;
  try {
    raw = BigInt(amountWei);
  } catch {
    return `${amountWei} ${symbol}`;
  }
  return `${displayAmount(raw, decimals)} ${symbol}`;
}

/**
 * The note id of a payment that landed here: the same for every tab and pass,
 * from its commitment, so two saves of one payment are one note.
 */
export function receivedNoteId(commitment: string): string {
  return `${CLAIM_PREFIX}rx-${commitment.toLowerCase()}`;
}

function readCursor(key: string): bigint | null {
  try {
    const v = window.localStorage.getItem(key);
    return v && /^\d{1,20}$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

function writeCursor(key: string, block: bigint): void {
  try {
    window.localStorage.setItem(key, block.toString());
  } catch {
    /* storage off: the next read starts from the board's first block again, which is only slower */
  }
}

/**
 * Reads one network's board and saves each new payment for this account to
 * the balance. Returns what landed (empty when nothing did, or when it isn't
 * time yet). `force` skips the once-a-minute pacing.
 */
export async function receiveWaitingPayments(
  net: GloamNetwork,
  address: Address,
  opts: { client?: PublicClient; force?: boolean; now?: number } = {}
): Promise<ReceivedPayment[]> {
  // the balance is sealed until it is unlocked: nothing can be saved to it before then
  if (typeof window === "undefined" || readDemo() || !accountShown() || dataKeyLocked()) return [];
  if (!net.pool || !net.payMemo) return [];
  const key = cursorKey(net);
  if (!key) return [];
  const runKey = `${key}:${address.toLowerCase()}`;
  const now = opts.now ?? Date.now();
  if (running.has(runKey)) return [];
  if (!opts.force && now - (lastRun.get(runKey) ?? 0) < RECEIVE_EVERY_MS) return [];
  running.add(runKey);
  lastRun.set(runKey, now);
  // a reset during this pass (keys restored, new address) wins: its cursor isn't written over
  const epoch = receiveCursorEpoch();
  try {
    const client = opts.client ?? publicClientFor(net);
    const pool = net.pool;
    const head = await client.getBlockNumber();
    const cursor = readCursor(key);
    const from = cursor != null && cursor > REORG_BLOCKS ? cursor - REORG_BLOCKS : undefined;
    const memos = await fetchPaymentMemos(client, from, head, net);

    const mine = new Set(
      getAllNotes()
        .filter((n) => n.chainId === net.chainId && n.pool.toLowerCase() === pool.toLowerCase())
        .map((n) => n.commitment.toLowerCase())
    );
    const found: { local: Omit<LocalNote, "id" | "leafIndex" | "unfunded">; label: string; note?: string }[] = [];
    for (const m of memos) {
      const commitmentNamed = m.paymentCommitment.toLowerCase();
      if (mine.has(commitmentNamed)) continue;
      let pack;
      try {
        pack = await decodeNotePackage(m.ticket, undefined, { tryTagDecrypt: true });
      } catch {
        continue; // not for this account
      }
      // Anyone who knows a Gloam address can post to it: only a real payment counts.
      if (claimNetworkProblem(net, pack)) continue;
      if (pack.pool && pack.pool.toLowerCase() !== pool.toLowerCase()) continue;
      let amount: bigint;
      try {
        amount = BigInt(pack.amountWei);
      } catch {
        continue;
      }
      if (amount <= 0n) continue;
      const commitment = fieldToHex(await noteCommitmentPoseidon(hexToField(pack.secret), amount, pack.asset)).toLowerCase() as Hex;
      if (commitment !== commitmentNamed) continue;
      const nullifier = fieldToHex(await noteNullifierPoseidon(hexToField(pack.secret), hexToField(commitment))) as Hex;
      const [inVault, spent] = await Promise.all([
        client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "commitmentSeen", args: [commitment] }),
        client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "isSpent", args: [nullifier] }),
      ]);
      if (!inVault || spent) continue;
      mine.add(commitment);
      found.push({
        label: receivedLabel(net, pack.amountWei, pack.asset),
        note: pack.note,
        local: {
          chainId: net.chainId,
          pool,
          asset: pack.asset,
          amountWei: pack.amountWei,
          commitment,
          secret: pack.secret,
          nullifier,
          bound: true,
          scheme: "poseidon",
          from: address,
          createdAt: now,
          status: "open",
          source: "local",
          ...(pack.note ? { note: pack.note } : {}),
        },
      });
    }

    // another tab may have saved some of these meanwhile: what is on disk now decides
    const onDisk = new Set(
      getAllNotes()
        .filter((n) => n.chainId === net.chainId && n.pool.toLowerCase() === pool.toLowerCase())
        .map((n) => n.commitment.toLowerCase())
    );
    const fresh = found.filter((f) => !onDisk.has(f.local.commitment.toLowerCase()));
    if (fresh.length) {
      keepStorage();
      // where each sits in the vault, so it can be secured at once; the vault already
      // said it holds each one, so a failed tree read only leaves the index for later
      const tree = await syncShieldTree(client, net).catch(() => null);
      for (const f of fresh) {
        const idx = tree?.indexByCommitment.get(f.local.commitment.toLowerCase());
        await saveLocalNote({
          ...f.local,
          id: receivedNoteId(f.local.commitment),
          leafIndex: idx ?? undefined,
          unfunded: false,
        } as LocalNote);
      }
    }
    // read up to here: the next pass starts from this block (unless a reset came meanwhile)
    if (receiveCursorEpoch() === epoch) writeCursor(key, head);

    const landed: ReceivedPayment[] = fresh.map((f) => ({
      label: f.label,
      note: f.note,
      network: net.label,
      networkKey: net.key,
      asset: f.local.asset,
      amountWei: f.local.amountWei,
    }));
    if (landed.length) window.dispatchEvent(new CustomEvent<ReceivedPayment[]>(PAYMENTS_RECEIVED_EVENT, { detail: landed }));
    return landed;
  } catch {
    // a failed read changes nothing: the cursor stays, and the next pass reads the same blocks
    lastRun.set(runKey, now - RECEIVE_EVERY_MS / 2);
    return [];
  } finally {
    running.delete(runKey);
  }
}

/**
 * Every other live network with a board: payments sent there land too, without
 * switching to it first. One network after another, each paced on its own.
 */
export async function receiveOnOtherNetworks(shown: GloamNetwork, address: Address, networks: GloamNetwork[]): Promise<ReceivedPayment[]> {
  const out: ReceivedPayment[] = [];
  for (const n of networks) {
    if (n.key === shown.key || !n.pool || !n.payMemo || n.status !== "live" || n.testnet !== shown.testnet) continue;
    out.push(...(await receiveWaitingPayments(n, address).catch(() => [])));
  }
  return out;
}

/** For the self-test: forget the pacing. */
export function resetAutoReceiveForTest(): void {
  lastRun.clear();
  running.clear();
}
