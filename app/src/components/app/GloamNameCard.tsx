"use client";

/**
 * "Your name" on Receive: get a short name (@duke) that pays this Gloam address,
 * or see the one this browser already has (lib/gloamNames, contracts/src/GloamNames.sol).
 *
 * Names live in one registry on Robinhood Chain mainnet and are paid per year in
 * $GLOAM, which goes to the treasury. Getting one is two wallet steps on
 * Robinhood Chain: approve the exact price, then register. The name points at
 * the key inside this Gloam address; the wallet that pays becomes its holder,
 * the only one who can re-point it. Hidden until the registry is deployed, and
 * in the recording demo.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { erc20Abi, zeroAddress, type Hex } from "viem";
import { useWriteContract } from "wagmi";
import { useAppAccount, useDemo } from "@/lib/demo";
import { useNetwork } from "./NetworkProvider";
import { getNetwork } from "@/lib/networks";
import { publicClientFor } from "@/lib/rhClient";
import { GLOAM_TOKEN } from "@/lib/buybacks";
import { receiveTagPoint } from "@/lib/receiveTag";
import { walletErrorForPeople } from "@/lib/walletErrors";
import { lookupGloamName, readGloamName } from "@/hooks/useGloamName";
import { BusyLabel } from "@/components/ui/Spinner";
import { SuccessModal } from "./SuccessModal";
import { Select } from "@/components/ui/Select";
import {
  GLOAM_NAMES_ADDRESS,
  GLOAM_NAMES_CHAIN_ID,
  NAME_GRACE_SECONDS,
  NAME_YEARS,
  forgetMyName,
  gloamAmount,
  gloamNamesAbi,
  isValidName,
  loadMyNames,
  nameDate,
  nameExpired,
  nameFromClaimInput,
  isBlockedName,
  nameProblem,
  rememberMyName,
  type NameRecord,
} from "@/lib/gloamNames";

type Check =
  | { status: "idle" }
  /** `balance` is the connected wallet's $GLOAM on Robinhood Chain, null with no wallet. */
  | { status: "free"; key: string; price: bigint; balance: bigint | null }
  | { status: "yours"; key: string; record: NameRecord }
  | { status: "taken"; key: string }
  | { status: "error"; key: string };

const rh = () => publicClientFor(getNetwork("robinhood-mainnet"));

export function GloamNameCard({ tag }: { tag: string }) {
  const demo = useDemo();
  if (!GLOAM_NAMES_ADDRESS || demo) return null;
  return <NameCard tag={tag} registry={GLOAM_NAMES_ADDRESS} />;
}

function NameCard({ tag, registry }: { tag: string; registry: `0x${string}` }) {
  const { address, isConnected } = useAppAccount();
  const { network, setNetworkKey } = useNetwork();
  const { writeContractAsync } = useWriteContract();
  const onRh = network.chainId === GLOAM_NAMES_CHAIN_ID;

  const [mine, setMine] = useState<NameRecord | null>(null);
  /** When `mine` was read, unix seconds: expiry is judged against it, not the clock at render. */
  const [readAt, setReadAt] = useState(0);
  const [mineLoaded, setMineLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [years, setYears] = useState<number>(1);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  /** Where getting a name is: step 1 approve, step 2 register (1 of 1 when no approval is needed). */
  const [progress, setProgress] = useState<{ step: number; of: number; text: string } | null>(null);
  /** The name just bought, shown in the success dialog. */
  const [won, setWon] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const still = Boolean(useReducedMotion());
  const [copied, setCopied] = useState(false);
  const [refresh, setRefresh] = useState(0);
  /** Set the moment a wallet action starts, so a second click in the same tick does nothing. */
  const working = useRef(false);

  const name = nameFromClaimInput(draft);
  const problem = nameProblem(name);
  const checkKey = `${name}:${years}:${address ?? ""}:${refresh}`;

  // The name this browser has: the newest saved one that still pays this address, or
  // is held by the connected wallet. A saved name now held by someone else is dropped;
  // one that could not be read is kept and read again shortly, never dropped.
  useEffect(() => {
    let stale = false;
    let retry = 0;
    void (async () => {
      let failed = false;
      for (const n of loadMyNames()) {
        const record = await lookupGloamName(n);
        if (stale) return;
        if (record === "failed") {
          failed = true;
          continue;
        }
        const held = Boolean(record && address && record.holder.toLowerCase() === address.toLowerCase());
        if (record && (record.tag === tag || held)) {
          setMine(record);
          setReadAt(Date.now() / 1000);
          setMineLoaded(true);
          return;
        }
        // without a wallet there is no telling whose it is now: keep it
        if (record && !address) continue;
        forgetMyName(n);
      }
      if (stale) return;
      if (failed) {
        retry = window.setTimeout(() => setRefresh((x) => x + 1), 3000);
        return;
      }
      setMine(null);
      setMineLoaded(true);
    })();
    return () => {
      stale = true;
      window.clearTimeout(retry);
    };
  }, [refresh, tag, address]);

  // Whether the typed name is free, and what it costs for the years picked.
  useEffect(() => {
    if (!isValidName(name) || isBlockedName(name)) return;
    let stale = false;
    const key = checkKey;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const record = await lookupGloamName(name);
          if (stale) return;
          if (record === "failed") throw new Error("read failed");
          if (record) {
            if (record.tag === tag && address && record.holder.toLowerCase() === address.toLowerCase()) {
              // A name typed here that pays this address and is held by this wallet is simply this browser's.
              rememberMyName(record.name);
              setMine(record);
              setReadAt(Date.now() / 1000);
              setDraft("");
              setCheck({ status: "yours", key, record });
            } else {
              setCheck({ status: "taken", key });
            }
            return;
          }
          const client = rh();
          const [free, price, balance] = await Promise.all([
            client.readContract({
              address: registry,
              abi: gloamNamesAbi,
              functionName: "available",
              args: [name, address ?? zeroAddress],
            }),
            client.readContract({
              address: registry,
              abi: gloamNamesAbi,
              functionName: "priceOf",
              args: [name, BigInt(years)],
            }),
            address
              ? client.readContract({ address: GLOAM_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [address] })
              : Promise.resolve(null),
          ]);
          if (stale) return;
          setCheck(free ? { status: "free", key, price, balance } : { status: "taken", key });
        } catch {
          if (!stale) setCheck({ status: "error", key });
        }
      })();
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [name, years, address, registry, tag, checkKey]);

  /** The check for exactly what is typed now; null while it is still being read. */
  const current = check.status !== "idle" && check.key === checkKey ? check : null;

  async function waitFor(hash: Hex) {
    const receipt = await rh().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction did not go through. Nothing was paid.");
  }

  /**
   * Whether the registry needs an approval for `amount` $GLOAM first. Throws
   * when the wallet holds too little, before any wallet prompt.
   */
  async function needsApproval(amount: bigint): Promise<boolean> {
    if (!address || amount === 0n) return false;
    const client = rh();
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: GLOAM_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      client.readContract({ address: GLOAM_TOKEN, abi: erc20Abi, functionName: "allowance", args: [address, registry] }),
    ]);
    if (balance < amount) {
      throw new Error(
        `This takes ${gloamAmount(amount)} $GLOAM on Robinhood Chain, and this wallet has ${gloamAmount(balance)}.`
      );
    }
    return allowance < amount;
  }

  /** Approve exactly `amount` $GLOAM for the registry and wait for it. */
  async function approve(amount: bigint) {
    await waitFor(
      await writeContractAsync({
        address: GLOAM_TOKEN,
        abi: erc20Abi,
        functionName: "approve",
        args: [registry, amount],
        account: address,
        chainId: GLOAM_NAMES_CHAIN_ID,
      })
    );
  }

  /** Approve exactly `amount` $GLOAM for the registry when the allowance is short. */
  async function approveIfNeeded(amount: bigint) {
    if (!(await needsApproval(amount))) return;
    setBusy("Approving $GLOAM…");
    await approve(amount);
  }

  async function run(label: string, work: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setError(null);
    setBusy((b) => b ?? `${label}…`);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error && e.message.includes("$GLOAM") ? e.message : walletErrorForPeople(e, `${label} didn't go through. Try again.`));
    } finally {
      working.current = false;
      setBusy(null);
      setProgress(null);
      // read everything again: the name, the price, the balance
      setRefresh((n) => n + 1);
    }
  }

  function getName(price: bigint) {
    const point = receiveTagPoint(tag);
    if (!address || !point || busy || working.current) return;
    const payer = address;
    // what was on screen when the button was pressed, whatever happens to the input after
    const wanted = name;
    const span = years;
    setBusy(`Getting @${wanted}…`);
    void run("Getting the name", async () => {
      // the price the button showed is the price paid: stop if it moved since
      const now = await rh().readContract({
        address: registry,
        abi: gloamNamesAbi,
        functionName: "priceOf",
        args: [wanted, BigInt(span)],
      });
      if (now !== price) throw new Error(`The price of @${wanted} just changed to ${gloamAmount(now)} $GLOAM. Check it and try again.`);
      const approving = await needsApproval(price);
      const of = approving ? 2 : 1;
      if (approving) {
        setProgress({ step: 1, of, text: `Approve ${gloamAmount(price)} $GLOAM in your wallet` });
        await approve(price);
      }
      setProgress({ step: of, of, text: `Confirm @${wanted} in your wallet` });
      const hash = await writeContractAsync({
        account: payer,
        address: registry,
        abi: gloamNamesAbi,
        functionName: "register",
        args: [wanted, point.x, point.y, payer, BigInt(span)],
        chainId: GLOAM_NAMES_CHAIN_ID,
      });
      setProgress({ step: of, of, text: `Saving @${wanted} on Robinhood Chain…` });
      try {
        await waitFor(hash);
      } catch (e) {
        // the wait can fail after the name is already saved: believe the chain, not the wait
        const record = await readGloamName(wanted);
        if (!(record && record.tag === tag)) throw e;
      }
      rememberMyName(wanted);
      setDraft("");
      setCopied(false);
      setWon(wanted);
    });
  }

  async function copyName(n: string) {
    try {
      await navigator.clipboard.writeText(`@${n}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy your name.");
    }
  }

  // One dialog for both views, so it stays put while the card turns into the new name under it.
  const successDialog = (
    <SuccessModal
      open={Boolean(won)}
      title="Your name is live"
      amount={won ? <NameReveal name={won} still={still} /> : null}
      body={
        <>
          People can now pay <span className="text-foreground">@{won}</span> privately on Gloam.
          {mine?.name === won && <span className="mt-1 block">Yours until {nameDate(mine.expires)}.</span>}
        </>
      }
      primaryLabel={copied ? "Copied" : `Copy @${won ?? ""}`}
      onPrimary={() => won && void copyName(won)}
      onClose={() => setWon(null)}
    />
  );

  /** A soft rise when the card changes between getting a name and showing it. */
  const enter = still
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const },
      };

  function renew(record: NameRecord) {
    void run("Renewing", async () => {
      const price = await rh().readContract({
        address: registry,
        abi: gloamNamesAbi,
        functionName: "priceOf",
        args: [record.name, 1n],
      });
      await approveIfNeeded(price);
      setBusy(`Renewing @${record.name}…`);
      await waitFor(
        await writeContractAsync({
          address: registry,
          abi: gloamNamesAbi,
          functionName: "renew",
          args: [record.name, 1n],
          account: address,
          chainId: GLOAM_NAMES_CHAIN_ID,
        })
      );
    });
  }

  function pointHere(record: NameRecord) {
    const point = receiveTagPoint(tag);
    if (!point) return;
    void run("Updating the name", async () => {
      setBusy(`Pointing @${record.name} at this address…`);
      await waitFor(
        await writeContractAsync({
          address: registry,
          abi: gloamNamesAbi,
          functionName: "setKey",
          args: [record.name, point.x, point.y],
          account: address,
          chainId: GLOAM_NAMES_CHAIN_ID,
        })
      );
    });
  }

  const walletStep = !isConnected ? (
    <p className="mt-2 text-[12.5px] leading-relaxed text-mute">Connect a wallet to continue.</p>
  ) : !onRh ? (
    <button type="button" onClick={() => setNetworkKey("robinhood-mainnet")} className="btn btn-ghost mt-3">
      Switch to Robinhood Chain
    </button>
  ) : null;

  if (!mineLoaded) return null;

  if (mine) {
    const expired = nameExpired(mine, readAt);
    const soon = !expired && mine.expires - readAt < NAME_GRACE_SECONDS;
    const elsewhere = mine.tag !== tag;
    const holder = address?.toLowerCase() === mine.holder.toLowerCase();
    return (
      <>
        {successDialog}
        <motion.div key={`mine:${mine.name}`} {...enter} className="mt-3 rounded-[16px] border border-line p-[16px]">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[20px] font-light leading-tight tracking-[-0.01em] text-foreground">@{mine.name}</p>
            <button
              type="button"
              onClick={() => void copyName(mine.name)}
              aria-live="polite"
              className="btn btn-ghost btn-sm"
            >
              {copied && !won ? "Copied" : "Copy name"}
            </button>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-mute">
            {expired
              ? `Expired ${nameDate(mine.expires)}. Renew by ${nameDate(mine.expires + NAME_GRACE_SECONDS)} to keep it.`
              : `Yours until ${nameDate(mine.expires)}.`}
          </p>
          {elsewhere && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
              It pays your earlier address, which still opens here.
            </p>
          )}
          {(expired || soon || elsewhere) &&
            (walletStep ?? (
              <div className="mt-3 flex flex-wrap gap-2">
                {(expired || soon) && (
                  <button type="button" disabled={Boolean(busy)} onClick={() => renew(mine)} className="btn btn-ink">
                    Renew for a year
                  </button>
                )}
                {elsewhere && holder && !expired && (
                  <button type="button" disabled={Boolean(busy)} onClick={() => pointHere(mine)} className="btn btn-ghost">
                    Point it at this address
                  </button>
                )}
              </div>
            ))}
          {busy && (
            <p aria-live="polite" className="mt-2 text-[12.5px] text-mute">
              {busy}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
              {error}
            </p>
          )}
        </motion.div>
      </>
    );
  }

  const short = current?.status === "free" && current.balance !== null && current.balance < current.price;

  return (
    <>
      {successDialog}
      <motion.div key="get" {...enter} className="mt-3 rounded-[16px] border border-line p-[16px]">
        <label htmlFor="gloam-name" className="text-[14px] text-foreground">
          Get a name
        </label>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-mute">People can pay @name instead of this address.</p>
        {/* one box: the name, and how long, in a dropdown at its end */}
        <div className="gl-inputcard mt-3 flex items-center gap-1 rounded-[14px] py-1.5 pl-3.5 pr-1.5">
          <span className="text-[15px] text-mute">@</span>
          <input
            id="gloam-name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={Boolean(busy)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={21}
            placeholder="yourname"
            className="h-10 min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none! placeholder:text-faint"
          />
          <Select
            variant="pill"
            align="end"
            className="shrink-0"
            label="How long"
            value={years}
            disabled={Boolean(busy)}
            onChange={(v) => setYears(v)}
            options={NAME_YEARS.map((y) => ({ value: y, label: y === 1 ? "1 year" : `${y} years` }))}
          />
        </div>
        {problem ? (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {problem}
          </p>
        ) : current?.status === "taken" ? (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            @{name} is taken.
          </p>
        ) : current?.status === "error" ? (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            Could not check that name. Try again in a moment.
          </p>
        ) : null}

        {isValidName(name) && !isBlockedName(name) && current?.status !== "taken" && (
          <>
            {walletStep ?? (
              <button
                type="button"
                disabled={current?.status !== "free" || short || Boolean(busy)}
                aria-busy={Boolean(busy)}
                onClick={() => current?.status === "free" && getName(current.price)}
                className="btn btn-ink mt-3"
              >
                <BusyLabel busy={Boolean(busy)} busyText={busy ? "Getting your name" : undefined}>
                  {current?.status === "free" ? `Get @${name} · ${gloamAmount(current.price)} $GLOAM` : "Checking…"}
                </BusyLabel>
              </button>
            )}
            {short && current?.status === "free" && !busy && (
              <p role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
                This takes {gloamAmount(current.price)} $GLOAM on Robinhood Chain, and this wallet has{" "}
                {gloamAmount(current.balance ?? 0n)}.{" "}
                <Link href="/token" className="underline underline-offset-2">
                  Get $GLOAM
                </Link>
              </p>
            )}
            {progress && (
              <div aria-live="polite" className="mt-3 flex items-center gap-2.5 text-[12.5px] text-mute">
                {progress.of > 1 && (
                  <span className="flex gap-1" aria-hidden>
                    {[1, 2].map((s) => (
                      <span
                        key={s}
                        className={`h-1 w-5 rounded-full transition-colors duration-300 ${
                          s <= progress.step ? "bg-sealed" : "bg-line"
                        }`}
                      />
                    ))}
                  </span>
                )}
                <span>
                  {progress.of > 1 && (
                    <span className="sr-only">
                      Step {progress.step} of {progress.of}.{" "}
                    </span>
                  )}
                  {progress.text}
                </span>
              </div>
            )}
            {error && (
              <p role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
                {error}{" "}
                {error.includes("$GLOAM on Robinhood Chain") && (
                  <Link href="/token" className="underline underline-offset-2">
                    Get $GLOAM
                  </Link>
                )}
              </p>
            )}
            <p className="mt-3 text-[12px] leading-relaxed text-mute">
              Payments to your name stay private. The wallet that pays for it is public.
            </p>
          </>
        )}
      </motion.div>
    </>
  );
}

/** The new name, letter by letter: each rises out of a blur. Still under reduced motion. */
function NameReveal({ name, still }: { name: string; still: boolean }) {
  const chars = ["@", ...name];
  return (
    <span aria-label={`@${name}`} className="inline-flex" style={name.length > 12 ? { fontSize: "0.72em" } : undefined}>
      {chars.map((c, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="inline-block"
          initial={still ? false : { opacity: 0, y: 14, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ delay: 0.22 + i * 0.045, type: "spring", stiffness: 380, damping: 26 }}
        >
          {c}
        </motion.span>
      ))}
    </span>
  );
}
