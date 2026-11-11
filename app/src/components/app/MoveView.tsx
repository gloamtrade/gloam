"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { formatUnits, isAddress, type Address, type Hex } from "viem";
import { useConfig, useReadContract, useWriteContract } from "wagmi";
import { writeContract as writeContractNow } from "wagmi/actions";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";
import { amountTextError } from "@/lib/amountText";
import { AmountProblem } from "./AmountProblem";
import { shortAddress } from "@/lib/chain";
import { useAppAccount, useAppTxReceipt, useAppWriteContract, useDemo } from "@/lib/demo";
import { knownTokens, nativeTokenFor, shieldTokensFor } from "@/lib/tokens";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { usePoolDeposited } from "@/hooks/usePoolDeposited";
import { useShieldTree } from "@/hooks/useShieldTree";
import { getRhPublicClient, publicClientFor } from "@/lib/rhClient";
import { HASH_SCHEME, dropUnsentNote, gasFor, noteNetworkProblem, SHIELD_GAS_LIMIT, TRANSFER_GAS_LIMIT, type LocalNote, assetDecimals, assetLabel, formatAssetAmount, formatAssetLabel, formatFeePercent, isNativeAsset, isShieldDeployed, loadLocalNotes, parseAssetAmount, saveLocalNote, shieldPoolAbi, updateLocalNote, withdrawFeeOf } from "@/lib/shield";
import {
  claimNoteId,
  isClaimedNote,
  isSecuredClaim,
  isUnsecuredClaim,
  secureClaim,
} from "@/lib/claimSweep";
import { secureFailureOf, secureFailureReason, secureNextStep } from "@/lib/secureRetry";
import { readDemo } from "@/lib/demoFlag";
import { syncShieldTree } from "@/lib/treeSync";
import { buildTransferWitness } from "@/lib/proverTransfer";
import { fieldToBytes32, proveTransferInBrowser } from "@/lib/proveClient";
import { proveCashOut } from "@/lib/cashOutProof";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";
import { screenWallets } from "@/lib/screeningClient";
import { cashOutTargetProblem } from "@/lib/cashOutTarget";
import { IssuerPolicyRow } from "./IssuerPolicyRow";
import { noteCommitmentPoseidon, noteNullifierPoseidon } from "@/lib/notePoseidon";
import { fieldToHex, hexToField } from "@/lib/poseidon";
import type { PoseidonMerklePath } from "@/lib/merklePoseidon";
import { randomNoteSeed, type SweepResult } from "@gloamtrade/sdk";

import {
  buildNotePackage,
  decodeNotePackage,
  encodeNotePackage,
  encodeNotePackageEncrypted,
  isEncryptedPackage,
  isPayToTagSealed,
  paymentCodeIn,
} from "@/lib/notePackage";
import {
  getOrCreateReceiveIdentity,
  isValidReceiveTag,
  encryptTicketForTag,
  rotateReceiveIdentity,
  type ReceiveIdentity,
} from "@/lib/receiveTag";
import {
  loadContacts,
  upsertContact,
  type GloamContact,
} from "@/lib/contacts";
import {
  fetchPaymentMemos,
  isPayMemoLive,
  MEMO_GAS_LIMIT,
  payMemoAddress,
  payMemoAbi,
  ticketToMemoBytes,
  type ScannedMemo,
} from "@/lib/payMemo";
import { useNetwork } from "./NetworkProvider";
import { getNetwork, isNetworkKey } from "@/lib/networks";
import {
  relayFor,
  relayMemo,
  relayPreferred,
  relayTransfer,
  relayUnshield,
  RelaySubmitError,
  setRelayPreferred,
  type RelayNetworkStatus,
} from "@/lib/relay/client";
import { gasHighMessage } from "@/lib/relay/gasCeiling";
import { RelayToggle } from "./RelayToggle";
import { RelayGasNotice } from "./RelayGasNotice";
import { PaymentRequestBanner, RequestPaymentCard } from "./PaymentRequest";
import { queuePartnerJobs, registerLinkSpend, settlePartnerTx, usePartnerName } from "@/lib/partnerLinkClient";
import {
  claimNetworkProblem,
  isWalletRequest,
  readPaymentRequest,
  requestParamsFrom,
  type PaymentRequest,
} from "@/lib/paymentRequest";
import { PAYMENT_NOTE_MAX, cleanPaymentNote } from "@/lib/paymentNote";
import { NoteGlyph, PaymentNoteLine } from "./PaymentNote";
import { SuccessModal } from "./SuccessModal";
import { PrivatePayShare } from "./PrivatePayShare";
import {
  markPrivatePaid,
  readFirstPaySuggestion,
  type FirstPaySuggestion,
} from "@/lib/firstPayment";
import { DevKeysBanner } from "./DevKeysBanner";
import { PaymentTicketShare } from "./PaymentTicketShare";
import { SentLinks } from "./SentLinks";
import { makeSentLink, paymentNullifier, type SentLink } from "@/lib/sentLinks";
import { removeSentLink, saveSentLink } from "@/lib/sentLinksStore";
import { surelyNotSent, walletErrorForPeople } from "@/lib/walletErrors";
import {
  cancelCashOut,
  dismissReturnedCashOut,
  feeMoved,
  reconcileCashOuts,
  releaseGoneCashOut,
  returnedCashOutNotes,
  scheduleNoteCashOut,
  scheduledCashOutNotes,
  type CashOutWindow,
} from "@/lib/cashOutLater";
import { freshPath, networkOfNote, roundDownToWhole, spendPlanFor, spendWaitMessage, splitForCashOut } from "@/lib/cashOutSplit";
import {
  findCashOutLink,
  linkMessage,
  piecesFee,
  planPieces,
  recentMoneyIn,
  seededRandom,
} from "@/lib/cashOutPlan";
import {
  cancelledPiece,
  keepPiece,
  moveLooseProofs,
  readPrivatePref,
  runPrivateCashOut,
  savePrivatePref,
  schedulePiece,
  unscheduledPieces,
  type PieceProgress,
} from "@/lib/cashOutPrivately";
import {
  CashOutLinkNote,
  HowChoice,
  PieceLeftover,
  PiecesCard,
  ScheduledCashOuts,
  SpreadOver,
  aboutTime,
} from "./PrivateCashOut";
import { cashOutPrivacyWarnings, cashOutSender, depositWallets, presetAmounts } from "@/lib/cashOutPrivacy";
import { CashOutAmountChips, CashOutPrivacyLine, CashOutWarnings } from "./CashOutPrivacy";
import { countLinkClaimed, countLinkCreated, countLinkOpened, countSendAfterClaim } from "@/lib/funnel";
import { codeFromHash } from "@/lib/claimLink";
import { dropClaimLink, keepClaimLink, keptClaimLink, onForgetClaim, onGoToClaim, setClaimWaiting } from "@/lib/claimLinkStore";
import { countPerson } from "@/lib/people";
import { WalletMenu } from "./WalletMenu";
import { AfterClaimNext } from "./AfterClaimNext";
import { ClaimSafetyLine } from "./ClaimSafetyLine";
import { canSwapAfterClaim, takeFirstClaim } from "@/lib/afterClaim";
import { TokenLogo } from "./TokenLogo";
import { AddTokenToWallet } from "./AddTokenToWallet";
import { CrossChainCashOutStatus, CrossChainPicker, CrossChainQuoteCard } from "./CrossChainCashOut";
import {
  cashOutNet,
  crossChainDestination,
  crossChainDestinations,
  crossChainProblem,
  relayOrderUrl,
  requestCrossChainQuote,
  requoteStillFine,
  type CrossChainQuote,
} from "@/lib/cashOutCrossChain";
import { checkSweep, sweepVerdict, type SweepCheck, type SweepReader } from "@/lib/sweepCheck";
import { EMBEDDED_CONNECTOR_ID, EMBEDDED_WALLETS } from "@/lib/embeddedWallet";
import { embeddedAvailability, onEmbeddedAvailability } from "@/lib/turnkeyBridge";
import { moveModeFromParam, searchWithMoveMode } from "@/lib/vaultNav";
import { cashOutHandoff, classifyPayRecipient, isWalletRecipient } from "@/lib/payRecipient";
import { useEnsAddress } from "@/hooks/useEnsAddress";

/** How securing a claim ended (lib/claimSweep), or "error" when it threw. */
type SweepStatus = SweepResult["status"] | "error";

type Mode = "send" | "cashout" | "receive";

/**
 * A payment code that can never be claimed: claimed already, carrying no value,
 * or not what the vault holds. The tab stops keeping it (lib/claimLinkStore), so
 * a dead code no longer fills the claim box again after a reload.
 */
class DeadCodeError extends Error {}
/** Direct (pay to sticky tag) vs open bearer ticket */
type PayStyle = "direct" | "bearer";

/**
 * Move = direct pay-to-tag + bearer tickets + cash out.
 * Never uses a public 0x as the private path.
 */
/** The older testnet pools carry no cash-out fee; every other network (Base Sepolia too) must report its fee first. */
const TESTNET_CHAIN_IDS = new Set<number>([46630, 42431]);

/** Relay failures after which the payment may still have gone out (a timeout, a lost reply). */
const RELAY_MAYBE_SENT = new Set(["maybe_sent", "rpc", "network", "error", "internal", "in_flight"]);

export function MoveView() {
  const shieldLive = isShieldDeployed();
  const poseidonMode = HASH_SCHEME === "poseidon";
  const { address, isConnected, chainId, connector } = useAppAccount();
  /** `to` is the Gloam wallet connected now (lib/sweepCheck sweepVerdict: its own sponsored deposits look like a sweep). */
  const ownGloamWallet = (to: string | null | undefined) =>
    Boolean(
      to &&
        address &&
        connector?.id === EMBEDDED_CONNECTOR_ID &&
        connector.type === "turnkey" &&
        to.toLowerCase() === address.toLowerCase()
    );
  const { network } = useNetwork();
  const onProduct = chainId === network.chainId;
  const { open, local: allLocal, refresh: refreshNotes } = useLocalShieldNotes(address);
  const wagmiConfig = useConfig();
  const {
    loading: treeLoading,
    error: treeError,
    matchesChain,
    pathForLeaf,
    leafIndexForCommitment,
    refresh: refreshTree,
  } = useShieldTree();

  // ?mode=receive|cashout opens a specific action (e.g. "Cash out" links).
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>(() => moveModeFromParam(searchParams.get("mode")));
  // Payment request links (lib/paymentRequest, mode=pay) open Send with the
  // recipient, amount and token filled in. Read once; the payer still sends.
  const [request, setRequest] = useState<PaymentRequest | null>(() =>
    typeof window === "undefined"
      ? null
      : readPaymentRequest(
          requestParamsFrom(window.location.search, window.location.hash),
          network.key
        )
  );
  // A partner's link code (p=): their name from their Gloam account, once the server says the code is live.
  const partnerName = usePartnerName(request?.partnerCode ?? null);
  // The first-payment nudge (FirstPaymentCard) opens Send with a small amount
  // in one stablecoin (?suggest=5&suggestAsset=0x…). A request link wins over
  // it. Read once; the URL is cleaned up below so a refresh starts blank.
  const [suggestion] = useState<FirstPaySuggestion | null>(() =>
    request ? null : readFirstPaySuggestion(searchParams, network.chainId)
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Cash out: how much ("" is the whole balance), when, and to which wallet.
  const [cashOutInput, setCashOutInput] = useState("");
  const [cashOutWhen, setCashOutWhen] = useState<"now" | CashOutWindow>("now");
  const [cashOutDest, setCashOutDest] = useState<"mine" | "other">("mine");
  const [otherTo, setOtherTo] = useState("");
  // The cash-out address's sweep check (lib/sweepCheck), keyed by network, address and token.
  const [sweepResults, setSweepResults] = useState<Record<string, SweepCheck>>({});
  const [sweepOkFor, setSweepOkFor] = useState<string | null>(null);
  const sweepRuns = useRef(new Map<string, Promise<SweepCheck>>());
  /** Where the last cash out went, for the "see it in your wallet" step after it lands. */
  const [cashedOut, setCashedOut] = useState<{ to: Address; asset: Address } | null>(null);
  // Cash out to another chain (lib/cashOutCrossChain): where it lands (null: this chain, as
  // always), the live price for it, and the order just sent, for its status.
  const [xDestId, setXDestId] = useState<string | null>(null);
  const [xQuote, setXQuote] = useState<CrossChainQuote | null>(null);
  const [xSent, setXSent] = useState<CrossChainQuote | null>(null);
  /** What was just scheduled: one cash out, or a private cash out's pieces (count, from `at` to `until`). */
  const [scheduledNotice, setScheduledNotice] = useState<{ at: number; label: string; count?: number; until?: number } | null>(null);
  // Cash out privately (lib/cashOutPrivately): a few pieces over time, the
  // default whenever it is offered, unless this browser chose all at once.
  const [privatePref, setPrivatePref] = useState(() => readPrivatePref().on);
  const [planWindow, setPlanWindow] = useState<CashOutWindow>(() => readPrivatePref().window);
  /** Picks the plan's sizes; "Other sizes" draws again. */
  const [planSeed, setPlanSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  /** Each piece to its own address (piece 1 goes to "To"; these are pieces 2 to 4). */
  const [perPiece, setPerPiece] = useState(false);
  const [pieceTo, setPieceTo] = useState<string[]>([]);
  /** The pieces' progress while a private cash out is being set up. */
  const [planRun, setPlanRun] = useState<PieceProgress[] | null>(null);
  /** The note a private cash out started from: the form stays on it while the run spends it. */
  const [runNote, setRunNote] = useState<LocalNote | null>(null);
  /** The piece being scheduled again from its notice. */
  const [leftoverBusy, setLeftoverBusy] = useState<string | null>(null);
  const [sendAmount, setSendAmount] = useState(
    () => request?.amount ?? suggestion?.amount ?? ""
  );
  // Private note that travels inside the payment (lib/paymentNote). A request's
  // note comes along by default; the payer can change or remove it.
  const [payNote, setPayNote] = useState(() => request?.note ?? "");
  const [noteOpen, setNoteOpen] = useState(() => Boolean(request?.note));
  /** The note the last payment carried, for the success message. */
  const [sentNote, setSentNote] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareBlob, setShareBlob] = useState<string | null>(null);
  /** The claim code the sender has copied, downloaded or shared, so the success dialog can let go. */
  const [savedCode, setSavedCode] = useState<string | null>(null);
  const [shareAmountLabel, setShareAmountLabel] = useState<string | null>(null);
  const [sendPassphrase, setSendPassphrase] = useState("");
  const [importText, setImportText] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importOk, setImportOk] = useState<{
    text: string;
    note?: string;
    /** A claim just secured: what it can do next (AfterClaimNext), full the first time in this browser. */
    next?: { id: string; full: boolean; amount: string; asset: Address };
    tone?: "warn" | "danger";
    /** A claim this says is not secured yet: the message changes once it is (secured with no one asking). */
    pending?: { id: string; label: string };
  } | null>(null);
  /** The claimed payment being secured right now (lib/claimSweep). */
  const [securingId, setSecuringId] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [successTitle, setSuccessTitle] = useState("Done");
  const [busy, setBusy] = useState(false);
  /** A cash out's checks (screening, the live fee) run before busy is set: one click at a time. */
  const cashOutGate = useRef(false);
  const [cashOutChecking, setCashOutChecking] = useState(false);
  /** Opening a claim code (PBKDF2, spent check, tree sync) before it is saved: one at a time. */
  const claimGate = useRef(false);
  const [claimOpening, setClaimOpening] = useState(false);
  /** The newest inbox scan: Check now waits for it, and an older one never ends its spinner. */
  const scanRun = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [claimPreview, setClaimPreview] = useState<{ text: string; note?: string } | null>(null);
  const [payStyle, setPayStyle] = useState<PayStyle>("direct");
  const [recipientTag, setRecipientTag] = useState(() => request?.to ?? "");
  // A 0x address or an ENS name in the To field is not paid with a note: Pay offers
  // Cash out to that wallet instead (lib/payRecipient). The name is looked up on Ethereum mainnet,
  // for the address it sets for this network (useEnsAddress).
  const payRecipient = useMemo(() => classifyPayRecipient(recipientTag), [recipientTag]);
  const ensLookup = useEnsAddress(
    payStyle === "direct" && payRecipient.kind === "ens" ? payRecipient.name : null,
    network.chainId
  );
  const payWalletTo: Address | null =
    payStyle !== "direct"
      ? null
      : payRecipient.kind === "address"
        ? payRecipient.address
        : payRecipient.kind === "ens" && ensLookup.status === "found"
          ? ensLookup.address
          : null;
  const payToWallet = payStyle === "direct" && (isWalletRecipient(payRecipient) || payRecipient.kind === "badAddress");
  const [myIdentity, setMyIdentity] = useState<ReceiveIdentity | null>(null);
  const [tagCopied, setTagCopied] = useState(false);
  const [shareLocked, setShareLocked] = useState(false);
  const [inbox, setInbox] = useState<
    { memo: ScannedMemo; label: string; ticket: string; note?: string }[]
  >([]);
  const [inboxStatus, setInboxStatus] = useState<string | null>(null);
  const [memoPosted, setMemoPosted] = useState(false);
  /** A claim code nobody else will get (no heads-up reached a Gloam address): the sender must keep it. */
  const mustSaveCode = Boolean(shareBlob) && !memoPosted;

  // leaving with an unsaved claim code loses the money in it
  useEffect(() => {
    if (!mustSaveCode || savedCode === shareBlob) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [mustSaveCode, savedCode, shareBlob]);
  // Setting up a private cash out: leaving now stops it after the piece in hand
  // (nothing is lost, but the rest is not scheduled), so ask first.
  const planRunning = planRun != null;
  useEffect(() => {
    if (!planRunning) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [planRunning]);
  const [contacts, setContacts] = useState<GloamContact[]>([]);
  /** Relay: submit proven actions from the Gloam relay so the wallet never shows. */
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [relayOn, setRelayOn] = useState(false);
  /** The relay status has loaded for this network; until then nothing is sent, so a quick click can't go out from the wallet. */
  const [relayChecked, setRelayChecked] = useState(false);
  /** The relay's status on this chain, for its gas ceiling (Ethereum): over it, relayed sends wait. */
  const [relayStatus, setRelayStatus] = useState<RelayNetworkStatus | null>(null);
  const gasHigh = Boolean(relayStatus?.gasHigh);
  const [relayHash, setRelayHash] = useState<Hex | undefined>(undefined);
  /** The last confirmed action was a private payment, so success offers the share post. */
  const [paidPrivately, setPaidPrivately] = useState(false);

  // Drop the nudge's suggestion from the URL once read (it is already in the
  // form), so a refresh or a tab switch does not fill it in again.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("suggest") && !url.searchParams.has("suggestAsset")) return;
    url.searchParams.delete("suggest");
    url.searchParams.delete("suggestAsset");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);

  const {
    writeContract,
    data: hash,
    isPending,
    error: writeError,
    reset,
  } = useAppWriteContract();
  // Securing a claim waits on its own transaction, apart from the flow above.
  const { writeContractAsync } = useWriteContract();

  const txHash = relayHash ?? hash;
  const { isLoading: confirming, isSuccess, isError: receiptLost } = useAppTxReceipt({
    hash: txHash,
    chainId: network.chainId,
  });

  // Claim links: /app/vault?tab=move&net=tempo#claim=<code>. The code lives in
  // the URL fragment (never sent to a server) and is cleared once read. It is
  // read the way /claim reads it (lib/claimLink), so a link cut mid-escape is
  // ignored instead of throwing, and read again when another claim link is
  // opened in this tab, which only changes the fragment. This tab keeps it
  // until it is claimed (lib/claimLinkStore), so a reload while the person
  // signs in brings it back (below).
  const { setNetworkKey, networkKey } = useNetwork();
  // Opened from a claim link (or brought back after a reload): go straight to the
  // claim, not the address above it. Its own effect, so the network switch a link
  // makes, which runs the effect below again, can't cancel it: it did for every
  // link on a network other than the saved one, so a phone landed far above the claim.
  const [claimScroll, setClaimScroll] = useState(0);
  // A claim link was read from the address bar on this visit: nothing kept is put back over it.
  const claimFromLink = useRef(false);
  useEffect(() => {
    if (!claimScroll) return;
    const t = window.setTimeout(() => {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("claim-payment")?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    }, 400);
    return () => window.clearTimeout(t);
  }, [claimScroll]);
  useEffect(() => {
    let t = 0;
    const openClaim = () => {
      const code = codeFromHash(window.location.hash);
      if (!code) return;
      const net = new URLSearchParams(window.location.search).get("net");
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        claimFromLink.current = true;
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
        if (isNetworkKey(net) && net !== networkKey) setNetworkKey(net);
        countLinkOpened(code, net);
        keepClaimLink(code, isNetworkKey(net) ? net : null);
        setMode("receive");
        setImportText(code);
        setClaimScroll((n) => n + 1);
      }, 0);
    };
    openClaim();
    window.addEventListener("hashchange", openClaim);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("hashchange", openClaim);
    };
  }, [networkKey, setNetworkKey]);

  // A claim link this tab opened and hasn't claimed yet, back after a reload
  // (lib/claimLinkStore): signing in with an email sends the person to their
  // mail app for the code, and a phone can reload the tab meanwhile. Once per
  // visit, only on Receive, and never over a link in the address bar or
  // something already in the box.
  const restoredClaim = useRef(false);
  const importTextNow = useRef(importText);
  useEffect(() => {
    importTextNow.current = importText;
  }, [importText]);
  useEffect(() => {
    if (restoredClaim.current) return;
    const t = window.setTimeout(() => {
      if (restoredClaim.current) return;
      restoredClaim.current = true;
      if (claimFromLink.current || codeFromHash(window.location.hash)) return;
      if (moveModeFromParam(new URLSearchParams(window.location.search).get("mode")) !== "receive") return;
      if (importTextNow.current.trim()) return;
      const kept = keptClaimLink();
      if (!kept) return;
      // it fills the box: only now move to its network
      if (kept.on && kept.on !== networkKey) setNetworkKey(kept.on);
      setImportText(kept.code);
      setClaimScroll((n) => n + 1);
    }, 0);
    return () => window.clearTimeout(t);
  }, [networkKey, setNetworkKey]);

  // Signed out or disconnected on purpose (WalletMenu, Settings): the claim box
  // empties with the tab's kept link, so the next person here never sees it.
  useEffect(
    () =>
      onForgetClaim(() => {
        setImportText("");
        setImportPassphrase("");
        setClaimPreview(null);
        setImportOk(null);
      }),
    []
  );

  // While a payment waits in the claim box, the new-wallet sheet (EmbeddedWalletFlow)
  // offers to go back to it instead of Add funds, and its button lands here.
  const claimInBox = mode === "receive" && importText.trim().length > 0;
  useEffect(() => {
    setClaimWaiting(claimInBox);
  }, [claimInBox]);
  useEffect(() => () => setClaimWaiting(false), []);
  useEffect(
    () =>
      onGoToClaim(() => {
        // after the sheet has closed and handed focus back
        window.setTimeout(() => {
          const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          document.getElementById("claim-payment")?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
          document.getElementById("claim-submit")?.focus({ preventScroll: true });
        }, 60);
      }),
    []
  );

  // A request link opened in a tab that already shows Pay only changes the
  // fragment, so pick it up here too.
  useEffect(() => {
    const onHash = () => {
      const r = readPaymentRequest(
        requestParamsFrom(window.location.search, window.location.hash),
        networkKey
      );
      if (!r) return;
      requestSwitched.current = false;
      setRequest(r);
      setMode("send");
      setSelectedId(null);
      setRecipientTag(r.to ?? "");
      // a request names who to pay: never turn it into a claim link the tab had chosen before
      if (r.to) {
        setPayStyle("direct");
        setSendPassphrase("");
      }
      setSendAmount(r.amount ?? "");
      setPayNote(r.note ?? "");
      setNoteOpen(Boolean(r.note));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [networkKey]);

  // Analytics: a request link was opened. Its shape only, never who, how much or the note.
  const trackedRequest = useRef<PaymentRequest | null>(null);
  useEffect(() => {
    if (!request || trackedRequest.current === request) return;
    trackedRequest.current = request;
    const chainId = getNetwork(request.network ?? networkKey).chainId;
    void import("@/lib/track").then(({ track }) => {
      track("payment_request_opened", {
        hasAmount: Boolean(request.amount),
        hasNote: Boolean(request.note),
        chainId,
      });
    });
  }, [request, networkKey]);

  // A request names its network: move there once so the right balance shows.
  // After that the banner offers the switch instead of forcing it again.
  const requestSwitched = useRef(false);
  useEffect(() => {
    const want = request?.network;
    if (!want || want === networkKey || requestSwitched.current) return;
    const t = window.setTimeout(() => {
      requestSwitched.current = true;
      setNetworkKey(want);
    }, 0);
    return () => window.clearTimeout(t);
  }, [request, networkKey, setNetworkKey]);

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- each network's relay is checked anew; the button waits until the answer comes back
    setRelayChecked(false);
    void relayFor(network.chainId).then((r) => {
      if (!live) return;
      const ok = Boolean(r?.enabled);
      setRelayStatus(r);
      setRelayAvailable(ok);
      setRelayOn(ok && relayPreferred());
      setRelayChecked(true);
    });
    return () => {
      live = false;
    };
  }, [network.chainId]);

  const handledHash = useRef<string | null>(null);
  const pendingAction = useRef<"send" | "cashout" | "memo" | null>(null);
  /** The change note and Sent link saved just before a send went out. */
  const keptBeforeSend = useRef<{ changeId: string | null; linkId: string | null } | null>(null);
  /** Drops what was kept ahead of a send that surely never went out. */
  const forgetUnsent = () => {
    const kept = keptBeforeSend.current;
    if (!kept) return;
    if (kept.changeId) dropUnsentNote(kept.changeId);
    if (kept.linkId) void removeSentLink(kept.linkId).catch(() => undefined);
    keptBeforeSend.current = null;
  };
  const spentNoteId = useRef<string | null>(null);
  /** Change only, never store the payment note on the sender */
  const pendingChange = useRef<LocalNote | null>(null);
  const pendingShare = useRef<{ blob: string; amountLabel: string } | null>(
    null
  );
  /**
   * The payment or cash out in flight came from a partner's link: its spend was
   * registered under the link's code before it was sent (by the app, or by the
   * relay with the code it was handed), and it is asked to be counted once it
   * lands (lib/partnerLinkClient). Never waited on.
   */
  const partnerSend = useRef<{ chainId: number } | null>(null);
  /** Analytics for the payment in flight: sent on a request, carrying a note. */
  const payTrack = useRef<{ chainId: number; request: boolean; note: boolean } | null>(null);
  /** The payment's code for Sent links, saved once the payment lands. */
  const pendingLink = useRef<SentLink | null>(null);
  /** The saved Sent links record, dropped again if their heads-up posts. */
  const savedLinkId = useRef<string | null>(null);
  /** The payment in flight is a claim link (counted once it lands, lib/funnel). */
  const pendingClaimLink = useRef(false);
  /**
   * After direct pay: post encrypted ticket on-chain (GloamPayMemo). `relay` is
   * the choice made at send time, so turning Hide my wallet off mid-send can't
   * post the heads-up from the wallet that the payment was hidden from.
   */
  const pendingMemo = useRef<{
    paymentCommitment: Hex;
    ticket: string;
    /** The payment went out through the relay: its heads-up must too, never from the wallet. */
    relay: boolean;
    /** The relay was up at send time: a wallet payment's heads-up goes through it first, with no second prompt. */
    relayFirst: boolean;
  } | null>(null);

  // Confirm path: transfer → optional on-chain memo → share UI
  useEffect(() => {
    if (!isSuccess || !txHash) return;
    if (handledHash.current === txHash) return;
    handledHash.current = txHash;

    void (async () => {
      // Memo post finished
      if (pendingAction.current === "memo") {
        pendingAction.current = null;
        pendingMemo.current = null;
        // They got the heads-up, so the payment shows up on their side: no Sent links row needed.
        if (savedLinkId.current) {
          void removeSentLink(savedLinkId.current).catch(() => undefined);
          savedLinkId.current = null;
        }
        setMemoPosted(true);
        if (pendingShare.current) {
          setShareBlob(pendingShare.current.blob);
          setShareAmountLabel(pendingShare.current.amountLabel);
          pendingShare.current = null;
        }
        setSuccessTitle("Paid privately");
        void import("@/lib/track").then(({ track }) => {
          track("private_pay_success");
        });
        void import("@/lib/onboarding").then(({ markOnboardingStep }) => {
          markOnboardingStep("move");
          markOnboardingStep("shield");
        });
        setShowSuccess(true);
        setBusy(false);
        setStatus(null);
        return;
      }

      if (pendingAction.current === "send") {
        // The payment itself has landed (a heads-up, if any, is a second
        // step). Retires the first-payment nudge on this device.
        markPrivatePaid(network.chainId);
        setPaidPrivately(true);
        // claim-link counts: a link made, or a claimer's first own payment (lib/funnel)
        if (pendingClaimLink.current) countLinkCreated();
        pendingClaimLink.current = false;
        countSendAfterClaim();
        // someone using Gloam (lib/people): sent later with the day's other actions, never with the payment
        countPerson("send", address, network.testnet);
        if (payTrack.current?.request) countPerson("request", address, network.testnet);
        // The payment landed: keep its code under Sent links, encrypted in this
        // browser, so a lost code is not lost money (removed again if a heads-up posts).
        const link = pendingLink.current;
        pendingLink.current = null;
        pendingClaimLink.current = false;
        if (link) {
          savedLinkId.current = link.id;
          void saveSentLink(link).catch(() => undefined);
        }
      }

      if (pendingAction.current === "cashout") countPerson("cashout", address, network.testnet);

      // From a partner's link: the server checks this transaction on chain and counts it to the link it was registered under.
      if ((pendingAction.current === "send" || pendingAction.current === "cashout") && partnerSend.current) {
        const ps = partnerSend.current;
        partnerSend.current = null;
        settlePartnerTx({ chainId: ps.chainId, txHash });
      }

      if (pendingAction.current === "send" && payTrack.current) {
        const t = payTrack.current;
        payTrack.current = null;
        void import("@/lib/track").then(({ track }) => {
          if (t.request) track("payment_request_paid", { chainId: t.chainId });
          if (t.note) track("private_note_added", { chainId: t.chainId });
        });
      }

      if (spentNoteId.current) {
        updateLocalNote(spentNoteId.current, { status: "recovered" });
        spentNoteId.current = null;
      }

      // Resolve leaf index from chain tree (safe if others inserted mid-flight)
      let changeLeaf: number | undefined;
      if (pendingChange.current) {
        try {
          // the change note's own network, even if the page switched while the send landed
          const changeNet = networkOfNote(pendingChange.current);
          const tree = changeNet ? await syncShieldTree(publicClientFor(changeNet), changeNet) : null;
          const idx = tree?.indexByCommitment.get(
            pendingChange.current.commitment.toLowerCase()
          );
          if (idx != null) changeLeaf = idx;
        } catch {
          /* leafIndex optional, path resolved on next sync */
        }
      }

      if (pendingChange.current) {
        saveLocalNote({
          ...pendingChange.current,
          txHash,
          leafIndex: changeLeaf,
        });
        pendingChange.current = null;
      }

      refreshNotes();
      void refreshTree();

      // Direct pay + memo board live → second tx posts ciphertext on-chain
      if (
        pendingMemo.current &&
        isPayMemoLive() &&
        payMemoAddress() &&
        pendingAction.current === "send"
      ) {
        const m = pendingMemo.current;
        setStatus("Letting them know privately…");
        pendingAction.current = "memo";
        handledHash.current = null;
        if (m.relay || m.relayFirst) {
          try {
            const h = await relayMemo({
              chainId: network.chainId,
              paymentCommitment: m.paymentCommitment,
              memo: ticketToMemoBytes(m.ticket),
            });
            setRelayHash(h);
            return;
          } catch (e) {
            // A payment sent from the wallet already shows the wallet, so its heads-up can still go
            // from there: the one wallet prompt below. A hidden payment's never does.
            if (!m.relay) {
              writeContract({
                address: payMemoAddress()!,
                abi: payMemoAbi,
                functionName: "postMemo",
                args: [m.paymentCommitment, ticketToMemoBytes(m.ticket)],
                gas: gasFor(network.chainId, MEMO_GAS_LIMIT),
                chainId: network.chainId,
              });
              return;
            }
            // Payment already landed; only the heads-up failed. Fall back to the link.
            pendingAction.current = null;
            pendingMemo.current = null;
            if (pendingShare.current) {
              setShareBlob(pendingShare.current.blob);
              setShareAmountLabel(pendingShare.current.amountLabel);
              pendingShare.current = null;
            }
            setError(
              `Payment sent. We could not send their heads-up (${e instanceof Error ? e.message : "relay error"}), so share the claim code below instead.`
            );
            setShowSuccess(true);
            setBusy(false);
            setStatus(null);
          }
          return;
        }
        writeContract({
          address: payMemoAddress()!,
          abi: payMemoAbi,
          functionName: "postMemo",
          args: [m.paymentCommitment, ticketToMemoBytes(m.ticket)],
          gas: gasFor(network.chainId, MEMO_GAS_LIMIT),
          chainId: network.chainId,
        });
        return;
      }

      pendingMemo.current = null;
      if (pendingShare.current) {
        setShareBlob(pendingShare.current.blob);
        setShareAmountLabel(pendingShare.current.amountLabel);
        pendingShare.current = null;
      }

      setShowSuccess(true);
      setBusy(false);
      setStatus(null);
    })();
  }, [isSuccess, txHash, network.chainId, network.testnet, address, refreshNotes, refreshTree, writeContract]);

  // Wallet reject / tx fail: drop ephemeral payment secrets
  useEffect(() => {
    if (!writeError) return;
    // Drop what was kept ahead of the send only when the wallet surely never
    // sent it. A timeout or lost reply may come after it did: then the change
    // and the code stay saved and settle once the chain shows them.
    if (pendingAction.current === "send" && surelyNotSent(writeError)) forgetUnsent();
    keptBeforeSend.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the wallet refused or the write failed: stop the spinner and clear what was kept for that send
    setBusy(false);
    setStatus(null);
    // Only their heads-up failed: the payment already landed, so its code
    // stays on screen (it is under Sent links too) instead of being dropped.
    const landed = pendingAction.current === "memo" ? pendingShare.current : null;
    pendingChange.current = null;
    pendingShare.current = null;
    pendingMemo.current = null;
    pendingLink.current = null;
    pendingClaimLink.current = false;
    spentNoteId.current = null;
    payTrack.current = null;
    // the wallet refused or the write failed: a memo's failure comes after the payment was reported
    partnerSend.current = null;
    setShareBlob(landed?.blob ?? null);
    if (landed) {
      setShareAmountLabel(landed.amountLabel);
      setError(
        "Payment sent, but their heads-up was not. Share the claim code below with them instead. It is also kept under Sent links."
      );
    }
  }, [writeError]);

  // The receipt wait gave up (a busy network). The payment may still land: what
  // it creates is already saved and settles on its own, so stop and say so.
  useEffect(() => {
    if (!receiptLost || !txHash || !busy) return;
    const action = pendingAction.current;
    keptBeforeSend.current = null;
    // it may still land: the report waits for the chain, and counts nothing if it never does
    const ps = partnerSend.current;
    partnerSend.current = null;
    if (ps && (action === "send" || action === "cashout")) settlePartnerTx({ chainId: ps.chainId, txHash });
    pendingChange.current = null;
    pendingShare.current = null;
    pendingMemo.current = null;
    pendingLink.current = null;
    pendingClaimLink.current = false;
    spentNoteId.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the receipt wait gave up on a busy network: stop the spinner and say the payment may still land
    setBusy(false);
    setStatus(null);
    setError(
      action === "cashout"
        ? "Your cash out was sent, but the network is slow to confirm it. Your balance updates once it lands. Check it with the link below."
        : "Your payment was sent, but the network is slow to confirm it. Your change and the payment's code are saved in this browser and show up once it lands."
    );
    const t = window.setTimeout(() => refreshNotes(), 15_000);
    return () => window.clearTimeout(t);
  }, [receiptLost, txHash, busy, refreshNotes]);

  // Resolve leafIndex from tree when import left it missing
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

  // Claimed payments the payer could still spend back (lib/claimSweep).
  const unsecured = useMemo(() => open.filter(isUnsecuredClaim), [open]);
  // A claim the message says is not secured yet, secured since with no one asking
  // (lib/claimSweep secureClaimsInBackground): the message says so instead.
  const importShown = useMemo(() => {
    const p = importOk?.pending;
    if (!importOk || !p || !allLocal.some((n) => n.id === p.id && n.secured)) return importOk;
    return {
      text: `Secured ${p.label}. Only you can spend it now, and the person who sent it can no longer take it back.`,
      note: importOk.note,
      tone: undefined,
    };
  }, [importOk, allLocal]);

  // For a request, default to a balance in the requested token: the smallest
  // one that covers the amount, else the largest. A manual pick still wins.
  const requestNoteId = useMemo(() => {
    const asset = request?.asset;
    if (!asset) return null;
    const same = notes.filter(
      (n) => n.asset.toLowerCase() === asset.address.toLowerCase()
    );
    if (!same.length) return null;
    const need = request.amount ? parseAssetAmount(request.amount, asset.address) : null;
    const bySize = [...same].sort((a, b) =>
      BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : 1
    );
    const covering = need ? bySize.find((n) => BigInt(n.amountWei) >= need) : null;
    return (covering ?? bySize[bySize.length - 1]).id;
  }, [request, notes]);

  // The nudge's suggestion picks a balance the same way: the smallest one in
  // its token that covers the amount, else the largest.
  const suggestNoteId = useMemo(() => {
    if (!suggestion) return null;
    const same = notes.filter(
      (n) => n.asset.toLowerCase() === suggestion.asset.toLowerCase()
    );
    if (!same.length) return null;
    const need = parseAssetAmount(suggestion.amount, suggestion.asset);
    const bySize = [...same].sort((a, b) =>
      BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : 1
    );
    const covering = need ? bySize.find((n) => BigInt(n.amountWei) >= need) : null;
    return (covering ?? bySize[bySize.length - 1]).id;
  }, [suggestion, notes]);

  const selected =
    runNote ??
    notes.find((n) => n.id === selectedId) ??
    notes.find((n) => n.id === requestNoteId) ??
    notes.find((n) => n.id === suggestNoteId) ??
    notes[0] ??
    null;

  const maxEth = selected
    ? formatUnits(BigInt(selected.amountWei), assetDecimals(selected.asset))
    : "0";

  const cashOutAsset = selected?.asset as `0x${string}` | undefined;
  const { deposited: poolForCashOut } = usePoolDeposited(
    mode === "cashout" ? cashOutAsset : null
  );
  // The whole balance unless a smaller amount is typed; a smaller one is set
  // aside privately first (lib/cashOutSplit), then cashed out.
  const noteWei = selected ? BigInt(selected.amountWei) : 0n;
  const typedWei = cashOutInput.trim() && selected ? parseAssetAmount(cashOutInput.trim(), selected.asset) : null;
  const cashOutAmountInvalid =
    cashOutInput.trim() !== "" && (typedWei === null || typedWei <= 0n || typedWei > noteWei);
  const cashOutAmount = typedWei !== null && !cashOutAmountInvalid ? typedWei : noteWei;
  const cashOutPartial = !cashOutAmountInvalid && cashOutAmount < noteWei;
  // Where it goes: the connected wallet, or another address (a fresh one is best).
  const otherToClean = otherTo.trim();
  const cashOutTo: Address | null =
    cashOutDest === "mine" ? ((address as Address | undefined) ?? null) : isAddress(otherToClean) ? (otherToClean as Address) : null;
  // Every wallet's notes in this browser on this chain and vault (allLocal holds only the
  // signed-in wallet's), for the privacy kit's depositing-wallet check (lib/cashOutPrivacy).
  // Read again whenever this wallet's notes change. Deposits read from the chain are left
  // out: they are only ever the signed-in wallet's, which its own warning already names.
  const browserNotes = useMemo(
    () => (allLocal.length ? loadLocalNotes(null, network) : []),
    [allLocal, network]
  );
  const depositWalletSet = useMemo(() => depositWallets(browserNotes, network), [browserNotes, network]);
  // A cash out that lines up with money that came in (lib/cashOutPlan): a calm note under the amount.
  const cashOutLink =
    selected != null && !cashOutAmountInvalid ? findCashOutLink(cashOutAmount, allLocal, selected.asset) : null;
  const scheduledRows = useMemo(
    () => scheduledCashOutNotes(allLocal).sort((a, b) => a.cashOut!.at - b.cashOut!.at),
    [allLocal]
  );
  const returnedRows = useMemo(() => returnedCashOutNotes(allLocal), [allLocal]);
  /** Pieces of a private cash out split off but not scheduled (a relay that was down, a closed tab). */
  const leftoverRows = useMemo(() => unscheduledPieces(allLocal).filter((n) => !n.cashOutPlan?.topUp), [allLocal]);
  // Cash-out fee (mainnet pools). The proof still spends the whole note; the
  // pool keeps the fee and pays the rest. Older pools fail this read: no fee.
  const demoMode = useDemo();
  const { data: feeBpsRead, refetch: refetchFee } = useReadContract({
    address: network.pool ?? undefined,
    abi: shieldPoolAbi,
    functionName: "withdrawFeeBps",
    chainId: network.chainId,
    query: { enabled: Boolean(network.pool) && mode === "cashout" && !demoMode, refetchInterval: 60_000 },
  });
  const liveFeeBps = typeof feeBpsRead === "number" ? feeBpsRead : null;
  const cashOutFeeBps = liveFeeBps ?? 0;
  // On mainnet the fee must be known before anyone confirms: a failed read must
  // not show the full amount when the pool will keep a fee. Testnet pools have no fee.
  const cashOutFeeUnknown =
    mode === "cashout" && !demoMode && !TESTNET_CHAIN_IDS.has(network.chainId) && typeof feeBpsRead !== "number";
  const cashOutFee = withdrawFeeOf(cashOutAmount, cashOutFeeBps);
  const cashOutInventoryShort =
    mode === "cashout" &&
    selected != null &&
    poolForCashOut != null &&
    poolForCashOut < cashOutAmount;

  // Cash out to another chain (lib/cashOutCrossChain): offered for the stablecoins Relay
  // takes from this chain. Now and all at once only; picking it turns off later and pieces.
  const xDestinations = mode === "cashout" && selected && !demoMode ? crossChainDestinations(network.chainId, selected.asset) : [];
  const xDestination = xDestinations.find((d) => d.id === xDestId) ?? null;
  const xActive = xDestination != null;
  /** What reaches Relay's deposit address: the cash out less the vault's fee. */
  const xNet = cashOutNet(cashOutAmount, cashOutFeeBps);
  /** The price, only while it still fits what is on screen: the amount after the fee, the chain, the wallets. */
  const xPrice =
    xQuote &&
    xDestination &&
    xQuote.destination.id === xDestination.id &&
    xQuote.amountIn === xNet.toString() &&
    address != null &&
    xQuote.refundTo.toLowerCase() === address.toLowerCase() &&
    (xDestination.kind === "svm" || (cashOutTo != null && xQuote.recipient.toLowerCase() === cashOutTo.toLowerCase()))
      ? xQuote
      : null;
  /** The person's address on the other chain: the To address for an EVM chain, typed in for Solana (in the quote). */
  const xRecipient = xDestination?.kind === "svm" ? (xPrice?.recipient ?? null) : cashOutTo;

  // Cash out privately (lib/cashOutPrivately): 2 to 4 round pieces, none
  // matching money that came in, each through cash out later. Offered for a
  // stablecoin above 5 with the relay up, since the relay sends every step.
  const selectedAsset = selected?.asset;
  const cashOutStable =
    selectedAsset != null &&
    shieldTokensFor(network.chainId).some(
      (t) => t.kind === "stablecoin" && t.address.toLowerCase() === selectedAsset.toLowerCase()
    );
  const moneyIn = selectedAsset ? recentMoneyIn(allLocal, selectedAsset) : [];
  // Seeded, so the same amount shows the same pieces on every render until "Other sizes".
  const plan =
    selectedAsset && cashOutStable && !cashOutAmountInvalid && cashOutAmount > 0n
      ? planPieces({
          amount: cashOutAmount,
          decimals: assetDecimals(selectedAsset),
          avoid: moneyIn.map((m) => m.amountWei),
          random: seededRandom(planSeed),
        })
      : null;
  const planOffered = plan != null && relayAvailable && poseidonMode && !xActive;
  const planActive = planOffered && privatePref;
  // While a run is setting pieces up, the card shows that run (the note it
  // started from is spent part way, so the selection moves on underneath).
  const planPieceList = planRun ? planRun.map((p) => p.amount) : (plan?.pieces ?? []);
  const planTotal = planPieceList.reduce((t, p) => t + p, 0n);
  /** The fee for what will go out: each piece pays the pool's own fee on its amount. */
  const outFee = planActive ? piecesFee(planPieceList, cashOutFeeBps) : cashOutFee;
  const avoiding =
    moneyIn.length === 0
      ? null
      : moneyIn.every((m) => m.kind === "deposit")
        ? "money you added"
        : moneyIn.every((m) => m.kind === "received")
          ? "money you were paid"
          : "money you added or were paid";
  const tiedToYou = (a: string) =>
    depositWalletSet.has(a.toLowerCase()) || (address != null && a.toLowerCase() === address.toLowerCase());
  // The privacy kit (lib/cashOutPrivacy): round amounts under the amount field, and quiet
  // warnings when the address or the amount ties this cash out back to you. In pieces
  // the whole amount never goes out as one transfer, so only the address counts there.
  const cashOutPresets = selected
    ? presetAmounts({ chainId: network.chainId, asset: selected.asset, spendable: noteWei })
    : [];
  const privacyWarnings = selected
    ? cashOutPrivacyWarnings({
        to: xActive ? xRecipient : cashOutTo,
        connected: address,
        amountWei: planActive || cashOutAmountInvalid ? null : cashOutAmount,
        asset: selected.asset,
        chainId: network.chainId,
        pool: network.pool,
        notes: browserNotes,
      })
    : [];
  const addressWarnings = privacyWarnings.filter((w) => w.aboutAddress);
  const amountWarnings = privacyWarnings.filter((w) => !w.aboutAddress);
  /** "Cash out somewhere else": the address field, empty and focused. */
  function cashOutElsewhere() {
    setCashOutDest("other");
    setOtherTo("");
    window.setTimeout(() => document.getElementById("cashout-other")?.focus(), 0);
  }
  /** Where each piece goes: all to "To", or piece 2 on to their own addresses. */
  const pieceTargets: (Address | null)[] = planPieceList.map((_, i) => {
    if (i === 0 || !perPiece) return cashOutTo;
    const v = (pieceTo[i - 1] ?? "").trim();
    return isAddress(v) ? (v as Address) : null;
  });
  const piecesReady = pieceTargets.length > 0 && pieceTargets.every(Boolean);
  const distinctTargets = new Set(pieceTargets.filter(Boolean).map((a) => a!.toLowerCase())).size;
  // Honest about what splitting can't hide: pieces that meet at one address add up there.
  const whereLine = !planActive
    ? null
    : pieceTargets.some((a) => a && tiedToYou(a))
      ? "Splitting can't hide a wallet that is tied to you: pieces that land there can still be linked back."
      : !perPiece
        ? `All ${planPieceList.length} pieces land at the same address, so anyone looking at it can add them up. A busy address, like an exchange deposit address, hides that better.`
        : !piecesReady
          ? "Paste an address for each piece. Fresh ones that never touched Gloam are best."
          : distinctTargets < planPieceList.length
            ? "Some pieces land at the same address, so they can be added up there."
            : "Each piece lands at its own address, which makes them harder to add up.";

  // Does money sent to this address get swept out? Read in the background; a
  // failed read is no warning, never a blocked cash out.
  const sweepKey =
    mode === "cashout" && cashOutTo && selected && !demoMode && !xActive
      ? `${network.chainId}:${cashOutTo.toLowerCase()}:${selected.asset.toLowerCase()}`
      : null;
  function runSweepCheck(key: string, to: Address, asset: Address, chainId: number): Promise<SweepCheck> {
    const known = sweepRuns.current.get(key);
    if (known) return known;
    const run = checkSweep(getRhPublicClient() as unknown as SweepReader, chainId, to, isNativeAsset(asset) ? null : asset).then(
      (result) => {
        setSweepResults((m) => ({ ...m, [key]: result }));
        return result;
      }
    );
    sweepRuns.current.set(key, run);
    return run;
  }
  useEffect(() => {
    if (!sweepKey || !cashOutTo || !selected) return;
    const t = window.setTimeout(() => void runSweepCheck(sweepKey, cashOutTo, selected.asset as Address, network.chainId), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepKey]);
  const sweepNow = sweepKey ? (sweepResults[sweepKey] ?? null) : null;
  const sweepSays = sweepVerdict(sweepNow, { ownGloamWallet: ownGloamWallet(cashOutTo) });
  const sweepHold = sweepSays === "swept" && sweepOkFor !== sweepKey;

  /** What Round it starts from and gives: the amount (or the whole balance) down to whole units. */
  const roundFrom = cashOutAmountInvalid ? noteWei : cashOutAmount;
  const roundsTo = selected ? roundDownToWhole(roundFrom, assetDecimals(selected.asset)) : 0n;

  /** Round it: the amount down to whole units, so odd cents stay in the private balance. */
  function roundCashOut() {
    if (!selected) return;
    const decimals = assetDecimals(selected.asset);
    const whole = roundDownToWhole(cashOutAmountInvalid ? noteWei : cashOutAmount, decimals);
    if (whole > 0n) setCashOutInput(formatUnits(whole, decimals));
  }

  /** Privately or all at once, remembered in this browser for next time. */
  function choosePrivately(on: boolean) {
    setPrivatePref(on);
    savePrivatePref({ on });
  }

  /** The cash out button: its checks run before busy is set, so a second click waits for the first. */
  async function startCashOut() {
    if (cashOutGate.current) return;
    cashOutGate.current = true;
    setCashOutChecking(true);
    try {
      await (planActive ? onPrivateCashOut() : onCashOut());
    } finally {
      cashOutGate.current = false;
      setCashOutChecking(false);
    }
  }

  async function onCashOut() {
    if (!selected || !address || !network.pool || !poseidonMode) return;
    // never prove or send a balance of another chain (several vaults share one address)
    const wrongNetwork = noteNetworkProblem(selected, network);
    if (wrongNetwork) {
      setError(wrongNetwork);
      return;
    }
    setError(null);
    setScheduledNotice(null);
    // To another chain: always now, and the vault pays Relay's one-time address from the price shown.
    const xShown = xActive ? xPrice : null;
    const xDest = xActive ? xDestination : null;
    const later = cashOutWhen !== "now" && !xDest;
    const amount = cashOutAmount;
    let to: Address | null = xShown ? (xShown.depositAddress as Address) : cashOutTo;

    if (cashOutAmountInvalid || amount <= 0n || amount > noteWei) {
      setError("Enter an amount up to this balance.");
      return;
    }
    if (xDest && (!xShown || !address)) {
      setError("Wait for the price from Relay, then try again.");
      return;
    }
    if (!to) {
      setError("Paste the address to cash out to.");
      return;
    }
    const moving = spendWaitMessage(selected);
    if (moving) {
      setError(moving);
      return;
    }
    if (later && !relayAvailable) {
      setError("Cashing out later needs the Gloam relay, which is off right now. Cash out now instead.");
      return;
    }
    // Over the gas ceiling the relay sends nothing now; a cash out for later still schedules and waits.
    if (!later && relayOn && gasHigh) {
      setError(gasHighMessage(network.label));
      return;
    }
    if (poolForCashOut != null && poolForCashOut < amount) {
      setError(
        `Not enough in the shared vault to cash out right now (${formatAssetLabel(poolForCashOut, selected.asset)} available, ${formatAssetLabel(amount, selected.asset)} needed). It opens up once more of this asset is added.`
      );
      return;
    }
    // Relay's address passes the same checks, but not the sweep check: it is swept on purpose.
    if (!(await checkCashOutTargets([to], selected.asset, to, { sweep: !xDest }))) return;
    const feeNote = await feeMoved(network, liveFeeBps);
    if (feeNote) {
      setError(feeNote);
      void refetchFee();
      return;
    }

    setBusy(true);
    setPaidPrivately(false);
    // the last payment's claim code (kept under Sent links) is not this cash out's success
    setShareBlob(null);
    setMemoPosted(false);
    reset();
    setRelayHash(undefined);
    handledHash.current = null;
    pendingAction.current = "cashout";
    pendingChange.current = null;
    setCashedOut(null);
    setXSent(null);

    let splitDone = false;
    try {
      // A part of the balance: set it aside in its own private note first. A balance that
      // backed a proof of funds moves whole to a fresh note first, so the proof can't point
      // at this cash out, and so does one whose last swap reverted (lib/cashOutSplit spendPlanFor).
      let target: LocalNote = selected;
      let path: PoseidonMerklePath | null;
      const plan = spendPlanFor(selected, amount);
      if (plan !== "direct") {
        const startPath = await pathForLeaf(selected.leafIndex!);
        if (!startPath) throw new Error("Could not read your private balance. Refresh and try again.");
        target = await splitForCashOut({
          note: selected,
          amount,
          path: startPath as PoseidonMerklePath,
          owner: address as Address,
          relayOn,
          allowWhole: plan === "move",
          sendWithWallet: (t) =>
            writeContractNow(wagmiConfig, {
              address: network.pool!,
              abi: shieldPoolAbi,
              functionName: "transfer",
              args: [t.proof, t.root, t.nullifier, [t.commitments[0], t.commitments[1]]],
              gas: gasFor(network.chainId, TRANSFER_GAS_LIMIT),
              chainId: network.chainId as never,
            }),
          onStatus: setStatus,
        });
        splitDone = true;
        refreshNotes();
        path = (await freshPath(target.commitment, network))?.path ?? null;
      } else {
        path = (await pathForLeaf(selected.leafIndex!)) as PoseidonMerklePath | null;
      }
      if (!path) throw new Error("Could not read your private balance. Refresh and try again.");
      // To another chain: a fresh price for exactly what the vault will pay, right before the
      // proof fixes the address and the amount. A worse price stops here and is shown instead.
      let xOrder: CrossChainQuote | null = null;
      if (xDest && xShown && address) {
        setStatus("Getting a fresh price from Relay…");
        const gross = BigInt(target.amountWei);
        const fresh = await requestCrossChainQuote({
          network: network.key,
          asset: target.asset,
          amount: cashOutNet(gross, cashOutFeeBps),
          destination: xDest.id,
          recipient: xShown.recipient,
          refundTo: address,
        });
        if (!requoteStillFine(xShown, fresh)) {
          setXQuote(fresh);
          throw new Error("The price moved. Check the new amount, then cash out again.");
        }
        const binding = { chainId: network.chainId, asset: target.asset, gross, feeBps: cashOutFeeBps, destinationId: xDest.id, recipient: xShown.recipient, refundTo: address };
        const problem = crossChainProblem(fresh, { ...binding, to: fresh.depositAddress });
        if (problem) throw new Error(problem);
        if (!(await checkCashOutTargets([fresh.depositAddress as Address], target.asset as Address, null, { sweep: false }))) {
          throw new Error("Relay's address didn't pass the checks. Nothing was sent.");
        }
        xOrder = fresh;
        to = fresh.depositAddress as Address;
        setXQuote(fresh);
      }
      spentNoteId.current = target.id;
      setStatus("Proving privately, this takes 10 to 30 seconds…");
      const call = await proveCashOut(target, to, path, network.chainId);
      // the proof binds where the money goes and how much: it must be exactly Relay's order
      if (xOrder && address) {
        const problem = crossChainProblem(xOrder, {
          chainId: call.chainId,
          asset: call.asset,
          gross: call.amount,
          feeBps: cashOutFeeBps,
          to: call.to,
          destinationId: xOrder.destination.id,
          recipient: xOrder.recipient,
          refundTo: address,
        });
        if (problem) throw new Error(problem);
      }
      // From a partner's link to the request's own wallet: bound to the link's code before anything is sent.
      const fromLink = requestPartner(to);
      if (later) {
        setStatus("Scheduling with the Gloam relay…");
        // Out of the balance while it waits; the chain settles it once it goes out. The
        // address shown is the one the relay holds, not the one asked for (and when this
        // money already has a cash out waiting, the note shows that one).
        // the relay registers it under the code as it schedules it, and counts it as it sends it
        const job = await scheduleNoteCashOut(target, call, cashOutWhen as CashOutWindow, cashOutFeeBps, fromLink ? { partnerCode: fromLink.code } : {});
        spentNoteId.current = null;
        countPerson("cashout", address, network.testnet);
        if (fromLink) queuePartnerJobs(network.chainId, [job.id]);
        setScheduledNotice({ at: job.sendAfter, label: formatAssetLabel(target.amountWei, target.asset) });
        setCashOutInput("");
        refreshNotes();
        setBusy(false);
        setStatus(null);
        void import("@/lib/track").then(({ track }) => {
          track("unshield_scheduled", { window: cashOutWhen });
        });
        return;
      }
      partnerSend.current = fromLink ? { chainId: network.chainId } : null;
      if (relayOn) {
        setStatus("Sending through the Gloam relay…");
        // the relay registers it under the code as it sends it
        const h = await relayUnshield({ ...call, ...(fromLink ? { partnerCode: fromLink.code } : {}) });
        if (xOrder) setXSent(xOrder);
        else setCashedOut({ to, asset: target.asset as Address });
        setRelayHash(h);
        setSuccessTitle("Cashed out");
        setCashOutInput("");
        return;
      }
      // from the wallet: registered under the code now, before the wallet is asked, bound to this cash out's proof
      if (fromLink) registerLinkSpend({ code: fromLink.code, chainId: network.chainId, nullifier: call.nullifier, proof: call.proof });
      setStatus("Confirm the cash out in your wallet…");
      writeContract({
        address: network.pool,
        abi: shieldPoolAbi,
        functionName: "unshield",
        args: [call.proof, call.root, call.nullifier, call.asset, call.to, call.amount],
        gas: gasFor(network.chainId, SHIELD_GAS_LIMIT),
        chainId: network.chainId,
      });
      if (xOrder) setXSent(xOrder);
      else setCashedOut({ to, asset: target.asset as Address });
      setSuccessTitle("Cashed out");
      setCashOutInput("");
      void import("@/lib/track").then(({ track }) => {
        track(xOrder ? "unshield_xchain" : "unshield_success");
      });
      // cash out is intentional exit, no onboarding mark
    } catch (e) {
      const msg = walletErrorForPeople(e, "The cash out didn't go through. Try again.");
      // The first step landed: the amount is its own note in the balance now.
      setError(splitDone ? `${msg} The amount is set aside in your private balance, so you can cash it out from there.` : msg);
      setBusy(false);
      setStatus(null);
      refreshNotes();
    }
  }

  /**
   * The partner a cash out counts to: one from a partner's request link (p=) to a
   * wallet, paying the very wallet the link asked for. null otherwise.
   */
  function requestPartner(to: Address | null | undefined): { code: string; chainId: number } | null {
    const code = request?.partnerCode;
    if (!code || !isWalletRequest(request) || handedOffRequest.current !== request || !handedOffTo.current || !to) return null;
    return to.toLowerCase() === handedOffTo.current.toLowerCase() ? { code, chainId: network.chainId } : null;
  }

  /**
   * The checks every cash out passes before anything is proven, for each
   * address it pays: never the vault, the memo board, a token contract, a swap
   * router or the zero address, the sweep check, and screening. A swept
   * `quiet` address (the one under To) stops without a message, since its
   * warning says why and how to go ahead; any other swept address is refused.
   */
  async function checkCashOutTargets(
    targets: Address[],
    asset: Address,
    quiet: Address | null,
    opts: { sweep?: boolean } = {}
  ): Promise<boolean> {
    const unique = targets.filter((t, i) => targets.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i);
    // Never to the vault, the memo board, a token or a swap router: the money would be stuck there.
    for (const t of unique) {
      const problem = cashOutTargetProblem(t, network);
      if (problem) {
        setError(problem);
        return false;
      }
    }
    // Money sent here has been swept out within seconds before: only on purpose.
    // A check still running gets a few seconds; one that fails is no warning.
    if (!demoMode && opts.sweep !== false) {
      for (const t of unique) {
        const key = `${network.chainId}:${t.toLowerCase()}:${asset.toLowerCase()}`;
        if (sweepOkFor === key) continue;
        const result = await Promise.race([
          runSweepCheck(key, t, asset, network.chainId),
          new Promise<null>((r) => window.setTimeout(() => r(null), 4_000)),
        ]);
        // the person's own connected Gloam wallet gets a note under To, not a hold
        if (sweepVerdict(result, { ownGloamWallet: ownGloamWallet(t) }) !== "swept") continue;
        if (quiet && t.toLowerCase() === quiet.toLowerCase()) return false;
        setError(
          `Money sent to ${shortAddress(t, 4)} has been moved out automatically within seconds before, by another account. Use another address for that piece.`
        );
        return false;
      }
    }
    // The wallets it pays, relay or not (on Tempo, also checked against the
    // asset's TIP-403 issuer policy).
    const screen = await screenWallets(unique, { chainId: network.chainId, asset, flow: "cashout" });
    if (!screen.allowed) {
      setError(screen.message ?? SCREEN_BLOCKED_MESSAGE);
      return false;
    }
    return true;
  }

  /**
   * Cash out privately: the pieces, one at a time, each split off, proven and
   * scheduled (lib/cashOutPrivately). Stops at the first problem with every
   * piece either waiting to go out or in the private balance.
   */
  async function onPrivateCashOut() {
    if (!selected || !address || !network.pool || !poseidonMode || !plan) return;
    // never prove or send a balance of another chain (several vaults share one address)
    const wrongNetwork = noteNetworkProblem(selected, network);
    if (wrongNetwork) {
      setError(wrongNetwork);
      return;
    }
    setError(null);
    setScheduledNotice(null);
    const amount = cashOutAmount;
    const pieces = plan.pieces;
    if (cashOutAmountInvalid || amount <= 0n || amount > noteWei) {
      setError("Enter an amount up to this balance.");
      return;
    }
    if (!piecesReady) {
      setError(perPiece ? "Paste an address for each piece." : "Paste the address to cash out to.");
      return;
    }
    if (!relayAvailable) {
      setError("Cashing out privately needs the Gloam relay, which is off right now. Send it all now instead.");
      return;
    }
    if (gasHigh) {
      setError(gasHighMessage(network.label));
      return;
    }
    if (poolForCashOut != null && poolForCashOut < amount) {
      setError(
        `Not enough in the shared vault to cash out right now (${formatAssetLabel(poolForCashOut, selected.asset)} available, ${formatAssetLabel(amount, selected.asset)} needed). It opens up once more of this asset is added.`
      );
      return;
    }
    const targets = pieceTargets as Address[];
    if (!(await checkCashOutTargets(targets, selected.asset, cashOutTo))) return;
    const feeNote = await feeMoved(network, liveFeeBps);
    if (feeNote) {
      setError(feeNote);
      void refetchFee();
      return;
    }

    const note = selected;
    setBusy(true);
    setPaidPrivately(false);
    setShareBlob(null);
    setMemoPosted(false);
    reset();
    setRelayHash(undefined);
    handledHash.current = null;
    pendingAction.current = "cashout";
    pendingChange.current = null;
    setCashedOut(null);
    setPlanRun(pieces.map((p, i) => ({ amount: p, to: targets[i]!, state: "waiting" })));
    setRunNote(note);
    // From a partner's link: the pieces that pay the request's own wallet carry its code to the relay as they are scheduled.
    const fromLink = requestPartner(cashOutTo);
    const toRequest = (a: Address) => Boolean(fromLink && cashOutTo && a.toLowerCase() === cashOutTo.toLowerCase());
    try {
      const r = await runPrivateCashOut({
        note,
        pieces,
        to: targets,
        window: planWindow,
        owner: address as Address,
        feeBps: cashOutFeeBps,
        onStatus: setStatus,
        onPiece: (i, patch) => setPlanRun((rows) => rows && rows.map((row, j) => (j === i ? { ...row, ...patch } : row))),
        ...(fromLink
          ? { deps: { schedule: (n, c, when, feeBps) => scheduleNoteCashOut(n, c, when, feeBps, toRequest(c.to) ? { partnerCode: fromLink.code } : {}) } }
          : {}),
      });
      if (fromLink) queuePartnerJobs(network.chainId, r.jobs.filter((j) => toRequest(j.to)).map((j) => j.id));
      if (r.jobs.length) {
        // Jobs come back in piece order: the first ones are what was scheduled.
        const times = r.jobs.map((j) => j.sendAfter);
        const out = pieces.slice(0, r.jobs.length).reduce((t, p) => t + p, 0n);
        setScheduledNotice({
          at: Math.min(...times),
          until: Math.max(...times),
          count: r.jobs.length,
          label: formatAssetLabel(out, note.asset),
        });
      }
      if (r.stoppedAt === null) {
        setCashOutInput("");
        setPieceTo([]);
        setPerPiece(false);
        setPlanSeed((v) => v + 7919);
      } else {
        const k = r.jobs.length;
        const done =
          k === 0
            ? "Nothing was scheduled."
            : `${k} of ${pieces.length} pieces ${k === 1 ? "is" : "are"} scheduled and ${k === 1 ? "goes" : "go"} out as planned.`;
        setError(
          r.maybeSent
            ? `${done} Setting aside the next piece may have gone out. Your money is safe in the vault and shows again once it lands.`
            : `${done} ${r.error ?? ""} The rest is safe in your private balance.`.replace(/\s+/g, " ")
        );
      }
      if (r.jobs.length > 0) countPerson("cashout", address, network.testnet);
      void import("@/lib/track").then(({ track }) => {
        track("unshield_private", {
          window: planWindow,
          pieceCount: pieces.length,
          scheduledCount: r.jobs.length,
          done: r.stoppedAt === null,
        });
      });
    } catch (e) {
      // Refused before anything moved.
      setError(walletErrorForPeople(e, "The cash out didn't go through. Try again."));
    } finally {
      setPlanRun(null);
      setRunNote(null);
      setBusy(false);
      setStatus(null);
      refreshNotes();
    }
  }

  /** A piece that did not get scheduled, scheduled now as it was planned: the same address and window. */
  async function scheduleLeftover(n: LocalNote) {
    const tag = n.cashOutPlan;
    if (!tag || !address) return;
    const wrongNetwork = noteNetworkProblem(n, network);
    if (wrongNetwork) {
      setError(wrongNetwork);
      return;
    }
    setError(null);
    setScheduledNotice(null);
    if (!relayAvailable) {
      setError("Scheduling needs the Gloam relay, which is off right now. Try again shortly.");
      return;
    }
    if (!(await checkCashOutTargets([tag.to], n.asset, null))) return;
    setLeftoverBusy(n.id);
    setBusy(true);
    setStatus("Proving privately, this takes 10 to 30 seconds…");
    try {
      const job = await schedulePiece(n, {}, liveFeeBps ?? undefined);
      setScheduledNotice({ at: job.sendAfter, label: formatAssetLabel(n.amountWei, n.asset) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not schedule this piece.");
    } finally {
      setLeftoverBusy(null);
      setBusy(false);
      setStatus(null);
      refreshNotes();
    }
  }

  async function cancelScheduled(note: LocalNote) {
    if (!note.cashOut) return;
    setError(null);
    setScheduledNotice(null);
    const result = await cancelCashOut(note.cashOut.job, note);
    if (result === "cancelled") {
      // Back in the balance as plain money: a cancelled piece is not one still to schedule.
      await cancelledPiece(note.id);
    } else if (result === "over") {
      // It already ended without going out: back in the balance once the chain agrees.
      await reconcileCashOuts().catch(() => false);
    } else if (result === "going") {
      updateLocalNote(note.id, { cashOut: { ...note.cashOut, state: "sent" } });
      setError("It is already going out, so it can't be cancelled. It shows as cashed out once it lands.");
    } else if (result === "gone") {
      if (await releaseGoneCashOut(note).catch(() => false)) keepPiece(note.id);
      else {
        setError("The relay no longer holds this cash out, and the network could not confirm it is unspent. Refresh in a moment.");
      }
    } else {
      setError("The relay could not be reached. Try Cancel again in a moment.");
    }
    refreshNotes();
    // its proof is still good until the note is spent: the note moves now, not at the next sync
    void moveLooseProofs()
      .catch(() => {})
      .finally(refreshNotes);
  }

  async function onPrivateSend() {
    // Whatever an earlier send kept is that send's, landed or not: a failure here must not drop it.
    keptBeforeSend.current = null;
    if (!selected || !address || !network.pool || !poseidonMode) return;
    // never prove or send a balance of another chain (several vaults share one address)
    const wrongNetwork = noteNetworkProblem(selected, network);
    if (wrongNetwork) {
      setError(wrongNetwork);
      return;
    }
    setError(null);
    // Over the gas ceiling the relay sends nothing: say so before proving.
    if (relayOn && gasHigh) {
      setError(gasHighMessage(network.label));
      return;
    }
    setShareBlob(null);
    setBusy(true);
    setPaidPrivately(false);
    reset();
    setRelayHash(undefined);
    handledHash.current = null;
    pendingAction.current = "send";
    spentNoteId.current = selected.id;
    pendingLink.current = null;
    pendingClaimLink.current = false;
    savedLinkId.current = null;

    try {
      const amountPay = parseAssetAmount(sendAmount, selected.asset);
      if (amountPay === null || amountPay <= 0n) {
        throw new Error("Enter a valid amount to send.");
      }
      if (amountPay > BigInt(selected.amountWei)) {
        throw new Error("That is more than this balance holds.");
      }
      // a mistyped Gloam address is caught before anything is proven or sent
      if (payStyle === "direct" && !isValidReceiveTag(recipientTag)) {
        throw new Error("That Gloam address is incomplete or mistyped. Copy it again from their Receive page.");
      }

      const path = await pathForLeaf(selected.leafIndex!);
      if (!path) throw new Error("Could not read your private balance. Refresh and try again.");

      setStatus("Proving your payment privately…");
      // The payee's secret is made from a 16-byte seed, so the claim link can be short (lib/claimLink).
      const w = await buildTransferWitness({
        secretHex: selected.secret,
        amountIn: BigInt(selected.amountWei),
        amountPay,
        asset: selected.asset,
        path: path as PoseidonMerklePath,
        paySeed: randomNoteSeed().seed,
      });
      if (w.blocker) throw new Error(w.blocker);

      // From a partner's link, to the request's own Gloam address: bound to the link's code before
      // anything is sent. Through the relay, the code goes with the send. From the wallet, it is
      // registered now, before proving, bound to this payment's new note commitment, which only
      // this send has.
      const linkCode =
        request?.partnerCode && request.toKind === "gloam" && payStyle === "direct" && recipientTag.trim() === request.to ? request.partnerCode : null;
      partnerSend.current = linkCode ? { chainId: network.chainId } : null;
      if (linkCode && !relayOn) {
        registerLinkSpend({
          code: linkCode,
          chainId: network.chainId,
          nullifier: fieldToBytes32(w.publicInputs.nullifier),
          bind: fieldToBytes32(w.publicInputs.newCommitment0),
        });
      }

      const { proofBytes } = await proveTransferInBrowser(w.circomInput);

      // Change stays with sender only. Payment secret goes solely into share package.
      if (BigInt(w.changeNote.amountWei) > 0n) {
        pendingChange.current = {
          id: `chg-${Date.now()}`,
          chainId: network.chainId,
          pool: network.pool,
          asset: selected.asset,
          amountWei: w.changeNote.amountWei,
          commitment: w.changeNote.commitment,
          secret: w.changeNote.secret,
          nullifier: w.changeNote.nullifier,
          bound: true,
          scheme: "poseidon",
          from: address,
          createdAt: Date.now(),
          status: "open",
          source: "local",
        };
      } else {
        pendingChange.current = null;
      }

      // Share package for recipient (shown only after on-chain success).
      // The note rides inside it, so it is sealed or locked with the payment.
      const pack = buildNotePackage({
        pool: network.pool,
        asset: w.paymentNote.asset,
        amountWei: w.paymentNote.amountWei,
        secret: w.paymentNote.secret,
        commitment: w.paymentNote.commitment,
        note: payNote,
        chainId: network.chainId,
        seed: w.paymentNote.seed,
      });
      setSentNote(pack.note ?? null);
      payTrack.current = { chainId: network.chainId, request: Boolean(request), note: Boolean(pack.note) };
      let share: string;
      let locked = false;
      if (payStyle === "direct") {
        const tag = recipientTag.trim();
        if (!isValidReceiveTag(tag)) {
          throw new Error(
            "Paste their Gloam address (it starts with gloamr1) to pay them privately."
          );
        }
        const plain = encodeNotePackage(pack);
        share = await encryptTicketForTag(plain, tag);
        locked = true; // encrypted to their key
      } else if (sendPassphrase.trim()) {
        share = await encodeNotePackageEncrypted(pack, sendPassphrase);
        locked = true;
      } else {
        share = encodeNotePackage(pack);
      }
      pendingShare.current = {
        blob: share,
        amountLabel: formatAssetLabel(w.paymentNote.amountWei, w.paymentNote.asset),
      };
      // Sent links record. The nullifier is worked out now, the same way a claim
      // does, so its status can be checked later without the phrase.
      let linkNullifier: Hex | undefined;
      try {
        linkNullifier = await paymentNullifier(pack.secret, pack.commitment);
      } catch {
        /* the row shows Couldn't check */
      }
      pendingClaimLink.current = payStyle === "bearer";
      pendingLink.current = makeSentLink({
        code: share,
        chainId: network.chainId,
        pool: network.pool,
        asset: pack.asset,
        symbol: assetLabel(pack.asset),
        amountWei: pack.amountWei,
        nullifier: linkNullifier,
        note: pack.note,
      });
      setShareLocked(locked);
      setShareBlob(null);
      setMemoPosted(false);

      // Payment leaf commitment, for on-chain memo discovery
      if (payStyle === "direct" && isPayMemoLive()) {
        pendingMemo.current = {
          paymentCommitment: fieldToBytes32(w.publicInputs.newCommitment0),
          ticket: share,
          relay: relayOn,
          relayFirst: relayAvailable,
        };
      } else {
        pendingMemo.current = null;
      }

      // The change and the payment's code are money: keep them in this browser
      // before anything is sent. The change waits out of the balance until the
      // chain shows it (lib/claimSweep settles it if this tab never hears back);
      // the code goes under Sent links. A send that surely never went out drops both.
      // A code that can't be kept stops the send, like a change note that can't.
      if (pendingChange.current) await saveLocalNote({ ...pendingChange.current, sweepPending: true });
      keptBeforeSend.current = { changeId: pendingChange.current?.id ?? null, linkId: null };
      if (pendingLink.current) {
        await saveSentLink(pendingLink.current);
        keptBeforeSend.current.linkId = pendingLink.current.id;
      }

      if (relayOn) {
        setStatus("Sending through the Gloam relay…");
        const h = await relayTransfer({
          chainId: network.chainId,
          proof: proofBytes,
          root: fieldToBytes32(w.publicInputs.root),
          nullifier: fieldToBytes32(w.publicInputs.nullifier),
          commitments: [
            fieldToBytes32(w.publicInputs.newCommitment0),
            fieldToBytes32(w.publicInputs.newCommitment1),
          ],
          ...(linkCode ? { partnerCode: linkCode } : {}),
        });
        setRelayHash(h);
        setSuccessTitle("Sent privately");
        void import("@/lib/track").then(({ track }) => {
          track("private_send_submit", { relay: true });
        });
        return;
      }
      setStatus("Confirm the payment in your wallet…");
      writeContract({
        address: network.pool,
        abi: shieldPoolAbi,
        functionName: "transfer",
        args: [
          proofBytes,
          fieldToBytes32(w.publicInputs.root),
          fieldToBytes32(w.publicInputs.nullifier),
          [
            fieldToBytes32(w.publicInputs.newCommitment0),
            fieldToBytes32(w.publicInputs.newCommitment1),
          ],
        ],
        gas: gasFor(network.chainId, TRANSFER_GAS_LIMIT),
        chainId: network.chainId,
      });
      setSuccessTitle(
        payStyle === "direct" && isPayMemoLive()
          ? "Paid. Confirm the heads-up next"
          : "Sent privately"
      );
      void import("@/lib/track").then(({ track }) => {
        track("private_send_submit");
      });
    } catch (e) {
      // The relay may have sent it (a lost reply, a timeout): keep what was saved,
      // it settles from the chain. Any clear refusal means nothing went out.
      const maybeSent = e instanceof RelaySubmitError && RELAY_MAYBE_SENT.has(e.code);
      if (maybeSent) {
        setError(
          "The relay may have sent this payment. Your change and the payment's code are saved in this browser: they show in your balance and under Sent links once it lands."
        );
      } else {
        forgetUnsent();
        setError(walletErrorForPeople(e, "The payment didn't go through. Try again."));
      }
      keptBeforeSend.current = null;
      setBusy(false);
      setStatus(null);
      pendingChange.current = null;
      pendingShare.current = null;
      pendingMemo.current = null;
      pendingLink.current = null;
      pendingClaimLink.current = false;
      payTrack.current = null;
    }
  }

  async function scanInbox() {
    if (!isPayMemoLive()) {
      setInboxStatus(
        "Not available on this network yet. Ask the sender for a claim link."
      );
      return;
    }
    // the board, the vault reads and the list below are all of the network shown
    const scanKey = networkKey;
    if (noteNetworkProblem({ chainId: network.chainId, pool: network.pool }, network)) return;
    const run = ++scanRun.current;
    setScanning(true);
    setInboxStatus("Checking for payments to your Gloam address…");
    setInbox([]);
    try {
      const client = publicClientFor(network);
      const memos = await fetchPaymentMemos(client);
      const hits: { memo: ScannedMemo; label: string; ticket: string; note?: string }[] = [];
      const seen = new Set<string>();
      for (const m of memos) {
        try {
          const pack = await decodeNotePackage(m.ticket, undefined, {
            tryTagDecrypt: true,
          });
          // Anyone who knows your Gloam address can post a message to it, so only
          // a real, unclaimed payment is shown: the code must open the commitment
          // the message names, and that note must be in the vault and unspent.
          const commitment = fieldToHex(
            await noteCommitmentPoseidon(hexToField(pack.secret), BigInt(pack.amountWei), pack.asset)
          ).toLowerCase();
          if (commitment !== m.paymentCommitment.toLowerCase() || seen.has(commitment)) continue;
          if (!network.pool || (pack.pool && pack.pool.toLowerCase() !== network.pool.toLowerCase())) continue;
          const [inVault, spent] = await Promise.all([
            client.readContract({ address: network.pool, abi: shieldPoolAbi, functionName: "commitmentSeen", args: [commitment as Hex] }),
            client.readContract({
              address: network.pool,
              abi: shieldPoolAbi,
              functionName: "isSpent",
              args: [await paymentNullifier(pack.secret, commitment as Hex)],
            }),
          ]);
          if (!inVault || spent) continue;
          seen.add(commitment);
          hits.push({
            memo: m,
            ticket: m.ticket,
            label: formatAssetLabel(pack.amountWei, pack.asset),
            note: pack.note,
          });
        } catch {
          /* not for us */
        }
      }
      // switched while scanning: these were the other network's payments
      if (shownNetworkKey.current !== scanKey) return;
      setInbox(hits);
      setInboxStatus(
        hits.length
          ? `Found ${hits.length} ${hits.length === 1 ? "payment" : "payments"} for you.`
          : "No new payments yet."
      );
    } catch {
      // an RPC error's text names the endpoint and the request: no use to read
      if (shownNetworkKey.current === scanKey) {
        setInboxStatus("Couldn't check for payments right now. Try again in a moment.");
      }
    } finally {
      if (run === scanRun.current) setScanning(false);
    }
  }

  /**
   * Move a claimed payment into a fresh note only this browser knows. Through
   * the relay when it is on; otherwise the wallet signs (and shows as sender).
   */
  async function secureNote(
    note: LocalNote,
    claim?: { claimed: true; note?: string },
    report = true
  ): Promise<SweepStatus> {
    const label = formatAssetLabel(note.amountWei, note.asset);
    const did = claim ? `Claimed ${label}` : `${label} is claimed`;
    const stillOpen = "Until it is secured, the person who sent it can still take it back.";
    // tried again with no one asking while the relay is on (lib/claimSweep secureClaimsInBackground)
    const next = secureNextStep(relayOn);
    const pending = { id: note.id, label };
    if (report) {
      setError(null);
      setImportOk(null);
    }
    const wrongNetwork = noteNetworkProblem(note, network);
    if (wrongNetwork) {
      if (report) setError(wrongNetwork);
      return "error";
    }
    setSecuringId(note.id);
    setBusy(true);
    setStatus("Securing this payment…");
    let outcome: SweepStatus = "error";
    try {
      const r = await secureClaim({
        note,
        relay: relayOn,
        sendWithWallet: ({ pool, args }) =>
          writeContractAsync({
            address: pool,
            abi: shieldPoolAbi,
            functionName: "transfer",
            args: [args[0], args[1], args[2], [args[3][0], args[3][1]]],
            gas: gasFor(network.chainId, TRANSFER_GAS_LIMIT),
            chainId: network.chainId,
          }),
        onStage: setStatus,
      });
      void import("@/lib/track").then(({ track }) => {
        track("claim_secure", { reason: r.status, relay: relayOn, chainId: network.chainId });
      });
      outcome = r.status;
      if (r.status === "swept") countPerson("claim", address, network.testnet);
      if (r.status === "swept" && r.freshNote) {
        const fresh = loadLocalNotes(address).find(
          (n) => n.commitment.toLowerCase() === r.freshNote!.commitment.toLowerCase()
        );
        if (fresh) setSelectedId(fresh.id);
      }
      if (!report) {
        /* the caller says what happened */
      } else if (r.status === "swept") {
        setImportOk({
          text: `${claim ? "Claimed and secured" : "Secured"} ${label}. Only you can spend it now, and the person who sent it can no longer take it back.`,
          note: claim?.note,
          next: claim ? { id: note.id, full: takeFirstClaim(), amount: label, asset: note.asset } : undefined,
        });
      } else if (r.status === "already_spent") {
        setImportOk({
          text: `${label} was claimed somewhere else before it was secured here, so it is not in this balance. If that was not you on another device, check with the person who sent it.`,
          note: claim?.note,
          tone: "danger",
        });
      } else if (r.status === "not_settled") {
        setImportOk({
          text: `${did}, but the payment has not reached the vault yet, so it is not in your balance and cannot be secured. It shows up once it lands; secure it then. ${stillOpen}`,
          note: claim?.note,
          tone: "warn",
          pending,
        });
      } else if (r.status === "unconfirmed" && !r.relayFailure) {
        setImportOk({
          text: `${did}. Securing it was sent and has not confirmed yet. It counts in your balance once it lands.`,
          note: claim?.note,
          tone: "warn",
          pending,
        });
      } else if (r.status === "bad_note") {
        setImportOk({
          text: "The amount in this payment does not match what it holds in the vault, so it cannot be secured.",
          tone: "danger",
        });
      } else if (r.relayFailure) {
        // the relay, not the chain: unreachable, turned it away, or its reply was lost (looked for on the chain first)
        setImportOk({
          text: `${did}, but it is not secured yet: ${secureFailureReason({ step: "relay", ...r.relayFailure }, network.label)}. ${next} ${stillOpen}`,
          note: claim?.note,
          tone: "warn",
          pending,
        });
      } else {
        const why = /reject|denied|cancel/i.test(r.reason ?? "")
          ? "the wallet prompt was closed"
          : "it did not go through";
        setImportOk({
          text: `${did}, but it is not secured yet: ${why}. ${stillOpen}`,
          note: claim?.note,
          tone: "warn",
          pending,
        });
      }
    } catch (e) {
      // Said in terms of the part that failed, after its retries (lib/secureRetry): the chain, the
      // proving files or the connection. Anything else shows its first line only: viem's message
      // carries the whole RPC request (URL, body, call args).
      const failure = secureFailureOf(e);
      const short =
        (e as { shortMessage?: string } | null)?.shortMessage ??
        (e instanceof Error ? e.message.split("\n")[0] : "something went wrong");
      const msg = failure ? `${secureFailureReason(failure, network.label)}. ${next}` : `${short.replace(/\.$/, "")}.`;
      if (report) setImportOk({
        text: `${did}, but it is not secured yet: ${msg} ${stillOpen}`,
        note: claim?.note,
        tone: "warn",
        pending,
      });
    }
    refreshNotes();
    void refreshTree();
    setBusy(false);
    setStatus(null);
    setSecuringId(null);
    return outcome;
  }

  /**
   * Claim a payment code into the connected wallet's private balance. Used by
   * Receive > Claim a payment and by Sent links > Take back, so a locked code
   * needs its phrase either way. The note is saved in this browser first (never
   * lost); the caller then secures it with secureNote, because the payer made
   * its secret and could spend it back until it moves. A payment already
   * claimed here is not counted twice, and one still waiting to be secured is
   * picked up again.
   */
  async function claimCode(
    code: string,
    passphrase?: string
  ): Promise<{ label: string; note?: string; local: LocalNote; isNew: boolean; already: boolean; demo: boolean }> {
    if (!network.pool || !address) {
      throw new Error("Connect a wallet first.");
    }
    // the vault reads below must be of the network shown, where the claim is saved
    const switching = noteNetworkProblem({ chainId: network.chainId, pool: network.pool }, network);
    if (switching) throw new Error(switching);
    const pack = await decodeNotePackage(code, passphrase || undefined, {
      tryTagDecrypt: true,
    });
    const wrongNetwork = claimNetworkProblem(network, pack);
    if (wrongNetwork) throw new Error(wrongNetwork);
    // A locked code takes a moment to open: still on the network shown, and every read below goes to it.
    const stillSwitching = noteNetworkProblem({ chainId: network.chainId, pool: network.pool }, network);
    if (stillSwitching) throw new Error(stillSwitching);
    const claimClient = publicClientFor(network);

    const asset = pack.asset;
    const secret = pack.secret;
    let amount: bigint;
    try {
      amount = BigInt(pack.amountWei);
    } catch {
      throw new DeadCodeError("This payment has no readable amount.");
    }
    if (amount <= 0n) throw new DeadCodeError("This payment carries no value.");
    // The amount must be what the note holds: commitment = Poseidon(secret, amount, asset).
    const commitment = fieldToHex(
      await noteCommitmentPoseidon(hexToField(secret), amount, asset)
    );
    if (
      pack.commitment &&
      pack.commitment !== "0x" &&
      pack.commitment.toLowerCase() !== commitment.toLowerCase()
    ) {
      throw new DeadCodeError(
        "The amount in this payment does not match what it holds in the vault, so it was not claimed."
      );
    }
    const nullifier = fieldToHex(
      await noteNullifierPoseidon(hexToField(secret), hexToField(commitment))
    );
    const label = formatAssetLabel(pack.amountWei, asset);
    const demo = readDemo();
    // Spent before this browser saw it: most often claimed already (on another
    // device, or by whoever had the link), sometimes taken back by the sender.
    const moved =
      "This payment has already been claimed, so there is nothing left here. If you claimed it on another device, it is in your balance there. If not, check with the person who sent it.";

    const known = loadLocalNotes(address, network).find(
      (n) => n.commitment.toLowerCase() === commitment.toLowerCase()
    );
    if (known && !isUnsecuredClaim(known)) {
      if (known.status === "recovered" && !known.secured) throw new DeadCodeError(moved);
      return { label, note: pack.note, local: known, isNew: false, already: true, demo };
    }

    if (!known && !demo) {
      const spent = await claimClient
        .readContract({
          address: network.pool,
          abi: shieldPoolAbi,
          functionName: "isSpent",
          args: [nullifier],
        })
        .catch(() => false);
      if (spent) throw new DeadCodeError(moved);
    }

    const tree = await syncShieldTree(claimClient, network).catch(() => null);
    const idx = tree?.indexByCommitment.get(commitment.toLowerCase());
    // Not in the vault yet (still on its way, or a code nobody paid): kept, but
    // out of the balance until the vault shows it.
    const seenInVault =
      demo || idx != null
        ? true
        : await claimClient
            .readContract({ address: network.pool, abi: shieldPoolAbi, functionName: "commitmentSeen", args: [commitment] })
            .catch(() => false);
    const unfunded = !demo && idx == null && seenInVault !== true;

    const local: LocalNote = known ?? {
      id: claimNoteId(),
      chainId: network.chainId,
      pool: network.pool,
      asset,
      amountWei: pack.amountWei,
      commitment,
      secret,
      nullifier,
      bound: true,
      scheme: "poseidon",
      from: address,
      createdAt: Date.now(),
      status: "open",
      source: "local",
      leafIndex: idx ?? undefined,
      ...(demo ? {} : { unfunded }),
      // The payer's private note, kept with the balance (encrypted at rest).
      ...(pack.note ? { note: pack.note } : {}),
      // Recording demo: the pretend payer cannot take anything back.
      ...(demo ? { secured: true } : {}),
    };
    if (!known) saveLocalNote(local);
    else if (demo) updateLocalNote(known.id, { secured: true });
    setSelectedId(local.id);
    refreshNotes();
    void refreshTree();
    return { label, note: pack.note, local, isNew: !known, already: false, demo };
  }

  async function onImportNote() {
    if (claimGate.current) return;
    claimGate.current = true;
    setClaimOpening(true);
    setError(null);
    setImportOk(null);
    try {
      const r = await claimCode(importText, importPassphrase);
      if (r.isNew) countLinkClaimed(importText);
      // in this browser's balance now: the tab no longer keeps the link
      dropClaimLink();
      setImportText("");
      setImportPassphrase("");
      if (r.already) {
        setImportOk({ text: `You already claimed ${r.label}.`, note: r.note });
        return;
      }
      if (r.demo) {
        setImportOk({
          text: `Claimed and secured ${r.label}. Only you can spend it now.`,
          note: r.note,
          next: { id: r.local.id, full: takeFirstClaim(), amount: r.label, asset: r.local.asset },
        });
        return;
      }
      await secureNote(r.local, { claimed: true, note: r.note });
    } catch (e) {
      // a code that can never be claimed: the tab stops filling the box with it
      if (e instanceof DeadCodeError) dropClaimLink();
      setError(walletErrorForPeople(e, "Couldn't open this payment. Check the code and try again."));
    } finally {
      claimGate.current = false;
      setClaimOpening(false);
    }
  }

  /**
   * Sent links > Take back: the same claim into the sender's own balance, then
   * secured, so the link stops working once the move lands.
   */
  async function takeBackLink(code: string, passphrase?: string): Promise<{ secured: boolean }> {
    const r = await claimCode(code, passphrase);
    if (r.already || r.demo) return { secured: true };
    const outcome = await secureNote(r.local, undefined, false);
    if (outcome === "already_spent") {
      throw new Error("Someone claimed it first, so there is nothing to take back.");
    }
    return { secured: outcome === "swept" };
  }

  /** The banner's button: secure every claimed payment still open to the payer, one at a time. */
  async function secureAll() {
    for (const n of unsecured) {
      if ((await secureNote(n)) !== "swept") return;
    }
  }

  // Sticky receive tag for direct private pay
  useEffect(() => {
    if (mode !== "receive" && mode !== "send") return;
    void getOrCreateReceiveIdentity().then(setMyIdentity).catch(() => {
      /* crypto unavailable */
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- saved contacts live in this browser; read again each time Send opens
    if (mode === "send") setContacts(loadContacts());
  }, [mode]);

  // Payments found for one network are never listed on another: a switch clears the list.
  const shownNetworkKey = useRef(networkKey);
  useEffect(() => {
    if (shownNetworkKey.current === networkKey) return;
    shownNetworkKey.current = networkKey;
    setInbox([]);
    setInboxStatus(null);
  }, [networkKey]);

  // Auto-scan inbox when opening Receive (if memo board live), and again on a network switch
  useEffect(() => {
    if (mode !== "receive" || !isPayMemoLive()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening Receive scans the payment-message board, which marks the scan as running
    void scanInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-tab scan once per enter
  }, [mode, networkKey]);

  // Live preview when pasting a ticket (amount only, not a full claim)
  useEffect(() => {
    const t = importText.trim();
    if (!t || mode !== "receive") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no text to preview: drop the last preview before the debounced check below
      setClaimPreview(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          if (isPayToTagSealed(t)) {
            const pack = await decodeNotePackage(t, undefined, {
              tryTagDecrypt: true,
            });
            if (!cancelled) {
              setClaimPreview({
                text: `A payment of ${formatAssetLabel(pack.amountWei, pack.asset)} for you, ready to claim.`,
                note: pack.note,
              });
            }
            return;
          }
          if (isEncryptedPackage(t) && !importPassphrase.trim()) {
            if (!cancelled) {
              setClaimPreview({ text: "This claim link is locked. Enter the phrase to see it." });
            }
            return;
          }
          const pack = await decodeNotePackage(
            t,
            importPassphrase || undefined
          );
          if (cancelled) return;
          setClaimPreview({
            text: `Looks like a payment of ${formatAssetLabel(pack.amountWei, pack.asset)}.`,
            note: pack.note,
          });
        } catch (e) {
          if (!cancelled) {
            setClaimPreview(
              e instanceof Error && e.message.includes("someone else")
                ? { text: e.message }
                : null
            );
          }
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [importText, importPassphrase, mode]);

  const working = busy || isPending || confirming;
  // What the spinner and the success note are about, read once per render.
  // eslint-disable-next-line react-hooks/refs -- each handler sets it together with busy, so the render that shows the spinner reads it current
  const busyAction = pendingAction.current;
  const connectedOk = isConnected && onProduct;
  // Email sign-in (Gloam wallets) is what the wallet menu offers first, while the kit can run here.
  const embeddedState = useSyncExternalStore(onEmbeddedAvailability, embeddedAvailability, () => "starting" as const);
  const signInOffered = EMBEDDED_WALLETS && embeddedState !== "unavailable";
  const memoLive = isPayMemoLive();

  // Payment request: who asked (only a saved contact counts as known) and
  // whether a private balance can cover it on this network.
  const requestContact = request?.to
    ? (contacts.find((c) => c.tag === request.to)?.label ?? null)
    : null;
  const requestHint = ((): { text: string; addHref?: string } | null => {
    const asset = request?.asset;
    if (!asset || !shieldLive) return null;
    if (!requestNoteId) {
      return {
        text: `You have no private ${asset.symbol} on ${network.label} yet. Add some, then open this link again.`,
        addHref: "/app/vault?tab=shield",
      };
    }
    if (!selected) return null;
    if (selected.asset.toLowerCase() !== asset.address.toLowerCase()) {
      return {
        text: `This request is for ${asset.symbol}. The balance picked below holds ${assetLabel(selected.asset)}.`,
      };
    }
    const need = request.amount ? parseAssetAmount(request.amount, asset.address) : null;
    if (need && BigInt(selected.amountWei) < need) {
      return {
        text: `Each payment comes from one balance, and your largest ${asset.symbol} balance is ${formatAssetLabel(selected.amountWei, selected.asset)}. Add more to pay it in full.`,
        addHref: "/app/vault?tab=shield",
      };
    }
    return null;
  })();

  function selectMode(id: Mode) {
    setMode(id);
    setError(null);
    setStatus(null);
    setImportOk(null);
    setClaimPreview(null);
  }

  /**
   * Pay hands a wallet over to Cash out (nothing else changes): another address,
   * that address, and the amount typed in Pay (Cash out checks it).
   * The URL follows through selectMode (?mode=cashout), as for a tab click.
   */
  function payThisWallet(to: Address) {
    const h = cashOutHandoff(to, sendAmount);
    setCashOutDest(h.dest);
    setOtherTo(h.to);
    setCashOutInput(h.amount);
    selectMode("cashout");
  }

  /**
   * A request link to a 0x address or an ENS name (lib/paymentRequest) takes
   * that same path on its own, once per request: when the address is known
   * (an ENS name once it is found), Cash out opens with the wallet, the amount
   * and the requested token's balance filled in. Nothing is sent: the payer
   * still checks it and presses Cash out. Deferred like a claim link, so the
   * mode reaches the URL after the first render has synced it.
   */
  const handedOffRequest = useRef<PaymentRequest | null>(null);
  /** The wallet a request was handed off to Cash out with: a cash out from a partner's link counts only when it pays this one. */
  const handedOffTo = useRef<Address | null>(null);
  useEffect(() => {
    if (!request || !isWalletRequest(request) || handedOffRequest.current === request) return;
    if (mode !== "send" || !payWalletTo || recipientTag !== request.to) return;
    const to = payWalletTo;
    const amount = request.amount ?? "";
    const t = window.setTimeout(() => {
      handedOffRequest.current = request;
      handedOffTo.current = to;
      const h = cashOutHandoff(to, amount);
      setCashOutDest(h.dest);
      setOtherTo(h.to);
      setCashOutInput(h.amount);
      setMode("cashout");
      setError(null);
      setStatus(null);
      setImportOk(null);
      setClaimPreview(null);
    }, 0);
    return () => window.clearTimeout(t);
  }, [request, mode, payWalletTo, recipientTag]);

  // The URL and the mode follow each other. The app nav's Pay privately,
  // Receive and Cash out links only change ?mode= on a page already showing
  // Pay, so a new ?mode= switches the mode as a tab click would; and a mode
  // picked here, or by a claim or request link, is written back (fragment
  // kept) so the nav and a reload show the same thing.
  const urlMode = moveModeFromParam(searchParams.get("mode"));
  const modeNow = useRef(mode);
  useEffect(() => {
    modeNow.current = mode;
  }, [mode]);
  useEffect(() => {
    if (urlMode === modeNow.current) return;
    setMode(urlMode);
    setError(null);
    setStatus(null);
    setImportOk(null);
    setClaimPreview(null);
  }, [urlMode]);
  useEffect(() => {
    const next = searchWithMoveMode(window.location.search, mode);
    if (next === null) return;
    // No state object: Next skips a replaceState that carries its own state, and
    // then the nav's useSearchParams would not see the new mode.
    window.history.replaceState(null, "", window.location.pathname + next + window.location.hash);
  }, [mode]);

  /**
   * An action picked after a claim (AfterClaimNext): open that part of Pay with
   * the claimed balance already picked, and bring it into view. "receive" goes
   * to the Gloam address, where getting paid privately starts.
   */
  function afterClaimGo(id: Mode) {
    // Cash out right after a claim opens on the balance just claimed (or the note securing it made).
    const claimed = importOk?.next?.id;
    if (id === "cashout" && claimed) {
      const pick = notes.find((n) => n.id === claimed || n.sweptFrom?.id === claimed);
      if (pick) setSelectedId(pick.id);
      // a fresh cash out of it: no amount typed earlier carries over
      setCashOutInput("");
    }
    selectMode(id);
    window.setTimeout(() => {
      const el = document.getElementById(id === "receive" ? "gloam-address" : "pay-card");
      if (!el) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
      if (id === "receive") el.focus({ preventScroll: true });
    }, 0);
  }

  // every token the chain knows, so a note a swap brought in (WETH, a stock token) shows its logo too
  const shieldTokens = knownTokens(network.chainId);
  const logoIdFor = (asset: string): string | null => {
    // the chain's own coin: HYPE on Elysium, ETH elsewhere
    if (isNativeAsset(asset)) return nativeTokenFor(network.chainId).id;
    return (
      shieldTokens.find((t) => t.address.toLowerCase() === asset.toLowerCase())?.id ??
      asset
    );
  };

  const totals = (() => {
    const m = new Map<string, bigint>();
    for (const n of notes) {
      const k = n.asset.toLowerCase();
      m.set(k, (m.get(k) ?? 0n) + BigInt(n.amountWei || "0"));
    }
    return Array.from(m.entries()).map(([asset, amt]) => ({
      asset,
      label: assetLabel(asset),
      logoId: logoIdFor(asset),
      amount: formatAssetAmount(amt, asset),
    }));
  })();

  const connectPrompt = (action: string) => (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-surface px-4 py-3">
      <p className="text-[14px] text-mute">
        {!isConnected
          ? signInOffered
            ? `Sign in with your email or connect a wallet to ${action}.`
            : `Connect a wallet to ${action}.`
          : `Switch to ${network.label} to ${action}.`}
      </p>
      <WalletMenu />
    </div>
  );

  const relayToggle = (
    <>
      {gasHigh && <RelayGasNotice status={relayStatus} label={network.label} later={mode === "cashout"} />}
      <RelayToggle
        available={relayAvailable}
        on={relayOn}
        onChange={(v) => {
          setRelayOn(v);
          setRelayPreferred(v);
        }}
      />
    </>
  );

  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Send, Receive and Cash out are picked in the Vault's own row
            (VaultHub: Pay privately, Receive, Cash out) through ?mode=, so
            the card has no row of its own; the first block sits at the top. */}
        <div id="pay-card" className="gl-card min-w-0 scroll-mt-24 p-5 sm:p-7 [&>*:first-child]:mt-0">
          <DevKeysBanner compact />

          {!poseidonMode && (
            <p className="mt-5 rounded-xl bg-warn-soft px-4 py-3 text-[13.5px] leading-relaxed text-warn">
              The private vault is not connected right now. Try again shortly.
            </p>
          )}

          {request && (mode === "send" || (mode === "cashout" && isWalletRequest(request))) && (
            <PaymentRequestBanner
              request={request}
              contactLabel={requestContact}
              currentNetwork={networkKey}
              onSwitchNetwork={setNetworkKey}
              onDismiss={() => setRequest(null)}
              balanceHint={requestHint}
              partnerName={partnerName}
            />
          )}

          {unsecured.length > 0 && poseidonMode && (
            <div className="mt-5 rounded-xl bg-warn-soft px-4 py-3.5 text-[13.5px] leading-relaxed">
              <p className="font-medium text-warn">
                {unsecured.length === 1
                  ? `Secure the ${formatAssetLabel(unsecured[0]!.amountWei, unsecured[0]!.asset)} you claimed`
                  : `Secure ${unsecured.length} payments you claimed`}
              </p>
              <p className="mt-1 text-foreground">
                {unsecured.length === 1
                  ? "Whoever paid you made its key, so they can still take it back until you secure it. Securing moves it into a balance only you hold."
                  : "Whoever paid you made their keys, so they can still take them back until you secure them. Securing moves them into a balance only you hold."}
                {relayOn
                  ? " It goes through the Gloam relay, so your wallet stays out of it."
                  : " With the relay off, your wallet signs it and shows as the sender."}
              </p>
              {isConnected && (onProduct || relayOn) ? (
                <button
                  type="button"
                  onClick={() => void secureAll()}
                  disabled={working}
                  className="btn btn-ink btn-sm mt-3"
                >
                  {securingId ? (
                    <>
                      <Spinner />
                      <span className="truncate">{status || "Securing…"}</span>
                    </>
                  ) : unsecured.length === 1 ? (
                    "Secure it now"
                  ) : (
                    "Secure them now"
                  )}
                </button>
              ) : (
                <div className="mt-3">{connectPrompt("secure it")}</div>
              )}
            </div>
          )}

          {importOk?.next ? (
            <AfterClaimNext
              key={importOk.next.id}
              full={importOk.next.full}
              amountLabel={importOk.next.amount}
              text={importOk.text}
              note={importOk.note}
              swapHref={canSwapAfterClaim(network.chainId, importOk.next.asset, address) ? "/app/vault?tab=swap" : null}
              onSend={() => afterClaimGo("send")}
              onGetPaid={() => afterClaimGo("receive")}
              onCashOut={() => afterClaimGo("cashout")}
            />
          ) : importShown && (
            <div
              className={`mt-5 flex items-start gap-3 rounded-xl px-4 py-3 text-[13.5px] leading-relaxed text-foreground ${
                importShown.tone === "danger"
                  ? "bg-danger-soft"
                  : importShown.tone === "warn"
                    ? "bg-warn-soft"
                    : "bg-sealed-soft"
              }`}
              role={importShown.tone === "danger" ? "alert" : undefined}
              aria-live="polite"
            >
              <span
                className={`mt-0.5 ${
                  importShown.tone === "danger"
                    ? "text-danger"
                    : importShown.tone === "warn"
                      ? "text-warn"
                      : "text-sealed"
                }`}
                aria-hidden
              >
                {importShown.tone ? <LockIcon size={14} /> : <CheckIcon />}
              </span>
              <span className="min-w-0">
                <span className="block">{importShown.text}</span>
                {importShown.note && (
                  <PaymentNoteLine
                    note={importShown.note}
                    label="Their note"
                    className="mt-1 text-soft"
                  />
                )}
              </span>
            </div>
          )}

          {shieldLive && notes.length > 0 && mode !== "receive" ? (
            <>
              <section className="mt-6">
                <p className="text-[13px] text-mute">
                  {mode === "cashout" ? "Cash out from" : "Pay from"}
                </p>
                <ul
                  role="radiogroup"
                  aria-label={mode === "cashout" ? "Cash out from" : "Pay from"}
                  className="mt-2 max-h-[300px] space-y-2 overflow-y-auto"
                >
                  {notes.map((n) => {
                    const active = selected?.id === n.id;
                    const exposed = isUnsecuredClaim(n);
                    const kind = exposed
                      ? "Claimed, not secured yet"
                      : isClaimedNote(n) || isSecuredClaim(n) || !n.txHash
                        ? "Claimed"
                        : n.cashOutPlan || n.id.startsWith("co-")
                          ? "Set aside to cash out"
                          : n.id.startsWith("chg-")
                            ? "Change from a payment"
                            : "Added";
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setSelectedId(n.id)}
                          className={`flex min-h-[60px] w-full items-center gap-3 rounded-[14px] border px-4 py-2.5 text-left transition-colors ${
                            active
                              ? "border-foreground bg-panel"
                              : "border-line hover:border-line-strong hover:bg-surface"
                          }`}
                        >
                          <AssetMark id={logoIdFor(n.asset)} symbol={assetLabel(n.asset)} size={32} />
                          <span className="min-w-0 flex-1">
                            <span className="tnum block truncate text-[16px] text-foreground">
                              {formatAssetAmount(n.amountWei, n.asset)}{" "}
                              <span className="text-mute">{assetLabel(n.asset)}</span>
                            </span>
                            <span className={`block truncate text-[12px] ${exposed ? "text-warn" : "text-mute"}`}>
                              {kind},{" "}
                              {new Date(n.createdAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                            {n.note && (
                              <PaymentNoteLine
                                note={n.note}
                                className="mt-0.5 text-[12px] text-soft"
                              />
                            )}
                          </span>
                          <span
                            aria-hidden
                            className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors ${
                              active ? "border-foreground bg-foreground" : "border-line-strong"
                            }`}
                          >
                            {active && <span className="h-2 w-2 rounded-full bg-panel" />}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {mode === "send" && (
                <div className="mt-6 space-y-5">
                  {/* Same mental model as public Send: To + Amount. A claim
                      link is the way to pay someone who has never used Gloam,
                      so it sits next to the address, not under the form. */}
                  <div>
                    <p id="pay-to" className="text-[13px] text-mute">
                      To
                    </p>
                    <div
                      role="radiogroup"
                      aria-labelledby="pay-to"
                      className="mt-2 grid grid-cols-2 gap-2"
                    >
                      {(
                        [
                          ["direct", "Gloam address", "They already use Gloam"],
                          ["bearer", "Claim link", "Anyone, even new to Gloam"],
                        ] as const
                      ).map(([style, label, hint]) => {
                        const active = payStyle === style;
                        return (
                          <button
                            key={style}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => {
                              if (style === "bearer") setRecipientTag("");
                              else setSendPassphrase("");
                              setPayStyle(style);
                            }}
                            className={`flex min-h-[60px] min-w-0 items-start gap-3 rounded-[14px] border px-3.5 py-3 text-left transition-colors ${
                              active
                                ? "border-foreground bg-panel"
                                : "border-line hover:border-line-strong hover:bg-surface"
                            }`}
                          >
                            <span
                              aria-hidden
                              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors ${
                                active ? "border-foreground bg-foreground" : "border-line-strong"
                              }`}
                            >
                              {active && <span className="h-2 w-2 rounded-full bg-panel" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[14.5px] leading-snug text-foreground">{label}</span>
                              <span className="mt-0.5 block text-[12px] leading-snug text-mute">{hint}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {payStyle === "bearer" ? (
                      <div className="mt-3">
                        <p className="text-[12.5px] leading-relaxed text-mute">
                          You get a link to send any way you like. They tap it and
                          claim in Gloam. Anyone with the link can claim it, so add
                          a phrase to lock it and share the phrase separately.
                        </p>
                        <label
                          htmlFor="send-pass"
                          className="mt-4 block text-[13px] text-mute"
                        >
                          Phrase (optional)
                        </label>
                        <input
                          id="send-pass"
                          type="text"
                          autoComplete="off"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          value={sendPassphrase}
                          onChange={(e) => setSendPassphrase(e.target.value)}
                          placeholder="e.g. coffee-tuesday"
                          className="gl-input mt-2"
                        />
                      </div>
                    ) : (
                    <>
                    <label htmlFor="recv-tag" className="sr-only">
                      Their Gloam address, 0x address or ENS name
                    </label>
                    <input
                      id="recv-tag"
                      value={recipientTag}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        setRecipientTag(v);
                        if (v.startsWith("gloamr1.")) setPayStyle("direct");
                        else if (v === "") setPayStyle("direct");
                      }}
                      placeholder="Gloam address, 0x address or ENS name"
                      className="gl-input tnum mt-3"
                    />
                    {payToWallet ? (
                      <div
                        id="pay-wallet"
                        className="mt-3 rounded-[14px] border border-line bg-surface px-4 py-3.5"
                      >
                        {payRecipient.kind === "badAddress" ? (
                          <p role="alert" className="text-[12.5px] leading-relaxed text-danger">
                            That 0x address looks mistyped. Check it and paste it again.
                          </p>
                        ) : (
                          <>
                            {payWalletTo && (
                              <p className="text-[14.5px] leading-snug text-foreground">That&apos;s a wallet address</p>
                            )}
                            {payRecipient.kind === "ens" && (
                              <p aria-live="polite" className={`tnum text-[12.5px] leading-snug text-mute ${payWalletTo ? "mt-1" : ""}`}>
                                {ensLookup.status === "found"
                                  ? `${payRecipient.name} · ${shortAddress(ensLookup.address)}`
                                  : ensLookup.status === "none"
                                    ? "No address found for that name."
                                    : ensLookup.status === "unsafe"
                                      ? `${payRecipient.name} · ${shortAddress(ensLookup.address)}`
                                      : "Looking up name…"}
                              </p>
                            )}
                            {ensLookup.status === "found" && ensLookup.source === "mainnet" && (
                              <p className="mt-1 text-[12.5px] leading-relaxed text-mute">
                                This name has no {network.label} address set, so this is its Ethereum address. It&apos;s a
                                regular wallet, so the same owner holds it on {network.label}.
                              </p>
                            )}
                            {ensLookup.status === "unsafe" && (
                              <p role="alert" className="mt-1 text-[12.5px] leading-relaxed text-danger">
                                This name only has an Ethereum address, and it&apos;s a smart account. It may not
                                belong to them on {network.label}. Ask them for their {network.label} address.
                              </p>
                            )}
                            {payWalletTo && (
                              <>
                                <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                                  Gloam pays it from your private balance. It arrives in their wallet like a normal
                                  transfer, and it doesn&apos;t show which Gloam balance paid it. The amount and their address are public.
                                </p>
                                <button
                                  type="button"
                                  onClick={() => payThisWallet(payWalletTo)}
                                  className="btn btn-ink mt-3"
                                >
                                  Pay this wallet
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    ) : recipientTag.trim().startsWith("gloamr1.") && !isValidReceiveTag(recipientTag) ? (
                      <p role="alert" className="mt-2 text-[12.5px] leading-relaxed text-danger">
                        That Gloam address looks incomplete or mistyped. Copy it again from their Receive page.
                      </p>
                    ) : (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                        Like sending to an address, but private. They find their
                        Gloam address under Receive.
                      </p>
                    )}
                    {(contacts.length > 0 || recipientTag.trim().startsWith("gloamr1.")) && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        {contacts.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setRecipientTag(c.tag)}
                            className={`h-10 rounded-full px-3.5 text-[13px] transition-colors ${
                              recipientTag === c.tag
                                ? "bg-ink text-on-ink"
                                : "bg-surface text-soft hover:bg-surface-2 hover:text-foreground"
                            }`}
                          >
                            {c.label}
                          </button>
                        ))}
                        {recipientTag.trim().startsWith("gloamr1.") && (
                          <button
                            type="button"
                            className="h-10 rounded-full px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-surface"
                            onClick={() => {
                              const label =
                                window.prompt("Save contact as", request?.name ?? "Friend") ?? "";
                              if (!label.trim()) return;
                              upsertContact(label, recipientTag);
                              setContacts(loadContacts());
                            }}
                          >
                            + Save to contacts
                          </button>
                        )}
                      </div>
                    )}
                    </>
                    )}
                  </div>

                  <div>
                    <label htmlFor="pay-amt" className="text-[13px] text-mute">
                      Amount
                    </label>
                    <div className="gl-inputcard mt-2 flex items-center gap-3 rounded-[16px] py-2 pl-4 pr-2">
                      <input
                        id="pay-amt"
                        inputMode="decimal"
                        autoComplete="off"
                        value={sendAmount}
                        onChange={(e) => setSendAmount(e.target.value)}
                        placeholder="0"
                        className="tnum min-w-0 flex-1 bg-transparent text-[32px] font-light leading-[1.25] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
                      />
                      {selected && (
                        <span className="shrink-0 text-[15px] text-mute">
                          {assetLabel(selected.asset)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm shrink-0"
                        onClick={() => setSendAmount(maxEth)}
                      >
                        Max
                      </button>
                    </div>
                    <AmountProblem value={sendAmount} decimals={selected ? assetDecimals(selected.asset) : undefined} />
                    <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                      The amount never shows up on the explorer. Anything left
                      over stays in your private balance.
                    </p>
                  </div>

                  <PayNoteField
                    value={payNote}
                    open={noteOpen}
                    onOpen={setNoteOpen}
                    onChange={setPayNote}
                    fromRequest={Boolean(request?.note) && cleanPaymentNote(payNote) === request?.note}
                    bearer={payStyle === "bearer" && !recipientTag.trim()}
                    locked={Boolean(sendPassphrase.trim())}
                  />

                  {relayToggle}

                  {!connectedOk ? (
                    connectPrompt("pay privately")
                  ) : (
                    <button
                      type="button"
                      disabled={
                        !isConnected ||
                        !onProduct ||
                        !selected ||
                        matchesChain === false ||
                        treeLoading ||
                        !relayChecked ||
                        working ||
                        payToWallet ||
                        (payStyle !== "bearer" && !recipientTag.trim())
                      }
                      onClick={() => {
                        if (recipientTag.trim()) setPayStyle("direct");
                        void onPrivateSend();
                      }}
                      className="btn btn-ink btn-lg btn-block"
                    >
                      {working &&
                      (busyAction === "send" ||
                        busyAction === "memo") ? (
                        <>
                          <Spinner />
                          <span className="truncate">{status || "Working…"}</span>
                        </>
                      ) : treeLoading ? (
                        "Syncing your balance…"
                      ) : payStyle === "bearer" ? (
                        "Make the claim link"
                      ) : (
                        "Send privately"
                      )}
                    </button>
                  )}
                  {treeError && !treeLoading && matchesChain !== false && (
                    <p className="flex flex-wrap items-center justify-center gap-x-2 text-center text-[12.5px] text-warn">
                      Couldn&apos;t read the vault right now. The network may be busy.
                      <button
                        type="button"
                        onClick={() => void refreshTree()}
                        className="font-medium underline underline-offset-4"
                      >
                        Try again
                      </button>
                    </p>
                  )}
                  {matchesChain === false && (
                    <p className="flex flex-wrap items-center justify-center gap-x-2 text-center text-[12.5px] text-warn">
                      Your private balance is out of sync.
                      <button
                        type="button"
                        onClick={() => void refreshTree()}
                        className="font-medium underline underline-offset-4"
                      >
                        Refresh
                      </button>
                    </p>
                  )}
                  {memoLive && payStyle === "direct" && (
                    <p className="text-center text-[12.5px] leading-relaxed text-mute">
                      They get a private heads-up, so the payment shows up under
                      Receive on their side. No QR needed.
                    </p>
                  )}
                  {shareBlob && (
                    <PaymentTicketShare
                      code={shareBlob}
                      amountLabel={shareAmountLabel}
                      locked={shareLocked}
                      onSaved={() => setSavedCode(shareBlob)}
                    />
                  )}
                </div>
              )}

              {mode === "cashout" && (
                <div className="mt-6 space-y-4">
                  <div className="rounded-[16px] bg-warn-soft px-4 py-3.5 text-[13px] leading-relaxed">
                    <p className="font-medium text-warn">
                      Cashing out makes the amount and where it goes public
                    </p>
                    <p className="mt-1 text-soft">
                      A round amount, a later time or a fresh wallet makes it
                      harder to link back to you.
                    </p>
                  </div>

                  {returnedRows.map((n) => (
                    <div key={n.id} className="rounded-[16px] bg-surface px-4 py-3.5 text-[13px] leading-relaxed">
                      <p className="text-foreground">
                        {`Your cash out of ${formatAssetLabel(n.amountWei, n.asset)} didn't go out, so nothing moved. It moves to a fresh private balance first, so its proof can't be used, then shows in your balance.`}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          dismissReturnedCashOut(n.id);
                          refreshNotes();
                        }}
                        className="mt-2 font-medium underline underline-offset-4"
                      >
                        Got it
                      </button>
                    </div>
                  ))}

                  {leftoverRows.map((n) => (
                    <PieceLeftover
                      key={n.id}
                      note={n}
                      busy={working}
                      scheduling={leftoverBusy === n.id}
                      onSchedule={() => void scheduleLeftover(n)}
                      onKeep={() => {
                        keepPiece(n.id);
                        refreshNotes();
                      }}
                    />
                  ))}

                  {selected && (
                    <div className="rounded-[16px] bg-surface p-[16px] sm:p-5">
                      <label htmlFor="cashout-amt" className="text-[13px] text-mute">
                        Amount
                      </label>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          id="cashout-amt"
                          inputMode="decimal"
                          autoComplete="off"
                          value={cashOutInput}
                          onChange={(e) => setCashOutInput(e.target.value)}
                          placeholder={maxEth}
                          aria-describedby="cashout-amt-help"
                          className="tnum min-w-0 flex-1 bg-transparent text-[32px] font-light leading-[1.25] tracking-[-0.02em] text-foreground outline-none! placeholder:text-foreground"
                        />
                        <span className="shrink-0 text-[15px] text-mute">{assetLabel(selected.asset)}</span>
                      </div>
                      <p id="cashout-amt-help" className={`mt-1 text-[12.5px] leading-relaxed ${cashOutAmountInvalid ? "text-warn" : "text-mute"}`}>
                        {cashOutAmountInvalid
                          ? (amountTextError(cashOutInput, assetDecimals(selected.asset)) ??
                            `Enter an amount up to ${formatAssetLabel(noteWei, selected.asset)}.`)
                          : cashOutPartial
                            ? planActive
                              ? `First this sets ${formatAssetLabel(cashOutAmount, selected.asset)} aside privately in pieces, then schedules each one. The rest stays in your private balance.`
                              : `First this sets ${formatAssetLabel(cashOutAmount, selected.asset)} aside privately, then cashes it out. The rest stays in your private balance.`
                            : `The whole balance: ${formatAssetLabel(noteWei, selected.asset)}.`}
                      </p>
                      <CashOutAmountChips
                        presets={cashOutPresets}
                        current={cashOutAmountInvalid ? null : typedWei}
                        maxActive={cashOutInput.trim() === ""}
                        onPick={setCashOutInput}
                        onMax={() => setCashOutInput("")}
                        disabled={working}
                        extra={
                          // only where it changes something: there are cents to drop and whole units left
                          roundsTo > 0n && roundsTo !== roundFrom ? (
                            <button type="button" className="gl-chip min-h-10" disabled={working} onClick={roundCashOut}>
                              Round it
                            </button>
                          ) : null
                        }
                      />
                      <CashOutWarnings
                        warnings={amountWarnings}
                        scope={selected.id}
                        disabled={working}
                        amountAction={
                          planOffered && !privatePref ? (
                            <button
                              type="button"
                              disabled={working}
                              onClick={() => choosePrivately(true)}
                              className="-my-1.5 inline-flex min-h-10 items-center font-medium underline underline-offset-4 disabled:opacity-50"
                            >
                              Cash out privately instead
                            </button>
                          ) : null
                        }
                      />
                      {/* the broader note (close amounts, payments received, timing) when the exact-deposit warning has not said it */}
                      {cashOutLink && amountWarnings.length === 0 && (
                        <CashOutLinkNote
                          text={linkMessage(cashOutLink)}
                          action={
                            planOffered && !privatePref ? (
                              <button
                                type="button"
                                onClick={() => choosePrivately(true)}
                                className="font-medium text-foreground underline underline-offset-4"
                              >
                                Cash out privately instead
                              </button>
                            ) : !planOffered ? (
                              relayAvailable ? "Cashing out later, or a different amount, keeps them apart." : "A different amount keeps them apart."
                            ) : null
                          }
                        />
                      )}
                      {xActive && xDestination ? (
                        <div className="mt-4 border-t border-line pt-3">
                          <p className="tnum text-[12.5px] leading-relaxed text-mute">
                            {cashOutFeeBps > 0
                              ? `${formatFeePercent(cashOutFeeBps)} fee: ${formatAssetLabel(cashOutFee, selected.asset)}. Relay gets ${formatAssetLabel(xNet, selected.asset)} and sends ${xDestination.token.symbol} on ${xDestination.chain}.`
                              : `Relay gets ${formatAssetLabel(xNet, selected.asset)} and sends ${xDestination.token.symbol} on ${xDestination.chain}.`}
                          </p>
                        </div>
                      ) : (
                      <div className="mt-4 border-t border-line pt-3">
                        <p className="text-[13px] text-mute">You get</p>
                        <p className="tnum mt-1.5 truncate text-[22px] font-light leading-tight text-foreground">
                          {formatAssetAmount(cashOutAmount - outFee, selected.asset)}{" "}
                          <span className="text-[14px] text-mute">{assetLabel(selected.asset)}</span>
                        </p>
                        {cashOutFeeBps > 0 && (
                          <p className="tnum mt-1 text-[12.5px] text-mute">
                            {formatFeePercent(cashOutFeeBps)} fee{planActive ? " in total" : ""}: {formatAssetLabel(outFee, selected.asset)}
                          </p>
                        )}
                      </div>
                      )}
                      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3 text-[13px]">
                        <span className="text-mute">
                          In the vault ({assetLabel(selected.asset)})
                        </span>
                        <span className="tnum truncate text-foreground">
                          {poolForCashOut != null
                            ? formatAssetLabel(poolForCashOut, selected.asset)
                            : "Checking…"}
                        </span>
                      </div>
                      {cashOutInventoryShort ? (
                        <p className="mt-2 text-[12.5px] leading-relaxed text-warn">
                          Not enough in the vault to pay this out yet. Cash out
                          opens once more {assetLabel(selected.asset)} is added.{" "}
                          <Link
                            href="/app/vault?tab=shield"
                            className="font-medium underline underline-offset-4"
                          >
                            Add more
                          </Link>
                        </p>
                      ) : poolForCashOut != null ? (
                        <p className="mt-2 text-[12.5px] text-mute">
                          The vault can cover this cash out.
                        </p>
                      ) : null}
                    </div>
                  )}

                  {selected && xDestinations.length > 0 && (
                    <CrossChainPicker
                      chainId={network.chainId}
                      chainLabel={network.label}
                      symbol={assetLabel(selected.asset)}
                      destinations={xDestinations}
                      value={xDestination ? xDestination.id : null}
                      onChange={(id) => {
                        setXDestId(id);
                        setXQuote(null);
                      }}
                      disabled={working}
                    />
                  )}

                  {xDestination?.kind !== "svm" && (
                  <div>
                    <p id="cashout-to" className="text-[13px] text-mute">{xDestination ? `To, on ${xDestination.chain}` : "To"}</p>
                    <div role="radiogroup" aria-labelledby="cashout-to" className="mt-2 grid grid-cols-2 gap-2">
                      {(
                        [
                          ["mine", "My wallet", address ? shortAddress(address) : "Connect a wallet"],
                          ["other", "Another address", "A fresh one is best"],
                        ] as const
                      ).map(([dest, label, hint]) => {
                        const active = cashOutDest === dest;
                        return (
                          <button
                            key={dest}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => setCashOutDest(dest)}
                            className={`flex min-h-[60px] min-w-0 items-start gap-3 rounded-[14px] border px-3.5 py-3 text-left transition-colors ${
                              active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                            }`}
                          >
                            <span
                              aria-hidden
                              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors ${
                                active ? "border-foreground bg-foreground" : "border-line-strong"
                              }`}
                            >
                              {active && <span className="h-2 w-2 rounded-full bg-panel" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[14.5px] leading-snug text-foreground">{label}</span>
                              <span className="mt-0.5 block text-[12px] leading-snug text-mute">{hint}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {cashOutDest === "other" && (
                      <>
                        <label htmlFor="cashout-other" className="sr-only">
                          Address to cash out to
                        </label>
                        <input
                          id="cashout-other"
                          value={otherTo}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => setOtherTo(e.target.value.trim())}
                          placeholder="0x… a wallet that never added money to Gloam"
                          className="gl-input tnum mt-3"
                        />
                        {otherToClean && !isAddress(otherToClean) && (
                          <p className="mt-2 text-[12.5px] text-warn">That isn&apos;t a valid 0x address. Check it and paste it again.</p>
                        )}
                      </>
                    )}
                    {selected && (
                      <CashOutWarnings warnings={addressWarnings} scope={selected.id} onElsewhere={cashOutElsewhere} disabled={working} />
                    )}
                    {addressWarnings.length === 0 && cashOutDest === "other" && cashOutTo ? (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                        For privacy, a fresh wallet that never added money to Gloam is best.
                      </p>
                    ) : null}
                    {sweepNow?.swept && cashOutTo && sweepSays === "own-wallet" ? (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                        Money that reached this Gloam wallet left again soon after, in a transaction another account sent.
                        Adding money privately with the network fee covered looks like that. If you didn&apos;t add
                        money privately, someone else may be moving money out of this wallet: don&apos;t cash out
                        here, and sign out.{" "}
                        <a
                          href={network.explorerTx(sweepNow.swept.evidenceTx)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground underline underline-offset-2"
                        >
                          See it on the explorer
                        </a>
                      </p>
                    ) : sweepNow?.swept && cashOutTo ? (
                      <SweptWarning
                        address={cashOutTo}
                        evidenceHref={network.explorerTx(sweepNow.swept.evidenceTx)}
                        accepted={!sweepHold}
                        onOtherAddress={() => {
                          setCashOutDest("other");
                          setOtherTo("");
                        }}
                        onAccept={() => setSweepOkFor(sweepKey)}
                      />
                    ) : sweepNow?.delegated ? (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                        This address hands control to a contract (EIP-7702). Some smart wallets do that on purpose. If you
                        didn&apos;t set it up, cash out to another address.
                      </p>
                    ) : null}
                  </div>
                  )}

                  {xDestination && selected && (
                    <CrossChainQuoteCard
                      networkKey={network.key}
                      chainId={network.chainId}
                      asset={selected.asset}
                      destination={xDestination}
                      netAmount={xNet}
                      evmRecipient={xDestination.kind === "evm" ? cashOutTo : null}
                      refundTo={(address as Address | undefined) ?? null}
                      ready={!cashOutAmountInvalid && !cashOutFeeUnknown && xNet > 0n}
                      quote={xPrice}
                      onQuote={setXQuote}
                      disabled={working}
                    />
                  )}

                  {planOffered && plan && (
                    <HowChoice
                      privately={privatePref}
                      onChange={choosePrivately}
                      pieceCount={planPieceList.length}
                      window={planWindow}
                      disabled={working}
                    />
                  )}

                  {planActive && plan && selected && (
                    <>
                      <PiecesCard
                        pieces={planPieceList}
                        asset={selected.asset}
                        amount={planTotal}
                        avoiding={avoiding}
                        tailMatch={plan.tailMatch}
                        run={planRun}
                        onReroll={working ? undefined : () => setPlanSeed((v) => v + 1)}
                        onRound={roundCashOut}
                      />
                      <SpreadOver
                        value={planWindow}
                        disabled={working}
                        onChange={(w) => {
                          setPlanWindow(w);
                          savePrivatePref({ window: w });
                        }}
                      />
                      <div>
                        <p className="text-[12.5px] leading-relaxed text-mute">{whereLine}</p>
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => setPerPiece((v) => !v)}
                          className="-my-1 inline-flex min-h-10 items-center text-[13px] font-medium text-foreground underline underline-offset-4 disabled:opacity-50"
                        >
                          {perPiece ? "Send them all to one address" : "Use a different address for each piece"}
                        </button>
                        {perPiece && (
                          <div className="mt-2 space-y-3">
                            <p className="text-[12.5px] leading-relaxed text-mute">
                              {`Piece 1, ${formatAssetLabel(plan.pieces[0]!, selected.asset)}, goes to the address under To.`}
                            </p>
                            {plan.pieces.slice(1).map((p, k) => {
                              const v = pieceTo[k] ?? "";
                              const ok = isAddress(v);
                              return (
                                <div key={k}>
                                  <label htmlFor={`piece-to-${k + 2}`} className="text-[13px] text-mute">
                                    {`Piece ${k + 2}, ${formatAssetLabel(p, selected.asset)}`}
                                  </label>
                                  <input
                                    id={`piece-to-${k + 2}`}
                                    value={v}
                                    autoComplete="off"
                                    spellCheck={false}
                                    disabled={working}
                                    onChange={(e) => {
                                      const next = [...pieceTo];
                                      next[k] = e.target.value.trim();
                                      setPieceTo(next);
                                    }}
                                    placeholder="0x… another address"
                                    className="gl-input tnum mt-2"
                                  />
                                  {v && !ok ? (
                                    <p className="mt-2 text-[12.5px] text-warn">That isn&apos;t a valid 0x address. Check it and paste it again.</p>
                                  ) : ok && tiedToYou(v) ? (
                                    <p className="mt-2 text-[12.5px] leading-relaxed text-warn">This wallet is tied to you, so this piece can be linked back.</p>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {!planActive && !xActive && (
                  <div>
                    <p id="cashout-when" className="text-[13px] text-mute">When</p>
                    <div role="radiogroup" aria-labelledby="cashout-when" className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {(
                        [
                          ["now", "Now"],
                          ["hour", "Within an hour"],
                          ["6h", "Within 6 hours"],
                          ["day", "Within a day"],
                        ] as const
                      ).map(([when, label]) => {
                        const active = cashOutWhen === when;
                        const off = when !== "now" && !relayAvailable;
                        return (
                          <button
                            key={when}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={off}
                            onClick={() => setCashOutWhen(when)}
                            className={`min-h-[48px] rounded-[14px] border px-2 py-2.5 text-center text-[13.5px] leading-snug transition-colors disabled:opacity-40 ${
                              active ? "border-foreground bg-panel text-foreground" : "border-line text-soft hover:border-line-strong hover:bg-surface"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                      {cashOutWhen === "now"
                        ? relayAvailable
                          ? "Later sends it at a random time in that window, so it doesn't go out right after a payment."
                          : "Cashing out later needs the Gloam relay, which is off right now."
                        : "Your proof is made now and the Gloam relay sends it at a random time in that window. It can't change the amount or where it goes. The vault takes its fee when it goes out, at the rate then. If it can't go out, nothing moves and it comes back to your private balance."}
                    </p>
                    {cashOutWhen !== "now" && (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
                        A proof shows roughly when it was made. While Gloam is open it swaps in a fresh one now and then, so
                        leaving it open until the send hides the most. If it goes out while Gloam is closed, it shows when
                        its proof was last made.
                      </p>
                    )}
                  </div>
                  )}

                  {!planActive && relayToggle}
                  {selected && (
                    <CashOutPrivacyLine
                      pieces={planActive}
                      sender={cashOutSender({ relayOn, pieces: planActive, later: cashOutWhen !== "now", partial: cashOutPartial })}
                    />
                  )}
                  {!connectedOk ? (
                    connectPrompt("cash out")
                  ) : (
                    <button
                      type="button"
                      disabled={
                        !isConnected ||
                        !onProduct ||
                        !selected ||
                        matchesChain === false ||
                        treeLoading ||
                        !relayChecked ||
                        working ||
                        cashOutChecking ||
                        selected?.leafIndex == null ||
                        cashOutInventoryShort ||
                        cashOutFeeUnknown ||
                        cashOutAmountInvalid ||
                        (xActive ? !xPrice : !cashOutTo) ||
                        sweepHold ||
                        (planActive ? !piecesReady : cashOutWhen !== "now" && !relayAvailable)
                      }
                      onClick={() => void startCashOut()}
                      className="btn btn-ink btn-lg btn-block"
                    >
                      {working && busyAction === "cashout" ? (
                        <>
                          <Spinner />
                          <span className="truncate">{status || "Working…"}</span>
                        </>
                      ) : cashOutChecking ? (
                        <>
                          <Spinner />
                          <span className="truncate">Checking…</span>
                        </>
                      ) : cashOutInventoryShort ? (
                        "Not enough in the vault yet"
                      ) : cashOutFeeUnknown ? (
                        "Loading the cash-out fee…"
                      ) : sweepHold ? (
                        "Check the address first"
                      ) : xActive && xDestination ? (
                        xPrice ? `Cash out to ${xDestination.chain}` : "Waiting for the price"
                      ) : planActive ? (
                        piecesReady || !perPiece ? "Cash out privately" : "Add an address for each piece"
                      ) : cashOutWhen !== "now" ? (
                        "Schedule the cash out"
                      ) : cashOutDest === "other" ? (
                        "Cash out to this address"
                      ) : (
                        "Cash out to my wallet"
                      )}
                    </button>
                  )}
                  {planActive && connectedOk && (
                    <div className="-mt-1 text-center">
                      <p className="text-[12.5px] leading-relaxed text-mute">
                        {working
                          ? "Keep this tab open until every piece is scheduled."
                          : "Setting it up takes a few minutes. Keep this tab open until every piece is scheduled."}
                      </p>
                      {!working && (
                        <button
                          type="button"
                          onClick={() => {
                            choosePrivately(false);
                            setCashOutWhen("now");
                          }}
                          className="inline-flex min-h-10 items-center text-[13px] font-medium text-foreground underline underline-offset-4"
                        >
                          Send it all now instead
                        </button>
                      )}
                    </div>
                  )}
                  {selected?.leafIndex == null && (
                    <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-warn">
                      This balance is not linked to the vault yet.
                      <button
                        type="button"
                        onClick={() => void refreshTree()}
                        className="font-medium underline underline-offset-4"
                      >
                        Refresh
                      </button>
                    </p>
                  )}

                  {scheduledNotice && (
                    <div className="rounded-[16px] bg-sealed-soft px-4 py-3.5 text-[13px] leading-relaxed text-foreground">
                      {scheduledNotice.count && scheduledNotice.count > 1 && scheduledNotice.until
                        ? `${scheduledNotice.count} pieces, ${scheduledNotice.label} in all, scheduled to go out between ${aboutTime(scheduledNotice.at)} and ${aboutTime(scheduledNotice.until).replace(/^about /, "")}. You can close Gloam: the relay sends each one then.`
                        : `Cash out of ${scheduledNotice.label} scheduled for ${aboutTime(scheduledNotice.at)}. You can close Gloam: the relay sends it then.`}
                    </div>
                  )}

                  <ScheduledCashOuts rows={scheduledRows} liveFeeBps={liveFeeBps} gasHigh={gasHigh} onCancel={cancelScheduled} />
                </div>
              )}
            </>
          ) : mode !== "receive" ? (
            <>
            {/* The whole balance can be waiting to go out: its rows, and Cancel, still show. */}
            {mode === "cashout" && scheduledRows.length > 0 && (
              <div className="mt-6">
                <ScheduledCashOuts rows={scheduledRows} liveFeeBps={liveFeeBps} gasHigh={gasHigh} onCancel={cancelScheduled} />
              </div>
            )}
            <div className="mt-6 rounded-[16px] bg-surface px-5 py-9 text-center">
              <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-panel text-mute shadow-card">
                <LockIcon />
              </span>
              <p className="mt-4 text-[15px] text-foreground">
                Nothing in your private balance yet
              </p>
              <p className="mx-auto mt-1.5 max-w-[40ch] text-[13.5px] leading-relaxed text-mute">
                Add money first, or open Receive to claim a payment someone sent
                you.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Link href="/app/vault?tab=shield" className="btn btn-ink">
                  Add money
                </Link>
                <button
                  type="button"
                  onClick={() => selectMode("receive")}
                  className="btn btn-ghost"
                >
                  Receive
                </button>
              </div>
            </div>
            </>
          ) : null}

          {mode === "send" && shieldLive && <SentLinks onTakeBack={takeBackLink} />}

          {mode === "receive" && (
            <div className="mt-6 space-y-7">
              <section id="gloam-address" tabIndex={-1} aria-labelledby="gloam-address-title" className="scroll-mt-24 outline-none">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="gloam-address-title" className="text-[15px] font-medium text-foreground">
                    Your Gloam address
                  </h3>
                  {myIdentity && (
                    <button
                      type="button"
                      onClick={() => {
                        void rotateReceiveIdentity().then(setMyIdentity);
                      }}
                      title="Makes a new address to share. Payments to your earlier addresses still open in this browser."
                      className="btn btn-quiet btn-sm -mr-2 text-mute"
                    >
                      New address
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-mute">
                  Share it once. People paste it to pay you privately. Payments
                  open only in{" "}
                  <strong className="font-medium text-foreground">this browser</strong>,
                  so back up your account before you clear your data.
                </p>
                {myIdentity ? (
                  <>
                    <div className="mt-3 rounded-[16px] border border-line p-[16px]">
                      <p className="tnum break-all text-[13px] leading-relaxed text-foreground">
                        {myIdentity.tag}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(myIdentity.tag);
                              setTagCopied(true);
                              setTimeout(() => setTagCopied(false), 2000);
                            } catch {
                              setError("Could not copy your address.");
                            }
                          }}
                          aria-live="polite"
                          className="btn btn-ink"
                        >
                          {tagCopied ? "Copied" : "Copy address"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const el = document.getElementById("req-amount");
                            const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                            el?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
                            el?.focus({ preventScroll: true });
                          }}
                          className="btn btn-ghost"
                        >
                          Request a payment
                        </button>
                      </div>
                    </div>
                    <div className="mt-3">
                      <PaymentTicketShare
                        code={myIdentity.tag}
                        amountLabel={null}
                        locked={false}
                      />
                    </div>
                  </>
                ) : (
                  <p className="mt-3 rounded-[16px] bg-surface p-[16px] text-[13px] text-mute">
                    Making your address… This needs a secure browser connection.
                  </p>
                )}
              </section>

              {myIdentity && (
                <section className="border-t border-line pt-6">
                  <h3 className="text-[15px] font-medium text-foreground">
                    Request a payment
                  </h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-mute">
                    Make a link with the amount and a note filled in, like an
                    invoice. They open it, check it and pay you privately.
                  </p>
                  <RequestPaymentCard tag={myIdentity.tag} />
                </section>
              )}

              <section className="border-t border-line pt-6">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[15px] font-medium text-foreground">
                    Payments to you
                  </h3>
                  <button
                    type="button"
                    onClick={() => void scanInbox()}
                    disabled={scanning}
                    className="btn btn-ghost btn-sm"
                  >
                    {scanning ? (
                      <>
                        <Spinner />
                        Checking…
                      </>
                    ) : (
                      "Check now"
                    )}
                  </button>
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-mute">
                  When someone pays your Gloam address, it shows up here on its
                  own. No QR needed.
                  {memoLive
                    ? ""
                    : " Not available on this network yet, so paste the claim link below."}
                </p>
                {inboxStatus && (
                  <p className="mt-3 text-[13px] text-soft" aria-live="polite">
                    {inboxStatus}
                  </p>
                )}
                {inbox.length > 0 && (
                  <ul className="mt-3 divide-y divide-line overflow-hidden rounded-[16px] border border-line">
                    {inbox.map((row) => (
                      <li
                        key={row.memo.paymentCommitment}
                        className="flex min-h-14 items-center justify-between gap-3 px-4 py-2"
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed">
                            <LockIcon size={13} />
                          </span>
                          <span className="min-w-0">
                            <span className="tnum block truncate text-[15px] text-foreground">
                              {row.label}
                            </span>
                            {row.note ? (
                              <PaymentNoteLine
                                note={row.note}
                                className="text-[12px] text-soft"
                              />
                            ) : (
                              <span className="block text-[12px] text-mute">
                                Private payment
                              </span>
                            )}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm shrink-0"
                          onClick={() => {
                            setImportText(row.ticket);
                            dropClaimLink();
                            setClaimPreview({
                              text: `Selected ${row.label} from your payments.`,
                              note: row.note,
                            });
                          }}
                        >
                          Select
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section id="claim-payment" className="scroll-mt-24 border-t border-line pt-6">
                <h3 className="text-[15px] font-medium text-foreground">
                  Claim a payment
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-mute">
                  Paste the claim link or payment code you were sent. Codes start
                  with gloam3, gloam1, gloam1e or gloam2t. Claiming also secures it: the
                  payment moves into a balance only you hold, so the person who
                  sent it can no longer take it back.
                </p>
                <label htmlFor="claim-code" className="sr-only">
                  Claim link or payment code
                </label>
                <textarea
                  id="claim-code"
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    dropClaimLink();
                  }}
                  rows={4}
                  spellCheck={false}
                  className="gl-input tnum mt-3 h-auto min-h-[108px] resize-none py-3 text-[13px] leading-relaxed"
                  placeholder="gloam.trade/c#…, gloam3… or gloam1…"
                />
                {claimPreview && (
                  <div className="mt-2 rounded-xl bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-soft" aria-live="polite">
                    <p>{claimPreview.text}</p>
                    {claimPreview.note && (
                      <PaymentNoteLine
                        note={claimPreview.note}
                        label="Their note"
                        className="mt-1 text-foreground"
                      />
                    )}
                  </div>
                )}
                {(paymentCodeIn(importText).startsWith("gloam1e.") ||
                  (isEncryptedPackage(importText) &&
                    !isPayToTagSealed(importText))) && (
                  <div className="mt-4">
                    <label htmlFor="recv-pass" className="text-[13px] text-mute">
                      Phrase
                    </label>
                    <input
                      id="recv-pass"
                      type="text"
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={importPassphrase}
                      onChange={(e) => setImportPassphrase(e.target.value)}
                      placeholder="The phrase the sender gave you"
                      className="gl-input mt-2"
                    />
                  </div>
                )}
                <div className="mt-4 space-y-4">
                  {relayToggle}
                  {!isConnected ? (
                    connectPrompt("claim it")
                  ) : (
                    <button
                      id="claim-submit"
                      type="button"
                      onClick={() => void onImportNote()}
                      disabled={!importText.trim() || !isConnected || working || claimOpening}
                      className="btn btn-ink btn-lg btn-block"
                    >
                      {securingId ? (
                        <>
                          <Spinner />
                          <span className="truncate">{status || "Securing…"}</span>
                        </>
                      ) : claimOpening ? (
                        <>
                          <Spinner />
                          <span className="truncate">Opening the payment…</span>
                        </>
                      ) : (
                        "Claim and secure"
                      )}
                    </button>
                  )}
                  {relayChecked && <ClaimSafetyLine free={relayAvailable && relayOn} />}
                </div>
              </section>
            </div>
          )}

          {(error || writeError) && (
            <p
              role="alert"
              className="mt-5 break-words rounded-xl bg-danger-soft px-4 py-3 text-[13.5px] leading-relaxed text-danger"
            >
              {error || walletErrorForPeople(writeError)}
            </p>
          )}
          {txHash && !isSuccess && (
            <p className="mt-4 flex items-center justify-center gap-2 text-[13.5px] text-mute">
              Submitted.
              <a
                href={network.explorerTx(txHash)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                View transaction
              </a>
            </p>
          )}
        </div>

        <aside className="space-y-4">
          {mode === "receive" ? (
            <div className="gl-card p-5">
              <p className="text-[13px] text-mute">About your Gloam address</p>
              <ul className="mt-3 divide-y divide-line text-[13.5px] leading-relaxed">
                <li className="py-3">
                  <p className="text-foreground">Not a wallet address</p>
                  <p className="mt-0.5 text-mute">
                    It never shows up on the explorer, so nobody can look up what
                    you receive.
                  </p>
                </li>
                <li className="py-3">
                  <p className="text-foreground">Opens in this browser</p>
                  <p className="mt-0.5 text-mute">
                    Back up your account in{" "}
                    <Link
                      href="/app/settings"
                      className="text-foreground underline underline-offset-4"
                    >
                      Settings
                    </Link>{" "}
                    so you can open payments on another device.
                  </p>
                </li>
                <li className="py-3">
                  <p className="text-foreground">Requests stay private</p>
                  <p className="mt-0.5 text-mute">
                    A request link carries your address, the amount and a note.
                    When they pay, the note comes back sealed inside the
                    payment, so only the two of you can read it.
                  </p>
                </li>
                <li className="pt-3">
                  <p className="text-foreground">Claim links work too</p>
                  <p className="mt-0.5 text-mute">
                    Paste one under Claim a payment. It lands in your private
                    balance and is secured straight away, so the person who sent
                    it cannot take it back.
                  </p>
                </li>
              </ul>
            </div>
          ) : (
            <>
              <PrivateBalanceCard rows={totals} />
              <div className="gl-card p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[13px] text-mute">What the explorer shows</p>
                  {mode === "send" ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 py-0.5 text-[12px] font-medium text-sealed">
                      <LockIcon size={10} />
                      Private
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-surface px-2.5 py-0.5 text-[12px] text-mute">
                      Public
                    </span>
                  )}
                </div>
                <dl className="mt-3 divide-y divide-line text-[14px]">
                  <div className="flex h-11 items-center justify-between gap-3">
                    <dt className="text-mute">Sent by</dt>
                    <dd className="truncate text-foreground">
                      {relayOn || (mode === "cashout" && (planActive || cashOutWhen !== "now")) ? "Gloam relay" : "Your wallet"}
                    </dd>
                  </div>
                  <div className="flex h-11 items-center justify-between gap-3">
                    <dt className="text-mute">To</dt>
                    <dd className="tnum truncate text-foreground">
                      {mode === "send" ? (
                        <SealDots n={6} className="text-foreground/60" />
                      ) : planActive && perPiece && distinctTargets > 1 ? (
                        `${distinctTargets} addresses`
                      ) : cashOutTo ? (
                        shortAddress(cashOutTo, 4)
                      ) : (
                        "Your wallet"
                      )}
                    </dd>
                  </div>
                  <div className="flex h-11 items-center justify-between gap-3">
                    <dt className="text-mute">Amount</dt>
                    <dd className="tnum truncate text-foreground">
                      {mode === "send" ? (
                        <SealDots n={6} className="text-foreground/60" />
                      ) : planActive ? (
                        `${planPieceList.length} separate amounts`
                      ) : selected && !cashOutAmountInvalid ? (
                        formatAssetLabel(cashOutAmount, selected.asset)
                      ) : (
                        "The full amount"
                      )}
                    </dd>
                  </div>
                  <IssuerPolicyRow chainId={network.chainId} asset={mode === "cashout" ? selected?.asset : null} flow="cashout" />
                </dl>
                <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
                  {mode === "send"
                    ? relayOn
                      ? "Nothing on the explorer links this payment to you or to them."
                      : relayAvailable
                        ? "Turn on Hide my wallet so your wallet stays off it too."
                        : "The amount and the person you pay stay hidden. Your wallet shows as the sender while the relay is offline."
                    : planActive
                      ? "Each piece is a public transfer at its own time. Together they end privacy for this amount."
                      : "A cash out is a public transfer. It ends privacy for this amount."}
                </p>
              </div>
            </>
          )}
        </aside>
      </div>

      <SuccessModal
        open={showSuccess && Boolean(txHash)}
        title={successTitle}
        hold={mustSaveCode && savedCode !== shareBlob ? "Save the code to finish" : null}
        detail={
          mustSaveCode && shareBlob ? (
            <PaymentTicketShare
              code={shareBlob}
              amountLabel={shareAmountLabel}
              locked={shareLocked}
              stacked
              onSaved={() => setSavedCode(shareBlob)}
            />
          ) : undefined
        }
        body={
          busyAction === "send" ||
          busyAction === "memo" ||
          shareBlob ? (
            <>
              <p>
                {memoPosted
                  ? "They got a private heads-up, so the payment shows up under Receive on their side. The claim code on the page is a backup."
                  : "This code is the money. Copy, download or share it now. A copy stays under Sent links in this browser only, and anything left over stays in your private balance."}
              </p>
              {sentNote && (
                <p className="mt-3 break-words">
                  Your note went with it:{" "}
                  <span className="text-foreground">{sentNote}</span>
                </p>
              )}
            </>
          ) : (
            <p>
              {xSent
                ? `The vault paid Relay, and Relay sends ${xSent.destination.symbol} on ${xSent.destination.chain}.`
                : cashOutDest === "other"
                  ? "The money is on its way to that address."
                  : "The money is back in your wallet."}{" "}
              The amount and the address it went to are public on the explorer, so only cash out when you
              need it in the open.
            </p>
          )
        }
        primaryHref={txHash ? network.explorerTx(txHash) : undefined}
        primaryLabel="View on explorer"
        secondaryLabel="Done"
        footer={
          paidPrivately ? (
            <PrivatePayShare chainId={network.chainId} networkLabel={network.label} testnet={network.testnet} />
          ) : successTitle === "Cashed out" && xSent ? (
            <CrossChainCashOutStatus
              quote={xSent}
              explorerTx={crossChainDestination(xSent.destination.id)?.explorerTx ?? relayOrderUrl}
            />
          ) : successTitle === "Cashed out" && cashedOut ? (
            <AddTokenToWallet chainId={network.chainId} asset={cashedOut.asset} to={cashedOut.to} />
          ) : undefined
        }
        onClose={() => {
          setShowSuccess(false);
          setStatus(null);
        }}
      />
    </>
  );
}

/**
 * Pay → Note: an optional private note that travels inside the payment
 * (lib/paymentNote), like "Invoice 042". One quiet button until it is wanted.
 */
/**
 * Money sent to this address was moved out within seconds before, by another
 * account (lib/sweepCheck): the wallet's key is likely in someone else's hands.
 * The cash out waits until they pick another address or go ahead on purpose.
 */
function SweptWarning({
  address,
  evidenceHref,
  accepted,
  onOtherAddress,
  onAccept,
}: {
  address: Address;
  evidenceHref: string;
  accepted: boolean;
  onOtherAddress: () => void;
  onAccept: () => void;
}) {
  return (
    <div role="alert" className="mt-3 rounded-[14px] bg-warn-soft px-4 py-3.5 text-[13px] leading-relaxed text-foreground">
      <p className="font-medium text-warn">Check this address first</p>
      <p className="mt-1">
        Money sent to {shortAddress(address, 4)}{" "}
        has been moved out automatically within seconds before, by another account. If you didn&apos;t set that up, this wallet may be compromised and your cash out could be taken the
        same way.{" "}
        <a href={evidenceHref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
          See it on the explorer
        </a>
      </p>
      {accepted ? (
        <p className="mt-2 text-[12.5px] text-mute">You chose to cash out to this address anyway.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onOtherAddress} className="btn btn-ink btn-sm">
            Use another address
          </button>
          <button type="button" onClick={onAccept} className="btn btn-ghost btn-sm">
            Cash out anyway
          </button>
        </div>
      )}
    </div>
  );
}

function PayNoteField({
  value,
  open,
  onOpen,
  onChange,
  fromRequest,
  bearer,
  locked,
}: {
  value: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (value: string) => void;
  /** The note is the one the payment request asked for. */
  fromRequest: boolean;
  /** Paying with a claim link rather than to a Gloam address. */
  bearer: boolean;
  /** The claim link is locked with a phrase. */
  locked: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the field opens or closes, so it is never dropped.
  const focusNext = useRef<"input" | "add" | null>(null);
  const shown = open || value.length > 0;
  useEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    (next === "input" ? inputRef : addRef).current?.focus();
  }, [shown]);

  if (!shown) {
    return (
      <div>
        <button
          ref={addRef}
          type="button"
          onClick={() => {
            focusNext.current = "input";
            onOpen(true);
          }}
          className="-my-2 inline-flex min-h-10 items-center gap-2 text-[13px] text-mute transition-colors hover:text-foreground"
        >
          <NoteGlyph size={14} />
          Add a note
        </button>
      </div>
    );
  }

  const length = Array.from(value).length;
  const hint = bearer
    ? locked
      ? "It is locked inside the claim link with your phrase, so only the person you pay can read it."
      : "It rides inside the claim link, so whoever has the link can read it. Add a phrase below to lock both."
    : "Only the person you pay can read it. It travels sealed inside the payment.";
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="pay-note" className="text-[13px] text-mute">
          Note <span className="text-faint">(optional)</span>
        </label>
        <button
          type="button"
          onClick={() => {
            focusNext.current = "add";
            onChange("");
            onOpen(false);
          }}
          className="-my-2 -mr-2 inline-flex min-h-10 items-center rounded-full px-2 text-[13px] text-mute transition-colors hover:text-foreground"
        >
          Remove note
        </button>
      </div>
      <input
        ref={inputRef}
        id="pay-note"
        type="text"
        autoComplete="off"
        maxLength={PAYMENT_NOTE_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Invoice 042"
        aria-describedby="pay-note-hint"
        className="gl-input mt-2"
      />
      <p
        id="pay-note-hint"
        className="mt-2 flex items-start gap-2 text-[12.5px] leading-relaxed text-mute"
      >
        <span className="mt-[3px] shrink-0 text-sealed" aria-hidden>
          <LockIcon size={12} />
        </span>
        <span className="min-w-0 flex-1">
          {fromRequest ? "From their request. " : ""}
          {hint}
        </span>
        {length > PAYMENT_NOTE_MAX - 20 && (
          <span className="tnum shrink-0 text-faint">
            {length}/{PAYMENT_NOTE_MAX}
          </span>
        )}
      </p>
    </div>
  );
}

type BalanceRow = {
  asset: string;
  label: string;
  logoId: string | null;
  amount: string;
};

/** The private balance, only visible to its owner. Carries the sealed glow. */
function PrivateBalanceCard({ rows }: { rows: BalanceRow[] }) {
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
              Only you
            </span>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => setHidden((v) => !v)}
                aria-pressed={hidden}
                aria-label={hidden ? "Show amounts" : "Hide amounts"}
                className="-mr-2 grid h-9 w-9 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
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
                <p className="tnum min-w-0 truncate text-[26px] font-light leading-none tracking-[-0.02em] text-foreground">
                  {hidden ? <SealDots n={6} className="text-foreground/60" /> : r.amount}{" "}
                  <span className="text-[14px] tracking-normal text-mute">{r.label}</span>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4">
            <p className="tnum text-[34px] font-light leading-none tracking-[-0.02em] text-foreground">
              0
            </p>
            <p className="mt-2 max-w-[30ch] text-[13px] leading-relaxed text-mute">
              Add money or claim a payment to start. Nobody else can see this.
            </p>
          </div>
        )}
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

function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80 motion-reduce:animate-none"
      aria-hidden
    />
  );
}
