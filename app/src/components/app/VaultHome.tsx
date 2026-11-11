"use client";

/**
 * The Vault's landing: your private balance next to your public wallet, the
 * one move between them ("You have 120 USDC in your wallet. Add it
 * privately."), and every action the Vault has, each named with one plain
 * line. Actions that spend the private balance wait, saying why, until there
 * is one. Everything here only reads; each action does its work on its own page.
 */
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { formatUnits } from "viem";
import { formatEth } from "@/lib/chain";
import { useAppAccount, useAppBalance, useAppTokenBalances } from "@/lib/demo";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { useAutoRestoreStatus } from "@/hooks/useAutoRestoreStatus";
import { assetLabel, formatAssetAmount, formatAssetLabel, isNativeAsset, isShieldDeployed } from "@/lib/shield";
import { addableTokensFor, isDollarStable, isNativeAddable, knownTokens, nativeTokenFor } from "@/lib/tokens";
import { useOpenGatedTokens } from "@/hooks/useOpenGatedTokens";
import { faucetFor } from "@/lib/faucet";
import { bridgeVisible } from "@/lib/bridge";
import {
  addAssetHref,
  pickAddAsset,
  topUpsSetAside,
  vaultActionBlocked,
  vaultActionSearch,
  compareHoldings,
  type VaultActionId,
  type VaultActionInfo,
} from "@/lib/vaultHub";
import { SealedField } from "@/components/ui/SealedField";
import { useNetwork } from "./NetworkProvider";
import { TokenLogo } from "./TokenLogo";
import { WalletMenu } from "./WalletMenu";
import { TempoFaucetButton } from "./TempoFaucetButton";

type Holding = { id: string; symbol: string; logoId: string; text: string; amount: number; dollar: boolean };

const SHOWN = 3;

export function VaultHome({ actions }: { actions: readonly VaultActionInfo[] }) {
  const { network } = useNetwork();
  const { address, isConnected, chainId } = useAppAccount();
  const onNetwork = chainId === network.chainId;
  const live = isShieldDeployed() && Boolean(network.pool);
  const { byAsset, local, ready, balanceSyncing } = useLocalShieldNotes(address);

  // The public side: what this wallet holds of what the vault takes now (BDX, or
  // ETH on Robinhood Chain, only once its live deposit limit is open).
  const openGated = useOpenGatedTokens();
  const tokens = useMemo(() => addableTokensFor(network.chainId, openGated), [network.chainId, openGated]);
  const tokenAddrs = useMemo(() => tokens.map((t) => t.address), [tokens]);
  const tokenBals = useAppTokenBalances({
    tokens: tokenAddrs,
    address,
    chainId: network.chainId,
    enabled: Boolean(address) && onNetwork,
  });
  const nativeOk = isNativeAddable(network.chainId, openGated);
  const { data: nativeBal } = useAppBalance({
    address,
    chainId: network.chainId,
    enabled: Boolean(address) && onNetwork && nativeOk,
  });

  const balancesVisible = isConnected && onNetwork;
  const walletLoading = balancesVisible && (tokenBals.some((b) => b === undefined) || (nativeOk && !nativeBal));
  const wallet: Holding[] = useMemo(() => {
    if (!balancesVisible) return [];
    const rows: Holding[] = [];
    tokens.forEach((t, i) => {
      const raw = tokenBals[i];
      if (!raw || raw <= BigInt(0)) return;
      rows.push({
        id: t.id,
        symbol: t.symbol,
        logoId: t.id,
        text: formatAssetAmount(raw, t.address),
        amount: Number(formatUnits(raw, t.decimals)),
        dollar: isDollarStable(t),
      });
    });
    if (nativeOk && nativeBal && nativeBal.value > BigInt(0)) {
      const symbol = network.primaryAsset.symbol;
      rows.push({
        id: "eth",
        symbol,
        logoId: nativeTokenFor(network.chainId).id,
        text: formatEth(nativeBal.value),
        amount: Number(formatUnits(nativeBal.value, 18)),
        dollar: false,
      });
    }
    return rows.sort(compareHoldings);
  }, [balancesVisible, tokens, tokenBals, nativeOk, nativeBal, network.primaryAsset.symbol, network.chainId]);

  // The private side: this browser's notes in this vault.
  const known = useMemo(() => knownTokens(network.chainId), [network.chainId]);
  const privateRows: Holding[] = useMemo(() => {
    if (!balancesVisible) return [];
    const rows: Holding[] = [];
    byAsset.forEach((raw, asset) => {
      if (raw <= BigInt(0)) return;
      const t = known.find((x) => x.address.toLowerCase() === asset.toLowerCase());
      const symbol = assetLabel(asset);
      rows.push({
        id: asset,
        symbol,
        logoId: isNativeAsset(asset) ? nativeTokenFor(network.chainId).id : (t?.id ?? symbol.toLowerCase()),
        text: isNativeAsset(asset) ? formatEth(raw) : formatAssetAmount(raw, asset),
        amount: isNativeAsset(asset) ? Number(formatUnits(raw, 18)) : t ? Number(formatUnits(raw, t.decimals)) : 0,
        dollar: Boolean(t && isDollarStable(t)),
      });
    });
    return rows.sort(compareHoldings);
  }, [balancesVisible, byAsset, known, network.chainId]);

  const hasPrivate = privateRows.length > 0;
  // Money set aside for agent top-ups is out of the balance, for months at times: say where it went.
  const setAside = useMemo(
    () => [...topUpsSetAside(local)].map(([asset, wei]) => formatAssetLabel(wei, asset)).join(", "),
    [local]
  );
  // A restore from the backup on its way (lib/autoRestore) can still bring the balance in.
  const autoRestore = useAutoRestoreStatus(address);
  const restoring = autoRestore.kind === "checking" || autoRestore.kind === "running";
  const privateLoading = balancesVisible && (!ready || ((balanceSyncing || restoring) && !hasPrivate));
  const privateKnown = balancesVisible && ready && !balanceSyncing && !restoring;
  const suggest = pickAddAsset(wallet);
  const core = actions.filter((a) => !a.extra);
  const extras = actions.filter((a) => a.extra);
  const faucet = network.testnet ? faucetFor(network.key) : null;

  // The one next step, and the screen's one primary button.
  const next: { text: ReactNode; action: ReactNode } = !live
    ? {
        text: `The private vault is not on ${network.label} yet. Pick another network from the menu.`,
        action: null,
      }
    : !isConnected
      ? { text: "Connect a wallet to see both balances and start.", action: <WalletMenu /> }
      : !onNetwork
        ? {
            text: `Your wallet is on another network. Switch it to ${network.label} to see your balances.`,
            action: <WalletMenu />,
          }
        : walletLoading || privateLoading
          ? { text: "Reading your balances…", action: null }
          : suggest && !hasPrivate
            ? {
                text: (
                  <>
                    You have <span className="tnum text-foreground">{suggest.text} {suggest.symbol}</span> in your
                    wallet. Add it privately.
                  </>
                ),
                action: (
                  <Link href={addAssetHref(suggest.id)} className="btn btn-ink">
                    Add privately
                  </Link>
                ),
              }
            : hasPrivate
              ? {
                  text: suggest ? (
                    <>
                      You also have <span className="tnum text-foreground">{suggest.text} {suggest.symbol}</span> in your
                      wallet.{" "}
                      <Link
                        href={addAssetHref(suggest.id)}
                        className="inline-flex min-h-10 items-center font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                      >
                        Add it privately
                      </Link>
                    </>
                  ) : (
                    "Pay from your private balance, or cash out to any wallet."
                  ),
                  action: (
                    <Link href={`/app/vault${vaultActionSearch("pay", "")}`} className="btn btn-ink">
                      Pay privately
                    </Link>
                  ),
                }
              : faucet
                ? {
                    text: "Nothing here yet. Get testnet funds, then add them privately.",
                    action:
                      network.key === "tempo" ? (
                        <TempoFaucetButton className="btn btn-ink" />
                      ) : (
                        <a
                          href={faucet.url}
                          target={faucet.url.startsWith("http") ? "_blank" : undefined}
                          rel={faucet.url.startsWith("http") ? "noreferrer" : undefined}
                          className="btn btn-ink"
                        >
                          Get testnet funds
                        </a>
                      ),
                  }
                : {
                    text: `Nothing to add yet. Gloam takes ${listAnd(tokens.map((t) => t.symbol))} on ${network.label}. Send some to this wallet${
                      bridgeVisible(network) ? ", or bring it over from another chain" : ""
                    }.`,
                    action: bridgeVisible(network) ? (
                      <Link href={`/app/vault${vaultActionSearch("shield", "")}`} className="btn btn-ink">
                        Bring money in
                      </Link>
                    ) : null,
                  };

  // Pay, Swap and Cash out wait for the same thing, so it is said once, not on every tile.
  const blockedNote =
    [...core, ...extras].map((a) => vaultActionBlocked(a, { known: privateKnown, hasPrivate })).find(Boolean) ?? null;

  return (
    <div className="space-y-6">
      {/* Phones: every money move on the first screen, before the balances. */}
      <QuickRow actions={core} blockedFor={(a) => vaultActionBlocked(a, { known: privateKnown, hasPrivate })} />

      {/* Private next to public: two different things, and the move between them. */}
      <section className="gl-card overflow-hidden" aria-labelledby="vault-money-title">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-7 sm:pt-6">
          <h2 id="vault-money-title" className="text-[15px] text-foreground">
            Your money on {network.label}
          </h2>
          <span className="shrink-0 text-[13px] text-mute">{network.testnet ? "Testnet" : "Mainnet"}</span>
        </div>

        <div className="mt-4 grid gap-px border-y border-line bg-line sm:grid-cols-2">
          <BalancePane
            sealed
            title="Private balance"
            badge="Only you"
            rows={privateRows}
            loading={privateLoading}
            empty={balancesVisible ? "0" : null}
            note={
              !balancesVisible
                ? "Connect to see it. Only you can."
                : restoring
                  ? "Syncing your private balance…"
                  : setAside
                    ? `${setAside} more is set aside for agent top-ups.`
                    : hasPrivate
                      ? "Only you can see it."
                      : "Nothing here yet. Only you will see this number."
            }
          />
          <BalancePane
            sealed={false}
            title="In your wallet"
            badge={null}
            rows={wallet}
            loading={walletLoading}
            empty={balancesVisible ? "0" : null}
            note={
              balancesVisible && !wallet.length && !walletLoading
                ? `No ${listOr(tokens.map((t) => t.symbol))} in this wallet.`
                : "Anyone can see this on the explorer."
            }
          />
        </div>

        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7" aria-live="polite">
          <p className="min-w-0 text-[14px] leading-relaxed text-soft">{next.text}</p>
          {next.action && <div className="shrink-0 max-sm:[&>.btn]:w-full">{next.action}</div>}
        </div>
      </section>

      {/* Every action, named, with one line. */}
      <section aria-labelledby="vault-actions-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
          <h2 id="vault-actions-title" className="t-eyebrow">
            What you can do
          </h2>
          {blockedNote && (
            <p className="inline-flex items-center gap-1.5 text-[13px] text-soft">
              <LockGlyph />
              {blockedNote}
            </p>
          )}
        </div>
        <ul
          className={`gl-card divide-y divide-line overflow-hidden xl:grid xl:divide-x xl:divide-y-0 ${
            core.length >= 5 ? "xl:grid-cols-5" : "xl:grid-cols-4"
          }`}
        >
          {core.map((a) => (
            <li key={a.id} className="min-w-0">
              <ActionTile action={a} blocked={vaultActionBlocked(a, { known: privateKnown, hasPrivate })} />
            </li>
          ))}
        </ul>
      </section>

      {extras.length > 0 && (
        <section aria-labelledby="vault-more-title">
          <h2 id="vault-more-title" className="t-eyebrow mb-3 px-1">
            Also on {network.label}
          </h2>
          <ul
            className={`gl-card divide-y divide-line overflow-hidden ${
              extras.length > 1 ? `sm:grid sm:divide-x sm:divide-y-0 ${extras.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2"}` : ""
            }`}
          >
            {extras.map((a) => (
              <li key={a.id} className="min-w-0">
                <ActionTile action={a} blocked={vaultActionBlocked(a, { known: privateKnown, hasPrivate })} compact />
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="max-w-[68ch] px-1 text-[13px] leading-relaxed text-mute">
        Adding money and cashing out show on the explorer, like any transfer. What you hold, and who you pay, stay
        private.{" "}
        <Link
          href="/docs/privacy-model"
          className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
        >
          What stays private
        </Link>
      </p>
    </div>
  );
}

function BalancePane({
  sealed,
  title,
  badge,
  rows,
  loading,
  empty,
  note,
}: {
  sealed: boolean;
  title: string;
  /** The one privacy signal, on the private side only. */
  badge: string | null;
  rows: Holding[];
  loading: boolean;
  /** What the amount reads with nothing in it; null when it can't be read (no wallet). */
  empty: string | null;
  note: string;
}) {
  const first = rows[0];
  const rest = rows.slice(1, SHOWN);
  const more = rows.length - SHOWN;
  return (
    <div className="relative min-w-0 overflow-hidden bg-panel px-5 py-5 sm:px-7 sm:py-6">
      {sealed && <SealedField tone="soft" />}
      <div className="relative z-[1]">
        <div className="flex h-6 items-center justify-between gap-3">
          <span className="text-[13px] text-mute">{title}</span>
          {badge && (
            <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 text-[12px] font-medium text-sealed">
              <LockGlyph />
              {badge}
            </span>
          )}
        </div>
        <div className="mt-4 min-h-[40px]">
          {loading ? (
            <span className="gl-skeleton block h-9 w-36" aria-label="Loading" />
          ) : first ? (
            <p className="tnum flex min-w-0 items-center gap-2.5 text-[32px] font-light leading-none tracking-[-0.02em] text-foreground">
              <TokenLogo id={first.logoId} symbol={first.symbol} size={28} />
              <span className="truncate">
                {first.text} <span className="text-[15px] tracking-normal text-mute">{first.symbol}</span>
              </span>
            </p>
          ) : (
            <p className={`tnum text-[32px] font-light leading-none tracking-[-0.02em] ${empty ? "text-foreground" : "text-faint"}`}>
              {empty ?? "0"}
            </p>
          )}
        </div>
        {!loading && rest.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {rest.map((r) => (
              <li key={r.id} className="tnum flex items-center gap-2 text-[14px] text-foreground">
                <TokenLogo id={r.logoId} symbol={r.symbol} size={18} />
                {r.text} <span className="text-mute">{r.symbol}</span>
              </li>
            ))}
            {more > 0 && <li className="text-[13px] text-mute">and {more} more</li>}
          </ul>
        )}
        <p className="mt-3 text-[12.5px] leading-relaxed text-mute">{note}</p>
      </div>
    </div>
  );
}

/**
 * On a phone the overview opens on its actions: Add, Pay, Receive and Cash out
 * (and Swap where it exists) side by side, each its mark and short name, so
 * none waits below the balances. One that needs a private balance first is
 * shown but quiet; the list below says why. From a tablet up the list is near
 * the top already, so this row is not drawn (globals.css .vault-quickrow).
 */
function QuickRow({
  actions,
  blockedFor,
}: {
  actions: readonly VaultActionInfo[];
  blockedFor: (a: VaultActionInfo) => string | null;
}) {
  return (
    <nav aria-label="Vault actions" className="vault-quickrow">
      <ul
        className={`grid gap-1 rounded-[20px] bg-surface-2 p-1 dark:bg-panel dark:ring-1 dark:ring-line ${
          actions.length >= 5 ? "grid-cols-5" : "grid-cols-4"
        }`}
      >
        {actions.map((a) => {
          const blocked = blockedFor(a);
          const cell =
            "flex h-[64px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-[16px] px-1 text-[12px] leading-tight";
          return (
            <li key={a.id} className="min-w-0">
              {blocked ? (
                <span aria-disabled="true" title={blocked} className={`${cell} text-faint`}>
                  <VaultActionIcon id={a.id} size={18} />
                  <span className="max-w-full truncate">{a.short}</span>
                </span>
              ) : (
                <Link
                  href={`/app/vault${vaultActionSearch(a.id, "")}`}
                  className={`${cell} bg-panel text-foreground shadow-card transition-colors active:bg-surface dark:bg-surface-2`}
                >
                  <VaultActionIcon id={a.id} size={18} />
                  <span className="max-w-full truncate">{a.short}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ActionTile({
  action,
  blocked,
  compact = false,
}: {
  action: VaultActionInfo;
  blocked: string | null;
  compact?: boolean;
}) {
  const body = (
    <>
      <span className={`grid h-6 w-6 shrink-0 place-items-center ${blocked ? "text-faint" : "text-foreground"}`} aria-hidden>
        <VaultActionIcon id={action.id} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`flex items-center gap-1.5 text-[15px] font-medium leading-snug ${blocked ? "text-mute" : "text-foreground"}`}
        >
          {action.label}
          {blocked && (
            <span className="text-faint">
              <LockGlyph />
            </span>
          )}
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-mute">{action.line}</span>
        {blocked && <span className="sr-only">{blocked}</span>}
      </span>
      {!blocked && (
        <span className={`shrink-0 text-faint transition-colors group-hover:text-foreground ${compact ? "" : "xl:hidden"}`} aria-hidden>
          <ChevronRight />
        </span>
      )}
    </>
  );
  const layout = `flex min-h-[76px] items-center gap-4 px-5 py-4 sm:px-6 ${
    compact ? "" : "xl:h-full xl:flex-col xl:items-start xl:gap-4 xl:px-6 xl:py-6"
  }`;
  if (blocked) {
    return (
      <div className={layout} aria-disabled="true">
        {body}
      </div>
    );
  }
  return (
    <Link
      href={`/app/vault${vaultActionSearch(action.id, "")}`}
      className={`group ${layout} transition-colors duration-200 hover:bg-surface/60 focus-visible:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/50`}
    >
      {body}
    </Link>
  );
}

/** One mark per action, the same line weight as the app nav. */
export function VaultActionIcon({ id, size = 18 }: { id: VaultActionId; size?: number }) {
  const p = { stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {id === "shield" && <path d="M12 5v14M5 12h14" {...p} />}
      {id === "pay" && <path d="M7 17L17 7M9 7h8v8" {...p} />}
      {id === "receive" && <path d="M17 7L7 17M15 17H7V9" {...p} />}
      {id === "swap" && <path d="M5 8.5h13m0 0l-3.5-3.5M18 8.5L14.5 12M19 15.5H6m0 0l3.5-3.5M6 15.5L9.5 19" {...p} />}
      {id === "cashout" && <path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14" {...p} />}
      {id === "topups" && <path d="M12 7v5l3 2M20 12a8 8 0 1 1-2.5-5.8M20 3.5v3.2h-3.2" {...p} />}
      {id === "trade" && <path d="M4 17l4.5-5 3.5 3 7-8M15 7h4v4" {...p} />}
      {id === "send" && <path d="M4.5 11.5L19.5 4.5l-7 15-2-6-6-2z" {...p} />}
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9.5 6l6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** "USDG", "USDG and GLOAM", "USDC, EURC and ETH". */
function listAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "USDG", "USDG or GLOAM". */
function listOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

