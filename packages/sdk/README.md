# @gloamtrade/sdk

**Private stablecoin payments for apps and agents on Robinhood Chain, Tempo, Base and Ethereum, as a package.**

Add shielded balances, private payments, and selective disclosure to any app or agent on Robinhood Chain, Tempo, Base, Ethereum or Elysium. Live on all five mainnets, on the trusted setup's final keys (Elysium from 0.7.0). Real zero-knowledge proofs, no proving stack to build from scratch.

[![npm version](https://img.shields.io/npm/v/@gloamtrade/sdk?color=0B0C0E&label=npm)](https://www.npmjs.com/package/@gloamtrade/sdk)
[![license](https://img.shields.io/npm/l/@gloamtrade/sdk?color=0B0C0E)](https://github.com/gloamtrade/gloam/blob/main/packages/sdk/LICENSE)
[![types](https://img.shields.io/npm/types/@gloamtrade/sdk?color=0B0C0E)](https://www.npmjs.com/package/@gloamtrade/sdk)
[![Networks](https://img.shields.io/badge/mainnet-Robinhood%20Chain%204663%20%C2%B7%20Tempo%204217%20%C2%B7%20Base%208453%20%C2%B7%20Ethereum%201-2E7D53)](https://gloam.trade/docs/chain)

![The Gloam SDK](https://raw.githubusercontent.com/gloamtrade/gloam/main/app/public/media/readme-hero.jpg)

---

## Table of contents

- [Why Gloam](#why-gloam)
- [What you can build](#what-you-can-build)
- [Install](#install)
- [Networks: mainnet and testnet](#networks-mainnet-and-testnet)
- [Quickstart: shield your first note](#quickstart-shield-your-first-note)
- [How it works](#how-it-works)
- [The intent model](#the-intent-model)
- [Cash out (unshield)](#cash-out-unshield)
- [Private payments (transfer)](#private-payments-transfer)
- [Private swaps](#private-swaps)
- [Selective disclosure](#selective-disclosure)
- [Private agents](#private-agents)
- [Private agent payments (x402)](#private-agent-payments-x402)
- [Take payments and read their notes](#take-payments-and-read-their-notes)
- [Commerce with commitments](#commerce-with-commitments)
- [API reference](#api-reference)
- [Framework integration](#framework-integration)
- [Examples](#examples)
- [Pinned public inputs](#pinned-public-inputs)
- [Guardrails and honesty](#guardrails-and-honesty)
- [Links](#links)

---

## Why Gloam

Public chains are public ledgers. Every balance and every payment is visible on-chain and copyable by anyone. For a business that means payroll and suppliers are exposed. For an agent it means the entire strategy leaks on the first payment.

Gloam is the shielded layer on top of Robinhood Chain, Tempo, Base and Ethereum, and `@gloamtrade/sdk` is that layer as a dependency. Deposit into a private balance, move value with the amount hidden, and prove a holding to one chosen party without revealing anything else. Every private action is backed by a real Groth16 proof verified on-chain. Nothing is a mock. If a path cannot be made private, it stays disabled rather than pretending.

The Gloam vault app is the reference implementation, not a special case. The same core that powers it is what you install here.

## What you can build

- **Shielded balances.** Deposit stablecoins (USDG on Robinhood Chain; USDC.e, pathUSD, USDT0 or OUSD on Tempo; USDC, EURC or USDT on Base; USDC, USDT, USDG, PYUSD or EURC on Ethereum; USDC on Elysium), ETH, or $GLOAM into a private balance only the holder can see or spend.
- **Private payments.** Send inside the vault to a receive tag, with on-chain encrypted discovery through the payment-message board on every network, mainnet included. No public transfer, no visible amount.
- **Cash out.** Unshield back to a public balance with a browser- or node-generated Groth16 proof.
- **Selective disclosure.** Let a holder prove one balance to a chosen party, an auditor or a counterparty, revealing nothing else. Provable, not a dark pool.
- **Private agents.** The same core runs server-side, so an autonomous agent can hold and move value under policy with its size and strategy hidden.
- **Private agent payments (x402).** Agents pay for tools and data over HTTP 402 and settle privately, so the amount, sender, and recipient never go public.

## Install

```bash
npm install @gloamtrade/sdk viem
npm install snarkjs   # optional peer, needed only when you generate proofs
```

`viem` handles signing and RPC. `snarkjs` is a lazy peer, imported dynamically only inside the prover, so it is required only for paths that generate a proof (shield, unshield, transfer, disclosure).

Prefer to start from a working app instead of wiring it yourself:

```bash
npm create gloam-app@latest my-private-app
```

That scaffolds a Next.js app already wired to the SDK. See [create-gloam-app](https://www.npmjs.com/package/create-gloam-app).

## Networks: mainnet and testnet

Gloam runs on five chains, each with a mainnet and, all but Elysium, a testnet. They are separate pools of the same design, not a bridge. Robinhood Chain and Tempo mainnet are live since 21 October 2026, Base and Ethereum mainnet since 26 October 2026 (from 0.4.1), Elysium mainnet since 9 November 2026 (from 0.7.0, [Elysium](#elysium)).

| Network | Key | Chain id | Pool | Assets (deposit limit per deposit / total) | Keys |
| --- | --- | --- | --- | --- | --- |
| Robinhood Chain | `robinhood-mainnet` | `4663` | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` (block `94194599`) | USDG (50,000 / 2,500,000), $GLOAM (2,500,000 / 25,000,000), PONS (390,000 / 9,800,000), CASHCAT (960,000 / 24,000,000), ETH (11 / 110), AI (400,000 / 4,000,000), ORBIO (1,000,000 / 10,000,000); GRIFT (no limit) once its timelocked change lands | Final |
| Tempo | `tempo-mainnet` | `4217` | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` (block `45172561`) | USDC.e, pathUSD, USDT0, OUSD (50,000 / 2,500,000 each) | Final |
| Base | `base-mainnet` | `8453` | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` (block `53109632`) | USDC, EURC, USDT (50,000 / 2,500,000 each), ETH (20 / 1,000), BDX (no limit once its timelocked change lands) | Final |
| Ethereum | `ethereum-mainnet` | `1` | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` (block `26276183`) | USDC, USDT, USDG, PYUSD, EURC (50,000 / 2,500,000 each), ETH (20 / 1,000), BDX (no limit once its timelocked change lands) | Final |
| Elysium | `elysium-mainnet` | `99901` | `0x89d3042390204f57b8b4F8949D3c2203E4002164` (block `3248495`) | USDC (500 / 25,000) | Final |
| Robinhood Chain testnet | `robinhood` | `46630` | `0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740` | Test ETH, test USDG, stock tokens | Dev |
| Tempo testnet (Moderato) | `tempo` | `42431` | `0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb` | PathUSD and other test stablecoins | Dev |

```ts
import { mainnetNetwork, gloamNetworks, getGloamNetwork, GLOAM_NETWORKS } from "@gloamtrade/sdk";

const tempo = mainnetNetwork("tempo");        // Tempo mainnet, or null if this SDK version has no pool for it
const all = gloamNetworks();                  // mainnets first, then the testnets
const rh = getGloamNetwork("robinhood-mainnet");
const practice = GLOAM_NETWORKS.tempo;        // the testnets, unchanged since 0.0.x
```

Each `GloamNetwork` carries `chainId`, `pool`, `deployBlock`, a viem `chain`, `rpcUrl`, `explorerUrl`, `assets` (with `depositLimit`), `testnet`, and `ceremony`.

What is different on mainnet:

- **Final keys.** The mainnet verifiers hold the final keys of the 13-contributor trusted setup (drand round 6561386, release `ceremony-final`). The testnets keep the single-party dev keys. A proof made with one set never verifies against the other, so prove with `circuitArtifactUrls(circuit, chainId)`, which picks the right set for the chain.
- **Payments only.** The mainnet pools (`ShieldPoolPayments`) take deposits, private payments and cash outs, and have no swap code. Private swaps go through a separate router, on the mainnets listed in the [docs](https://gloam.trade/docs/private-swaps); from 0.5.0 this SDK builds them too ([Private swaps](#private-swaps)). On Robinhood Chain mainnet, stock tokens go in and out of the private balance through those swaps; this SDK does not list them as deposit assets.
- **Deposit limits.** 50,000 per deposit and 2,500,000 in total for each stablecoin, 20 and 1,000 for ETH on Base and Ethereum, 2,500,000 and 25,000,000 for $GLOAM, 500 and 25,000 for USDC on Elysium. On Robinhood Chain, ETH (11 per deposit, 110 in total), AI (400,000 and 4,000,000) and ORBIO (1,000,000 and 10,000,000) opened on 3 November 2026. From 0.4.2 the SDK reads the limits live from the vault (`readDepositLimit`, `assertDepositWithinLiveLimit`); the `depositLimit` on each asset holds the limit read on chain on 2 November 2026. Pass `client` (a viem public client on that chain) to `buildShieldBoundIntent` and it refuses an amount over the vault's live per-deposit limit, or over the room left under its total, before it proves. If the vault can't be read, nothing is refused: the vault enforces its own limits. An unlisted asset is refused either way. Cash outs and private payments are never limited.
- **Fees.** Deposits and private payments are free. A cash out costs 0.5% (0.25% until 3 November 2026): the pool keeps `cashOutFee(amount, bps)` and sends the rest. The owner can change the fee through the vault's timelock, so from 0.5.0 `readCashOutFeeBps(client, pool)` reads it live; the swap planner always does, and `buildUnshieldIntent` does when you pass `client`.
- **Pools come with the SDK version.** Mainnet pool addresses live in `MAINNET_POOLS`. If your SDK version has no pool for a mainnet, `mainnetNetwork()` returns `null` and the builders refuse that chain id rather than guess. Update the SDK, or pass `poolAddress` yourself.

The builders still default to Robinhood Chain testnet when you pass no `chainId`, so code written for 0.0.x keeps working. For mainnet, pass the network explicitly, as below. The vault has the same address on every mainnet, so it can't say which chain you mean: from 0.4.4 a builder given a mainnet vault as `poolAddress` and no `chainId` throws and asks for it, before it proves.

### Base

Base is the third chain. Base mainnet is live since 26 October 2026: from 0.4.1, `mainnetNetwork("base")` returns its vault (`0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194`, deploy block `53109632`). Base Sepolia, the testnet, is in 0.3.0: `testnetNetwork("base")` returns its vault (`0x39e28cde55cab798874746ac52cb4b5cc99a0194`, deploy block `49802958`) and its payment-message board, and it runs the mainnet pool and final keys.

| Network | Key | Chain id | Assets (deposit limit per deposit / total) | Keys |
| --- | --- | --- | --- | --- |
| Base | `base-mainnet` | `8453` | USDC, EURC, USDT (50,000 / 2,500,000 each), ETH (20 / 1,000), BDX (no limit once its timelocked change lands) | Final |
| Base testnet (Sepolia) | `base` | `84532` | Test USDC and EURC from Circle's faucet (500 / 25,000 each), test ETH (0.2 / 10) | Final |

Base Sepolia is a testnet, but it runs the mainnet pool (`ShieldPoolPayments`) on the final keys, with the same listed assets as Base mainnet, its own deposit limits and a 0.25% cash-out fee (Base mainnet's is 0.5%), so a test there runs the same code as Base mainnet. Both Base pools take native ETH, and both have a payment-message board (`payMemoBoardFor(8453)`, `payMemoBoardFor(84532)`). The bridge (through Relay) brings USDC into Base mainnet since 26 October 2026; private swaps on Base come later.

### Ethereum

Ethereum mainnet is the fourth chain, live since 26 October 2026: from 0.4.1, `mainnetNetwork("ethereum")` returns its vault (`0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194`, deploy block `26276183`) and its payment-message board (`payMemoBoardFor(1)`). Its testnet is Ethereum Sepolia (below), `testnetNetwork("ethereum")`.

| Network | Key | Chain id | Assets (deposit limit per deposit / total) | Keys |
| --- | --- | --- | --- | --- |
| Ethereum | `ethereum-mainnet` | `1` | USDC, USDT, USDG, PYUSD, EURC (50,000 / 2,500,000 each), ETH (20 / 1,000), BDX (no limit once its timelocked change lands) | Final |

- **USDT approvals.** Tether's `approve()` refuses to change one non-zero allowance into another. Before a USDT deposit, ask `approvalSteps(chainId, token, allowance, amount)`: it returns the exact `approve(pool, value)` calls to send in order (`[0, amount]` when a stale allowance is in the way, `[]` when the allowance already covers it).
- **EURC is a euro stablecoin.** Never count it as a dollar.
- **Gas.** A private send costs about 1.9M gas and a cash out about 0.5M to 0.7M. On Ethereum that adds up, so the Gloam relay stops relaying while gas is above its ceiling (3 gwei by default) and says so; you can still submit yourself.
- **RPC.** `ETHEREUM_MAINNET_CHAIN` reads through MEV Blocker (`rpc.mevblocker.io`), which keeps old state and serves `eth_getLogs` over 10,000-block ranges. Use your own RPC for heavy reads.
- The bridge (through Relay) brings USDC into Ethereum, as into Base. Private swaps there follow the next router: see the [docs](https://gloam.trade/docs/private-swaps).
### Ethereum Sepolia

| Network | Key | Chain id | Assets (deposit limit per deposit / total) | Keys |
| --- | --- | --- | --- | --- |
| Ethereum Sepolia | `ethereum` | `11155111` | Test USDC and EURC (Circle), test USDG and PYUSD (Paxos), 500 / 25,000 each; ETH (0.2 / 10) | Final |

- **RPC.** `ETHEREUM_SEPOLIA_CHAIN` reads through publicnode, which is at the chain head but keeps only about the last 10,000 blocks of logs, receipts and state. Older reads go to Tenderly's public gateway (`ETHEREUM_SEPOLIA_HISTORY_RPC`, the network's `historyRpc`), which keeps everything but can trail the head by a minute or two. `gloamReadTransport(network)` splits reads that way for you: build the public client you sync the tree and wait for receipts with on it.

0.4.0 knows Ethereum Sepolia, a testnet on the mainnet pool and final keys like Base Sepolia, live since 25 October 2026: `testnetNetwork("ethereum")` returns its vault (`0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef`, deploy block `11992914`) and its payment-message board. Its proofs always use the final keys (`ceremonyForChainId(11155111)`).

### Elysium

Elysium mainnet is live since 9 November 2026. Elysium is Kinetiq's Hyperliquid L2, an Arbitrum Orbit chain with HYPE as its gas coin. The SDK knows it as `elysium-mainnet` (chain id `99901`), with its values in one file, `src/elysium.ts` (`ELYSIUM_MAINNET`, `elysiumMainnetConfig()`). They are in from 0.7.0; 0.6.0 and older return `null` for `mainnetNetwork("elysium")` and refuse its chain id.

- The vault is `ShieldPoolPayments` on the final keys, at its own address (`0x89d3042390204f57b8b4F8949D3c2203E4002164`, deploy block `3248495`), owned from its deploy by a `VaultOwnerGuard`. USDC only (500 per deposit, 25,000 in total), the 0.5% cash-out fee. Gas is paid in HYPE; HYPE itself is not listed as a deposit. There is no payment-message board there yet (`payMemo` is `null`).
- Elysium testnet (`99801`, key `elysium`, `testnetNetwork("elysium")`, test USDC, final keys) stays `null` until its pool is in `ELYSIUM_TESTNET`.
- Not on Elysium yet: private swaps (`planVaultSwap` refuses with "Private swaps are not on Elysium yet").
- Short links: Elysium mainnet's USDC is id 45 in `SHORT_LINK_WHERE`; id 46 stays reserved for its testnet until that pool is in.
- Keys: `src/elysium.ts` ships in the npm package, so `elysiumMainnetConfig()` and `elysiumTestnetConfig()` refuse an RPC URL with an API key in it; `redactRpcUrl(url)` hides a key for display. Keyed RPCs for Elysium go in your own env.

## Quickstart: shield your first note

The pool enforces a proof at deposit, so `buildShieldBoundIntent` mints the note **and** generates the shield proof. You approve the token and sign the resolved call. The `note.secret` it returns is the only spend authority, so persist it.

```ts
import {
  mainnetNetwork,
  buildShieldBoundIntent,
  artifactProver,
  circuitArtifactUrls,
  TEMPO_USDCE,
  gloamReadTransport,
} from "@gloamtrade/sdk";
import { createWalletClient, createPublicClient, http, erc20Abi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const net = mainnetNetwork("tempo");          // Tempo mainnet
if (!net) throw new Error("This SDK version has no Tempo mainnet pool yet.");

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const wallet = createWalletClient({ account, chain: net.chain, transport: http(net.rpcUrl) });
// Reads at the chain head, and old logs from a full-history RPC where the network names one (net.historyRpc).
const publicClient = createPublicClient({ chain: net.chain, transport: gloamReadTransport(net) });
const amount = parseUnits("25", 6);           // 25 USDC.e, within the vault's deposit limit (read live below)

// 1. Mint the note and generate the shield proof with the mainnet (final) keys.
const intent = await buildShieldBoundIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  asset: TEMPO_USDCE,
  amountWei: amount,
  prover: artifactProver(circuitArtifactUrls("shield", net.chainId)),
  client: publicClient, // checks the vault's live deposit limits before proving
});

// 2. Let the pool pull the token, then sign the resolved shieldBound(asset, amount, commitment, proof) call.
await publicClient.waitForTransactionReceipt({
  hash: await wallet.writeContract({ address: TEMPO_USDCE, abi: erc20Abi, functionName: "approve", args: [net.pool, amount] }),
});
const hash = await wallet.writeContract({
  address: intent.exec.poolAddress,
  abi: shieldBoundAbi,
  functionName: intent.exec.fn,   // "shieldBound"
  args: intent.exec.args,
  value: intent.exec.valueWei,    // 0n for tokens
});

// 3. PERSIST THIS. Losing note.secret loses the funds.
saveSecret(intent.note.commitment, intent.note.secret);
```

On Robinhood Chain mainnet use `mainnetNetwork("robinhood")` with `RH_MAINNET_USDG` (or `GLOAM_TOKEN`, `RH_MAINNET_PONS`, `RH_MAINNET_CASHCAT`, `RH_MAINNET_AI`, `RH_MAINNET_ORBIO`, or `NATIVE_ASSET` for ETH). Gas is ETH on Robinhood Chain and a USD stablecoin on Tempo.

To practice for free first, use a testnet: `GLOAM_NETWORKS.tempo` (test PathUSD from the Tempo faucet) or `GLOAM_NETWORKS.robinhood` (test ETH and test USDG). The same code works with that network's `chainId`, `pool` and assets, and `circuitArtifactUrls` picks the dev keys.

The minimal ABI fragment for the one call you make:

```ts
const shieldBoundAbi = [{
  type: "function", name: "shieldBound", stateMutability: "payable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "commitment", type: "bytes32" },
    { name: "proof", type: "bytes" },
  ],
  outputs: [],
}] as const;
```

Circuit files are served at [www.gloam.trade/circuits](https://www.gloam.trade/circuits): the dev keys at the root, the final keys under `/circuits/final`. `circuitArtifactUrls` returns the right URLs; in the browser pass them straight to `artifactProver`. In node, snarkjs proves from local files, so download them first and check them against `CIRCUIT_SHA256`. The full walkthrough, including confirming the deposit and cashing out, is in the [quickstart](https://gloam.trade/docs/quickstart).

## How it works

A private balance is a **note**:

```
commitment = Poseidon(secret, amount, asset)
nullifier  = Poseidon(secret, commitment)
```

Shielding inserts the `commitment` as a leaf in a depth-20 incremental Merkle tree. The `secret` is the only spend authority and never leaves the client. Spending (send, cash out, trade) proves in zero knowledge that you know the secret for a commitment in the tree, and publishes the `nullifier` so it cannot be spent twice, all without revealing which note. The chain verifies a Groth16 proof, never your identity or size.

The note commitment binds the asset, so one pool holds several assets (stablecoins, $GLOAM, and on testnet ETH and stock tokens) without mixing them up.

## The intent model

Every action is an **intent** with two layers. The **plan** is portable and safe to log or hand to an agent (symbol, amount, no secrets). The **exec** resolves the on-chain call (wei amounts, resolved addresses, proof args). The SDK and the agent server share one intent shape, so a plan an app builds and a plan an agent builds are the same object.

```ts
interface GloamIntent<K> {
  intent: K;                  // "shield" | "unshield" | "private_send" | "private_trade"
  chainId: number;
  agentAddress: Address | null;
  plan: PlanFor<K>;           // portable: symbol, amount, no secrets
  privacy: string;            // plain-language: what is and is not hidden
  execution: string;          // plain-language: how to sign and broadcast
  exec: IntentExec;           // the resolved on-chain call
}

interface IntentExec {
  poolAddress: Address;
  fn: PoolFn;                 // e.g. "shieldBound", "unshield", "transfer"
  valueWei: bigint;           // ETH to attach (native shield only)
  args: readonly unknown[];   // ABI-ordered call args
}
```

You always sign and broadcast yourself. The SDK never holds a key.

## Cash out (unshield)

A spend needs a membership path, which needs the current tree. `syncTree` rebuilds it from chain (replaying `Shielded`, `Transferred`, and `SealedSwapped` leaves in order, so the root stays correct after any transfer). Then `buildUnshieldIntent` builds the witness and the proof. On exit, the amount, asset, and recipient become public. The source note stays unlinkable via the nullifier.

On mainnet the pool keeps a 0.5% cash-out fee: cashing out `amount` sends `amount - cashOutFee(amount)` to `to`. The note is spent in full either way. The pool takes the fee when the cash out lands, at its rate that day, and the proof doesn't fix it, so a proof held back pays whatever the rate is then. For the rate now, `readCashOutFeeBps(client, pool)`, then `cashOutFee(amount, bps)`.

From 0.4.3 `buildUnshieldIntent` refuses an address where the money would be lost, before it proves: the vault, the network's payment-message board, a token contract, a Gloam swap router and the zero address. The Gloam relay refuses the same ones, and this covers a cash out you send from your own wallet too. Each list is for that chain only, so an address that is a router on one chain is an ordinary recipient on another. To check an address before anything else happens (a split, say), call `cashOutTargetProblem(to, network)`: it returns the reason, or null.

```ts
import { buildUnshieldIntent, artifactProver, circuitArtifactUrls, syncTree, cashOutFee } from "@gloamtrade/sdk";

const synced = await syncTree(publicClient, { pool: net.pool, fromBlock: net.deployBlock });
const path = await synced.pathForCommitment(note.commitment);
if (!path) throw new Error("note not found in the tree yet");

const exit = await buildUnshieldIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  secretHex: note.secret,
  amountWei: note.amountWei,      // the whole note
  asset: note.asset,
  to: account.address,
  path,
  prove: artifactProver(circuitArtifactUrls("unshield", net.chainId)),
});
// `to` receives note.amountWei - cashOutFee(note.amountWei) on mainnet.

await wallet.writeContract({
  address: exit.exec.poolAddress,
  abi: unshieldAbi,
  functionName: exit.exec.fn,     // "unshield"
  args: exit.exec.args,
});
```

## Private payments (transfer)

`buildPrivateSendIntent` spends a note and produces two new notes: a payment note for the recipient and a change note for the sender. There is no public transfer and no visible amount.

```ts
import { buildPrivateSendIntent, artifactProver, circuitArtifactUrls, syncTree } from "@gloamtrade/sdk";

const synced = await syncTree(publicClient, { pool: net.pool, fromBlock: net.deployBlock });
const path = await synced.pathForCommitment(note.commitment);

const send = await buildPrivateSendIntent({
  chainId: net.chainId,
  poolAddress: net.pool,
  secretHex: note.secret,
  amountInWei: note.amountWei,       // the source note's amount
  amountPayWei: parseUnits("10", 6), // amount to send; the rest is your change
  asset: note.asset,
  path,
  prove: artifactProver(circuitArtifactUrls("transfer", net.chainId)),
});

await wallet.writeContract({
  address: send.exec.poolAddress,
  abi: transferAbi,
  functionName: send.exec.fn,       // "transfer"
  args: send.exec.args,
});

// Hand send.paymentNote to the recipient; keep send.changeNote.
```

Private payments are free and have no limit. Every network, mainnet included, has an encrypted payment board (`GloamPayMemo`), so a recipient finds a payment with their Gloam address; see [Take payments and read their notes](#take-payments-and-read-their-notes).

## Private swaps

From 0.5.0 the SDK quotes, builds and finishes private swaps, with the same planning as the Gloam app (routers, pools, routes, buffers and quote stops; a parity test holds the two together). A swap takes one note out of the vault through a one-time escrow, trades it on a public DEX, and puts the new note back in, in one transaction the Gloam relay sends. **It hides who swapped. The tokens and the amounts are public**, like any trade on that DEX.

Where it runs: Robinhood Chain (router v2) and Tempo today. Base and Ethereum get the next router (GloamVaultSwapV4c); until its address is switched on for a chain, `quoteSwap` and `buildSwapIntent` refuse that chain with `no_swap`. `swapChainIds()` lists the chains where a swap can be made now. Private swaps are not on Elysium yet.

```ts
import {
  quoteSwap, buildSwapIntent, sendSwap, relaySwapCall, relayStatus, swapJson,
  syncTree, artifactProver, circuitArtifactUrls,
} from "@gloamtrade/sdk";

// 1. Quote one whole note. Every stop the app and the relay apply comes back in `stop`.
const relay = (await relayStatus()).find((s) => s.chainId === net.chainId) ?? null;
const quote = await quoteSwap({ client, chainId: net.chainId, assetIn: note.asset, assetOut, amountIn: note.amountWei, relayStatus: relay });
if (quote.stop) throw new Error(quote.stop.message); // e.g. refund_wont_fit (quote.limits.maxIn), over_room, swap_small

// 2. Prove it: the note's unshield to the swap's escrow, the new note and a refund note.
const synced = await syncTree(client, { pool: net.pool, fromBlock: net.deployBlock });
const intent = await buildSwapIntent({
  client, chainId: net.chainId, quote, assetOut,
  note: { secretHex: note.secret, amountWei: note.amountWei, asset: note.asset },
  path: (await synced.pathForCommitment(note.commitment))!,
  shieldProver: artifactProver(circuitArtifactUrls("shield", net.chainId)),
  unshieldProver: artifactProver(circuitArtifactUrls("unshield", net.chainId)),
  relayStatus: relay,
});

// 3. Store the recovery record, then send. sendSwap won't send until `save` resolved.
const sent = await sendSwap({
  intent, client,
  save: (rec) => db.put(`swap:${rec.spent.nullifier}`, JSON.stringify(swapJson(rec))),
  submit: (call) => relaySwapCall(call),       // or new GloamApiClient({ apiKey }).swapSubmitter()
});
sent.outcome?.state; // "swapped": intent.recovery.out is your new note
```

**Getting money back.** The note's unshield proof stays valid until the note is spent, so anyone could send it on its own; the money then waits at the swap's escrow. The `SwapRecovery` (it holds the secrets of the new note and the refund note) is how you always get it back, so store it before sending and keep it until `readSwapOutcome` says `swapped`, `refunded` or `closed`:

| `readSwapOutcome(client, rec).state` | What to do |
| --- | --- |
| `swapped` | `rec.out` is your new note |
| `refunded` | `rec.refund` is your note again (the input less the vault's fee and a 0.1% margin) |
| `refund_ready` | `buildSwapRefund(rec, { client, shieldProver })`, then send its `relay` call |
| `exit_ready` | the refund note can't take the money (the vault's fee rose): `buildSwapExit(rec, { client, to })` sends it to `to`, in the clear, on routers with an exit |
| `pending` | the swap may still land, until its deadline on routers with one |
| `reverted`, `expired` | the swap can't land; spend the note (a private send to yourself) to end its unshield proof, and keep the record until then |
| `closed` | the note was spent another way, or left by its exit; nothing waits |

The exit key is derived from the refund note's secret (`exitAccount`), the same as the app, so the refund note is all you keep. A swap spends one whole note: to swap part of one, split it first with a private send to yourself (`buildPrivateSendIntent`) and swap the note of the right size.

**What is checked before any proof**, so the relay doesn't refuse a swap you could have known about: a known router and its live pools, the right chain (`wrong_chain`) and vault (`wrong_vault`), the note unspent and its root known, price impact over 2% (`too_thin`, with `fitsIn`) and two dollar stablecoins more than 2% apart (`off_peg`) on every chain, value more than 4% below market when you pass `marks`, the refund note fitting the vault's limit (`refund_wont_fit`, with `maxIn`), the vault taking the output and having room (`vault_closed`, `over_room`), and through the relay: its floor where gas is dear (`swap_small`, Ethereum), and its state when you pass `relayStatus`. The relay wants a minute left before a swap's deadline (`expired`). Refusals are `SwapRefusedError` with a `code`.

The impact, peg and value stops apply on every chain by default. The Gloam app holds Base and Ethereum to them and only warns on Robinhood Chain and Tempo, where a person reads the warning before swapping; code that swaps on its own gets the stop. Set them with `stops: { maxImpactBps, maxPegGapBps, maxValueGapBps }` (basis points; 10000 turns one off, and Base and Ethereum keep the app's 2% and 4% either way).

**Sending from your own wallet** works too: `intent.wallet` is `{ to, data, value }` for the router. It puts that wallet next to the swap on the explorer, so the relay is the default. With a partner key, `GloamApiClient.relaySwap(call)` sends through the partner relay and counts the swap to you (never charged); `swapQuote` and `swapNetworks` are the partner API's read-only quote and router list.

## Selective disclosure

Private by default, provable by choice. A holder proves one shielded balance to a party they choose, revealing nothing about their identity, their other notes, or the note secret (so the disclosure can never move the funds). It reuses the shield circuit, so there is no extra setup, and it verifies in-browser with no wallet. See the [disclosure guide](https://gloam.trade/docs/sdk/disclosure).

## Private agents

The crypto core is pure and isomorphic, so the exact code above runs server-side. An AI agent can shield, pay, and prove holdings with its size and strategy hidden. Two ways in:

- **Directly via `@gloamtrade/sdk`.** Your agent framework builds an intent and signs it with its own wallet.
- **Via the `@gloamtrade/mcp` server** (`npx -y @gloamtrade/mcp`). An MCP-speaking model gets Gloam as tools alongside its other capabilities, with planning and execution kept separate, keys held server-side, and spending limits the agent cannot lift.

See [Build a private agent](https://gloam.trade/docs/agents).

## Private agent payments (x402)

Agents pay for tools and data over HTTP 402. The pattern that won Colosseum (MCPay) paired x402 with stablecoins, but that settlement is fully public: the amount, the payer, and the payee all leak. Gloam's `gloam-private` scheme keeps the settlement private and self-custodial. The agent settles a shielded transfer to the payee itself (no operator or facilitator ever holds its key or funds), then presents the payment note plus the settlement tx on the 402 retry.

Two rules keep the money safe:

- **The payment note is sealed to the payee.** `payTo` must be the payee's receive tag (`gloamr1.…`). `buildGloamPayment` encrypts the payment note to it, so the agent, a proxy or a log that sees the `X-PAYMENT` header cannot open it. A `payTo` that is not a receive tag is refused.
- **The payee sweeps before it serves.** The payer created the payment note, so it knows the secret too and could spend it back after being served. `settleGloamPayment` opens the note, verifies it, and moves it into a fresh note only the payee knows. Grant access only when it returns `grantAccess: true`. A `verifyGloamPayment` on its own always says `final: false`.
- **The payment is bound to its payee (from 0.7.0).** `buildGloamPayment` adds `payload.binding`, an HMAC keyed by the payment note's secret over the chain, pool, receive tag and note. A sealed ticket can also be public (a payment made with the app or `buildPrivatePaymentWithReceipt` posts it on the payment board), and anyone could copy it into an X-PAYMENT header; it has no binding, so `settleGloamPayment` refuses it. A payer older than the binding sends none: pass `allowUnbound: true` to take such payments anyway. `checkGloamPaymentBinding` runs the check on its own.

```ts
import {
  generateReceiveKey,
  buildGloamPaymentRequirements,
  buildGloamPayment,
  settleGloamPayment,
  decodePaymentHeader,
  sweepChainFromClient,
  relaySubmitter,
  transferCallArgs,
  POOL_TRANSFER_ABI,
  artifactProver,
} from "@gloamtrade/sdk";

// Server, once: a receive key. Share the tag; keep privateJwk secret, server-side.
const seller = await generateReceiveKey();

// Server: price a resource. This is the 402 challenge.
const requirements = buildGloamPaymentRequirements({
  amountWei: parseUnits("0.25", 6),
  asset: TEMPO_USDCE,        // a stable asset the pool lists
  assetSymbol: "USDC.e",
  network: net.chainId,      // the pool is resolved from the network (pass poolAddress to override)
  payTo: seller.tag,         // the payment is sealed to this
  resource: "mcp://tool/summarize",
});

// Agent: build the private payment, broadcast it, then present the header.
const pay = await buildGloamPayment({
  requirements,
  senderSecretHex: note.secret,
  senderNoteAmountWei: note.amountWei,
  path,                                  // from syncTree.pathForCommitment
  prove: artifactProver(circuitArtifactUrls("transfer", net.chainId)),
  issuerTag: "issuer:usd",               // optional issuer-scoped compliance disclosure
});
const hash = await wallet.writeContract({
  address: pay.intent.exec.poolAddress, abi: POOL_TRANSFER_ABI, functionName: "transfer", args: transferCallArgs(pay.intent),
}); // agent self-settles
pay.payload.payload.txHash = hash;
// Keep pay.changeNote (the agent's remaining balance). pay.paymentNote never needs to leave this process.

// Server: open, verify and sweep. Serve only when grantAccess is true.
const result = await settleGloamPayment({
  requirements,
  payload: decodePaymentHeader(xPaymentHeader),
  receiveKey: seller,
  prove: artifactProver(circuitArtifactUrls("transfer", net.chainId)),
  chain: sweepChainFromClient(publicClient, { pool: net.pool, fromBlock: net.deployBlock }),
  submit: relaySubmitter(),                                  // or your own wallet
  beforeSubmit: (fresh) => saveNote(fresh),                  // persist before it is sent
});
if (result.grantAccess) serve(); // result.freshNote is the payment, in a note only you know
// Otherwise result.status says why: already_spent (the payer took it back first),
// not_settled (not in the pool yet), rejected, failed or unconfirmed.
```

A `submit` of your own that cannot tell whether its send went out (a timeout, a reply lost after the node took it) should throw an error with `maybeSent: true`, and `hash` when it knows it. The sweep then comes back `unconfirmed` with the fresh note to keep, never `failed`.

The sealed ticket is the same format the Gloam app uses for paying a receive tag (`gloam2t.…`, ECDH P-256 + HKDF-SHA256 + AES-256-GCM over a `gloam1.` note package), so a payment sealed by an agent opens in the app, and a tag made in the app works as `payTo`.

**Upgrading from 0.0.5.** `payTo` must now be a receive tag, in `buildGloamPaymentRequirements` and `buildGloamPayment` (pass `legacyUnsealed: true` to pay an old server anyway; the note then travels in plain text, readable by anyone who sees the header). A sealed payment must be opened before `verifyGloamPayment` can read it (`openGloamPaymentNote`, then pass `note`); `settleGloamPayment` does all of this and the sweep.

### Private payer, public payee (gloam-cashout)

New in 0.6.0. Some x402 gateways pay out to a public address (a creator's splitter) in USDG on Robinhood Chain. Scheme `gloam-cashout` lets the paying agent stay private there: it cashes out of its private balance straight to the gateway's `payTo`. The chain shows USDG leaving the Gloam vault to `payTo`. It does not show the agent's wallet (the relay sends it) or which deposit funded it.

- **The 402** lists `{ scheme: "gloam-cashout", network: "eip155:4663", asset: USDG, payTo, amount: G, quoteId }` in `accepts`. G is gross: `ceil(price * 10000 / (10000 - bps)) + tag`, with `bps` the vault's live `withdrawFeeBps()` and a tag of 1 to 9999 unique per quote. The vault keeps `floor(G * bps / 10000)`; `payTo` gets the rest, at least the price.
- **The agent** cashes out exactly G to `payTo` and retries with `X-PAYMENT` = base64 JSON `{ scheme, txHash, quoteId }`. `maxAmount` is required.
- **The gateway** runs `verifyGloamCashout` and keeps its own store of used tx hashes.

```ts
import { findGloamCashoutRequirement, payGloamCashout, quoteGross, buildGloamCashoutRequirement, verifyGloamCashout } from "@gloamtrade/sdk";

// Agent: a note of exactly G (split a larger one first, or use GloamAgent.payX402Cashout, which does).
const req = findGloamCashoutRequirement(res.headers, await res.text());
const paid = await payGloamCashout({ requirement: req!, maxAmount: 1_010_000n, note: { secretHex, amountWei: G, path }, prove: unshieldProver, client });
await fetch(url, { headers: { "X-PAYMENT": paid.header } });

// Gateway: quote, then check the payment.
const q = await quoteGross(price, tag);                                   // reads withdrawFeeBps live
const entry = buildGloamCashoutRequirement({ payTo: splitter, gross: q.gross, quoteId });
const v = await verifyGloamCashout({ txHash, quote: { payTo: splitter, gross: q.gross, price, issuedAt, windowSec: 300 } });
if (v.ok && markUsed(txHash)) serve();                                     // the txHash store is yours
```

With both `gloam-private` and `gloam-cashout` offered, `chooseGloamX402Scheme` keeps `gloam-private` unless the caller prefers `gloam-cashout`; with only `gloam-cashout` (alone or next to `exact`), it picks `gloam-cashout`. `gloamCashoutProblem` refuses a wrong network, asset or vault, a `payTo` a cash out cannot reach, a zero or fractional amount, a missing `quoteId`, a missing or exceeded `maxAmount`, and an expired quote.

**This is not a Tempo Zone.** A Zone is operator-visible: the zone operator sees every transaction inside it. Gloam is private from the public and from any operator; only the payer and the payee learn the amount. Compliance visibility is opt-in per payment via `buildComplianceDisclosure`, an issuer-scoped disclosure that reuses the shield-circuit proof rather than handing an operator a blanket view. See [`TEMPO_EXPANSION.md`](https://github.com/gloamtrade/gloam/blob/main/TEMPO_EXPANSION.md).

## Take payments and read their notes

New in 0.2.0. A service can ask to be paid privately, with a note on each payment (an invoice number, an agent ID), and credit each payment by its note. Only your key reads the note, and nothing on chain ties the payer to it.

1. **Hold a receive key.** `generateReceiveKey()` gives you a Gloam address (`gloamr1.…`) to share and a private key to keep on your server.
2. **Make a request link** with `buildPaymentRequestLink`: the same link the Gloam app makes, with your address, the network, the token, an optional amount and a note of up to 80 characters. A longer note is refused, not cut.
3. **The payer pays it** from their private balance in Gloam. The note travels inside the payment, sealed to your address.
4. **Find it.** Where the network has a payment-message board, `scanIncomingPayments` returns every payment sealed to your key, with its amount, token and note. It only returns payments that are in the vault and not yet spent, read at one block, and it splits any block range the node refuses. Resume from `scannedTo + 1`.
5. **Secure it, then credit.** Until you move it, the payer could still spend it back. `sweepReceivedNote` moves it into a note only you know, through the Gloam relay, so your server needs no gas. Credit only when it returns `final: true`. From 0.4.2 that also means the fresh note is in the pool: a successful receipt alone is not enough, since a sweep sent through a smart account, bundler or forwarder can succeed outside while the transfer inside it reverts. Such a sweep comes back `unconfirmed`, with the fresh note kept.

```ts
import {
  mainnetNetwork, generateReceiveKey, buildPaymentRequestLink,
  scanIncomingPayments, openIncomingPayment, notePackageToExport,
  sweepReceivedNote, sweepChainFromClient, relaySubmitter, findRequestAsset,
} from "@gloamtrade/sdk";

const net = mainnetNetwork("robinhood")!;
const key = await generateReceiveKey();       // keep key.privateJwk secret
const usdg = findRequestAsset(net, "USDG")!;  // the token you credit

const link = buildPaymentRequestLink({
  payTo: key.tag, network: net, asset: "USDG", amount: "25", note: "agent:42",
});

// With a payment-message board: scan for payments to your key.
const { payments, scannedTo } = await scanIncomingPayments({ client, network: net, receiveKey: key });

// Or check a sealed code a payer hands over directly.
const check = await openIncomingPayment({ client, network: net, receiveKey: key, sealedTicket: code });

for (const p of payments) {
  const r = await sweepReceivedNote({
    note: await notePackageToExport(p.notePackage),
    poolAddress: net.pool, chainId: net.chainId, prove,
    chain: sweepChainFromClient(client, { pool: net.pool, fromBlock: net.deployBlock }),
    submit: relaySubmitter(),
    beforeSubmit: (fresh) => saveNote(fresh),  // persist before it is sent
  });
  // Anyone can pay in any token the vault takes: credit only the one you priced in.
  if (r.final && p.asset.toLowerCase() === usdg.address.toLowerCase()) creditAgent(p.note, p.amountWei);
}
```

**Every network has a board,** every mainnet included (since October 2026), so `scanIncomingPayments` finds payments to your key on its own. A payer can also hand you the sealed code (`gloam2t.…`) their app shows after paying; check it with `openIncomingPayment`, which says whether it is ready, has not landed yet, or was already spent. The full runnable version is [`examples/receive-and-credit.ts`](https://github.com/gloamtrade/gloam/tree/main/packages/sdk/examples/receive-and-credit.ts).

## Commerce with commitments

For an economy that already posts a merkle root of its records on chain (a game city, a marketplace, an agent network). Payments stay private, and each one becomes a leaf in that root that anyone holding the record can check later.

1. **Pay privately.** `buildPrivatePaymentWithReceipt` builds the private send to the payee's receive tag, seals the payment to it, and returns the plan for its receipt. The agent signs `intent.exec` (and `memo`, so the payee finds it).
2. **Prove.** Once the transfer lands, `buildPaymentReceipt` proves it with the receipt circuit, bound to a label you pick (a record id) and an expiry, and returns the record with its leaf.
3. **Commit.** Put `record.leaf` in your nightly root; store the record (no secrets in it) off chain.
4. **Check.** `checkPaymentReceipt` recomputes the leaf, checks the fields and the context, verifies the proof, and reads the chain: the vault had the root, and the transaction's `Transferred` event created this note as the payment.

```ts
import {
  buildPrivatePaymentWithReceipt, buildPaymentReceipt, checkPaymentReceipt,
  verifyGroth16, proveGroth16, POOL_TRANSFER_ABI, transferCallArgs, syncTree,
} from "@gloamtrade/sdk";

const pay = await buildPrivatePaymentWithReceipt({
  payTo: supplierTag, chainId: net.chainId, asset: usdg.address, amountWei: parseUnits("25", 6),
  from: { secretHex: note.secret, amountWei: note.amount, path },
  prove: transferProver,
  receipt: { verifier: "nightly-root:sale:8812" },
});
const txHash = await wallet.writeContract({
  address: net.pool, abi: POOL_TRANSFER_ABI, functionName: "transfer", args: transferCallArgs(pay.intent),
});
if (pay.memo) await wallet.writeContract(pay.memo);

const synced = await syncTree(client, { pool: net.pool, fromBlock: net.deployBlock });
const record = await buildPaymentReceipt({
  plan: pay.receiptPlan,
  path: (await synced.pathForCommitment(pay.paymentNote.commitment))!,
  txHash,
  prove: (input) => proveGroth16(input, "receipt.wasm", "final/receipt_final.zkey"),
});
// record.leaf goes in your root

const result = await checkPaymentReceipt(record, {
  verifySnark: (signals, proof) => verifyGroth16(receiptVkey, signals, proof),
  client,
}); // result.ok, result.checks
```

The leaf, so a Solidity contract or any other language can recompute it:

```
keccak256(abi.encode("gloam.receipt-leaf.v1", uint256 chainId, address pool, bytes32 txHash, uint256[7] signals))
```

with `signals` the receipt's public signals in circuit order: `[root, commitment, asset, minAmount, reveal, shownAmount, context]`. `paymentReceiptLeaf` computes it and `verifyPaymentReceiptLeaf` recomputes and compares; the tests pin a vector that Solidity and `cast` reproduce. `agentSigningAllowlist({ chainId, assets })` lists every call an agent signs (token approvals of the vault, `shieldBound`, `transfer`, `unshield`, `postMemo`) with selectors from the ABIs the SDK signs with, for an economy that signs only from an allowlist.

What it does not do: no contract verifies receipt proofs on chain; they are checked off chain (`verifyGroth16`, gloam.trade/verify, the partner API). A receipt shows a private payment of that asset and size was made by that transaction, not who received it. An agent that signs its own transfer is that transaction's sender; the relay (`relayIntent`, `relayMemo`) keeps its wallet out of it. Guide: [gloam.trade/docs/agents/commitments](https://gloam.trade/docs/agents/commitments).

## API reference

Everything exports from one barrel. The crypto and math core is pure and runs anywhere. Proving (snarkjs plus artifacts) and storage (notes, keys) are injected, so the same core serves a browser app and a node signer.

### Networks, keys and fees (new in 0.1.0)

```ts
mainnetNetwork("robinhood" | "tempo" | "base" | "ethereum" | "elysium"): GloamNetwork | null  // null until this SDK version has the pool ("elysium": from 0.7.0)
testnetNetwork("robinhood" | "tempo" | "base" | "ethereum" | "elysium"): GloamNetwork | null  // "base" (0.3.0) is Base Sepolia, "ethereum" (0.4.0) Ethereum Sepolia, "elysium" Elysium testnet (null until its pool is in)
gloamNetworks(): GloamNetwork[]                             // mainnets with a pool first, then testnets
getGloamNetwork(key): GloamNetwork | null                   // "robinhood-mainnet" | "tempo-mainnet" | "base-mainnet" | "ethereum-mainnet" | "elysium-mainnet" | "robinhood" | "tempo" | "base" | "ethereum" | "elysium"
networkForChainId(chainId): GloamNetwork | undefined        // now finds mainnets too
GLOAM_NETWORKS / GLOAM_TESTNETS                             // the two testnets, unchanged
poolForChainId(chainId): Address                            // throws rather than guess
isMainnetChainId(chainId), networkName(chainId)
isPaymentsPoolChainId(chainId)                              // ShieldPoolPayments: every mainnet, Base Sepolia, Ethereum Sepolia and Elysium testnet
ceremonyForChainId(chainId): "dev" | "production"           // production (final keys) on 4663, 4217, 8453, 1, 99901, 84532, 11155111 and 99801
circuitArtifactUrls(circuit, chainId, base?)                // { wasm, zkey } for "shield" | "transfer" | "unshield"
circuitArtifactFiles(circuit, ceremony), CIRCUIT_SHA256     // relative paths and SHA-256 to check a download
GLOAM_ARTIFACTS_URL                                         // https://www.gloam.trade/circuits
assertDepositAllowed(chainId, asset, amount)                // listed asset, no native on mainnet (amounts: read live, below)
readDepositLimit(client, pool, asset)                       // the vault's live deposit limit: { on, perDeposit, total, deposited, room, unlimited } (0.4.2)
isNoLimit(value), NO_LIMIT_THRESHOLD                        // a perDeposit or total of 2^127 or more (the owner sets uint128 max) is no limit
assertDepositWithinLiveLimit(client, chainId, asset, amount, pool?)  // refuses over the live limit; refuses nothing if the vault can't be read
CASH_OUT_FEE_BPS, cashOutFee(amount, bps?)                  // 50 bps on mainnet, rounded down like the pool
readCashOutFeeBps(client, pool)                             // the rate a vault charges now: Base Sepolia and Ethereum Sepolia are still at 25 (0.5.0)
cashOutTargetProblem(to, net): string | null                // why a cash out to `to` would be lost, or null (0.4.3). `net` is a GloamNetwork, or { chainId, pool? }
MAINNET_POOLS, mainnetPoolFor(chainId)                      // the one place mainnet pool addresses live
BASE_SEPOLIA_POOL, baseSepoliaPool()                        // the Base Sepolia pool, null until it is in
ETHEREUM_SEPOLIA_POOL, ethereumSepoliaPool(), ethereumSepoliaPayMemo()  // Ethereum Sepolia's pool and board (0.4.0), null until in
RH_MAINNET_CHAIN, TEMPO_MAINNET_CHAIN, RH_TESTNET_CHAIN, TEMPO_TESTNET_CHAIN  // viem chains
BASE_MAINNET_CHAIN, BASE_SEPOLIA_CHAIN                      // viem's Base chains, on RPCs that serve eth_getLogs
RH_MAINNET_ASSETS, TEMPO_MAINNET_ASSETS                     // assets with deposit limits
BASE_MAINNET_ASSETS, BASE_SEPOLIA_ASSETS                    // Base: USDC, EURC, USDT (mainnet only), ETH
RH_MAINNET_USDG, GLOAM_TOKEN, TEMPO_USDCE, TEMPO_USDT0, TEMPO_PATHUSD, TEMPO_OUSD
RH_MAINNET_GRIFT, RH_MAINNET_PONS, RH_MAINNET_CASHCAT, RH_MAINNET_AI, RH_MAINNET_ORBIO  // 18 decimals each (the last four from 0.4.5)
BASE_USDC, BASE_EURC, BASE_USDT, BASE_SEPOLIA_USDC, BASE_SEPOLIA_EURC
RH_MAINNET_CHAIN_ID (4663), TEMPO_MAINNET_CHAIN_ID (4217), MAINNET_POSEIDON_T3
BASE_MAINNET_CHAIN_ID (8453), BASE_SEPOLIA_CHAIN_ID (84532)
ETHEREUM_MAINNET_CHAIN, ETHEREUM_MAINNET_ASSETS, ETHEREUM_MAINNET_CHAIN_ID (1)       // 0.4.0
ETHEREUM_USDC, ETHEREUM_USDT, ETHEREUM_USDG, ETHEREUM_PYUSD, ETHEREUM_EURC         // 0.4.0, 6 decimals each
approvalSteps(chainId, token, allowance, amount), approveNeedsReset(chainId, token) // 0.4.0: USDT's approve rule
ETHEREUM_SEPOLIA_CHAIN_ID (11155111), ETHEREUM_SEPOLIA_CHAIN, ETHEREUM_SEPOLIA_ASSETS
ETHEREUM_SEPOLIA_USDC, ETHEREUM_SEPOLIA_USDG, ETHEREUM_SEPOLIA_PYUSD, ETHEREUM_SEPOLIA_EURC
```

### Intent builders

| Function | Resolves | Status |
| --- | --- | --- |
| `buildShieldBoundIntent(p)` | Mints a note + shield proof, then `shieldBound(...)` | Live, mainnet and testnet |
| `buildShieldIntent(p)` | Plain `shield(...)`, no proof (legacy pools only) | Refused on mainnet |
| `buildUnshieldIntent(p)` | Witness + proof, then `unshield(...)` (cash out) | Live, mainnet and testnet |
| `buildPrivateSendIntent(p)` | Transfer witness, then `transfer(...)`; returns payment + change notes | Live, mainnet and testnet |
| `buildPrivateTradeIntent(p)` | Sealed-swap witness, then `sealedSwap(...)` | Retired; refused on mainnet |
| `buildSwapIntent(p)` | Unshield to the swap's escrow + two shields, then the router's `swap(...)` (relay or wallet) | Live where a router is switched on (0.5.0) |

Each builder returns a `GloamIntent` whose `exec` is guaranteed populated. Every builder takes `chainId` (default Robinhood Chain testnet, required with a mainnet vault as `poolAddress`) and `poolAddress` (default: Gloam's pool on that chain). `buildPrivateTradeIntent` produces a valid intent for the testnets, but the sealed trade is retired and switched off on every live pool, so its call reverts.

### Private swaps (new in 0.5.0)

```ts
quoteSwap(p): Promise<SwapQuote>                         // price of one whole note, with `stop` (or throws SwapRefusedError: no price); p.stops sets the impact, peg and value stops
buildSwapIntent(p): Promise<SwapIntent>                  // { relay, wallet, recovery, plan, warnings }; refuses before any proof
sendSwap({ intent, save, submit, client })               // saves the recovery, then sends, then reads the outcome
relaySwapCall(call, opts?)                               // POST a swap, refund or exit to the Gloam relay
readSwapOutcome(client, rec)                             // swapped | refunded | refund_ready | exit_ready | pending | reverted | expired | closed
buildSwapRefund(rec, { client, shieldProver })           // money at the escrow back as the refund note
buildSwapExit(rec, { client, to })                       // money at the escrow out to `to` (routers with an exit)
findSwapUnshieldTx(client, rec), parseSwapRecovery(raw), swapJson(value)
swapRouterFor(chainId, router?), vaultSwapRouter(chainId), swapChainIds(), vaultSwapAssets(chainId)
routesBetween(a, b, router), isKnownRoute(...), planVaultSwap(client, chainId, ask)   // the app's planner
escrowAddress(router, assetIn, key), exitDigest(...), exitAccount(refundSecret), refundAmountFor(amount, feeBps?)
readCashOutFeeBps(client, pool), cashOutFeeLive(client, pool, amount)                  // the vault's fee, read live
VAULT_SWAP_V3_LIVE, VAULT_SWAP_V3_ADDRESS                // the next router's switch (null until set) and pinned addresses
```

### Notes

```ts
makeBoundNotePoseidon(amount: bigint, asset?: Address): Promise<BoundNote>
noteCommitmentPoseidon(secret: bigint, amount: bigint, asset?: Address): Promise<bigint>
noteNullifierPoseidon(secret: bigint, commitment: bigint): Promise<bigint>
openNotePoseidon(secretHex: Hex, amount: bigint, asset: Address)
randomSecretField(): Promise<bigint>
```

### Prover (injected)

```ts
type Prover = (input: Record<string, string | string[]>) => Promise<ProveResult>
artifactProver(a: { wasm: string; zkey: string }): Prover   // paths in node, URLs in the browser
proveGroth16(input, wasm, zkey)                              // one-shot form
```

### Tree sync

```ts
syncTree(client, { pool, fromBlock?, chunkSize?, concurrency? }): Promise<SyncedTree>
assertTreeMatchesChain(client, pool, synced): Promise<boolean>
// SyncedTree.pathForCommitment(commitment) feeds straight into the spend builders.

// keep the tree instead of rebuilding it (next release)
createTreeSync(client, { pool, fromBlock?, chunkSize?, concurrency?, store?, seed?, overlap?, verifyRoot?, reuseMs? }): TreeSync
  .sync(): Promise<SyncedTree>                                // reads only the blocks since the last sync
  .pathForCommitment(commitment, { atBlock? }?)               // sync, then the path (atBlock: skip the head read)
  .knownPath(commitment)                                      // the kept tree's path, one root check, no log reads
  .follow(intervalMs): () => void                             // keep syncing in the background (servers)
gloamLeafSeed(network, { url?, fetch?, timeoutMs? }?): TreeSeed  // gloam.trade's public leaf list for a cold start
parseTreeSnapshot(json, pool): TreeSnapshot | null             // what a TreeStore keeps (JSON)
```

`syncTree` walks the pool's logs from `fromBlock` every time. On a public RPC that caps `eth_getLogs` (Tempo: 100,000 blocks) that is about a minute for a pool a few months old. A server or agent that spends more than once should keep a `createTreeSync`:

```ts
const tree = createTreeSync(publicClient, {
  pool: net.pool,
  fromBlock: net.deployBlock,
  chunkSize: 99_000n,
  seed: gloamLeafSeed("tempo-mainnet"),  // a cold start in one request instead of a walk over the pool's history
  store: myFileStore,                    // { load(), save(snapshot) }: a restart reads only the blocks since
});
const path = await tree.pathForCommitment(note.commitment);
```

Nothing from the seed is trusted, nor a stored copy the pool has not confirmed: the rebuilt root has to be one the pool knows (`isKnownRoot`, one call), and a list that does not match is dropped for a walk of the chain. Gloam pools keep every root they have had, so a store saves the root the pool confirmed with its copy, and `knownPath` answers from that copy on the next run with no chain reads at all (a copy whose items do not build that root is checked again). The seed request names only the network and is the same for everyone.

### x402 payments

```ts
buildGloamPaymentRequirements(p): GloamPaymentRequirements   // server: the 402 challenge (payTo must be a receive tag)
buildGloamPayment(p): Promise<BuiltPayment>                  // agent: private send + X-PAYMENT header, note sealed to payTo
settleGloamPayment(p): Promise<SettleResult>                 // server: open + verify + sweep; grant access on grantAccess
openGloamPaymentNote(paymentNote, receiveKey?)               // server: open the sealed payment note
verifyGloamPayment({ requirements, payload, note? }): VerifyResult  // structural verify, always final: false
verifyPaymentNoteBinding(note): Promise<boolean>             // crypto: amount binds to commitment
buildComplianceDisclosure(p): Promise<GloamComplianceDisclosure>  // optional issuer-scoped disclosure
encodeRequirements / decodeRequirements                      // 402 body transport
encodePaymentHeader / decodePaymentHeader                    // X-PAYMENT transport
GLOAM_VS_ZONE, GLOAM_X402_SCHEME, GLOAM_NOT_FINAL            // posture, scheme id, the not-final notice

// scheme gloam-cashout (new in 0.6.0): a private payer, a public payee
findGloamCashoutRequirement(headers, body) / parseGloamCashoutRequirement(entry)
chooseGloamX402Scheme({ gloamPrivate, gloamCashout }, prefer?)
gloamCashoutProblem(req, { maxAmount }) / assertGloamCashoutPayable  // refusals before paying
buildGloamCashoutIntent(p) / payGloamCashout(p)              // agent: unshield exactly G to payTo, header back
encodeGloamCashoutHeader / decodeGloamCashoutHeader          // X-PAYMENT: base64 JSON { scheme, txHash, quoteId }
cashoutGross(price, tag, bps) / quoteGross(price, tag, opts?) // gateway: G, at the live fee
buildGloamCashoutRequirement(p)                              // gateway: the accepts entry
verifyGloamCashout({ txHash, quote, rpcUrl?, client? })      // gateway: receipt, logs, window (not replay)
```

`buildGloamPayment` does not broadcast: the agent signs and broadcasts the returned `intent.exec` itself, staying self-custodial, then sets `payload.txHash`. `verifyGloamPayment` confirms the payment note binds the required amount and asset, is the payment output of the transfer, and settles through the right pool. It never makes a payment final: its result carries `final: false` and a plain `finality` notice. `settleGloamPayment` runs it, checks the binding, and sweeps.

### Receive tags and sweeps

```ts
generateReceiveKey(): Promise<ReceiveKey>                    // { tag: "gloamr1.…", privateJwk }
isReceiveTag(s) / assertReceiveTag(s)                        // strict: gloamr1. + a P-256 public key
sealToReceiveTag(text, tag) / openSealedTicket(sealed, key)  // gloam2t.… tickets, app-compatible
encodeNotePackage / decodeNotePackage                        // gloam1.… note packages, app-compatible
sweepReceivedNote(p): Promise<SweepResult>                   // move a received note into a fresh one
sweepChainFromClient(publicClient, { pool, fromBlock, ...treeSyncParams, tree?, pollingInterval? }) // the chain reads a sweep needs; keeps the tree
relaySubmitter(opts?)                                        // submit sweeps through the Gloam relay
POOL_TRANSFER_ABI, POOL_STATE_ABI, transferCallArgs(intent)  // sign a transfer with your own wallet
```

A sweep spends the received note into a fresh note of the whole amount plus a zero-value change note, both with secrets only the payee knows. It checks the nullifier first (`already_spent` if the payer got there), stores nothing itself (persist the fresh note in `beforeSubmit`), and reports `final: true` only once the sweep confirms or its fresh note is seen on chain.

### Request links and incoming payments (new in 0.2.0)

```ts
buildPaymentRequestLink({ payTo, network, asset, amount?, note?, name?, origin? }): string  // the app's exact link
parsePaymentRequestLink(link)                                 // read the fields back
normalizeRequestAmount(input, asset), findRequestAsset(net, s), REQUEST_NOTE_MAX (80)
scanIncomingPayments({ client, network, receiveKey, fromBlock?, toBlock?, board? })
  : Promise<{ payments: IncomingPayment[]; scannedTo: bigint }>  // where the network has a board
openIncomingPayment({ client, network, receiveKey, sealedTicket })
  : Promise<{ status: "ready" | "not_in_vault_yet" | "already_spent"; payment }>  // a code handed over
payMemoBoardFor(chainId), PAY_MEMO_BOARDS, NoPayMemoBoardError
cleanPaymentNote(s), PAYMENT_NOTE_MAX                         // the app's note rules
```

`IncomingPayment` carries `commitment`, `nullifier`, `amountWei`, `asset`, `note`, the `sealedTicket`, the opened `notePackage` (pass `notePackageToExport(notePackage)` to `sweepReceivedNote`), and where it was posted. Note packages now carry the payer's note under `n`, byte for byte like the app.

### Commerce with commitments

```ts
buildPrivatePaymentWithReceipt(p): Promise<PrivatePaymentWithReceipt>  // private send to a tag + the receipt plan
buildPaymentReceipt({ plan, path, txHash, prove }): Promise<PaymentReceiptRecord>
paymentReceiptLeaf(fields): Hex / verifyPaymentReceiptLeaf(leaf, fields): boolean
checkPaymentReceipt(record, { leaf?, verifySnark?, client?, now? }): Promise<ReceiptCheckResult>
verifyGroth16(vkey, publicSignals, proof): Promise<boolean>    // off-chain proof check
paymentProofText(record)                                       // gloampay1:… for /verify
agentSigningAllowlist({ chainId?, assets? }): AgentSigningEntry[]
GLOAM_VAULT_AGENT_ABI, PAY_MEMO_ABI, RECEIPT_LEAF_DOMAIN, cleanReceiptLabel
```

### Merkle, rates, privacy, constants

```ts
IncrementalMerkleTreePoseidon, pathToCircomInput, MERKLE_DEPTH
exactSealedAmounts, estimateSealedOut, marksToSealedRates   // sealed-rate math (pure)
publicAmountOutMin, SEALED_PRIVACY_FACTS                    // size-privacy policy
SEALED_VAULT, TEMPO_SEALED_VAULT, SHIELD_VERIFIER, NATIVE_ASSET   // testnet pools and the native-asset sentinel
RH_TESTNET_CHAIN_ID, TEMPO_TESTNET_CHAIN_ID, RH_MAINNET_CHAIN_ID, TEMPO_MAINNET_CHAIN_ID
```

The full surface, with every parameter interface, is documented at [gloam.trade/docs/sdk/reference](https://gloam.trade/docs/sdk/reference).

![The Gloam docs](https://raw.githubusercontent.com/gloamtrade/gloam/main/app/public/media/readme-docs.jpg)

## Framework integration

The SDK ships TypeScript source and is consumed through your bundler. It uses NodeNext `.js` import specifiers internally.

**Next.js** (App Router). Transpile the package and map the `.js` specifiers to `.ts`:

```js
// next.config.mjs
const nextConfig = {
  transpilePackages: ["@gloamtrade/sdk"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
export default nextConfig;
```

**Vite / tsx / node.** Works out of the box with a bundler or a TypeScript-aware runner. `snarkjs` and `circomlibjs` have no bundled types, so if your `tsconfig` is strict, add ambient shims (`declare module "snarkjs"` and `declare module "circomlibjs"`); the [web example](https://github.com/gloamtrade/gloam/tree/main/examples/web-shield) includes a copy you can drop in.

## Examples

Runnable references, one for each shape a builder starts from:

| Example | Runtime | What it shows |
| --- | --- | --- |
| [agent-shield](https://github.com/gloamtrade/gloam/tree/main/examples/agent-shield) | Node | The smallest agent: mint a note, prove, deposit privately. |
| [pay-bot](https://github.com/gloamtrade/gloam/tree/main/examples/pay-bot) | Node | A private payment end to end: shield, sync, send. |
| [pay-x402](https://github.com/gloamtrade/gloam/tree/main/examples/pay-x402) | Node | A private agent payment over x402: price, pay sealed to the payee, sweep, serve. |
| [web-shield](https://github.com/gloamtrade/gloam/tree/main/examples/web-shield) | Browser | Shield in the browser, read the balance back from chain. |
| [receive-and-credit](https://github.com/gloamtrade/gloam/tree/main/packages/sdk/examples/receive-and-credit.ts) | Node | Take payments by request link, read each payment's note, secure it, credit the account it names. |
| [san-verano](https://github.com/gloamtrade/gloam/tree/main/examples/san-verano) | Node | Commerce with commitments: pay a supplier privately, sweep, prove, put the receipt leaf in a nightly root; a dry run by default. |

![Add money privately in the browser](https://raw.githubusercontent.com/gloamtrade/gloam/main/app/public/media/readme-browser.jpg)

## Pinned public inputs

`PUBLIC_INPUTS` pins the exact signal ordering the deployed verifiers expect, so an integrator cannot drift out of proof compatibility:

```ts
PUBLIC_INPUTS.unshield   // [root, nullifier, asset, amount, to]
PUBLIC_INPUTS.transfer   // [root, nullifier, newCommitment0, newCommitment1]
PUBLIC_INPUTS.sealedSwap // [root, nullifier, newCommitmentOut, newCommitmentChange, assetIn, assetOut, amountOutMin, rateIn, rateOut]
```

## Guardrails and honesty

- **Mainnet.** Robinhood Chain (`4663`), Tempo (`4217`), Base (`8453`), Ethereum (`1`) and Elysium (`99901`) run on the final keys of the 13-contributor trusted setup, with deposit limits. The contracts and circuits had an internal pre-mainnet review on 20 October 2026 with no Critical or High findings open. Kann Audits then reviewed the vault contracts (report, 1 November 2026: [gloam.trade/security](https://gloam.trade/security)) and found no Critical, High or Medium issues. The circuits and this SDK were not part of that review.
- **A new pool has a small crowd.** Privacy depends on how many notes you hide among. On a brand new mainnet pool that crowd is thin at first, so do not treat a quick deposit and cash out of the same amount as unlinkable.
- **Testnet runs on dev keys.** Robinhood Chain testnet (`46630`) and Tempo Moderato (`42431`) keep running with the single-party dev keys. Base Sepolia (`84532`) and Ethereum Sepolia (`11155111`) are testnets too, but on the final keys.
- **Real privacy only.** No mock successes. If a path cannot be private, the SDK returns a plan rather than a fake result.
- **The sealed trade is retired** on every pool (the mainnet pools have no swap code at all). Private swaps go through the swap routers instead, in the app and in this SDK (`buildSwapIntent`): they hide who swapped, not the tokens or the amounts. The routers were not part of the external review. Shield, private send, cash out, swaps and disclosure are proof-gated.
- **Note secrets are the sole spend authority.** Persist and protect them. `localStorage` is fine for a demo, not for real value. Never hand one to an agent: the `@gloamtrade/mcp` server keeps them in an encrypted store and gives the agent handles.
- **A received x402 payment is not yours until you sweep it.** The payer knows the payment note's secret. Use `settleGloamPayment` and serve only on `grantAccess`.

## Links

- Documentation: [gloam.trade/docs/sdk](https://gloam.trade/docs/sdk)
- Quickstart: [gloam.trade/docs/quickstart](https://gloam.trade/docs/quickstart)
- API reference: [gloam.trade/docs/sdk/reference](https://gloam.trade/docs/sdk/reference)
- App: [gloam.trade](https://gloam.trade)
- Source: [github.com/gloamtrade/gloam](https://github.com/gloamtrade/gloam)
- X: [@gloamtrade](https://x.com/gloamtrade)
- Email: [hello@gloam.trade](mailto:hello@gloam.trade)

## License

MIT
