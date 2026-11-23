"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { useAppAccount } from "@/lib/demo";
import { CashOutReceipts } from "./prove/CashOutReceipts";
import { ExactBalance } from "./prove/ExactBalance";
import { FundsFlow } from "./prove/FundsFlow";
import { PaymentFlow } from "./prove/PaymentFlow";
import { ConnectCard, NoBalanceCard, ProveLayout, SafeToShare } from "./prove/ProofParts";

/**
 * Prove what you hold, three ways: one balance exactly, "at least" an amount
 * with the balance hidden, or a private payment. Each is sealed for one
 * verifier and an expiry. Plus a receipt for a cash out to a public wallet,
 * read from the chain. `?mode=` picks the tab so a link can open straight
 * onto one.
 */
const MODES = [
  { id: "exact", label: "Exact balance", hint: "Show one private balance exactly" },
  { id: "funds", label: "At least", hint: "Show you hold at least an amount, balance hidden" },
  { id: "payment", label: "Payment", hint: "Show a private payment, the amount or a minimum" },
  { id: "cashout", label: "Cash out", hint: "A receipt for a cash out to a public wallet" },
] as const;

type ModeId = (typeof MODES)[number]["id"];

export function DiscloseView() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const raw = sp.get("mode");
  const mode: ModeId = MODES.some((m) => m.id === raw) ? (raw as ModeId) : "exact";

  const { address } = useAppAccount();
  const { open, merged } = useLocalShieldNotes(address);

  function select(id: ModeId) {
    const params = new URLSearchParams(Array.from(sp.entries()));
    if (id === "exact") params.delete("mode");
    else params.set("mode", id);
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  const what = mode === "payment" ? "a payment" : mode === "cashout" ? "a cash out" : "a balance";

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="What to prove"
        className="inline-flex max-w-full overflow-x-auto rounded-full bg-surface-2 p-1 max-sm:flex max-sm:w-full dark:bg-panel dark:ring-1 dark:ring-line"
      >
        {MODES.map((m) => {
          const active = m.id === mode;
          return (
            <button
              key={m.id}
              id={`prove-tab-${m.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="prove-panel"
              title={m.hint}
              onClick={() => select(m.id)}
              className={`h-10 whitespace-nowrap rounded-full px-[18px] text-[14px] transition-colors duration-200 max-sm:flex-auto max-sm:px-3 ${
                active
                  ? "bg-panel font-medium text-foreground shadow-card dark:bg-surface-2"
                  : "text-mute hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      <div id="prove-panel" role="tabpanel" aria-labelledby={`prove-tab-${mode}`} className="min-w-0">
        {!address ? (
          <ProveLayout aside={<SafeToShare />}>
            <ConnectCard what={what} />
          </ProveLayout>
        ) : mode === "funds" ? (
          <FundsFlow notes={open} empty={<NoBalanceCard />} />
        ) : mode === "payment" ? (
          <PaymentFlow notes={merged} />
        ) : mode === "cashout" ? (
          <CashOutReceipts />
        ) : (
          <ExactBalance notes={open} />
        )}
      </div>
    </div>
  );
}
