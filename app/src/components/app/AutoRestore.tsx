"use client";

/**
 * Brings a Gloam wallet's private balance back on a new device right after
 * sign-in, on whatever page it lands (lib/autoRestore). Draws nothing: the
 * balance shows "Syncing your private balance…" meanwhile. A browser wallet's
 * one signature request is left to the pages that know a deposit is missing.
 */
import { useAutoRestore } from "@/hooks/useAutoRestore";

export default function AutoRestore() {
  useAutoRestore(null);
  return null;
}
