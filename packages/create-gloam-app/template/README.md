# {{PROJECT_NAME}}

A private payments app on **Robinhood Chain**, scaffolded with
[`create-gloam-app`](https://www.npmjs.com/package/create-gloam-app) and powered
by [`@gloamtrade/sdk`](https://gloam.trade/docs/sdk).

It shields a private USDG balance in the browser: connect a wallet, prove the
shield client-side, approve the pool, deposit via `shieldBound()`, and read the
balance back from the pool with `commitmentSeen()`. The note secret is stored in
`localStorage` and never leaves the client.

## Run

```bash
npm install
npm run dev
```

`npm run dev` fetches the shield circuit into `public/circuits`, then starts on
http://localhost:3000.

| Network | How | Chain id | What you need |
| --- | --- | --- | --- |
| Robinhood Chain mainnet | the default, or `NEXT_PUBLIC_GLOAM_NETWORK=robinhood-mainnet` | `4663` | USDG, and a little ETH for gas |
| Robinhood Chain testnet | `NEXT_PUBLIC_GLOAM_NETWORK=robinhood npm run dev` | `46630` | Test ETH from the [Robinhood faucet](https://faucet.testnet.chain.robinhood.com/), test USDG from the [Paxos faucet](https://faucet.paxos.com/) |

On mainnet, deposit limits apply: at most 50,000 USDG per deposit and 2,500,000 USDG
across the pool. Direct deposits and private payments are free; cashing out
costs 0.5%.

## Where to go next

- `app/page.tsx` is the whole flow: picking the network, `buildShieldBoundIntent`,
  the approval, wallet signing, and the balance read. Start there.
- Add **cash out** and **private send** with `buildUnshieldIntent` /
  `buildPrivateSendIntent` + `syncTree`. See the
  [SDK reference](https://gloam.trade/docs/sdk/reference).
- Add **selective disclosure** to prove a balance to a chosen party. See the
  [disclosure guide](https://gloam.trade/docs/sdk/disclosure).

## Notes

- Mainnet proofs use the final keys from the trusted setup (13 contributors);
  testnet proofs use the dev keys. `circuitArtifactUrls` picks the right one.
- The note secret is the only spend authority. `localStorage` is per-browser; a
  real app, and anything on mainnet, must back it up.
- Artifacts are fetched from `https://www.gloam.trade/circuits` by default (the
  final keys under `/final`). Point `GLOAM_ARTIFACTS_SOURCE` (build-time
  download) or `NEXT_PUBLIC_GLOAM_ARTIFACTS` (browser fetch, needs CORS, same
  layout) elsewhere to self-host them.
