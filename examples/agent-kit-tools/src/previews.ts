/**
 * Previews: what a preview tool promised, kept until gloam_execute runs it.
 *
 * A preview binds the facts that decide where money goes (network, vault,
 * asset, amount in base units, recipient, fee) and hashes them into a digest.
 * Execute runs the action with those bound facts, never with fresh input, so
 * what was approved is what runs. A preview runs at most once; a second
 * execute gets the first result back. Previews live in memory: a restart drops
 * them, and since nothing was signed for a preview, nothing is lost.
 */
import { createHash, randomBytes } from "node:crypto";

export type PreviewAction = "shield" | "pay" | "claim_link" | "cash_out" | "prove_funds" | "pay_x402" | "pay_x402_cashout";

/** One step the agent's wallet signs, in words and with the exact target. */
export interface SignStep {
  contract: string;
  call: string;
  /** Present when the step happens only sometimes (an approve when the allowance is short). */
  when?: string;
}

/** What a preview tool returns. Plain JSON, no secrets. */
export interface PreviewView {
  status: "preview";
  previewId: string;
  digest: string;
  action: PreviewAction;
  expiresAt: string;
  summary: string;
  network: { key: string; name: string; chainId: number; testnet: boolean };
  /** What will be moved or shown: amount, asset, recipient or tag, fee. */
  details: Record<string, unknown>;
  /** What the agent's wallet signs. Empty when nothing is signed (a proof authorizes it and the relay submits it). */
  walletSigns: SignStep[];
  submittedBy: string;
  public: string;
  next: string;
}

export interface PreviewRecord {
  view: PreviewView;
  /** The facts the digest covers. */
  binding: Record<string, unknown>;
  /** Runs the action with the bound facts. */
  run: (rec: PreviewRecord) => Promise<Record<string, unknown> & { status: string }>;
  /** Checked right before running: a reason to refuse (the fee changed), or null. */
  recheck?: () => Promise<string | null>;
  /** Whether a finished preview may run again (an x402 payment presented again, never paid again). */
  rerun?: (last: Record<string, unknown>) => boolean;
  state: "ready" | "running" | "done";
  result?: Record<string, unknown> & { status: string };
  /** Private to the action (the x402 request, the payment header). Never shown. */
  scratch: Record<string, unknown>;
  expiresAtMs: number;
}

/** sha256 over canonical JSON: keys sorted, bigints as decimal strings. */
export function digestOf(action: string, binding: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return "sha256:" + createHash("sha256").update(JSON.stringify(canon({ action, binding }))).digest("hex");
}

export class PreviewBook {
  private readonly items = new Map<string, PreviewRecord>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 200
  ) {}

  add(args: {
    action: PreviewAction;
    binding: Record<string, unknown>;
    view: Omit<PreviewView, "status" | "previewId" | "digest" | "action" | "expiresAt" | "next">;
    run: PreviewRecord["run"];
    recheck?: PreviewRecord["recheck"];
    rerun?: PreviewRecord["rerun"];
    scratch?: Record<string, unknown>;
    ttlMs?: number;
  }): PreviewView {
    this.sweep();
    if (this.items.size >= this.max) throw new Error("Too many previews waiting. Execute or let some expire first.");
    const previewId = `pv_${randomBytes(9).toString("base64url")}`;
    const digest = digestOf(args.action, args.binding);
    const expiresAtMs = Date.now() + (args.ttlMs ?? this.ttlMs);
    const view: PreviewView = {
      status: "preview",
      previewId,
      digest,
      action: args.action,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...args.view,
      next: `Show this to whoever approves it. To go ahead, call gloam_execute with previewId "${previewId}" and digest "${digest}".`,
    };
    this.items.set(previewId, {
      view,
      binding: args.binding,
      run: args.run,
      recheck: args.recheck,
      rerun: args.rerun,
      state: "ready",
      scratch: args.scratch ?? {},
      expiresAtMs,
    });
    return view;
  }

  get(previewId: string): PreviewRecord | undefined {
    return this.items.get(previewId);
  }

  /** Drop expired previews that never ran. Finished ones stay an hour, so a repeated execute gets its answer. */
  private sweep(now = Date.now()) {
    for (const [id, r] of this.items) {
      if (r.state === "ready" && r.expiresAtMs < now) this.items.delete(id);
      if (r.state === "done" && r.expiresAtMs + 60 * 60_000 < now) this.items.delete(id);
    }
  }
}
