/**
 * x402 on the seller side: take Gloam private payments next to standard x402.
 *
 * A seller already answering 402 with standard x402 (scheme exact) keeps doing
 * so. This adds a Gloam price to that answer and settles Gloam payments before
 * the standard middleware sees them:
 *
 *   - The 402 answer gains an X-Payment-Required header with the Gloam
 *     requirements (gloamx402req1:…). On an x402 v2 answer, the gloam entry is
 *     also added to the PAYMENT-REQUIRED header's `accepts`, where v2 clients
 *     skip schemes they do not know. The v1 JSON body is left as it is: v1
 *     clients parse every `accepts` entry strictly and would stop on an unknown
 *     scheme.
 *   - A request whose X-PAYMENT is a Gloam payment (gloamx402pay1:…) is opened
 *     with the seller's receive key, checked against the price for this route
 *     (never the price the payer sent), and swept into a fresh note only the
 *     seller knows. The resource is served only once that sweep confirms.
 *
 * A payment is served once. Which payments were secured is kept in a ledger:
 * in memory by default, or the seller's own store when it runs more than one
 * process.
 */
import { createPublicClient, parseUnits, type Address, type PublicClient } from "viem";
import {
  GLOAM_X402_SCHEME,
  GloamApiClient,
  artifactProver,
  buildGloamPaymentRequirements,
  decodePaymentHeader,
  encodeRequirements,
  getGloamNetwork,
  gloamReadTransport,
  openGloamPaymentNote,
  relaySubmitter,
  settleGloamPayment,
  sweepChainFromClient,
  type GloamNetwork,
  type GloamNetworkKey,
  type GloamPaymentPayload,
  type GloamPaymentRequirements,
  type NoteExport,
  type Prover,
  type ReceiveKey,
  type SettleResult,
  type SweepChain,
  type SweepSubmitter,
} from "@gloamtrade/sdk";
import { Artifacts, type ArtifactSource } from "@gloamtrade/game-plugin-gloam/engine";

const PAY_PREFIX = "gloamx402pay1:";

/** A price for one route, in the asset's own units ("0.25" USDG). */
export interface GloamPrice {
  amount: string;
  /** Symbol or address. Default: the network's first asset (USDG on Robinhood Chain mainnet). */
  asset?: string;
  description?: string;
}

/** What the seller remembers per payment, by the payment note's nullifier. */
export interface SellerLedgerEntry {
  freshCommitment: string | null;
  served: boolean;
}

export interface SellerLedger {
  get(paymentNullifier: string): Promise<SellerLedgerEntry | null> | SellerLedgerEntry | null;
  put(paymentNullifier: string, entry: SellerLedgerEntry): Promise<void> | void;
}

export interface GloamSellerOptions {
  /** The seller's receive key (generateReceiveKey()). Share key.tag; keep privateJwk on the server. */
  receiveKey: ReceiveKey;
  network: GloamNetworkKey;
  /**
   * Store the seller's fresh note. Called before the sweep is sent: if the process dies after that,
   * this is the only copy of the money. Throw to stop the sweep.
   */
  saveNote: (fresh: NoteExport, info: { chainId: number; pool: Address; resource: string }) => void | Promise<void>;
  /** Reads. Default: a client over the network's RPC. */
  client?: PublicClient;
  /** The chain reads a sweep needs. Default: from `client` (it rebuilds the vault tree for each sweep). */
  chain?: SweepChain;
  /** Who sends the sweep. Default: the Gloam relay, or the partner relay with `apiKey`. */
  submit?: SweepSubmitter;
  /** A Gloam partner key: sweeps go through the partner relay and count on gloam.trade/partners/dashboard. */
  apiKey?: string;
  /** Transfer prover for the sweep. Default: the network's circuit files, downloaded and hash-checked. */
  prove?: Prover;
  artifacts?: ArtifactSource;
  /** Default: in memory. */
  ledger?: SellerLedger;
}

export interface GloamSeller {
  readonly network: GloamNetwork;
  /** The seller's Gloam address, the payTo of every price. */
  readonly tag: string;
  /** The Gloam requirements for a price at a resource (the URL, without its query). */
  requirements(price: GloamPrice, resource: string): GloamPaymentRequirements;
  /** Add the Gloam price to a 402 answer from the standard middleware (or to a bare one). */
  addToChallenge(res: Response, requirements: GloamPaymentRequirements): Promise<Response>;
  /** Open, check and secure a presented Gloam payment. Serve only on grantAccess. */
  settle(requirements: GloamPaymentRequirements, paymentHeader: string): Promise<SellerSettleResult>;
}

export type SellerSettleResult = {
  grantAccess: boolean;
  status: SettleResult["status"] | "used" | "settling" | "confirming";
  reason: string | null;
  /** The sweep's transaction, when there is one. */
  hash: string | null;
};

/** The Gloam payment a request presents (X-PAYMENT, or PAYMENT-SIGNATURE for v2 servers), or null. */
export function gloamPaymentFrom(headers: Headers): string | null {
  for (const name of ["x-payment", "payment-signature"]) {
    const v = headers.get(name)?.trim();
    if (v?.startsWith(PAY_PREFIX)) return v;
  }
  return null;
}

/** A resource as the price names it: origin and path, no query or fragment. */
export function resourceOf(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

function memoryLedger(): SellerLedger {
  const m = new Map<string, SellerLedgerEntry>();
  return { get: (k) => m.get(k) ?? null, put: (k, v) => void m.set(k, v) };
}

export function createGloamSeller(opts: GloamSellerOptions): GloamSeller {
  const found = getGloamNetwork(opts.network);
  if (!found) throw new Error(`${opts.network} has no Gloam vault in this version of @gloamtrade/sdk.`);
  const net: GloamNetwork = found;
  const client = opts.client ?? (createPublicClient({ chain: net.chain, transport: gloamReadTransport(net) }) as PublicClient);
  const chain = opts.chain ?? sweepChainFromClient(client, { pool: net.pool, fromBlock: net.deployBlock });
  const submit = opts.submit ?? (opts.apiKey ? new GloamApiClient({ apiKey: opts.apiKey }).submitter() : relaySubmitter());
  const ledger = opts.ledger ?? memoryLedger();
  const artifacts = new Artifacts(opts.artifacts ?? {});
  let prover: Promise<Prover> | null = opts.prove ? Promise.resolve(opts.prove) : null;
  const prove = () => (prover ??= artifacts.paths("transfer", net.ceremony).then((a) => artifactProver(a)));
  const settling = new Set<string>();

  const requirements = (price: GloamPrice, resource: string): GloamPaymentRequirements => {
    const v = (price.asset ?? "").trim().toLowerCase();
    const a = v ? net.assets.find((x) => x.symbol.toLowerCase() === v || x.address.toLowerCase() === v) : net.assets[0];
    if (!a) throw new Error(`The ${net.label} vault does not take "${price.asset}".`);
    return buildGloamPaymentRequirements({
      amountWei: parseUnits(price.amount, a.decimals),
      asset: a.address,
      assetSymbol: a.symbol,
      payTo: opts.receiveKey.tag,
      resource,
      description: price.description,
      network: net.chainId,
      poolAddress: net.pool,
    });
  };

  async function addToChallenge(res: Response, req: GloamPaymentRequirements): Promise<Response> {
    const headers = new Headers(res.headers);
    const encoded = encodeRequirements(req);
    headers.set("X-Payment-Required", encoded);
    headers.set("Access-Control-Expose-Headers", [headers.get("Access-Control-Expose-Headers"), "X-Payment-Required"].filter(Boolean).join(", "));
    const v2 = headers.get("payment-required");
    if (v2) {
      try {
        const pr = JSON.parse(Buffer.from(v2, "base64").toString("utf8")) as { accepts?: unknown[] };
        if (pr && Array.isArray(pr.accepts)) {
          pr.accepts.push({
            scheme: GLOAM_X402_SCHEME,
            network: `eip155:${req.network}`,
            amount: req.maxAmountRequired,
            asset: req.asset,
            payTo: req.payTo,
            maxTimeoutSeconds: req.maxTimeoutSeconds,
            extra: { gloam: encoded, poolAddress: req.poolAddress, assetSymbol: req.assetSymbol },
          });
          headers.set("payment-required", Buffer.from(JSON.stringify(pr)).toString("base64"));
        }
      } catch {
        /* not a v2 header we can read: the X-Payment-Required header still carries the price */
      }
    }
    return new Response(await res.text(), { status: res.status, statusText: res.statusText, headers });
  }

  async function settle(req: GloamPaymentRequirements, header: string): Promise<SellerSettleResult> {
    const no = (status: SellerSettleResult["status"], reason: string, hash: string | null = null): SellerSettleResult => ({ grantAccess: false, status, reason, hash });
    let payload: GloamPaymentPayload;
    let note: NoteExport;
    try {
      payload = decodePaymentHeader(header);
      if (payload.scheme !== GLOAM_X402_SCHEME) return no("rejected", "Not a Gloam payment.");
      note = await openGloamPaymentNote(payload.payload.paymentNote, opts.receiveKey);
    } catch (e) {
      return no("rejected", `The payment does not open with this seller's key: ${e instanceof Error ? e.message : String(e)}`);
    }
    const key = note.nullifier.toLowerCase();
    if (settling.has(key)) return no("settling", "This payment is being secured right now. Try again in a moment.");
    settling.add(key);
    try {
      const seen = await ledger.get(key);
      if (seen?.served) return no("used", "This payment was already used for a request.");
      if (seen?.freshCommitment) {
        // Secured before, its answer not seen then: serve once the fresh note is in the vault.
        if (!(await chain.isCommitmentSeen(seen.freshCommitment as `0x${string}`))) return no("confirming", "The payment's sweep has not confirmed yet. Try again shortly.");
        await ledger.put(key, { ...seen, served: true });
        return { grantAccess: true, status: "swept", reason: null, hash: null };
      }
      const r = await settleGloamPayment({
        requirements: req,
        payload,
        receiveKey: opts.receiveKey,
        prove: await prove(),
        chain,
        submit,
        beforeSubmit: async (fresh) => {
          await opts.saveNote(fresh, { chainId: net.chainId, pool: net.pool, resource: req.resource });
          await ledger.put(key, { freshCommitment: fresh.commitment, served: false });
        },
      });
      if (r.grantAccess) await ledger.put(key, { freshCommitment: r.freshNote?.commitment ?? null, served: true });
      // Nothing of the seller's can land (only an unconfirmed sweep may): the next presentation is settled afresh.
      else if (r.status !== "unconfirmed") await ledger.put(key, { freshCommitment: null, served: false });
      return { grantAccess: r.grantAccess, status: r.status, reason: r.reason, hash: r.sweep?.hash ?? null };
    } finally {
      settling.delete(key);
    }
  }

  return { network: net, tag: opts.receiveKey.tag, requirements, addToChallenge, settle };
}

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Put a route behind both: Gloam private payments and the standard x402
 * middleware you already run. For fetch-style servers (Hono, Next.js route
 * handlers, Bun, Deno, Cloudflare Workers).
 *
 *   handler   the resource itself
 *   standard  the same handler behind your x402 middleware; leave it out to sell through Gloam only
 *   price     the price of a request, or null for a free one
 */
export function protectWithGloam(o: { seller: GloamSeller; price: (req: Request) => GloamPrice | null; handler: Handler; standard?: Handler }): Handler {
  return async (req) => {
    const price = o.price(req);
    if (!price) return o.handler(req);
    const requirements = o.seller.requirements(price, resourceOf(req.url));
    const presented = gloamPaymentFrom(req.headers);
    if (presented) {
      const r = await o.seller.settle(requirements, presented);
      if (r.grantAccess) {
        const res = await o.handler(req);
        const headers = new Headers(res.headers);
        const receipt = { success: true, scheme: GLOAM_X402_SCHEME, network: requirements.network, transaction: r.hash };
        headers.set("X-Payment-Response", Buffer.from(JSON.stringify(receipt)).toString("base64"));
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
      const again = r.status === "settling" || r.status === "confirming" || r.status === "unconfirmed" || r.status === "not_settled";
      const body = { x402Version: 1, error: r.reason ?? "The payment was not accepted.", status: r.status, retry: again, accepts: [requirements] };
      return o.seller.addToChallenge(new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "cache-control": "no-store" } }), requirements);
    }
    if (o.standard) {
      const res = await o.standard(req);
      return res.status === 402 ? o.seller.addToChallenge(res, requirements) : res;
    }
    const body = { x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirements] };
    return o.seller.addToChallenge(new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "cache-control": "no-store" } }), requirements);
  };
}
