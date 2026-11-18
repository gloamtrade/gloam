"use client";

/*
 * Hide amounts: one switch for every balance on screen, like a banking app's
 * eye. It only changes what this screen shows (nothing on chain, nothing sent),
 * and it is remembered in this browser, so a balance stays hidden across
 * reloads and in every open tab until the owner shows it again.
 */

import { useCallback, useSyncExternalStore } from "react";

const KEY = "gloam.hideAmounts";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAmountsHidden(hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    /* private window: the switch still works for this page */
  }
  memory = hidden;
  listeners.forEach((l) => l());
}

// Kept in memory too, so the switch works where storage is blocked.
let memory: boolean | null = null;

function snapshot(): boolean {
  if (memory === null) memory = read();
  return memory;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Another tab flipped it: follow.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      memory = e.newValue === "1";
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** Whether amounts are hidden, and a toggle. Shown by default (server render included). */
export function useHideAmounts(): [boolean, () => void] {
  const hidden = useSyncExternalStore(subscribe, snapshot, () => false);
  const toggle = useCallback(() => setAmountsHidden(!snapshot()), []);
  return [hidden, toggle];
}
