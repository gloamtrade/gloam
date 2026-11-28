"use client";

/**
 * Cash out on Starknet, to another network: the person's private balance pays
 * an address on Base, Ethereum or another CCTP chain, in one Starknet
 * transaction (lib/starknetPrivacy/cctpOut says how, who pays what and what is
 * public), and Circle delivers it there. Nothing is needed on that chain.
 *
 * What it costs is shown before anything is proven: what arrives, Circle's fee
 * (its fast transfer and its delivery, all of which it takes) and Gloam's.
 */
import { useId, useMemo, useState } from "react";
import { isAddress } from "viem";
import { chainLogoSrc } from "@/lib/chainLogo";
import type { StarknetToken } from "@/lib/starknetPrivacy/config";
import { CCTP_DESTINATIONS, cashOutToChainCosts, type ForwardFee } from "@/lib/starknetPrivacy/cctpOut";
import type { CctpSource } from "@/lib/starknetPrivacy/cctp";
import { Select, type SelectOption } from "@/components/ui/Select";
import { parseStarkAmount, useStarknet } from "./StarknetAccount";
import { STARKNET_NAME, StarknetActionButton, StarknetAmountCard, StarknetError, StarknetSteps, starkAmount, starkAmountProblem } from "./StarknetParts";

/** "starknet" cashes out on Starknet; a chain id cashes out there. */
export type StarknetCashOutNet = "starknet" | number;

function ChainMark({ id, size = 22 }: { id: number; size?: number }) {
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(id)} alt="" width={size} height={size} className="h-full w-full object-cover dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(id, true)} alt="" width={size} height={size} className="hidden h-full w-full object-cover dark:block" />
    </span>
  );
}

type DestInfo = { domain: number; fastBps: number | null; forward: { low: string; med: string; high: string } | null };

/** The networks a cash out can go to: CCTP destinations Circle priced (fast fee and delivery) when Gloam's relay does it. */
export function cashOutDestinations(info: { on: boolean; destinations?: DestInfo[] } | null): CctpSource[] {
  if (!info?.on || !info.destinations) return [];
  return CCTP_DESTINATIONS.filter((d) => info.destinations!.some((x) => x.domain === d.domain && x.fastBps !== null && x.forward));
}

/** The "To network" picker on Cash out. */
export function StarknetCashOutNetPicker({ value, onChange, destinations, disabled }: { value: StarknetCashOutNet; onChange: (v: StarknetCashOutNet) => void; destinations: CctpSource[]; disabled?: boolean }) {
  const options = useMemo<SelectOption<string>[]>(
    () => [
      { value: "starknet", label: STARKNET_NAME, description: "Any Starknet address" },
      ...destinations.map((d) => ({ value: String(d.chainId), label: d.name, icon: <ChainMark id={d.chainId} />, description: `Any address on ${d.name}, delivered by Circle` })),
    ],
    [destinations]
  );
  return (
    <div className="gl-inputcard p-5 sm:p-6">
      <p className="text-[13px] text-mute">To network</p>
      <Select label="Cash out to network" value={String(value)} onChange={(v) => onChange(v === "starknet" ? "starknet" : Number(v))} options={options} disabled={disabled} className="mt-2 w-full" />
    </div>
  );
}

/** Cash out from the private balance to an address on `dest`. */
export function StarknetCashOutTo({
  dest,
  token,
  onDone,
}: {
  dest: CctpSource;
  token: StarknetToken;
  onDone: (r: { hash: string; arrives: bigint; delivered: boolean }) => void;
}) {
  const sn = useStarknet()!;
  const id = useId();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const value = parseStarkAmount(amount, token.decimals);
  const info = sn.cctp?.destinations?.find((d) => d.domain === dest.domain) ?? null;
  const forward: ForwardFee | null = info?.forward ? { low: BigInt(info.forward.low), med: BigInt(info.forward.med), high: BigInt(info.forward.high) } : null;
  const burnFee = BigInt(sn.cctp?.fee ?? "0");
  const gloamFee = sn.fee + burnFee;
  const costs = value !== null && info?.fastBps != null && forward ? cashOutToChainCosts(value, info.fastBps, forward, sn.fee, burnFee) : null;
  const working = sn.task?.kind === "cashout";
  const problem = starkAmountProblem(amount, token, sn.privateBalance, gloamFee);
  const badTo = to.trim() !== "" && !isAddress(to.trim());
  const stop =
    !sn.relay?.funded || sn.relay.moves === "off"
      ? "Paused for a moment"
      : info?.fastBps == null || !forward
        ? "Circle's fee isn't available right now"
        : !isAddress(to.trim())
          ? `Enter an address on ${dest.name}`
          : !amount.trim() || !value
            ? "Enter an amount"
            : (problem ?? (!costs ? "That is less than Circle's fee" : null));

  return (
    <>
      <div className="gl-inputcard p-5 sm:p-6" data-invalid={badTo || undefined}>
        <label htmlFor={id} className="text-[13px] text-mute">
          To (an address on {dest.name})
        </label>
        <input
          id={id}
          value={to}
          disabled={working}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTo(e.target.value.trim())}
          placeholder="0x..."
          className="tnum mt-2 w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none! placeholder:text-faint"
        />
        <p className={`mt-1 min-h-5 text-[13px] ${badTo ? "text-danger" : "text-mute"}`} role={badTo ? "alert" : undefined}>
          {badTo ? `That isn't an address on ${dest.name}` : " "}
        </p>
      </div>
      <div className="mt-3">
        <StarknetAmountCard
          id={`sn-cashout-${dest.chainId}`}
          label="Cash out"
          balanceLabel="Private balance"
          balance={sn.privateBalance}
          token={token}
          amount={amount}
          onAmount={setAmount}
          problem={problem}
          disabled={working}
        />
      </div>
      <dl className="mt-3 divide-y divide-line text-[13.5px]">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">They get on {dest.name}</dt>
          <dd className="tnum text-right text-foreground">{costs ? `${starkAmount(costs.arrives, token)} ${token.symbol}` : value !== null && forward ? "Less than Circle's fee" : `0.00 ${token.symbol}`}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Circle&apos;s fee</dt>
          <dd className="tnum text-right text-foreground">
            {costs
              ? `${starkAmount(costs.circle, token)} ${token.symbol}, with delivery on ${dest.name}`
              : forward
                ? `About ${starkAmount(forward.high, token)} ${token.symbol} to deliver, plus ${Number(((info?.fastBps ?? 0) / 100).toFixed(4))}%`
                : "Not available right now"}
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Gloam&apos;s fee</dt>
          <dd className="tnum text-right text-foreground">
            {starkAmount(gloamFee, token)} {token.symbol}, from your private balance
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Arrives</dt>
          <dd className="text-right text-foreground">In a few minutes</dd>
        </div>
      </dl>
      <StarknetActionButton
        kind="cashout"
        label={`Cash out to ${dest.name}`}
        stop={stop}
        className="mt-5"
        onClick={() =>
          void sn.cashOutTo(dest.chainId, to.trim(), value!).then((r) => {
            if (!r) return;
            setAmount("");
            onDone(r);
          })
        }
      />
      <StarknetSteps task={working ? sn.task : null} className="mt-4" />
      <StarknetError kind="cashout" className="mt-4" />
      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
        It leaves through a one-time account, never your own. Like any cash out, the amount and the address on {dest.name} are public, never which private account it came from.
      </p>
    </>
  );
}
