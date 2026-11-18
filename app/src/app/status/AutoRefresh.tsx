"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** A status page left open stays current: the page is fetched again every minute while it is in view. */
export function AutoRefresh({ everyMs = 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
