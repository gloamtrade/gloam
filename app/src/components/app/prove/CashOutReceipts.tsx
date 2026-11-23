"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Hex } from "viem";
import { useAppAccount } from "@/lib/demo";
import { shortAddress } from "@/lib/chain";
import { cashOutMarkers, findCashOuts, isTxHash, readCashOutReceipt, type CashOutReceipt, type FoundCashOut } from "@/lib/cashOutReceipt";
import { bridgeMarkFor } from "@/lib/cashOutBridge";
import { getNetwork, isNetworkKey, type GloamNetwork } from "@/lib/networks";
import { getAllNotes, onNotesSaved, unlockNoteVault } from "@/lib/noteVault";
import { publicClientFor } from "@/lib/rhClient";
import { formatAssetLabel, notesForWallet } from "@/lib/shield";
import { useShownAccount } from "../AccountScope";
import { useNetwork } from "../NetworkProvider";
import { CashOutReceiptSheet } from "../CashOutReceiptSheet";
import { EmptyCard, Notice, ProveLayout, Spinner } from "./ProofParts";


type Row = FoundCashOut & { time?: number };

/** How many rows get their date read (one block read each). */
const DATED = 20;
/** A cash out just sent may not have landed: how many times to look, and how far apart (ms). */
const PENDING_TRIES = 10;
const PENDING_GAP_MS = 4_000;

/**
 * Prove > Cash out: a receipt for a cash out to a public wallet. Lists this
 * browser's cash outs on the network shown (the vault's logs that name the
 * spend marker of a note held here), and opens a receipt for one, or for a
 * pasted transaction hash. `?tx=` opens that receipt straight away (the
 * "Get a receipt" link after a cash out).
 */
export function CashOutReceipts() {
  const { address } = useAppAccount();
  const { network } = useNetwork();
  const shownAccount = useShownAccount();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const txParam = sp.get("tx");
  const netParam = sp.get("net");
  // which cash out in that transaction: a cash out across balances sends its parts in one
  const partParam = sp.get("part");

  // this account's notes, read once they are open, and again when they change
  const [notesVersion, setNotesVersion] = useState(0);
  useEffect(() => {
    if (!shownAccount) return;
    let live = true;
    void unlockNoteVault().then(() => {
      if (live) setNotesVersion((v) => v + 1);
    });
    const off = onNotesSaved(() => setNotesVersion((v) => v + 1));
    return () => {
      live = false;
      off();
    };
  }, [shownAccount]);
  // the markers to ask about, as one key: a save that changes none of them reads nothing again
  const markers = useMemo(
    () =>
      address && shownAccount && notesVersion > 0 && network.pool
        ? cashOutMarkers(notesForWallet(getAllNotes(), address), network.chainId, network.pool)
        : null,
    [address, shownAccount, notesVersion, network]
  );
  const markersKey = markers ? markers.join(",") : null;

  // the list is the network's it was read on: another network's never shows
  const [list, setList] = useState<{ key: string; rows: Row[] } | null>(null);
  const rows = list?.key === network.key ? list.rows : null;
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState<CashOutReceipt | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const run = useRef(0);
  const openedParam = useRef<string | null>(null);

  const scan = useCallback(async () => {
    // not before the signed-in account's notes are open: an empty list then would say "no cash outs"
    if (!address || !network.pool || markersKey === null) return;
    const mine = ++run.current;
    setLoading(true);
    setListError(null);
    try {
      const nullifiers = markersKey ? (markersKey.split(",") as Hex[]) : [];
      const client = publicClientFor(network);
      const found = await findCashOuts(client, network, nullifiers);
      const dated: Row[] = await Promise.all(
        found.map(async (c, i) => {
          if (i >= DATED) return c;
          const b = await client.getBlock({ blockNumber: c.blockNumber }).catch(() => null);
          return b ? { ...c, time: Number(b.timestamp) * 1000 } : c;
        })
      );
      if (mine === run.current) setList({ key: network.key, rows: dated });
    } catch {
      if (mine === run.current) setListError(`Couldn't read ${network.label} just now. Try again in a moment.`);
    } finally {
      if (mine === run.current) setLoading(false);
    }
  }, [address, network, markersKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the tab, a switch of network or account, or new notes read the vault's logs, which marks the read as running
    void scan();
  }, [scan]);

  const openReceipt = useCallback(
    async (hash: string, nullifier?: Hex, on: GloamNetwork = network) => {
      setNotice(null);
      setOpening(hash);
      try {
        // read on the network it was made on, even if the app switches while it waits
        const client = publicClientFor(on);
        for (let i = 0; i < PENDING_TRIES; i++) {
          const r = await readCashOutReceipt(client, on, hash, { nullifier });
          if (r.ok) {
            setOpen(r.receipt);
            return;
          }
          if (r.reason !== "pending" || i === PENDING_TRIES - 1) {
            setNotice(r.message);
            return;
          }
          await new Promise((res) => setTimeout(res, PENDING_GAP_MS));
        }
      } finally {
        setOpening(null);
      }
    },
    [network]
  );

  // the link after a cash out: open its receipt once, on the network it names, then
  // take it out of the address so closing and coming back doesn't open it again
  useEffect(() => {
    if (!txParam || !isTxHash(txParam) || openedParam.current === txParam) return;
    openedParam.current = txParam;
    const on = isNetworkKey(netParam) ? getNetwork(netParam) : network;
    const part = partParam && /^0x[0-9a-fA-F]{64}$/.test(partParam) ? (partParam as Hex) : undefined;
    void openReceipt(txParam, part, on);
    const params = new URLSearchParams(Array.from(sp.entries()));
    params.delete("tx");
    params.delete("net");
    params.delete("part");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [txParam, netParam, partParam, network, openReceipt, sp, router, pathname]);

  if (!network.pool) {
    return <EmptyCard title="No vault on this network" body="Switch to a network Gloam runs on to see your cash outs." />;
  }

  // two places, cut down, like every amount shown (lib/amountShort)
  const amount = (raw: bigint, asset: string) => formatAssetLabel(raw, asset);
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <ProveLayout aside={<ReceiptShows />}>
      <section className="gl-card max-sm:p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] text-foreground">Cash out receipts</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-mute">
              A receipt for a cash out to a public wallet, read from {network.label}.
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm h-10 shrink-0" onClick={() => void scan()} disabled={loading}>
            {loading ? <Spinner /> : null}
            Refresh
          </button>
        </div>

        {listError && (
          <div className="mt-4">
            <Notice tone="danger">{listError}</Notice>
          </div>
        )}

        {rows === null && loading ? (
          <ul className="mt-4 space-y-2" aria-busy="true" aria-label="Loading your cash outs">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-14 rounded-[14px] bg-surface motion-safe:animate-pulse" />
            ))}
          </ul>
        ) : rows && rows.length > 0 ? (
          <ul className="mt-4 divide-y divide-line overflow-hidden rounded-[16px] border border-line">
            {rows.map((r) => (
              <li key={`${r.txHash}:${r.nullifier}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="tnum truncate text-[15px] text-foreground">{amount(r.amount, r.asset)}</p>
                  <p className="tnum truncate text-[12.5px] text-mute">
                    To {shortAddress(r.to, 4)}
                    {r.time ? `, ${day(r.time)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm h-10 shrink-0"
                  disabled={opening !== null}
                  aria-busy={opening === r.txHash}
                  onClick={() => void openReceipt(r.txHash, r.nullifier)}
                >
                  {opening === r.txHash ? <Spinner /> : null}
                  Receipt
                </button>
              </li>
            ))}
          </ul>
        ) : rows ? (
          <p className="mt-4 rounded-[14px] bg-surface px-4 py-3 text-[13.5px] text-soft">
            No cash outs from this browser on {network.label} yet.
          </p>
        ) : null}

        <form
          className="mt-6 border-t border-line pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (isTxHash(paste)) void openReceipt(paste.trim());
            else setNotice("That isn't a transaction hash. It starts with 0x and has 64 letters and numbers after it.");
          }}
        >
          <label htmlFor="receipt-tx" className="block text-[13px] text-mute">
            Or paste the transaction hash of a cash out
          </label>
          <div className="mt-2 flex gap-2 max-sm:flex-col">
            <input
              id="receipt-tx"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              className="gl-input tnum min-w-0 flex-1"
            />
            <button type="submit" className="btn btn-ink h-11 shrink-0" disabled={!paste.trim() || opening !== null}>
              {opening && opening === paste.trim() ? <Spinner /> : null}
              Get receipt
            </button>
          </div>
        </form>

        {opening && (
          <p className="mt-3 text-[13px] text-mute" aria-live="polite">
            Reading the cash out from {network.label}…
          </p>
        )}
        {notice && (
          <div className="mt-3">
            <Notice tone="warn">{notice}</Notice>
          </div>
        )}
      </section>

      {open && (
        <CashOutReceiptSheet receipt={open} bridge={bridgeMarkFor(open.nullifier)} onClose={() => setOpen(null)} />
      )}
    </ProveLayout>
  );
}

/** What a receipt shows: all of it is public already, so nothing private is in it. */
function ReceiptShows() {
  const shows = ["Amount and fee", "The wallet it went to", "When", "The transaction"];
  const never = ["Your private balance", "Your other payments", "Where the money came from"];
  return (
    <section className="gl-card max-sm:p-5 sm:p-6">
      <p className="text-[13px] text-mute">A receipt shows</p>
      <ul className="mt-2 divide-y divide-line text-[14px]">
        {shows.map((s) => (
          <li key={s} className="flex min-h-11 items-center py-2 text-foreground">
            {s}
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[13px] text-mute">Never shows</p>
      <ul className="mt-2 divide-y divide-line rounded-[14px] bg-surface px-4 text-[13.5px]">
        {never.map((n) => (
          <li key={n} className="flex min-h-11 items-center py-2 text-soft">
            {n}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
        A cash out is public on chain, so anyone can check a receipt against the transaction. It is not a proof: it
        holds no secret and needs no expiry.
      </p>
    </section>
  );
}
