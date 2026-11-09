# E2B sandboxes, paid privately over MPP

Agents already buy E2B sandboxes at `mpp.e2b.dev` with MPP on Tempo.
Every one of those payments is public: the agent's wallet, E2B's wallet and the amount, readable by anyone with one RPC query.
That tells competitors which agents run on E2B, how much they spend and when they scale up.
Adding Gloam's `gloam` method next to the existing `tempo` one lets an agent pay the same price from a private balance.
The chain then shows a nullifier and two commitments. No payer, no payee, no amount.

## What is in here

| File | What it does |
| --- | --- |
| `public-402.mjs` | Calls the real `https://mpp.e2b.dev/sandboxes` without paying, decodes the 402 and shows what a payment puts on Tempo mainnet. Also reads the last payments into E2B's wallet from the public RPC. No key, no payment. |
| `server.ts` | What E2B adds: an `mpp.e2b.dev`-style `POST /sandboxes` that offers `tempo` (as today) and `gloam`. On a private payment it forwards to `https://api.e2b.app/sandboxes` when `E2B_API_KEY` is set, else returns a mock sandbox labelled `"mock": true`. |
| `agent.ts` | An agent with a private balance. It pays the 402 with `mppx/client` and the `gloam` method, prints the receipt and the sandbox id, then reads both transactions from the chain and shows what is and is not there. |
| `fund.ts` | One-time testnet setup: a throwaway key, Tempo's testnet faucet, and a 1 PathUSD deposit into the Gloam pool. |
| `demo-output.txt` | The full transcript of a real run on Tempo testnet (three purchases: one cold, two warm). |
| `public-402-output.txt` | `public-402.mjs` run against the live E2B endpoint. |

## Run it

From the repo root, `pnpm install`, then in `examples/e2b-private-mpp`:

```bash
node public-402.mjs   # the live E2B endpoint, no payment
pnpm fund             # once: throwaway Tempo testnet key, faucet, 1 PathUSD into the Gloam pool
pnpm server           # terminal 1
pnpm agent            # terminal 2
```

Everything runs on Tempo testnet (Moderato, chain 42431) with test PathUSD and the Gloam testnet pool `0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb`. `pnpm fund` writes the throwaway key, the seller's receive key and the MPP secret to `.env`, and note secrets to `.wallet/`. Both are gitignored and nothing prints them. Set `E2B_API_KEY` before `pnpm server` to create real sandboxes on `api.e2b.app`.

Each side keeps the pool's Merkle tree in `.cache/` (gitignored, public chain data only). With nothing there, it starts from Gloam's public leaf list (one request, checked against the pool's root on chain) instead of walking the pool's logs.

### Before a live call

Warm both sides once, a few minutes before:

```bash
pnpm server           # terminal 1: syncs the pool tree at startup ("warm  pool tree ready in ...") and keeps it current
pnpm agent            # terminal 2: one throwaway purchase, so the agent's .cache/ holds its newest note
```

Leave the server running. On the call, `pnpm agent` again: each purchase prints a `timings` line on both sides. The agent holds about 0.89 test PathUSD, about 100 purchases at 0.008721. If the server was restarted, that is fine: it reads only the blocks since its `.cache/` copy.

## Timings

One purchase, measured on a laptop against the public Tempo testnet RPC (each RPC call there took 0.4 to 1 s) and Gloam's production relay. Before is the code merged in #245, after is this version. Full logs in `demo-output.txt`.

| Phase | Before | After, cold | After, warm |
| --- | --- | --- | --- |
| Agent: the note's membership path | 54.4 s (walks ~6M blocks of logs) | 3.4 s (Gloam's leaf list + root check) | 1.2 to 2.2 s (kept tree + root check, no log reads) |
| Agent: payment proof | 0.4 s | 0.4 s | 0.4 s |
| Server: checks before submitting | 4.2 s (sequential reads) | 0.6 s (in parallel) | 1.0 s |
| Server: relay submits the payer's transfer | 2.9 s | 2.0 s | 3.0 to 4.2 s |
| Server: payer's transfer confirms | 0.7 s | 1.5 s | 0.3 to 1.0 s |
| Server: the payment's path (tree sync) | 48.8 s (walks again) | 1.0 s (new blocks only) | 0.0 to 0.5 s (kept current) |
| Server: sweep proof | 0.4 s | 0.4 s | 0.2 s |
| Server: relay submits the sweep | 2.6 s | 1.5 s | 1.6 to 3.3 s |
| Server: sweep confirms | 0.3 s | 0.3 s | 0.3 s |
| Paid request (credential sent to 201) | 61.3 s | 9.0 s | 9.3 to 9.4 s |
| End to end (first request to 201) | 115.8 s | 10.8 s | 9.9 to 11.2 s |

A warm run earlier the same evening came in at 6.9 to 9.3 s end to end. The server's startup sync (2.9 s from the leaf list) happens once, before the first request.

What is left is the floor of a private payment that is safe to serve: two relay submissions (1.5 to 4 s each, about 0.65 s of it the round trip to gloam.trade) and two block confirmations. The server never serves before the sweep has confirmed and its fresh note is in the pool, so the payer cannot spend the payment back; that wait is not configurable and should not be.

What changed:

- The SDK keeps the pool tree (`createTreeSync`) instead of rebuilding it for every path: each sync reads only the blocks since the last one, a restart starts from a stored copy, and a cold start from Gloam's public leaf list. Every root it builds from a copy or the list is checked against the pool (`isKnownRoot`) before use, and a list that does not match is dropped for a walk of the chain. Gloam pools keep every root they have had, so the agent's path comes from its kept tree with that one check and no log reads.
- `gloamChargeChainFromClient` keeps one tree for the life of the server; `warm()` syncs it at startup, `follow(1000)` keeps it current, and a sweep's path reads only up to the payer's receipt block.
- The server's checks before submitting run in parallel, the read the settle step repeated right after validation is gone, and a sweep whose receipt carries the pool's `Transferred` event for the fresh note is final without one more read.
- Receipts are polled every 250 ms (viem's default is 4 s), and the SDK's relay URL is `www.gloam.trade` (the bare domain answered every relay call with a redirect).
- Proving keys were never the problem: a transfer proof takes 0.2 to 0.4 s with the files read from disk each time.

## What the real run showed

From `demo-output.txt` (three purchases):

- The 402 offers `tempo/charge` to wallet `0xb10A...1460` (public) and `gloam/charge` to a receive tag (private), both at E2B's price for a 300 second `base` sandbox, 0.008721.
- The agent pays in pull mode: it proves the payment and broadcasts nothing. The server submits it through the Gloam relay, sweeps it into a note only the server knows, and then creates the sandbox. `201`, `Payment-Receipt method=gloam status=success`.
- On chain, both transactions are `transfer(proof, root, nullifier, newCommitments)` sent by the relay to the pool. The agent's wallet appears in neither, no token transfer of the price happens, and E2B has no address at all. The only token movement is the relay's gas fee.

| Purchase | Payment tx | Sweep tx |
| --- | --- | --- |
| 1 (cold) | [0xe6bacfda...](https://explore.testnet.tempo.xyz/tx/0xe6bacfda64163bc42f8bb0f047a95215d63c15eee4192ac2c83e9fa5dc91be31) | [0x834d6957...](https://explore.testnet.tempo.xyz/tx/0x834d69570b9c8417628261545562e587af8be6b010a9d6898165ac897e5c954c) |
| 2 (warm) | [0x0da27beb...](https://explore.testnet.tempo.xyz/tx/0x0da27beba848ae4ae63092835b0755bcff9f7eaca072a276669bb022aac6d65f) | [0xfe0c5dbe...](https://explore.testnet.tempo.xyz/tx/0xfe0c5dbe94407b59687a018de360aba649889fce64935d5e59aea49d458ba32e) |
| 3 (warm) | [0xc1af4775...](https://explore.testnet.tempo.xyz/tx/0xc1af47752395cb9457f0195e420f09c7aa257153f89322c54eac22db553942ee) | [0x35668a15...](https://explore.testnet.tempo.xyz/tx/0x35668a158229e358dc4c2a7b5ca684177b9aa5ae6d777752b7221c75a743ea7a) |

The one public step is the agent's deposit into the pool ([0xa7c9dfdf...](https://explore.testnet.tempo.xyz/tx/0xa7c9dfdfac090fa04ba8e53a6830e7fa07849eeaf9c1c4982b5810de9aad3776)). It shows that address put 1 PathUSD into Gloam, not what it bought or from whom.

## The code E2B adds

`npm i @gloamtrade/mppx-gloam @gloamtrade/sdk`, then one entry in the methods array. The `tempo` method stays as it is.

```ts
import { Mppx, tempo } from "mppx/server";
import { gloam } from "@gloamtrade/mppx-gloam/server";
import { gloamChargeChainFromClient } from "@gloamtrade/mppx-gloam/core";
import { artifactProver, createTreeSync, gloamLeafSeed, mainnetNetwork, relayIntent } from "@gloamtrade/sdk";

const net = mainnetNetwork("tempo")!; // Tempo mainnet (4217), the Gloam pool and its deploy block

// The pool's tree, kept for the life of the server (and in a store across restarts), so a payment reads only new blocks.
const tree = createTreeSync(publicClient, {
  pool: net.pool,
  fromBlock: net.deployBlock,
  chunkSize: 99_000n,                   // Tempo's RPC caps eth_getLogs at 100,000 blocks
  seed: gloamLeafSeed("tempo-mainnet"), // cold start: Gloam's public leaf list, checked against the pool's root
  store: treeStore,                     // optional: { load(), save(snapshot) } in a file, Redis or a database
  reuseMs: 5_000,
});
const chain = gloamChargeChainFromClient(publicClient, { pool: net.pool, tree, pollingInterval: 250 });
await chain.warm();                     // at startup
tree.follow(1_000);                     // keep it current

const mppx = Mppx.create({
  secretKey,
  methods: [
    tempo.charge({ currency: USDC_E, recipient: E2B_WALLET }),          // unchanged
    gloam({
      network: "tempo-mainnet",                                        // USDC.e by default
      receiveKey,                                                      // generateReceiveKey(), once, kept server side
      chain,
      prove: artifactProver({ wasm: "transfer.wasm", zkey: "transfer_final.zkey" }), // final ceremony keys
      submit: (intent) => relayIntent(intent),                         // Gloam's relay pays the gas
      beforeSubmit: (note) => saveNote(note),                          // the swept note is E2B's money
    }),
  ],
});
```

Routes do not change: `mppx.charge({ amount })` (or a `compose` with `["gloam/charge", { amount }]` next to the tempo entry) now offers both. Agents that hold a Gloam balance pay with `gloam`, everyone else keeps paying with `tempo`.

## What E2B would need

- **Sandbox ownership without a wallet.** `mpp.e2b.dev` ties each sandbox to the wallet that paid. A private payment has no payer wallet, so ownership needs another handle: an owner token returned on create, or a public key the agent sends with the request. This is the one change on E2B's side beyond the methods array.
- **A receive key and somewhere to keep notes.** The receive key opens payments (store it like a signing key). Each swept payment is a note whose secret is the money; persist it before the sweep goes out (`beforeSubmit`). E2B cashes out to its Privy wallet whenever it likes; a cash out costs 0.5%, private payments cost nothing.
- **A shared replay store on Vercel.** Pass `replay` (Redis or a database) when several instances settle. The default is in memory.
- **Node runtime and the proving key.** The sweep makes a Groth16 proof (`transfer_final.zkey`, about 3.7 MB). It runs in Node, not the Edge runtime.
- **Latency.** About 9 to 11 seconds per purchase end to end (see Timings), almost all of it two relay submissions and their confirmations. The first version took about 70 seconds per paid request because both sides rebuilt the pool's tree from the public RPC every time; both now keep it. Creating the sandbox can start while the payment settles, as long as it is handed over only after the receipt.
- **Charges only.** `gloam` implements the MPP `charge` intent. Sessions stay on `tempo`.

From us: the Tempo mainnet pool and relay are live, `@gloamtrade/mppx-gloam` is on npm, and we can run this against E2B's staging with a real `E2B_API_KEY`.
