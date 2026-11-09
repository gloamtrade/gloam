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
| `demo-output.txt` | The full transcript of a real run on Tempo testnet (two purchases). |
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

## What the real run showed

From `demo-output.txt`:

- The 402 offers `tempo/charge` to wallet `0xb10A...1460` (public) and `gloam/charge` to a receive tag (private), both at E2B's price for a 300 second `base` sandbox, 0.008721.
- The agent pays in pull mode: it proves the payment and broadcasts nothing. The server submits it through the Gloam relay, sweeps it into a note only the server knows, and then creates the sandbox. `201`, `Payment-Receipt method=gloam status=success`.
- On chain, both transactions are `transfer(proof, root, nullifier, newCommitments)` sent by the relay to the pool. The agent's wallet appears in neither, no token transfer of the price happens, and E2B has no address at all. The only token movement is the relay's gas fee.

| Purchase | Payment tx | Sweep tx |
| --- | --- | --- |
| 1 | [0x95f122d4...](https://explore.testnet.tempo.xyz/tx/0x95f122d4c1edf756a230c3a11ff4503810947b1dabf5c3d3ed72f16f9f2603ef) | [0xaef4151b...](https://explore.testnet.tempo.xyz/tx/0xaef4151b328395f526d142cbba347d9887290f3a34c50bfa54bd44f92c90e6bc) |
| 2 | [0x2f400aed...](https://explore.testnet.tempo.xyz/tx/0x2f400aedac0c71c936727085ce2e667206a0505bb5e92eda4a34a288cba48c78) | [0x7347f25e...](https://explore.testnet.tempo.xyz/tx/0x7347f25ee62d55779526fa746b1f2382a55a08f681eee39011eb56e6c3fba08f) |

The one public step is the agent's deposit into the pool ([0xa7c9dfdf...](https://explore.testnet.tempo.xyz/tx/0xa7c9dfdfac090fa04ba8e53a6830e7fa07849eeaf9c1c4982b5810de9aad3776)). It shows that address put 1 PathUSD into Gloam, not what it bought or from whom.

## The code E2B adds

`npm i @gloamtrade/mppx-gloam @gloamtrade/sdk`, then one entry in the methods array. The `tempo` method stays as it is.

```ts
import { Mppx, tempo } from "mppx/server";
import { gloam } from "@gloamtrade/mppx-gloam/server";
import { gloamChargeChainFromClient } from "@gloamtrade/mppx-gloam/core";
import { artifactProver, mainnetNetwork, relayIntent } from "@gloamtrade/sdk";

const net = mainnetNetwork("tempo")!; // Tempo mainnet (4217), the Gloam pool and its deploy block

const mppx = Mppx.create({
  secretKey,
  methods: [
    tempo.charge({ currency: USDC_E, recipient: E2B_WALLET }),          // unchanged
    gloam({
      network: "tempo-mainnet",                                        // USDC.e by default
      receiveKey,                                                      // generateReceiveKey(), once, kept server side
      chain: gloamChargeChainFromClient(publicClient, { pool: net.pool, fromBlock: net.deployBlock }),
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
- **Latency.** This demo took about 70 seconds per purchase, almost all of it two cold rebuilds of the pool's Merkle tree from the public testnet RPC (the agent's and the server's). With a cached tree or an indexer that drops to a few seconds of proving plus two block confirmations.
- **Charges only.** `gloam` implements the MPP `charge` intent. Sessions stay on `tempo`.

From us: the Tempo mainnet pool and relay are live, `@gloamtrade/mppx-gloam` is on npm, and we can run this against E2B's staging with a real `E2B_API_KEY`.
