"use client";

/**
 * Gloam on Solana as one account the whole app shares, the way the EVM side
 * shares its wallet: the Solana wallet that opens it, the private account it
 * opens (lib/solanaRings, on Helius Solana Privacy Rings), the private and
 * public balances, and every money move with the step it is on. Portfolio,
 * the Vault's actions and Payroll all read it while Solana is the network
 * picked (NetworkProvider `solana`), so moving between them keeps the account
 * open. The open account is held in memory for the whole visit (`kept`, below),
 * the way the EVM side keeps its unlocked notes: leaving the app pages and
 * coming back does not ask again; a full reload does. The private account's
 * keys live only in this tab, never in storage, and the signature that derives
 * them is wiped as soon as they are made.
 *
 * A wallet that opened a private account here before (lib/solanaRings/opened:
 * its address and account index, nothing secret) is asked to open it, not to
 * set one up, and reopens the same index.
 *
 * Signed in, it stays signed in on this device (lib/solanaRings/keep): the
 * main wallet reconnects on load with no prompt, and the open account reopens
 * from its sealed seed for KEEP_DAYS after the signature, with no new one.
 * Sign out (or Disconnect, or switching the wallet's account) clears both.
 *
 * Nothing here loads the Solana SDK until Solana is picked. In the recording
 * demo (lib/demoFlag, local only) a pretend wallet and balance play every step
 * back with no wallet and nothing sent.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNetwork } from "./NetworkProvider";
import { useDemo } from "@/lib/demo";
import { displayAmount } from "@/lib/amountShort";
import { ringsAmount } from "@/lib/solanaRings/amount";
import { RINGS_PROXY_PATHS, SOLANA_RINGS_ENABLED, SOLANA_RINGS_NETWORK, ringsAssets, ringsBalancesFrom, type RingsAsset, type RingsNetwork } from "@/lib/solanaRings/config";
import type { RelayStatus, RingsSession } from "@/lib/solanaRings/client";
import type { PayrollDeps } from "@/lib/solanaRings/payroll";
import type { PayrollStore } from "@/lib/solanaRings/payrollStore";
import { browserStorage, openedBefore, rememberOpened } from "@/lib/solanaRings/opened";
import { browserKeepDb, forgetAccount, forgetWallet, keepAccount, keepWallet, keptAccount, keptWallet } from "@/lib/solanaRings/keep";
import {
  canSignMessage,
  connectSolana,
  disconnectSolana,
  reconnectSolana,
  useSolanaWallets,
  watchSolanaAccount,
  type SolanaAccount,
  type SolanaWallet,
} from "@/lib/solanaWallet";
import { isGloamAccount } from "@/lib/turnkeySolana";
import type { ClaimResult, LinkState } from "@/lib/solanaRings/claim";
import type { SolanaSentLinksStore } from "@/lib/solanaRings/sentLinks";

const lib = () => import("@/lib/solanaRings/client");

/** "link": making a claim link; "claim": claiming one; "takeback": taking one of yours back (Sent links). */
export type SolanaTaskKind = "connect" | "setup" | "add" | "pay" | "cashout" | "refresh" | "link" | "claim" | "takeback";

/** What a claim link's one-time account holds now (lib/solanaRings/claim). */
export type SolanaLinkRead = { state: LinkState; unspent: Record<string, bigint> };

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
  /** A claim link's one-time account (its Solana address), for a payroll row with no address. */
  claimAddress(body: string): Promise<string>;
};

type Main = { wallet: SolanaWallet; account: SolanaAccount };

/**
 * How a Gloam account (lib/turnkeySolana) opens its private account: from a
 * secret Turnkey never sees (its passkey, or a backup code: lib/solanaRings/gloamRoot),
 * never from a signature, which Turnkey keeps. `first` names the wait's first
 * step; `seed` gives the account's 32-byte seed for an index.
 */
export type AccountOpener = { first: string; seed: (index: number) => Promise<Uint8Array> };

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
  /**
   * The main wallet opened a private account here before (or the account it
   * opened turned out to be set up already): the screen says "open", not "set up".
   */
  returning: boolean;
  /** Reconnecting the wallet this device stayed signed in with, and reopening its account. */
  restoring: boolean;
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
  /** Set up (or open) the private account: from the main wallet's signature, or from `open` (a Gloam account: never a signature). */
  setUp(open?: AccountOpener): Promise<boolean>;
  /** Sign out: close the account, forget the wallet and the kept account on this device. */
  disconnect(): void;
  refresh(): Promise<boolean>;
  add(asset: RingsAsset, amount: bigint): Promise<string | null>;
  pay(to: string, asset: RingsAsset, amount: bigint): Promise<string | null>;
  cashOut(to: string, asset: RingsAsset, amount: bigint): Promise<string | null>;
  /**
   * Make a claim link for `amount` of `asset`: kept here (sealed, under Sent
   * links) before it is paid, then paid privately to its one-time account.
   * The link's body, or null with the error kept.
   */
  makeLink(asset: RingsAsset, amount: bigint): Promise<{ body: string; signature: string } | null>;
  /** Read a claim link (its body): what its one-time account holds now. Throws with plain words. */
  readLink(body: string): Promise<SolanaLinkRead>;
  /** Read several links' one-time accounts, one at a time: null for one that couldn't be read. */
  readLinks(bodies: readonly string[]): Promise<(LinkState | null)[]>;
  /** Claim a link into this private balance, or (`takeBack`, a sent link's id) take one of yours back. Null with the error kept. */
  claimLink(body: string, takeBack?: string): Promise<ClaimResult | null>;
  /** This account's sent links, sealed in this browser; null until the account is open. */
  sentLinks: (() => Promise<SolanaSentLinksStore>) | null;
  /** Goes up whenever a sent link is added or changes, so the list reads again. */
  linksTick: number;
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

/** An amount in base units as shown (lib/solanaRings/amount: two places, ZEC up to four). */
export function formatSolAmount(v: bigint, decimals: number): string {
  return ringsAmount(v, decimals);
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

/** The demo's pretend private balances: 4.25 SOL, 1,250 USDC, 300 USDT, 0.5 ZEC. */
const DEMO_PRIVATE: Record<string, bigint> = { sol: 4_250_000_000n, usdc: 1_250_000_000n, usdt: 300_000_000n, zec: 50_000_000n };
/** And its wallet's: 2.1 SOL, 480 USDC. */
const DEMO_WALLET: Record<string, bigint> = { sol: 2_100_000_000n, usdc: 480_000_000n };

function demoBalances(network: RingsNetwork): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const a of ringsAssets(network)) out[a.id] = DEMO_PRIVATE[a.id] ?? 0n;
  return out;
}

function demoWalletBalances(network: RingsNetwork): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const a of ringsAssets(network)) out[a.id] = DEMO_WALLET[a.id] ?? 0n;
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

// ---------------------------------------------------------------- the visit's account

/**
 * The open account for the rest of this visit, outside React: the provider
 * starts from it and writes back to it, so the account stays open while the app
 * pages come and go (to the docs and back, say). Memory only: a reload starts
 * empty, and the wallet signs once more.
 */
type Kept = {
  main: Main | null;
  session: RingsSession | null;
  demoOpen: boolean;
  balances: Record<string, bigint> | null;
  walletBalances: Record<string, bigint> | null;
};
const kept: Kept = { main: null, session: null, demoOpen: false, balances: null, walletBalances: null };

// ---------------------------------------------------------------- the provider

export function SolanaAccountProvider({ children }: { children: ReactNode }) {
  const { solana, settled } = useNetwork();
  const demo = useDemo();
  const on = SOLANA_RINGS_ENABLED && settled && solana;
  const network = SOLANA_RINGS_NETWORK;
  const found = useSolanaWallets();
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [ready, setReady] = useState<Record<string, boolean>>({ sol: true });
  const [main, setMain] = useState<Main | null>(() => kept.main);
  const [session, setSession] = useState<RingsSession | null>(() => kept.session);
  const [demoOpen, setDemoOpen] = useState(() => kept.demoOpen);
  const [balances, setBalancesState] = useState<Record<string, bigint> | null>(() => kept.balances);
  const [walletBalances, setWalletBalances] = useState<Record<string, bigint> | null>(() => kept.walletBalances);
  // Seen before, by this wallet: read when it connects; set too once its account turns out to be set up already.
  const [seen, setSeen] = useState<{ owner: string; index: number; seen: boolean } | null>(null);
  const [task, setTask] = useState<SolanaTask | null>(null);
  const [error, setError] = useState<{ kind: SolanaTaskKind; message: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [linksTick, setLinksTick] = useState(0);
  const bumpLinks = useCallback(() => setLinksTick((n) => n + 1), []);
  const restoreTried = useRef(false);
  const hook = useRef<{ ask?: () => void; answer?: () => void }>({});
  const busy = useRef(false);
  const sessionRef = useRef<RingsSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // The pretend balance the demo moves, kept for the life of the provider.
  const [demoBal] = useState(() => demoStore(demoBalances(network)));
  // The demo's sent links (in memory, sealed with nothing) and the links it claimed.
  const [demoLinks] = useState(() => demoLinkStore(network));

  // The visit's account follows every change, so the next mount starts where this one is.
  useEffect(() => {
    Object.assign(kept, { main, session, demoOpen, balances, walletBalances });
  }, [main, session, demoOpen, balances, walletBalances]);

  // Whether the connected wallet opened a private account here before (the demo's never has).
  const owner = main?.account.address ?? null;
  useEffect(() => {
    if (!owner) return;
    const was = demo ? { seen: false, index: 0 } : openedBefore(browserStorage(), network, owner);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the record lives only in this browser's storage; read once the wallet connects
    setSeen({ owner, ...was });
  }, [owner, demo, network]);
  const returning = Boolean(owner && seen?.owner === owner && seen.seen);

  const wallets = useMemo(
    () => (demo ? [{ name: "Demo wallet", icon: DEMO_ICON, wallet: null as unknown as SolanaWallet["wallet"] }] : found.filter((w) => canSignMessage(w) || isGloamAccount(w))),
    [demo, found]
  );

  // The relay: read once Solana is picked (the demo's is always open).
  useEffect(() => {
    if (!on || relay || demo) return;
    let live = true;
    void lib().then(async (l) => {
      const r = await l.relayStatus();
      if (live) setRelay(r);
    });
    return () => {
      live = false;
    };
  }, [on, relay, demo, network]);

  // Which assets are set up, in its own read: when it followed the relay in the
  // effect above, setting the relay re-ran that effect, whose cleanup dropped
  // this answer, so ZEC (listed only once read as set up) never showed.
  useEffect(() => {
    if (!on || demo) return;
    let live = true;
    void lib().then(async (l) => {
      const a = await l.assetsReady();
      if (live) setReady(a);
    });
    return () => {
      live = false;
    };
  }, [on, demo, network]);

  // The open account closes with the tab, or on Disconnect. Not when this
  // provider goes: the next one picks it up from `kept`.

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
    async <T,>(
      kind: SolanaTaskKind,
      steps: string[],
      fn: (step: (i: number) => void, detail: (text: string) => void, restep: (steps: string[], at: number) => void) => Promise<T>
    ): Promise<T | null> => {
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
      // The steps ahead, once the wait knows them (an account already set up skips getting it ready).
      const restep = (next: string[], at: number) => {
        current = { kind, steps: next, at: Math.min(at, next.length - 1) };
        setTask(current);
      };
      try {
        return await fn(step, detail, restep);
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

  /**
   * Reopen `m`'s account from the seed this device kept (lib/solanaRings/keep),
   * with no signature. False when none is kept for this wallet and account, or
   * it ended; the person then signs to open it.
   */
  const reopenKept = useCallback(
    async (m: Main): Promise<boolean> => {
      const db = browserKeepDb();
      if (demo || !db) return false;
      const owner = m.account.address;
      const { index } = openedBefore(browserStorage(), network, owner);
      const seed = await keptAccount(db, { network, owner, index }).catch(() => null);
      if (!seed) return false;
      try {
        const ok = await run("setup", ["Opening your private account", "Reading your private balance"], async (step) => {
          const l = await lib();
          let s: RingsSession;
          try {
            s = await l.reopenRingsAccount({ wallet: watchedWallet(m.wallet, hook), account: m.account, index, network, seed });
          } catch {
            // A kept seed that no longer opens: forget it, and the wallet signs as usual.
            await forgetAccount(db).catch(() => {});
            return false;
          }
          step(1);
          try {
            await l.syncRings(s);
            setBalancesState(l.ringsBalances(s));
          } catch (e) {
            l.closeRingsAccount(s);
            throw e;
          }
          setSession(s);
          return true;
        });
        return Boolean(ok);
      } finally {
        seed.fill(0);
      }
    },
    [demo, network, run]
  );

  /** Remember `account` of wallet `w` as the one to reconnect; another account than the last one's drops what was kept for it. */
  const keepMain = useCallback(
    async (w: SolanaWallet, account: SolanaAccount) => {
      const storage = browserStorage();
      const last = keptWallet(storage);
      const db = browserKeepDb();
      if (db && last && last.address !== account.address) await forgetAccount(db).catch(() => {});
      keepWallet(storage, { name: w.name, address: account.address });
    },
    []
  );

  const connect = useCallback(
    async (w: SolanaWallet) => {
      const m = await run("connect", [`Open ${w.name} and connect`], async () => {
        if (demo) {
          await sleep(700);
          setMain({ wallet: w, account: { address: DEMO_WALLET_ADDRESS, account: { address: DEMO_WALLET_ADDRESS, chains: [] } } });
          setWalletBalances(demoWalletBalances(network));
          return null;
        }
        const account = await connectSolana(w);
        await keepMain(w, account);
        const next = { wallet: w, account };
        setMain(next);
        return next;
      });
      // Signed in on this device before: the account opens with no new signature.
      if (m) await reopenKept(m);
      return demo || Boolean(m);
    },
    [run, demo, network, keepMain, reopenKept]
  );

  // On load, the wallet this device stayed signed in with reconnects with no
  // prompt, and its account reopens (until Sign out). Only while Solana is picked.
  useEffect(() => {
    if (!on || demo || restoreTried.current) return;
    const saved = main ? null : keptWallet(browserStorage());
    if (!saved) {
      restoreTried.current = true;
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the wallet to reconnect lives only in this browser's storage
    setRestoring(true);
    const w = wallets.find((x) => x.name === saved.name);
    if (!w) {
      // Wallets announce themselves as they load: give this one a moment, then show the usual connect.
      const t = setTimeout(() => {
        restoreTried.current = true;
        setRestoring(false);
      }, 2500);
      return () => clearTimeout(t);
    }
    restoreTried.current = true;
    void (async () => {
      try {
        const account = await reconnectSolana(w);
        if (!account) return;
        await keepMain(w, account);
        const m = { wallet: w, account };
        setMain(m);
        await reopenKept(m);
      } finally {
        setRestoring(false);
      }
    })();
  }, [on, demo, main, wallets, keepMain, reopenKept]);

  const setUp = useCallback(async (open?: AccountOpener) => {
    const m = main;
    if (!m) return false;
    const owner = m.account.address;
    const index = seen?.owner === owner ? seen.index : 0;
    const sign = open?.first ?? `Sign the message in ${m.wallet.name}`;
    const opening = "Opening your private account";
    const ready = "Getting it ready on Solana";
    const reading = "Reading your private balance";
    // A wallet seen before opens its account; a new one sets it up. Solana has the last word once the account is known.
    const opened = [sign, opening, reading];
    const fresh = [sign, opening, ready, reading];
    const ok = await run("setup", returning ? opened : fresh, async (step, detail, restep) => {
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
      // A copy of the account's seed, sealed on this device once the account is open (lib/solanaRings/keep), then wiped.
      const held: { seed: Uint8Array | null } = { seed: null };
      let s: RingsSession;
      try {
        if (open) {
          held.seed = await open.seed(index);
          step(1);
          s = await l.reopenRingsAccount({ wallet: watched, account: m.account, index, network, seed: held.seed });
        } else if (isGloamAccount(m.wallet)) {
          // A Gloam account's signatures are Turnkey's to keep: its private account never comes from one.
          throw new Error("Open your private account with your passkey or backup code.");
        } else {
          s = await l.openRingsAccount({ wallet: watched, account: m.account, index, network, onSeed: (x) => void (held.seed = x.slice()) });
        }
        hook.current = {};
        try {
          const registered = await l.isRegistered(s).catch(() => false);
          if (registered) {
            // Set up already (on another device, or before this browser kept a record): nothing new is made.
            restep(opened, 2);
            rememberOpened(browserStorage(), network, owner, index);
            setSeen({ owner, index, seen: true });
          } else {
            restep(fresh, 2);
            await l.ensureRegistered(s, { onStep: (_step, label) => detail(label) });
            rememberOpened(browserStorage(), network, owner, index);
            step(3);
          }
          await l.syncRings(s);
          setBalancesState(l.ringsBalances(s));
          // Stay signed in on this device: the next visit reopens it with no signature (until Sign out).
          const db = browserKeepDb();
          if (db && held.seed) await keepAccount(db, { network, owner, index, seed: held.seed }).catch(() => {});
        } catch (e) {
          l.closeRingsAccount(s);
          throw e;
        }
      } finally {
        held.seed?.fill(0);
      }
      setSession(s);
      return true;
    });
    return Boolean(ok);
  }, [main, seen, returning, run, demo, demoBal, network]);

  /** A sign out asked for while a wait ran (the wallet switched accounts mid-send): it runs once the wait ends. */
  const signOutLater = useRef<boolean | null>(null);

  /** Close the account and forget this device's sign-in: the kept wallet and the kept account. */
  const signOut = useCallback((tellWallet: boolean) => {
    if (busy.current) {
      signOutLater.current = (signOutLater.current ?? false) || tellWallet;
      return;
    }
    signOutLater.current = null;
    const s = sessionRef.current;
    if (s) void lib().then((l) => l.closeRingsAccount(s));
    const w = kept.main?.wallet;
    if (tellWallet && w) void disconnectSolana(w);
    forgetWallet(browserStorage());
    // a claim link this tab held goes too, so the next person here never sees it
    void import("@/lib/solanaRings/claimKeep").then((k) => k.dropSolanaClaim()).catch(() => undefined);
    const db = browserKeepDb();
    if (db) void forgetAccount(db).catch(() => {});
    restoreTried.current = true;
    setSession(null);
    setDemoOpen(false);
    setMain(null);
    setBalancesState(null);
    setWalletBalances(null);
    setError(null);
    setSeen(null);
    setRestoring(false);
    Object.assign(kept, { main: null, session: null, demoOpen: false, balances: null, walletBalances: null });
  }, []);

  const disconnect = useCallback(() => signOut(true), [signOut]);

  // The wait that held a sign out back has ended: sign out now.
  useEffect(() => {
    if (task || busy.current || signOutLater.current === null) return;
    signOut(signOutLater.current);
  }, [task, signOut]);

  // The wallet switching to another account signs this one out: its kept account is not the new one's.
  useEffect(() => {
    if (!main || demo) return;
    const mine = main.account.address;
    return watchSolanaAccount(main.wallet, (address) => {
      if (address && address !== mine) signOut(false);
    });
  }, [main, demo, signOut]);

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
        if (!s) throw new Error("Open your private account first.");
        const l = await lib();
        hook.current = { ask: () => step(1), answer: () => step(2) };
        const sig = await l.addToPrivate(s, asset, amount, {
          onStep: (_step, label) => detail(label),
          // Done once Solana confirms it: the private balance's read catches up behind the success screen.
          syncLater: (sync) => void sync.then(() => setBalancesState(l.ringsBalances(s))).catch(() => {}),
        });
        // The add landed, so it is in the private balance: show it now; the read above settles the exact figure.
        setBalancesState((b) => {
          const base = b ?? l.ringsBalances(s);
          return { ...base, [asset.id]: (base[asset.id] ?? 0n) + amount };
        });
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
        if (!s) throw new Error("Open your private account first.");
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

  // ---------------------------------------------------------------- claim links

  const sentLinks = useMemo<(() => Promise<SolanaSentLinksStore>) | null>(() => {
    if (demo) return demoOpen ? async () => demoLinks.store : null;
    if (!session) return null;
    return async () => (await lib()).ringsSentLinksStore(session);
  }, [demo, demoOpen, demoLinks, session]);

  const makeLink = useCallback(
    (asset: RingsAsset, amount: bigint) =>
      run("link", ["Making the link", "Paying it privately", "Updating your private balance"], async (step, detail) => {
        const [{ newClaim, encodeClaim }, { makeSolanaSentLink }] = await Promise.all([import("@/lib/solanaRings/claimLink"), import("@/lib/solanaRings/sentLinks")]);
        const body = encodeClaim(newClaim(network, asset, amount));
        const rec = makeSolanaSentLink({ body });
        if (demo) {
          await demoLinks.store.add(rec);
          await sleep(900);
          step(1);
          await sleep(2200);
          step(2);
          demoBal.set({ ...demoBal.get(), [asset.id]: (demoBal.get()[asset.id] ?? 0n) - amount });
          setBalancesState({ ...demoBal.get() });
          bumpLinks();
          return { body, signature: demoSig() };
        }
        const s = sessionRef.current;
        if (!s) throw new Error("Open your private account first.");
        const [l, { payNewLink }] = await Promise.all([lib(), import("@/lib/solanaRings/claim")]);
        const store = await l.ringsSentLinksStore(s);
        try {
          // Kept before anything is sent, and dropped only if the payment surely went nowhere (lib/solanaRings/claim).
          const signature = await payNewLink({
            keep: async () => {
              await store.add(rec);
              bumpLinks();
              step(1);
            },
            forget: () => store.remove(rec.id),
            pay: (handed) => l.fundClaim(s, body, asset, amount, { onStep: (_step, label) => detail(label), onHanded: handed }),
            surelyNotSent: l.surelyNotSent,
          });
          step(2);
          setBalancesState(l.ringsBalances(s));
          return { body, signature };
        } finally {
          bumpLinks();
        }
      }),
    [run, demo, network, demoBal, demoLinks, bumpLinks]
  );

  const readLink = useCallback(
    async (body: string): Promise<SolanaLinkRead> => {
      const { decodeClaim } = await import("@/lib/solanaRings/claimLink");
      const read = decodeClaim(body);
      if (!read.ok) throw new Error(read.why === "unknown" ? "This link is from a newer Gloam. Reload the page and try again." : "This link is cut off or damaged. Ask the sender to send it again.");
      if (read.claim.network !== network) throw new Error(`This link is for Solana ${read.claim.network}, and this is Gloam on Solana ${network}.`);
      if (demo) {
        await sleep(700);
        const used = demoLinks.claimed.has(body);
        return { state: used ? "used" : "unused", unspent: used ? {} : { [read.claim.asset.id]: read.claim.amount } };
      }
      const s = sessionRef.current;
      if (!s) throw new Error("Open your private account first.");
      const [l, { linkState }] = await Promise.all([lib(), import("@/lib/solanaRings/claim")]);
      const e = await l.openClaimAccount(read.claim, s);
      try {
        const h = await l.readClaimAccount(e);
        return { state: linkState(h), unspent: { ...h.unspent } };
      } finally {
        l.closeClaimAccount(e);
      }
    },
    [demo, demoLinks, network]
  );

  const readLinks = useCallback(
    async (bodies: readonly string[]) => {
      const out: (LinkState | null)[] = [];
      for (const b of bodies) out.push(await readLink(b).then((r) => r.state, () => null));
      return out;
    },
    [readLink]
  );

  const claimLink = useCallback(
    (body: string, takeBack?: string) =>
      run(takeBack ? "takeback" : "claim", [takeBack ? "Opening your link" : "Opening the link", takeBack ? "Taking it back privately" : "Claiming it privately", "Updating your private balance"], async (step, detail) => {
        const { decodeClaim } = await import("@/lib/solanaRings/claimLink");
        const read = decodeClaim(body);
        if (!read.ok) throw new Error("This link is cut off or damaged. Ask the sender to send it again.");
        if (read.claim.network !== network) throw new Error(`This link is for Solana ${read.claim.network}, and this is Gloam on Solana ${network}.`);
        let result: ClaimResult;
        if (demo) {
          await sleep(800);
          step(1);
          await sleep(2400);
          if (demoLinks.claimed.has(body)) result = { state: "used" };
          else {
            demoLinks.claimed.add(body);
            demoBal.set({ ...demoBal.get(), [read.claim.asset.id]: (demoBal.get()[read.claim.asset.id] ?? 0n) + read.claim.amount });
            result = { state: "claimed", moved: [{ assetId: read.claim.asset.id, amount: read.claim.amount, signature: demoSig() }] };
          }
          step(2);
          setBalancesState({ ...demoBal.get() });
        } else {
          const s = sessionRef.current;
          if (!s) throw new Error("Open your private account first.");
          const l = await lib();
          const e = await l.openClaimAccount(read.claim, s);
          try {
            step(1);
            result = await l.claimInto(s, e, { onStep: (_step, label) => detail(label) });
          } finally {
            l.closeClaimAccount(e);
          }
          step(2);
          setBalancesState(l.ringsBalances(s));
        }
        if (takeBack && sentLinks) {
          const store = await sentLinks();
          if (result.state === "claimed") await store.markTakenBack(takeBack).catch(() => undefined);
          else if (result.state === "used") await store.markUsed([takeBack]).catch(() => undefined);
          bumpLinks();
        }
        return result;
      }),
    [run, demo, network, demoLinks, demoBal, sentLinks, bumpLinks]
  );

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
      returning,
      restoring,
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
      makeLink,
      readLink,
      readLinks,
      claimLink,
      sentLinks,
      linksTick,
      clearError: () => setError(null),
      setBalances,
      payroll,
    }),
    [on, demo, network, wallets, relay, ready, main, returning, restoring, address, session, balances, walletBalances, task, error, connect, setUp, disconnect, refresh, add, pay, cashOut, makeLink, readLink, readLinks, claimLink, sentLinks, linksTick, setBalances, payroll]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The demo's sent links, in this tab's memory and sealed with nothing, and the links it has claimed. */
function demoLinkStore(network: RingsNetwork): { store: SolanaSentLinksStore; claimed: Set<string> } {
  const memory = new Map<string, string>();
  const plain = { seal: async (t: string) => t, open: async (t: string) => t };
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
  let store: SolanaSentLinksStore | null = null;
  const lazy = async () => {
    if (!store) {
      const { solanaSentLinksStore, sentLinksKey } = await import("@/lib/solanaRings/sentLinks");
      store = solanaSentLinksStore({ key: sentLinksKey(network, DEMO_PRIVATE_ADDRESS), cipher: plain, storage });
    }
    return store;
  };
  return {
    store: {
      load: async () => (await lazy()).load(),
      add: async (r) => (await lazy()).add(r),
      remove: async (id) => (await lazy()).remove(id),
      markUsed: async (ids, now) => (await lazy()).markUsed(ids, now),
      markTakenBack: async (id, now) => (await lazy()).markTakenBack(id, now),
    },
    claimed: new Set<string>(),
  };
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
    claimAddress: async (body) => (await (await lib()).claimDestination(body, s.network)).address,
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
    claimAddress: async () => demoSig().slice(0, 44),
  };
}
