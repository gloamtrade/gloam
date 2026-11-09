"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Address } from "viem";
import {
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { exitDemo, useAppAccount } from "@/lib/demo";
import { ensureRhTestnetWallet, ensureWalletOnChain, shortAddress } from "@/lib/chain";
import { allNetworks, networkName, type GloamChainId } from "@/lib/networks";
import { ORIGIN_CHAINS } from "@/lib/originChains";
import {
  FEE_MANAGER,
  OUSD,
  TEMPO_CHAIN_ID,
  TEMPO_SPONSORED,
  isTempoFeeChain,
  feeManagerAbi,
  tempoStableSymbol,
} from "@/lib/feeSponsor";
import { isTempoWallet, preloadTempoWallet } from "@/lib/tempoWallet";
import { WALLETCONNECT_ID, prefersWalletConnect } from "@/lib/walletConnect";
import { EMBEDDED_CONNECTOR_ID } from "@/lib/embeddedWallet";
import { walletDeclined } from "@/lib/walletErrors";
import { embeddedAvailability, onEmbeddedAvailability, openEmbeddedSheet, signOutEmbedded } from "@/lib/turnkeyBridge";
import { useNetwork } from "./NetworkProvider";
import { TURNKEY_ENABLED } from "./TurnkeyEmbeddedProvider";
import { ClientOnly } from "./ClientOnly";

// Email and passkey sign-in (Gloam wallets) ships only when Turnkey is switched on.
const TurnkeyHeaderSignIn = dynamic(() =>
  import("./TurnkeyHeaderSignIn").then((m) => m.TurnkeyHeaderSignIn),
);

// The wallet-app sheet (and its animation library) loads the first time it opens, not with every app page.
const WalletConnectSheet = dynamic(() => import("./WalletConnectSheet").then((m) => m.WalletConnectSheet), { ssr: false });

/**
 * Where the wallet control sits, which sets its shape:
 * - `sidebar`: full-width block at the foot of the desktop sidebar; the
 *   connected state is an account row whose menu opens upward.
 * - `compact`: a small pill for the 56px mobile top bar; menu drops down.
 * - `inline`: inside a form or card, where it stands in for the submit
 *   button, so the connect state is a full-width primary pill.
 * Left unset, it reads its surroundings after mount (`.gl-sidebar` means
 * sidebar, `.gl-mobilebar` means compact, anything else is inline).
 */
export type WalletMenuVariant = "sidebar" | "compact" | "inline";

function detectVariant(el: HTMLElement | null): WalletMenuVariant {
  if (!el) return "inline";
  if (el.closest(".gl-sidebar")) return "sidebar";
  if (el.closest(".gl-mobilebar")) return "compact";
  return "inline";
}

/**
 * What to call the chain a wallet reports, for "Your wallet is on …": Gloam's
 * own networks by name, the chains the bridge pays from by theirs, any other
 * by its id.
 */
function walletChainName(id: number): string {
  const own = allNetworks().find((n) => n.chainId === id);
  if (own) return networkName(own);
  return ORIGIN_CHAINS.find((c) => c.id === id)?.name ?? `chain ${id}`;
}

export function WalletMenu({ variant }: { variant?: WalletMenuVariant } = {}) {
  const { address, isConnected, isConnecting, chainId, demo, connector } =
    useAppAccount();
  const { connect, connectors, isPending, error, variables, reset } = useConnect();
  const { disconnect: wagmiDisconnect, disconnectAsync } = useDisconnect();
  const embedded = connector?.id === EMBEDDED_CONNECTOR_ID;
  // A Gloam wallet signs out of Turnkey: disconnecting alone would connect it again.
  const disconnect = demo ? exitDemo : () => (embedded ? void signOutEmbedded() : wagmiDisconnect());
  const { network } = useNetwork();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  // Gloam wallets: offered while the Turnkey kit can work on this page.
  const embeddedState = useSyncExternalStore(onEmbeddedAvailability, embeddedAvailability, () => "starting" as const);
  const offerEmbedded = TURNKEY_ENABLED && embeddedState !== "unavailable";
  // `wc`: no wallet in this browser, so "use a wallet" opens WalletConnect
  const [env, setEnv] = useState<{ mounted: boolean; auto: WalletMenuVariant; wc: boolean }>(
    { mounted: false, auto: "inline", wc: false }
  );
  const [wcOpen, setWcOpen] = useState(false);
  // mounted from its first opening on, so it can animate out when it closes
  const [wcShown, setWcShown] = useState(false);
  const closeWc = useCallback(() => setWcOpen(false), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const mounted = env.mounted;

  useEffect(
    () => setEnv({ mounted: true, auto: detectVariant(root.current), wc: prefersWalletConnect() }),
    []
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Injected wallet (MetaMask, etc.) is the fallback, not a passkey connector.
  const walletConnector =
    connectors.find(
      (c) => c.id !== EMBEDDED_CONNECTOR_ID && c.id !== WALLETCONNECT_ID && !isTempoWallet(c)
    ) ?? connectors[0];
  const wc = env.wc;
  const canUseWallet = wc || Boolean(walletConnector);
  // A browser wallet connects in place; with none here, a wallet app does.
  function openWallet() {
    if (wc) {
      setWcShown(true);
      setWcOpen(true);
    }
    else if (walletConnector) connect({ connector: walletConnector });
  }
  const sheet = wc && wcShown ? <WalletConnectSheet open={wcOpen} onClose={closeWc} /> : null;
  // Passkey sign-in (Tempo Wallet) is offered on Tempo testnet, where it lives,
  // unless Gloam wallets are on: they sign in with a passkey on every network.
  const passkeyConnector =
    network.key === "tempo" && !offerEmbedded ? connectors.find((c) => isTempoWallet(c)) : undefined;
  const offerPasskey = Boolean(passkeyConnector) && !isConnected && !demo;

  // Load the wallet SDK while the button is visible, so a click can open the
  // wallet popup inside the same user gesture.
  useEffect(() => {
    if (offerPasskey) preloadTempoWallet();
  }, [offerPasskey]);

  async function onSwitch() {
    setBusy(true);
    setSwitchFailed(false);
    try {
      try {
        await switchChainAsync({ chainId: network.chainId });
      } catch (e) {
        // turned down in the wallet: no second prompt, no error
        if (walletDeclined(e)) return;
        // Robinhood Chain testnet keeps its old fallback; every other network adds its own chain
        await (network.key === "robinhood" ? ensureRhTestnetWallet() : ensureWalletOnChain(network.chain));
        await switchChainAsync({ chainId: network.chainId });
      }
    } catch (e) {
      // A wallet app connected before it had this chain refuses the switch
      // until it connects again; say so instead of doing nothing.
      if (!walletDeclined(e)) setSwitchFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function onCopy() {
    if (!address) return;
    void navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => undefined
    );
  }

  const v: WalletMenuVariant = variant ?? env.auto;
  const compact = v === "compact";
  const sidebar = v === "sidebar";
  // Primary pill sizing per placement. Inline stands in for a form's submit
  // button, so it matches that height.
  const primary = compact
    ? "btn btn-ink btn-sm"
    : sidebar
      ? "btn btn-ink btn-block"
      : "btn btn-ink btn-lg btn-block";

  if (!mounted) {
    // Holds the space without guessing the label. Ancestor selectors size it
    // for the top bar before the variant is known.
    return (
      <div ref={root} className={compact ? "inline-flex" : undefined}>
        <span
          aria-hidden
          className={`block rounded-full bg-surface ${
            compact
              ? "h-9 w-[92px]"
              : variant
                ? sidebar
                  ? "h-11 w-full"
                  : "h-12 w-full"
                : "h-12 w-full [.gl-sidebar_&]:h-11 [.gl-mobilebar_&]:h-9 [.gl-mobilebar_&]:w-[92px]"
          }`}
        />
      </div>
    );
  }

  if (!isConnected || !address) {
    const connecting = isPending || isConnecting;

    // Gloam wallets: email or passkey on every network, a browser wallet beside it.
    if (offerEmbedded) {
      const plainConnect = (
        <button type="button" onClick={openWallet} disabled={!canUseWallet || connecting} className={primary}>
          {!compact && <WalletGlyph />}
          {connecting ? "Connecting…" : compact ? "Connect" : "Connect wallet"}
        </button>
      );
      return (
        <div
          ref={root}
          className={
            compact
              ? "flex items-center gap-2"
              : "flex flex-col items-stretch gap-1"
          }
        >
          <ClientOnly>
            <TurnkeyHeaderSignIn
              className={primary}
              quietClassName={`text-[13px] text-mute transition-colors hover:text-foreground disabled:opacity-60 ${
                compact ? "h-9 px-1" : "h-9 w-full rounded-full hover:bg-surface"
              }`}
              fallback={plainConnect}
              onUseWallet={canUseWallet ? openWallet : undefined}
              walletLabel={wc ? "Use a wallet app" : "Use a browser wallet"}
            />
          </ClientOnly>
          <button
            type="button"
            onClick={openWallet}
            disabled={!canUseWallet || connecting}
            className={`text-[13px] text-mute transition-colors hover:text-foreground disabled:opacity-60 ${
              compact ? "h-9 px-1" : "h-9 w-full rounded-full hover:bg-surface"
            }`}
          >
            {connecting ? "Connecting…" : compact ? "Use a wallet" : wc ? "Use a wallet app" : "Use a browser wallet"}
          </button>
          {v === "inline" && (
            <p className="mt-1 text-center text-[12px] leading-snug text-mute">
              Sign in with your email or a passkey. No seed phrase.
            </p>
          )}
          {error && !compact && (
            <p className="mt-1 text-[12px] leading-snug text-danger">
              {connectErrorText(error)}
            </p>
          )}
          {sheet}
        </div>
      );
    }

    if (passkeyConnector) {
      const pendingConnector = variables?.connector;
      const signingIn =
        connecting &&
        typeof pendingConnector === "object" &&
        isTempoWallet(pendingConnector);
      const walletPending = connecting && !signingIn;
      return (
        <div
          ref={root}
          className={
            compact
              ? "flex items-center gap-2"
              : "flex flex-col items-stretch gap-1"
          }
        >
          <button
            type="button"
            onClick={() => {
              void import("@/lib/track").then(({ track }) => {
                track("wallet_connect_click", { method: "passkey" });
              });
              connect({ connector: passkeyConnector });
            }}
            disabled={connecting}
            className={primary}
          >
            {signingIn ? "Finish signing in…" : "Sign in"}
          </button>
          <button
            type="button"
            onClick={openWallet}
            disabled={!canUseWallet || connecting}
            className={`text-[13px] text-mute transition-colors hover:text-foreground disabled:opacity-60 ${
              compact ? "h-9 px-1" : "h-9 w-full rounded-full hover:bg-surface"
            }`}
          >
            {walletPending
              ? "Connecting…"
              : compact
                ? "Use a wallet"
                : wc
                  ? "Use a wallet app"
                  : "Use a browser wallet"}
          </button>
          {v === "inline" && TEMPO_SPONSORED && (
            <p className="mt-1 text-center text-[12px] leading-snug text-mute">
              Create an account or use your passkey. Network fees are covered.
            </p>
          )}
          {error && !compact && (
            <p className="mt-1 text-[12px] leading-snug text-danger">
              {connectErrorText(error)}
            </p>
          )}
          {sheet}
        </div>
      );
    }

    return (
      <div ref={root} className={compact ? "relative inline-flex" : undefined}>
        <button
          type="button"
          onClick={openWallet}
          disabled={!canUseWallet || connecting}
          className={primary}
        >
          {!compact && <WalletGlyph />}
          {connecting ? "Connecting…" : compact ? "Connect" : "Connect wallet"}
        </button>
        {error && !compact && (
          <p className="mt-2 text-[12px] leading-snug text-danger">
            {connectErrorText(error)}
          </p>
        )}
        {/* The top bar has no room under the button, so a phone gets the same message as a small card. */}
        {error && compact && (
          <div
            role="alert"
            className="absolute right-0 top-full z-50 mt-2 flex w-[min(300px,calc(100vw-2rem))] items-start gap-1 rounded-[14px] border border-line bg-panel py-2 pl-3.5 pr-1 shadow-pop"
          >
            <p className="min-w-0 flex-1 py-1 text-[12.5px] leading-snug text-danger">{connectErrorText(error)}</p>
            <button
              type="button"
              onClick={() => reset()}
              aria-label="Dismiss"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        {sheet}
      </div>
    );
  }

  const wrong = chainId !== network.chainId;

  // A passkey (Tempo Wallet) account cannot move to Robinhood Chain: offer a
  // browser wallet there instead of a network switch that cannot succeed.
  if (wrong && !demo && isTempoWallet(connector)) {
    return (
      <div
        ref={root}
        className={compact ? "inline-flex" : "flex flex-col items-stretch gap-1"}
      >
        <button
          type="button"
          onClick={async () => {
            setBusy(true);
            try {
              await disconnectAsync().catch(() => {});
              openWallet();
            } finally {
              setBusy(false);
            }
          }}
          disabled={!canUseWallet || busy || isPending}
          className={primary}
        >
          {!compact && <WalletGlyph />}
          {busy || isPending
            ? "Connecting…"
            : compact
              ? "Connect"
              : "Connect a wallet"}
        </button>
        {!compact && (
          <p className="mt-1 text-[12px] leading-snug text-mute">
            {network.testnet
              ? `Passkey accounts are on Tempo. ${network.label} needs ${wc ? "a wallet app" : "a browser wallet"}.`
              : `Passkey accounts are on Tempo testnet. ${network.label} mainnet needs ${wc ? "a wallet app" : "a browser wallet"}.`}
          </p>
        )}
        {sheet}
      </div>
    );
  }

  if (wrong) {
    const walletOn = chainId === undefined ? null : walletChainName(chainId);
    return (
      <div ref={root} className={compact ? "inline-flex" : undefined}>
        <button
          type="button"
          onClick={onSwitch}
          disabled={switching || busy}
          className={primary}
        >
          {switching || busy
            ? "Switching…"
            : compact
              ? "Switch network"
              : `Switch to ${network.label}`}
        </button>
        {!compact && (walletOn || switchFailed) && (
          <p className={`mt-2 text-[12px] leading-snug ${switchFailed ? "text-danger" : "text-mute"}`}>
            {walletOn && `Your wallet is on ${walletOn}. `}
            {switchFailed &&
              `It did not switch. Pick ${networkName(network)} in your wallet, then disconnect here and connect again.`}
          </p>
        )}
        {!compact && switchFailed && (
          <button
            type="button"
            onClick={() => {
              setSwitchFailed(false);
              disconnect();
            }}
            className="inline-flex min-h-10 items-center text-[12px] font-medium text-foreground underline underline-offset-2"
          >
            Disconnect
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={root} className={`relative ${sidebar ? "w-full" : "inline-flex"}`}>
      {sidebar ? (
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={`flex min-h-[52px] w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left transition-colors hover:bg-surface ${
            open ? "bg-surface" : ""
          }`}
        >
          <AddressSeal address={address} size={34} />
          <span className="min-w-0 flex-1">
            <span className="tnum block truncate text-[14px] font-medium leading-tight text-foreground">
              {shortAddress(address)}
            </span>
            <span className="mt-0.5 block truncate text-[12px] leading-tight text-mute">
              {network.label}
            </span>
          </span>
          <UpDownGlyph className="shrink-0 text-faint" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={`inline-flex h-10 items-center gap-2 rounded-full border bg-panel pl-1 pr-3 text-foreground transition-colors hover:border-line-strong ${
            open ? "border-line-strong" : "border-line"
          }`}
        >
          <AddressSeal address={address} size={32} />
          <span className="tnum whitespace-nowrap text-[13px] font-medium">
            {shortAddress(address)}
          </span>
          <ChevronGlyph
            className={`text-faint transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      )}

      {open && (
        <div
          role="menu"
          aria-label="Wallet"
          className={`absolute z-50 rounded-[18px] border border-line bg-panel p-1.5 shadow-pop ${
            sidebar
              ? "bottom-0 left-full ml-5 w-[288px]"
              : "right-0 top-full mt-2 w-[288px] max-w-[calc(100vw-32px)]"
          }`}
        >
          <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
            <AddressSeal address={address} size={38} />
            <div className="min-w-0 flex-1">
              <p className="tnum truncate text-[14px] font-medium text-foreground">
                {shortAddress(address, 6)}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-mute">
                {network.label}{network.testnet ? " testnet" : " mainnet"}
              </p>
            </div>
            <button
              type="button"
              onClick={onCopy}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
              aria-label={copied ? "Address copied" : "Copy address"}
              title={copied ? "Copied" : "Copy address"}
            >
              {copied ? <CheckGlyph /> : <CopyGlyph />}
            </button>
          </div>
          {isTempoFeeChain(network.chainId) && !demo && (
            <TempoFeeRow
              address={address as Address}
              passkey={isTempoWallet(connector)}
              chainId={network.chainId}
            />
          )}
          <div className="mx-1 h-px bg-line" />
          <div className="py-1">
            <MenuLink href="/app" onClick={() => setOpen(false)} icon={<GridGlyph />}>
              Portfolio
            </MenuLink>
            {embedded && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  openEmbeddedSheet("funding");
                }}
                className="flex h-10 w-full items-center gap-3 rounded-xl px-2.5 text-[14px] text-foreground transition-colors hover:bg-surface"
              >
                <span className="text-mute">
                  <PlusGlyph />
                </span>
                Add funds
              </button>
            )}
            {/* Trade: tokenized stocks, where the network has them (the Vault's Trade) */}
            {network.stocks && (
              <MenuLink
                href="/app/vault?tab=trade"
                onClick={() => setOpen(false)}
                icon={<TradeGlyph />}
              >
                Trade
              </MenuLink>
            )}
            <MenuLink
              href="/app/vault?tab=move"
              onClick={() => setOpen(false)}
              icon={<SendGlyph />}
            >
              Pay privately
            </MenuLink>
            <MenuLink
              href="/app/settings"
              onClick={() => setOpen(false)}
              icon={<GearGlyph />}
            >
              Settings
            </MenuLink>
          </div>
          <div className="mx-1 h-px bg-line" />
          <div className="pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                disconnect();
              }}
              className="flex h-10 w-full items-center gap-3 rounded-xl px-2.5 text-[14px] text-mute transition-colors hover:bg-surface hover:text-foreground"
            >
              <ExitGlyph />
              {embedded ? "Sign out" : "Disconnect"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Friendly text for a failed connect (a closed passkey prompt is not an error). */
function connectErrorText(error: Error): string {
  if (error.name === "UserRejectedRequestError") return "Sign-in cancelled.";
  // No wallet extension in this browser (wagmi says "Provider not found" and its version).
  if (error.name === "ProviderNotFoundError") {
    return "No wallet found in this browser. Add one such as MetaMask or Rabby, or open this page in your wallet app.";
  }
  // MetaMask answers -32002 while an earlier connect request is still open in it
  const code = (error as Error & { code?: number; cause?: { code?: number } }).code ?? (error as { cause?: { code?: number } }).cause?.code;
  if (code === -32002 || /already pending/i.test(error.message)) {
    return "Your wallet already has a request open. Check it, then try again.";
  }
  const short = (error as Error & { shortMessage?: string }).shortMessage;
  const line = (short ?? error.message).split("\n")[0]!.trim();
  return line ? line.slice(0, 100) : "Couldn't connect. Try again.";
}

/**
 * How this account pays network fees on Tempo. Passkey accounts are
 * sponsored. Browser wallets pay in their chosen fee token, else PathUSD, so
 * one tap sets OUSD (that call pays its own fee in OUSD, no PathUSD needed).
 * On mainnet the row only says which token pays; when the wallet has none set
 * and too little pathUSD, the app sets one before the first send.
 */
function TempoFeeRow({
  address,
  passkey,
  chainId,
}: {
  address: Address;
  passkey: boolean;
  chainId: GloamChainId;
}) {
  const mainnet = chainId !== TEMPO_CHAIN_ID;
  const pref = useReadContract({
    address: FEE_MANAGER,
    abi: feeManagerAbi,
    functionName: "userTokens",
    args: [address],
    chainId,
    query: { enabled: !passkey },
  });
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash, chainId });
  const { refetch } = pref;

  useEffect(() => {
    if (receipt.isSuccess) void refetch().then(() => reset());
  }, [receipt.isSuccess, refetch, reset]);

  const row = "flex min-h-10 items-center gap-3 px-2.5 pb-2 text-[13px] text-mute";

  if (passkey) {
    return (
      <div className={row}>
        <FeeGlyph />
        <span className="min-w-0 flex-1">
          {TEMPO_SPONSORED
            ? "Network fees covered"
            : "Fees paid from your stablecoins"}
        </span>
      </div>
    );
  }

  if (pref.data === undefined) return null;
  const set = !/^0x0{40}$/i.test(pref.data);
  const symbol = set
    ? (tempoStableSymbol(pref.data, chainId) ?? "your chosen stablecoin")
    : mainnet
      ? "pathUSD"
      : "PathUSD";
  const saving = isPending || receipt.isLoading;

  return (
    <div className={row}>
      <FeeGlyph />
      <span className="min-w-0 flex-1">
        {error ? "Not changed. Try again." : `Fees paid in ${symbol}`}
      </span>
      {!set && !mainnet && (
        <button
          type="button"
          onClick={() =>
            writeContract({
              address: FEE_MANAGER,
              abi: feeManagerAbi,
              functionName: "setUserToken",
              args: [OUSD],
              chainId: TEMPO_CHAIN_ID,
            })
          }
          disabled={saving}
          className="btn btn-ghost btn-sm shrink-0"
        >
          {saving ? "Saving…" : "Pay in OUSD"}
        </button>
      )}
    </div>
  );
}

function MenuLink({
  href,
  onClick,
  icon,
  children,
}: {
  href: string;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      className="flex h-10 items-center gap-3 rounded-xl px-2.5 text-[14px] text-foreground transition-colors hover:bg-surface"
    >
      <span className="text-mute">{icon}</span>
      {children}
    </Link>
  );
}

/**
 * The account mark: a 3x3 mirrored dot grid read from the address bytes. It
 * borrows the sealed-dots motif, so each wallet gets a stable, quiet identity.
 */
function AddressSeal({ address, size = 32 }: { address: string; size?: number }) {
  const hex = address.slice(2).toLowerCase();
  const nib = (i: number) => parseInt(hex[i] ?? "0", 16) || 0;
  const cells: boolean[] = [];
  for (let r = 0; r < 3; r++) {
    const side = nib(r * 2 + 3) % 2 === 0;
    const mid = nib(r * 2 + 4) % 2 === 0;
    cells.push(side, mid, side);
  }
  if (cells.filter(Boolean).length < 3) {
    cells[1] = cells[4] = cells[7] = true;
  }
  const dot = Math.max(3, Math.round(size / 8.5));
  const gap = Math.max(2, Math.round(size / 12));
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-ink"
      style={{ width: size, height: size }}
    >
      <span className="grid grid-cols-3" style={{ gap }}>
        {cells.map((on, i) => (
          <i
            key={i}
            className={`block rounded-full bg-on-ink ${on ? "opacity-95" : "opacity-25"}`}
            style={{ width: dot, height: dot }}
          />
        ))}
      </span>
    </span>
  );
}

const glyph = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  "aria-hidden": true,
} as const;

function WalletGlyph() {
  return (
    <svg {...glyph}>
      <path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5h10A1.5 1.5 0 0 1 18 6.5V8M4 7.5v9A2.5 2.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17.5 8H6.5A2.5 2.5 0 0 1 4 7.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="15.5" cy="13.5" r="1.2" fill="currentColor" />
    </svg>
  );
}
function FeeGlyph() {
  return (
    <svg {...glyph} className="shrink-0">
      <path
        d="M5.5 6.5h13M5.5 6.5v11A1.5 1.5 0 0 0 7 19h10a1.5 1.5 0 0 0 1.5-1.5v-11M5.5 6.5 7 4.5h10l1.5 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M12 9.75v6M13.75 11a1.75 1.25 0 0 0-1.75-1.25c-.97 0-1.75.56-1.75 1.25s.78 1.25 1.75 1.25 1.75.56 1.75 1.25-.78 1.25-1.75 1.25a1.75 1.25 0 0 1-1.75-1.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
function UpDownGlyph({ className = "" }: { className?: string }) {
  return (
    <svg {...glyph} className={className}>
      <path
        d="M8.5 9.5 12 6l3.5 3.5M8.5 14.5 12 18l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ChevronGlyph({ className = "" }: { className?: string }) {
  return (
    <svg {...glyph} width={14} height={14} className={className}>
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function CopyGlyph() {
  return (
    <svg {...glyph}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function CheckGlyph() {
  return (
    <svg {...glyph}>
      <path d="m5.5 12.5 4 4 9-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GridGlyph() {
  return (
    <svg {...glyph}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function TradeGlyph() {
  return (
    <svg {...glyph}>
      <path d="M7 4.5v15M7 4.5 4 7.5M7 4.5l3 3M17 19.5v-15M17 19.5l-3-3M17 19.5l3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SendGlyph() {
  return (
    <svg {...glyph}>
      <path d="M5 12h13M13 6.5 18.5 12 13 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GearGlyph() {
  return (
    <svg {...glyph}>
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3.75v2M12 18.25v2M20.25 12h-2M5.75 12h-2M17.83 6.17l-1.41 1.41M7.58 16.42l-1.41 1.41M17.83 17.83l-1.41-1.41M7.58 7.58L6.17 6.17"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
function PlusGlyph() {
  return (
    <svg {...glyph}>
      <path d="M12 5.5v13M5.5 12h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function ExitGlyph() {
  return (
    <svg {...glyph}>
      <path d="M14 5.5H7A1.5 1.5 0 0 0 5.5 7v10A1.5 1.5 0 0 0 7 18.5h7M11 12h9M17 9l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
