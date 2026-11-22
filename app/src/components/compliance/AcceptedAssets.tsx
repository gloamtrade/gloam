"use client";

import { useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { isNoLimit } from "@gloamtrade/sdk";
import { contractDirectory, type DirectoryEntry } from "@/lib/contractDirectory";
import { publicClientFor } from "@/lib/rhClient";
import { NATIVE_ASSET, shieldPoolAbi } from "@/lib/shield";
import { shieldTokensFor, supportsNativeShield, swapDisplayTokensFor } from "@/lib/tokens";

/**
 * /compliance#assets: what each live mainnet vault takes, with its deposit
 * limits read from the vault as the page loads. Nothing here is typed in: the
 * assets are the ones Add lists and the ones private swaps land in (lib/tokens:
 * shieldTokensFor, swapDisplayTokensFor), and the limits are the vault's own
 * answer (depositLimitsOn, depositLimit), so a limit raised, lowered or closed
 * shows as it stands. A swap-only asset the vault has not opened is left out:
 * the vault doesn't take it.
 */

/** `swapOnly`: listed for swaps, not on Add; shown only while the vault takes it. */
type Asset = { symbol: string; address: Address; decimals: number; swapOnly?: boolean };
type Limit = { per: bigint; total: bigint } | "off";
type Row = Asset & { limit: Limit | null };
type State = { status: "loading" } | { status: "done"; rows: Row[] } | { status: "error" };

const MAINNETS: DirectoryEntry[] = contractDirectory(false).filter((e) => e.live && e.kind === "mainnet");

function assetsOf(e: DirectoryEntry): Asset[] {
  const n = e.network;
  const seen = new Set<string>();
  const add = (a: Asset): boolean => {
    const k = a.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const native: Asset[] = supportsNativeShield(n.chainId)
    ? [{ symbol: n.primaryAsset.symbol, address: NATIVE_ASSET, decimals: n.primaryAsset.decimals }]
    : [];
  const listed: Asset[] = shieldTokensFor(n.chainId).map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals }));
  const swaps: Asset[] = swapDisplayTokensFor(n.chainId).map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, swapOnly: true }));
  return [...native, ...listed, ...swaps].filter(add);
}

/** A swap-only asset shows only when the vault takes it: limits off, or a limit above zero. */
function shown(r: Row): boolean {
  if (!r.swapOnly) return true;
  if (r.limit === "off") return true;
  return r.limit !== null && r.limit.per > 0n && r.limit.total > 0n;
}

async function readLimits(e: DirectoryEntry): Promise<Row[]> {
  const n = e.network;
  if (!n.pool) return [];
  const client = publicClientFor(n);
  const pool = n.pool;
  const assets = assetsOf(e);
  const on = await client.readContract({ address: pool, abi: shieldPoolAbi, functionName: "depositLimitsOn" }).catch(() => false);
  if (!on) return assets.map((a) => ({ ...a, limit: "off" as const }));
  const limits = await Promise.all(
    assets.map((a) =>
      client
        .readContract({ address: pool, abi: shieldPoolAbi, functionName: "depositLimit", args: [a.address] })
        .then(([per, total]) => ({ per, total }))
        .catch(() => null)
    )
  );
  return assets.map((a, i) => ({ ...a, limit: limits[i] ?? null })).filter(shown);
}

function amount(v: bigint, decimals: number): string {
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 });
}

function limitText(r: Row): { text: string; open: boolean } {
  if (r.limit === null) return { text: "Could not read", open: true };
  if (r.limit === "off") return { text: "No limit", open: true };
  const { per, total } = r.limit;
  if (total === 0n || per === 0n) return { text: "Not open for deposits", open: false };
  const perText = isNoLimit(per) ? "No limit per deposit" : `Up to ${amount(per, r.decimals)} per deposit`;
  const totalText = isNoLimit(total) ? "no total limit" : `${amount(total, r.decimals)} in total`;
  return { text: `${perText}, ${totalText}`, open: true };
}

function ChainAssets({ entry }: { entry: DirectoryEntry }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    readLimits(entry).then(
      (rows) => live && setState({ status: "done", rows }),
      () => live && setState({ status: "error" })
    );
    return () => {
      live = false;
    };
  }, [entry]);

  return (
    <div className="min-w-0">
      <h3 className="t-title">{entry.name}</h3>
      {state.status === "loading" && <p className="mt-3 text-[14px] text-mute">Reading the vault…</p>}
      {state.status === "error" && <p className="mt-3 text-[14px] text-mute">The network did not answer just now. Reload to try again.</p>}
      {state.status === "done" && (
        <ul className="mt-3 divide-y divide-line border-y border-line text-[14px]">
          {state.rows.map((r) => {
            const l = limitText(r);
            return (
              <li key={r.address} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
                <span className="text-foreground">{r.symbol}</span>
                <span className={`tnum text-right ${l.open ? "text-mute" : "text-faint"}`}>{l.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function AcceptedAssets() {
  return (
    <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
      {MAINNETS.map((e) => (
        <ChainAssets key={e.key} entry={e} />
      ))}
    </div>
  );
}
