"use client";

import { useEffect, useState } from "react";
import { getNetwork } from "@/lib/networks";
import { publicClientFor } from "@/lib/rhClient";
import { GLOAM_NAMES_ADDRESS, gloamNamesAbi, readNameRecord, type NameRecord } from "@/lib/gloamNames";

export type NameLookup =
  | { status: "idle" }
  /** Names are not live yet (no registry address). */
  | { status: "off" }
  | { status: "loading" }
  | { status: "found"; record: NameRecord }
  | { status: "none"; name: string };

/** How long the text must sit still before a name is looked up, ms. */
export const NAME_DEBOUNCE_MS = 350;

type Result = Extract<NameLookup, { status: "found" } | { status: "none" }>;

/** Read one name's record from the registry on Robinhood Chain mainnet. */
export function readGloamName(name: string): Promise<NameRecord | null> {
  const registry = GLOAM_NAMES_ADDRESS;
  if (!registry) return Promise.resolve(null);
  const client = publicClientFor(getNetwork("robinhood-mainnet"));
  return readNameRecord(name, (n) =>
    client.readContract({ address: registry, abi: gloamNamesAbi, functionName: "resolve", args: [n] })
  );
}

/**
 * Look up a Gloam name for the Pay box: the Gloam address it pays, read from
 * the registry on Robinhood Chain mainnet whichever network the app is on.
 * Waits for the text to settle, drops an answer for a name that has since
 * changed, and treats any failure as "no such name". Pass null when the text
 * is not a name. `refresh` reads it again (after buying or changing a name).
 */
export function useGloamName(name: string | null, refresh = 0): NameLookup {
  const [state, setState] = useState<{ key: string; result: Result } | null>(null);
  const key = name ? `${name}:${refresh}` : "";

  useEffect(() => {
    if (!name || !GLOAM_NAMES_ADDRESS) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      void readGloamName(name).then((record) => {
        if (stale) return;
        setState({ key: `${name}:${refresh}`, result: record ? { status: "found", record } : { status: "none", name } });
      });
    }, NAME_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [name, refresh]);

  if (!name) return { status: "idle" };
  if (!GLOAM_NAMES_ADDRESS) return { status: "off" };
  if (!state || state.key !== key) return { status: "loading" };
  return state.result;
}
