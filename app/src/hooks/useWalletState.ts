"use client";

import { useCallback, useState, type SetStateAction } from "react";

/**
 * useState for what belongs to the wallet connected when it was set: a message
 * naming an amount ("Claimed and secured 50 USDG"), a list read for it. When
 * that wallet signs out, or another one connects, it goes back to `initial` in
 * that same render, so nothing one person saw stays on screen for the next.
 * A set made from an earlier wallet's render (an async step that ends after
 * the switch) is dropped: it belongs to a wallet that is gone.
 *
 * `initial` must not change between renders (a constant, or null).
 */
export function useWalletState<T>(
  wallet: string | null | undefined,
  initial: T
): [T, (next: SetStateAction<T>) => void] {
  const key = wallet ? wallet.toLowerCase() : "";
  const [state, setState] = useState<{ key: string; value: T }>({ key, value: initial });
  // Another wallet (or none) since the last render: start over, before anything paints.
  if (state.key !== key) setState({ key, value: initial });
  const set = useCallback(
    (next: SetStateAction<T>) =>
      setState((prev) =>
        prev.key !== key
          ? prev
          : { key, value: typeof next === "function" ? (next as (cur: T) => T)(prev.value) : next }
      ),
    [key]
  );
  return [state.key === key ? state.value : initial, set];
}
