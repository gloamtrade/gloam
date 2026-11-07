"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useReadContract, useReadContracts } from "wagmi";
import {
  decodeEventLog,
  formatEther,
  formatUnits,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { formatEth, shortAddress } from "@/lib/chain";
import {
  useAppAccount,
  useAppBalance,
  useAppTokenBalance,
  useAppTokenBalances,
  useAppTxReceipt,
  useAppWriteContract,
} from "@/lib/demo";
import { useNetwork } from "./NetworkProvider";
import { MAINNET_ENABLED, getActiveNetwork } from "@/lib/networks";
import { safeParseEther, safeParseUnits } from "@/lib/amount";
import { amountTextError } from "@/lib/amountText";
import { erc20Abi } from "@/lib/dex";
import { useEthPrice, useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { formatUsd } from "@/lib/markets";
import { addableTokensFor, approvalsBeforeDeposit, isDollarStable, isNativeAddable } from "@/lib/tokens";
import { useOpenGatedTokens } from "@/hooks/useOpenGatedTokens";
import { hasCoingeckoMarks, useCoingeckoMarks } from "@/hooks/useCoingeckoMarks";
import { surelyNotSent, walletErrorForPeople } from "@/lib/walletErrors";
import { publicClientFor } from "@/lib/rhClient";

import { isNoLimit } from "@gloamtrade/sdk";
import { APPROVE_GAS_LIMIT, gasFor, HASH_SCHEME, NATIVE_ASSET, SHIELD_GAS_LIMIT, SHIELD_BOUND_GAS_LIMIT, type LocalNote, assetDecimals, assetLabel, dropUnsentNote, formatAssetAmount, isNativeAsset, isShieldDeployed, makeNoteMaterial, markAllNotesRecovered, saveLocalNote, shieldPoolAbi } from "@/lib/shield";
import { makeBoundNotePoseidon } from "@/lib/notePoseidon";
import { createTxLog, depositAfterLostApproval, depositCall, networkMovedMessage, type DepositCall } from "@/lib/depositFlow";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";
import { screenWallets } from "@/lib/screeningClient";
import { IssuerPolicyRow } from "./IssuerPolicyRow";
import { useVaultStatus } from "@/lib/passkey";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";
import { WalletMenu } from "./WalletMenu";
import { TokenLogo } from "./TokenLogo";
import { Select } from "@/components/ui/Select";
import { SuccessModal } from "./SuccessModal";
import { DevKeysBanner } from "./DevKeysBanner";
import { BridgeInCard } from "./BridgeIn";
import { RefreshIcon } from "./VaultHealth";
import { BRIDGE_DESTINATIONS, bridgeVisible } from "@/lib/bridge";
import { countPerson } from "@/lib/people";
import { compareHoldings, pickAddAsset, vaultActionSearch } from "@/lib/vaultHub";
import { faucetFor } from "@/lib/faucet";
import { TempoFaucetButton } from "./TempoFaucetButton";

type TxKind = "shield" | "approve" | "pull" | null;
type AssetChoice = "eth" | string; // eth | token id

/** The receipt wait gave up; the deposit may still land. */
const DEPOSIT_SLOW =
  "Your deposit was sent, but the network is slow to confirm it. It's saved in this browser and shows in your private balance as soon as it lands. Check the link below.";
const DEPOSIT_REVERTED =
  "This deposit didn't go through on chain, so nothing was added to your private balance. Only the network fee was spent. Check the link below.";

/** A wallet error that may have come after the deposit went out (a timeout, a lost reply): the note is kept. */
export const DEPOSIT_MAYBE_SENT =
  "Your wallet answered with an error, but the deposit may still have gone out. It's saved in this browser and shows in your private balance if it lands. Check your wallet's activity before trying again.";

export function ShieldView() {
  const { address, isConnected, chainId, demo } = useAppAccount();
  const { network } = useNetwork();
  // The network the page shows now. Work that outlives the render it started in
  // (a proof, an approval's wait) checks against it right before it sends.
  const networkNow = useRef(network);
  useLayoutEffect(() => {
    networkNow.current = network;
  }, [network]);
  const onProduct = chainId === network.chainId;
  const { ethUsd } = useEthPrice();
  const { data: marketData } = useLiveMarkets();
  // $GLOAM, PONS, AI and the like: the markets feed has no price for them.
  const { marks: geckoMarks } = useCoingeckoMarks(hasCoingeckoMarks(network.chainId));
  const deployed = isShieldDeployed() && Boolean(network.pool);
  const {
    open: openNotes,
    shieldedWei,
    byAsset,
    syncing,
    refresh: refreshNotes,
  } = useLocalShieldNotes(address);

  // An asset listed ahead of its deposit limit (BDX, ETH on Robinhood Chain) shows
  // only once the vault's live limit for it is open, so no one is offered a deposit
  // it would refuse.
  const openGated = useOpenGatedTokens();
  const tokens = useMemo(() => addableTokensFor(network.chainId, openGated), [network.chainId, openGated]);
  const nativeOk = isNativeAddable(network.chainId, openGated);
  // A link can pick the asset (?asset=usdg, from a Holdings row or the Vault
  // overview); that choice, or one made here, is never changed for you.
  const searchParams = useSearchParams();
  const askedAsset = searchParams.get("asset");
  const askedValid =
    askedAsset !== null &&
    (askedAsset === "eth" ? nativeOk : tokens.some((t) => t.id === askedAsset));
  const [assetChoice, setAssetChoice] = useState<AssetChoice>(() =>
    askedValid ? askedAsset! : nativeOk ? "eth" : tokens[0]?.id ?? "eth"
  );
  // The network an asset was picked on, by a link or by hand; there it stays.
  const [pickedOn, setPickedOn] = useState<number | null>(askedValid ? network.chainId : null);
  const selectedToken =
    assetChoice === "eth"
      ? null
      : tokens.find((t) => t.id === assetChoice) ?? null;
  // Reset the asset choice when the network changes to one where it is invalid
  // (e.g. Tempo has no native ETH shield, and different tokens).
  useEffect(() => {
    const valid =
      assetChoice === "eth" ? nativeOk : tokens.some((t) => t.id === assetChoice);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a network that can't take the picked asset falls back to its first one
    if (!valid) setAssetChoice(nativeOk ? "eth" : tokens[0]?.id ?? "eth");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network.chainId]);
  // A link to a token that opens with its live limit (?asset=bdx) is valid only
  // once that limit is read open: then it is picked, unless one was picked by hand.
  useEffect(() => {
    if (!askedValid || pickedOn !== null || assetChoice === askedAsset) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the asked asset became addable after the first render
    setAssetChoice(askedAsset as AssetChoice);
    setPickedOn(network.chainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedValid]);
  const assetAddress: Address = selectedToken
    ? selectedToken.address
    : NATIVE_ASSET;

  const { data: ethBal, refetch: refetchEth } = useAppBalance({
    address,
    chainId: network.chainId,
    enabled: Boolean(address),
  });

  // Every asset the vault takes, read once, so the form opens on one this
  // wallet holds rather than on one it has none of.
  const tokenAddrs = useMemo(() => tokens.map((t) => t.address), [tokens]);
  const allTokenBals = useAppTokenBalances({
    tokens: tokenAddrs,
    address,
    chainId: network.chainId,
    enabled: Boolean(address && onProduct),
  });
  const walletEmpty =
    !allTokenBals.some((b) => b === undefined || b > BigInt(0)) &&
    (!nativeOk || (ethBal !== undefined && ethBal.value === BigInt(0)));

  const { data: tokenBal, refetch: refetchTok } = useAppTokenBalance({
    token: selectedToken?.address,
    address,
    chainId: network.chainId,
    enabled: Boolean(selectedToken && onProduct),
  });

  const { data: allowanceRead, refetch: refetchAllow } = useReadContract({
    address: selectedToken?.address,
    abi: erc20Abi,
    functionName: "allowance",
    args:
      address && network.pool
        ? [address, network.pool]
        : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(address && selectedToken && onProduct && !demo) },
  });
  // The pretend wallet approved the vault long ago, so a demo deposit is one step.
  const allowance = demo ? maxUint256 : allowanceRead;

  const { data: poolData, refetch: refetchPool } = useReadContracts({
    contracts: deployed
      ? [
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "nextIndex",
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "deposited",
            args: [NATIVE_ASSET],
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "currentRoot",
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "verifier",
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "owner",
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "deposited",
            args: [assetAddress],
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "shieldVerifier",
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "depositLimitsOn",
            chainId: network.chainId,
          },
          {
            address: network.pool!,
            abi: shieldPoolAbi,
            functionName: "depositLimit",
            args: [assetAddress],
            chainId: network.chainId,
          },
        ]
      : [],
    query: { enabled: deployed && !demo, refetchInterval: 12_000 },
  });

  // Balances read again on demand: after a bridge or swap lands, or when a
  // wallet's own app moved money, the numbers here catch up without a reload.
  const [refreshing, setRefreshing] = useState(false);
  const refreshBalances = async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([refetchEth(), refetchTok(), refetchAllow(), refetchPool()]);
    } finally {
      setRefreshing(false);
    }
  };

  // poolData[0..4] (next index, pool ETH, current root, verifier, owner) are
  // read with the rest but not shown here.
  const poolSelected =
    poolData?.[5]?.status === "success"
      ? (poolData[5].result as bigint)
      : null;
  const shieldVerifierAddr =
    poolData?.[6]?.status === "success"
      ? (poolData[6].result as string)
      : null;
  // Deposit limits. Pools from before them fail this read: no limits.
  const limitsOn = poolData?.[7]?.status === "success" && poolData[7].result === true;
  const limit =
    limitsOn && poolData?.[8]?.status === "success"
      ? (poolData[8].result as readonly [bigint, bigint])
      : null;
  // A side set to type(uint128).max is no limit (isNoLimit): never checked or shown.
  const limitPer = limit && !isNoLimit(limit[0]) ? limit[0] : null;
  const limitRoom =
    limit && !isNoLimit(limit[1]) && poolSelected !== null
      ? (limit[1] > poolSelected ? limit[1] - poolSelected : BigInt(0))
      : null;
  // C1: when the pool enforces bound shields, plain shield() reverts and we must
  // prove commitment == Poseidon(secret, amount, asset) via shieldBound().
  // A demo takes that path without asking the chain (both live pools enforce it).
  const shieldVerifierLive =
    demo ||
    (Boolean(shieldVerifierAddr) &&
      shieldVerifierAddr !== "0x0000000000000000000000000000000000000000");

  const [amount, setAmount] = useState("");

  // The first time every balance is in for this wallet and network, open on
  // an asset it holds (a dollar stablecoin first), unless one was picked. Once
  // per wallet and network, so the form never jumps under you.
  const [autoFor, setAutoFor] = useState<string | null>(null);
  const autoKey = address && onProduct ? `${network.chainId}:${address}` : null;
  if (
    autoKey &&
    autoFor !== autoKey &&
    pickedOn !== network.chainId &&
    !allTokenBals.some((b) => b === undefined) &&
    (!nativeOk || ethBal)
  ) {
    setAutoFor(autoKey);
    const best = pickAddAsset([
      ...(nativeOk && ethBal ? [{ id: "eth", amount: Number(formatEther(ethBal.value)), dollar: false }] : []),
      ...tokens.map((t, i) => ({
        id: t.id,
        amount: Number(formatUnits(allTokenBals[i] ?? BigInt(0), t.decimals)),
        dollar: isDollarStable(t),
      })),
    ]);
    if (best && best.id !== assetChoice) {
      setAssetChoice(best.id);
      setAmount("");
    }
  }
  const [formError, setFormError] = useState<string | null>(null);
  const vault = useVaultStatus();
  // Sanctions screening of the depositing wallet (public address only). Checked
  // when the wallet connects so a blocked wallet never fills in the form, and
  // again right before signing.
  const [blockedAddr, setBlockedAddr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const screenBlocked = Boolean(address) && blockedAddr === address;
  useEffect(() => {
    if (!address || demo) return;
    let live = true;
    void screenWallets([address]).then(({ allowed }) => {
      if (live) setBlockedAddr(allowed ? null : address);
    });
    return () => {
      live = false;
    };
  }, [address, demo]);
  const [showSuccess, setShowSuccess] = useState(false);
  const [successTitle, setSuccessTitle] = useState("Added privately");
  const [successBody, setSuccessBody] = useState<React.ReactNode>(null);
  const [pendingNote, setPendingNote] = useState<LocalNote | null>(null);
  const [pendingKind, setPendingKind] = useState<TxKind>(null);
  const [sentLabel, setSentLabel] = useState("");
  const autoShieldAfterApprove = useRef(false);
  /** Approvals still to send before the deposit: the exact amount, after USDT's stale allowance is set to 0. */
  const approvalsLeft = useRef<{ token: `0x${string}`; values: bigint[] } | null>(null);
  /** The approval in the wallet now only clears an old allowance (USDT on Ethereum). */
  const [clearingAllowance, setClearingAllowance] = useState(false);
  /** The approval has landed and the deposit is on its way: the button says so. */
  const [approved, setApproved] = useState(false);
  /**
   * The deposit's proof, started at the click so it is made while the approval
   * is mined instead of after it. Keyed by the note's commitment.
   */
  const depositProof = useRef<{ commitment: Hex; proofBytes: Promise<Hex> } | null>(null);
  const pendingShieldArgs = useRef<{
    value: bigint;
    commitment: Hex;
    note: LocalNote;
  } | null>(null);

  const {
    writeContract,
    data: hash,
    isPending,
    error: writeError,
    reset,
  } = useAppWriteContract();

  const {
    isLoading: confirming,
    isSuccess,
    isError: receiptLost,
    data: receipt,
  } = useAppTxReceipt({
    hash,
    chainId: network.chainId,
  });

  const handledHash = useRef<string | null>(null);
  /** Which of this form's transactions each hash is: only the deposit's lost receipt says "your deposit was sent". */
  const [txLog] = useState(createTxLog);
  /** A click is being checked and prepared: a second one waits for it. */
  const submitting = useRef(false);
  // Declared before the effects that read it, so it is current when they run.
  useEffect(() => {
    txLog.handed(hash);
  }, [hash, txLog]);

  const walletBalance = selectedToken
    ? (tokenBal as bigint | undefined)
    : ethBal?.value;
  // The chain's own gas coin (HYPE on Elysium), never a hardcoded "ETH".
  const symbol = selectedToken?.symbol ?? network.primaryAsset.symbol;
  const decimals = selectedToken?.decimals ?? 18;

  const mark = selectedToken
    ? isDollarStable(selectedToken)
      ? 1
      : (marketData?.markets?.find((m) => m.id === selectedToken.id)?.mark ?? geckoMarks.get(selectedToken.address.toLowerCase()) ?? 0)
    : ethUsd ?? 0;

  useEffect(() => {
    if (!isSuccess || !hash || !receipt) return;
    if (handledHash.current === hash) return;
    handledHash.current = hash;

    if (pendingKind === "pull") {
      markAllNotesRecovered(address, assetAddress);
      refreshNotes();
      void refetchEth();
      void refetchTok();
      void refetchPool();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a transaction's receipt arrived: update the notes and show the result once per transaction
      setSuccessTitle("Pulled back");
      setSuccessBody(
        <>
          <p>
            {assetLabel(assetAddress)} went back from the vault to the owner
            wallet.
          </p>
          <p className="mt-2">Testnet recovery only.</p>
        </>
      );
      setShowSuccess(true);
      setPendingKind(null);
      return;
    }

    if (pendingKind === "approve") {
      void refetchAllow();
      const pending = pendingShieldArgs.current;
      // USDT: the old allowance is 0 now, so the deposit's exact amount can be approved
      const queued = approvalsLeft.current;
      const nextApproval = queued?.values.shift();
      if (queued && nextApproval !== undefined && pending && network.pool && autoShieldAfterApprove.current) {
        setClearingAllowance(false);
        // The page moved to another network while the old allowance was cleared:
        // the next approval would name the old chain's token on the new one. Stop.
        if (pending.note.chainId !== network.chainId) {
          approvalsLeft.current = null;
          autoShieldAfterApprove.current = false;
          pendingShieldArgs.current = null;
          depositProof.current = null;
          setPendingKind(null);
          setPendingNote(null);
          setFormError(networkMovedMessage(pending.note.chainId, network));
          return;
        }
        txLog.writing("approve");
        writeContract({
          address: queued.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [network.pool, nextApproval],
          gas: gasFor(network.chainId, APPROVE_GAS_LIMIT),
          chainId: network.chainId,
        });
        return;
      }
      approvalsLeft.current = null;
      setPendingKind(null);
      setClearingAllowance(false);
      // auto continue shield
      if (pending && network.pool && autoShieldAfterApprove.current) {
        autoShieldAfterApprove.current = false;
        setApproved(true);
        // Keep handledHash on the approval: the deposit has its own hash, and
        // clearing it here let this approval's receipt count as the deposit.
        // Route through executeShield so the shieldBound (C1) branch applies
        // after an ERC20 approval too.
        // eslint-disable-next-line react-hooks/immutability -- declared further down; the effect runs after render, when it exists
        void executeShield(pending.value, pending.note, pending.commitment);
      }
      return;
    }

    let leafIndex: number | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: shieldPoolAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "Shielded") {
          leafIndex = Number(decoded.args.leafIndex);
          break;
        }
      } catch {
        /* not ours */
      }
    }
    // Only the deposit itself emits Shielded; any other receipt is not a deposit.
    // (Demo receipts carry no logs; the pretend chain only plays the deposit.)
    if (pendingKind !== "shield" || (leafIndex === undefined && !demo)) return;

    if (pendingNote) {
      // Landed: the note saved before sending (waiting, out of the balance) now counts
      saveLocalNote({
        ...pendingNote,
        txHash: hash,
        leafIndex,
        status: "open",
      });
    }
    setPendingNote(null);
    setPendingKind(null);
    setApproved(false);
    pendingShieldArgs.current = null;
    depositProof.current = null;
    refreshNotes();
    void refetchEth();
    void refetchTok();
    void refetchAllow();
    void refetchPool();
    countPerson("deposit", address, network.testnet);
    void import("@/lib/track").then(({ track }) => {
      track("shield_success", {
        asset: sentLabel.replace(/[\d.]+/g, "").trim().slice(0, 16) || "asset",
      });
    });
    setSuccessTitle("Added privately");
    setSuccessBody(
      <>
        <p>
          <span className="tnum font-medium text-foreground">{sentLabel}</span>{" "}
          is now in your private balance. Only you can see it.
        </p>
        <p className="mt-2">
          From the Vault you can pay privately or cash out to any wallet.
        </p>
      </>
    );
    setShowSuccess(true);
    void import("@/lib/onboarding").then(({ markOnboardingStep }) => {
      markOnboardingStep("shield");
      markOnboardingStep("faucet");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executeShield reads this render's form; a new one every render must not run the receipt again
  }, [
    isSuccess,
    hash,
    receipt,
    pendingNote,
    pendingKind,
    address,
    network,
    assetAddress,
    sentLabel,
    refreshNotes,
    refetchEth,
    refetchTok,
    refetchAllow,
    refetchPool,
    writeContract,
    txLog,
    demo,
  ]);

  function parseAmount(): bigint | null {
    if (selectedToken) {
      return safeParseUnits(amount || "0", decimals);
    }
    return safeParseEther(amount || "0");
  }

  function limitText(v: bigint): string {
    const n = Number(formatUnits(v, decimals));
    return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${symbol}`;
  }

  /** Why the vault's deposit limits refuse this amount, or null. */
  function limitProblem(value: bigint): string | null {
    if (!limitsOn) return null;
    if (!limit || limit[1] === BigInt(0)) {
      return `${symbol} deposits are closed right now. Private payments and cash out still work.`;
    }
    if (limitPer !== null && value > limitPer) {
      return `One deposit can be up to ${limitText(limitPer)}.`;
    }
    if (limitRoom !== null && value > limitRoom) {
      return limitRoom === BigInt(0)
        ? `The vault is at its deposit limit for ${symbol}. Try again later.`
        : `The vault has room for ${limitText(limitRoom)} more right now.`;
    }
    return null;
  }

  function validate(): string | null {
    if (!deployed) return "Pool not configured.";
    if (!isConnected || !onProduct) return network.testnet ? "Connect and switch to testnet." : `Connect and switch to ${network.label}.`;
    const value = parseAmount();
    if (value === null) return "Invalid amount.";
    if (value <= BigInt(0)) return "Amount must be greater than zero.";
    if (walletBalance !== undefined && value > walletBalance) {
      return `Not enough ${symbol}.`;
    }
    const overLimit = limitProblem(value);
    if (overLimit) return overLimit;
    if (!selectedToken && ethBal) {
      // value is at most the balance here (checked above), so this also catches the whole balance
      if (value > ethBal.value - 50_000_000_000_000n) {
        return `Leave a little ${network.primaryAsset.symbol} for gas.`;
      }
    }
    return null;
  }

  /**
   * The proof that binds a deposit (C1): commitment == Poseidon(secret, amount,
   * asset). Made once per note: onSubmit starts it, executeShield waits for it.
   */
  function proveDeposit(value: bigint, note: LocalNote, commitment: Hex, asset: Address): Promise<Hex> {
    const started = depositProof.current;
    if (started && started.commitment === commitment) return started.proofBytes;
    const proofBytes = import("@/lib/proveClient")
      .then(({ proveShieldInBrowser }) =>
        proveShieldInBrowser({
          commitment: BigInt(commitment).toString(),
          amount: value.toString(),
          asset: BigInt(asset).toString(),
          secret: BigInt(note.secret).toString(),
        })
      )
      .then((made) => made.proofBytes);
    // a failure is read where the proof is awaited (executeShield)
    proofBytes.catch(() => undefined);
    depositProof.current = { commitment, proofBytes };
    return proofBytes;
  }

  /**
   * The deposit's call while the page is still on the note's network, or null
   * (said in the form). Checked again right before the wallet is asked: the
   * page can move to another network while the proof is made or the approval
   * is mined, and the deposit must not go out on the old one behind it.
   */
  function callForNote(note: LocalNote, proofBytes: Hex | null): DepositCall | null {
    // NetworkProvider names a switch to lib code as it happens, before the next render
    const shown = getActiveNetwork();
    const page = shown.chainId !== note.chainId ? shown : networkNow.current;
    const call = depositCall(note, page, proofBytes);
    if (!call) setFormError(networkMovedMessage(note.chainId, page));
    return call;
  }

  /** Stop a deposit before it went out: a note saved for it is dropped again (lib/shield dropUnsentNote). */
  function stopDeposit(saved: LocalNote | null) {
    if (saved) dropUnsentNote(saved.id);
    setPendingKind(null);
    setPendingNote(null);
    setApproved(false);
    pendingShieldArgs.current = null;
    depositProof.current = null;
  }

  async function executeShield(value: bigint, note: LocalNote, commitment: Hex) {
    // The deposit is the note's: its chain, vault and asset, whatever the form
    // shows by now (lib/depositFlow depositCall), and only while the page is
    // still on that network (callForNote).
    if (!callForNote(note, null)) return stopDeposit(null);
    setPendingNote(note);
    setPendingKind("shield");
    // The note's secret is the money: keep it in the browser before anything is
    // sent, out of the balance until the chain shows it (lib/claimSweep settles it
    // if this tab never hears back). A refused wallet prompt drops it again.
    const keepUntilLanded = () => saveLocalNote({ ...note, status: "open", sweepPending: true });

    // C1 (audit): a hardened pool requires a proof that commitment ==
    // Poseidon(secret, amount, asset), submitted via shieldBound(). On legacy
    // pools (shieldVerifier unset) plain shield() still works, unchanged.
    if (shieldVerifierLive) {
      try {
        const proofBytes = await proveDeposit(value, note, commitment, note.asset);
        // a switch while the proof was made: stop before the note is saved
        if (!callForNote(note, proofBytes)) return stopDeposit(null);
        // stored and read back before the wallet is asked: a refused write stops here
        await keepUntilLanded();
        // and one while it was saved: right before the wallet is asked
        const call = callForNote(note, proofBytes);
        if (!call) return stopDeposit(note);
        txLog.writing("shield");
        writeContract({
          ...call,
          abi: shieldPoolAbi,
          gas: gasFor(note.chainId, SHIELD_BOUND_GAS_LIMIT),
          chainId: networkNow.current.chainId,
        } as Parameters<typeof writeContract>[0]);
      } catch (err) {
        // The note store's own words say what to do; a prover or chunk-load error is no use to read.
        setFormError(
          err instanceof Error && err.name === "NoteSaveError"
            ? err.message
            : "Could not prepare your private deposit. Try again."
        );
        stopDeposit(note);
      }
      return;
    }

    try {
      await keepUntilLanded();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save your private deposit. Try again.");
      setPendingKind(null);
      setPendingNote(null);
      return;
    }
    const call = callForNote(note, null);
    if (!call) return stopDeposit(note);
    txLog.writing("shield");
    writeContract({
      ...call,
      abi: shieldPoolAbi,
      gas: gasFor(note.chainId, SHIELD_GAS_LIMIT),
      chainId: networkNow.current.chainId,
    } as Parameters<typeof writeContract>[0]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    if (!network.pool || !address) return;
    if (vault.locked) {
      setFormError("Unlock your private balance with your passkey first.");
      return;
    }

    const value = parseAmount();
    if (value === null) {
      setFormError("Invalid amount.");
      return;
    }

    // "Checking…" holds from the click until the approvals are worked out, so a
    // second click cannot start a second note and approval meanwhile.
    if (submitting.current) return;
    submitting.current = true;
    setChecking(true);
    let ready: { note: LocalNote; commitment: Hex; steps: bigint[] } | null = null;
    try {
      ready = await prepareDeposit(value, network.pool, address);
    } catch {
      // nothing is saved or sent before prepareDeposit returns
      setFormError("Could not prepare your private deposit. Try again.");
    } finally {
      submitting.current = false;
      setChecking(false);
    }
    if (!ready) return;
    const { note, commitment, steps } = ready;

    setFormError(null);
    reset();
    setShowSuccess(false);
    setApproved(false);
    handledHash.current = null;
    txLog.clear();
    setSentLabel(`${amount} ${symbol}`);
    pendingShieldArgs.current = { value, commitment, note };
    // Proved while any approval is mined, so the deposit goes out as soon as it lands.
    if (shieldVerifierLive) void proveDeposit(value, note, commitment, note.asset);

    if (selectedToken && steps.length) {
      autoShieldAfterApprove.current = true;
      approvalsLeft.current = { token: selectedToken.address, values: steps.slice(1) };
      setClearingAllowance(steps.length > 1);
      setPendingKind("approve");
      setPendingNote(note);
      sendApprove(selectedToken.address, steps[0]!);
      return;
    }

    await executeShield(value, note, commitment);
  }

  /**
   * Everything between the click and the first wallet prompt: screening, the
   * note, and the approvals it needs from an allowance read now. Null when
   * something stops the deposit (said in the form).
   */
  async function prepareDeposit(
    value: bigint,
    pool: Address,
    address: Address
  ): Promise<{ note: LocalNote; commitment: Hex; steps: bigint[] } | null> {
    // The allowance as the chain has it now, read alongside the screening: the
    // cached one can be from before an approval that already landed, and
    // approving again would cost a wallet prompt and a block for nothing.
    const allowanceNow: Promise<bigint | undefined> =
      selectedToken && !demo
        ? refetchAllow().then(
            (r) => (r.isSuccess ? (r.data as bigint) : allowance),
            () => allowance
          )
        : Promise.resolve(allowance);

    // Screen the depositing wallet on the server before the wallet signs (on
    // Tempo, also the asset's TIP-403 issuer policy for this deposit).
    const { allowed, scope, message } = await screenWallets([address], {
      chainId: network.chainId,
      asset: assetAddress,
      flow: "deposit",
    });
    if (!allowed && scope === "asset") {
      setFormError(message ?? SCREEN_BLOCKED_MESSAGE);
      return null;
    }
    if (!allowed) {
      setBlockedAddr(address);
      setFormError(null);
      return null;
    }

    let secret: `0x${string}`;
    let commitment: `0x${string}`;
    let nullifier: `0x${string}`;
    if (HASH_SCHEME === "poseidon") {
      const n = await makeBoundNotePoseidon(value, assetAddress);
      secret = n.secret;
      commitment = n.commitment;
      nullifier = n.nullifier;
    } else {
      const n = makeNoteMaterial(value, assetAddress);
      secret = n.secret;
      commitment = n.commitment;
      nullifier = n.nullifier;
    }
    // eslint-disable-next-line react-hooks/purity -- runs in the submit handler, never during render
    const now = Date.now();
    const note: LocalNote = {
      id: `${now}-${commitment.slice(0, 10)}`,
      chainId: network.chainId,
      pool,
      asset: assetAddress,
      amountWei: value.toString(),
      commitment,
      secret,
      nullifier,
      bound: true,
      scheme: HASH_SCHEME,
      from: address,
      createdAt: now,
      status: "open",
      source: "local",
    };

    // ERC20: approve first if needed. USDT on Ethereum refuses to change one
    // non-zero allowance into another, so a stale one (a deposit that never went
    // through) is set to 0 first. Only a non-zero allowance actually read is
    // reset; one that could not be read is read again instead of guessed.
    const steps = selectedToken ? approvalsBeforeDeposit(selectedToken, await allowanceNow, value) : [];
    if (steps === null) {
      setFormError(`Could not read your ${symbol} approval for the vault. Try again in a moment.`);
      return null;
    }
    return { note, commitment, steps };
  }

  function sendApprove(token: `0x${string}`, value: bigint) {
    if (!network.pool) return;
    txLog.writing("approve");
    writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      // Exactly this deposit, never an open-ended allowance: a standing
      // approval would let any key on this account move more than it meant to.
      args: [network.pool, value],
      gas: gasFor(network.chainId, APPROVE_GAS_LIMIT),
      chainId: network.chainId,
    });
  }

  // Clear in-memory pending on wallet reject / failed write
  useEffect(() => {
    if (!writeError) return;
    // The deposit's note goes only when the wallet surely never sent it (lib/walletErrors).
    // A timeout or a lost reply can come after the wallet already sent it: then the note
    // stays saved and settles once the chain shows it (lib/claimSweep).
    if (pendingKind === "shield" && pendingNote) {
      if (surelyNotSent(writeError)) dropUnsentNote(pendingNote.id);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the wallet answered with an error after the deposit may have gone out: say the note is kept
      else setFormError(DEPOSIT_MAYBE_SENT);
    }
    if (pendingKind === "shield" || pendingKind === "approve") {
      setPendingNote(null);
      setPendingKind(null);
      setApproved(false);
      pendingShieldArgs.current = null;
      depositProof.current = null;
      autoShieldAfterApprove.current = false;
      approvalsLeft.current = null;
      setClearingAllowance(false);
    }
  }, [writeError, pendingKind, pendingNote]);

  // The receipt wait gave up (a busy network). The deposit may still land: its
  // note is already saved and settles on its own, so stop the spinner and say so.
  useEffect(() => {
    // Only the deposit's own receipt: an approval's lost receipt is handled below.
    if (!receiptLost || !txLog.isDeposit(hash) || pendingKind !== "shield") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the receipt wait gave up on a busy network: stop waiting and say the deposit may still land
    setPendingNote(null);
    setPendingKind(null);
    setApproved(false);
    pendingShieldArgs.current = null;
    depositProof.current = null;
    setFormError(DEPOSIT_SLOW);
    // The wait also gives up when the deposit reverted (wagmi throws on a reverted
    // receipt). Read the receipt once more and say so then: only the message changes.
    if (hash) {
      void publicClientFor(network)
        .getTransactionReceipt({ hash })
        .then(
          (r) => {
            if (r.status === "reverted") setFormError((cur) => (cur === DEPOSIT_SLOW ? DEPOSIT_REVERTED : cur));
          },
          () => undefined
        );
    }
    const t = window.setTimeout(() => refreshNotes(), 15_000);
    return () => window.clearTimeout(t);
  }, [receiptLost, hash, pendingKind, refreshNotes, txLog, network]);

  // The wait for an approval's receipt gave up (a busy RPC). It may have landed
  // anyway: read the allowance and go on to the deposit when it covers it,
  // instead of leaving the button to ask for the same approval again.
  useEffect(() => {
    if (!receiptLost || !hash || pendingKind !== "approve") return;
    const pending = pendingShieldArgs.current;
    const more = approvalsLeft.current?.values.length ?? 0;
    let live = true;
    // the button waits ("Checking…") rather than offer the approval again meanwhile
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a receipt wait gave up: hold the button while the allowance is read
    setChecking(true);
    void refetchAllow().then((r) => {
      setChecking(false);
      if (!live) return;
      const carryOn =
        pending !== null &&
        depositAfterLostApproval({
          depositWanted: autoShieldAfterApprove.current,
          amount: pending.value,
          approvalsLeft: more,
          allowance: r.isSuccess ? (r.data as bigint) : undefined,
        });
      autoShieldAfterApprove.current = false;
      approvalsLeft.current = null;
      setClearingAllowance(false);
      setPendingKind(null);
      if (carryOn && pending) {
        // Drop the approval's hash and lost wait first: the deposit gets its own.
        reset();
        setApproved(true);
        void executeShield(pending.value, pending.note, pending.commitment);
        return;
      }
      pendingShieldArgs.current = null;
      depositProof.current = null;
      setPendingNote(null);
      setFormError("Your approval was sent, but the network is slow to confirm it. Check the link below, then try again.");
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executeShield reads this render's form; the effect runs once per lost receipt
  }, [receiptLost, hash, pendingKind, refetchAllow]);

  const maxLabel =
    walletBalance !== undefined
      ? selectedToken
        ? formatUnits(walletBalance, decimals)
        : formatEth(walletBalance, 6)
      : "0";

  const amtNum = Number(amount);
  // "1,25" or "-1" is refused out loud, never quietly turned into 125 or 1
  const amountProblem = amountTextError(amount, decimals);
  const usdHint =
    mark > 0 && Number.isFinite(amtNum) && amtNum > 0
      ? formatUsd(amtNum * mark)
      : null;

  const myShieldUsd =
    ethUsd != null && shieldedWei > BigInt(0)
      ? formatUsd((Number(shieldedWei) / 1e18) * ethUsd)
      : null;

  // The same order as the Vault overview (lib/vaultHub compareHoldings).
  const assetRows = useMemo(() => {
    const rows: { asset: string; label: string; amount: bigint; dollar: boolean; size: number }[] = [];
    byAsset.forEach((amount, asset) => {
      if (amount > BigInt(0)) {
        const t = tokens.find((x) => x.address.toLowerCase() === asset.toLowerCase());
        rows.push({
          asset,
          label: assetLabel(asset),
          amount,
          dollar: Boolean(t && isDollarStable(t)),
          size: Number(formatUnits(amount, assetDecimals(asset))),
        });
      }
    });
    return rows.sort((a, b) =>
      compareHoldings({ dollar: a.dollar, amount: a.size, symbol: a.label }, { dollar: b.dollar, amount: b.size, symbol: b.label })
    );
  }, [byAsset, tokens]);

  if (!deployed) {
    return (
      <div className="gl-card max-w-[620px] p-6 sm:p-8">
        <span className="inline-flex items-center rounded-full bg-warn-soft px-2.5 py-1 text-[12px] font-medium text-warn">
          Not set up
        </span>
        <p className="t-title mt-4 text-foreground">
          The private vault is not on this network yet
        </p>
        <p className="mt-2 max-w-[52ch] text-[14px] leading-relaxed text-mute">
          The vault address is missing for {network.label}. Pick another network
          from the menu, or check back soon.
        </p>
      </div>
    );
  }

  const busy = isPending || confirming;
  // The browser is building the proof that binds the deposit (hardened pools)
  // before the wallet prompt opens.
  const proving =
    pendingKind === "shield" && !isPending && !confirming && !formError;

  const hasActiveShield = openNotes.length > 0;
  const connectedOk = isConnected && onProduct;
  // Private stock trade only exists on Robinhood Chain testnet.
  const stocks = network.stocks;

  const maxDisplay =
    selectedToken && walletBalance !== undefined
      ? formatAssetAmount(walletBalance, selectedToken.address)
      : maxLabel;

  const logoIdFor = (asset: string): string | null => {
    if (isNativeAsset(asset)) return null;
    return (
      tokens.find((t) => t.address.toLowerCase() === asset.toLowerCase())?.id ??
      asset
    );
  };

  const balanceRows = hasActiveShield
    ? assetRows.map((r) => ({
        asset: r.asset,
        label: r.label,
        logoId: logoIdFor(r.asset),
        amount: isNativeAsset(r.asset)
          ? formatEth(r.amount)
          : formatAssetAmount(r.amount, r.asset),
        sub: isNativeAsset(r.asset) && myShieldUsd ? `≈ ${myShieldUsd}` : null,
      }))
    : [];

  // What stops this deposit before the wallet is asked, said on the button
  // itself; the checks on submit (validate) stay as they were.
  const working = busy || proving || checking;
  const typedValue = amount.trim() && !amountProblem ? parseAmount() : null;
  const liveLimit = typedValue !== null && typedValue > BigInt(0) ? limitProblem(typedValue) : null;
  const ctaStop: string | null = working
    ? null
    : walletBalance === BigInt(0)
      ? `No ${symbol} in this wallet`
      : !amount.trim() || (typedValue === null && !amountProblem) || (typedValue !== null && typedValue <= BigInt(0))
        ? "Enter an amount"
        : amountProblem
          ? "Enter a valid amount"
          : typedValue !== null && walletBalance !== undefined && typedValue > walletBalance
            ? `Not enough ${symbol}`
            : liveLimit
              ? limit && limit[1] === BigInt(0)
                ? `${symbol} deposits are closed`
                : "Over the deposit limit"
              : null;
  const faucet = network.testnet ? faucetFor(network.key) : null;
  // A long list reads worse than a short one: name the first two and say there are more.
  const sendable =
    tokens.length > 3
      ? `${tokens[0]?.symbol}, ${tokens[1]?.symbol} or another asset the vault takes`
      : tokens.map((t) => t.symbol).join(" or ");

  const ctaLabel = checking
    ? "Checking…"
    : isPending && pendingKind === "approve"
      ? clearingAllowance
        ? "Clear the old approval in your wallet…"
        : "Approve in your wallet…"
      : confirming && pendingKind === "approve"
        ? clearingAllowance
          ? "Clearing the old approval…"
          : "Approving…"
        : proving
          ? approved
            ? "Adding privately…"
            : "Preparing your private deposit…"
          : isPending && pendingKind === "shield"
            ? "Confirm in your wallet…"
            : confirming && pendingKind === "shield"
              ? "Adding privately…"
              : selectedToken &&
                  allowance !== undefined &&
                  parseAmount() !== null &&
                  (allowance as bigint) < (parseAmount() as bigint)
                ? `Approve and add ${symbol}`
                : `Add ${symbol} privately`;

  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form onSubmit={onSubmit} className="gl-card min-w-0 p-5 sm:p-7">
          <DevKeysBanner compact />

          <div className="min-w-0">
            <h2 className="t-title text-foreground">Add privately</h2>
            <p className="mt-1 text-[14px] leading-relaxed text-mute">
              Move money from your wallet into your private balance.
            </p>
          </div>

          <div className="mt-6">
            {/* from: your wallet */}
            <div className="gl-inputcard p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <label htmlFor="shield-amount" className="text-mute">
                  You add
                </label>
                <span className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  disabled={!isConnected || refreshing}
                  onClick={() => void refreshBalances()}
                  aria-label="Refresh balance"
                  title="Refresh balance"
                  className="-my-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-panel hover:text-foreground disabled:opacity-45"
                >
                  <span className={refreshing ? "animate-spin motion-reduce:animate-none" : ""}>
                    <RefreshIcon />
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!isConnected}
                  onClick={() => {
                    if (walletBalance === undefined) return;
                    if (selectedToken) {
                      // On Tempo gas is paid in the stablecoin itself, so Max
                      // leaves a little of the token for the approve and deposit
                      // gas, the same reason the native branch keeps an ETH buffer.
                      // Without it, the approve's gas drops the balance below Max
                      // and the deposit reverts. Other chains pay gas in ETH, so
                      // a token deposit keeps its whole balance.
                      const leaveForGas =
                        network.family === "tempo"
                          ? BigInt(2) * BigInt(10) ** BigInt(Math.max(0, decimals - 2)) // ~0.02 of the token
                          : BigInt(0);
                      const v =
                        walletBalance > leaveForGas ? walletBalance - leaveForGas : BigInt(0);
                      setAmount(v === BigInt(0) ? "0" : formatUnits(v, decimals).slice(0, 18));
                    } else {
                      const leave = 50_000_000_000_000n;
                      const v =
                        walletBalance > leave ? walletBalance - leave : BigInt(0);
                      setAmount(v === BigInt(0) ? "0" : formatEther(v).slice(0, 12));
                    }
                  }}
                  className="tnum -my-2 inline-flex min-h-10 min-w-0 items-center gap-1.5 text-mute transition-colors hover:text-foreground disabled:opacity-45"
                >
                  <span className="truncate">
                    In wallet {isConnected ? maxDisplay : "0"} {symbol}
                  </span>
                  <span className="font-medium text-foreground">Max</span>
                </button>
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <input
                  id="shield-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="tnum min-w-0 flex-1 bg-transparent text-[40px] font-light leading-[1.15] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint sm:text-[46px]"
                  aria-label="Amount to add"
                />
                <Select
                  variant="pill"
                  align="end"
                  className="shrink-0"
                  label="Asset to add"
                  value={assetChoice}
                  // the deposit under way is for the asset it started with
                  disabled={working || pendingKind !== null}
                  onChange={(v) => {
                    setPickedOn(network.chainId);
                    setAssetChoice(v);
                    setAmount("");
                  }}
                  options={[
                    ...(nativeOk
                      ? [{ value: "eth", label: "ETH", description: "Ether", icon: <AssetMark id={null} symbol="ETH" size={30} /> }]
                      : []),
                    ...tokens.map((t) => ({
                      value: t.id,
                      label: t.symbol,
                      description: t.name,
                      icon: <AssetMark id={t.id} symbol={t.symbol} size={30} />,
                    })),
                  ]}
                />
              </div>
              <p
                className={`tnum mt-1 min-h-5 text-[13px] ${amountProblem ? "text-danger" : liveLimit ? "text-warn" : "text-mute"}`}
                role={amountProblem || liveLimit ? "alert" : undefined}
              >
                {amountProblem ?? liveLimit ?? (usdHint ? `≈ ${usdHint}` : " ")}
              </p>
            </div>

            <div
              aria-hidden
              className="relative z-10 mx-auto -my-3 grid h-9 w-9 place-items-center rounded-full border-4 border-panel bg-sealed-soft text-sealed"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14m0 0l-5-5m5 5l5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            {/* to: private balance */}
            <div className="rounded-[16px] bg-surface p-[16px] sm:p-5">
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span className="text-mute">Into your private balance</span>
                <span className="inline-flex items-center gap-1.5 font-medium text-sealed">
                  <span className="h-1.5 w-1.5 rounded-full bg-sealed" aria-hidden />
                  Only you
                </span>
              </div>
              <p className="tnum mt-3 truncate text-[28px] font-light leading-none tracking-[-0.02em] text-foreground">
                {amtNum > 0 ? amount : "0"}{" "}
                <span className="text-[15px] tracking-normal text-mute">{symbol}</span>
              </p>
            </div>
          </div>

          <dl className="mt-5 divide-y divide-line text-[14px]">
            <div className="flex h-11 items-center justify-between gap-3">
              <dt className="text-mute">Fee</dt>
              <dd className="text-foreground">No fee</dd>
            </div>
            <div className="flex h-11 items-center justify-between gap-3">
              <dt className="text-mute">Network</dt>
              {/* Once a mainnet sits next to the testnets, say which side this deposit lands on. */}
              <dd className="text-foreground">
                {MAINNET_ENABLED ? `${network.label} ${network.testnet ? "testnet" : "mainnet"}` : network.label}
              </dd>
            </div>
            {limitsOn && limitPer !== null && limitPer > BigInt(0) && (
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">Deposit limit</dt>
                <dd className="tnum text-foreground">{limitText(limitPer)} per deposit</dd>
              </div>
            )}
          </dl>

          <div className="mt-5">
            {!connectedOk ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-surface px-4 py-3">
                <p className="text-[14px] text-mute">
                  {!isConnected
                    ? "Connect a wallet to add money."
                    : `Switch to ${network.label} to add money.`}
                </p>
                <WalletMenu />
              </div>
            ) : screenBlocked ? (
              <p role="status" className="rounded-[16px] bg-surface px-4 py-3.5 text-center text-[14px] text-mute">
                {SCREEN_BLOCKED_MESSAGE}
              </p>
            ) : (
              <button
                type="submit"
                disabled={working || ctaStop !== null}
                className="btn btn-ink btn-lg btn-block"
              >
                {working && <Spinner />}
                {ctaStop ?? ctaLabel}
              </button>
            )}
            {/* Nothing the vault takes is in this wallet: say where it comes from. */}
            {connectedOk && !screenBlocked && walletEmpty && !working && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[16px] bg-surface px-4 py-3">
                <p className="min-w-0 text-[13.5px] leading-relaxed text-soft">
                  {faucet
                    ? "Nothing to add yet. Get testnet funds first."
                    : bridgeVisible(network)
                      ? `Nothing to add yet. Send ${sendable} to this wallet, or bring money over from another chain.`
                      : `Nothing to add yet. Send ${sendable} to this wallet first.`}
                </p>
                {faucet &&
                  (network.key === "tempo" ? (
                    <TempoFaucetButton className="btn btn-ghost h-10 shrink-0" />
                  ) : (
                    <a
                      href={faucet.url}
                      target={faucet.url.startsWith("http") ? "_blank" : undefined}
                      rel={faucet.url.startsWith("http") ? "noreferrer" : undefined}
                      className="btn btn-ghost h-10 shrink-0"
                    >
                      Get testnet funds
                    </a>
                  ))}
              </div>
            )}
          </div>

          {(formError || writeError) && (
            <p
              role="alert"
              className="mt-4 break-words rounded-xl bg-danger-soft px-4 py-3 text-[13.5px] leading-relaxed text-danger"
            >
              {formError ||
                (writeError?.message.includes("OverDepositLimit")
                  ? "This deposit is over the vault's deposit limit. Try a smaller amount."
                  : walletErrorForPeople(writeError))}
            </p>
          )}
          {hash && !isSuccess && (
            <p className="mt-4 flex items-center justify-center gap-2 text-[13.5px] text-mute">
              Submitted.
              <a
                href={network.explorerTx(hash)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                View transaction
              </a>
            </p>
          )}

          <p className="mt-5 text-center text-[12.5px] leading-relaxed text-mute">
            Your public wallet balance goes down. Only you can see what is in your
            private balance.
          </p>
        </form>

        <aside className="space-y-4">
          <PrivateBalanceCard
            rows={balanceRows}
            syncing={syncing}
            actions={
              balanceRows.length > 0 ? (
                <>
                  <Link href={`/app/vault${vaultActionSearch("pay", "")}`} className="btn btn-ghost btn-sm h-10">
                    Pay privately
                  </Link>
                  <Link href={`/app/vault${vaultActionSearch("cashout", "")}`} className="btn btn-ghost btn-sm h-10">
                    Cash out
                  </Link>
                </>
              ) : null
            }
          />

          {bridgeVisible(network) && (!demo || process.env.NEXT_PUBLIC_BRIDGE_PREVIEW === "1") && (
            <BridgeInCard
              recipient={address ?? undefined}
              startOpen={searchParams.get("bridge") === "open"}
              onArrived={(arrived) => {
                // By address on mainnet (Tempo lists Relay's USDC as USDC.e), by symbol in a testnet preview.
                const dest = BRIDGE_DESTINATIONS[network.family]?.token;
                const landed = dest
                  ? (tokens.find((t) => t.address.toLowerCase() === dest.address.toLowerCase()) ??
                    tokens.find((t) => t.symbol === dest.symbol))
                  : undefined;
                if (landed) {
                  setPickedOn(network.chainId);
                  setAssetChoice(landed.id as AssetChoice);
                }
                setAmount(arrived);
                // The new balance can take a few seconds to show on the RPC.
                void refreshBalances();
                for (const ms of [4_000, 10_000]) window.setTimeout(() => void refreshBalances(), ms);
              }}
              onPrivate={() => {
                refreshNotes();
                void refetchPool();
              }}
            />
          )}

          <div className="gl-card p-5">
            <p className="text-[13px] text-mute">What the explorer shows</p>
            <dl className="mt-3 divide-y divide-line text-[14px]">
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">Your deposit</dt>
                <dd className="tnum truncate text-foreground">
                  {amtNum > 0 ? `${amount} ${symbol}` : `The amount, in ${symbol}`}
                </dd>
              </div>
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">From</dt>
                <dd className="tnum truncate text-foreground">
                  {address ? shortAddress(address, 4) : "Your wallet"}
                </dd>
              </div>
              <IssuerPolicyRow chainId={network.chainId} asset={assetAddress} flow="deposit" />
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">Your private balance</dt>
                <dd className="text-foreground/60">
                  <SealDots n={6} />
                </dd>
              </div>
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">Who you pay next</dt>
                <dd className="text-foreground/60">
                  <SealDots n={6} />
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
              Adding money is a deposit like any other. What you hold and who you
              pay after that stays private.
            </p>
          </div>
        </aside>
      </div>

      <SuccessModal
        open={showSuccess && Boolean(hash)}
        title={successTitle}
        body={
          <>
            {successBody}
            {/* Private trade is not live yet, so a recording never points at it. */}
            {successTitle === "Added privately" && stocks && !demo && (
              <p className="mt-2">
                For a private stock trade, add ETH, then open{" "}
                <a
                  href="/app/trade?market=tsla&path=sealed"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Trade, Private trade
                </a>
                .
              </p>
            )}
          </>
        }
        primaryHref={hash ? network.explorerTx(hash) : undefined}
        primaryLabel="View on explorer"
        secondaryLabel="Done"
        onClose={() => {
          setShowSuccess(false);
          setAmount("");
        }}
      />
    </>
  );
}

type BalanceRow = {
  asset: string;
  label: string;
  logoId: string | null;
  amount: string;
  sub: string | null;
};

/** The private balance, only visible to its owner. Carries the sealed glow. */
function PrivateBalanceCard({
  rows,
  syncing,
  actions,
}: {
  rows: BalanceRow[];
  syncing: boolean;
  actions?: React.ReactNode;
}) {
  const [hidden, setHidden] = useState(false);
  return (
    <div className="gl-card relative overflow-hidden p-5">
      <SealedField tone="soft" />
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-mute">Private balance</p>
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-sealed">
              <span className="h-1.5 w-1.5 rounded-full bg-sealed" aria-hidden />
              {syncing ? "Syncing" : "Only you"}
            </span>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => setHidden((v) => !v)}
                aria-pressed={hidden}
                aria-label={hidden ? "Show amounts" : "Hide amounts"}
                className="-mr-2 grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
              >
                <EyeIcon off={hidden} />
              </button>
            )}
          </div>
        </div>

        {rows.length > 0 ? (
          <ul className="mt-4 space-y-3.5">
            {rows.map((r) => (
              <li key={r.asset} className="flex items-center gap-3">
                <AssetMark id={r.logoId} symbol={r.label} size={32} />
                <div className="min-w-0">
                  <p className="tnum truncate text-[26px] font-light leading-none tracking-[-0.02em] text-foreground">
                    {hidden ? (
                      <SealDots n={6} className="text-foreground/60" />
                    ) : (
                      r.amount
                    )}{" "}
                    <span className="text-[14px] tracking-normal text-mute">{r.label}</span>
                  </p>
                  {r.sub && !hidden && (
                    <p className="tnum mt-1 text-[12.5px] text-mute">{r.sub}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4">
            <p className="tnum text-[34px] font-light leading-none tracking-[-0.02em] text-foreground">
              0
            </p>
            <p className="mt-2 max-w-[30ch] text-[13px] leading-relaxed text-mute">
              Money you add shows up here. Nobody else can see it.
            </p>
          </div>
        )}

        {actions && <div className="mt-5 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

function AssetMark({
  id,
  symbol,
  size = 28,
}: {
  id: string | null;
  symbol: string;
  size?: number;
}) {
  if (!id) return <EthMark size={size} />;
  return <TokenLogo id={id} symbol={symbol} size={size} />;
}

/** ETH's real mark, the same one Portfolio and every token list show. */
function EthMark({ size = 28 }: { size?: number }) {
  return <TokenLogo id="eth" symbol="ETH" size={size} />;
}

function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.6" />
      {off && <path d="M4 20L20 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80 motion-reduce:animate-none"
      aria-hidden
    />
  );
}
