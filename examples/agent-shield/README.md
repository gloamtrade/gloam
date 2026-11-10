# agent-shield

The smallest end-to-end example of plugging into Gloam's private layer: an
autonomous agent that shields money **privately**, using only
[`@gloamtrade/sdk`](../../packages/sdk).

It mints a Poseidon note, generates the zero-knowledge shield proof, and deposits
via `shieldBound()`. Who can spend the balance leaves the public feed; only the
holder (with `note.secret`) can later spend, send, or disclose it.

## Run on mainnet

```bash
# from the repo root
pnpm install

cd examples/agent-shield
GLOAM_NETWORK=robinhood-mainnet GLOAM_AGENT_PRIVATE_KEY=0x... npx tsx agent-shield.ts
```

- `GLOAM_NETWORK=robinhood-mainnet` shields 1 USDG on Robinhood Chain. The key
  needs the USDG plus a little ETH for gas. Set `GLOAM_ASSET=GLOAM` to shield $GLOAM
  instead, or `GLOAM_ASSET=ETH` to shield ETH.
- `GLOAM_NETWORK=tempo-mainnet` shields 1 USDC.e on Tempo. `GLOAM_ASSET` can also
  be `pathUSD`, `USDT0` or `OUSD`. Tempo has no gas coin: fees are paid in the
  account's chosen fee token, else pathUSD, so hold a little of it.
- The script approves the pool for the token, waits for that approval, then
  sends `shieldBound`.

What to know before you use mainnet:

- **Deposit limits.** Deposits are capped at 50,000 per deposit and
  2,500,000 in total for each stablecoin ($GLOAM: 2,500,000 and 25,000,000). Cash outs and
  private payments are never limited.
- **Fees.** Direct deposits and private payments are free. Cashing out costs 0.5%
  (`cashOutFee(amount)` in the SDK).
- **Final keys.** Mainnet proofs use the final keys from the 13-contributor
  trusted setup (release `ceremony-final`). The script picks them with
  `circuitArtifactFiles` / `circuitArtifactUrls`, so a mainnet proof is never made
  with the dev keys.
- **Payments only.** The mainnet pools take deposits, private payments and cash
  outs. This example does not swap; private swaps are in the Gloam app and in the SDK (from 0.5.0), on Robinhood Chain and Tempo mainnet.
- **Your secret is your money.** The script prints `note.secret`. Store it
  somewhere safe before anything else; losing it loses the funds.

If your SDK version has no pool for the mainnet you picked, the script stops
with a message and spends nothing. Update `@gloamtrade/sdk` once the pool is
published.

## Practice on testnet

Unset `GLOAM_NETWORK` (the default) to run on Robinhood Chain testnet with test
funds, or pick a testnet:

```bash
# Robinhood Chain testnet (46630): shields 0.001 test ETH
GLOAM_AGENT_PRIVATE_KEY=0x... npx tsx agent-shield.ts

# Tempo testnet (Moderato, 42431): shields 1 test PathUSD
GLOAM_NETWORK=tempo GLOAM_AGENT_PRIVATE_KEY=0x... npx tsx agent-shield.ts
```

Get test ETH from the [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com/).
`GLOAM_ASSET=USDG` shields test USDG instead (from the
[Paxos faucet](https://faucet.paxos.com/)). Testnets use the dev keys.

## Options

| Variable | What it does |
| --- | --- |
| `GLOAM_AGENT_PRIVATE_KEY` | The agent's key (required). |
| `GLOAM_NETWORK` | `robinhood-mainnet`, `tempo-mainnet`, `base-mainnet`, `ethereum-mainnet`, `robinhood`, `tempo` or `base` (Base Sepolia). Default `robinhood` (testnet). |
| `GLOAM_ASSET` | A symbol the pool lists. Default: the first stablecoin (test ETH on Robinhood Chain testnet). |
| `GLOAM_RPC` | Your own RPC URL. Default: the network's public RPC. |
| `GLOAM_CIRCUITS_CACHE` | Where downloaded circuit files go. Default `~/.cache/gloam/circuits`. |

## Circuit files

snarkjs proves from local files in node. The script uses the repo's copy in
`app/public/circuits` (dev keys at the root, final keys under `final/`). Outside
the repo it downloads them from
[www.gloam.trade/circuits](https://www.gloam.trade/circuits) into the cache,
keeping the `final/` folder so the two key sets never mix. Every file is checked
against `CIRCUIT_SHA256` before it is used.

## What it shows

- `getGloamNetwork(key)`: one object with the chain, RPC, pool, assets, limits
  and key set for a network. It is `null` for a mainnet whose pool is not in your
  SDK version.
- `buildShieldBoundIntent(...)`: the SDK checks the asset and the deposit limit,
  mints the note, runs the shield prover, and returns a ready-to-sign
  `shieldBound(asset, amount, commitment, proof)` call. Plain `shield()` is off on
  every live pool, so the proof is required.
- The private core is environment-agnostic: the same SDK powers the browser vault
  and this node agent.

## Next

- Persist `note.secret` (this example just prints it). A real agent keeps a note
  store keyed by commitment.
- Send privately with the transfer builder ([`examples/pay-bot`](../pay-bot)) or
  cash out with the unshield builder.
- Prove a balance to a counterparty with a **selective disclosure**; verify it at
  [gloam.trade/verify](https://gloam.trade/verify).
