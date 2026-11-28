/**
 * Gloam on Starknet for agents: the gloam_starknet_* tools.
 *
 * Starknet runs on Starknet's own privacy pool (STRK20), through
 * @gloamtrade/sdk/starknet and Gloam's routes. NOT OPEN YET: until Starknet
 * opens on Gloam its routes refuse, and every tool that touches them says so
 * (status "not_open") without sending anything.
 *
 * What it hides, said plainly in every answer: over a channel that is already
 * open, who paid, who was paid and the amount. The first payment to someone
 * shows their private account; adding money shows the account and the amount;
 * a cash out shows the destination and the amount. The pool's auditor key can
 * read an account's private activity (it cannot spend), and Starkscan's prover
 * sees what it proves.
 *
 * The agent's private Starknet account comes from its EVM key
 * (GLOAM_AGENT_PRIVATE_KEY): the key signs the Gloam app's fixed account text,
 * so it is the same account the Gloam app opens for that wallet (index
 * GLOAM_STARKNET_ACCOUNT_INDEX, default 0). The key never leaves this process.
 * Gloam's relay deploys the account and sends every transaction, so the agent
 * never needs STRK; each add, payment and cash out pays Gloam's relay fee
 * (0.25 USDC on mainnet) inside its proof.
 *
 * Every tool that moves money passes the owner's spending limits first
 * (src/policy.ts): adding money is "shield", paying and cashing out are "pay",
 * on the network "starknet-mainnet" (USDC named with that network). A payment
 * or cash out counts its amount and Gloam's fee. No limits configured means no
 * spending.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  STARKNET_MAINNET_LIST_ID,
  STARKNET_PRIVACY,
  STARKNET_PRIVACY_NOTE,
  isStarknetAddress,
  starknetAddressHex,
  starknetAsset,
  starknetNetworkInfo,
  type StarknetAsset,
} from "@gloamtrade/sdk";
import type * as StarknetSdk from "@gloamtrade/sdk/starknet";
import type { Address } from "viem";
import { agentPrivateKey } from "./signer.js";
import { authorizeSpend, settleSpend } from "./spendGuard.js";

type Env = Record<string, string | undefined>;
type ToolAnswer = { content: { type: "text"; text: string }[] };

/** The Starknet tools' names, in the order they are registered. */
export const STARKNET_TOOLS = [
  "gloam_starknet_info",
  "gloam_starknet_balance",
  "gloam_starknet_register",
  "gloam_starknet_add",
  "gloam_starknet_pay",
  "gloam_starknet_cash_out",
  "gloam_starknet_tx_status",
] as const;

/** The plain line for agents, on every Starknet answer. */
export const STARKNET_AGENT_PRIVACY = `${STARKNET_PRIVACY_NOTE} Registering stores the account's viewing key encrypted to the pool's auditor key, for authorized inspection; it cannot spend.`;

/** What every Starknet answer says while Gloam's Starknet routes are off. */
export const STARKNET_NOT_OPEN = "Starknet is not open on Gloam yet: its routes refuse until it opens. Nothing was sent.";

/** Private account index from GLOAM_STARKNET_ACCOUNT_INDEX (default 0). */
export function starknetAccountIndex(env: Env = process.env): number {
  const raw = env.GLOAM_STARKNET_ACCOUNT_INDEX?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000) throw new Error("GLOAM_STARKNET_ACCOUNT_INDEX must be a whole number from 0 to 1000000.");
  return n;
}

/** Where Gloam's Starknet routes are (GLOAM_STARKNET_BASE_URL, default https://www.gloam.trade). */
export function starknetBaseUrl(env: Env = process.env): string | undefined {
  const v = env.GLOAM_STARKNET_BASE_URL?.trim();
  if (!v) return undefined;
  if (!/^https:\/\/[^/]+/.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(v)) throw new Error("GLOAM_STARKNET_BASE_URL must be an https URL.");
  return v;
}

export interface StarknetToolContext {
  env: Env;
  text: (value: unknown) => ToolAnswer;
  errMsg: (e: unknown) => string;
  /** The Starknet client module (tests pass a fake). */
  sdk?: () => Promise<typeof StarknetSdk>;
}

function units(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** "1.5" of `asset` in base units; null when it is not a plain positive number with at most the asset's decimals. */
export function starknetAmount(amount: string, asset: StarknetAsset): bigint | null {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  if (f.length > asset.decimals) return null;
  const raw = BigInt(w!) * 10n ** BigInt(asset.decimals) + BigInt((f + "0".repeat(asset.decimals)).slice(0, asset.decimals) || "0");
  return raw > 0n ? raw : null;
}

const USDC = starknetAsset("USDC", "mainnet")!;
const amountArg = z.string().describe('Amount of USDC in whole units, like "2.5" (not base units).');
const maxFeeArg = z
  .string()
  .optional()
  .describe('Most Gloam\'s relay fee may be, in whole USDC (like "0.25"). Above it nothing is proven or sent. Default: the fee the relay asked when this server last read it.');

export function registerStarknetTools(server: McpServer, ctx: StarknetToolContext): void {
  const { env, text, errMsg } = ctx;
  const load = ctx.sdk ?? (() => import("@gloamtrade/sdk/starknet"));
  const fail = (value: Record<string, unknown>) => ({ ...text({ status: "error", ...value, privacy: STARKNET_AGENT_PRIVACY }), isError: true });

  /** The opened account, kept for the life of the server (its keys stay in memory, never in an answer). */
  let opened: { key: string; account: Promise<StarknetSdk.GloamStarknetAccount> } | null = null;

  async function account(): Promise<{ sdk: typeof StarknetSdk; account: StarknetSdk.GloamStarknetAccount; base: string | undefined } | { error: string }> {
    let key: string | null;
    let index: number;
    let base: string | undefined;
    try {
      key = agentPrivateKey(env);
      index = starknetAccountIndex(env);
      base = starknetBaseUrl(env);
    } catch (e) {
      return { error: errMsg(e) };
    }
    if (!key) {
      return {
        error:
          "No agent key. Set GLOAM_AGENT_PRIVATE_KEY (the agent's EVM key) in the environment or ~/.gloam/agent.env, then restart this server. It opens the same private Starknet account the Gloam app opens for that wallet.",
      };
    }
    const sdk = await load();
    const fingerprint = `${index}:${base ?? ""}:${[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
    if (!opened || opened.key !== fingerprint) {
      const { privateKeyToAccount } = await import("viem/accounts");
      const signer = privateKeyToAccount(key as `0x${string}`);
      const p = sdk.openStarknetAccount({ wallet: sdk.starknetViemWallet(signer), index, ...(base ? { baseUrl: base } : {}) });
      p.catch(() => {
        if (opened?.account === p) opened = null;
      });
      opened = { key: fingerprint, account: p };
    }
    try {
      return { sdk, account: await opened.account, base };
    } catch (e) {
      return { error: `Could not open the Starknet private account: ${errMsg(e)}` };
    }
  }

  /** A Starknet error as the answer's fields: off and busy said plainly, whether anything may have been sent. */
  function errorFields(sdk: typeof StarknetSdk, e: unknown): Record<string, unknown> {
    const se = sdk.asStarknetError(e);
    if (se instanceof sdk.StarknetOffError) return { status: "not_open", code: se.code, error: se.message, next: STARKNET_NOT_OPEN };
    if (se instanceof sdk.StarknetBusyError) {
      return {
        status: "busy",
        code: se.code,
        error: se.message,
        next: se.code === "quota" ? "Gloam's proofs on Starknet for today are used. Nothing was sent; try again tomorrow (it resets at midnight UTC)." : "Nothing was sent. Try again in a little while.",
      };
    }
    if (se instanceof sdk.StarknetFeeChangedError) {
      return { code: se.code, error: se.message, ...(se.fee !== null ? { feeNow: units(se.fee, USDC.decimals) } : {}), next: "Nothing was sent. Call again to pay the fee the relay asks now, or set maxFee." };
    }
    if (se instanceof sdk.StarknetInsufficientError) {
      return { code: se.code, error: se.message, ...(se.have !== null ? { have: units(se.have, USDC.decimals) } : {}), ...(se.need !== null ? { need: units(se.need, USDC.decimals) } : {}), next: "Nothing was sent." };
    }
    return {
      code: se.code,
      error: se.message,
      maybeSent: se.maybeSent,
      ...(se.txHash ? { txHash: se.txHash } : {}),
      next: se.maybeSent ? "It may have been sent. Check gloam_starknet_balance (or gloam_starknet_tx_status) before sending again." : "Nothing was sent.",
    };
  }

  const answerError = (sdk: typeof StarknetSdk, e: unknown) => fail(errorFields(sdk, e));

  server.registerTool(
    "gloam_starknet_info",
    {
      title: "Gloam on Starknet",
      description:
        "Gloam on Starknet (Starknet's privacy pool, STRK20; not open on Gloam yet): the asset (USDC), what a payment hides there (over an open channel both sides and the amount; the first payment to someone shows their private account; adds show the account and amount; cash outs show the destination and amount), the pool's auditor key and Starkscan's prover, whether Gloam's relay is on and its fee, and this agent's private Starknet account if GLOAM_AGENT_PRIVATE_KEY is set. Read only.",
    },
    async () => {
      const info = starknetNetworkInfo();
      const sdk = await load();
      let base: string | undefined;
      try {
        base = starknetBaseUrl(env);
      } catch (e) {
        return fail({ error: errMsg(e) });
      }
      const relay = await sdk.starknetRelayStatus(base ? { baseUrl: base } : {});
      let agent: Record<string, unknown> = { configured: false, how: "Set GLOAM_AGENT_PRIVATE_KEY to pay and get paid on Starknet." };
      if (env.GLOAM_AGENT_PRIVATE_KEY?.trim()) {
        const a = await account();
        agent = "error" in a ? { configured: true, error: a.error } : { configured: true, privateAccount: a.account.address, accountIndex: a.account.index };
      }
      return text({
        status: relay.on ? "open" : "not_open",
        ...(relay.on ? {} : { note: STARKNET_NOT_OPEN }),
        network: { key: info.key, name: info.name, chainId: info.chainId, pool: info.pool, assets: info.assets.map((a) => ({ symbol: a.symbol, address: a.address, decimals: a.decimals })) },
        privacy: STARKNET_AGENT_PRIVACY,
        hidden: STARKNET_PRIVACY.hidden,
        visible: STARKNET_PRIVACY.visible,
        auditor: STARKNET_PRIVACY.auditor,
        prover: STARKNET_PRIVACY.prover,
        discovery: STARKNET_PRIVACY.discovery,
        mainWallet: STARKNET_PRIVACY.mainWallet,
        fees: info.fees,
        relay: {
          reachable: relay.reachable,
          on: relay.on,
          funded: relay.funded,
          moves: relay.moves,
          address: relay.relayer,
          feeUsdc: units(sdk.starknetRelayFee(relay, USDC), USDC.decimals),
        },
        agent,
        tools: [
          "gloam_starknet_balance: the private balance, and what sits at the account's address ready to add (read)",
          "gloam_starknet_register: put the account on chain and open it, once; free, the relay pays (shows the account)",
          'gloam_starknet_add: make what sits at the account\'s address private (public: the account and the amount; limits tool "shield")',
          'gloam_starknet_pay: pay another Gloam private account on Starknet; a first payment shows their account (limits tool "pay")',
          'gloam_starknet_cash_out: cash out to any Starknet address; the destination and amount are public (limits tool "pay")',
          "gloam_starknet_tx_status: where a Starknet transaction stands (read)",
        ],
        limits: 'Spending limits name the network "starknet-mainnet": USDC with "network": "starknet-mainnet" (or GLOAM_LIMIT_NETWORK=starknet-mainnet). Payments and cash outs count their amount and Gloam\'s fee.',
      });
    }
  );

  server.registerTool(
    "gloam_starknet_balance",
    {
      title: "Starknet private balance",
      description:
        "This agent's private USDC balance on Starknet (its notes, found and read here), what sits at its private account's address ready to add, and whether the account is open (can be paid). Needs GLOAM_AGENT_PRIVATE_KEY. Read only.",
    },
    async () => {
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      try {
        const open = await a.sdk.isStarknetAccountOpen(a.account);
        const b = (await a.sdk.starknetBalances(a.account)).usdc ?? { private: 0n, public: 0n };
        return text({
          network: "starknet-mainnet",
          privateAccount: a.account.address,
          open,
          ...(open ? {} : { next: "Call gloam_starknet_register once so the account is on chain and can be paid." }),
          usdc: { private: units(b.private, USDC.decimals), atAddress: units(b.public, USDC.decimals) },
          ...(b.public > 0n ? { add: "USDC at the account's address is public until gloam_starknet_add makes it private." } : {}),
          privacy: STARKNET_AGENT_PRIVACY,
        });
      } catch (e) {
        return answerError(a.sdk, e);
      }
    }
  );

  server.registerTool(
    "gloam_starknet_register",
    {
      title: "Open the Starknet private account",
      description:
        "Put this agent's private Starknet account on chain and open it, once: Gloam's relay deploys it (no STRK from the agent) and one proof registers its viewing key, stored encrypted to the pool's auditor key, and opens its own channel. Free, with a daily cap. Shows the account's address. Does nothing when it is already open. Needs GLOAM_AGENT_PRIVATE_KEY.",
    },
    async () => {
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      try {
        const r = await a.sdk.registerStarknetAccount(a.account);
        return text({
          status: r.alreadyOpen ? "already_open" : "opened",
          privateAccount: a.account.address,
          ...(r.deployTx ? { deployTx: r.deployTx } : {}),
          ...(r.openTx ? { openTx: r.openTx, explorer: a.sdk.starknetExplorerTx(r.openTx) } : {}),
          privacy: STARKNET_AGENT_PRIVACY,
        });
      } catch (e) {
        return answerError(a.sdk, e);
      }
    }
  );

  /** Gate, send, settle: one spend through the owner's limits. `counted` is what the limits count (the amount, with the fee where it leaves the private balance). */
  async function spend(
    a: { sdk: typeof StarknetSdk; account: StarknetSdk.GloamStarknetAccount; base: string | undefined },
    tool: "shield" | "pay",
    counted: bigint,
    recipient: string | null,
    send: () => Promise<StarknetSdk.StarknetSendResult & { firstPayment?: boolean }>
  ) {
    const gate = authorizeSpend({ tool, network: "starknet-mainnet", chainId: STARKNET_MAINNET_LIST_ID, asset: USDC.address as Address, amountWei: counted, recipient }, env);
    if (!gate.ok) return fail({ ...gate.refusal, error: gate.refusal.message });
    try {
      const r = await send();
      const logError = settleSpend(gate, "sent", { hash: r.txHash });
      return text({
        status: "accepted",
        txHash: r.txHash,
        block: r.block,
        feeUsdc: units(r.fee, USDC.decimals),
        explorer: r.explorer,
        ...(r.firstPayment === true ? { firstPayment: "This was the first payment to them: it showed their private account. Later payments over this channel show neither side nor the amount." } : {}),
        ...(logError ? { logWarning: logError } : {}),
        privacy: STARKNET_AGENT_PRIVACY,
      });
    } catch (e) {
      const se = a.sdk.asStarknetError(e);
      settleSpend(gate, se.maybeSent ? "unconfirmed" : "failed", { reason: se.message });
      return answerError(a.sdk, se);
    }
  }

  /** The owner's fee cap: maxFee in whole USDC, or the fee the relay asked when this server last read it. */
  async function feeFor(a: { sdk: typeof StarknetSdk; base: string | undefined }, maxFee: string | undefined): Promise<{ fee: bigint; maxFee?: bigint } | { error: string; off?: true }> {
    const relay = await a.sdk.starknetRelayStatus(a.base ? { baseUrl: a.base } : {});
    // Not open: said before the owner's limits are asked, so nothing is reserved or logged.
    if (!relay.on) return { error: relay.reachable ? STARKNET_NOT_OPEN : "Gloam's Starknet relay can't be reached. Nothing was sent; try again shortly.", ...(relay.reachable ? { off: true as const } : {}) };
    const fee = a.sdk.starknetRelayFee(relay, USDC);
    if (maxFee === undefined) return { fee };
    const cap = maxFee.trim() === "0" ? 0n : starknetAmount(maxFee, USDC);
    if (cap === null) return { error: `"${maxFee}" is not an amount of USDC (at most ${USDC.decimals} decimals).` };
    return { fee, maxFee: cap };
  }

  server.registerTool(
    "gloam_starknet_add",
    {
      title: "Add money on Starknet",
      description:
        'Make USDC that sits at this agent\'s private Starknet account\'s address private (send USDC there first, from any wallet or exchange on Starknet). The account approves the pool and one proof deposits it; Gloam\'s fee comes out of it. PUBLIC on chain: the account and the amount. Passes the owner\'s spending limits as tool "shield" on network "starknet-mainnet".',
      inputSchema: { amount: amountArg, maxFee: maxFeeArg },
    },
    async ({ amount, maxFee }) => {
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      const raw = starknetAmount(amount, USDC);
      if (raw === null) return fail({ error: `"${amount}" is not a positive amount of USDC (at most ${USDC.decimals} decimals).` });
      const f = await feeFor(a, maxFee);
      if ("error" in f) return fail(f.off ? { status: "not_open", code: "off", error: f.error } : { error: f.error });
      return spend(a, "shield", raw, null, () => a.sdk.addToStarknetPrivate(a.account, { amount: raw, ...(f.maxFee !== undefined ? { maxFee: f.maxFee } : {}) }));
    }
  );

  server.registerTool(
    "gloam_starknet_pay",
    {
      title: "Pay privately on Starknet",
      description:
        'Pay another Gloam private account on Starknet from this agent\'s private balance. Gloam\'s fee comes from the balance too. Over a channel already open it shows neither side nor the amount. The FIRST payment to someone opens a channel to them, which SHOWS their private account (never who paid or how much). Proofs are made by Starkscan\'s prover. Passes the owner\'s spending limits as tool "pay" on network "starknet-mainnet" (the amount and the fee count).',
      inputSchema: {
        to: z.string().describe("The recipient's Gloam private account on Starknet (0x, up to 64 hex digits). It must be open."),
        amount: amountArg,
        maxFee: maxFeeArg,
      },
    },
    async ({ to, amount, maxFee }) => {
      if (!isStarknetAddress(to)) return fail({ error: "`to` is not a Starknet address." });
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      const raw = starknetAmount(amount, USDC);
      if (raw === null) return fail({ error: `"${amount}" is not a positive amount of USDC (at most ${USDC.decimals} decimals).` });
      const f = await feeFor(a, maxFee);
      if ("error" in f) return fail(f.off ? { status: "not_open", code: "off", error: f.error } : { error: f.error });
      return spend(a, "pay", raw + (f.maxFee ?? f.fee), starknetAddressHex(to), () => a.sdk.payStarknetPrivately(a.account, { to, amount: raw, ...(f.maxFee !== undefined ? { maxFee: f.maxFee } : {}) }));
    }
  );

  server.registerTool(
    "gloam_starknet_cash_out",
    {
      title: "Cash out on Starknet",
      description:
        'Cash out from this agent\'s private Starknet balance to any Starknet address (default: its own private account\'s address, as public USDC). Gloam\'s fee comes from the balance too. PUBLIC on chain: the destination and the amount, never the private account it came from. Passes the owner\'s spending limits as tool "pay" on network "starknet-mainnet" (the amount and the fee count; the destination must be an allowed recipient unless it is the agent\'s own account).',
      inputSchema: {
        to: z.string().optional().describe("Destination Starknet address (0x, up to 64 hex digits). Default: this agent's private account's own address."),
        amount: amountArg,
        maxFee: maxFeeArg,
      },
    },
    async ({ to, amount, maxFee }) => {
      if (to !== undefined && !isStarknetAddress(to)) return fail({ error: "`to` is not a Starknet address." });
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      const dest = to ?? a.account.address;
      const raw = starknetAmount(amount, USDC);
      if (raw === null) return fail({ error: `"${amount}" is not a positive amount of USDC (at most ${USDC.decimals} decimals).` });
      const f = await feeFor(a, maxFee);
      if ("error" in f) return fail(f.off ? { status: "not_open", code: "off", error: f.error } : { error: f.error });
      const own = starknetAddressHex(dest) === starknetAddressHex(a.account.address);
      return spend(a, "pay", raw + (f.maxFee ?? f.fee), own ? null : starknetAddressHex(dest), () => a.sdk.cashOutStarknet(a.account, { to: dest, amount: raw, ...(f.maxFee !== undefined ? { maxFee: f.maxFee } : {}) }));
    }
  );

  server.registerTool(
    "gloam_starknet_tx_status",
    {
      title: "Starknet transaction status",
      description: "Where a Starknet transaction stands: accepted (with its block), reverted (nothing moved) or pending. Read through Gloam's Starknet RPC. Read only.",
      inputSchema: { txHash: z.string().describe("The transaction hash (0x, up to 64 hex digits).") },
    },
    async ({ txHash }) => {
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(txHash)) return fail({ error: "That is not a Starknet transaction hash." });
      const sdk = await load();
      let base: string | undefined;
      try {
        base = starknetBaseUrl(env);
      } catch (e) {
        return fail({ error: errMsg(e) });
      }
      try {
        const st = await sdk.starknetTxStatus(txHash, base ? { baseUrl: base } : {});
        const next = st.state === "accepted" ? "It went through." : st.state === "reverted" ? "Nothing moved. You can send it again." : "Not settled yet. Ask again shortly.";
        return text({ ...st, explorer: sdk.starknetExplorerTx(txHash), next });
      } catch (e) {
        return answerError(sdk, e);
      }
    }
  );
}
