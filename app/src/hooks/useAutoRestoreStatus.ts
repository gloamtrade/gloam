"use client";

import { useSyncExternalStore } from "react";
import { autoRestoreStatus, subscribeAutoRestore, type AutoRestoreStatus } from "@/lib/autoRestore";

const IDLE: AutoRestoreStatus = { kind: "idle" };
const idle = () => IDLE;

/**
 * How the restore from the backup is going for this wallet (lib/autoRestore), for
 * a page that shows a balance. Loads nothing of recovery itself.
 */
export function useAutoRestoreStatus(address: string | null | undefined): AutoRestoreStatus {
  return useSyncExternalStore(subscribeAutoRestore, () => autoRestoreStatus(address), idle);
}
