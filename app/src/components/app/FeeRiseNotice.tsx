"use client";

/**
 * On every app page: a cash out or top-up waiting with the relay that will pay
 * less than it showed, because the vault's fee rose after it was set up (lib/
 * cashOutLater feeRise). The relay sends a job whether or not anyone is here,
 * and people land on Portfolio, so this can't wait for the screen that lists
 * them. It looks across every network, so a job on one chain still shows while
 * the app is on another. It stays until the job goes or is cancelled.
 *
 * It only reads what this browser holds. A job with the app closed, or set up
 * in another browser, goes out with nobody told.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { feeRiseNotice, waitingFeeRises, type WaitingRise } from "@/lib/cashOutLater";
import { networkOfNote } from "@/lib/cashOutSplit";
import { useAppAccount, useDemo } from "@/lib/demo";
import { getAllNotes } from "@/lib/noteVault";
import { publicClientFor } from "@/lib/rhClient";
import { shieldPoolAbi } from "@/lib/shield";
import { vaultActionSearch } from "@/lib/vaultHub";
import { useNetwork } from "./NetworkProvider";

/** How often it looks at this browser's notes: the note store opens a moment after the page does. */
const LOOK_MS = 5_000;
/** How long a vault's fee is trusted before it is read again. */
const FEE_READ_MS = 60_000;

export function FeeRiseNotice() {
  const { address } = useAppAccount();
  const { network, setNetworkKey } = useNetwork();
  const demoMode = useDemo();
  const [found, setFound] = useState<WaitingRise[]>([]);
  const fees = useRef(new Map<string, { bps: number | null; at: number }>());

  useEffect(() => {
    if (!address || demoMode) return;
    let live = true;
    const key = (n: { chainId: number; pool: string }) => `${n.chainId}:${n.pool.toLowerCase()}`;
    const look = async () => {
      const me = address.toLowerCase();
      const mine = getAllNotes().filter((n) => !n.from || n.from.toLowerCase() === me);
      const now = Date.now();
      for (const n of mine) {
        if (n.cashOut?.state !== "scheduled") continue;
        const was = fees.current.get(key(n));
        if (was && now - was.at < FEE_READ_MS) continue;
        const net = networkOfNote(n);
        // A pool with no fee to read, or a read that failed, says nothing.
        const bps = net?.pool
          ? await publicClientFor(net)
              .readContract({ address: net.pool, abi: shieldPoolAbi, functionName: "withdrawFeeBps" })
              .then(Number)
              .catch(() => null)
          : null;
        fees.current.set(key(n), { bps, at: now });
      }
      if (live) setFound(waitingFeeRises(mine, (n) => fees.current.get(key(n))?.bps ?? null));
    };
    void look();
    const timer = setInterval(() => void look(), LOOK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [address, demoMode]);

  const shown = address && !demoMode ? found : [];
  if (shown.length === 0) return null;

  // The link opens where a job is, this network first.
  const here = shown.find((r) => r.note.chainId === network.chainId) ?? shown[0]!;
  const target = networkOfNote(here.note);
  const elsewhere = [...new Set(shown.filter((r) => r.note.chainId !== network.chainId).map((r) => networkOfNote(r.note)?.label))].filter(Boolean);
  const onThisChain = shown.filter((r) => r.note.chainId === here.note.chainId);
  const topUps = onThisChain.some((r) => r.note.cashOutPlan?.topUp);

  return (
    <div role="status" className="mb-4 rounded-[14px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
      <p>
        {feeRiseNotice(shown.map((r) => r.rise), "scheduled cash out")}
        {elsewhere.length > 0 ? ` On ${elsewhere.join(" and ")}${shown.length > elsewhere.length ? " too" : ""}.` : ""}
      </p>
      <Link
        href={`/app/vault${vaultActionSearch(topUps ? "topups" : "cashout", "")}`}
        onClick={() => {
          if (target && target.key !== network.key) setNetworkKey(target.key);
        }}
        className="mt-1 inline-flex min-h-10 items-center font-medium underline underline-offset-4"
      >
        See what each one pays
      </Link>
    </div>
  );
}
