# gloam-pay-bot

A payments bot that sends a **private payment** using only
[`@gloamtrade/sdk`](../../packages/sdk). It is the smallest end-to-end example of
the spend path: shield, sync the tree from chain, and transfer privately.

## What it does

1. **Shields** a note to fund itself (`buildShieldBoundIntent` + a real shield
   proof). For a token it approves the pool first and waits for that approval.
2. **Rebuilds the pool tree** from chain with `syncTree`, starting at the pool's
   deploy block, and checks the root against the pool's on-chain `currentRoot()`.
3. **Sends privately** with `buildPrivateSendIntent`: it spends the funding note
   and produces two new notes, a payment note for the recipient and a change
   note for itself. There is no public transfer and no visible amount.
4. Prints the **payment note** to hand the recipient (they open or cash it out)
   and the **change note** to keep.

## Run on mainnet

```bash
# from the repo root
pnpm install

cd examples/pay-bot
GLOAM_NETWORK=robinhood-mainnet GLOAM_PAY_KEY=0x... npx tsx pay-bot.ts
```

- `GLOAM_NETWORK=robinhood-mainnet` shields 2 USDG on Robinhood Chain and pays 1
  privately. The key needs the USDG plus a little ETH for gas. Robinhood Chain
  mainnet takes no native ETH deposit (ETH is only gas).
- `GLOAM_NETWORK=tempo-mainnet` does the same with 2 USDC.e on Tempo. Tempo has
  no gas coin: fees are paid in the account's chosen fee token, else pathUSD, so
  hold a little of it.
- `GLOAM_ASSET` picks another asset the pool lists (`GLOAM` on Robinhood Chain;
  `pathUSD`, `USDT0`, `OUSD` on Tempo).

What to know before you use mainnet:

- **Deposit limits.** Deposits are capped at 50,000 per deposit and
  2,500,000 in total for each stablecoin ($GLOAM: 2,500,000 and 25,000,000). Private
  payments and cash outs are never limited.
- **Fees.** Direct deposits and private payments are free. Cashing out costs 0.5%; the
  bot prints what the pool would keep from the payment note (`cashOutFee`).
- **Final keys.** Mainnet proofs use the final keys from the 13-contributor
  trusted setup (release `ceremony-final`). The bot picks them with
  `circuitArtifactFiles` / `circuitArtifactUrls`.
- **Payments only.** The SDK does not swap. Private swaps are in the Gloam app on Robinhood Chain and Tempo mainnet.
- **Secrets are money.** The bot prints the source note before it deposits, then
  the payment and change notes. Store them; losing a secret loses its funds.

If your SDK version has no pool for the mainnet you picked, the bot stops with a
message and spends nothing. Update `@gloamtrade/sdk` once the pool is published.

## Practice on testnet

Unset `GLOAM_NETWORK` (the default) to run on Robinhood Chain testnet (chain id
`46630`) with test funds: it shields 0.002 test ETH and pays 0.001.

```bash
GLOAM_PAY_KEY=0x... npx tsx pay-bot.ts                       # Robinhood Chain testnet, test ETH
GLOAM_NETWORK=tempo GLOAM_PAY_KEY=0x... npx tsx pay-bot.ts   # Tempo testnet, test PathUSD
```

Get test ETH from the [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com/).
`GLOAM_ASSET=USDG` uses test USDG instead (from the
[Paxos faucet](https://faucet.paxos.com/)). Testnets use the dev keys.

## Options

| Variable | What it does |
| --- | --- |
| `GLOAM_PAY_KEY` | The bot's key (required). |
| `GLOAM_NETWORK` | `robinhood-mainnet`, `tempo-mainnet`, `robinhood` or `tempo`. Default `robinhood` (testnet). |
| `GLOAM_ASSET` | A symbol the pool lists. Default: the first stablecoin (test ETH on Robinhood Chain testnet). |
| `GLOAM_RPC` | Your own RPC URL. Default: the network's public RPC. |
| `GLOAM_CIRCUITS_CACHE` | Where downloaded circuit files go. Default `~/.cache/gloam/circuits`. |

snarkjs proves from local files in node. The bot uses the repo's copy in
`app/public/circuits` (dev keys at the root, final keys under `final/`), or
downloads them from [www.gloam.trade/circuits](https://www.gloam.trade/circuits)
into the cache with the same layout. Every file is checked against
`CIRCUIT_SHA256` first.

## What stays private

The transfer emits only a nullifier and two new commitments. The amount, the
sender and recipient link, and which note was spent are all hidden. Shielding
itself is a public deposit (the deposit amount is visible); everything after it
is not.

See [`examples/agent-shield`](../agent-shield) for the deposit-only path, and the
[SDK docs](https://gloam.trade/docs/sdk) for the full surface.
