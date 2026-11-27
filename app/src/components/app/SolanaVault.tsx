"use client";

/**
 * The Vault on Solana: the same overview, action row and forms as on the EVM
 * networks (VaultHome, VaultHub's row, Add privately's amount card), over the
 * Solana account (SolanaAccount). Solana has Add privately, Pay privately
 * (to a private address or by claim link), Receive (with Claim a payment and
 * Request a payment) and Cash out; Swap, Agent top-ups and Public send are not
 * on Solana yet, so they are not listed here.
 *
 * What each screen says follows lib/solanaRings/config: a private payment
 * hides the token and the amount, the two private accounts it moves between
 * show, adding shows the wallet it came from, and a cash out shows where it
 * went. Never say or suggest that the sender or the recipient is hidden.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RINGS_PRIVACY_NOTE, addFeePayer, ringsAssets, ringsExplorerTx, type RingsAsset } from "@/lib/solanaRings/config";
import { canSignOnly } from "@/lib/solanaWallet";
import { ADD_FIRST, addAssetHref, type VaultActionId, type VaultActionInfo } from "@/lib/vaultHub";
import { SOLANA_VAULT_ACTIONS } from "@/lib/solanaRings/vaultActions";
import { ActionTile, BalancePane, QuickRow, type Holding } from "./VaultHome";
import { SuccessModal } from "./SuccessModal";
import { TokenLogo } from "./TokenLogo";
import {
  SOLANA_NET_LABEL,
  SolanaActionButton,
  SolanaAmountCard,
  SolanaEmptyBalance,
  SolanaError,
  SolanaGate,
  SolanaSteps,
  amountProblem,
  preferredAsset,
  useShownAssets,
  useSolanaUsd,
  usd,
} from "./SolanaParts";
import { formatSolAmount, parseSolAmount, plainSolAmount, shortSol, useSolana } from "./SolanaAccount";
import { displayAmountText, typedAmount } from "@/lib/amountShort";
import { SolanaArrivals, SolanaBridgeIn } from "./SolanaBridgeIn";
import { solanaBridgeVisible } from "@/lib/solanaRings/bridgeIn";
import { claimLinkUrl, decodeClaim, decodeRequest, requestBodyFromHash, type SolanaRequest } from "@/lib/solanaRings/claimLink";
import { SolanaClaimCard, SolanaLinkShare, SolanaRequestBanner, SolanaRequestCard, SolanaSentLinks, useSolanaClaimFromUrl } from "./SolanaLinks";

/** What a claim link shows on Solana, said where one is made. */
const LINK_PRIVACY_NOTE =
  "On Solana, a claim link hides the token and the amount. Your private account, the link's one-time account and the account that claims it show on Solana.";

function holdings(b: Record<string, bigint> | null, toUsd: (id: string, v: bigint) => number | null): Holding[] {
  if (!b) return [];
  return ringsAssets()
    .filter((a) => (b[a.id] ?? 0n) > 0n)
    .map((a) => ({
      id: a.id,
      symbol: a.symbol,
      logoId: a.id,
      text: formatSolAmount(b[a.id]!, a.decimals),
      amount: toUsd(a.id, b[a.id]!) ?? 0,
      dollar: Boolean(a.stable),
    }))
    .sort((x, y) => y.amount - x.amount);
}

function listOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------- overview

export function SolanaVaultHome({ missing }: { missing?: string | null }) {
  const sol = useSolana();
  const toUsd = useSolanaUsd();
  const shown = useShownAssets();
  if (!sol) return null;
  const { address, balances, walletBalances } = sol;
  const privateRows = holdings(balances, toUsd);
  const walletRows = holdings(walletBalances, toUsd);
  const known = Boolean(address && balances);
  const hasPrivate = privateRows.length > 0;
  const blockedFor = (a: VaultActionInfo) => (known && !hasPrivate && (a.id === "pay" || a.id === "cashout") ? ADD_FIRST : null);
  const firstWallet = walletRows[0];
  const symbols = listOr(shown.map((a) => a.symbol));

  const next: { text: string; action: React.ReactNode } = hasPrivate
    ? {
        text: "Pay privately from your private balance, or cash out to any Solana address.",
        action: (
          <Link href="/app/vault?tab=move" className="btn btn-ink">
            Pay privately
          </Link>
        ),
      }
    : firstWallet
      ? {
          text: `You have ${firstWallet.text} ${firstWallet.symbol} in your Solana wallet. Add it privately.`,
          action: (
            <Link href={addAssetHref(firstWallet.id)} className="btn btn-ink">
              Add privately
            </Link>
          ),
        }
      : { text: `Nothing to add yet. Send ${symbols} to your Solana wallet first.`, action: null };

  return (
    <div className="space-y-6">
      {missing && (
        <p role="status" className="rounded-[16px] bg-surface px-4 py-3 text-[14px] text-soft">
          {missing} is not on Solana yet. Here is what Gloam does on Solana.
        </p>
      )}
      <QuickRow actions={SOLANA_VAULT_ACTIONS} blockedFor={blockedFor} />

      <SolanaNotPrivateYet />
      {!address ? (
        <SolanaGate />
      ) : (
        <section className="gl-card overflow-hidden" aria-labelledby="vault-money-title">
          <div className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-7 sm:pt-6">
            <h2 id="vault-money-title" className="text-[15px] text-foreground">
              Your money on Solana
            </h2>
            <span className="shrink-0 text-[13px] text-mute">{SOLANA_NET_LABEL === "devnet" ? "Devnet" : "Mainnet"}</span>
          </div>
          <div className="mt-4 grid gap-px border-y border-line bg-line sm:grid-cols-2">
            <BalancePane
              sealed
              title="Private balance"
              badge="Only you"
              rows={privateRows}
              loading={!balances}
              empty={displayAmountText("0")}
              note={hasPrivate ? "Read and decrypted on this device." : "Nothing here yet. Only you will see this number."}
            />
            <BalancePane
              sealed={false}
              title="In your wallet"
              badge={null}
              rows={walletRows}
              loading={!walletBalances}
              empty={displayAmountText("0")}
              note="Anyone can see this on the explorer."
            />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7" aria-live="polite">
            <p className="min-w-0 text-[14px] leading-relaxed text-soft">{next.text}</p>
            {next.action && <div className="shrink-0 max-sm:[&>.btn]:w-full">{next.action}</div>}
          </div>
        </section>
      )}

      <section aria-labelledby="vault-actions-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
          <h2 id="vault-actions-title" className="t-eyebrow">
            What you can do
          </h2>
        </div>
        <ul className="gl-card divide-y divide-line overflow-hidden xl:grid xl:grid-cols-4 xl:divide-x xl:divide-y-0">
          {SOLANA_VAULT_ACTIONS.map((a) => (
            <li key={a.id} className="min-w-0">
              <ActionTile action={a} blocked={blockedFor(a)} />
            </li>
          ))}
        </ul>
      </section>

      {/* Before the account is open, the card beside the connect step says it already. */}
      {address && (
      <p className="max-w-[68ch] px-1 text-[13px] leading-relaxed text-mute">
        {RINGS_PRIVACY_NOTE}{" "}
        <Link
          href="/docs/privacy-model"
          className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
        >
          What stays private
        </Link>
      </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the panel under the action row

export function SolanaVaultPanel({ id, onReceive }: { id: VaultActionId; onReceive: () => void }) {
  const sol = useSolana();
  // A claim link opened here (#sol=...), kept for the tab while the wallet connects.
  const claim = useSolanaClaimFromUrl();
  if (!sol) return null;
  if (!sol.address) return <SolanaGate lead={claim && id === "receive" ? <ClaimWaiting body={claim} /> : undefined} />;
  if (id === "shield") return <SolanaAddView />;
  if (id === "pay") return <SolanaSpendView kind="pay" onReceive={onReceive} />;
  if (id === "cashout") return <SolanaSpendView kind="cashout" onReceive={onReceive} />;
  if (id === "receive") return <SolanaReceiveView claim={claim} />;
  return null;
}

/** Above the connect card when a claim link opened the app: what waits, and that the account comes first. */
function ClaimWaiting({ body }: { body: string }) {
  const read = decodeClaim(body);
  if (!read.ok) return null;
  const { asset, amount } = read.claim;
  return (
    <section className="gl-card flex items-center gap-4 p-5 sm:p-6" aria-label="A payment for you">
      <TokenLogo id={asset.id} symbol={asset.symbol} size={40} />
      <div className="min-w-0">
        <p className="text-[15px] text-foreground">
          Someone sent you <span className="tnum font-medium">{formatSolAmount(amount, asset.decimals)} {asset.symbol}</span>
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-mute">Open your private account below, then claim it. It waits in the link until you do.</p>
      </div>
    </section>
  );
}

function useSuccess() {
  const [shown, setShown] = useState<{ title: string; body: string; asset: RingsAsset; amount: bigint; sig: string } | null>(null);
  const modal = (
    <SuccessModal
      open={Boolean(shown)}
      title={shown?.title ?? ""}
      body={shown?.body ?? ""}
      logo={shown ? <TokenLogo id={shown.asset.id} symbol={shown.asset.symbol} size={56} /> : undefined}
      amount={shown ? `${formatSolAmount(shown.amount, shown.asset.decimals)} ${shown.asset.symbol}` : undefined}
      primaryHref={shown ? ringsExplorerTx(shown.sig) : undefined}
      primaryLabel="View on explorer"
      secondaryLabel="Done"
      onClose={() => setShown(null)}
    />
  );
  return { show: setShown, modal };
}

/** Gloam's Solana relay is low on SOL: payments out wait. */
function RelayPaused() {
  return (
    <p className="mt-4 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
      Private payments on Solana are paused for a moment. Try again later.
    </p>
  );
}

// ---------------------------------------------------------------- Add privately

export function SolanaAddView() {
  const sol = useSolana()!;
  const sp = useSearchParams();
  // ZEC shows once it is read as set up (useShownAssets); ?asset=zec waits for that read
  const assets = useShownAssets();
  const [assetId, setAssetId] = useState(() => {
    const want = sp.get("asset");
    return ringsAssets().some((a) => a.id === want) ? want! : assets[0]!.id;
  });
  const [amount, setAmount] = useState("");
  const { show, modal } = useSuccess();
  const asset = assets.find((a) => a.id === assetId) ?? assets[0]!;
  const inWallet = sol.walletBalances?.[asset.id] ?? null;
  // SOL also pays the network fee for adding: keep a little back from Max.
  const spendable = inWallet === null ? null : asset.id === "sol" ? (inWallet > 10_000_000n ? inWallet - 10_000_000n : 0n) : inWallet;
  const problem = amountProblem(amount, asset, inWallet);
  const value = parseSolAmount(amount, asset.decimals);
  const working = sol.task?.kind === "add";
  const stop =
    sol.ready[asset.id] === false
      ? `${asset.symbol} is not set up on Gloam yet`
      : inWallet === 0n
        ? `No ${asset.symbol} in this wallet`
        : !amount.trim() || (value === null && !problem)
          ? "Enter an amount"
          : problem
            ? inWallet !== null && value !== null && value > inWallet
              ? `Not enough ${asset.symbol}`
              : "Enter a valid amount"
            : null;
  const walletEmpty = sol.walletBalances !== null && Object.values(sol.walletBalances).every((v) => v === 0n);
  // Who pays the network fee, by the client's rule (lib/solanaRings/client buildAddFor, which reads the SOL again just before).
  const feePayer =
    sol.main && sol.relay
      ? addFeePayer({ asset, walletLamports: sol.walletBalances?.sol ?? null, relay: sol.relay, signOnly: sol.demo || canSignOnly(sol.main.wallet) })
      : "wallet";

  return (
    <div className="grid items-start gap-6">
      <section className="gl-card min-w-0 p-5 sm:p-7">
        <h2 className="t-title text-foreground">Add privately</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-mute">Move money from your Solana wallet into your private balance.</p>

        <div className="mt-6">
          <SolanaAmountCard
            id="sol-add-amount"
            label="You add"
            balanceLabel="In wallet"
            balance={inWallet}
            spendable={spendable}
            asset={asset}
            assets={assets}
            onAsset={(id) => {
              setAssetId(id);
              setAmount("");
            }}
            amount={amount}
            onAmount={setAmount}
            problem={problem}
            disabled={working}
          />
          <div
            aria-hidden
            className="relative z-10 mx-auto -my-3 grid h-9 w-9 place-items-center rounded-full border-4 border-panel bg-sealed-soft text-sealed"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14m0 0l-5-5m5 5l5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="rounded-[16px] bg-surface p-[16px] sm:p-5">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="text-mute">Into your private balance</span>
              <span className="inline-flex items-center gap-1.5 font-medium text-sealed">
                <span className="h-1.5 w-1.5 rounded-full bg-sealed" aria-hidden />
                Only you
              </span>
            </div>
            <p className="tnum mt-3 truncate text-[28px] font-light leading-none tracking-[-0.02em] text-foreground">
              {value !== null ? typedAmount(amount) : displayAmountText("0")} <span className="text-[15px] tracking-normal text-mute">{asset.symbol}</span>
            </p>
          </div>
        </div>

        <div className="mt-5">
          <SolanaActionButton
            kind="add"
            label={`Add ${asset.symbol} privately`}
            stop={stop}
            onClick={() => {
              if (value === null) return;
              void sol.add(asset, value).then((sig) => {
                if (!sig) return;
                show({
                  title: "Added privately",
                  body: "It is in your private balance now. Only you can see it.",
                  asset,
                  amount: value,
                  sig,
                });
                setAmount("");
              });
            }}
          />
          {walletEmpty && !working && (
            <p className="mt-3 rounded-[16px] bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-soft">
              Nothing to add yet. Send {listOr(assets.map((a) => a.symbol))} to {shortSol(sol.main?.account.address ?? "")} first.
            </p>
          )}
          {feePayer === "relay" && <p className="mt-3 text-center text-[12.5px] leading-relaxed text-mute">Gloam pays the network fee. The deposit shows it came through Gloam.</p>}
          {feePayer === "needs_sol" && !walletEmpty && inWallet !== 0n && !working && (
            <p className="mt-3 rounded-[16px] bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-soft">Your wallet needs a little SOL for the network fee.</p>
          )}
        </div>
        <SolanaSteps task={working ? sol.task : null} className="mt-4" />
        <SolanaError kind="add" className="mt-4" />

        {asset.note && <p className="mt-4 text-center text-[12.5px] leading-relaxed text-mute">{asset.note}</p>}
        <p className={`${asset.note ? "mt-1.5" : "mt-4"} text-center text-[12.5px] text-mute`}>Adding shows your wallet, the token and the amount on Solana.</p>
      </section>

      <SolanaFromAnotherChain />
      {modal}
    </div>
  );
}

/** After money that arrived went private (SolanaBridgeIn): the private balance as the account holds it now. */
function useShowPrivate(): () => void {
  const sol = useSolana();
  const session = sol?.session ?? null;
  const setBalances = sol?.setBalances;
  return useCallback(() => {
    if (session && setBalances) void import("@/lib/solanaRings/client").then((l) => setBalances(l.ringsBalances(session)));
  }, [session, setBalances]);
}

/**
 * Add privately's "from another chain" card, where EVM's Add shows its bridge
 * card: money from another chain into the private balance on Solana
 * (SolanaBridgeIn). Hidden unless NEXT_PUBLIC_SOLANA_BRIDGE_IN is on
 * (lib/solanaRings/bridgeIn solanaBridgeVisible), and in the demo.
 */
export function SolanaFromAnotherChain() {
  const sol = useSolana();
  const onPrivate = useShowPrivate();
  if (!sol?.session || !solanaBridgeVisible(sol.network)) return null;
  return <SolanaBridgeIn session={sol.session} ready={sol.ready} relayFunded={sol.relay?.funded !== false} onPrivate={onPrivate} />;
}

/**
 * Money at the private account's own address that isn't private yet, with
 * Make it private (SolanaArrivals). Shown wherever the balance is: the Vault
 * and Portfolio. Nothing when there is none.
 */
export function SolanaNotPrivateYet() {
  const sol = useSolana();
  const onPrivate = useShowPrivate();
  if (!sol?.session) return null;
  return <SolanaArrivals session={sol.session} onPrivate={onPrivate} />;
}

// ---------------------------------------------------------------- Pay privately and Cash out

/** A request link (#solreq=...) in the address bar, read once on mount: null when there is none. */
function useSolanaRequestFromUrl(network: string): { request: SolanaRequest | null; problem: string | null } {
  const [found, setFound] = useState<{ request: SolanaRequest | null; problem: string | null }>({ request: null, problem: null });
  useEffect(() => {
    const body = requestBodyFromHash(window.location.hash);
    if (!body) return;
    const r = decodeRequest(body);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the request lives in the address bar's fragment, read once after mount
    setFound(
      !r.ok
        ? { request: null, problem: r.why === "unknown" ? "This request is from a newer Gloam. Reload the page and try again." : "This request link is cut off or damaged. Ask them to send it again." }
        : r.request.network !== network
          ? { request: null, problem: `This request is for Solana ${r.request.network}, and this is Gloam on Solana ${network}.` }
          : { request: r.request, problem: null }
    );
  }, [network]);
  return found;
}

function SolanaSpendView({ kind, onReceive }: { kind: "pay" | "cashout"; onReceive: () => void }) {
  const sol = useSolana()!;
  const toUsd = useSolanaUsd();
  const assets = useShownAssets(sol.balances);
  const own = sol.main?.account.address ?? "";
  const firstHeld = sol.balances ? preferredAsset(sol.balances, assets) : null;
  const [assetId, setAssetId] = useState(preferredAsset(sol.balances, assets).id);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState(kind === "cashout" ? own : "");
  // Pay to a private address, or make a claim link anyone can claim (as on the other chains).
  const [style, setStyle] = useState<"direct" | "link">("direct");
  const [made, setMade] = useState<{ url: string; label: string; asset: RingsAsset; amount: bigint } | null>(null);
  const { show, modal } = useSuccess();
  const fromUrl = useSolanaRequestFromUrl(sol.network);
  const [request, setRequest] = useState<SolanaRequest | null>(null);
  const [filledFor, setFilledFor] = useState<SolanaRequest | null>(null);
  // A request link fills in who, what and how much, once.
  useEffect(() => {
    if (kind !== "pay" || !fromUrl.request || filledFor === fromUrl.request) return;
    const r = fromUrl.request;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the request is read from the address bar after mount
    setFilledFor(r);
    setRequest(r);
    setStyle("direct");
    setTo(r.to);
    setAssetId(r.asset.id);
    if (r.amount !== null) setAmount(plainSolAmount(r.amount, r.asset.decimals));
  }, [kind, fromUrl.request, filledFor]);
  // The first read of the balance names the asset to pay with (a request names its own).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the balance arrives after mount
    if (firstHeld && !amount && !request && (sol.balances?.[assetId] ?? 0n) === 0n) setAssetId(firstHeld.id);
  }, [firstHeld, amount, assetId, sol.balances, request]);

  const asset = assets.find((a) => a.id === assetId) ?? assets[0]!;
  const have = sol.balances?.[asset.id] ?? null;
  const problem = amountProblem(amount, asset, have);
  const value = parseSolAmount(amount, asset.decimals);
  const byLink = kind === "pay" && style === "link";
  const working = sol.task?.kind === (byLink ? "link" : kind);
  const target = byLink ? "" : to.trim();
  const shape = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target);
  const toProblem = !target ? null : !shape ? "That isn't a Solana address." : kind === "pay" && target === sol.address ? "That is your own private account." : null;
  const funded = sol.relay?.funded !== false;
  const stop = !funded
    ? "Paused for a moment"
    : sol.ready[asset.id] === false
      ? `${asset.symbol} is not set up on Gloam yet`
      : !target && !byLink
        ? kind === "pay"
          ? "Enter a private address"
          : "Enter an address"
        : toProblem
          ? "Check the address"
          : !amount.trim() || (value === null && !problem)
            ? "Enter an amount"
            : problem
              ? have !== null && value !== null && value > have
                ? `Not enough ${asset.symbol}`
                : "Enter a valid amount"
              : null;
  const empty = sol.balances !== null && Object.values(sol.balances).every((v) => v === 0n);
  const title = kind === "pay" ? "Pay privately" : "Cash out";
  const toMine = kind === "cashout" && target === own;

  return (
    <section className="gl-card min-w-0 p-5 sm:p-7">
      <h2 className="t-title text-foreground">{title}</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-mute">
        {kind === "pay"
          ? "Send from your private balance to a Gloam private account on Solana, or to anyone by claim link."
          : "From your private balance back to any Solana address."}
      </p>

      {kind === "pay" && request && <SolanaRequestBanner request={request} onDismiss={() => setRequest(null)} />}
      {kind === "pay" && fromUrl.problem && (
        <p role="alert" className="mt-5 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
          {fromUrl.problem}
        </p>
      )}

      {empty ? (
        <SolanaEmptyBalance onReceive={onReceive} />
      ) : (
        <>
          {kind === "pay" && (
            <div className="mt-6">
              <p id="sol-pay-to" className="text-[13px] text-mute">
                To
              </p>
              <div role="radiogroup" aria-labelledby="sol-pay-to" className="mt-2 grid grid-cols-2 gap-2">
                {(
                  [
                    ["direct", "Private address", "They already use Gloam"],
                    ["link", "Claim link", "Anyone, even new to Gloam"],
                  ] as const
                ).map(([s, label, hint]) => {
                  const active = style === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={working}
                      onClick={() => {
                        setStyle(s);
                        setMade(null);
                        sol.clearError();
                      }}
                      className={`flex min-h-[60px] min-w-0 items-start gap-3 rounded-[14px] border px-3.5 py-3 text-left transition-colors ${
                        active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
                      }`}
                    >
                      <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors ${active ? "border-foreground bg-foreground" : "border-line-strong"}`}>
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
              {byLink && (
                <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
                  You get a link to send any way you like. They tap it and claim in Gloam. Anyone with the link can claim it, and you can take it back until they do.
                </p>
              )}
            </div>
          )}
          {!byLink && (
          <div className={kind === "pay" ? "mt-5" : "mt-6"}>
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`sol-${kind}-to`} className="text-[13px] text-mute">
                {kind === "pay" ? "To a Gloam private address" : "To"}
              </label>
              {kind === "cashout" && !toMine && own && (
                <button type="button" onClick={() => setTo(own)} className="btn btn-quiet btn-sm -mr-3 h-10 text-mute">
                  Use my wallet
                </button>
              )}
            </div>
            <input
              id={`sol-${kind}-to`}
              className="gl-input mt-1.5 font-mono text-[14px]"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="Solana address"
              disabled={working}
              aria-invalid={Boolean(toProblem) || undefined}
            />
            {toProblem ? (
              <p role="alert" className="mt-1.5 text-[13px] text-danger">
                {toProblem}
              </p>
            ) : toMine ? (
              <p className="mt-1.5 text-[13px] text-mute">Your Solana wallet, {sol.main?.wallet.name}.</p>
            ) : null}
          </div>
          )}

          <div className="mt-5">
            <SolanaAmountCard
              id={`sol-${kind}-amount`}
              label={kind === "pay" ? "You pay" : "You cash out"}
              balanceLabel="Private balance"
              balance={have}
              asset={asset}
              assets={assets}
              onAsset={(id) => {
                setAssetId(id);
                setAmount("");
              }}
              amount={amount}
              onAmount={setAmount}
              problem={problem}
              disabled={working}
            />
          </div>

          <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
            {byLink ? LINK_PRIVACY_NOTE : kind === "pay" ? RINGS_PRIVACY_NOTE : "A cash out shows the address it goes to, the token and the amount. Gloam pays the network fee."}
          </p>
          {!funded && <RelayPaused />}

          <div className="mt-5">
            <SolanaActionButton
              kind={byLink ? "link" : kind}
              label={byLink ? "Make the claim link" : kind === "pay" ? "Pay privately" : toMine ? "Cash out to my wallet" : "Cash out to this address"}
              stop={stop}
              onClick={() => {
                if (value === null) return;
                if (byLink) {
                  void sol.makeLink(asset, value).then((r) => {
                    if (!r) return;
                    setMade({ url: claimLinkUrl(r.body, window.location.origin), label: `${formatSolAmount(value, asset.decimals)} ${asset.symbol}`, asset, amount: value });
                    setAmount("");
                  });
                  return;
                }
                const run = kind === "pay" ? sol.pay(target, asset, value) : sol.cashOut(target, asset, value);
                void run.then((sig) => {
                  if (!sig) return;
                  const dollars = toUsd(asset.id, value);
                  show({
                    title: kind === "pay" ? "Paid privately" : "Cashed out",
                    body:
                      kind === "pay"
                        ? `To ${shortSol(target)}. The token and the amount stay hidden on Solana.${dollars != null ? ` About ${usd(dollars)}.` : ""}`
                        : `To ${toMine ? "your Solana wallet" : shortSol(target)}. It shows on Solana like any transfer.`,
                    asset,
                    amount: value,
                    sig,
                  });
                  setAmount("");
                });
              }}
            />
          </div>
          <SolanaSteps task={working ? sol.task : null} className="mt-4" />
          <SolanaError kind={byLink ? "link" : kind} className="mt-4" />
        </>
      )}
      {kind === "pay" && <SolanaSentLinks />}
      <SuccessModal
        open={Boolean(made)}
        title="Claim link ready"
        body="It is kept under Sent links in this browser too, so you can copy it again or take it back."
        logo={made ? <TokenLogo id={made.asset.id} symbol={made.asset.symbol} size={56} /> : undefined}
        amount={made?.label}
        detail={made ? <SolanaLinkShare url={made.url} kind="claim" label={made.label} stacked /> : undefined}
        secondaryLabel="Done"
        onClose={() => setMade(null)}
      />
      {modal}
    </section>
  );
}

// ---------------------------------------------------------------- Receive

function SolanaReceiveView({ claim }: { claim: string | null }) {
  const sol = useSolana()!;
  const address = sol.address!;
  const assets = useShownAssets(sol.balances);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import("qrcode")
      .then((QR) => QR.toDataURL(address, { margin: 2, width: 272, color: { dark: "#0a0a0a", light: "#ffffff" } }))
      .then((url) => live && setQr(url))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);
  const refreshing = sol.task?.kind === "refresh";

  return (
    <section className="gl-card min-w-0 p-5 sm:p-7">
      <div className="grid gap-x-10 gap-y-7 lg:grid-cols-2 [&>*]:min-w-0">
        <div>
          <h3 className="text-[15px] font-medium text-foreground">Your private address</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">
            People on Gloam pay you privately at this address. The token and the amount stay hidden; the address shows on Solana.
          </p>
          <div className="mt-3 rounded-[16px] border border-line p-[16px]">
            <p className="tnum break-all font-mono text-[13px] leading-relaxed text-foreground">{address}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                aria-live="polite"
                className="btn btn-ink"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(address);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    /* the address stays on screen to copy by hand */
                  }
                }}
              >
                {copied ? "Copied" : "Copy address"}
              </button>
            </div>
          </div>
          <div className="gl-tile mt-3 p-[16px] sm:p-5">
            <div className="flex gap-5 max-sm:flex-col max-sm:items-center">
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element -- made here, never by a third party
                <img src={qr} alt="QR code for your private address on Solana" width={136} height={136} className="h-[136px] w-[136px] shrink-0 rounded-[14px] shadow-card" />
              ) : (
                <div className="grid h-[136px] w-[136px] shrink-0 place-items-center rounded-[14px] bg-panel text-[11px] text-mute">Making QR...</div>
              )}
              <div className="min-w-0 flex-1 max-sm:w-full">
                <p className="text-[15px] font-medium text-foreground">Scan to pay privately</p>
                <p className="mt-1 text-[13px] leading-relaxed text-mute">Anyone on Gloam can scan this to pay you on Solana. Send it any way you like.</p>
              </div>
            </div>
          </div>
        </div>

        {/* stacked on a phone: a hairline above, as EVM's Receive sets off its second part */}
        <SolanaClaimCard initial={claim} />

        <section className="border-t border-line pt-6 lg:col-span-2">
          <h3 className="text-[15px] font-medium text-foreground">Request a payment</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-mute">A link with the amount and a note, like an invoice.</p>
          <SolanaRequestCard />
        </section>

        <div className="border-t border-line pt-6 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[15px] font-medium text-foreground">Payments to you</h3>
            {/* -my-2: the button doesn't push this title below the one beside it */}
            <button type="button" aria-busy={refreshing || undefined} onClick={() => !sol.task && void sol.refresh()} className="btn btn-ghost btn-sm -my-2 h-10">
              Check now
            </button>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-mute">Payments to your private address land in your balance on their own.</p>
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {assets.map((a) => (
              <li key={a.id} className="flex min-h-[56px] items-center justify-between gap-3 py-2.5">
                <span className="flex min-w-0 items-center gap-3">
                  <TokenLogo id={a.id} symbol={a.symbol} size={28} />
                  <span className="text-[14px] text-foreground">{a.symbol}</span>
                </span>
                <span className="tnum text-[14px] text-foreground">
                  {sol.balances ? formatSolAmount(sol.balances[a.id] ?? 0n, a.decimals) : "..."} <span className="text-mute">private</span>
                </span>
              </li>
            ))}
          </ul>
          <SolanaSteps task={refreshing ? sol.task : null} className="mt-4" />
          <SolanaError kind="refresh" className="mt-4" />
        </div>
      </div>
    </section>
  );
}
