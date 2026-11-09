/**
 * Spending-limit tests: policy loading, every refusal path, the rolling daily
 * window, the spending log, the reports, and a multi-process race on the log.
 *
 *   pnpm --filter @gloamtrade/mcp test
 *
 * Nothing here touches a chain: spends are checked and reserved, never signed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnits, type Address } from "viem";
import { GLOAM_NETWORKS, NATIVE_ASSET, RH_USDG, TEMPO_PATHUSD } from "@gloamtrade/sdk";
import { checkSpend, loadPolicy, parseExpiry, type Spend } from "../src/policy.js";
import { authorizeSpend, limitsReport, previewSpend, settleSpend, spendingReport } from "../src/spendGuard.js";

type Env = Record<string, string | undefined>;

const TEMPO = GLOAM_NETWORKS.tempo;
const RH = GLOAM_NETWORKS.robinhood;
/**
 * Noon (UTC) of the day the test runs. The spending log drops entries over 30 days old
 * by the real clock when it writes, so a fixed date here stops working a month later.
 */
const NOW = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 43_200_000;
const PAYEE = "gloamr1.payee-tag-for-tests";
const OTHER = "gloamr1.someone-else";

const pathusd = (n: string) => parseUnits(n, 6);

function pay(amount: string, over: Partial<Spend & { pool: Address }> = {}): Spend & { pool?: Address } {
  return {
    tool: "pay",
    network: "tempo",
    chainId: TEMPO.chainId,
    asset: TEMPO_PATHUSD,
    amountWei: pathusd(amount),
    recipient: PAYEE,
    pool: TEMPO.pool,
    ...over,
  };
}

/** A fresh temp dir with a limits file for agent "bot", and the env pointing at it. */
function setup(agentConfig: unknown, agent = "bot"): Env {
  const dir = mkdtempSync(join(tmpdir(), "gloam-limits-"));
  const file = join(dir, "limits.json");
  writeFileSync(file, JSON.stringify({ agents: { [agent]: agentConfig } }));
  return { GLOAM_AGENT_ID: agent, GLOAM_LIMITS_FILE: file, GLOAM_SPEND_LOG: join(dir, "spend-log.json") };
}

const BASIC = {
  recipients: [PAYEE, "0xAbCdEf0000000000000000000000000000000001"],
  tools: ["pay", "send"],
  expiresAt: "2099-12-31",
  assets: { PathUSD: { maxPerPayment: "5", maxPerDay: "12" } },
};

const read = (p: string) => readFileSync(p, "utf8");

// ------------------------------------------------------------------ child mode (race test)

if (process.argv.includes("--reserve-once")) {
  const env = JSON.parse(process.env.TEST_ENV!) as Env;
  const gate = authorizeSpend(pay("5"), env, NOW);
  process.stdout.write(gate.ok ? "ok" : "refused");
} else {
  // ---------------------------------------------------------------- loading

  test("no limits configured: every spend is refused, and the refusal is logged", () => {
    const dir = mkdtempSync(join(tmpdir(), "gloam-limits-"));
    const env: Env = { GLOAM_SPEND_LOG: join(dir, "log.json") };
    assert.equal(loadPolicy(env, read).mode, "unset");
    const gate = authorizeSpend(pay("1"), env, NOW);
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.equal(gate.refusal.code, "limits_unset");
      assert.match(gate.refusal.message, /GLOAM_LIMITS_FILE/);
    }
    const log = JSON.parse(read(env.GLOAM_SPEND_LOG!));
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].status, "refused");
  });

  test("GLOAM_LIMITS=off allows and still logs; mixing it with limits is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "gloam-limits-"));
    const env: Env = { GLOAM_LIMITS: "off", GLOAM_SPEND_LOG: join(dir, "log.json") };
    const gate = authorizeSpend(pay("999"), env, NOW);
    assert.equal(gate.ok, true);
    assert.equal(spendingReport(10, env, NOW).recentPayments?.length, 1);
    assert.equal(loadPolicy({ GLOAM_LIMITS: "off", GLOAM_LIMIT_ASSETS: "PathUSD" }, read).mode, "invalid");
  });

  test("inline env limits resolve symbols to real addresses and decimals", () => {
    const loaded = loadPolicy(
      {
        GLOAM_AGENT_ID: "inline",
        GLOAM_LIMIT_ASSETS: "PathUSD, usdg",
        GLOAM_LIMIT_MAX_PER_PAYMENT: "2.5",
        GLOAM_LIMIT_MAX_PER_DAY: "20",
        GLOAM_LIMIT_RECIPIENTS: "any",
        GLOAM_LIMIT_EXPIRES: "2026-11-30",
        GLOAM_LIMIT_TOOLS: "pay",
      },
      read
    );
    assert.equal(loaded.mode, "enforced");
    if (loaded.mode !== "enforced") return;
    const p = loaded.policy;
    assert.equal(p.agent, "inline");
    assert.deepEqual(p.tools, ["pay"]);
    assert.equal(p.recipients, "any");
    assert.equal(p.assets[0].address, TEMPO_PATHUSD);
    assert.equal(p.assets[0].chainId, TEMPO.chainId);
    assert.equal(p.assets[0].maxPerPayment, pathusd("2.5"));
    assert.equal(p.assets[1].address, RH_USDG);
    assert.equal(p.expiresAt?.toISOString(), "2026-11-30T23:59:59.999Z");
  });

  test("bad configs fail closed with a plain reason", () => {
    const cases: [unknown, RegExp][] = [
      [{ ...BASIC, assets: ["DOGE"] }, /Unknown asset "DOGE"/],
      [{ ...BASIC, assets: ["PathUSD"] }, /needs both maxPerPayment and maxPerDay/],
      [{ assets: BASIC.assets }, /recipients/],
      [{ ...BASIC, expiresAt: "next tuesday" }, /expiresAt/],
      [{ ...BASIC, assets: { PathUSD: { maxPerPayment: "1.0000001", maxPerDay: "5" } } }, /more than 6 decimal/],
      [{ ...BASIC, assets: { "0x1111111111111111111111111111111111111111": { maxPerPayment: "1", maxPerDay: "2" } } }, /add "decimals"/],
      [{ ...BASIC, surprise: true }, /Unrecognized key/],
    ];
    for (const [cfg, msg] of cases) {
      const env = setup(cfg);
      const loaded = loadPolicy(env, read);
      assert.equal(loaded.mode, "invalid", `expected invalid for ${JSON.stringify(cfg)}`);
      if (loaded.mode === "invalid") assert.match(loaded.error, msg);
      const gate = authorizeSpend(pay("1"), env, NOW);
      assert.equal(gate.ok, false);
      if (!gate.ok) assert.equal(gate.refusal.code, "limits_invalid");
    }
    const env = setup(BASIC, "bot");
    const wrongAgent = loadPolicy({ ...env, GLOAM_AGENT_ID: "nobody" }, read);
    assert.equal(wrongAgent.mode, "invalid");
    if (wrongAgent.mode === "invalid") assert.match(wrongAgent.error, /No limits for agent "nobody"/);
  });

  test("an unreadable limits file or log refuses rather than spending", () => {
    const env = setup(BASIC);
    writeFileSync(env.GLOAM_LIMITS_FILE!, "{ not json");
    const a = authorizeSpend(pay("1"), env, NOW);
    assert.equal(a.ok, false);
    const env2 = setup(BASIC);
    writeFileSync(env2.GLOAM_SPEND_LOG!, "garbage");
    const b = authorizeSpend(pay("1"), env2, NOW);
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.refusal.code, "log_unavailable");
  });

  // ---------------------------------------------------------------- single checks

  test("each limit refuses with its own reason", () => {
    const loaded = loadPolicy(setup(BASIC), read);
    assert.equal(loaded.mode, "enforced");
    if (loaded.mode !== "enforced") return;
    const p = loaded.policy;
    const code = (s: Spend, now = NOW) => checkSpend(p, s, [], now)?.code ?? "ok";

    assert.equal(code(pay("5")), "ok");
    assert.equal(code(pay("5.000001")), "over_per_payment");
    assert.equal(code(pay("1", { asset: RH_USDG, chainId: RH.chainId, network: "robinhood" })), "asset_not_allowed");
    // A payee cannot relabel another token as PathUSD: matching is by chain and address.
    assert.equal(code(pay("1", { asset: NATIVE_ASSET })), "asset_not_allowed");
    assert.equal(code(pay("1", { chainId: RH.chainId, network: "robinhood" })), "asset_not_allowed");
    assert.equal(code(pay("1", { recipient: OTHER })), "recipient_not_allowed");
    // 0x recipients compare without case.
    assert.equal(code({ ...pay("1"), tool: "send", recipient: "0xabcdef0000000000000000000000000000000001" }), "ok");
    assert.equal(code({ ...pay("1"), tool: "shield", recipient: null }), "tool_not_allowed");
    assert.equal(code(pay("0")), "bad_amount");
    // Expiry: a date means through the end of that day (UTC).
    assert.equal(code(pay("1"), Date.parse("2099-12-31T23:00:00Z")), "ok");
    assert.equal(code(pay("1"), Date.parse("2100-01-01T00:00:01Z")), "expired");
    assert.equal(parseExpiry("2026-02-30"), null);
  });

  test("payments only go through Gloam's own pool, even with limits off", () => {
    const env = setup(BASIC);
    const gate = authorizeSpend(pay("1", { pool: "0x000000000000000000000000000000000000dEaD" }), env, NOW);
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.refusal.code, "unknown_pool");
    const dir = mkdtempSync(join(tmpdir(), "gloam-limits-"));
    const off = authorizeSpend(pay("1", { pool: RH.pool }), { GLOAM_LIMITS: "off", GLOAM_SPEND_LOG: join(dir, "l.json") }, NOW);
    assert.equal(off.ok, false);
  });

  // ---------------------------------------------------------------- the daily window and the log

  test("the daily limit counts reserved spends, frees failed ones, and rolls after 24 hours", () => {
    const env = setup(BASIC);
    const a = authorizeSpend(pay("5"), env, NOW);
    const b = authorizeSpend(pay("5"), env, NOW + 1_000);
    assert.ok(a.ok && b.ok);
    const c = authorizeSpend(pay("5"), env, NOW + 2_000);
    assert.equal(c.ok, false);
    if (!c.ok) {
      assert.equal(c.refusal.code, "over_daily");
      assert.match(c.refusal.message, /2 PathUSD is left/);
      assert.ok(c.refusal.message.includes(new Date(NOW + 86_400_000).toISOString()), c.refusal.message);
    }
    // A plan preview reserves nothing.
    assert.equal(previewSpend(pay("2"), env, NOW + 3_000).allowed, true);
    assert.equal(previewSpend(pay("3"), env, NOW + 3_000).allowed, false);

    if (a.ok) settleSpend(a, "sent", { hash: "0xaaa" });
    if (b.ok) settleSpend(b, "failed", { reason: "prover crashed" });
    // b moved nothing, so its 5 is free again.
    assert.equal(authorizeSpend(pay("5"), env, NOW + 4_000).ok, true);
    assert.equal(authorizeSpend(pay("3"), env, NOW + 5_000).ok, false);
    // A day after the first spend it ages out of the window.
    assert.equal(authorizeSpend(pay("5"), env, NOW + 86_400_000 + 1).ok, true);
  });

  test("a flood of refused calls cannot push today's spends out of the log", () => {
    const env = setup(BASIC);
    const a = authorizeSpend(pay("5"), env, NOW);
    const b = authorizeSpend(pay("5"), env, NOW + 1);
    assert.ok(a.ok && b.ok);
    if (a.ok) settleSpend(a, "sent", { hash: "0xaaa" });
    if (b.ok) settleSpend(b, "sent", { hash: "0xbbb" });
    // More refusals than the log keeps (2000), each one cheap for an agent to cause.
    for (let i = 0; i < 2005; i++) authorizeSpend(pay("1", { recipient: OTHER }), env, NOW + 10 + i);
    const c = authorizeSpend(pay("5"), env, NOW + 5_000);
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.refusal.code, "over_daily");
    const log = JSON.parse(read(env.GLOAM_SPEND_LOG!)).entries as { status: string }[];
    assert.ok(log.length <= 2002, `log kept ${log.length} entries`);
    assert.equal(log.filter((e) => e.status === "sent").length, 2);
  });

  test("reports: limits as configured, spent and remaining today, newest payments first", () => {
    const env = setup(BASIC);
    const a = authorizeSpend(pay("4"), env, NOW);
    if (a.ok) settleSpend(a, "sent", { hash: "0x01" });
    const b = authorizeSpend(pay("3.5"), env, NOW + 60_000);
    if (b.ok) settleSpend(b, "unconfirmed", { hash: "0x02", reason: "receipt timed out" });
    authorizeSpend(pay("1", { recipient: OTHER }), env, NOW + 120_000);

    const limits = limitsReport(env, NOW) as Record<string, unknown>;
    assert.equal(limits.mode, "enforced");
    assert.match(String(limits.enforcedBy), /off-chain/);

    const r = spendingReport(10, env, NOW + 180_000);
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.equal(r.today[0].spentToday, "7.5");
    assert.equal(r.today[0].remainingToday, "4.5");
    assert.equal(r.today[0].payments, 2);
    assert.deepEqual(
      r.recentPayments.map((p) => [p.amount, p.status]),
      [
        ["3.5", "unconfirmed"],
        ["4", "sent"],
      ]
    );
    assert.equal(r.refusals.last24h, 1);
    assert.match(String(r.refusals.recent[0].reason), /allowed recipients/);
  });

  test("parallel server processes cannot overspend the same day (the log is locked)", async () => {
    const env = setup(BASIC);
    const self = fileURLToPath(import.meta.url);
    const tsx = join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", ".bin", "tsx");
    const runs = Array.from(
      { length: 6 },
      () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(tsx, [self, "--reserve-once"], { env: { ...process.env, TEST_ENV: JSON.stringify(env) } });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("error", reject);
          child.on("close", () => resolve(out.trim()));
        })
    );
    const results = await Promise.all(runs);
    // 12 a day at 5 each: exactly two get through, however the six interleave.
    assert.equal(results.filter((r) => r === "ok").length, 2, results.join(","));
    assert.equal(results.filter((r) => r === "refused").length, 4, results.join(","));
  });
}
