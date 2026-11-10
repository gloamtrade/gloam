"use client";

/**
 * Vault trade adapter (testnet):
 * unshield vault note → public DEX swap → reshield proceeds.
 * Honest privacy: hold is private; swap size is public on the execution edge.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { formatEther, formatUnits, type Address, type Hex } from "viem";
import { formatEth } from "@/lib/chain";
import { useNetwork } from "./NetworkProvider";
import {
  DEX_ROUTER,
  WETH,
  applySlippage,
  deadlineSeconds,
  erc20Abi,
  routerAbi,
} from "@/lib/dex";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { useShieldTree } from "@/hooks/useShieldTree";
import {
  APPROVE_GAS_LIMIT,
  HASH_SCHEME,
  NATIVE_ASSET,
  SHIELD_GAS_LIMIT,
  SHIELD_POOL_ADDRESS,
  assetLabel,
  isNativeAsset,
  isShieldDeployed,
  saveLocalNote,
  shieldPoolAbi,
  updateLocalNote,
  type LocalNote,
} from "@/lib/shield";
import { makeBoundNotePoseidon } from "@/lib/notePoseidon";
import { buildPoseidonUnshieldWitness } from "@/lib/proverPoseidon";
import { fieldToBytes32, proveUnshieldInBrowser } from "@/lib/proveClient";
import type { PoseidonMerklePath } from "@/lib/merklePoseidon";
import { getRhPublicClient } from "@/lib/rhClient";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";
import { screenWallets } from "@/lib/screeningClient";
import { cashOutTargetProblem } from "@/lib/cashOutTarget";
import { StatusPill } from "./StatusPill";
import { SuccessModal } from "./SuccessModal";
import { WalletMenu } from "./WalletMenu";
import { DevKeysBanner } from "./DevKeysBanner";

type Side = "buy" | "sell";
type Phase =
  | "idle"
  | "prove"
  | "unshield"
  | "approve"
  | "swap"
  | "reshield"
  | "done";

type Plan = {
  side: Side;
  note: LocalNote;
  token: Address;
  symbol: string;
  /** true when approve is for vault re-shield, not the DEX router */
  reshieldApprove?: boolean;
};

export function VaultTradePanel({
  marketSymbol,
  tokenAddress,
  hasPool,
  initialSide = "buy",
}: {
  marketId?: string;
  marketSymbol: string;
  tokenAddress?: Address;
  hasPool: boolean;
  /** The side a link asked for, else the saved default (Settings), until a side is picked here. */
  initialSide?: Side;
}) {
  const router = useRouter();
  const shieldLive = isShieldDeployed();
  const poseidonMode = HASH_SCHEME === "poseidon";
  const { address, isConnected } = useAccount();
  const { network } = useNetwork();
  const chainId = useChainId();
  const onProduct = chainId === network.chainId;
  const { open, refresh: refreshNotes } = useLocalShieldNotes(address);
  const {
    matchesChain,
    pathForLeaf,
    leafIndexForCommitment,
    refresh: refreshTree,
  } = useShieldTree();

  const [pickedSide, setSide] = useState<Side | null>(null);
  const side: Side = pickedSide ?? initialSide;
  const [noteId, setNoteId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [showSuccess, setShowSuccess] = useState(false);
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();
  /** True after cash-out landed, show recovery links if later steps fail */
  const [needsRecovery, setNeedsRecovery] = useState(false);

  const planRef = useRef<Plan | null>(null);
  /** Pipeline phase in a ref so receipt handlers never see a stale React state */
  const phaseRef = useRef<Phase>("idle");
  const spentNoteId = useRef<string | null>(null);
  const handledHash = useRef<string | null>(null);
  const preTokenBal = useRef<bigint>(0n);
  const preEthBal = useRef<bigint>(0n);
  const unshieldDone = useRef(false);
  const pendingReshield = useRef<{
    amount: bigint;
    asset: Address;
    note: LocalNote;
  } | null>(null);

  function setPipeline(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  const {
    writeContract,
    data: hash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract();

  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
    chainId: network.chainId,
  });

  const { data: ethBal, refetch: refetchEth } = useBalance({
    address,
    chainId: network.chainId,
    query: { enabled: Boolean(address) },
  });

  const { data: tokenBal, refetch: refetchTok } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(address && tokenAddress) },
  });

  const notes = useMemo(() => {
    return open
      .filter(
        (n) =>
          n.bound &&
          n.secret &&
          n.secret !== "0x" &&
          (!poseidonMode || n.scheme === "poseidon" || !n.scheme)
      )
      .map((n) => {
        if (n.leafIndex != null) return n;
        const idx = leafIndexForCommitment(n.commitment);
        return idx != null ? { ...n, leafIndex: idx } : n;
      })
      .filter((n) => n.leafIndex != null);
  }, [open, poseidonMode, leafIndexForCommitment]);

  const ethNotes = useMemo(
    () => notes.filter((n) => isNativeAsset(n.asset)),
    [notes]
  );

  const tokenNotes = useMemo(() => {
    if (!tokenAddress) return [];
    return notes.filter(
      (n) => n.asset.toLowerCase() === tokenAddress.toLowerCase()
    );
  }, [notes, tokenAddress]);

  const eligible = side === "buy" ? ethNotes : tokenNotes;
  const selected =
    eligible.find((n) => n.id === noteId) ?? eligible[0] ?? null;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pins the note in use, so a note saved meanwhile does not swap in mid-trade
    if (selected && selected.id !== noteId) setNoteId(selected.id);
  }, [selected, noteId]);

  const amountIn = selected ? BigInt(selected.amountWei) : 0n;

  const { data: quote } = useReadContract({
    address: DEX_ROUTER,
    abi: routerAbi,
    functionName: "getAmountsOut",
    args:
      hasPool &&
      tokenAddress &&
      amountIn > 0n &&
      selected
        ? side === "buy"
          ? [amountIn, [WETH, tokenAddress]]
          : [amountIn, [tokenAddress, WETH]]
        : undefined,
    chainId: network.chainId,
    query: {
      enabled:
        hasPool &&
        Boolean(tokenAddress) &&
        amountIn > 0n &&
        Boolean(selected),
    },
  });

  const quoteOut = quote?.[1];

  async function runSwap(plan: Plan) {
    if (!address) return;
    setPipeline("swap");
    setStatus(
      plan.side === "buy"
        ? `Swapping vault ETH → ${plan.symbol}…`
        : `Swapping vault ${plan.symbol} → ETH…`
    );
    handledHash.current = null;

    if (plan.side === "buy") {
      if (!quoteOut || quoteOut <= 0n) {
        throw new Error("No pool quote. Try again in a moment.");
      }
      writeContract({
        address: DEX_ROUTER,
        abi: routerAbi,
        functionName: "swapExactETHForTokens",
        args: [
          applySlippage(quoteOut),
          [WETH, plan.token],
          address,
          deadlineSeconds(),
        ],
        value: BigInt(plan.note.amountWei),
        chainId: network.chainId,
      });
      return;
    }

    // sell
    if (!quoteOut || quoteOut <= 0n) {
      throw new Error("No pool quote. Try again in a moment.");
    }
    writeContract({
      address: DEX_ROUTER,
      abi: routerAbi,
      functionName: "swapExactTokensForETH",
      args: [
        BigInt(plan.note.amountWei),
        applySlippage(quoteOut),
        [plan.token, WETH],
        address,
        deadlineSeconds(),
      ],
      chainId: network.chainId,
    });
  }

  async function runApproveThenSwap(plan: Plan) {
    if (!address) return;
    setPipeline("approve");
    setStatus(`Approve ${plan.symbol} for the swap…`);
    handledHash.current = null;
    writeContract({
      address: plan.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [DEX_ROUTER, BigInt(plan.note.amountWei)],
      gas: APPROVE_GAS_LIMIT,
      chainId: network.chainId,
    });
  }

  async function measureProceeds(plan: Plan): Promise<{
    amount: bigint;
    asset: Address;
  }> {
    if (!address) {
      throw new Error("Wallet not ready.");
    }
    const publicClient = getRhPublicClient();
    if (plan.side === "buy") {
      const bal = (await publicClient.readContract({
        address: plan.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;
      const delta = bal > preTokenBal.current ? bal - preTokenBal.current : bal;
      return { amount: delta, asset: plan.token };
    }
    const bal = await publicClient.getBalance({ address });
    const leave = 80_000_000_000_000n; // 0.00008 ETH for gas
    const afterGas = bal > leave ? bal - leave : 0n;
    const delta = bal > preEthBal.current ? bal - preEthBal.current : afterGas;
    let amount = delta > afterGas ? afterGas : delta;
    if (amount <= 0n && afterGas > 0n) amount = afterGas;
    return { amount, asset: NATIVE_ASSET };
  }

  async function submitShield(
    amount: bigint,
    asset: Address,
    commitment: Hex
  ) {
    if (!SHIELD_POOL_ADDRESS) return;
    setPipeline("reshield");
    setStatus("Shielding proceeds back into the vault…");
    handledHash.current = null;
    writeContract({
      address: SHIELD_POOL_ADDRESS,
      abi: shieldPoolAbi,
      functionName: "shield",
      args: [asset, amount, commitment],
      value: isNativeAsset(asset) ? amount : 0n,
      gas: SHIELD_GAS_LIMIT,
      chainId: network.chainId,
    });
  }

  async function runReshield(plan: Plan) {
    if (!address || !SHIELD_POOL_ADDRESS) return;
    const publicClient = getRhPublicClient();

    const { amount, asset } = await measureProceeds(plan);
    if (amount <= 0n) {
      throw new Error(
        "Could not measure swap proceeds. Funds may be in your open wallet, use Shield manually."
      );
    }

    const n = await makeBoundNotePoseidon(amount, asset);
    const note: LocalNote = {
      id: `vt-${Date.now()}`,
      chainId: network.chainId,
      pool: SHIELD_POOL_ADDRESS,
      asset,
      amountWei: amount.toString(),
      commitment: n.commitment,
      secret: n.secret,
      nullifier: n.nullifier,
      bound: true,
      scheme: "poseidon",
      from: address,
      createdAt: Date.now(),
      status: "open",
      source: "local",
    };
    // Hold in memory until shield confirms, avoids ghost notes on fail
    pendingReshield.current = { amount, asset, note };

    // ERC-20 shield needs pool allowance first
    if (!isNativeAsset(asset)) {
      const allowance = (await publicClient.readContract({
        address: asset,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, SHIELD_POOL_ADDRESS],
      })) as bigint;
      if (allowance < amount) {
        setPipeline("approve");
        setStatus(`Approve ${plan.symbol} for the vault…`);
        handledHash.current = null;
        planRef.current = { ...plan, reshieldApprove: true };
        writeContract({
          address: asset,
          abi: erc20Abi,
          functionName: "approve",
          args: [SHIELD_POOL_ADDRESS, amount],
          gas: APPROVE_GAS_LIMIT,
          chainId: network.chainId,
        });
        return;
      }
    }

    await submitShield(amount, asset, n.commitment);
  }

  // Advance pipeline after each confirmed tx (phaseRef avoids stale React state)
  useEffect(() => {
    if (!isSuccess || !hash) return;
    if (handledHash.current === hash) return;
    handledHash.current = hash;
    setLastHash(hash);

    const plan = planRef.current;
    if (!plan) return;
    const p = phaseRef.current;

    void (async () => {
      try {
        if (p === "unshield") {
          unshieldDone.current = true;
          setNeedsRecovery(true);
          if (spentNoteId.current) {
            updateLocalNote(spentNoteId.current, { status: "recovered" });
            spentNoteId.current = null;
          }
          refreshNotes();
          void refreshTree();
          void refetchEth();
          void refetchTok();

          if (plan.side === "sell") {
            if (!address) return;
            const publicClient = getRhPublicClient();
            const allowance = (await publicClient.readContract({
              address: plan.token,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, DEX_ROUTER],
            })) as bigint;
            const need = BigInt(plan.note.amountWei);
            if (allowance < need) {
              await runApproveThenSwap(plan);
              return;
            }
          }
          await runSwap(plan);
          return;
        }

        if (p === "approve") {
          if (plan.reshieldApprove) {
            const pending = pendingReshield.current;
            if (!pending) throw new Error("Missing re-shield note.");
            plan.reshieldApprove = false;
            if (planRef.current) planRef.current.reshieldApprove = false;
            await submitShield(
              pending.amount,
              pending.asset,
              pending.note.commitment
            );
            return;
          }
          await runSwap(plan);
          return;
        }

        if (p === "swap") {
          void refetchEth();
          void refetchTok();
          await new Promise((r) => setTimeout(r, 800));
          await runReshield(plan);
          return;
        }

        if (p === "reshield") {
          const pending = pendingReshield.current;
          if (pending) {
            saveLocalNote({
              ...pending.note,
              txHash: hash,
              status: "open",
            });
            pendingReshield.current = null;
          }
          refreshNotes();
          void refreshTree();
          setPipeline("done");
          setStatus(null);
          setShowSuccess(true);
          planRef.current = null;
          unshieldDone.current = false;
          setNeedsRecovery(false);
        }
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Vault trade step failed";
        setError(
          unshieldDone.current
            ? `${msg} Funds may already be in your open wallet, finish swap/Shield manually.`
            : msg
        );
        setPipeline("idle");
        setStatus(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- receipt-driven pipeline
  }, [isSuccess, hash]);

  useEffect(() => {
    if (!writeError) return;
    setError(
      unshieldDone.current
        ? `${writeError.message.slice(0, 120)}, if cash-out already landed, finish swap/Shield from wallet balances.`
        : writeError.message.slice(0, 160)
    );
    setPipeline("idle");
    setStatus(null);
  }, [writeError]);

  async function onStart() {
    setError(null);
    setShowSuccess(false);
    reset();
    handledHash.current = null;

    if (!selected || !address || !tokenAddress || !SHIELD_POOL_ADDRESS) {
      setError("Connect a wallet and pick a vault balance.");
      return;
    }
    if (!hasPool) {
      setError(`No swap pool for ${marketSymbol} on testnet.`);
      return;
    }
    if (!poseidonMode || !shieldLive) {
      setError("Vault trade needs the live privacy vault.");
      return;
    }
    if (!onProduct) {
      setError(`Switch to ${network.label}.`);
      return;
    }
    if (matchesChain === false) {
      setError("Vault out of sync. Open Move, refresh, then retry.");
      return;
    }
    if (selected.leafIndex == null) {
      setError("This balance is not ready in the vault yet.");
      return;
    }
    // A trade here cashes the whole note out to this wallet. A note that backed a proof of
    // funds would show that wallet to whoever holds the proof (lib/cashOutSplit spendPlanFor).
    if (selected.fundsProofAt) {
      setError("This balance backs a proof of funds you made. Trading it here would show your wallet to whoever has that proof. Swap it privately instead, or pick another balance.");
      return;
    }
    // This cash out has no step to move the note first; the sync is already moving it (lib/claimSweep).
    if (selected.swapProofAt) {
      setError("Your last swap of this balance didn't go through, so it's moving to a fresh private balance first. Try again in a minute, or pick another balance.");
      return;
    }
    // need gas in wallet for proofs + txs
    if (ethBal && ethBal.value < 50_000_000_000_000n) {
      setError("Keep a little ETH in your open wallet for gas.");
      return;
    }
    // The trade cashes out to this wallet and deposits back from it.
    const targetProblem = cashOutTargetProblem(address, { chainId: network.chainId, pool: SHIELD_POOL_ADDRESS, payMemo: network.payMemo });
    if (targetProblem) {
      setError(targetProblem);
      return;
    }
    if (!(await screenWallets([address])).allowed) {
      setError(SCREEN_BLOCKED_MESSAGE);
      return;
    }

    const plan: Plan = {
      side,
      note: selected,
      token: tokenAddress,
      symbol: marketSymbol,
    };
    planRef.current = plan;
    spentNoteId.current = selected.id;
    preTokenBal.current = (tokenBal as bigint | undefined) ?? 0n;
    preEthBal.current = ethBal?.value ?? 0n;
    unshieldDone.current = false;
    setNeedsRecovery(false);
    pendingReshield.current = null;

    setPipeline("prove");
    setStatus("Building cash-out proof… 10 to 30 seconds is normal.");

    try {
      const path = await pathForLeaf(selected.leafIndex);
      if (!path) throw new Error("Could not sync the vault. Refresh and try again.");

      const w = await buildPoseidonUnshieldWitness({
        secretHex: selected.secret,
        amount: BigInt(selected.amountWei),
        asset: selected.asset,
        to: address,
        path: path as PoseidonMerklePath,
      });
      if (!w.checks.commitmentMatches) {
        throw new Error(w.blocker ?? "This balance does not match the vault.");
      }
      const { proofBytes } = await proveUnshieldInBrowser(w.circomInput);

      setPipeline("unshield");
      setStatus("Confirm cash out in your wallet…");
      writeContract({
        address: SHIELD_POOL_ADDRESS,
        abi: shieldPoolAbi,
        functionName: "unshield",
        args: [
          proofBytes,
          fieldToBytes32(w.publicInputs.root),
          fieldToBytes32(w.publicInputs.nullifier),
          selected.asset,
          address,
          BigInt(selected.amountWei),
        ],
        gas: SHIELD_GAS_LIMIT,
        chainId: network.chainId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start vault trade");
      setPipeline("idle");
      setStatus(null);
      planRef.current = null;
    }
  }

  const working =
    phase !== "idle" &&
    phase !== "done" &&
    (phase === "prove" || isPending || confirming);

  const stepLabel =
    phase === "prove"
      ? "Proving…"
      : phase === "unshield"
        ? "Cashing out…"
        : phase === "approve"
          ? "Approving…"
          : phase === "swap"
            ? "Swapping…"
            : phase === "reshield"
              ? "Shielding back…"
              : null;

  if (!shieldLive || !poseidonMode) {
    return (
      <div className="gl-card p-6 text-[14px] text-mute">
        Vault trade needs the privacy vault. Shield is not configured.
      </div>
    );
  }

  const steps: { label: string; active: boolean }[] = [
    {
      label: "Cash out from the vault (public step)",
      active: phase === "unshield" || phase === "prove",
    },
    {
      label: "Swap on the public market",
      active: phase === "approve" || phase === "swap",
    },
    {
      label: "Shield the result back into the vault",
      active: phase === "reshield",
    },
  ];

  return (
    <>
      <div className="space-y-4">
        <DevKeysBanner compact />

        {!hasPool && (
          <div className="gl-card p-6">
            <p className="t-title text-foreground">
              No public pool for {marketSymbol}
            </p>
            <p className="mt-2 text-[14px] leading-relaxed text-mute">
              This path needs an open market, and testnet doesn&apos;t have one
              for {marketSymbol} yet. You can still hold {marketSymbol} in your
              vault and pay with it privately.
            </p>
            <Link href="/app/vault?tab=move" className="btn btn-ink btn-block mt-5">
              Pay privately
            </Link>
          </div>
        )}

        <div
          className={`gl-card overflow-hidden ${
            !hasPool ? "pointer-events-none opacity-40" : ""
          }`}
        >
          <div className="flex items-start justify-between gap-3 px-5 pt-5">
            <div className="min-w-0">
              <p className="t-title text-foreground">{marketSymbol} via market</p>
              <p className="mt-1 text-[13px] text-mute">
                The amount is public while it swaps.
              </p>
            </div>
            <StatusPill dot={hasPool}>
              {hasPool ? "Pool live" : "No pool"}
            </StatusPill>
          </div>

          <div className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-1 rounded-full bg-surface p-1">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  disabled={working}
                  aria-pressed={side === s}
                  className={`h-10 truncate rounded-full px-2 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    side === s
                      ? "bg-panel text-foreground shadow-card dark:bg-surface-2"
                      : "text-mute hover:text-foreground"
                  }`}
                >
                  {s === "buy" ? "Buy with vault ETH" : `Sell vault ${marketSymbol}`}
                </button>
              ))}
            </div>

            <div>
              <p className="text-[13px] text-mute">
                {side === "buy"
                  ? "ETH vault balance"
                  : `${marketSymbol} vault balance`}
              </p>
              {eligible.length === 0 ? (
                <p className="mt-2 rounded-[16px] border border-dashed border-line-strong px-4 py-4 text-[13px] leading-relaxed text-mute">
                  No matching balances.{" "}
                  <Link
                    href="/app/shield"
                    className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                  >
                    Shield
                  </Link>{" "}
                  {side === "buy" ? "ETH" : marketSymbol} first.
                </p>
              ) : (
                <ul className="mt-2 grid gap-1.5">
                  {eligible.map((n) => {
                    const on = selected?.id === n.id;
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => setNoteId(n.id)}
                          aria-pressed={on}
                          className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-[14px] border px-4 py-2.5 text-left transition-colors ${
                            on
                              ? "border-foreground bg-panel"
                              : "border-line hover:border-line-strong"
                          }`}
                        >
                          <span className="flex items-center gap-3">
                            <span
                              aria-hidden
                              className={`grid h-4 w-4 place-items-center rounded-full border ${
                                on ? "border-foreground" : "border-line-strong"
                              }`}
                            >
                              {on && (
                                <span className="h-2 w-2 rounded-full bg-foreground" />
                              )}
                            </span>
                            <span className="tnum text-[15px] font-medium text-foreground">
                              {isNativeAsset(n.asset)
                                ? formatEth(BigInt(n.amountWei))
                                : formatUnits(BigInt(n.amountWei), 18)}{" "}
                              {assetLabel(n.asset)}
                            </span>
                          </span>
                          <span className="text-[12px] text-mute">
                            {n.leafIndex != null ? "Ready" : "…"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {selected && quoteOut != null && quoteOut > 0n && (
              <div className="rounded-[16px] bg-surface px-4 py-3.5 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-mute">You get (est.)</span>
                  <span className="tnum text-[15px] font-medium text-foreground">
                    {side === "buy"
                      ? `${formatUnits(quoteOut, 18)} ${marketSymbol}`
                      : `${formatEther(quoteOut)} ETH`}
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] text-mute">
                  Before price moves. Uses your whole balance.
                </p>
              </div>
            )}

            <ol className="grid gap-2 text-[13px]">
              {steps.map((st, i) => (
                <li
                  key={st.label}
                  className={`flex items-center gap-2.5 ${
                    st.active ? "font-medium text-foreground" : "text-mute"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`tnum grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-medium ${
                      st.active ? "bg-ink text-on-ink" : "bg-surface text-soft"
                    }`}
                  >
                    {i + 1}
                  </span>
                  {st.label}
                </li>
              ))}
            </ol>

            {!isConnected || !onProduct ? (
              <WalletMenu variant="inline" />
            ) : (
              <button
                type="button"
                disabled={
                  working ||
                  !selected ||
                  !hasPool ||
                  matchesChain === false
                }
                onClick={() => void onStart()}
                className="btn btn-ink btn-lg btn-block"
              >
                {working && <Spinner onInk />}
                <span className="truncate">
                  {working
                    ? status || stepLabel || "Working…"
                    : side === "buy"
                      ? `Buy ${marketSymbol} from vault`
                      : `Sell ${marketSymbol} from vault`}
                </span>
              </button>
            )}

            {error && (
              <div
                role="alert"
                className="space-y-2 rounded-[14px] bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger"
              >
                <p>{error}</p>
                {needsRecovery && (
                  <p className="text-mute">
                    Recovery:{" "}
                    <button
                      type="button"
                      className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                      onClick={() => {
                        // parent TradeView follows this deep link into its pathMode
                        router.push("/app/trade?path=public");
                      }}
                    >
                      swap from open wallet
                    </button>
                    {" · "}
                    <Link
                      href="/app/shield"
                      className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                    >
                      shield leftover
                    </Link>
                    {" · "}
                    <Link
                      href="/app/move"
                      className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                    >
                      cash out other balances
                    </Link>
                  </p>
                )}
              </div>
            )}
            {status && !error && (
              <p className="text-[13px] text-mute">{status}</p>
            )}
            {hash && phase !== "done" && (
              <p className="text-[13px] text-mute">
                Transaction sent.{" "}
                <a
                  href={network.explorerTx(hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                >
                  View on explorer
                </a>
              </p>
            )}
          </div>
        </div>
      </div>

      <SuccessModal
        open={showSuccess}
        title="Vault trade complete"
        body={
          <p>
            Your {marketSymbol} vault trade finished. The result was shielded
            back into the vault when possible.{" "}
            {lastHash && (
              <a
                href={network.explorerTx(lastHash)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
              >
                Last transaction
              </a>
            )}
          </p>
        }
        primaryHref="/app"
        primaryLabel="Portfolio"
        onClose={() => {
          setShowSuccess(false);
          setPipeline("idle");
        }}
      />
    </>
  );
}

/** Small ring spinner; still (no spin) under reduced motion. */
function Spinner({ onInk = false }: { onInk?: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-4 w-4 shrink-0 rounded-full border-2 motion-safe:animate-spin ${
        onInk
          ? "border-on-ink/30 border-t-on-ink"
          : "border-line-strong border-t-foreground"
      }`}
    />
  );
}
