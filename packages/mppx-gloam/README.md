# @gloamtrade/mppx-gloam

Private payments for the [Machine Payments Protocol](https://mpp.dev) (MPP).

MPP is HTTP 402 done properly: a server answers `WWW-Authenticate: Payment …`, the client pays and retries with `Authorization: Payment …`, and gets a `Payment-Receipt`. Every method so far (tempo, evm, stripe, solana) settles in public, so the ledger shows which agent paid which service, how much, how often.

This package adds the **`gloam`** method. A charge is paid with a private transfer inside a Gloam shielded pool on Tempo, Robinhood Chain, Base or Ethereum, on mainnet or testnet (Elysium mainnet support is coming):

- the payment note is sealed to the payee's receive tag, so only the payee can open it;
- the server checks it binds the price, that it is the payment output of a `Transferred` event in the official pool, and that the credential is bound to this exact challenge;
- the server sweeps the payment into a fresh note only it knows, and serves only after that sweep confirms (until then the payer, who created the note, could spend it back);
- the public chain sees shielded transfers: a nullifier and two commitments each. No amount, no asset, no payer, no payee.

Spec: [`docs/mpp/draft-gloam-charge-00.md`](../../docs/mpp/draft-gloam-charge-00.md).

## Server (mppx)

```ts
import { Mppx } from "mppx/server";
import { gloam } from "@gloamtrade/mppx-gloam/server";
import { gloamChargeChainFromClient } from "@gloamtrade/mppx-gloam/core";
import { artifactProver, circuitArtifactUrls, mainnetNetwork, relayIntent } from "@gloamtrade/sdk";

const tempo = mainnetNetwork("tempo")!;                   // Tempo mainnet; GLOAM_NETWORKS.tempo for the testnet
const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    gloam({
      network: "tempo-mainnet",                           // USDC.e by default; "tempo" for the testnet (PathUSD)
      receiveKey,                                         // from generateReceiveKey(), stored server side
      chain: gloamChargeChainFromClient(publicClient, { pool: tempo.pool, fromBlock: tempo.deployBlock }),
      prove: artifactProver(circuitArtifactUrls("transfer", tempo.chainId)), // final keys on mainnet
      submit: (intent) => relayIntent(intent),            // or your own wallet: writeContract(...)
      beforeSubmit: (freshNote) => saveNote(freshNote),   // the money: persist before the sweep goes out
    }),
  ],
});

export async function handler(request: Request) {
  const r = await mppx.charge({ amount: "0.01" })(request);
  if (r.status === 402) return r.challenge;
  return r.withReceipt(Response.json({ answer: 42 }));
}
```

With Hono: `import { Mppx } from "mppx/hono"` and `app.get("/answer", mppx.charge({ amount: "0.01" }), handler)`.

Options: `modes: ["push"]` or `["pull"]` to accept one submission mode (default both), `replay` for a shared replay store when several instances settle (default in memory), `pools` only for a private deployment you trust.

### Settling fast

A sweep needs the payment's membership path, so the server needs the pool's tree. `gloamChargeChainFromClient` keeps it for the life of the server (the SDK's `createTreeSync`) and reads only the blocks since the last payment. Make it once, start it before the first request, and keep it current:

```ts
import { createTreeSync, gloamLeafSeed } from "@gloamtrade/sdk";

const tree = createTreeSync(publicClient, {
  pool: tempo.pool,
  fromBlock: tempo.deployBlock,
  chunkSize: 99_000n,                     // Tempo's RPC caps eth_getLogs at 100,000 blocks
  seed: gloamLeafSeed("tempo-mainnet"),   // cold start: Gloam's public leaf list, checked against the pool's root
  store: fileStore(".cache/tree.json"),   // optional: a restart reads only the blocks since
  reuseMs: 5_000,
});
const chain = gloamChargeChainFromClient(publicClient, { pool: tempo.pool, tree, pollingInterval: 250 });
await chain.warm();                       // at startup: the tree and the RPC's chain id
tree.follow(1_000);                       // a payment's leaf is usually there before the sweep asks
```

What a payment still waits for, and should: the payer's transfer to confirm (pull mode), then the sweep to confirm with its fresh note in the pool. A receipt is served only after that, since until the sweep lands the payer could spend the payment note back. The sweep's own receipt is enough proof when it carries the pool's `Transferred` event for the fresh note; otherwise the pool is asked (`commitmentSeen`). Neither wait can be turned off. On Tempo testnet from a laptop a warm payment settles in about 7 to 8 seconds, most of it the two relay submissions and their blocks (see `examples/e2b-private-mpp`).

## Client (mppx)

```ts
import { Mppx } from "mppx/client";
import { gloam } from "@gloamtrade/mppx-gloam/client";
import { artifactProver, circuitArtifactUrls, relayIntent, TEMPO_USDCE, TEMPO_MAINNET_CHAIN_ID } from "@gloamtrade/sdk";

const mppx = Mppx.create({
  polyfill: false,
  methods: [
    gloam({
      getNote: ({ amountWei, currency }) => wallet.noteCovering(amountWei, currency), // { secret, amountWei, path }
      prove: artifactProver(circuitArtifactUrls("transfer", TEMPO_MAINNET_CHAIN_ID)), // the keys of the chain you pay on
      mode: "auto",                                       // pull when offered, else push
      submit: (intent) => relayIntent(intent),            // only needed for push
      policy: { maxAmountWei: 50_000n, currencies: [TEMPO_USDCE], chainIds: [TEMPO_MAINNET_CHAIN_ID] },
      beforeSubmit: (built) => wallet.keep(built.changeNote),
    }),
  ],
});

const res = await mppx.fetch("https://api.example.com/answer");
```

The client refuses, before proving anything, a pool that is not Gloam's for that chain, a recipient that is not a receive tag, and anything outside `policy`.

Proofs must be made with the keys of the chain the payment settles on: the trusted setup's final keys on mainnet (Tempo `4217`, Robinhood Chain `4663`), the dev keys on testnet. `circuitArtifactUrls("transfer", chainId)` from the SDK returns the right files. A client that pays on more than one chain picks the prover per challenge. In Node, snarkjs reads local files only: download the files first, check them against `CIRCUIT_SHA256`, and pass their paths to `artifactProver`.

## Without an MPP library

`@gloamtrade/mppx-gloam/core` has the whole method with no `mppx` dependency:

```ts
import { createGloamPaywall, createGloamChargeCredential, parsePaymentChallenges, isGloamChargeChallenge } from "@gloamtrade/mppx-gloam/core";

// Server: same handler shape as mppx.
const paywall = createGloamPaywall({ secretKey, server: { receiveKey, chain, prove, submit, beforeSubmit: (freshNote) => saveNote(freshNote) } });
const r = await paywall.charge({ amount: "0.01" })(request);

// Client.
const [challenge] = parsePaymentChallenges(res.headers.get("www-authenticate")).filter(isGloamChargeChallenge);
const { authorization } = await createGloamChargeCredential({ challenge, note, prove, mode: "pull" });
await fetch(url, { headers: { Authorization: authorization } });
```

It also exports the Payment scheme codec (challenges, credentials, receipts, the HMAC challenge id, byte compatible with mppx), `validateGloamCharge` (read-only checks) and `settleGloamCharge` (sweep and receipt).

## Push or pull

| | push | pull |
|---|---|---|
| Who broadcasts the payer's transfer | the payer (its wallet or the Gloam relay) | the server |
| Payer needs gas / a wallet on chain | yes (unless relayed) | no |
| If the server refuses | the value already moved (sealed to the payee) | nothing moved |
| What the server learns | the payer's sending address, unless relayed | nothing about the payer's wallet |

In pull mode the server checks the payer's transfer against the pool before it submits anything: `gloamChargeChainFromClient` makes an `eth_call` of `transfer()` (`transferWouldLand`), and a transfer the pool would refuse is refused with nothing sent. A custom `GloamChargeChain` can set `transferWouldLand` the same way (`transferCheckFromCall` builds it from any call function); without it the transfer is submitted as before.

## Networks

| `network` | Chain | Default currency | Keys |
| --- | --- | --- | --- |
| `"tempo-mainnet"` | Tempo mainnet `4217` | USDC.e (also pathUSD, USDT0, OUSD) | Final ceremony keys |
| `"robinhood-mainnet"` | Robinhood Chain mainnet `4663` | USDG (also GLOAM) | Final ceremony keys |
| `"tempo"` | Tempo Moderato `42431` | PathUSD | Dev keys |
| `"robinhood"` | Robinhood Chain testnet `46630` | ETH | Dev keys |

The default `network` is still `"tempo"` (the testnet), as in 0.0.x. Official pools come from the SDK this package is built with: a mainnet appears once that SDK has its pool, and a challenge naming any other pool is refused on both sides.

Base: `"base"` (Base Sepolia `84532`, test USDC by default, also EURC and ETH, on the final keys) works with SDK 0.3.0, which has its pool. `"base-mainnet"` (Base `8453`, USDC by default, also EURC, USDT and ETH), live since 26 October 2026, works when built with SDK 0.4.1 or later, which has its pool; built with an older SDK it is refused with a plain error.

Ethereum too (0.3.0): `"ethereum-mainnet"` (Ethereum `1`, USDC by default, also USDT, USDG, PYUSD, EURC and ETH), live since 26 October 2026, works the same way with SDK 0.4.1 or later. Its testnet is Ethereum Sepolia, below.

Elysium is coming: `"elysium-mainnet"` (Elysium mainnet, USDC only, gas in HYPE, final keys) and `"elysium"` (Elysium testnet `99801`, test USDC) are known to this package, and are coming in a build whose SDK has Elysium's values. Until then each is refused with a plain error.

Ethereum Sepolia: `"ethereum"` (`11155111`, test USDC by default, also USDG, PYUSD, EURC and ETH, on the final keys) is known to 0.3.0 and works with SDK 0.4.0, which has its pool (deployed 25 October 2026). Built with an older SDK it is refused with a plain error.

### The chain reader must say which chain it reads

Gloam's vault has one address on every chain, and ETH is `0x0` on all of them. A server pricing a charge on one chain with a reader pointed at another (Base mainnet `8453` and Base Sepolia `84532`, Ethereum `1` and Ethereum Sepolia `11155111`) would otherwise see the other chain's payments as real.

- `gloamChargeChainFromClient` asks the RPC for its chain id once (`eth_chainId`).
- A charge is validated and settled only when that id is the charge's. Otherwise it gets a 402.
- A custom `GloamChargeChain` should set `chainId()` the same way. Without it nothing can be checked, so set it on every Base and Ethereum chain especially.

## Status

Mainnet on Tempo, Robinhood Chain, Base and Ethereum (Base and Ethereum need a build with SDK 0.4.1 or later; Elysium support is coming), payments only, with the trusted setup's final keys and deposit limits on the pools; reviewed internally before launch, and Kann Audits reviewed the vault contracts (report, 1 November 2026: gloam.trade/security) and found no Critical, High or Medium issues. The testnets stay up.

## Tests

```bash
pnpm --filter @gloamtrade/mppx-gloam test
```

Runs against an in-memory pool that applies the pool's transfer rules: wire codec (spec HMAC vectors, mppx interop both ways), push and pull end to end, replay, a credential lifted onto another challenge, wrong keys, amounts, assets, pools and events, a payer who spends the payment back, lost sweep receipts, concurrency, the Fetch paywall, and `Mppx.create` on both sides.
