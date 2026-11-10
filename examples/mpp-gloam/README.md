# mpp-gloam

A paid API over the [Machine Payments Protocol](https://mpp.dev), charged per request with the private `gloam` method, and an agent that pays it. Built on `mppx` and `@gloamtrade/mppx-gloam`.

```bash
pnpm --filter gloam-mpp-example start                   # stub proofs, a few seconds
pnpm --filter gloam-mpp-example start -- --real-proofs  # real Groth16 transfer proofs, each verified
```

Runs against a mock pool in memory that applies the Gloam pool's transfer rules (known root, nullifier spent once, fresh commitments, a `Transferred` log). Nothing is broadcast and no money moves, on any network.

## Which network's terms

`GLOAM_NETWORK` picks the network the charge names: its chain id, its official Gloam pool and its stablecoin.

| `GLOAM_NETWORK` | Charge terms |
|---|---|
| `tempo-mainnet` | Tempo mainnet (4217), priced in USDC.e |
| `robinhood-mainnet` | Robinhood Chain mainnet (4663), priced in USDG |
| `base-mainnet` | Base mainnet (8453), priced in USDC |
| `ethereum-mainnet` | Ethereum mainnet (1), priced in USDC |
| `elysium-mainnet` | Elysium mainnet (99901), priced in USDC |
| `tempo` (default) | Tempo testnet (42431), priced in PathUSD |
| `robinhood` | Robinhood Chain testnet (46630), priced in test USDG |

```bash
GLOAM_NETWORK=tempo-mainnet pnpm --filter gloam-mpp-example start
```

The chain id, pool and stablecoin come from the SDK's network list (`getGloamNetwork`, over `gloamNetworks()`). If your SDK version has no pool for the mainnet you picked, the demo stops with a message: update `@gloamtrade/sdk` once the pool is published. `--real-proofs` uses the transfer key set that network verifies: the final keys from the 13-contributor trusted setup (`app/public/circuits/final/`, checked against `final/transfer_vkey.json`) on a mainnet, the dev keys (checked against `contracts/circuits/build/transfer_v2/transfer_vkey.json`, a local build output) on a testnet. The zkey is checked against `CIRCUIT_SHA256` first.

## What happens

1. `GET /answer` with no payment: `402` with `WWW-Authenticate: Payment method="gloam", intent="charge"`, priced at 0.01 of the network's stablecoin, payable to the seller's receive tag, through that network's official pool.
2. The agent pays in **push** mode: it checks the price against its policy, proves a private send of exactly 0.01 from its shielded balance, seals the payment note to the seller, broadcasts the transfer, and retries with `Authorization: Payment …`. The seller checks the payment and the `Transferred` event, sweeps it into a fresh note, and only then serves. `200` with a `Payment-Receipt`.
3. The agent pays in **pull** mode: it broadcasts nothing. The seller submits the agent's proven transfer, then sweeps.
4. The same credential again: `402 verification-failed`, already used.
5. The public feed: four `Transferred` events, a nullifier and two commitments each. No amounts, no tags.

## Files

| File | Role |
|---|---|
| `server.ts` | The seller: Hono + `mppx/hono` with `gloam()` from `@gloamtrade/mppx-gloam/server`, and a tiny `node:http` adapter |
| `client.ts` | The buyer: `mppx/client` with `gloam()` from `@gloamtrade/mppx-gloam/client`, and a minimal note wallet |
| `mock-pool.ts` | The mock chain |
| `demo.ts` | Wires them together over real HTTP on localhost |

## Going live on mainnet

On mainnet, deposits are capped (50,000 per deposit and 2,500,000 in total for each stablecoin), private payments and cash outs are not. MPP payments are private sends, so Gloam takes no fee on them; a cash out costs 0.5% (`cashOutFee(amount)`). The mainnet pools take payments only, with no private trading.

Swap the mock for the chain, using the network object for every value:

```ts
import { mainnetNetwork, circuitArtifactUrls, TEMPO_USDCE } from "@gloamtrade/sdk";

const net = mainnetNetwork("tempo");                 // null until this SDK version has the pool
if (!net) throw new Error("No Tempo mainnet pool in this SDK version yet.");
const publicClient = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl) });

gloam({
  network: net.chainId,
  currency: TEMPO_USDCE,
  decimals: 6,
  chain: gloamChargeChainFromClient(publicClient, { pool: net.pool, fromBlock: net.deployBlock }),
  // ...receiveKey, prove, submit
});
```

- Prove with the final keys: `circuitArtifactUrls("transfer", net.chainId)` gives their URLs (under `/circuits/final/`). In node, download them first and check them against `CIRCUIT_SHA256`, since snarkjs proves from local files there.
- Submit with a wallet or the Gloam relay (`relayIntent`), and use `syncTree(publicClient, { pool: net.pool, fromBlock: net.deployBlock })` for the agent's note paths.
- Keep the seller's receive key and fresh notes server side, set `MPP_SECRET_KEY`, and serve over TLS.

## Practice on testnet

Run the same setup against `GLOAM_NETWORKS.tempo` (Tempo testnet, test PathUSD) or `GLOAM_NETWORKS.robinhood` (Robinhood Chain testnet, test USDG) first. The testnets use the dev keys, which `circuitArtifactUrls` picks from the chain id. For Robinhood Chain testnet, get test ETH from the [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com/) and test USDG from the [Paxos faucet](https://faucet.paxos.com/).
