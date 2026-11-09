/**
 * What E2B adds: an mpp.e2b.dev-style route, POST /sandboxes, that also takes
 * the private "gloam" method.
 *
 *   pnpm server        (after pnpm fund)
 *
 * mpp.e2b.dev today builds its payment handler like this, and the gloam
 * method goes next to the tempo one. The tempo offer stays exactly as it is;
 * an agent that holds a private balance picks gloam, everyone else keeps
 * paying with tempo:
 *
 *   const mppx = Mppx.create({
 *     secretKey,
 *     methods: [
 *       tempo.charge({ currency: USDC_E, recipient: E2B_WALLET }),
 *  +    gloam({ network: "tempo-mainnet", receiveKey, chain, prove, submit: relayIntent, beforeSubmit: saveNote }),
 *     ],
 *   })
 *
 * On a verified private payment (the payment is swept into a note only the
 * seller knows before the route runs) the route forwards to E2B's real API
 * when E2B_API_KEY is set, else it answers with a clearly labelled mock.
 *
 * This demo runs on Tempo TESTNET terms (chain 42431, PathUSD, Gloam's testnet
 * pool). The tempo offer next to it is there to show both side by side; it
 * names E2B's public mainnet wallet as the recipient and nothing in this demo
 * pays it.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { Address, Hex } from "viem";
import { Mppx, NodeListener, tempo } from "mppx/server";
import { gloam } from "@gloamtrade/mppx-gloam/server";
import { gloamChargeChainFromClient } from "@gloamtrade/mppx-gloam/core";
import { relayIntent, type GloamIntent, type IntentExec } from "@gloamtrade/sdk";
import {
  ASSET,
  loadEnv,
  NET,
  proverFor,
  sdkClient,
  sellerNotes,
  sellerReceiveKey,
  SERVER_PORT,
  short,
  stamp,
  TREE,
  txUrl,
} from "./common.js";

loadEnv();
const log = (s: string) => console.log(`[server ${stamp()}] ${s}`);

/** E2B's public receiving wallet on Tempo mainnet (from the live 402). Only shown in the tempo offer. */
const E2B_TEMPO_WALLET: Address = "0xb10ACa684083730D93D68EcB71486b17bDf71460";
const E2B_API = process.env.E2B_API_URL ?? "https://api.e2b.app";
const E2B_API_KEY = process.env.E2B_API_KEY?.trim();

/** E2B's published price for a `base` sandbox (2 vCPU, 512 MiB): compute for the requested time, 5% off, plus $0.0001. */
function quote(timeoutSeconds: number): string {
  const perSecond = 2 * 0.000014 + 0.5 * 0.0000045;
  const usd = perSecond * timeoutSeconds * 0.95 + 0.0001;
  return (Math.round(usd * 1e6) / 1e6).toFixed(6);
}

const receiveKey = sellerReceiveKey();
const transferProver = await proverFor("transfer");

/** Gloam's relay submits the transfers, so neither the agent's nor E2B's wallet signs anything on chain. */
const submit = async (intent: GloamIntent & { exec: IntentExec }): Promise<Hex> => {
  const hash = await relayIntent(intent);
  log(`relay submitted a pool transfer   ${txUrl(hash)}`);
  return hash;
};

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  realm: "e2b-demo.localhost",
  methods: [
    // What mpp.e2b.dev offers today (public): a TIP-20 transfer to E2B's wallet.
    tempo.charge({ testnet: true, currency: ASSET.address, decimals: ASSET.decimals, recipient: E2B_TEMPO_WALLET }),
    // The one line E2B adds (private): a shielded transfer in the Gloam pool, sealed to E2B's receive tag.
    gloam({
      network: "tempo", // "tempo-mainnet" in production: USDC.e by default, the final ceremony keys
      currency: ASSET.address,
      decimals: ASSET.decimals,
      receiveKey,
      chain: gloamChargeChainFromClient(sdkClient, TREE),
      prove: transferProver,
      submit,
      // The swept note is E2B's money: store it before the sweep goes out.
      beforeSubmit: (fresh) => {
        sellerNotes.add({
          secret: fresh.secret as Hex,
          commitment: fresh.commitment as Hex,
          amountWei: String(fresh.amountWei),
          status: "unspent",
          createdAt: new Date().toISOString(),
        });
        log(`sweeping the payment into a fresh note ${short(fresh.commitment)} (secret stored, not printed)`);
      },
    }),
  ],
});

async function createSandbox(body: { templateID?: string; timeout?: number }) {
  if (E2B_API_KEY) {
    const res = await fetch(`${E2B_API}/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": E2B_API_KEY },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }
  // No E2B key here: a mock with E2B's response shape, labelled as one.
  const id = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  return {
    status: 201,
    json: {
      mock: true,
      note: "MOCK sandbox: set E2B_API_KEY to forward paid requests to api.e2b.app",
      alias: body.templateID ?? "base",
      sandboxID: `mock-${id}`,
      templateID: body.templateID ?? "base",
      clientID: "mock",
      envdVersion: "mock",
    },
  };
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, network: NET.chainId, pool: NET.pool, recipient: receiveKey.tag });
  }
  if (request.method !== "POST" || url.pathname !== "/sandboxes") return new Response("Not found", { status: 404 });

  const body = (await request.clone().json().catch(() => ({}))) as { templateID?: string; timeout?: number };
  const timeout = Math.min(Math.max(Number(body.timeout ?? 300), 1), 86_400);
  const amount = quote(timeout);
  const description = `Create sandbox - 2 vCPU, 512 MiB, ${timeout}s`;

  const r = await mppx.charge({ amount, description })(request);
  if (r.status === 402) {
    log(`POST /sandboxes without payment -> 402, ${amount} ${ASSET.symbol}, offers: tempo (public), gloam (private)`);
    return r.challenge;
  }
  log(`POST /sandboxes paid privately and swept. Creating the sandbox ${E2B_API_KEY ? "on api.e2b.app" : "(mock, no E2B_API_KEY)"}`);
  const created = await createSandbox({ ...body, timeout });
  log(`-> ${created.status} sandboxID ${created.json.sandboxID ?? "(none)"}`);
  return r.withReceipt(Response.json(created.json, { status: created.status }));
}

// node:http bridge for the Fetch handler. Production MPP runs behind TLS.
function toRequest(req: IncomingMessage): Promise<Request> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      resolve(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined,
        })
      );
    });
  });
}

createServer(async (req, res) => {
  try {
    await NodeListener.sendResponse(res, await handle(await toRequest(req)));
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
}).listen(SERVER_PORT, "127.0.0.1", () => {
  log(`E2B-style MPP proxy on http://127.0.0.1:${SERVER_PORT}  (POST /sandboxes)`);
  log(`network     ${NET.label} testnet, chain ${NET.chainId}, Gloam pool ${NET.pool}`);
  log(`price       E2B's quote for a base sandbox, ${quote(300)} ${ASSET.symbol} for 300s`);
  log(`gloam pays  E2B's receive tag ${short(receiveKey.tag, 18)} (no wallet address)`);
  log(`E2B API     ${E2B_API_KEY ? `forwarding to ${E2B_API}` : "no E2B_API_KEY: answering with a labelled mock sandbox"}`);
});
