"use client";

/**
 * Gloam on Solana as one account the whole app shares, the way the EVM side
 * shares its wallet: the Solana wallet that opens it, the private account it
 * opens (lib/solanaRings, on Helius Solana Privacy Rings), the private and
 * public balances, and every money move with the step it is on. Portfolio,
 * the Vault's actions and Payroll all read it while Solana is the network
 * picked (NetworkProvider `solana`), so moving between them keeps the account
 * open. The private account's keys live only in this tab.
 *
 * Nothing here loads the Solana SDK until Solana is picked. In the recording
 * demo (lib/demoFlag, local only) a pretend wallet and balance play every step
 * back with no wallet and nothing sent.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNetwork } from "./NetworkProvider";
import { useDemo } from "@/lib/demo";
import { displayAmount } from "@/lib/amountShort";
import { RINGS_PROXY_PATHS, SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK, ringsAssets, ringsBalancesFrom, type RingsAsset, type RingsNetwork } from "@/lib/solanaRings/config";
import type { RelayStatus, RingsSession } from "@/lib/solanaRings/client";
import type { PayrollDeps } from "@/lib/solanaRings/payroll";
import type { PayrollStore } from "@/lib/solanaRings/payrollStore";
import { canSignMessage, connectSolana, useSolanaWallets, type SolanaAccount, type SolanaWallet } from "@/lib/solanaWallet";

const lib = () => import("@/lib/solanaRings/client");

export type SolanaTaskKind = "connect" | "setup" | "add" | "pay" | "cashout" | "refresh";

/**
 * A wait, named step by step: what it is doing now, and what comes after.
 * `detail` is where a send stands within the current step, in the client's
 * own words (lib/solanaRings/client ringsStepLabel): sending, waiting for
 * Solana, sending again, checking.
 */
export type SolanaTask = { kind: SolanaTaskKind; steps: string[]; at: number; detail?: string };

/** What a payroll run needs from the account (components/app/SolanaPayrollView). */
export type SolanaPayrollEngine = {
  network: RingsNetwork;
  owner: string;
  store(): Promise<PayrollStore>;
  registeredMany(owners: readonly string[]): Promise<Map<string, boolean>>;
  /** Read the private balance again from Solana. */
  sync(): Promise<Record<string, bigint>>;
  /** The private balance as this tab knows it now. */
  balances(): Record<string, bigint>;
  deps(asset: RingsAsset): Promise<Pick<PayrollDeps, "build" | "send" | "release" | "confirm" | "resolve" | "message" | "tooBig">>;
  message(e: unknown): Promise<string>;
};

type Main = { wallet: SolanaWallet; account: SolanaAccount };

type SolanaCtx = {
  /** Solana is the network picked (and on). */
  on: boolean;
  demo: boolean;
  network: RingsNetwork;
  /** Solana wallets in this browser that can open a private account. */
  wallets: SolanaWallet[];
  /** Gloam's Solana relay: null until read. */
  relay: RelayStatus | null;
  /** Which assets are set up on chain, by asset id. */
  ready: Record<string, boolean>;
  main: Main | null;
  /** The private account's address, once it is open. */
  address: string | null;
  /** The open private account (none in the demo): money that arrived at its address is made private from it (SolanaBridgeIn). */
  session: RingsSession | null;
  /** Private balances in base units by asset id, once read. */
  balances: Record<string, bigint> | null;
  /** The main wallet's public balances by asset id, once read. */
  walletBalances: Record<string, bigint> | null;
  task: SolanaTask | null;
  error: { kind: SolanaTaskKind; message: string } | null;
  connect(w: SolanaWallet): Promise<boolean>;
  setUp(): Promise<boolean>;
  disconnect(): void;
  refresh(): Promise<boolean>;
  add(asset: RingsAsset, amount: bigint): Promise<string | null>;
  pay(to: string, asset: RingsAsset, amount: bigint): Promise<string | null>;
  cashOut(to: string, asset: RingsAsset, amount: bigint): Promise<string | null>;
  clearError(): void;
  setBalances(b: Record<string, bigint>): void;
  payroll: SolanaPayrollEngine | null;
};

const Ctx = createContext<SolanaCtx | null>(null);

/** The Solana account, or null outside the app (or while Solana is off). */
export function useSolana(): SolanaCtx | null {
  return useContext(Ctx);
}

/** Short form of a Solana address: "7Gh4...x9Qa". */
export function shortSol(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a;
}

/** "1.5" in `decimals` places, or null. */
export function parseSolAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const v = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return v > 0n ? v : null;
}

/** An amount in base units as shown, like every amount in the app: two places, cut down (lib/amountShort). */
export function formatSolAmount(v: bigint, decimals: number): string {
  return displayAmount(v, decimals);
}

/** The same amount as plain text for an input (no grouping, every decimal). */
export function plainSolAmount(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

/**
 * The same wallet, telling us when it is asked to sign and when it answers, so
 * a wait can say "Confirm in Phantom" while the wallet is open and move on the
 * moment it closes. Wallet Standard wallets keep their fields on getters, so
 * this wraps them rather than copying them.
 */
function watchedWallet(w: SolanaWallet, hook: { current: { ask?: () => void; answer?: () => void } }): SolanaWallet {
  const inner = w.wallet;
  const wrapFeature = (key: "solana:signMessage" | "solana:signTransaction" | "solana:signAndSendTransaction", method: string) => {
    const feat = inner.features[key] as Record<string, unknown> | undefined;
    if (!feat || typeof feat[method] !== "function") return feat;
    const fn = (feat[method] as (...a: unknown[]) => Promise<unknown>).bind(feat);
    return {
      ...feat,
      [method]: async (...args: unknown[]) => {
        hook.current.ask?.();
        try {
          return await fn(...args);
        } finally {
          hook.current.answer?.();
        }
      },
    };
  };
  const wrapped = {
    get name() {
      return inner.name;
    },
    get icon() {
      return inner.icon;
    },
    get chains() {
      return inner.chains;
    },
    get accounts() {
      return inner.accounts;
    },
    get features() {
      return {
        ...inner.features,
        "solana:signMessage": wrapFeature("solana:signMessage", "signMessage"),
        "solana:signTransaction": wrapFeature("solana:signTransaction", "signTransaction"),
        "solana:signAndSendTransaction": wrapFeature("solana:signAndSendTransaction", "signAndSendTransaction"),
      } as typeof inner.features;
    },
  } as typeof inner;
  return { name: w.name, icon: w.icon, wallet: wrapped };
}

/** The main wallet's public SOL and token balances, through Gloam's Solana RPC. */
async function readWallet(owner: string, network: RingsNetwork): Promise<Record<string, bigint>> {
  const assets = ringsAssets(network);
  const calls = assets.map((a, i) =>
    a.mint
      ? { jsonrpc: "2.0", id: i, method: "getTokenAccountsByOwner", params: [owner, { mint: a.mint }, { encoding: "jsonParsed", commitment: "confirmed" }] }
      : { jsonrpc: "2.0", id: i, method: "getBalance", params: [owner, { commitment: "confirmed" }] }
  );
  const res = await fetch(RINGS_PROXY_PATHS.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls) });
  const json = (await res.json().catch(() => null)) as { id: number; result?: unknown }[] | null;
  if (!Array.isArray(json)) throw new Error("rpc");
  const out: Record<string, bigint> = {};
  assets.forEach((a, i) => {
    const r = json.find((x) => x.id === i)?.result as
      | { value?: number | { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] }
      | undefined;
    if (!r) return;
    if (typeof r.value === "number") out[a.id] = BigInt(r.value);
    else if (Array.isArray(r.value)) {
      out[a.id] = r.value.reduce((sum, acc) => sum + BigInt(acc.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
    }
  });
  return out;
}

// ---------------------------------------------------------------- the recording demo

const DEMO_WALLET_ADDRESS = "9wPkC6bZ3mWtq8FxVhN2sRj4LdYa7GuE5oTcKpB1iHzX";
const DEMO_PRIVATE_ADDRESS = "4nQe8RtV2yJxW7aLmK3sPdF9cHbU6gZoN1iTqEvA5wYr";
const DEMO_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1d1f23"/><path d="M9 20.5c1.6-6 4.6-9 7-9s5.4 3 7 9" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>'
)}`;

function demoBalances(network: RingsNetwork): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const a of ringsAssets(network)) out[a.id] = a.id === "sol" ? 4_250_000_000n : a.id === "usdc" ? 1_250_000_000n : 300_000_000n;
  return out;
}

function demoWalletBalances(network: RingsNetwork): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const a of ringsAssets(network)) out[a.id] = a.id === "sol" ? 2_100_000_000n : a.id === "usdc" ? 480_000_000n : 0n;
  return out;
}

const DEMO_RELAY: RelayStatus = { on: true, funded: true, relayer: null, network: SOLANA_RINGS_NETWORK, priorityMicroLamports: null };
const DEMO_READY: Record<string, boolean> = Object.fromEntries(ringsAssets().map((a) => [a.id, true]));

/** The demo's pretend private balance: read and replaced whole. */
type DemoStore = { get(): Record<string, bigint>; set(b: Record<string, bigint>): void };
function demoStore(start: Record<string, bigint>): DemoStore {
  let now = start;
  return { get: () => now, set: (b) => void (now = b) };
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const demoSig = () => Array.from({ length: 88 }, () => "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[Math.floor(Math.random() * 58)]).join("");

// ---------------------------------------------------------------- the provider

export function SolanaAccountProvider({ children }: { children: ReactNode }) {
  const { solana, settled } = useNetwork();
  const demo = useDemo();
  const on = SOLANA_RINGS_ENABLED && settled && solana;
  const network = SOLANA_RINGS_NETWORK;
  const found = useSolanaWallets();
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [ready, setReady] = useState<Record<string, boolean>>({ sol: true });
  const [main, setMain] = useState<Main | null>(null);
  const [session, setSession] = useState<RingsSession | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [balances, setBalancesState] = useState<Record<string, bigint> | null>(null);
  const [walletBalances, setWalletBalances] = useState<Record<string, bigint> | null>(null);
  const [task, setTask] = useState<SolanaTask | null>(null);
  const [error, setError] = useState<{ kind: SolanaTaskKind; message: string } | null>(null);
  const hook = useRef<{ ask?: () => void; answer?: () => void }>({});
  const busy = useRef(false);
  const sessionRef = useRef<RingsSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // The pretend balance the demo moves, kept for the life of the provider.
  const [demoBal] = useState(() => demoStore(demoBalances(network)));

  const wallets = useMemo(
    () => (demo ? [{ name: "Demo wallet", icon: DEMO_ICON, wallet: null as unknown as SolanaWallet["wallet"] }] : found.filter(canSignMessage)),
    [demo, found]
  );

  // The relay and which assets are set up: read once Solana is picked (the demo's are always open).
  useEffect(() => {
    if (!on || relay || demo) return;
    let live = true;
    // The relay first (it decides what the screen shows); which assets are set up follows.
    void lib().then(async (l) => {
      const r = await l.relayStatus();
      if (!live) return;
      setRelay(r);
      const a = await l.assetsReady();
      if (live) setReady(a);
    });
    return () => {
      live = false;
    };
  }, [on, relay, demo, network]);

  // The open account closes with the tab (or when this provider goes).
  useEffect(() => {
    return () => {
      if (session) void lib().then((l) => l.closeRingsAccount(session));
    };
  }, [session]);

  // The main wallet's public balances: read when it connects, and again after a move.
  const readPublic = useCallback(async () => {
    const owner = main?.account.address;
    if (demo || !owner) return;
    try {
      const read = await readWallet(owner, network);
      setWalletBalances(read);
    } catch {
      /* Solana slow to answer: the public side stays as it was */
    }
  }, [demo, main, network]);
  useEffect(() => {
    if (!on || !main || demo) return;
    let live = true;
    void readWallet(main.account.address, network)
      .then((read) => live && setWalletBalances(read))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [on, main, demo, network]);

  /** Run one wait, with its steps; returns its result, or null with the error kept. */
  const run = useCallback(
    async <T,>(kind: SolanaTaskKind, steps: string[], fn: (step: (i: number) => void, detail: (text: string) => void) => Promise<T>): Promise<T | null> => {
      if (busy.current) return null;
      busy.current = true;
      setError(null);
      let current: SolanaTask = { kind, steps, at: 0 };
      setTask(current);
      const step = (i: number) => {
        const at = Math.max(current.at, Math.min(i, current.steps.length - 1));
        current = { ...current, at, detail: at === current.at ? current.detail : undefined };
        setTask(current);
      };
      const detail = (text: string) => {
        current = { ...current, detail: text };
        setTask(current);
      };
      try {
        return await fn(step, detail);
      } catch (e) {
        if (process.env.NODE_ENV !== "production") console.error("solana:", e);
        const message = demo ? "Something went wrong. Try again." : (await lib()).ringsErrorMessage(e);
        setError({ kind, message });
        return null;
      } finally {
        hook.current = {};
        busy.current = false;
        setTask(null);
      }
    },
    [demo]
  );

  const connect = useCallback(
    async (w: SolanaWallet) => {
      const ok = await run("connect", [`Open ${w.name} and connect`], async () => {
        if (demo) {
          await sleep(700);
          setMain({ wallet: w, account: { address: DEMO_WALLET_ADDRESS, account: { address: DEMO_WALLET_ADDRESS, chains: [] } } });
          setWalletBalances(demoWalletBalances(network));
          return true;
        }
        const account = await connectSolana(w);
        setMain({ wallet: w, account });
        return true;
      });
      return Boolean(ok);
    },
    [run, demo, network]
  );

  const setUp = useCallback(async () => {
    const m = main;
    if (!m) return false;
    const ok = await run(
      "setup",
      [`Sign the message in ${m.wallet.name}`, "Opening your private account", "Getting it ready on Solana", "Reading your private balance"],
      async (step, detail) => {
        if (demo) {
          for (const [i, ms] of [[0, 1200], [1, 900], [2, 1400], [3, 900]] as const) {
            step(i);
            await sleep(ms);
          }
          setDemoOpen(true);
          setBalancesState({ ...demoBal.get() });
          return true;
        }
        const l = await lib();
        hook.current = { answer: () => step(1) };
        const watched = watchedWallet(m.wallet, hook);
        const s = await l.openRingsAccount({ wallet: watched, account: m.account });
        hook.current = {};
        try {
          step(2);
          await l.ensureRegistered(s, { onStep: (_step, label) => detail(label) });
          step(3);
          await l.syncRings(s);
          setBalancesState(l.ringsBalances(s));
        } catch (e) {
          l.closeRingsAccount(s);
          throw e;
        }
        setSession(s);
        return true;
      }
    );
    return Boolean(ok);
  }, [main, run, demo, demoBal]);

  const disconnect = useCallback(() => {
    if (busy.current) return;
    const s = sessionRef.current;
    if (s) void lib().then((l) => l.closeRingsAccount(s));
    setSession(null);
    setDemoOpen(false);
    setMain(null);
    setBalancesState(null);
    setWalletBalances(null);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    const ok = await run("refresh", ["Reading your private balance"], async () => {
      if (demo) {
        await sleep(700);
        setBalancesState({ ...demoBal.get() });
        return true;
      }
      const s = sessionRef.current;
      if (!s) return false;
      const l = await lib();
      await l.syncRings(s);
      setBalancesState(l.ringsBalances(s));
      void readPublic();
      return true;
    });
    return Boolean(ok);
  }, [run, demo, readPublic, demoBal]);

  const add = useCallback(
    (asset: RingsAsset, amount: bigint) => {
      const name = main?.wallet.name ?? "your wallet";
      return run("add", ["Getting it ready", `Confirm in ${name}`, "Adding to your private balance"], async (step, detail) => {
        if (demo) {
          await sleep(800);
          step(1);
          await sleep(1400);
          step(2);
          await sleep(1800);
          demoBal.set({ ...demoBal.get(), [asset.id]: (demoBal.get()[asset.id] ?? 0n) + amount });
          setBalancesState({ ...demoBal.get() });
          setWalletBalances((w) => (w ? { ...w, [asset.id]: (w[asset.id] ?? 0n) > amount ? (w[asset.id] ?? 0n) - amount : 0n } : w));
          return demoSig();
        }
        const s = sessionRef.current;
        if (!s) throw new Error("Set up your private account first.");
        const l = await lib();
        hook.current = { ask: () => step(1), answer: () => step(2) };
        const sig = await l.addToPrivate(s, asset, amount, { onStep: (_step, label) => detail(label) });
        setBalancesState(l.ringsBalances(s));
        void readPublic();
        return sig;
      });
    },
    [main, run, demo, readPublic, demoBal]
  );

  const spend = useCallback(
    (kind: "pay" | "cashout", to: string, asset: RingsAsset, amount: bigint) => {
      const first = kind === "pay" ? "Paying privately" : "Cashing out";
      return run(kind, [first, "Updating your private balance"], async (step, detail) => {
        if (demo) {
          await sleep(2600);
          step(1);
          await sleep(700);
          demoBal.set({ ...demoBal.get(), [asset.id]: (demoBal.get()[asset.id] ?? 0n) - amount });
          setBalancesState({ ...demoBal.get() });
          if (kind === "cashout" && to === DEMO_WALLET_ADDRESS) {
            setWalletBalances((w) => (w ? { ...w, [asset.id]: (w[asset.id] ?? 0n) + amount } : w));
          }
          return demoSig();
        }
        const s = sessionRef.current;
        if (!s) throw new Error("Set up your private account first.");
        const l = await lib();
        if (kind === "pay" && !(await l.isRegistered(s, to))) {
          throw new Error("That address has no Gloam private account. Use Cash out to pay any Solana address.");
        }
        const opts = { onStep: (_step: unknown, label: string) => detail(label) };
        const sig = kind === "pay" ? await l.payPrivately(s, to, asset, amount, opts) : await l.cashOut(s, to, asset, amount, opts);
        step(1);
        setBalancesState(l.ringsBalances(s));
        if (kind === "cashout") void readPublic();
        return sig;
      });
    },
    [run, demo, readPublic, demoBal]
  );

  const pay = useCallback((to: string, asset: RingsAsset, amount: bigint) => spend("pay", to, asset, amount), [spend]);
  const cashOut = useCallback((to: string, asset: RingsAsset, amount: bigint) => spend("cashout", to, asset, amount), [spend]);

  const setBalances = useCallback(
    (b: Record<string, bigint>) => {
      if (demo) demoBal.set({ ...b });
      setBalancesState(b);
    },
    [demo, demoBal]
  );

  const address = demo ? (demoOpen ? DEMO_PRIVATE_ADDRESS : null) : (session?.address ?? null);

  const payroll = useMemo<SolanaPayrollEngine | null>(() => {
    if (demo && demoOpen) return demoPayrollEngine(network, DEMO_PRIVATE_ADDRESS, demoBal);
    if (!session) return null;
    return realPayrollEngine(session);
  }, [demo, demoOpen, session, network, demoBal]);

  const value = useMemo<SolanaCtx>(
    () => ({
      on,
      demo,
      network,
      wallets,
      relay: demo ? DEMO_RELAY : relay,
      ready: demo ? DEMO_READY : ready,
      main,
      address,
      session: demo ? null : session,
      balances: address ? balances : null,
      walletBalances: main ? walletBalances : null,
      task,
      error,
      connect,
      setUp,
      disconnect,
      refresh,
      add,
      pay,
      cashOut,
      clearError: () => setError(null),
      setBalances,
      payroll,
    }),
    [on, demo, network, wallets, relay, ready, main, address, session, balances, walletBalances, task, error, connect, setUp, disconnect, refresh, add, pay, cashOut, setBalances, payroll]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function realPayrollEngine(s: RingsSession): SolanaPayrollEngine {
  return {
    network: s.network,
    owner: s.address,
    store: async () => (await lib()).ringsPayrollStore(s),
    registeredMany: async (owners) => (await lib()).registeredMany(s, owners),
    sync: async () => {
      const l = await lib();
      await l.syncRings(s);
      return l.ringsBalances(s);
    },
    balances: () => ringsBalancesFrom(s.wallet.balances(true), s.network),
    deps: async (asset) => {
      const l = await lib();
      return {
        build: (payments) => l.buildPayments(s, asset, payments),
        send: (wire) => l.sendPayments(wire),
        release: () => l.releasePayments(s),
        confirm: (sig) => l.confirmPayments(s, sig),
        resolve: (f) => l.settlePayments(s, f),
        message: (e) => l.ringsErrorMessage(e),
        tooBig: (e) => l.paymentsTooBig(e),
      };
    },
    message: async (e) => (await lib()).ringsErrorMessage(e),
  };
}

function demoPayrollEngine(network: RingsNetwork, owner: string, bal: DemoStore): SolanaPayrollEngine {
  const memory = new Map<string, string>();
  return {
    network,
    owner,
    store: async () => {
      const { payrollStore, payrollStoreKey } = await import("@/lib/solanaRings/payrollStore");
      const plain = { seal: async (t: string) => t, open: async (t: string) => t };
      return payrollStore({
        key: payrollStoreKey(network, owner),
        cipher: plain,
        storage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) },
      });
    },
    registeredMany: async (owners) => {
      await sleep(500);
      return new Map(owners.map((o) => [o, true]));
    },
    sync: async () => {
      await sleep(500);
      return { ...bal.get() };
    },
    balances: () => ({ ...bal.get() }),
    deps: async (asset) => {
      let pendingAmount = 0n;
      return {
        build: async (payments) => {
          await sleep(900);
          pendingAmount = payments.reduce((s, p) => s + p.amount, 0n);
          return { wire: new Uint8Array([1]), nullifiers: [demoSig()], blockhash: demoSig() };
        },
        send: async () => {
          await sleep(700);
          bal.set({ ...bal.get(), [asset.id]: (bal.get()[asset.id] ?? 0n) - pendingAmount });
          return demoSig();
        },
        release: async () => {},
        confirm: async () => {
          await sleep(1100);
        },
        resolve: async () => ({ state: "landed" as const }),
        message: (e) => (e instanceof Error ? e.message : "Something went wrong. Try again."),
        tooBig: () => false,
      };
    },
    message: async (e) => (e instanceof Error ? e.message : "Something went wrong. Try again."),
  };
}
