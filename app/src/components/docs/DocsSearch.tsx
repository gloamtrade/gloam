"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { FLAT_DOCS_NAV, DOCS_NAV, findDocHeading, slugify } from "./DocsNav";
import { CloseIcon, HashIcon, Kbd, PageIcon, SearchIcon, useIsMac } from "./docsUi";
import { liveMainnetCountWords, liveMainnetNames } from "@/lib/mainnet";
import { ELYSIUM_FLAG, ELYSIUM_TESTNET_FLAG } from "@/lib/elysium";

/* ------------------------------------------------------------------ */
/* Static index: the nav list plus a hand-written description, a few   */
/* keywords people actually type, and each page's h2 headings.         */
/* ------------------------------------------------------------------ */

type PageMeta = { description: string; keywords: string[]; headings: string[] };

const PAGE_META: Record<string, PageMeta> = {
  "/docs": {
    description: "What Gloam is, what works today, and where to start.",
    keywords: ["intro", "introduction", "getting started", "what is gloam", "stablecoin", "payments"],
    headings: ["What is Gloam?", "Try it (2 minutes)", "What works today", "What does not work yet", "Read next"],
  },
  "/docs/quickstart": {
    description: "From an empty project to a private balance on mainnet or the free testnet in about ten minutes.",
    keywords: ["install", "create gloam app", "first app", "hello world", "start building", "npm", "mainnet", "approve", "usdg", "circuit artifacts", "final keys"],
    headings: [
      "Fastest start",
      "What you need",
      "1. Install",
      "2. Get the circuit artifacts",
      "3. Shield your first note",
      "4. Confirm it landed",
      "5. Cash out",
      "Where to go next",
      "Honesty",
    ],
  },
  "/docs/testnet": {
    description: "Practice for free with test funds: wallet setup, faucet, adding funds privately, paying and cashing out.",
    keywords: ["testnet", "practice", "faucet", "test funds", "wallet", "metamask", "usdg", "pathusd", "troubleshooting", "demo", "46630", "base sepolia", "84532", "circle faucet", "eurc", "ethereum sepolia", "sepolia", "11155111", "paxos faucet", "pyusd"],
    headings: [
      "Demo video",
      "What you can do on testnet",
      "Before you start",
      "1. Add Robinhood Chain testnet",
      "Base Sepolia",
      "Ethereum Sepolia",
      "2. Get testnet funds (faucet)",
      "3. Portfolio at a glance",
      "4. Shield (deposit into the vault)",
      "5. Private pay (send inside the vault)",
      "6. Cash out (unshield)",
      "7. Trade paths",
      "7b. Private swaps (mainnet)",
      "8. Settings & backups",
      "Practice checklist",
      "Troubleshooting",
      "Safety & non-claims",
      "Read next",
    ],
  },
  "/docs/product": {
    description: "Status board: what is live on mainnet and testnet, what is next, and the rules we keep.",
    keywords: ["status", "roadmap", "live", "shipping", "features", "mainnet"],
    headings: ["Where things live", "Status (honest)", "Rules we will not break"],
  },
  "/docs/sdk": {
    description: "Add private balances, payments and proofs to any app or agent, on mainnet or testnet.",
    keywords: ["package", "npm", "typescript", "library", "integrate", "intents", "@gloamtrade/sdk", "mainnet", "testnet", "mainnetNetwork", "gloamNetworks", "cash out fee"],
    headings: [
      "What Gloam gives your app",
      "Install",
      "Mainnet and testnet",
      "The model",
      "Quickstart: shield privately",
      "Intents: plan and exec",
      "API surface",
      "Integration patterns",
      "Public inputs are pinned",
      "Guardrails",
    ],
  },
  "/docs/sdk/reference": {
    description: "Every export in @gloamtrade/sdk, with signatures and status.",
    keywords: ["api", "functions", "exports", "signatures", "methods", "prover", "x402", "constants", "types", "mainnet", "mainnetNetwork", "gloamNetworks", "getGloamNetwork", "circuitArtifactUrls", "ceremonyForChainId", "cashOutFee", "CASH_OUT_FEE_BPS", "MAINNET_POOLS"],
    headings: [
      "Import",
      "Networks and mainnet",
      "Intent builders",
      "Intent shape",
      "Notes",
      "Prover",
      "Merkle tree",
      "Tree sync",
      "x402 payments",
      "Witness builders",
      "Sealed-rate math",
      "Size-privacy policy",
      "Field math & proof packing",
      "Constants",
      "Guardrails",
    ],
  },
  "/docs/sdk/disclosure": {
    description: "Prove one balance to an auditor or counterparty and show nothing else.",
    keywords: ["prove", "proof", "auditor", "audit", "compliance", "verify", "accountant"],
    headings: [
      "Why it matters",
      "What a disclosure proves",
      "How it works",
      "Create a disclosure",
      "Verify a disclosure",
      "Guarantees",
    ],
  },
  "/docs/proofs": {
    description: "Prove you hold at least an amount, or that you were paid, without showing your balance.",
    keywords: ["proof of funds", "proof of payment", "receipt", "at least", "solvency", "bank", "landlord", "verify", "threshold"],
    headings: [
      "Four proofs",
      "What each one shows and hides",
      "Made for one person",
      "How checking works",
      "Limits worth knowing",
      "How to check a proof",
    ],
  },
  "/docs/agents": {
    description: "Give an AI agent private payments, with spending kept under policy.",
    keywords: ["ai", "agent", "bot", "mcp", "x402", "policy", "llm", "automation", "keys", "limits", "spending cap", "budget", "hosted", "connector", "url", "claude", "chatgpt", "cursor", "top up", "topup", "refill", "schedule"],
    headings: [
      "Why agents need this most",
      "Two ways in",
      "For Virtuals agents",
      "For agent kits and marketplaces",
      "Connect by URL",
      "Keep an agent topped up",
      "Reference agent (the SDK path)",
      "The MCP server",
      "Private agent payments (x402)",
      "Spending limits",
      "Policy and key custody",
      "Honesty",
    ],
  },
  "/docs/agents/commitments": {
    description: "Private agent payments that stay checkable against the merkle root your economy already posts on chain.",
    keywords: ["commitments", "merkle", "root", "nightly root", "leaf", "receipt", "proof of payment", "game", "city", "economy", "marketplace", "allowlist", "selector", "signing", "burn", "verify", "solidity", "abi.encode", "keccak"],
    headings: [
      "Why this matters",
      "How it fits",
      "Pay and plan the receipt",
      "Prove it and make the leaf",
      "The leaf, exactly",
      "Checking a record",
      "What an agent signs",
      "What is public and what is not",
      "Limits worth knowing",
      "Reference integration",
    ],
  },
  "/docs/integrate": {
    description: "Add private payments to an agent kit or MCP add-on with a preview-then-execute tool pack, or let x402 marketplace sellers take private payments next to standard ones.",
    keywords: ["agent kit", "kit", "tool pack", "tools", "mcp add-on", "marketplace", "x402", "x402 marketplace", "seller", "middleware", "gloam-private", "gloam-cashout", "splitter", "public payee", "verifyGloamCashout", "exact", "payment-required", "x-payment", "preview", "execute", "approval", "claim link", "cash out", "proof of funds", "partner", "dashboard", "integrate", "integration", "usdg", "robinhood"],
    headings: [
      "Pick a path",
      "The tool pack",
      "Preview, then execute",
      "Secrets stay with the kit",
      "Or bundle the Gloam MCP server",
      "For x402 marketplaces",
      "Get your integration counted",
      "What is public, fees and networks",
      "FAQ",
    ],
  },
  "/docs/virtuals": {
    description: "Private balances and payments for Virtuals agents, built on GAME, and private payouts on ACP.",
    keywords: ["virtuals", "virtuals protocol", "game", "game framework", "game plugin", "acp", "agent commerce protocol", "erc-8183", "8183", "job", "escrow", "provider", "client", "evaluator", "payout", "private payout", "fund transfer", "wallet policy", "acp_only", "privy", "base", "robinhood", "usdc", "usdg", "agent", "plugin"],
    headings: [
      "Why agent commerce needs privacy",
      "Install and set up",
      "Functions",
      "Limits",
      "What the planner sees",
      "Private payouts on ACP",
      "What stays public",
      "Wallet policies",
      "Networks",
      "FAQ",
    ],
  },
  "/docs/partners": {
    description: "Build on Gloam with an API key: relay payments, count deposits, check proofs and see your volume.",
    keywords: ["partner", "partners", "api", "api key", "rest", "http", "integrate", "wallet", "app", "fees", "revenue", "volume", "bearer", "v1", "portal", "live key", "test key", "charged"],
    headings: [
      "How the program works",
      "What you can charge, and why",
      "Partner fees: not charged yet",
      "Authentication and limits",
      "Responses and errors",
      "Relay a payment",
      "Count a deposit",
      "Your volume and fees",
      "Vaults and the leaf list",
      "Check a proof",
      "Payment request links",
      "Public figures",
      "With the SDK",
      "What is recorded",
    ],
  },
  "/docs/payroll": {
    description: "Upload a list and pay a whole team without showing who got what.",
    keywords: ["salary", "team", "csv", "contractors", "payday", "claim link", "relay", "bulk", "pay many", "schedule", "recurring", "monthly", "cap"],
    headings: [
      "Why payroll needs privacy",
      "Run your first payroll",
      "List format",
      "Who sees what",
      "Scheduled payroll",
      "If something goes wrong",
      "The Gloam relay",
      "No middlemen",
    ],
  },
  "/docs/private-pay": {
    description: "Pay someone inside Gloam so the amount and the sender stay private.",
    keywords: ["send", "payment", "pay", "receive", "gloam address", "memo", "solana", "zcash", "transfer"],
    headings: [
      "Why Solana private send feels like public send",
      "Is RH not able to do Solana-style private send?",
      "Replicating Zcash on Robinhood with Gloam?",
      "Try it",
    ],
  },
  "/docs/private-swaps": {
    description: "Swap straight from your private balance on mainnet. Who swapped stays private; the amounts are public.",
    keywords: ["swap", "swaps", "private swap", "trade", "exchange", "dex", "uniswap", "usdg", "gloam", "pathusd", "usdc.e", "usdt0", "ousd", "refund", "buffer", "router", "escrow", "max", "sealed trade", "sealed swap", "retired"],
    headings: [
      "How a swap works",
      "What you can swap",
      "What stays private and what is public",
      "Keep a swap from linking back to you",
      "One note per swap",
      "What it costs",
      "If a swap can't finish",
      "What the router can and cannot do",
      "Contracts",
      "The old sealed trade",
      "Try it",
    ],
  },
  "/docs/bridge": {
    description: "Pay into Gloam from Bitcoin, Solana, Tron or 22 EVM chains through Relay, straight into the private balance from a Solana or EVM wallet.",
    keywords: ["bridge", "deposit", "relay", "bitcoin", "btc", "solana", "tron", "base", "ethereum", "exchange", "deposit address", "refund", "fee", "cross-chain"],
    headings: ["Straight into your private balance", "Bitcoin, Tron and exchanges", "What it costs", "What is public", "Try it"],
  },
  "/docs/fresh-wallet": {
    description: "Fund a new wallet from your private balance, with ETH for gas, and use Borro on Robinhood Chain without the position pointing to your main wallet.",
    keywords: ["borro", "fresh wallet", "new wallet", "gas station", "gas", "short", "stock lending", "loan", "robinhood chain", "cash out", "pump"],
    headings: ["The steps", "Why gas takes its own step", "What is public and what is private", "What can still link your wallets", "What it costs", "Coming back", "About Borro", "Linking to this flow"],
  },
  "/docs/encryption": {
    description: "Add money, hold it privately, cash out: the whole loop in plain words.",
    keywords: ["shield", "deposit", "withdraw", "cash out", "private balance", "vault", "how it works"],
    headings: ["The short version", "Visual path", "What the public still sees", "What we do not claim"],
  },
  "/docs/threat-model": {
    description: "Who Gloam defends against, what each can and cannot do, our assumptions and known gaps.",
    keywords: ["threat model", "security", "attacker", "relay", "owner", "timelock", "trusted setup", "ceremony", "issuer", "freeze", "rpc", "bug bounty", "report", "vulnerability", "researcher", "swap", "swap router", "escrow", "refund", "griefing"],
    headings: ["What we protect", "Who can do what", "The details that matter", "What we assume", "Known gaps", "Out of scope", "How to report"],
  },
  "/docs/privacy-model": {
    description: "Exactly what an explorer can and cannot see when you use Gloam.",
    keywords: ["privacy", "explorer", "public", "hidden", "anonymity", "operator", "threat", "what is public", "passkey", "sanctions", "screening", "ofac", "compliance", "new", "novel", "viewing key", "context", "swap", "private swap"],
    headings: [
      "What an explorer actually shows",
      "What stays hidden",
      "What the public still sees",
      "The anonymity set is the whole game",
      "What we will not promise",
      "Private from the public, not from an operator",
      "What is new and what is not",
      "Security and compliance",
      "Before you use mainnet",
    ],
  },
  "/docs/compare": {
    description: "Why a payment needs no key holder, and how Gloam compares with Zama, Arcium, Tempo Zones, Helius and Railgun.",
    keywords: ["compare", "comparison", "competitors", "alternatives", "zama", "fhe", "arcium", "mpc", "tempo zones", "zones", "helius", "railgun", "payy", "cloak", "committee", "operator", "vs"],
    headings: [
      "Two jobs, two kinds of privacy",
      "What a breach exposes",
      "Not new cryptography",
      "Side by side",
      "Gloam and each of them",
      "What about trading?",
      "The short version",
      "Where Gloam is behind",
    ],
  },
  "/docs/chain": {
    description: `${liveMainnetNames()} mainnet, and their testnets: chain IDs, RPCs, pools, assets and deposit limits.`,
    keywords: ["robinhood", "tempo", "base", "base sepolia", "chain id", "rpc", "network", "mainnet", "testnet", "4663", "4217", "8453", "46630", "42431", "84532", "1", "ethereum", "explorer", "pool address", "deposit limits", "deposit limit", "usdg", "usdc.e", "usdt0", "usdc", "eurc", "usdt", "pyusd", "gas", "gloam token", "relayer", "fees", "swap router", "treasury", "ethereum sepolia", "sepolia", "11155111", ...(ELYSIUM_FLAG || ELYSIUM_TESTNET_FLAG ? ["elysium", "hype", "hyperliquid", "99801"] : [])],
    headings: [
      `${liveMainnetCountWords().replace(/^./, (c) => c.toUpperCase())}, one shielded pool design`,
      "Mainnet",
      "Robinhood Chain",
      "Tempo",
      "Base",
      "Ethereum",
      "Ethereum Sepolia",
      ...(ELYSIUM_FLAG ? ["Elysium"] : []),
      ...(ELYSIUM_TESTNET_FLAG ? ["Elysium testnet"] : []),
      "Switching networks in the app",
      "Honest status",
    ],
  },
  "/docs/data": {
    description: "Where prices in the app come from, and what sets the price you get.",
    keywords: ["price", "prices", "oracle", "chainlink", "pyth", "redstone", "quotes", "market data", "swap price", "quoter"],
    headings: [
      "Do you use Chainlink / Pyth / RedStone?",
      "What prices you see in the app",
      "What sets execution price",
      "Our rule on oracles",
      "Balances and history",
      "Testnet ETH",
    ],
  },
  "/docs/production": {
    description: "What mainnet cleared before launch, and what is still ahead.",
    keywords: ["mainnet", "launch", "ceremony", "keys", "security", "audit", "kann", "review", "multisig", "deposit limits", "timelock", "checklist"],
    headings: [
      "Why this page exists",
      "Ceremony checklist (keys)",
      "Mainnet at launch",
      "What was hardened before mainnet",
      "What is still ahead",
    ],
  },
  "/whitepaper": {
    description: "The technical and product thesis behind Gloam.",
    keywords: ["paper", "thesis", "architecture", "threat model", "research", "novel", "compare", "one owner"],
    headings: [
      "1. Abstract",
      "2. Problem",
      "3. Thesis and principles",
      "4. What privacy means here",
      "5. System architecture",
      "6. Cryptography and verification",
      "7. What is new in Gloam",
      "8. How Gloam compares",
      "9. Threat model",
      "10. Product surface",
      "11. Roadmap",
      "12. Risks and limitations",
      "13. Explicit non-claims",
      "14. Closing",
    ],
  },
};

type Entry = {
  key: string;
  kind: "page" | "heading";
  href: string;
  title: string;
  context: string;
  /** normalised fields, highest weight first */
  fields: { text: string; weight: number }[];
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”"’'?]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const PAGE_ENTRIES: Entry[] = FLAT_DOCS_NAV.map((item) => {
  const meta = PAGE_META[item.href];
  return {
    key: item.href,
    kind: "page",
    href: item.href,
    title: item.label,
    context: meta?.description ?? item.section,
    fields: [
      { text: norm(item.label), weight: 10 },
      { text: norm((meta?.keywords ?? []).join(" | ")), weight: 6 },
      { text: norm(item.section), weight: 3 },
      { text: norm(meta?.description ?? ""), weight: 2 },
    ],
  };
});

const HEADING_ENTRIES: Entry[] = FLAT_DOCS_NAV.flatMap((item) =>
  (PAGE_META[item.href]?.headings ?? []).map((h) => ({
    key: `${item.href}#${slugify(h)}`,
    kind: "heading" as const,
    href: `${item.href}#${slugify(h)}`,
    title: h,
    context: item.label,
    fields: [
      { text: norm(h), weight: 8 },
      { text: norm(item.label), weight: 2 },
    ],
  }))
);

type Group = { label: string; items: Entry[] };

function search(query: string): Group[] {
  const q = norm(query);
  if (!q) {
    return DOCS_NAV.map((g) => ({
      label: g.section,
      items: g.items.map((i) => PAGE_ENTRIES.find((e) => e.href === i.href)!),
    }));
  }
  const terms = q.split(" ").filter(Boolean);
  const score = (e: Entry) => {
    let total = 0;
    let ownHit = false;
    for (const t of terms) {
      let best = 0;
      for (const f of e.fields) {
        if (f.weight > best && f.text.includes(t)) best = f.weight;
      }
      if (!best) return 0;
      if (e.fields[0].text.includes(t)) ownHit = true;
      total += best;
    }
    // A section must match on its own words, not only on its page's title.
    if (e.kind === "heading" && !ownHit) return 0;
    const title = e.fields[0].text;
    if (title === q) total += 20;
    else if (title.startsWith(q)) total += 10;
    else if (title.split(" ").some((w) => w.startsWith(terms[0]))) total += 3;
    return total;
  };
  const rank = (list: Entry[], limit: number) =>
    list
      .map((e) => ({ e, s: score(e) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);

  const pages = rank(PAGE_ENTRIES, 8);
  const headings = rank(HEADING_ENTRIES, 12);
  const groups: (Group & { best: number })[] = [];
  if (pages.length) groups.push({ label: "Pages", items: pages.map((x) => x.e), best: pages[0].s + 1 });
  if (headings.length) groups.push({ label: "Sections", items: headings.map((x) => x.e), best: headings[0].s });
  // Whichever group holds the strongest match leads, so Enter opens it.
  return groups.sort((a, b) => b.best - a.best);
}

/** Bolds the parts of `text` that match a query term. */
function Marked({ text, query }: { text: string; query: string }) {
  const terms = norm(query)
    .split(" ")
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-medium text-foreground">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

export function SearchField({
  onOpen,
  hint = true,
  className = "",
}: {
  onOpen: () => void;
  /** Show the ⌘K / Ctrl K chip (off in the touch sheet). */
  hint?: boolean;
  className?: string;
}) {
  const mac = useIsMac();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search the docs"
      aria-haspopup="dialog"
      className={`group flex h-10 w-full items-center gap-2.5 rounded-xl border border-transparent bg-surface pl-3.5 pr-2 text-left text-[14px] text-faint transition-colors hover:border-line-strong hover:bg-panel ${className}`}
    >
      <SearchIcon className="shrink-0 text-mute" />
      <span className="min-w-0 flex-1 truncate">Search the docs</span>
      {hint && <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>}
    </button>
  );
}

export function SearchIconButton({ onOpen, className = "" }: { onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search the docs"
      aria-haspopup="dialog"
      className={`grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface ${className}`}
    >
      <SearchIcon size={18} />
    </button>
  );
}

/** ⌘K / Ctrl K toggles, "/" opens (when not typing somewhere). */
export function useSearchShortcut(toggle: () => void, open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, open]);
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const mac = useIsMac();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;

  const groups = useMemo(() => search(query), [query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = flat[Math.min(active, flat.length - 1)];

  // Focus the field on open; hand focus back to the trigger on close.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  const go = (entry: Entry) => {
    const [path, hash] = entry.href.split("#");
    onClose();
    if (path === pathname) {
      if (hash) {
        findDocHeading(hash)?.scrollIntoView({ block: "start" });
        window.history.replaceState(null, "", `#${hash}`);
      } else {
        window.scrollTo({ top: 0 });
      }
      return;
    }
    router.push(entry.href);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = flat.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (n) setActive((i) => (Math.min(i, n - 1) + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((i) => (Math.min(i, n - 1) - 1 + n) % n);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) go(current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // Keep focus in the field; the list is driven by the arrows.
      e.preventDefault();
      if (n) setActive((i) => (Math.min(i, n - 1) + (e.shiftKey ? -1 + n : 1)) % n);
    }
  };

  const onItemClick = (e: ReactMouseEvent, entry: Entry) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(entry);
  };

  let flatIndex = -1;

  return (
    <div className="fixed inset-0 z-[80]" onKeyDown={onKeyDown}>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm transition-opacity duration-150 starting:opacity-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search the docs"
        className="relative mx-auto mt-3 flex max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[640px] flex-col overflow-hidden rounded-[20px] border border-line bg-panel shadow-pop transition-[opacity,transform] duration-150 ease-out starting:opacity-0 motion-safe:starting:translate-y-1 sm:mt-[12vh] sm:max-h-[min(560px,76vh)] sm:w-[calc(100%-32px)] sm:rounded-[24px]"
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line pl-4 pr-2.5 sm:h-[60px] sm:pl-5">
          <SearchIcon size={18} className="shrink-0 text-mute" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={current ? `${uid}-${current.key}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search pages and sections"
            // The field is the dialog's focus home; the global focus ring would box it in.
            style={{ outline: "none" }}
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground placeholder:text-faint"
          />
          <button
            type="button"
            onClick={onClose}
            className="hidden h-8 items-center rounded-lg px-1.5 text-mute transition-colors hover:bg-surface sm:inline-flex"
            aria-label="Close search"
          >
            <Kbd>Esc</Kbd>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground sm:hidden"
            aria-label="Close search"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {flat.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-[15px] text-foreground">No results for “{query.trim()}”</p>
              <p className="mt-1.5 text-[13.5px] text-mute">
                Try a page name, a feature like payroll, or a term like faucet.
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label} className="mb-1 last:mb-0">
                <p className="t-label px-3 pb-1.5 pt-3">{group.label}</p>
                {group.items.map((entry) => {
                  flatIndex += 1;
                  const i = flatIndex;
                  const on = current?.key === entry.key;
                  return (
                    <ResultRow
                      key={entry.key}
                      id={`${uid}-${entry.key}`}
                      entry={entry}
                      query={query}
                      active={on}
                      onHover={() => setActive(i)}
                      onClick={(e) => onItemClick(e, entry)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-5 border-t border-line px-5 py-2.5 text-[12px] text-mute sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            to move
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            to open
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
            anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

function ResultRow({
  id,
  entry,
  query,
  active,
  onHover,
  onClick,
}: {
  id: string;
  entry: Entry;
  query: string;
  active: boolean;
  onHover: () => void;
  onClick: (e: ReactMouseEvent) => void;
}): ReactNode {
  const Icon = entry.kind === "page" ? PageIcon : HashIcon;
  return (
    <Link
      id={id}
      href={entry.href}
      role="option"
      aria-selected={active}
      data-active={active}
      tabIndex={-1}
      onMouseMove={active ? undefined : onHover}
      onClick={onClick}
      className={`flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 transition-colors ${
        active ? "bg-surface" : ""
      }`}
    >
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line ${
          active ? "bg-panel text-foreground" : "text-mute"
        }`}
      >
        <Icon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] leading-snug text-foreground">
          <Marked text={entry.title} query={query} />
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] leading-snug text-mute">
          {entry.kind === "heading" ? `In ${entry.context}` : entry.context}
        </span>
      </span>
      <span
        aria-hidden
        className={`hidden shrink-0 transition-opacity sm:block ${active ? "opacity-100" : "opacity-0"}`}
      >
        <Kbd>Enter</Kbd>
      </span>
    </Link>
  );
}
