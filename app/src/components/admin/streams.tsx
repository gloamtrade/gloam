"use client";

/**
 * The run cards: vault transactions on chain, bridges and swaps through
 * Relay, and product events. Each mark is one real event, newest on the
 * right; red is only ever a failure.
 */
import { getNetwork, isNetworkKey } from "@/lib/networks";
import { relayChainName } from "@/lib/bridge";
import type { RecentRow } from "@/lib/onchainMetrics";
import type { StoredEvent } from "@/lib/tractionStore";
import { StreamCard, StreamIcon } from "./cards";
import { MarkKey, TickRow, type Mark, type Point } from "./charts";
import { adminName, MAINNET_DAY } from "./data";
import { agoMs, dayOfMonth, fmtAge, fmtDay, fmtUsd, n, nShort } from "./format";
import { sideRevenueDays, type LiveRelay, type Side } from "./side";
import { Panel, Notice } from "./ui";

const KIND_WORD: Record<RecentRow["kind"], string> = {
  deposit: "Deposit",
  cashout: "Cash-out",
  transfer: "Private payment",
  trade: "Private swap",
};

const perDay = (v: number) => `${nShort(v)} a day`;

/** On-chain vault transactions, one row per network. */
export function VaultStream({ side }: { side: Side }) {
  const { agg, nets, oc } = side;
  // Transactions a day: the money days (30) when read, else the chain's 14.
  const money = sideRevenueDays(side);
  const chainDays = side.isMain && agg?.sinceLaunch?.length ? agg.sinceLaunch.slice(-30) : (agg?.daily ?? []).filter((d) => !side.isMain || d.day >= MAINNET_DAY);
  const points: Point[] = money.length
    ? money.map((d) => ({ label: fmtDay(d.day), axis: dayOfMonth(d.day), value: d.txs, display: `${n(d.txs)} transactions` }))
    : chainDays.map((d) => {
        const v = d.deposits + d.transfers + d.cashouts + d.trades;
        return { label: fmtDay(d.day), axis: dayOfMonth(d.day), value: v, display: `${n(v)} transactions` };
      });
  const total = agg ? agg.deposits + agg.transfers + agg.cashouts + agg.trades : 0;
  const readFailed = nets.filter((m) => m.error).length;
  const windowTotal = points.reduce((a, p) => a + p.value, 0);

  if (!oc || !agg) {
    return (
      <Panel title="Vault activity" sub="On chain, every network on this side">
        <div className="gl-skeleton h-[220px]" role="status" aria-label="Reading the chains" />
      </Panel>
    );
  }
  return (
    <StreamCard
      icon={<StreamIcon kind="vault" />}
      title="Vault activity"
      sub={`${nets.length} ${nets.length === 1 ? "network" : "networks"} · chain read ${fmtAge(oc.ageSec)}`}
      elapsed={agg.lastActivity ? agoMs(agg.lastActivity * 1000) : "None yet"}
      tally={[
        { value: total, word: "landed" },
        ...(readFailed ? [{ value: readFailed, word: readFailed === 1 ? "read failed" : "reads failed", fail: true }] : []),
      ]}
      chartLabel="Transactions a day"
      chartUnit={perDay}
      points={points}
      chartFoot={`${points.length} days · ${n(windowTotal)} transactions`}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <MarkKey
            items={[
              ["private", "Private payment or swap"],
              ["public", "Deposit or cash-out"],
            ]}
          />
          <p className="text-[12px] text-faint">Latest per network, one mark each, newest on the right</p>
        </div>
      }
    >
      {nets.map((m) => {
        const net = getNetwork(m.key);
        const marks: Mark[] = [...m.recent]
          .sort((a, b) => a.ts - b.ts || Number(a.block) - Number(b.block))
          .map((r) => ({
            tone: r.kind === "transfer" || r.kind === "trade" ? "private" : "public",
            title: `${KIND_WORD[r.kind]}${r.kind === "deposit" || r.kind === "cashout" ? `, ${r.detail}` : ""}${r.ts ? `, ${agoMs(r.ts * 1000)}` : `, block ${r.block}`}`,
          }));
        return (
          <TickRow
            key={m.key}
            label={adminName(net)}
            marks={marks}
            right={m.error ? "read failed" : m.lastActivity ? agoMs(m.lastActivity * 1000) : "none yet"}
            rightTone={m.error ? "danger" : "mute"}
          />
        );
      })}
    </StreamCard>
  );
}

const STAGE_MARK: Record<LiveRelay["recent"][number]["stage"], Mark["tone"]> = {
  done: "ok",
  failed: "failed",
  refunded: "failed",
  pending: "pending",
};
const STAGE_WORD: Record<LiveRelay["recent"][number]["stage"], string> = {
  done: "Done",
  failed: "Failed",
  refunded: "Refunded",
  pending: "In flight",
};

/** Bridges and swaps through Relay: requests a day, then the latest requests by source chain. */
export function BridgeStream({ side }: { side: Side }) {
  const relay = side.relay;
  const live = side.liveRelay;
  if (!live) {
    const failed = relay && "error" in relay ? relay.error : null;
    const off = relay && "enabled" in relay && !relay.enabled ? relay.reason : null;
    return (
      <Panel title="Bridges and swaps" sub="Relay">
        {relay == null ? (
          <div className="gl-skeleton h-[160px]" role="status" aria-label="Reading Relay" />
        ) : (
          <Notice tone={failed ? "danger" : "info"}>
            {failed
              ? `Relay: ${failed}`
              : `Volume from Relay is off. ${off ?? ""} Add RELAY_API_KEY on Vercel to tag new quotes as gloam.trade and read them back here.`}
          </Notice>
        )}
      </Panel>
    );
  }
  const points: Point[] = live.daily.map((d) => {
    const v = d.bridges + d.swaps;
    return { label: fmtDay(d.day), axis: dayOfMonth(d.day), value: v, display: `${n(v)} finished` };
  });
  const recent = [...live.recent].sort((a, b) => a.ts - b.ts);
  // a red marker on each day a recent request failed or was refunded
  const badDays = new Set(recent.filter((r) => r.stage === "failed" || r.stage === "refunded").map((r) => new Date(r.ts * 1000).toISOString().slice(0, 10)));
  const marks = live.daily.map((d, i) => (badDays.has(d.day) ? i : -1)).filter((i) => i >= 0);
  const groups = new Map<string, typeof recent>();
  for (const r of recent) {
    const k = `${relayChainName(r.fromChainId)}${r.kind === "swap" ? ", swap" : ""}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const finished = live.all.bridge.count + live.all.swap.count;
  const newest = recent.at(-1);
  return (
    <StreamCard
      icon={<StreamIcon kind="bridge" />}
      title="Bridges and swaps"
      sub={`Relay · ${n(live.pending)} in flight · ${n(live.refunded)} refunded`}
      elapsed={newest ? agoMs(newest.ts * 1000) : "None yet"}
      tally={[
        { value: finished, word: "finished" },
        { value: live.failed, word: "failed", fail: true },
      ]}
      chartLabel="Finished a day"
      chartUnit={perDay}
      points={points}
      marks={marks}
      chartFoot={`${points.length} days · ${fmtUsd(live.last30.bridge.inUsd + live.last30.swap.inUsd)} bridged and swapped`}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <MarkKey
            items={[
              ["ok", "Done"],
              ["failed", "Failed or refunded"],
              ["pending", "In flight"],
            ]}
          />
          <p className="text-[12px] text-faint">Latest {n(recent.length)} requests by source chain, one mark each</p>
        </div>
      }
    >
      {rows.length === 0 ? (
        <li className="text-[13px] text-mute">No requests yet</li>
      ) : (
        rows.map(([k, list]) => {
          const bad = list.filter((r) => r.stage === "failed" || r.stage === "refunded").length;
          const usd = list.filter((r) => r.stage === "done").reduce((a, r) => a + (r.inUsd ?? 0), 0);
          return (
            <TickRow
              key={k}
              label={k}
              marks={list.map((r) => ({
                tone: STAGE_MARK[r.stage],
                title: `${STAGE_WORD[r.stage]}: ${r.inAmount ? Number(r.inAmount).toLocaleString("en-US", { maximumFractionDigits: 6 }) : ""} ${r.inSymbol}, ${agoMs(r.ts * 1000)}`,
              }))}
              right={bad ? `${n(bad)} failed` : fmtUsd(usd)}
              rightTone={bad ? "danger" : "mute"}
            />
          );
        })
      )}
    </StreamCard>
  );
}

/** Events that mean a flow finished; `_failed` ones are failures; the rest are steps and views. */
const DONE_EVENTS = new Set([
  "shield_success",
  "private_pay_success",
  "unshield_success",
  "unshield_private",
  "unshield_xchain",
  "unshield_scheduled",
  "sealed_swap_success",
  "swap_success",
  "bridge_arrived",
  "bridge_private_landed",
  "bridge_wallet_sent",
  "payroll_run_finished",
  "payment_request_paid",
  "proof_created",
  "proof_verified",
  "claim_secure",
  "schedule_run",
]);

function eventTone(t: string): Mark["tone"] {
  if (/_failed$/.test(t)) return "failed";
  return DONE_EVENTS.has(t) ? "ok" : "pending";
}

/** Product events: a day's count, then the latest events grouped by name. */
export function ProductStream({ side }: { side: Side }) {
  const { prod } = side;
  const days = prod.daily.filter((d) => !side.isMain || d.day >= MAINNET_DAY);
  const points: Point[] = days.map((d) => {
    const v = Object.values(d.counters).reduce((a, b) => a + b, 0);
    return { label: fmtDay(d.day), axis: dayOfMonth(d.day), value: v, display: `${n(v)} events` };
  });
  const failedOn = (d: (typeof days)[number]) => Object.entries(d.counters).reduce((a, [k, v]) => a + (/_failed$/.test(k) ? v : 0), 0);
  const marks = days.map((d, i) => (failedOn(d) > 0 ? i : -1)).filter((i) => i >= 0);
  const windowTotal = points.reduce((a, p) => a + p.value, 0);
  const windowFailed = days.reduce((a, d) => a + failedOn(d), 0);

  const recent = [...prod.recent].sort((a, b) => a.ts - b.ts);
  const groups = new Map<string, StoredEvent[]>();
  for (const ev of recent) groups.set(ev.t, [...(groups.get(ev.t) ?? []), ev]);
  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 7);
  const newest = recent.at(-1);

  if (!side.data) {
    return (
      <Panel title="Product events" sub="Analytics">
        <div className="gl-skeleton h-[220px]" role="status" aria-label="Reading events" />
      </Panel>
    );
  }
  return (
    <StreamCard
      icon={<StreamIcon kind="events" />}
      title="Product events"
      sub={`Visitors who accepted analytics · ${side.isMain ? "mainnet" : "testnets"}`}
      elapsed={newest ? agoMs(newest.ts) : "None yet"}
      tally={[
        { value: windowTotal, word: `in ${points.length} days` },
        { value: windowFailed, word: "failed", fail: true },
      ]}
      chartLabel="Events a day"
      chartUnit={perDay}
      points={points}
      marks={marks}
      chartFoot={`${points.length} days · a red mark is a day with a failure`}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <MarkKey
            items={[
              ["ok", "Finished"],
              ["pending", "Step or view"],
              ["failed", "Failed"],
            ]}
          />
          <p className="text-[12px] text-faint">Latest {n(recent.length)} events, one mark each</p>
        </div>
      }
    >
      {rows.length === 0 ? (
        <li className="text-[13px] text-mute">No {side.money} events among the latest ones</li>
      ) : (
        rows.map(([t, list]) => {
          const bad = list.filter((e) => eventTone(e.t) === "failed").length;
          return (
            <TickRow
              key={t}
              label={t}
              marks={list.map((e) => ({
                tone: eventTone(e.t),
                title: `${e.t}${e.path ? ` on ${e.path}` : ""}, ${agoMs(e.ts)}${typeof e.meta?.network === "string" && isNetworkKey(e.meta.network) ? `, ${adminName(getNetwork(e.meta.network))}` : ""}`,
              }))}
              right={bad ? `${n(bad)} failed` : n(list.length)}
              rightTone={bad ? "danger" : "mute"}
            />
          );
        })
      )}
    </StreamCard>
  );
}
