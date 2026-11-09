import {
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
  GameFunction,
  GameWorker,
} from "@virtuals-protocol/game";
import { GloamAgent, type GloamAgentOptions } from "./agent.js";
import { redact, safeErrorMessage } from "./redact.js";

/**
 * Gloam for agents built on the GAME framework: a private balance, private
 * payments, cash outs and proofs, on Base and Robinhood Chain.
 *
 * Same shape as the plugins in game-node/plugins: a class with options, one
 * getter per GameFunction, and getWorker() to hand the agent a GameWorker.
 *
 * The planner (the GAME API) only ever sees what the functions return and the
 * environment: amounts, assets, handles, hashes, Gloam addresses and proofs.
 * Never a key, a note secret or a claim link. Money moves only within the
 * owner's per-asset limits.
 */
interface IGloamPluginOptions extends GloamAgentOptions {
  id?: string;
  name?: string;
  description?: string;
  /** Use this engine instead of building one from the options. */
  agent?: GloamAgent;
  /**
   * Share private balance amounts in the environment the planner reads each
   * step. Default false: the planner is Virtuals' hosted LLM, and the agent can
   * still ask with gloam_private_balance when it needs the figures.
   */
  shareBalances?: boolean;
}

const DESCRIPTION = `A worker that holds and moves money privately with Gloam, a shielded vault for stablecoins.
It can:
- show the agent's private balance and Gloam address
- add money from the agent's wallet to its private balance (a public deposit; spending from it is private)
- pay privately to a Gloam address (gloamr1.…), a Gloam payment request link, or by claim link for someone with no Gloam address
- receive: share its Gloam address, make a payment request link, pick up payments sent to it, or claim a claim link
- cash out from the private balance to a public 0x address (the cash out itself is public)
- prove it holds at least an amount privately, for one named reader, without showing the balance
- check a Gloam proof someone sends it
Every payment and cash out must fit the owner's per-asset limits; a refusal says why. Amounts are plain numbers in the asset's units (25 means 25 USDC).`;


class GloamPlugin {
  private id: string;
  private name: string;
  private description: string;
  private shareBalances: boolean;
  public readonly agent: GloamAgent;

  constructor(options: IGloamPluginOptions = {}) {
    this.id = options.id || "gloam_worker";
    this.name = options.name || "Gloam Worker";
    this.description = options.description || DESCRIPTION;
    this.shareBalances = options.shareBalances ?? false;
    this.agent = options.agent ?? new GloamAgent(options);
  }

  /** Run an engine call and turn it into a GAME response. Nothing leaves without going through redact(). */
  private async run(logger: (msg: string) => void, what: string, fn: () => Promise<Record<string, unknown> & { status: string }>) {
    try {
      const out = await fn();
      const text = redact(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      logger(redact(`${what}: ${out.status}`));
      // "unconfirmed": the send went out and its answer was lost. Reported as done (not failed), with the
      // instruction not to send it again, so a planner never retries money that may already have moved.
      const ok = out.status === "done" || out.status === "ok" || out.status === "pending" || out.status === "unconfirmed";
      return new ExecutableGameFunctionResponse(ok ? ExecutableGameFunctionStatus.Done : ExecutableGameFunctionStatus.Failed, text);
    } catch (e) {
      // One short line: an RPC error's full text quotes the URL, which can carry an API key.
      const message = safeErrorMessage(e);
      logger(`${what} failed: ${message}`);
      return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, JSON.stringify({ status: "error", message }));
    }
  }

  public get getPrivateBalanceFunction() {
    return new GameFunction({
      name: "gloam_private_balance",
      description:
        "Show the agent's private balance per asset, what its wallet holds publicly, its Gloam address, open claim links, and how much its limits leave for today. A payment spends one note, so largestPayment is the most one payment can be right now.",
      args: [
        {
          name: "refresh",
          description: 'Pass "true" to check pending notes against the chain first.',
          type: "string",
          optional: true,
        },
      ],
      executable: async (args, logger) => this.run(logger, "private balance", () => this.agent.balance({ refresh: args.refresh === "true" })),
    });
  }

  public get addPrivatelyFunction() {
    return new GameFunction({
      name: "gloam_add_privately",
      description:
        "Move money from the agent's wallet into its private balance. The deposit is public (wallet, asset and amount show); what the agent does with the money afterwards is private. Each deposit is capped: 50,000 of a stablecoin on mainnet, 500 on Base Sepolia.",
      args: [
        { name: "amount", description: "How much, in the asset's units, for example 25.", type: "string" },
        { name: "asset", description: "The asset symbol, for example USDC on Base or USDG on Robinhood Chain. Default: the network's first asset.", type: "string", optional: true },
      ],
      executable: async (args, logger) => this.run(logger, "add privately", () => this.agent.add({ amount: args.amount ?? "", asset: args.asset })),
    });
  }

  public get payPrivatelyFunction() {
    return new GameFunction({
      name: "gloam_pay_privately",
      description:
        'Pay privately from the private balance. `to` is a Gloam address (gloamr1.…), a Gloam payment request link (https://gloam.trade/app/vault?…#to=…), or the words "claim link" to pay someone who has no Gloam address (the link goes to the owner, or sealed to seal_to). The chain shows a shielded transfer, not the amount or the parties. Refused when over the owner\'s limits.',
      args: [
        { name: "to", description: 'A Gloam address, a payment request link, or "claim link".', type: "string" },
        { name: "amount", description: "How much, in the asset's units. Leave out when the payment request names it.", type: "string", optional: true },
        { name: "asset", description: "Asset symbol. Default: what the request names, else the network's first asset.", type: "string", optional: true },
        { name: "note", description: "A private note for the payee, at most 80 characters (an invoice or job id). Only the payee can read it.", type: "string", optional: true },
        { name: "seal_to", description: "For a claim link: a Gloam address to seal the link to, so only that address can open it.", type: "string", optional: true },
      ],
      executable: async (args, logger) =>
        this.run(logger, "pay privately", () => {
          const to = (args.to ?? "").trim();
          if (/^claim[\s_-]?link$/i.test(to)) {
            return this.agent.payByClaimLink({ amount: args.amount ?? "", asset: args.asset, note: args.note, sealTo: args.seal_to?.trim() || undefined });
          }
          return this.agent.pay({ to, amount: args.amount, asset: args.asset, note: args.note });
        }),
    });
  }

  public get receiveFunction() {
    return new GameFunction({
      name: "gloam_receive",
      description:
        'Receive privately. mode "address": the agent\'s Gloam address to share. mode "request": a payment request link (optional amount, asset and note). mode "check": find payments sent to the agent\'s Gloam address and secure them (a payment counts only once moved into a note only this agent knows). mode "claim": claim a claim link or code someone gave the agent. A plain claim link is the money itself and passes through this planner: ask the payer to pay the Gloam address instead, or to seal the link to it (a gloam2t.… code, which only this agent opens).',
      args: [
        { name: "mode", description: '"address", "request", "check" or "claim".', type: "string" },
        { name: "amount", description: "For a request: how much to ask for. Leave out to let the payer choose.", type: "string", optional: true },
        { name: "asset", description: "For a request: the asset symbol.", type: "string", optional: true },
        { name: "note", description: "For a request: a private note the payment will carry, at most 80 characters.", type: "string", optional: true },
        { name: "claim_link", description: "For claim: a code sealed to this agent's Gloam address (gloam2t.…), or a claim link or code. A plain link is a bearer secret: prefer the sealed code.", type: "string", optional: true },
      ],
      executable: async (args, logger) =>
        this.run(logger, `receive (${args.mode ?? "?"})`, async () => {
          const mode = (args.mode ?? "").trim().toLowerCase();
          if (mode === "address") {
            const tag = await this.agent.address();
            return { status: "done", action: "address", network: this.agent.network.key, gloamAddress: tag, share: "Anyone can pay this address privately. It is safe to share." };
          }
          if (mode === "request") return this.agent.requestPayment({ amount: args.amount, asset: args.asset, note: args.note });
          if (mode === "check") return this.agent.checkIncoming();
          if (mode === "claim") {
            if (!args.claim_link) return { status: "error", message: "Pass the claim link as claim_link." };
            return this.agent.claim(args.claim_link);
          }
          return { status: "error", message: 'mode must be "address", "request", "check" or "claim".' };
        }),
    });
  }

  public get cashOutFunction() {
    return new GameFunction({
      name: "gloam_cash_out",
      description:
        "Cash out from the private balance to a public 0x address. The cash out is public (asset, amount and recipient show), not which private payment funded it. The pool keeps 0.5% on mainnet and 0.25% on Base Sepolia. A note behind a proof of funds the agent made is first moved to a fresh note, so the proof does not lead to the cash out. Refused when the address or amount is outside the owner's limits.",
      args: [
        { name: "amount", description: "How much to cash out, in the asset's units.", type: "string" },
        { name: "to", description: "The 0x address to send it to.", type: "string" },
        { name: "asset", description: "Asset symbol. Default: the network's first asset.", type: "string", optional: true },
      ],
      executable: async (args, logger) =>
        this.run(logger, "cash out", () => this.agent.cashOut({ amount: args.amount ?? "", to: args.to ?? "", asset: args.asset })),
    });
  }

  public get proveFundsFunction() {
    return new GameFunction({
      name: "gloam_prove_funds",
      description:
        "Make a proof that the agent holds at least an amount of an asset privately, for one named reader and an expiry, without showing the balance. The proof carries the nullifiers of the notes behind it, so the reader can check they are unspent and can tell when they are spent later. Returns a gloamfunds1: proof anyone can check at gloam.trade/verify.",
      args: [
        { name: "at_least", description: "The amount to prove, in the asset's units.", type: "string" },
        { name: "for", description: 'Who the proof is for, as they should see it ("Acme counterparty desk"). Sealed into the proof.', type: "string" },
        { name: "asset", description: "Asset symbol. Default: the network's first asset.", type: "string", optional: true },
        { name: "expires_in_hours", description: "How long it stays valid. Default 168 (7 days).", type: "string", optional: true },
      ],
      executable: async (args, logger) =>
        this.run(logger, "prove funds", () =>
          this.agent.proveFunds({
            atLeast: args.at_least ?? "",
            for: args.for ?? "",
            asset: args.asset,
            expiresInHours: args.expires_in_hours ? Number(args.expires_in_hours) : undefined,
          })
        ),
    });
  }

  public get verifyProofFunction() {
    return new GameFunction({
      name: "gloam_verify_proof",
      description:
        "Check a Gloam proof of funds (gloamfunds1:…) or proof of payment (gloampay1:…) against the chain: the zero-knowledge proof, who it was made for, Gloam's vault, the amounts, that the notes are unspent or the payment was a private send, and the expiry. ok is true only when every check passes. A proof of payment shows a private payment of that amount was made; it does not show who received it.",
      args: [{ name: "proof", description: "The proof text.", type: "string" }],
      executable: async (args, logger) => this.run(logger, "verify proof", () => this.agent.verifyProof(args.proof ?? "")),
    });
  }

  /** What the planner sees each step: the network, the Gloam address, the balance (unless turned off) and the limits. */
  public async environment(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      gloam_network: this.agent.network.key,
      gloam_network_kind: this.agent.network.testnet ? "testnet" : "mainnet",
      gloam_assets: this.agent.network.assets.map((a) => a.symbol),
    };
    try {
      out.gloam_address = await this.agent.address();
      if (this.shareBalances) {
        const b = await this.agent.balance();
        out.gloam_private_balance = b.privateBalance;
      }
      out.gloam_limits = this.agent.limitsReport();
    } catch (e) {
      out.gloam_error = safeErrorMessage(e);
    }
    return JSON.parse(redact(JSON.stringify(out)));
  }

  public getWorker(data?: {
    id?: string;
    functions?: GameFunction<any>[];
    getEnvironment?: () => Promise<Record<string, any>>;
  }): GameWorker {
    return new GameWorker({
      id: data?.id || this.id,
      name: this.name,
      description: this.description,
      functions: data?.functions || [
        this.getPrivateBalanceFunction,
        this.addPrivatelyFunction,
        this.payPrivatelyFunction,
        this.receiveFunction,
        this.cashOutFunction,
        this.proveFundsFunction,
        this.verifyProofFunction,
      ],
      getEnvironment: data?.getEnvironment || (() => this.environment()),
    });
  }
}

export type { IGloamPluginOptions };
export default GloamPlugin;
