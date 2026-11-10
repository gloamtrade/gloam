# create-gloam-app

Scaffold a private payments app on **Robinhood Chain** in one command, powered by
[`@gloamtrade/sdk`](https://gloam.trade/docs/sdk): private stablecoin payments,
live on mainnet and testnet.

```bash
npm create gloam-app@latest my-private-app
# or
npx create-gloam-app my-private-app
```

Then:

```bash
cd my-private-app
npm install
npm run dev
```

Open http://localhost:3000, connect a wallet, and shield your first private USDG.

- **Mainnet** (the default): Robinhood Chain,
  chain id `4663`. You need USDG and a little ETH for gas. Gloam has
  deposit limits of 50,000 USDG per deposit and 2,500,000 USDG
  across the pool. Direct deposits and private payments are free; cashing out
  costs 0.5%. Proofs use the final keys from the trusted setup.
- **Testnet**: Robinhood Chain testnet, chain id `46630`, on the dev keys.
  Run with `NEXT_PUBLIC_GLOAM_NETWORK=robinhood`. Get test
  ETH from the [Robinhood faucet](https://faucet.testnet.chain.robinhood.com/)
  and test USDG from the [Paxos faucet](https://faucet.paxos.com/).

## What you get

A minimal Next.js (App Router) app that shields a private USDG balance in the browser:

- **Client-side proving.** The shield proof is generated in the browser with
  snarkjs. The circuit is fetched into `public/circuits` automatically, with the
  dev key for testnet and the final key (under `final/`) for mainnet, each
  checked against its pinned SHA-256.
- **The note never leaves the client.** Its secret is the only spend authority.
- **No backend.** The private balance is read straight from the pool with
  `commitmentSeen()`.
- **Wallet signing only.** viem's injected transport signs the approval and the
  deposit; the app never touches a key.

`app/page.tsx` is the whole flow. From there, add cash out, private send, and
selective disclosure with the rest of the SDK. See the
[docs](https://gloam.trade/docs/sdk).

## Notes

`NEXT_PUBLIC_GLOAM_NETWORK` picks the network: `robinhood-mainnet` or
`robinhood`. Unset, the app uses Robinhood Chain mainnet when the installed
`@gloamtrade/sdk` has its pool, and testnet otherwise. Requires Node 20.9+, as Next does.
