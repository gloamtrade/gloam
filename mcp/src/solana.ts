/**
 * Gloam on Solana for agents: the gloam_solana_* tools.
 *
 * Solana runs on Helius Solana Privacy Rings (the permissionless Default
 * Ring), through @gloamtrade/sdk/solana. What it hides, said plainly in every
 * answer: the asset and the amount of a private payment. The two private
 * accounts a payment moves between are visible, adding money shows the wallet
 * it came from, a cash out shows its destination, asset and amount, and proofs
 * are made by Helius's prover. It never hides who paid whom.
 *
 * The agent's main wallet is a Solana keypair in GLOAM_AGENT_SOLANA_KEY (a
 * Solana CLI keypair file's JSON array, or its base58 text), read from the
 * environment or ~/.gloam/agent.env like GLOAM_AGENT_PRIVATE_KEY. It opens the
 * same private account the Gloam app opens for that wallet (index
 * GLOAM_SOLANA_ACCOUNT_INDEX, default 0). The key never leaves this process
 * and is never printed. Gloam's relay pays the fees of registering, paying and
 * cashing out; adding money is the one transaction the main wallet pays for.
 *
 * Every tool that moves money passes the owner's spending limits first
 * (src/policy.ts): adding money is "shield", paying and cashing out are "pay",
 * on the network "solana-mainnet" (SOL, and USDC and USDT named with that
 * network). No limits configured means no spending.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_PRIVACY,
  SOLANA_PRIVACY_NOTE,
  SOLANA_RINGS_SOL_MINT,
  isSolanaAddress,
  solanaAsset,
  solanaNetworkInfo,
  type SolanaAsset,
} from "@gloamtrade/sdk";
import type * as SolanaSdk from "@gloamtrade/sdk/solana";
import type { Address } from "viem";
import { authorizeSpend, settleSpend } from "./spendGuard.js";

type Env = Record<string, string | undefined>;
type ToolAnswer = { content: { type: "text"; text: string }[] };

/** The Solana tools' names, in the order they are registered. */
export const SOLANA_TOOLS = [
  "gloam_solana_info",
  "gloam_solana_balance",
  "gloam_solana_register",
  "gloam_solana_add",
  "gloam_solana_pay",
  "gloam_solana_cash_out",
  "gloam_solana_tx_status",
] as const;

/** The plain line for agents, on every Solana answer. */
export const SOLANA_AGENT_PRIVACY = `${SOLANA_PRIVACY_NOTE} A cash out shows its destination, asset and amount. Sender and recipient are not hidden on Solana.`;

/**
 * The agent's Solana key from GLOAM_AGENT_SOLANA_KEY, as bytes, or null.
 * Throws (without echoing it) when it is not a Solana secret key.
 */
export function agentSolanaKey(env: Env = process.env): Uint8Array | null {
  const raw = env.GLOAM_AGENT_SOLANA_KEY?.trim();
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    if (raw.startsWith("[")) {
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
      bytes = Uint8Array.from(arr as number[]);
    } else {
      const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let n = 0n;
      for (const ch of raw) {
        const i = B58.indexOf(ch);
        if (i < 0) throw new Error();
        n = n * 58n + BigInt(i);
      }
      const out: number[] = [];
      while (n > 0n) {
        out.unshift(Number(n & 0xffn));
        n >>= 8n;
      }
      let zeros = 0;
      while (raw[zeros] === "1") zeros++;
      bytes = Uint8Array.from([...new Array<number>(zeros).fill(0), ...out]);
    }
  } catch {
    throw new Error("GLOAM_AGENT_SOLANA_KEY is not a Solana secret key (a keypair file's JSON array of 64 numbers, or its base58 text).");
  }
  if (bytes.length !== 64) {
    bytes.fill(0);
    throw new Error("GLOAM_AGENT_SOLANA_KEY is not a 64-byte Solana secret key (a keypair file's JSON array, or its base58 text).");
  }
  return bytes;
}

/** Private account index from GLOAM_SOLANA_ACCOUNT_INDEX (default 0). */
export function solanaAccountIndex(env: Env = process.env): number {
  const raw = env.GLOAM_SOLANA_ACCOUNT_INDEX?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000) throw new Error("GLOAM_SOLANA_ACCOUNT_INDEX must be a whole number from 0 to 1000000.");
  return n;
}

/** Where Gloam's Solana endpoints are (GLOAM_SOLANA_BASE_URL, default https://www.gloam.trade). */
export function solanaBaseUrl(env: Env = process.env): string | undefined {
  const v = env.GLOAM_SOLANA_BASE_URL?.trim();
  if (!v) return undefined;
  if (!/^https:\/\/[^/]+/.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(v)) throw new Error("GLOAM_SOLANA_BASE_URL must be an https URL.");
  return v;
}

export interface SolanaToolContext {
  env: Env;
  text: (value: unknown) => ToolAnswer;
  errMsg: (e: unknown) => string;
  /** The Solana client module (tests pass a fake). */
  sdk?: () => Promise<typeof SolanaSdk>;
}

function units(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** "1.5" of `asset` in base units; null when it is not a plain positive number with at most the asset's decimals. */
export function solanaAmount(amount: string, asset: SolanaAsset): bigint | null {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  if (f.length > asset.decimals) return null;
  const raw = BigInt(w!) * 10n ** BigInt(asset.decimals) + BigInt((f + "0".repeat(asset.decimals)).slice(0, asset.decimals) || "0");
  return raw > 0n ? raw : null;
}

const assetArg = z.enum(["SOL", "USDC", "USDT"]).describe("SOL, USDC or USDT.");
const amountArg = z.string().describe('Amount in whole units, like "2.5" (not base units).');
const timeoutArg = z
  .number()
  .int()
  .min(5_000)
  .max(180_000)
  .optional()
  .describe("How long to wait for Solana, in ms (default 120000). A send still unsettled then comes back pending with its signature and blockhash.");

export function registerSolanaTools(server: McpServer, ctx: SolanaToolContext): void {
  const { env, text, errMsg } = ctx;
  const load = ctx.sdk ?? (() => import("@gloamtrade/sdk/solana"));
  const fail = (value: Record<string, unknown>) => ({ ...text({ status: "error", ...value, privacy: SOLANA_AGENT_PRIVACY }), isError: true });

  /** The opened account, kept for the life of the server (its keys stay in memory, never in an answer). */
  let opened: { key: string; account: Promise<SolanaSdk.GloamSolanaAccount> } | null = null;

  async function account(): Promise<{ sdk: typeof SolanaSdk; account: SolanaSdk.GloamSolanaAccount; base: string | undefined } | { error: string }> {
    let secret: Uint8Array | null;
    let index: number;
    let base: string | undefined;
    try {
      secret = agentSolanaKey(env);
      index = solanaAccountIndex(env);
      base = solanaBaseUrl(env);
    } catch (e) {
      return { error: errMsg(e) };
    }
    if (!secret) {
      return {
        error:
          "No Solana key. Set GLOAM_AGENT_SOLANA_KEY (a Solana keypair file's JSON array, or its base58 text) in the environment or ~/.gloam/agent.env, then restart this server. It opens the same private account the Gloam app opens for that wallet.",
      };
    }
    const sdk = await load();
    const fingerprint = `${index}:${base ?? ""}:${secret.reduce((h, b) => (h * 31 + b) >>> 0, 7)}`;
    if (!opened || opened.key !== fingerprint) {
      const wallet = sdk.solanaKeypairWallet(secret);
      const p = wallet.then((w) => sdk.openSolanaAccount({ wallet: w, index, ...(base ? { baseUrl: base } : {}) }));
      p.catch(() => {
        if (opened?.account === p) opened = null;
      });
      opened = { key: fingerprint, account: p };
    }
    try {
      return { sdk, account: await opened.account, base };
    } catch (e) {
      return { error: `Could not open the Solana private account: ${errMsg(e)}` };
    } finally {
      secret.fill(0);
    }
  }

  function assetFor(symbol: string): SolanaAsset {
    const a = solanaAsset(symbol, "mainnet");
    if (!a) throw new Error(`Unknown Solana asset ${symbol}.`);
    return a;
  }

  const mintOf = (a: SolanaAsset) => (a.mint ?? SOLANA_RINGS_SOL_MINT) as Address;

  function balancesView(raw: Record<string, bigint>) {
    return solanaNetworkInfo().assets.map((a) => ({ symbol: a.symbol, balance: units(raw[a.id] ?? 0n, a.decimals), baseUnits: (raw[a.id] ?? 0n).toString() }));
  }

  server.registerTool(
    "gloam_solana_info",
    {
      title: "Gloam on Solana",
      description:
        "Gloam on Solana (Helius Solana Privacy Rings): the assets, what a private payment hides there (the asset and the amount; the two private accounts and an add's main wallet are visible; proofs are made by Helius's prover), whether Gloam's relay is on, and this agent's private Solana address if GLOAM_AGENT_SOLANA_KEY is set. Read only.",
    },
    async () => {
      const info = solanaNetworkInfo();
      const sdk = await load();
      let base: string | undefined;
      try {
        base = solanaBaseUrl(env);
      } catch (e) {
        return fail({ error: errMsg(e) });
      }
      const relay = await sdk.solanaRelayStatus(base ? { baseUrl: base } : {});
      let agent: Record<string, unknown> = { configured: false, how: "Set GLOAM_AGENT_SOLANA_KEY to pay and get paid on Solana." };
      if (env.GLOAM_AGENT_SOLANA_KEY?.trim()) {
        const a = await account();
        agent = "error" in a ? { configured: true, error: a.error } : { configured: true, mainWallet: a.account.mainAddress, privateAddress: a.account.address, accountIndex: a.account.index };
      }
      return text({
        network: { key: info.key, name: info.name, assets: info.assets.map((a) => ({ symbol: a.symbol, mint: a.mint, decimals: a.decimals })) },
        privacy: SOLANA_AGENT_PRIVACY,
        hidden: SOLANA_PRIVACY.hidden,
        visible: SOLANA_PRIVACY.visible,
        mainWallet: SOLANA_PRIVACY.mainWallet,
        prover: SOLANA_PRIVACY.prover,
        fees: info.fees,
        relay: { on: relay.on, funded: relay.funded, address: relay.relayer },
        agent,
        tools: [
          "gloam_solana_balance: the private balance (read)",
          "gloam_solana_register: publish the private account so others can pay it; the relay pays the rent (once)",
          'gloam_solana_add: add money from the main wallet (public: the wallet, asset and amount; limits tool "shield")',
          'gloam_solana_pay: pay another Gloam private account on Solana; hides the asset and amount, not the two accounts (limits tool "pay")',
          'gloam_solana_cash_out: cash out to any Solana address; destination, asset and amount are public (limits tool "pay")',
          "gloam_solana_tx_status: where a sent transaction stands (landed, failed, dropped or pending)",
        ],
        limits: 'Spending limits name the network "solana-mainnet": SOL, or USDC and USDT with "network": "solana-mainnet" (or GLOAM_LIMIT_NETWORK=solana-mainnet).',
      });
    }
  );

  server.registerTool(
    "gloam_solana_balance",
    {
      title: "Solana private balance",
      description:
        "This agent's private balance on Solana (SOL, USDC, USDT), decrypted here from the Rings indexer, plus its private address and whether it is registered (can be paid). Needs GLOAM_AGENT_SOLANA_KEY. Read only.",
    },
    async () => {
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      try {
        const [raw, registered] = await Promise.all([a.sdk.solanaBalances(a.account), a.sdk.isSolanaAccountRegistered(a.account)]);
        return text({
          network: "solana-mainnet",
          privateAddress: a.account.address,
          mainWallet: a.account.mainAddress,
          registered,
          ...(registered ? {} : { next: "Call gloam_solana_register once so other Gloam accounts can pay this one." }),
          balances: balancesView(raw),
          privacy: SOLANA_AGENT_PRIVACY,
        });
      } catch (e) {
        return fail({ error: a.sdk.solanaErrorMessage(e) });
      }
    }
  );

  server.registerTool(
    "gloam_solana_register",
    {
      title: "Register the Solana private account",
      description:
        "Publish this agent's private Solana account in the Privacy Rings registry, so other Gloam accounts can pay it privately. Gloam's relay pays the record's rent (about 0.0016 SOL); nothing is spent from the agent. Does nothing when it is already registered. Needs GLOAM_AGENT_SOLANA_KEY.",
      inputSchema: { timeoutMs: timeoutArg },
    },
    async ({ timeoutMs }) => {
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      try {
        const r = await a.sdk.registerSolanaAccount(a.account, timeoutMs ? { timeoutMs } : {});
        return text({
          status: r.alreadyRegistered ? "already_registered" : "registered",
          privateAddress: a.account.address,
          ...(r.signature ? { signature: r.signature, explorer: a.sdk.solanaExplorerTx(r.signature) } : {}),
          privacy: SOLANA_AGENT_PRIVACY,
        });
      } catch (e) {
        return fail({ error: a.sdk.solanaErrorMessage(e), ...relayDetails(a.sdk, e) });
      }
    }
  );

  function relayDetails(sdk: typeof SolanaSdk, e: unknown): Record<string, unknown> {
    if (e instanceof sdk.SolanaRelayError) {
      return {
        code: e.code,
        maybeSent: e.maybeSent,
        ...(e.maybeSent
          ? { next: "It may have been sent. Check gloam_solana_tx_status (or the balance) before sending again.", ...(e.pending ? { blockhash: e.pending.blockhash } : {}) }
          : { next: "Nothing was sent. You can try again." }),
      };
    }
    if (e instanceof sdk.SolanaTxError) return { code: e.state, signature: e.signature, next: "Nothing moved. You can send it again." };
    return {};
  }

  /** Gate, send, settle: one spend through the owner's limits. */
  async function spend(
    tool: "shield" | "pay",
    asset: SolanaAsset,
    raw: bigint,
    recipient: string | null,
    send: () => Promise<SolanaSdk.SolanaSendResult>,
    sdk: typeof SolanaSdk
  ) {
    const gate = authorizeSpend({ tool, network: "solana-mainnet", chainId: SOLANA_MAINNET_CHAIN_ID, asset: mintOf(asset), amountWei: raw, recipient }, env);
    if (!gate.ok) return fail({ ...gate.refusal, error: gate.refusal.message });
    try {
      const r = await send();
      const logError = settleSpend(gate, r.state === "landed" ? "sent" : "unconfirmed", { hash: r.signature });
      return text({
        status: r.state === "landed" ? "landed" : "pending",
        signature: r.signature,
        blockhash: r.blockhash,
        explorer: r.explorer,
        ...(r.state === "pending" ? { next: "Not settled yet. Check gloam_solana_tx_status with this signature and blockhash before sending again." } : {}),
        ...(logError ? { logWarning: logError } : {}),
        privacy: SOLANA_AGENT_PRIVACY,
      });
    } catch (e) {
      const maybeSent = e instanceof sdk.SolanaRelayError && e.maybeSent;
      settleSpend(gate, maybeSent ? "unconfirmed" : "failed", { reason: sdk.solanaErrorMessage(e) });
      return fail({ error: sdk.solanaErrorMessage(e), ...relayDetails(sdk, e) });
    }
  }

  server.registerTool(
    "gloam_solana_add",
    {
      title: "Add money on Solana",
      description:
        'Add money to this agent\'s private Solana balance from its main wallet (the GLOAM_AGENT_SOLANA_KEY wallet), which pays Solana\'s fee. PUBLIC on chain: the main wallet, the asset and the amount (an add links the main wallet to its private account). Passes the owner\'s spending limits as tool "shield" on network "solana-mainnet".',
      inputSchema: { asset: assetArg, amount: amountArg, timeoutMs: timeoutArg },
    },
    async ({ asset, amount, timeoutMs }) => {
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      const as = assetFor(asset);
      const raw = solanaAmount(amount, as);
      if (raw === null) return fail({ error: `"${amount}" is not a positive amount of ${as.symbol} (at most ${as.decimals} decimals).` });
      return spend("shield", as, raw, null, () => a.sdk.addToSolanaPrivate(a.account, { asset: as, amount: raw, ...(timeoutMs ? { timeoutMs } : {}) }), a.sdk);
    }
  );

  server.registerTool(
    "gloam_solana_pay",
    {
      title: "Pay privately on Solana",
      description:
        'Pay another Gloam private account on Solana (its registered private address) from this agent\'s private balance. Gloam\'s relay pays the fee. HIDDEN: the asset and the amount. VISIBLE: this agent\'s private account and the recipient\'s private account (sender and recipient are not hidden on Solana). Proofs are made by Helius\'s prover. Passes the owner\'s spending limits as tool "pay" on network "solana-mainnet".',
      inputSchema: {
        to: z.string().describe("The recipient's Gloam private address on Solana (base58). It must be registered."),
        asset: assetArg,
        amount: amountArg,
        timeoutMs: timeoutArg,
      },
    },
    async ({ to, asset, amount, timeoutMs }) => {
      if (!isSolanaAddress(to)) return fail({ error: "`to` is not a Solana address." });
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      const as = assetFor(asset);
      const raw = solanaAmount(amount, as);
      if (raw === null) return fail({ error: `"${amount}" is not a positive amount of ${as.symbol} (at most ${as.decimals} decimals).` });
      return spend("pay", as, raw, to, () => a.sdk.paySolanaPrivately(a.account, { to, asset: as, amount: raw, ...(timeoutMs ? { timeoutMs } : {}) }), a.sdk);
    }
  );

  server.registerTool(
    "gloam_solana_cash_out",
    {
      title: "Cash out on Solana",
      description:
        'Cash out from this agent\'s private Solana balance to any Solana address (default: its own main wallet). Gloam\'s relay pays the fee. PUBLIC on chain: the private account, the destination, the asset and the amount. Passes the owner\'s spending limits as tool "pay" on network "solana-mainnet" (the destination must be an allowed recipient unless it is the agent\'s own main wallet).',
      inputSchema: {
        to: z.string().optional().describe("Destination Solana address (base58). Default: this agent's main wallet."),
        asset: assetArg,
        amount: amountArg,
        timeoutMs: timeoutArg,
      },
    },
    async ({ to, asset, amount, timeoutMs }) => {
      if (to !== undefined && !isSolanaAddress(to)) return fail({ error: "`to` is not a Solana address." });
      const a = await account();
      if ("error" in a) return fail({ error: a.error });
      const dest = to ?? a.account.mainAddress;
      const as = assetFor(asset);
      const raw = solanaAmount(amount, as);
      if (raw === null) return fail({ error: `"${amount}" is not a positive amount of ${as.symbol} (at most ${as.decimals} decimals).` });
      const recipient = dest === a.account.mainAddress ? null : dest;
      return spend("pay", as, raw, recipient, () => a.sdk.cashOutSolana(a.account, { to: dest, asset: as, amount: raw, ...(timeoutMs ? { timeoutMs } : {}) }), a.sdk);
    }
  );

  server.registerTool(
    "gloam_solana_tx_status",
    {
      title: "Solana transaction status",
      description:
        "Where a Solana transaction this server sent stands: landed, failed (nothing moved), dropped (its blockhash expired unseen, nothing moved, safe to send again) or pending. Pass the blockhash a send returned so a dropped one can be told apart. Waits at most timeoutMs (default: one read). Read only.",
      inputSchema: {
        signature: z.string().describe("The transaction signature (base58)."),
        blockhash: z.string().optional().describe("The blockhash the send returned."),
        timeoutMs: z.number().int().min(0).max(180_000).optional().describe("Keep checking up to this long, in ms (default 0: read once)."),
      },
    },
    async ({ signature, blockhash, timeoutMs }) => {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return fail({ error: "That is not a Solana transaction signature." });
      if (blockhash !== undefined && !isSolanaAddress(blockhash)) return fail({ error: "That is not a Solana blockhash." });
      const sdk = await load();
      let base: string | undefined;
      try {
        base = solanaBaseUrl(env);
      } catch (e) {
        return fail({ error: errMsg(e) });
      }
      const opts = base ? { baseUrl: base } : {};
      try {
        const st = timeoutMs
          ? await sdk.waitForSolanaTx({ signature, ...(blockhash ? { blockhash } : {}), timeoutMs }, opts)
          : await sdk.solanaTxStatus({ signature, ...(blockhash ? { blockhash } : {}) }, opts);
        const next =
          st.state === "landed"
            ? "It went through."
            : st.state === "pending"
              ? blockhash
                ? "Not settled yet. Ask again shortly; it settles within about 90 seconds of being built."
                : "Unknown without its blockhash: pass the blockhash the send returned."
              : "Nothing moved. It is safe to send it again.";
        return text({ ...st, ...(st.state === "landed" ? { slot: st.slot.toString() } : {}), explorer: sdk.solanaExplorerTx(signature), next });
      } catch (e) {
        return fail({ error: errMsg(e) });
      }
    }
  );
}
