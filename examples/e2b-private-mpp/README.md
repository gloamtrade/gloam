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
| `demo-output.txt` | The full transcript of a real run on Tempo testnet (four purchases: one cold, three warm). |
| `public-402-output.txt` | `public-402.mjs` run against the live E2B endpoint. |

## Run it

From the repo root, `pnpm install`, then in `examples/e2b-private-mpp`:

```bash
node public-402.mjs   # the live E2B endpoint, no payment
pnpm fund             # once: throwaway Tempo testnet key, faucet, 1 PathUSD into the Gloam pool
pnpm proxy           # terminal 1
pnpm agent            # terminal 2
```

Everything runs on Tempo testnet (Moderato, chain 42431) with test PathUSD and the Gloam testnet pool `0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb`. `pnpm fund` writes the throwaway key, the seller's receive key and the MPP secret to `.env`, and note secrets to `.wallet/`. Both are gitignored and nothing prints them. Set `E2B_API_KEY` before `pnpm proxy` to create real sandboxes on `api.e2b.app`.

Each side keeps the pool's Merkle tree in `.cache/` (gitignored, public chain data only). With nothing there, it starts from Gloam's public leaf list (one request, checked against the pool's root on chain) instead of walking the pool's logs.

### Before a live call

Warm both sides once, a few minutes before:

```bash
pnpm proxy           # terminal 1: syncs the pool tree at startup ("warm  pool tree ready in ...") and keeps it current
pnpm agent            # terminal 2: one throwaway purchase, so the agent's .cache/ holds its newest note
```

Leave the server running. On the call, `pnpm agent` again: each purchase prints a `timings` line on both sides. The agent holds about 0.75 test PathUSD, about 85 purchases at 0.008721. If the server was restarted, that is fine: it reads only the blocks since its `.cache/` copy.

## Timings

One purchase, measured on a laptop against the public Tempo testnet RPC and Gloam's production relay. Before is the code merged in #245; after is this version, from the run in `demo-output.txt` (one cold purchase, then three warm).

| Phase | Before | After, cold | After, warm |
| --- | --- | --- | --- |
| Agent: the note's membership path | 54.4 s (walks ~6M blocks of logs) | 3.5 s (Gloam's leaf list + the newest blocks) | 0.2 to 0.3 s (the kept tree, no chain reads) |
| Agent: payment proof | 0.4 s | 0.4 s | 0.4 s |
| Server: checks before submitting | 4.2 s (one read after another) | 0.9 s (side by side) | 0.6 to 1.0 s |
| Server: relay submits the payer's transfer | 2.9 s | 3.7 s | 2.0 to 3.0 s (one 11.9 s outlier) |
| Server: payer's transfer confirms | 0.7 s | 0.3 s | 0.3 to 0.5 s |
| Server: the payment's path (tree sync) | 48.8 s (walks again) | 0.9 s (new blocks only) | 0.2 to 1.2 s (kept current) |
| Server: sweep proof | 0.4 s | 0.4 s | 0.2 s |
| Server: relay submits the sweep | 2.6 s | 1.3 s | 1.4 to 2.2 s |
| Server: sweep confirms | 0.3 s | 3.0 s | 0.3 to 2.0 s |
| Paid request (credential sent to 201) | 61.3 s | 12.8 s | 6.2 s, 7.4 s (17.8 s with the outlier) |
| End to end (first request to 201) | 115.8 s | 13.9 s | 6.7 s, 7.9 s (18.3 s with the outlier) |

The server's startup sync (2.8 to 7.9 s from the leaf list, or from `.cache/` plus the blocks since) happens once, before the first request. Over about fifteen purchases that evening a warm one took 6.7 to 11 s end to end; the slow ones were the testnet RPC or the relay answering in several seconds instead of under one.

What is left is the floor of a private payment that is safe to serve: two relay submissions (usually 1.5 to 3 s each, about 0.65 s of it the round trip to gloam.trade) and two block confirmations. The server never serves before the sweep has confirmed and its fresh note is in the pool, so the payer cannot spend the payment back; that wait is not configurable and should not be.

What changed:

- The SDK keeps the pool tree (`createTreeSync`) instead of rebuilding it for every path: each sync reads only the blocks since the last one, a restart starts from a stored copy, and a cold start from Gloam's public leaf list. Every root built from the list, or from a copy the pool has not confirmed, is checked against the pool (`isKnownRoot`) before use, and a list that does not match is dropped for a walk of the chain. Gloam pools keep every root they have had, so a stored copy saved with its confirmed root gives the agent its path with no chain reads at all.
- `gloamChargeChainFromClient` keeps one tree for the life of the server; `warm()` syncs it at startup, `follow(1000)` keeps it current, and a sweep's path reads only up to the payer's receipt block.
- The server's checks before submitting run side by side, the read the settle step repeated right after validation is gone, and a sweep whose receipt carries the pool's `Transferred` event for the fresh note is final without one more read.
- Receipts are polled every 250 ms (viem's default is 4 s), and the SDK's relay URL is `www.gloam.trade` (the bare domain answered every relay call with a redirect).
- In this demo, a read the RPC has not answered in 1.2 s is sent again and the first answer wins (`hedged` in `common.ts`). Reads only.
- Proving keys were never the problem: a transfer proof takes 0.2 to 0.4 s with the files read from disk each time.

## What the real run showed

From `demo-output.txt` (four purchases):

- The 402 offers `tempo/charge` to wallet `0xb10A...1460` (public) and `gloam/charge` to a receive tag (private), both at E2B's price for a 300 second `base` sandbox, 0.008721.
- The agent pays in pull mode: it proves the payment and broadcasts nothing. The server submits it through the Gloam relay, sweeps it into a note only the server knows, and then creates the sandbox. `201`, `Payment-Receipt method=gloam status=success`.
- On chain, both transactions are `transfer(proof, root, nullifier, newCommitments)` sent by the relay to the pool. The agent's wallet appears in neither, no token transfer of the price happens, and E2B has no address at all. The only token movement is the relay's gas fee.

| Purchase | Payment tx | Sweep tx |
| --- | --- | --- |
| 1 (cold) | [0x24b27c42...](https://explore.testnet.tempo.xyz/tx/0x24b27c42d8ff5096fa5a59b2d34916c945b42627365e604015af39cc9e6005fa) | [0x623ab347...](https://explore.testnet.tempo.xyz/tx/0x623ab3478b764825ab5507d6385f6033f4e0bfe52f174709b43710669dd261ed) |
| 2 (warm) | [0x35db5643...](https://explore.testnet.tempo.xyz/tx/0x35db56432732ef7adb19ae542f6874085ed8c7ef423df0e97fcac02927584862) | [0xd571730a...](https://explore.testnet.tempo.xyz/tx/0xd571730aec8a9dbc7bda6d9087f90948315a1638618b6ee8f0d9f8c9be491a65) |
| 3 (warm) | [0xabacd190...](https://explore.testnet.tempo.xyz/tx/0xabacd190027580bf31d8c2c998e87e1901bee1762e4f4e0586f799977a5d7caa) | [0xc63d0beb...](https://explore.testnet.tempo.xyz/tx/0xc63d0beb8e45baccf222a178c0f9d8d96420899fc03b033abc7e2e626b9bfb41) |
| 4 (warm) | [0x392eabf8...](https://explore.testnet.tempo.xyz/tx/0x392eabf898acd9ee6bdb3639c728c2b8619d1b4163fed65b9324960faf129e71) | [0x65d981bf...](https://explore.testnet.tempo.xyz/tx/0x65d981bffe2f7c26fb44e8609f72773aa4ba8157a60f2b85978f9fec7f434a02) |

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
- **Latency.** About 7 to 11 seconds per purchase end to end (see Timings), almost all of it two relay submissions and their confirmations. The first version took about 70 seconds per paid request because both sides rebuilt the pool's tree from the public RPC every time; both now keep it. Creating the sandbox can start while the payment settles, as long as it is handed over only after the receipt.
- **Charges only.** `gloam` implements the MPP `charge` intent. Sessions stay on `tempo`.

From us: the Tempo mainnet pool and relay are live, `@gloamtrade/mppx-gloam` is on npm, and we can run this against E2B's staging with a real `E2B_API_KEY`.
