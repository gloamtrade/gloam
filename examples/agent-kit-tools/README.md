# agent-kit-tools

Gloam for agent kits and agent marketplaces: a drop-in tool pack, and the
seller side of private x402.

An agent kit adds these tools and its agents get a private balance, private
payments, claim links, cash outs and proofs of funds on Robinhood Chain, Tempo,
Base and Ethereum (Elysium mainnet support is coming). An x402 marketplace adds the seller helper and its sellers
take Gloam private payments next to the standard x402 ones they take today.

- **Framework-agnostic.** Tools are plain data (name, description, JSON schema)
  plus one `call(name, input)`. Map them onto MCP, the Anthropic or OpenAI tool
  formats, or your own registry in a few lines.
- **Preview, then execute.** Every action that moves money or shows something
  about it is two calls. The preview returns exactly what will be signed or
  sent (amount, asset, network, recipient or tag, fee, the calls the wallet
  signs) with a `previewId` and a `digest`. `gloam_execute` runs that preview,
  once. A kit that asks for an exact approval before anything is signed keeps
  that model as it is.
- **Built on the existing engine.** The handlers run `GloamAgent`
  (`@gloamtrade/game-plugin-gloam/engine`), which is built on `@gloamtrade/sdk`.
  Proving, note handling, spending limits and lost-answer recovery are the
  engine's, not a copy.

## Five-minute quickstart

From a checkout of this repo:

```bash
pnpm install
cd examples/agent-kit-tools
pnpm test        # 22 tests, no chain needed
```

Then against a network (Robinhood Chain mainnet here; a testnet key such as
`base` or `robinhood` works the same way):

```bash
GLOAM_NETWORK=robinhood-mainnet \
GLOAM_AGENT_PRIVATE_KEY=0x... \
GLOAM_NOTE_KEY=$(openssl rand -hex 32) \
pnpm example     # lists the tools, reads the balance, previews a 1 USDG deposit
```

`GLOAM_EXECUTE=1` runs the deposit it previewed. Keep `GLOAM_NOTE_KEY`: it
opens the note store, and the note store holds the money.

In your kit:

```ts
import { createGloamToolPack } from "./agent-kit-tools/src/index.js";

const gloam = createGloamToolPack({
  network: "robinhood-mainnet",
  // Your kit's wallet: anything with an address and sendCalls(calls). Default: GLOAM_AGENT_PRIVATE_KEY.
  sender: myKitWallet,
  // The owner's limits. Each asset has its own caps; without limits nothing moves.
  limits: { recipients: "any", assets: { USDG: { maxPerPayment: "50", maxPerDay: "200" } } },
  // Claim links are bearer secrets: they come to your code, never to the model.
  onClaimLink: (c) => deliverToUser(c.link),
  // Optional: your approval screen sees the exact calls before the wallet signs them.
  onSign: async (calls, ctx) => showApproval(ctx.action, calls),
  // Optional: a Gloam partner key, so your volume counts on the partner dashboard.
  apiKey: process.env.GLOAM_API_KEY,
});

// Register the tools with your framework...
for (const t of gloam.definitions) registerTool(t.name, t.description, t.inputSchema, (input) => gloam.call(t.name, input));

// ...or call them yourself.
const p = await gloam.call("gloam_preview_pay", { to: "gloamr1....", amount: "25", note: "invoice 7" });
// p.details: { amount: "25 USDG", to: "gloamr1....", fee: "None: private payments are free.", ... }
// p.walletSigns: [] (the proof authorizes it and the Gloam relay sends it)
const done = await gloam.call("gloam_execute", { previewId: p.previewId, digest: p.digest });
```

Outside this repo, install the two packages and copy `src/`:

```bash
npm install @gloamtrade/sdk @gloamtrade/game-plugin-gloam viem snarkjs circomlibjs
```

The pack imports `@gloamtrade/game-plugin-gloam/engine` and uses `payX402`,
`noteBackend` and `apiKey`. Those land on npm with the next release of
`@gloamtrade/game-plugin-gloam` (0.1.2 on npm today does not have them); until
then, run it from this repo.

## Tools

| Tool | Kind | What it does | Public on chain |
| --- | --- | --- | --- |
| `gloam_balance` | read | Private balance per asset, the agent's Gloam address (`gloamr1.…`), what the wallet holds, limits left today. `largestPayment` is the most one payment can be | Nothing |
| `gloam_receive` | read | Pick up payments sent to the agent's Gloam address and secure each one into a note only it knows | A shielded transfer |
| `gloam_preview_shield` | preview | Deposit from the wallet into the private balance (USDG on Robinhood Chain mainnet, or any asset the vault takes) | The deposit: wallet, asset, amount |
| `gloam_preview_pay` | preview | Pay a Gloam address or a payment request link privately | A shielded transfer only |
| `gloam_preview_claim_link` | preview | Pay by claim link, for someone with no Gloam address | A shielded transfer only |
| `gloam_preview_cash_out` | preview | Private balance to a 0x address. The preview shows the vault's live fee (0.5% on mainnet) and what arrives | The cash out: asset, amount, recipient |
| `gloam_preview_prove_funds` | preview | A `gloamfunds1:` proof that the agent holds at least an amount, for one named reader, with an expiry | Nothing |
| `gloam_preview_pay_x402` | preview | Request a URL; if it answers 402 with a Gloam price, plan paying it privately. For scheme `gloam-cashout`, plan a cash out of the quoted amount to the resource's public address (needs `maxAmount`) | A shielded transfer only; for `gloam-cashout`, the cash out to the public payee |
| `gloam_execute` | execute | Run a preview by its `previewId` (and `digest`) | What the preview said |
| `gloam_verify_proof` | read | Check a `gloamfunds1:` or `gloampay1:` proof against the chain | Nothing |

Deposits and private payments are free; a cash out costs 0.5%. Mainnet has
deposit limits (50,000 of a stablecoin per deposit).

## Preview, then execute

A preview looks like this (trimmed):

```json
{
  "status": "preview",
  "previewId": "pv_Xq3...",
  "digest": "sha256:9c1e...",
  "action": "cash_out",
  "expiresAt": "2026-11-05T12:10:00.000Z",
  "summary": "Cash out 100 USDG to 0xAbc... on Robinhood Chain mainnet: 99.5 USDG arrives after the 0.5% fee.",
  "network": { "key": "robinhood-mainnet", "name": "Robinhood Chain mainnet", "chainId": 4663, "testnet": false },
  "details": {
    "amount": "100 USDG",
    "asset": { "symbol": "USDG", "address": "0x5fc5...", "decimals": 6 },
    "to": "0xAbc...",
    "fee": { "bps": 50, "percent": "0.5%", "amount": "0.5 USDG" },
    "receives": "99.5 USDG"
  },
  "walletSigns": [],
  "submittedBy": "the Gloam relay, which pays the gas (your wallet does not appear next to it)",
  "public": "A cash out is the public exit: the asset, the amount and the recipient show. Which private payment funded it does not."
}
```

What the pack guarantees:

- **Execute runs the preview, not new input.** The amount in base units, the
  asset, the recipient, the network and the fee are bound when the preview is
  made and hashed into the digest. Pass the digest you approved to
  `gloam_execute` and a different preview is refused.
- **Once.** A second execute returns the first result. The one exception is an
  x402 payment the seller did not serve yet: executing again presents the same
  payment again, and never pays again.
- **Fresh.** A preview expires after 10 minutes (`previewTtlMs`). A cash out
  whose fee changed since the preview is refused.
- **The wallet signs only what the preview named.** The kit's wallet is wrapped
  in a guard. Outside a running preview it signs nothing. A deposit may sign an
  approve of the vault for exactly the amount (with a reset to 0 first where the
  token needs one) and one `shieldBound` of exactly that asset and amount. A
  cash out sent from the wallet may sign only an `unshield` of exactly that
  asset, recipient and amount. Anything else is refused before it reaches the
  wallet. `onSign` sees each batch decoded and can still say no.
- **Errors move nothing.** An execute that comes back `error` or `refused` sent
  nothing, so the same approved preview can run again. When a send may have
  gone out but its answer was lost, the result is `unconfirmed` and the engine
  never pays it twice: `gloam_balance` with `refresh` settles it.

Private payments and cash outs are proven on this machine and sent by the Gloam
relay by default, so the wallet signs only deposits. With `submit: "wallet"`
they come from the wallet too, and `walletSigns` lists them.

## Secrets and storage

- **Notes.** A note's secret is the money. Secrets stay in the engine's note
  store and every result passes through its redactor; tools hand out handles
  and public facts. The store is one AES-256-GCM ciphertext, keyed by
  `GLOAM_NOTE_KEY` (or derived from `GLOAM_AGENT_PRIVATE_KEY`). It lives in a
  local file by default (`GLOAM_NOTE_STORE`, or `~/.gloam/game-notes.<agent>.json`).
  To keep it elsewhere, pass `noteBackend`: an object with `read()`, `write(text)`
  and `lock(fn)`. It only ever sees ciphertext.

  ```ts
  createGloamToolPack({ network: "robinhood-mainnet", noteBackend: {
    where: "keychain:gloam-agent-7",
    read: () => keychain.get("gloam-agent-7") ?? null,
    write: (text) => keychain.set("gloam-agent-7", text),   // atomic
    lock: (fn) => keychainLock.run(fn),
  } });
  ```

- **Claim links** go to `onClaimLink`, or sealed to a Gloam address given as
  `sealTo`, or stay in the store for your code to read with
  `gloam.claimLink(handle)`. A result never carries one.
- **Limits** are the owner's, checked and reserved before anything is signed:
  per asset, per payment and per rolling 24 hours, recipients, actions and an
  expiry. They are enforced by this code, not by the vault contract.
- **x402 requests** go to https URLs only (`allowHttp` for local development),
  never follow a redirect, and never carry credentials in the URL. Pass `fetch`
  to route them through your own egress rules.

## Count your integration

Make a partner key at [gloam.trade/partners/dashboard](https://gloam.trade/partners/dashboard)
and pass it as `apiKey` (or `GLOAM_API_KEY`). Private payments, cash outs and
payment messages then go through the partner relay, and deposits are attributed
once they land, so the dashboard counts what your kit brings in. Partner fees
are not charged yet. See the [Partner API](https://gloam.trade/docs/partners).

## Bundle the Gloam MCP server instead

A kit that speaks MCP can run Gloam's own MCP server next to its own, with no
code. Add it to the client's config:

```json
{
  "mcpServers": {
    "gloam": {
      "command": "npx",
      "args": ["-y", "@gloamtrade/mcp"],
      "env": { "GLOAM_ENV_FILE": "/home/agent/.gloam/agent.env" }
    }
  }
}
```

Keys and limits go in that file (mode 600), not in the client config:

```bash
GLOAM_NETWORK=robinhood-mainnet
GLOAM_AGENT_PRIVATE_KEY=0x...
GLOAM_NOTE_KEY=...                 # openssl rand -hex 32
GLOAM_LIMITS_FILE=/home/agent/.gloam/limits.json
```

What differs from this pack: the MCP server (0.7.x) shields, pays privately,
pays x402 and MPP resources (`gloam_fetch_paid`), checks payments it is paid
(`gloam_verify_payment`) and runs private swaps, under the same kind of owner
limits. Its execute tools run directly, so the approval step is your MCP
client's tool approval rather than a preview id, and it has no claim link, cash
out or proof of funds tool yet. The hosted `https://www.gloam.trade/mcp` reads
and plans only and never takes a key. See the [MCP README](../../mcp/README.md).

## Sell with private x402

For marketplaces where sellers put x402 middleware in front of an API and
agents pay per call (standard SDKs such as `@x402/core`). A seller keeps its
standard x402 `exact` price and adds a Gloam price next to it. Agents that can
pay privately do; the rest keep paying the normal way.

### What a standard client can and cannot do

- A standard x402 client (`x402-fetch`, `@x402/fetch` and the like) never sees
  or pays the Gloam price. It pays `exact` as before.
- To pay privately, the client must support Gloam's scheme, `gloam-private`:
  this pack (`gloam_preview_pay_x402`), the Gloam MCP server (`gloam_fetch_paid`),
  or the SDK (`buildGloamPayment`). There is no `gloam-private` plugin for the
  standard x402 SDKs today.
- Adding the Gloam price does not break standard clients, because of where it
  goes. x402 v1 clients parse every entry of the 402 body's `accepts` strictly
  (scheme `exact`, a fixed list of networks) and stop on anything else, so the
  body is left as it is and the Gloam price rides in its own header. x402 v2
  clients read the `PAYMENT-REQUIRED` header and skip schemes they have not
  registered, so the Gloam entry is added there too.

### The 402 answer

A standard v1 answer, with the Gloam price added:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-Payment-Required: gloamx402req1:eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZ2xvYW0tcHJpdmF0ZSIs...

{"x402Version":1,"error":"X-PAYMENT header is required",
 "accepts":[{"scheme":"exact","network":"base","maxAmountRequired":"250000","payTo":"0x...", ...}]}
```

`X-Payment-Required` holds the Gloam requirements, encoded:

```json
{
  "x402Version": 1,
  "scheme": "gloam-private",
  "network": 4663,
  "maxAmountRequired": "250000",
  "asset": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  "assetSymbol": "USDG",
  "payTo": "gloamr1.MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...",
  "resource": "https://api.example.com/v1/quote",
  "poolAddress": "0x39e28cde55cab798874746ac52cb4b5cc99a0194",
  "maxTimeoutSeconds": 120
}
```

On a v2 answer, the `PAYMENT-REQUIRED` header's `accepts` also gets:

```json
{ "scheme": "gloam-private", "network": "eip155:4663", "amount": "250000",
  "asset": "0x5fc5...", "payTo": "gloamr1....", "maxTimeoutSeconds": 120,
  "extra": { "gloam": "gloamx402req1:...", "poolAddress": "0x39e2...", "assetSymbol": "USDG" } }
```

The buyer pays and retries with `X-PAYMENT: gloamx402pay1:…`. That value holds
the payment note sealed to the seller's Gloam address (only the seller's key
opens it) and the settlement transaction.

### The middleware

For fetch-style servers (Hono, Next.js route handlers, Bun, Deno, Workers):

```ts
import { generateReceiveKey } from "@gloamtrade/sdk";
import { createGloamSeller, protectWithGloam } from "./agent-kit-tools/src/index.js";

// Once: the seller's receive key. Share key.tag; keep key.privateJwk on the server.
const key = await generateReceiveKey();

const seller = createGloamSeller({
  receiveKey: key,
  network: "robinhood-mainnet",
  // The swept payment, in a note only the seller knows. Store it before anything else: it is the money.
  saveNote: (fresh) => db.insert("gloam_notes", fresh),
  apiKey: process.env.GLOAM_API_KEY, // optional: sweeps count on the partner dashboard
});

export const GET = protectWithGloam({
  seller,
  price: (req) => ({ amount: "0.25", asset: "USDG" }), // null for a free request
  handler: quoteHandler,                                // the resource
  standard: withStandardX402(quoteHandler),            // the same, behind your x402 middleware
});
```

For each request: a Gloam payment in `X-PAYMENT` is settled and, once secured,
the handler serves; anything else goes to the standard chain, and a 402 from it
gets the Gloam price added. Leave `standard` out to sell through Gloam only.

Express, with `x402-express` or similar, is the same three steps by hand:

```ts
import { encodeRequirements } from "@gloamtrade/sdk";

app.use("/v1/quote", async (req, res, next) => {
  const requirements = seller.requirements({ amount: "0.25" }, `${req.protocol}://${req.get("host")}${req.baseUrl}`);
  const presented = req.get("x-payment");
  if (presented?.startsWith("gloamx402pay1:")) {
    const r = await seller.settle(requirements, presented);
    if (r.grantAccess) return quoteHandler(req, res);       // served here: the standard middleware never sees it
    return res.status(402).set("X-Payment-Required", encodeRequirements(requirements)).json({ x402Version: 1, error: r.reason, status: r.status });
  }
  res.set("X-Payment-Required", encodeRequirements(requirements)); // stays on the standard 402
  next();
}, paymentMiddleware(/* your standard x402 config */), quoteHandler);
```

### How the seller verifies and sweeps

`seller.settle(requirements, header)`:

1. Opens the payment note with the seller's receive key.
2. Checks it against the price of this route (never the price the payer sent):
   scheme, network, vault, asset, at least the amount, the note's amount bound
   to its commitment, and that it is the payment output of its transfer.
3. Sweeps it: a private send of the whole note into a fresh note only the
   seller knows, through the Gloam relay (no gas, and the seller's wallet does
   not appear). `saveNote` gets the fresh note before the sweep is sent.
4. Grants access only once the fresh note is in the vault.

The sweep is what makes it the seller's money. The buyer made the payment note,
so it knows that note's secret and could spend it back until the seller moves
it. A buyer who gets there first leaves the sweep with nothing (`already_spent`)
and is not served. Each payment is served once: the seller keeps which payments
it secured in a ledger, in memory by default (pass `ledger` with your own store
when more than one process serves). Securing a payment takes a proof and a
confirmation, so a paid request takes a few seconds longer than a free one.
Cash the swept notes out with the pack's `gloam_preview_cash_out`, or in the
[Gloam app](https://gloam.trade/app).

## What is public, and what was reviewed

Robinhood Chain, Tempo, Base and Ethereum mainnets are live with
deposit limits (Elysium mainnet support is coming, with gas in HYPE). A deposit and a cash out are public (wallet or recipient, asset,
amount); a private payment shows only that a shielded transfer happened.
Privacy grows with the number of notes in a vault, so a quick deposit and cash
out of the same amount can be linked. Kann Audits reviewed the vault contracts
and Hey Research Lab reviewed the stack; the engine, this pack and the seller
helper are the parts to read before trusting them with money. Start small.

## Files

| File | What it is |
| --- | --- |
| `src/definitions.ts` | The tools as data: names, descriptions, JSON schemas |
| `src/pack.ts` | `createGloamToolPack`: handlers, previews, execute |
| `src/guard.ts` | The wallet guard: signs only what the running preview named |
| `src/previews.ts` | Preview records, digests, expiry |
| `src/x402.ts` | Reading a Gloam price out of a 402 answer |
| `src/seller.ts` | `createGloamSeller`, `protectWithGloam`: take private x402 |
| `src/example.ts` | The five-minute check |
| `test/` | Preview and execute on a fake engine, the guard, and x402 end to end on the real engine |
