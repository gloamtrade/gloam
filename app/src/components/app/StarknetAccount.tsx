"use client";

/**
 * Gloam on Starknet as one account the whole app shares while Starknet is the
 * network picked (NetworkProvider `starknet`): the browser wallet that opens
 * it, the private account it opens (lib/starknetPrivacy/session, on the
 * Starknet privacy pool), its private balance and what sits at its address,
 * and every money move with the step it is on. Portfolio and the Vault's
 * actions read it, so moving between them keeps the account open.
 *
 * Where the private account's keys come from (lib/starknetPrivacy/account):
 *  - a browser wallet signs one message (starknetAccountMessage): the same on
 *    any device, so there is nothing to back up.
 *  - a Gloam wallet (signed in with email or a passkey) never signs for it,
 *    because Turnkey keeps its signatures: it opens from its passkey (one
 *    prompt, the same passkey output Solana's private account opens from,
 *    salted for Starknet) or a backup code made in this browser
 *    (components/app/GloamAccountParts GloamRootOpen, lib/starknetPrivacy/gloamCodes).
 * The open account is held for the visit (`kept`, below), and its 32-byte
 * seed is sealed on this device for KEEP_DAYS (lib/starknetPrivacy/keep), so a
 * reload reopens it with no prompt. Signing out, Disconnect or another wallet
 * forgets it.
 *
 * Nothing here loads the Starknet SDK until Starknet is picked.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSignMessage } from "wagmi";
import { useNetwork } from "./NetworkProvider";
import { useAppAccount } from "@/lib/demo";
import { EMBEDDED_CONNECTOR_ID } from "@/lib/embeddedWallet";
import { STARKNET_ENABLED, STARKNET_NETWORK, type StarknetToken } from "@/lib/starknetPrivacy/config";
import type { StarknetRelayInfo, StarknetSession } from "@/lib/starknetPrivacy/session";
import { forgetStarknetAccount, keepStarknetAccount, keptStarknetAccount, starknetKeepDb } from "@/lib/starknetPrivacy/keep";
import type { PayrollDeps, Reach } from "@/lib/starknetPrivacy/payroll";
import type { PayrollStore } from "@/lib/starknetPrivacy/payrollStore";
import type { ScheduleStore } from "@/lib/starknetPrivacy/payrollSchedule";

/** How a Gloam wallet opens its private account here (never a signature): what the wait's first step says, and the seed. */
export type StarknetOpener = { first: string; seed: (index: number) => Promise<Uint8Array> };

export type StarknetTaskKind = "setup" | "restore" | "add" | "pay" | "cashout" | "refresh";

/** A wait, named step by step (the same shape SolanaSteps draws). */
export type StarknetTask = { kind: StarknetTaskKind; steps: string[]; at: number; detail?: string };

/** What a payroll run needs from the open account (components/app/StarknetPayrollView). */
export type StarknetPayrollEngine = {
  network: typeof STARKNET_NETWORK;
  /** The paying private account. */
  owner: string;
  token: StarknetToken;
  /** This account's runs, sealed in this browser. */
  store(): Promise<PayrollStore>;
  /** This account's payroll schedules, sealed in this browser. */
  schedules(): Promise<ScheduleStore>;
  /** Where each account stands for a payment from this one. */
  reach(addresses: string[]): Promise<Map<string, Reach>>;
  /** The engine's chain side (lib/starknetPrivacy/payrollSession). */
  deps(): Promise<Pick<PayrollDeps, "prove" | "send" | "confirm" | "resolve">>;
  /** Read the balances again; the private balance. */
  sync(): Promise<bigint>;
  /** Plain words for an error. */
  message(e: unknown): string;
};

type StarknetCtx = {
  /** Starknet is the network picked (and on). */
  on: boolean;
  network: typeof STARKNET_NETWORK;
  /** USDC here (or devnet's stand-in); null while none is listed. */
  token: StarknetToken | null;
  relay: StarknetRelayInfo | null;
  /** The browser wallet that opens the private account, once connected. */
  wallet: { address: string; gloam: boolean } | null;
  /** The private account's address, once it is open. */
  address: string | null;
  /** Private balance, base units, once read. */
  privateBalance: bigint | null;
  /** What sits at the private account's own address (not private yet), once read. */
  publicBalance: bigint | null;
  /** The relay's fee per proven move, base units (0 when none). */
  fee: bigint;
  /** Most one add may move (the relay's cap on an approve), base units; 0 while unknown. */
  maxAdd: bigint;
  /** Reopening the account this device kept open (no prompt). */
  restoring: boolean;
  task: StarknetTask | null;
  error: { kind: StarknetTaskKind; message: string } | null;
  /** Open (or set up) the private account: from the browser wallet's signature, or from `open` (a Gloam wallet: never a signature). */
  setUp(open?: StarknetOpener): Promise<boolean>;
  refresh(): Promise<boolean>;
  add(amount: bigint): Promise<string | null>;
  pay(to: string, amount: bigint): Promise<string | null>;
  cashOut(to: string, amount: bigint): Promise<string | null>;
  /** Payroll over the open account, or null until it is open. */
  payroll: StarknetPayrollEngine | null;
  /** Close the private account in this tab and forget it on this device. */
  close(): void;
  clearError(): void;
};

const Ctx = createContext<StarknetCtx | null>(null);

/** The Starknet account, or null outside the app (or while Starknet is off). */
export function useStarknet(): StarknetCtx | null {
  return useContext(Ctx);
}

/** Short form of a Starknet address: "0x68b8...e656". */
export function shortStark(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

/** Open sessions for this visit, by main wallet (lower case). Never stored. */
const kept = new Map<string, StarknetSession>();

const lib = () => Promise.all([import("@/lib/starknetPrivacy/session"), import("@/lib/starknetPrivacy/account"), import("@/lib/starknetPrivacy/config")]);

/** What a failure says, plainly; never a stack or an address dump. */
function say(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied|rejected the request/i.test(m)) return "The wallet did not sign. Try again when you're ready.";
  if (/rate.?limit|too many/i.test(m)) return "Too many requests. Try again in a little while.";
  // Gloam's daily proof quota on Starknet is used up (lib/starknetPrivacy/starkscanProver).
  if (/Starknet is busy/i.test(m)) return "Starknet is busy. Try again later.";
  return m.length > 220 ? `${m.slice(0, 217)}...` : m;
}

const STEPS: Record<Exclude<StarknetTaskKind, "refresh">, string[]> = {
  setup: ["Setting up your Starknet account", "Waiting for Starknet", "Opening your private account"],
  restore: ["Opening your private account"],
  add: ["Approving", "Waiting for Starknet", "Adding privately"],
  pay: ["Waiting for Starknet", "Paying privately"],
  cashout: ["Waiting for Starknet", "Cashing out"],
};

export function StarknetAccountProvider({ children }: { children: ReactNode }) {
  const { starknet } = useNetwork();
  const on = STARKNET_ENABLED && starknet;
  const account = useAppAccount();
  const { signMessageAsync } = useSignMessage();
  const mainAddress = account.isConnected && account.address ? account.address.toLowerCase() : null;
  const gloam = account.connector?.id === EMBEDDED_CONNECTOR_ID;

  const [relay, setRelay] = useState<StarknetRelayInfo | null>(null);
  const [token, setToken] = useState<StarknetToken | null>(null);
  const [session, setSession] = useState<StarknetSession | null>(null);
  const [privateBalance, setPrivate] = useState<bigint | null>(null);
  const [publicBalance, setPublic] = useState<bigint | null>(null);
  const [task, setTask] = useState<StarknetTask | null>(null);
  const [error, setError] = useState<StarknetCtx["error"]>(null);
  const busy = useRef(false);

  // The relay and the token, once Starknet is picked.
  useEffect(() => {
    if (!on) return;
    let live = true;
    void lib()
      .then(async ([s, , c]) => {
        const cfg = c.starknetConfig();
        if (live) setToken(cfg.tokens[0] ?? null);
        const info = await s.readRelayInfo().catch(() => null);
        if (live) setRelay(info ?? { on: false, funded: false, relayer: null, network: STARKNET_NETWORK, pool: null, fee: {}, maxApprove: {} });
      })
      .catch(() => live && setRelay({ on: false, funded: false, relayer: null, network: STARKNET_NETWORK, pool: null, fee: {}, maxApprove: {} }));
    return () => {
      live = false;
    };
  }, [on]);

  // The account kept for this wallet this visit; another wallet (or none) closes it.
  useEffect(() => {
    const k = mainAddress ? (kept.get(mainAddress) ?? null) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follow the connected wallet: its kept account, or none
    setSession(k);
    setPrivate(null);
    setPublic(null);
    setError(null);
  }, [mainAddress]);

  // A wallet that was connected on this page and then isn't (Disconnect, signing out of
  // the Gloam wallet): this device forgets its account. A reload's moment with no wallet
  // yet is not one: nothing was connected on this page.
  const wasConnected = useRef<string | null>(null);
  useEffect(() => {
    if (mainAddress) {
      wasConnected.current = mainAddress;
      return;
    }
    if (!wasConnected.current) return;
    kept.delete(wasConnected.current);
    wasConnected.current = null;
    const db = starknetKeepDb();
    if (db) void forgetStarknetAccount(db).catch(() => {});
  }, [mainAddress]);

  // Opened on this device before: reopen it from its sealed seed, with no prompt.
  const [restoring, setRestoring] = useState(false);
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!on || !mainAddress || !relay?.on || kept.has(mainAddress) || restoredFor.current === mainAddress) return;
    restoredFor.current = mainAddress;
    const db = starknetKeepDb();
    if (!db) return;
    const owner = mainAddress;
    let live = true;
    void (async () => {
      const seed = await keptStarknetAccount(db, { network: STARKNET_NETWORK, owner, index: 0 }).catch(() => null);
      if (!seed || !live) {
        seed?.fill(0);
        return;
      }
      setRestoring(true);
      try {
        await run("restore", async () => {
          const [s, a, c] = await lib();
          const cfg = c.starknetConfig();
          const keys = await a.keysFromSeed(seed, 0, cfg.accountClassHash);
          const opened = new s.StarknetSession(cfg, keys, relay, window.location.origin);
          const t = cfg.tokens[0];
          // Kept only once it was open; if it isn't any more (another network's record, a reset devnet), the person opens it again.
          // A node that can't answer throws (the error shows, the record stays for the next visit): that is never "gone".
          if (!t || !(await opened.stillOpen(t))) {
            await forgetStarknetAccount(db).catch(() => {});
            return false;
          }
          if (!live) return false;
          kept.set(owner, opened);
          // The balances are read by the session's effect, below, without holding this wait open.
          setSession(opened);
          return true;
        });
      } finally {
        seed.fill(0);
        if (live) setRestoring(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per wallet per page, when the relay is known
  }, [on, mainAddress, relay?.on]);

  const readBalances = useCallback(
    async (s: StarknetSession): Promise<boolean> => {
      const t = token ?? s.cfg.tokens[0];
      if (!t) return false;
      const [p, w] = await Promise.all([s.privateBalance(t), s.publicBalance(t)]);
      setPrivate(p);
      setPublic(w);
      return true;
    },
    [token]
  );

  useEffect(() => {
    if (!session || !on) return;
    // The balances are read from Starknet after the account opens; they land once the reads answer.
    // A read that fails says so where Refresh is, instead of a balance that loads forever.
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the balances (and a failed read) are set once Starknet answers, never in this pass
    readBalances(session).catch((e: unknown) => {
      if (live) setError({ kind: "refresh", message: say(e) });
    });
    return () => {
      live = false;
    };
  }, [session, on, readBalances]);

  const run = useCallback(
    async <T,>(kind: StarknetTaskKind, work: (step: (at: number, detail?: string) => void) => Promise<T>, named?: string[]): Promise<T | null> => {
      if (busy.current) return null;
      busy.current = true;
      setError(null);
      const steps = named ?? (kind === "refresh" ? ["Reading your balance"] : STEPS[kind]);
      setTask({ kind, steps, at: 0 });
      try {
        return await work((at, detail) => setTask({ kind, steps, at: Math.min(at, steps.length - 1), detail }));
      } catch (e) {
        setError({ kind, message: say(e) });
        return null;
      } finally {
        busy.current = false;
        setTask(null);
      }
    },
    []
  );

  const setUp = useCallback(
    async (open?: StarknetOpener): Promise<boolean> => {
      if (!on || !mainAddress || !relay?.on) return false;
      const owner = mainAddress;
      const steps = open ? [open.first, ...STEPS.setup] : STEPS.setup;
      const done = await run("setup", async (step) => {
        const [s, a, c] = await lib();
        const cfg = c.starknetConfig();
        let seed: Uint8Array;
        if (open) {
          step(0);
          seed = await open.seed(0);
        } else if (gloam) {
          // A Gloam wallet's signatures are Turnkey's to keep: its private account never comes from one.
          throw new Error("Open your private account with your passkey or backup code.");
        } else {
          // A new account is signed for twice, so a wallet that signs differently each time never makes one it can't reopen.
          seed = await a.seedFromWallet(
            (message) => signMessageAsync({ message }),
            0,
            async (first) => !(await new s.StarknetSession(cfg, await a.keysFromSeed(first, 0, cfg.accountClassHash), relay, window.location.origin).deployed()),
            () => step(0, "Sign once more, so Gloam knows your wallet signs the same way each time")
          );
        }
        try {
          const keys = await a.keysFromSeed(seed, 0, cfg.accountClassHash);
          const opened = new s.StarknetSession(cfg, keys, relay, window.location.origin);
          try {
            // With an opener the first step is its own; the session's steps follow it.
            await opened.ensureOpen((at, detail) => step(open ? at + 1 : at, detail));
          } finally {
            setRelay(opened.relayInfo);
          }
          kept.set(owner, opened);
          restoredFor.current = owner;
          // The balances are read by the session's effect: the wait ends as soon as the account is open.
          setSession(opened);
          // Stay open on this device: the next visit reopens it with no prompt (until Sign out).
          const db = starknetKeepDb();
          if (db) await keepStarknetAccount(db, { network: STARKNET_NETWORK, owner, index: 0, seed }).catch(() => {});
          return true;
        } finally {
          seed.fill(0);
        }
      }, steps);
      return done === true;
    },
    [on, mainAddress, gloam, relay, run, signMessageAsync]
  );

  const refresh = useCallback(async () => (session ? (await run("refresh", () => readBalances(session))) === true : false), [session, run, readBalances]);

  const move = useCallback(
    async (kind: "add" | "pay" | "cashout", work: (s: StarknetSession, t: StarknetToken, step: (at: number, d?: string) => void) => Promise<string>) => {
      const s = session;
      const t = token;
      if (!s || !t) return null;
      const hash = await run(kind, (step) => work(s, t, step));
      // The relay as the move last read it (a new fee, a pause), and the balances after it,
      // whether it went through or not: a move that failed late may still have landed.
      setRelay(s.relayInfo);
      await readBalances(s).catch(() => {});
      return hash;
    },
    [session, token, run, readBalances]
  );

  const payroll = useMemo<StarknetPayrollEngine | null>(() => {
    const s = session;
    const t = token;
    if (!s || !t) return null;
    return {
      network: STARKNET_NETWORK,
      owner: s.address,
      token: t,
      store: async () => {
        const st = await import("@/lib/starknetPrivacy/payrollStore");
        return st.payrollStore({ key: st.payrollStoreKey(STARKNET_NETWORK, s.address), cipher: await st.runCipher(s.keys.viewingKey, s.address) });
      },
      schedules: async () => {
        const [st, sc] = await Promise.all([import("@/lib/starknetPrivacy/payrollStore"), import("@/lib/starknetPrivacy/payrollSchedule")]);
        return sc.scheduleStore({ key: sc.scheduleStoreKey(STARKNET_NETWORK, s.address), cipher: await st.runCipher(s.keys.viewingKey, s.address, sc.SCHEDULE_DOMAIN) });
      },
      reach: async (addresses) => (await import("@/lib/starknetPrivacy/payrollSession")).payrollReach(s, t, addresses),
      deps: async () => (await import("@/lib/starknetPrivacy/payrollSession")).starknetPayrollDeps(s, t),
      sync: async () => {
        const [p, w] = await Promise.all([s.privateBalance(t), s.publicBalance(t)]);
        setPrivate(p);
        setPublic(w);
        setRelay(s.relayInfo);
        return p;
      },
      message: say,
    };
  }, [session, token]);

  const value = useMemo<StarknetCtx>(
    () => ({
      on,
      network: STARKNET_NETWORK,
      token,
      relay,
      wallet: mainAddress ? { address: mainAddress, gloam } : null,
      address: session?.address ?? null,
      privateBalance,
      publicBalance,
      fee: relay && token ? BigInt(relay.fee[`0x${BigInt(token.address).toString(16)}`] ?? "0") : 0n,
      maxAdd: relay && token ? BigInt(relay.maxApprove[`0x${BigInt(token.address).toString(16)}`] ?? "0") : 0n,
      restoring,
      task,
      error,
      setUp,
      refresh,
      add: (amount) => move("add", (s, t, step) => s.add(t, amount, step)),
      pay: (to, amount) =>
        move("pay", async (s, t, step) => {
          if (!(await s.canBePaid(to, t))) throw new Error("That private account isn't open on Starknet yet.");
          return s.pay(to, t, amount, step);
        }),
      cashOut: (to, amount) => move("cashout", (s, t, step) => s.cashOut(to, t, amount, step)),
      payroll,
      close: () => {
        if (mainAddress) kept.delete(mainAddress);
        const db = starknetKeepDb();
        if (db) void forgetStarknetAccount(db).catch(() => {});
        setSession(null);
        setPrivate(null);
        setPublic(null);
      },
      clearError: () => setError(null),
    }),
    [on, token, relay, mainAddress, gloam, session, privateBalance, publicBalance, restoring, task, error, setUp, refresh, move, payroll]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Amount helpers, two places shown (lib/amountShort), every decimal kept for inputs. */
export function parseStarkAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const v = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return v > 0n ? v : null;
}

export function plainStarkAmount(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}
