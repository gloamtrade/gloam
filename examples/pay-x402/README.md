# pay-x402

A private agent payment over x402, end to end, using only `@gloamtrade/sdk`.

A seller prices a resource (the HTTP 402 challenge) and names its receive tag as
`payTo`. A buyer agent shields a note to fund itself, builds a private payment of
the required amount, seals the payment note to the seller's tag, broadcasts the
shielded transfer itself, and presents the `X-PAYMENT` header. The seller opens
the payment, verifies it, and sweeps it into a fresh note only the seller knows.
It grants access only after that sweep confirms. The amount and the parties never
go on the public feed.

This is the pattern that won Colosseum (x402 paired with stablecoins) with the
settlement made private and self-custodial. It is **not** a Tempo Zone: no
operator sees the payment; only the payer and the payee learn the amount, and
compliance visibility is opt-in per payment through an issuer-scoped disclosure.

Selling an API that already takes standard x402? The seller guide in
[`examples/agent-kit-tools`](../agent-kit-tools/README.md#sell-with-private-x402)
adds a Gloam price next to your `exact` one, with middleware that settles and
sweeps before it serves, and says what standard clients can and cannot do.

## Run on mainnet

```bash
# from the repo root
pnpm install

GLOAM_NETWORK=tempo-mainnet GLOAM_PAY_KEY=0x... npx tsx examples/pay-x402/pay-x402.ts
```

- `GLOAM_NETWORK=tempo-mainnet` funds the buyer with 1 USDC.e on Tempo and pays a
  0.01 USDC.e price. Tempo has no gas coin: fees are paid in the account's chosen
  fee token, else pathUSD, so hold a little of it. `GLOAM_ASSET` can also be
  `pathUSD`, `USDT0` or `OUSD`.
- `GLOAM_NETWORK=robinhood-mainnet` does the same with USDG on Robinhood Chain.
  The key needs a little ETH for gas. Robinhood Chain mainnet takes no native ETH
  deposit (ETH is only gas).
- The one key plays both sides here: it funds the buyer and signs the seller's
  sweep. Set `GLOAM_RELAY_URL` to sweep through the Gloam relay instead.

What to know before you use mainnet:

- **Deposit limits.** Deposits are capped at 50,000 per deposit and
  2,500,000 in total for each stablecoin. Private payments and cash outs are never
  limited.
- **Fees.** Gloam takes no fee on deposits or private payments (this x402
  payment and the seller's sweep included); you pay only network gas. Cashing
  out costs 0.5% (`cashOutFee(amount)`).
- **Final keys.** Mainnet proofs use the final keys from the 13-contributor
  trusted setup (release `ceremony-final`), picked with `circuitArtifactFiles` /
  `circuitArtifactUrls`.
- **Payments only.** The SDK does not swap. Private swaps are in the Gloam app on Robinhood Chain and Tempo mainnet.
- **Secrets are money.** The script prints the buyer's funding note, the buyer's
  change note and the seller's fresh note. Store them; losing a secret loses its
  funds.

If your SDK version has no pool for the mainnet you picked, the script stops with
a message and spends nothing. Update `@gloamtrade/sdk` once the pool is
published.

## Practice on testnet

Unset `GLOAM_NETWORK` (the default) to run on Robinhood Chain testnet with test
ETH (a 0.0002 ETH price, funded with 0.0005), or pick a testnet:

```bash
GLOAM_PAY_KEY=0x... npx tsx examples/pay-x402/pay-x402.ts                      # Robinhood Chain testnet
GLOAM_NETWORK=tempo GLOAM_PAY_KEY=0x... npx tsx examples/pay-x402/pay-x402.ts  # Tempo testnet, PathUSD
```

Get test ETH from the [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com/).
`GLOAM_ASSET=USDG` pays in test USDG instead (from the
[Paxos faucet](https://faucet.paxos.com/)). Testnets use the dev keys.

## Options

| Variable | What it does |
| --- | --- |
| `GLOAM_PAY_KEY` | The key that funds the buyer and signs the seller's sweep (required). |
| `GLOAM_NETWORK` | `robinhood-mainnet`, `tempo-mainnet`, `robinhood` or `tempo`. Default `robinhood` (testnet). |
| `GLOAM_ASSET` | A symbol or address the pool lists. Default: the first stablecoin (test ETH on Robinhood Chain testnet). |
| `GLOAM_RPC` | Your own RPC URL. Default: the network's public RPC. |
| `GLOAM_RELAY_URL` | Sweep through the Gloam relay instead of the seller's wallet. |
| `GLOAM_CIRCUITS_CACHE` | Where downloaded circuit files go. Default `~/.cache/gloam/circuits`. |

snarkjs proves from local files in node. The script uses the repo's copy in
`app/public/circuits` (dev keys at the root, final keys under `final/`), or
downloads them from [www.gloam.trade/circuits](https://www.gloam.trade/circuits)
into the cache with the same layout. Every file is checked against
`CIRCUIT_SHA256` first.

## What it shows

1. `generateReceiveKey` gives the seller a receive tag; `buildGloamPaymentRequirements`
   builds the 402 challenge with that tag as `payTo` (anything else is refused).
2. `buildShieldBoundIntent` funds the buyer with a private note.
3. `syncTree` rebuilds the pool tree from the pool's deploy block and returns the
   note's membership path.
4. `buildGloamPayment` builds the private send plus the `X-PAYMENT` header, with
   the payment note sealed to the seller's tag, and an optional issuer-scoped
   compliance disclosure. The agent broadcasts the transfer itself and attaches
   the tx hash.
5. `settleGloamPayment` opens the note with the seller's key, checks it binds the
   price and asset in the right pool, and sweeps it into a fresh note only the
   seller knows. `grantAccess` is true only once the sweep confirms.

## Why the sweep

The buyer creates the payment note, so it knows the note's secret too. If the
seller served right after a plain verify, the buyer could spend the note back
before the seller moved it. The sweep closes that: once it confirms, the money
sits under a secret the buyer never saw. If the buyer got there first, the sweep
fails with `already_spent` and the seller does not serve. `verifyGloamPayment` on
its own says so in its result (`final: false`).
