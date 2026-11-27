"use client";

/**
 * The Vault on Starknet: the same overview, action row and forms as on the
 * other networks (VaultHome, VaultHub's row, the big amount card), over the
 * Starknet account (StarknetAccount). Starknet has Add privately, Pay
 * privately, Receive and Cash out; Swap, Agent top-ups and Public send are not
 * on Starknet yet, so they are not listed.
 *
 * What each screen says follows lib/starknetPrivacy/config, once and plainly:
 * a payment over an open channel hides who paid, who was paid and how much;
 * the first payment to someone shows their private account; adding shows the
 * account and the amount; a cash out shows where it went and how much.
 */
import Link from "next/link";
import { useState } from "react";
import { STARKNET_NETWORK, type StarknetToken } from "@/lib/starknetPrivacy/config";
import { STARKNET_VAULT_ACTIONS } from "@/lib/starknetPrivacy/vaultActions";
import { ADD_FIRST, type VaultActionId, type VaultActionInfo } from "@/lib/vaultHub";
import { ActionTile, BalancePane, QuickRow, type Holding } from "./VaultHome";
import { SuccessModal } from "./SuccessModal";
import { TokenLogo } from "./TokenLogo";
import { parseStarkAmount, useStarknet } from "./StarknetAccount";
import {
  STARKNET_NAME,
  StarknetActionButton,
  StarknetAddressCopy,
  StarknetAddressField,
  StarknetAmountCard,
  StarknetEmptyBalance,
  StarknetError,
  StarknetGate,
  StarknetPrivacyNote,
  StarknetSteps,
  isStarkAddress,
  starkAmount,
  starkAmountProblem,
} from "./StarknetParts";

/** A transaction on Starknet's explorer (Voyager), or null on a local devnet. */
export function starknetExplorerTx(hash: string): string | null {
  if (STARKNET_NETWORK === "mainnet") return `https://voyager.online/tx/${hash}`;
  if (STARKNET_NETWORK === "sepolia") return `https://sepolia.voyager.online/tx/${hash}`;
  return null;
}

function holding(v: bigint | null, token: StarknetToken | null): Holding[] {
  if (v === null || !token || v <= 0n) return [];
  return [{ id: token.symbol.toLowerCase(), symbol: token.symbol, logoId: "usdc", text: starkAmount(v, token), amount: Number(v) / 10 ** token.decimals, dollar: true }];
}

// ---------------------------------------------------------------- overview

export function StarknetVaultHome({ missing }: { missing?: string | null }) {
  const sn = useStarknet();
  if (!sn) return null;
  const { address, token, privateBalance, publicBalance } = sn;
  const privateRows = holding(privateBalance, token);
  const walletRows = holding(publicBalance, token);
  const known = Boolean(address && privateBalance !== null);
  const hasPrivate = privateRows.length > 0;
  const blockedFor = (a: VaultActionInfo) => (known && !hasPrivate && (a.id === "pay" || a.id === "cashout") ? ADD_FIRST : null);
  const symbol = token?.symbol ?? "USDC";

  const next = hasPrivate
    ? {
        text: `Pay privately from your private balance, or cash out to any ${STARKNET_NAME} address.`,
        action: (
          <Link href="/app/vault?tab=move" className="btn btn-ink">
            Pay privately
          </Link>
        ),
      }
    : walletRows[0]
      ? {
          text: `${walletRows[0].text} ${symbol} is on your Starknet account. Add it privately.`,
          action: (
            <Link href="/app/vault?tab=shield" className="btn btn-ink">
              Add privately
            </Link>
          ),
        }
      : { text: `Nothing to add yet. Send ${symbol} on ${STARKNET_NAME} to your Starknet account first.`, action: null };

  return (
    <div className="space-y-6">
      {missing && (
        <p role="status" className="rounded-[16px] bg-surface px-4 py-3 text-[14px] text-soft">
          {missing} is not on Starknet yet. Here is what Gloam does on Starknet.
        </p>
      )}
      <QuickRow actions={STARKNET_VAULT_ACTIONS} blockedFor={blockedFor} />

      {!address ? (
        <StarknetGate />
      ) : (
        <section className="gl-card overflow-hidden" aria-labelledby="vault-money-title">
          <div className="flex items-center justify-between gap-3 px-5 pt-5 sm:px-7 sm:pt-6">
            <h2 id="vault-money-title" className="text-[15px] text-foreground">
              Your money on {STARKNET_NAME}
            </h2>
          </div>
          <div className="mt-4 grid gap-px border-y border-line bg-line sm:grid-cols-2">
            <BalancePane
              sealed
              title="Private balance"
              badge="Only you"
              rows={privateRows}
              loading={privateBalance === null}
              empty="0.00"
              note={hasPrivate ? "Read and decrypted on this device." : "Nothing here yet. Only you will see this number."}
            />
            <BalancePane
              sealed={false}
              title="On your Starknet account"
              badge={null}
              rows={walletRows}
              loading={publicBalance === null}
              empty="0.00"
              note="Not private yet. Anyone can see this on the explorer."
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
          {STARKNET_VAULT_ACTIONS.map((a) => (
            <li key={a.id} className="min-w-0">
              <ActionTile action={a} blocked={blockedFor(a)} />
            </li>
          ))}
        </ul>
      </section>

      {address && <StarknetPrivacyNote className="max-w-[68ch] px-1 text-[13px]" />}
    </div>
  );
}

// ---------------------------------------------------------------- the panel under the action row

export function StarknetVaultPanel({ id, onReceive }: { id: VaultActionId; onReceive: () => void }) {
  const sn = useStarknet();
  if (!sn) return null;
  if (!sn.address || !sn.token) return <StarknetGate />;
  if (id === "shield") return <StarknetAddView token={sn.token} />;
  if (id === "pay") return <StarknetSpendView kind="pay" token={sn.token} onReceive={onReceive} />;
  if (id === "cashout") return <StarknetSpendView kind="cashout" token={sn.token} onReceive={onReceive} />;
  if (id === "receive") return <StarknetReceiveView />;
  return null;
}

type Shown = { title: string; body: string; amount: bigint; hash: string };

function useSuccess(token: StarknetToken) {
  const [shown, setShown] = useState<Shown | null>(null);
  const href = shown ? starknetExplorerTx(shown.hash) : null;
  const modal = (
    <SuccessModal
      open={Boolean(shown)}
      title={shown?.title ?? ""}
      body={shown?.body ?? ""}
      logo={<TokenLogo id="usdc" symbol={token.symbol} size={56} />}
      amount={shown ? `${starkAmount(shown.amount, token)} ${token.symbol}` : undefined}
      primaryHref={href ?? undefined}
      primaryLabel={href ? "View on explorer" : undefined}
      secondaryLabel="Done"
      onClose={() => setShown(null)}
    />
  );
  return { show: setShown, modal };
}

function RelayPaused() {
  return (
    <p className="mt-4 rounded-[16px] bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
      Private payments on {STARKNET_NAME} are paused for a moment. Try again later.
    </p>
  );
}

/** Gloam's fee on a move, when it asks one. */
function FeeLine({ fee, token }: { fee: bigint; token: StarknetToken }) {
  if (fee <= 0n) return null;
  return (
    <p className="tnum mt-3 text-[13px] text-mute">
      Gloam&apos;s fee: {starkAmount(fee, token)} {token.symbol}, from your private balance
    </p>
  );
}

// ---------------------------------------------------------------- Add privately

function StarknetAddView({ token }: { token: StarknetToken }) {
  const sn = useStarknet()!;
  const [amount, setAmount] = useState("");
  const { show, modal } = useSuccess(token);
  const balance = sn.publicBalance;
  const problem = starkAmountProblem(amount, token, balance);
  const value = parseStarkAmount(amount, token.decimals);
  const tooSmall = value !== null && sn.fee > 0n && value <= sn.fee ? `More than Gloam's fee of ${starkAmount(sn.fee, token)} ${token.symbol}` : null;
  // The relay approves at most this much for one add, and refuses more before anything moves.
  const tooBig = value !== null && sn.maxAdd > 0n && value > sn.maxAdd ? `One add moves at most ${starkAmount(sn.maxAdd, token)} ${token.symbol}` : null;
  const working = sn.task?.kind === "add";
  const stop = !sn.relay?.funded ? "Paused for a moment" : !amount.trim() || !value ? "Enter an amount" : (problem ?? tooSmall ?? tooBig);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="gl-card p-5 sm:p-7">
        <h2 className="t-title text-foreground">Add privately</h2>
        <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
          Move {token.symbol} that sits on your Starknet account into your private balance. Adding shows your account and the amount.
        </p>
        <div className="mt-5">
          <StarknetAmountCard
            id="sn-add-amount"
            label="Add"
            balanceLabel="On your account"
            balance={balance}
            token={token}
            amount={amount}
            onAmount={setAmount}
            problem={problem}
            disabled={working}
          />
        </div>
        <FeeLine fee={sn.fee} token={token} />
        {!sn.relay?.funded && <RelayPaused />}
        <StarknetActionButton
          kind="add"
          label="Add privately"
          stop={stop}
          className="mt-5"
          onClick={() =>
            void sn.add(value!).then((hash) => {
              if (!hash) return;
              setAmount("");
              show({ title: "Added privately", body: "It's in your private balance now.", amount: value!, hash });
            })
          }
        />
        <StarknetSteps task={working ? sn.task : null} className="mt-4" />
        <StarknetError kind="add" className="mt-4" />
      </section>
      <aside className="gl-card p-5 sm:p-6">
        <h3 className="text-[15px] text-foreground">Fund your Starknet account</h3>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-mute">
          Send {token.symbol} on {STARKNET_NAME} to this address from any Starknet wallet or exchange. Then add it privately here.
        </p>
        <div className="mt-4">
          <StarknetAddressCopy address={sn.address!} label="Your Starknet account" />
        </div>
        <p className="mt-4 text-[12.5px] leading-relaxed text-mute">Bringing money in from other networks is coming.</p>
      </aside>
      {modal}
    </div>
  );
}

// ---------------------------------------------------------------- Pay privately and Cash out

function StarknetSpendView({ kind, token, onReceive }: { kind: "pay" | "cashout"; token: StarknetToken; onReceive: () => void }) {
  const sn = useStarknet()!;
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const { show, modal } = useSuccess(token);
  const balance = sn.privateBalance;
  const pay = kind === "pay";
  const problem = starkAmountProblem(amount, token, balance, sn.fee);
  const value = parseStarkAmount(amount, token.decimals);
  const working = sn.task?.kind === kind;
  const self = sn.address && to && isStarkAddress(to) && BigInt(to) === BigInt(sn.address);
  const stop = !sn.relay?.funded
    ? "Paused for a moment"
    : !isStarkAddress(to)
      ? pay
        ? "Enter a private account"
        : "Enter an address"
      : self
        ? "That's your own account"
        : !amount.trim() || !value
          ? "Enter an amount"
          : problem;

  if (balance !== null && balance === 0n && !working) {
    // A move that spent the whole balance lands here: its success shows over the empty state.
    return (
      <section className="gl-card p-5 sm:p-7">
        <h2 className="t-title text-foreground">{pay ? "Pay privately" : "Cash out"}</h2>
        <StarknetEmptyBalance onReceive={onReceive} />
        {modal}
      </section>
    );
  }

  return (
    <section className="gl-card max-w-[720px] p-5 sm:p-7">
      <h2 className="t-title text-foreground">{pay ? "Pay privately" : "Cash out"}</h2>
      <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
        {pay
          ? "Pay another private account on Starknet. The first payment to someone shows their private account; after that, nothing about a payment shows."
          : `Send from your private balance to any ${STARKNET_NAME} address. A cash out shows where it went and how much, never which account it came from.`}
      </p>
      <div className="mt-5 space-y-3">
        <StarknetAddressField label={pay ? "To (their private account)" : "To (any Starknet address)"} value={to} onChange={setTo} placeholder="0x..." disabled={working} />
        <StarknetAmountCard
          id={`sn-${kind}-amount`}
          label={pay ? "Pay" : "Cash out"}
          balanceLabel="Private balance"
          balance={balance}
          token={token}
          amount={amount}
          onAmount={setAmount}
          problem={problem}
          disabled={working}
        />
      </div>
      <FeeLine fee={sn.fee} token={token} />
      {!sn.relay?.funded && <RelayPaused />}
      <StarknetActionButton
        kind={kind}
        label={pay ? "Pay privately" : "Cash out"}
        stop={stop}
        className="mt-5"
        onClick={() =>
          void (pay ? sn.pay(to, value!) : sn.cashOut(to, value!)).then((hash) => {
            if (!hash) return;
            setAmount("");
            show({
              title: pay ? "Paid privately" : "Cashed out",
              body: pay ? "They'll see it in their private balance." : "It's on its way to that address.",
              amount: value!,
              hash,
            });
          })
        }
      />
      <StarknetSteps task={working ? sn.task : null} className="mt-4" />
      <StarknetError kind={kind} className="mt-4" />
      {modal}
    </section>
  );
}

// ---------------------------------------------------------------- Receive

function StarknetReceiveView() {
  const sn = useStarknet()!;
  return (
    <section className="gl-card max-w-[720px] p-5 sm:p-7">
      <h2 className="t-title text-foreground">Receive</h2>
      <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
        Share your private account to get paid privately on Starknet. The first payment to it shows this address; after that, nothing about a payment shows.
      </p>
      <div className="mt-5">
        <StarknetAddressCopy address={sn.address!} label="Your private account on Starknet" />
      </div>
    </section>
  );
}
