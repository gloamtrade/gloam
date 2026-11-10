# gloam-web-shield

Shield a **private USDG balance in the browser** with
[`@gloamtrade/sdk`](../../packages/sdk). The smallest complete web integration:
connect an injected wallet, prove the shield client-side, approve the pool for
USDG, deposit via `shieldBound()`, and read the private balance straight back from
the pool.

A minimal Next.js (App Router) app. Copy the pattern into your own dapp.

## Run on mainnet

```bash
pnpm install            # from the repo root (workspace)
cd examples/web-shield
npm run dev             # copies the shield circuit files, then starts Next
```

Open http://localhost:3000 and connect a wallet. The app asks the wallet to
switch to Robinhood Chain mainnet (chain id `4663`) and adds the chain if the
wallet does not know it. You need USDG to shield and a little ETH for gas.

The network comes from `NEXT_PUBLIC_GLOAM_NETWORK`:

| Value | Network |
| --- | --- |
| `robinhood-mainnet` | Robinhood Chain mainnet. |
| `robinhood` | Robinhood Chain testnet. |
| unset | Robinhood Chain mainnet when your SDK version has its pool, else the testnet. |

If you ask for `robinhood-mainnet` and your SDK version has no mainnet pool yet,
the page says so and does not connect. Update `@gloamtrade/sdk` once the pool is
published.

What to know before you use mainnet:

- **Deposit limits.** Deposits are capped at 50,000 USDG per deposit
  and 2,500,000 USDG in total. The SDK checks the per-deposit limit before
  it proves (`assertDepositAllowed`).
- **Fees.** Direct deposits and private payments are free. Cashing out costs 0.5%
  (`cashOutFee(amount)`).
- **Final keys.** Mainnet proofs use the final keys from the 13-contributor
  trusted setup (release `ceremony-final`). `circuitArtifactUrls("shield", chainId)`
  points at `final/` on mainnet and at the dev keys on testnet.
- **No swaps here.** This example does not swap. Private swaps are in the Gloam app and in the SDK (from 0.5.0), on Robinhood Chain and Tempo mainnet.
- **The note secret is the money.** It stays in this browser's `localStorage`.
  Back it up; clearing site data without a backup loses the funds.

## Practice on testnet

```bash
NEXT_PUBLIC_GLOAM_NETWORK=robinhood npm run dev
```

Connect a wallet on Robinhood Chain testnet (chain id `46630`). Get test ETH for
gas from the [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com/)
and test USDG from the [Paxos faucet](https://faucet.paxos.com/). The testnet uses
the dev keys.

## Circuit files

The shield proof needs `shield.wasm` plus the zkey for the network's key set.
`npm run dev` and `npm run build` copy them from `app/public/circuits`
(`npm run artifacts`):

```
public/circuits/shield.wasm               same for both key sets
public/circuits/shield_final.zkey         dev keys (testnet)
public/circuits/final/shield_final.zkey   final keys (mainnet)
```

To load them from another host, set `NEXT_PUBLIC_GLOAM_ARTIFACTS` to a root with
the same layout, such as Gloam's copy at `https://www.gloam.trade/circuits`. That
host must serve CORS for your app's origin.

```bash
NEXT_PUBLIC_GLOAM_ARTIFACTS=https://www.gloam.trade/circuits npm run dev
```

## What it shows

- **One network object.** `getGloamNetwork(key)` gives the chain (for the wallet
  and viem), RPC, explorer, pool and key set.
- **Client-side proving.** `artifactProver` points snarkjs at the shield circuit
  over HTTP; the proof is generated in the browser.
- **Approve, then deposit.** The pool pulls USDG with `transferFrom`, so the app
  approves the pool and waits for that approval before it sends `shieldBound`.
- **The note never leaves the client.** `buildShieldBoundIntent` mints the note;
  its secret is stored in `localStorage` keyed by commitment.
- **No backend.** The private balance is read directly from the pool with
  `commitmentSeen()`: no indexer, no server.
- **Wallet signing only.** viem's `custom(window.ethereum)` transport signs; the
  app never touches a private key.

## What stays private

Shielding is a public deposit: the amount you deposit is visible. What is hidden
is **who can spend it**: the note commitment reveals nothing, so later private
sends and cash outs are unlinkable to this deposit. See
[`examples/pay-bot`](../pay-bot) for the private-send path and the
[SDK docs](https://gloam.trade/docs/sdk) for the full surface.
