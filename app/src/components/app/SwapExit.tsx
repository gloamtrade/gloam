"use client";

/**
 * The way out for a swap's money when its refund can't land (lib/vaultSwapRun
 * exitVaultSwap). Waiting stays the default: the refund comes back privately by
 * itself once the vault has room. Taking it out now pays a public address, so the
 * page says that before anything goes.
 */
import { useState } from "react";
import { isAddress, type Address } from "viem";
import { cashOutTargetProblem } from "@/lib/cashOutTarget";
import type { LocalNote } from "@/lib/shield";
import { useNetwork } from "./NetworkProvider";

export function SwapExit({ note, onDone }: { note: LocalNote; onDone: () => void }) {
  const { network } = useNetwork();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (note.chainId !== network.chainId) return null;

  const clean = to.trim();
  const valid = isAddress(clean);
  const problem = !clean ? null : valid ? cashOutTargetProblem(clean, network) : "Enter a wallet address.";

  const send = async () => {
    if (!valid || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { exitVaultSwap } = await import("@/lib/vaultSwapRun");
      await exitVaultSwap(note, clean as Address);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The exit didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 min-h-10 text-[12.5px] font-medium text-foreground underline underline-offset-4">
        Take it out now instead
      </button>
    );
  }
  return (
    <div className="mt-2 max-w-sm space-y-2">
      <p className="text-[12.5px] text-mute">
        This pays a wallet in public. Anyone can see that address and the amount next to this swap, so this money stops being
        private. A wallet you have never used keeps the rest of your balance apart from it. If you wait, it comes back privately
        by itself once the vault has room.
      </p>
      <label className="block text-[12.5px] text-mute">
        Wallet address
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          className="mt-1 min-h-10 w-full rounded-lg border border-line bg-transparent px-3 text-[13px] text-foreground"
        />
      </label>
      {(problem || error) && <p className="text-[12.5px] text-warn">{problem ?? error}</p>}
      <button
        type="button"
        onClick={() => void send()}
        disabled={!valid || Boolean(problem) || busy}
        className="btn btn-ink btn-sm"
      >
        {busy ? "Taking it out…" : "Take it out, in public"}
      </button>
    </div>
  );
}
