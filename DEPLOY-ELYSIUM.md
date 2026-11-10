# Deploy Gloam to Elysium

Launch-day runbook for Elysium mainnet, Kinetiq's Hyperliquid L2 (Arbitrum Orbit,
settles to HyperEVM 999, gas in HYPE, blocks about every 100 ms, one sequencer at
launch). Mainnet is chain id **99901** (0x1863d), already in the SDK file; its public
RPC (`https://rpc.elysium.kinetiq.xyz`), explorer (`https://elysium.kinetiq.xyz/explorer`) and USDC
(`0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65`) are in `packages/sdk/src/elysium.ts` too. The testnet (99801) has its own
section at the end and can be deployed now. You run it with your own
keys; no agent and no CI deploys it. Elysium mainnet launched on Sunday 9 November 2026, and
the vault was deployed the same day ([below](#deployed-on-9-november-2026)).

Same vault as every other mainnet (`ShieldPoolPayments`, the ceremony's final keys,
deposit limits, 0.5% cash-out fee to the treasury), through the shared
`contracts/script/MainnetDeploy.sol`. One difference: **the vault is born guarded.**
In the same run the deploy hands ownership to a `VaultOwnerGuard` (Kann I-02 fix), so
its proof checkers can never be swapped and its ownership can never move. The guard's
controller is `GUARD_CONTROLLER` (on Elysium mainnet the owner wallet `0x76b7…D4D8` for now;
`transferController` moves it to a Safe later), who can only change limits and the fee,
with the vault's 3-day notice for any raise.

Every value below is in, and the app shows Elysium while `NEXT_PUBLIC_ELYSIUM_ENABLED=1` is
set (on in production since 9 November 2026). Without the flag, or with a value missing,
Elysium appears nowhere.

## Deployed on 9 November 2026

The record is `contracts/deployments/elysium-mainnet.json`.

| Item | Value |
| --- | --- |
| Vault (`ShieldPoolPayments`) | `0x89d3042390204f57b8b4F8949D3c2203E4002164`, block `3248495` |
| `VaultOwnerGuard` (the owner) | `0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5`, controller the owner wallet `0x76b7…D4D8` |
| PoseidonT3 | `0x62c435CE6886fa91e3b0e91500c6dC9219723457` (not `0x1a32…`: a new deployer) |
| Deployer | `0xec9993765e249e8e9DC677B7BCB61F78b31c6b60` |
| Memo board | Not deployed yet (step 5) |
| Assets | USDC, 500 per deposit and 25,000 in total; 0.5% cash-out fee |

## The values

One file holds them all: `packages/sdk/src/elysium.ts` (`ELYSIUM_MAINNET`). The app
reads it too, and each value can be overridden on Vercel by its
`NEXT_PUBLIC_ELYSIUM_*` variable (list at the top of `app/src/lib/elysium.ts`).

| Value | Who fills it | From |
| --- | --- | --- |
| `chainId` | in already | 99901, Kinetiq's docs; `cast chain-id --rpc-url <RPC>` must agree. Anything else fails the build. |
| `rpcUrl` | you | A public https RPC that answers `eth_getLogs`, with **no API key in it** (the file is public and ships on npm; a keyed URL there throws). A keyed RPC, like Kinetiq's recommended `https://elysium-mainnet.g.alchemy.com/v2/{API_KEY}`, goes only in Vercel's `NEXT_PUBLIC_ELYSIUM_RPC_URL` (then in the browser bundle, so restrict the key to gloam.trade) or the server-only `GLOAM_RPC_URL_99901`. Pages, Glim and the MCP show it as `.../v2/{API_KEY}`. |
| `explorerUrl` | you | The block explorer, no trailing slash |
| `usdc` (+ `usdcDecimals` if not 6) | you | Kinetiq's or Circle's docs, checked on chain |
| `pool`, `deployBlock`, `payMemo`, `payMemoBlock` | `elysium-mainnet-after-deploy.sh` | the deploy |

Plus, for the deploy only: `GUARD_CONTROLLER`, the multisig that will run the guard.

## Check first (stop if any fails)

- [ ] **Chain id** `cast chain-id --rpc-url $RPC_URL` is 99901.
- [ ] **RPC** answers `eth_getLogs` over a wide range. Blocks come every ~100 ms (about 860,000 a day), and the app reads 1,000,000 blocks per call by default: `cast logs --from-block <head-1000000> --to-block latest --address 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url $RPC_URL` must answer. The testnet's public RPCs cap a call at 10,000 logs, not at a range (the app splits on that error). A keyed plan with a range cap: set `NEXT_PUBLIC_ELYSIUM_LOG_RANGE` to it.
- [ ] **USDC**: `cast call $ELYSIUM_USDC 'symbol()(string)'` is `USDC`, `decimals()(uint8)` is noted (6 expected), and the address is the one Circle or Kinetiq publish (one source says it is backed by native USDC on HyperEVM: confirm which contract is the canonical one, not a bridged look-alike). Check it has no transfer fee (the vault refuses fee-on-transfer tokens).
- [ ] **Orbit precompiles behave like Robinhood Chain's**: `cast call 0x0000000000000000000000000000000000000064 'arbChainID()(uint256)' --rpc-url $RPC_URL` returns the chain id, and `cast block latest --rpc-url $RPC_URL` shows normal block numbers and timestamps.
- [ ] **Gas in HYPE**: `cast gas-price` and the deploy-gas line from `elysium-mainnet-env.sh` (creating `ShieldVerifierFinal`, about 390k gas elsewhere, a little more on Orbit). Far above that means the parent-chain data cost is high: add `--gas-estimate-multiplier` as below.
- [ ] **Multicall3** at `0xcA11bde05977b3631167028862bE2a173976CA11` has code (the app batches reads through it; without it reads still work, slower).
- [ ] **A Safe** exists on Elysium for `GUARD_CONTROLLER`. If not, use the owner wallet `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` with `GUARD_CONTROLLER_EOA=1` and move it to a Safe later with `transferController`.
- [ ] **Deployer**: a fresh wallet (nonce 0) made for this deploy. The first deployer `0x891E…F411` was retired on 9 Nov 2026, so the Elysium vault lands at its own address, not `0x39E2…0194`; `elysium-mainnet-after-deploy.sh` records the real one.

## Steps

From `contracts/` in a fresh worktree of `main`.

1. **Fund, in HYPE.** The new deployer: enough for about 9M gas at the gas
   price you saw (keep a margin of several times that). Relayer
   `0xb1E994586E62994648a0b866BF33F2EDd942512e`: at least 0.5 HYPE to start (the
   after-deploy script warns under that; one relayed private send is about 1.9M gas).
   Send nothing from the deployer itself.
2. **Settings.**
   ```bash
   export RPC_URL=<rpc> ELYSIUM_USDC=<usdc> GUARD_CONTROLLER=<safe>   # ELYSIUM_CHAIN_ID defaults to 99901
   # export GUARD_CONTROLLER_EOA=1   # only if GUARD_CONTROLLER is a plain wallet
   source elysium-mainnet-env.sh
   ```
   It refuses unless the RPC's chain id matches, reads USDC's decimals and sets the
   launch limits (500 per deposit, 25,000 in total, the Base launch caps), sets the
   0.5% fee to the treasury, reads the deployer key hidden, and prints each value
   next to what it must be.
3. **PoseidonT3.**
   ```bash
   POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
   export POSEIDON2=0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4   # or what it printed
   cast code $POSEIDON2 --rpc-url $RPC_URL | cast keccak   # 0x354b2699…e7da
   ```
4. **The vault, born guarded.**
   ```bash
   forge script $SCRIPT --rpc-url $RPC_URL                       # dry run, must end "Guard checks passed"
   forge script $SCRIPT --rpc-url $RPC_URL --broadcast --slow     # add --gas-estimate-multiplier 300 if step 2 said so
   ```
   One run: verifiers (refused unless they hold the final keys), vault, limits, fee,
   guard, ownership to the guard, setup ended, guard accepts. It reads it all back and
   fails on any mismatch. If it stops partway, use `--resume`; never start fresh once a
   transaction landed.
5. **Memo board** (optional, recommended).
   ```bash
   forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL --broadcast --slow
   ```
6. **Controller handover** (skip if `GUARD_CONTROLLER` is the deployer). From the Safe,
   or the owner wallet, call `acceptController()` on the guard address step 4 printed:
   a Safe transaction to the guard, value 0, data `0x9bc21c0c`
   (`cast sig 'acceptController()'`), or from a plain wallet
   `cast send <guard> 'acceptController()' --rpc-url $RPC_URL --interactive`.
7. **Read back and record.**
   ```bash
   ACCEPT_CONTROLLER_TX=0x... ./elysium-mainnet-after-deploy.sh
   ```
   Reads only. Stops at the first thing off; if all is right it writes
   `deployments/elysium-mainnet.json` and the pool, block and memo board into
   `packages/sdk/src/elysium.ts`.
8. **Fill the rest of `packages/sdk/src/elysium.ts`**: `rpcUrl` (public, no key),
   `explorerUrl`, `usdc` (and `usdcDecimals`); `chainId` is 99901 already. Then from the repo root:
   ```bash
   (cd packages/sdk && npm test) && (cd mcp && npm test)
   (cd app && npx tsc --noEmit && ../mcp/node_modules/.bin/tsx scripts/selftest-elysium.mts && ../mcp/node_modules/.bin/tsx scripts/selftest-elysium-everywhere.mts)
   ```
   Branch, commit, PR, merge as usual.
9. **Verify the source.** On Sourcify if it lists Elysium, else the explorer's own
   verifier, with the same loop as DEPLOY-ETHEREUM.md step 8 over
   `broadcast/DeployElysiumMainnet.s.sol/$CHAIN/run-latest.json`. The guard is
   `src/VaultOwnerGuard.sol:VaultOwnerGuard`, constructor `(vault, deployer)`.
10. **Flip the flag.** On Vercel set `NEXT_PUBLIC_ELYSIUM_ENABLED=1` (and
    `NEXT_PUBLIC_ELYSIUM_RPC_URL`, so the CSP allows it even if you override the
    file), optionally `GLOAM_RELAY_HOURLY_SPEND_<chainId>` (default 1 HYPE an hour)
    and `GLOAM_RPC_URL_<chainId>` (a private RPC for the server). Redeploy. Then
    Elysium everywhere the app lists its chains: the network selector, the
    chain counts and lists in the copy ("five mainnets"), /docs (chain, SDK,
    reference, integrate, product, production, bridge and swaps notes), /stats,
    /transparency, /verify, /security, /disclosures, the whitepaper, the docs
    search, OG images, the admin network tabs and chain cards, the partner
    quickstart, Wallet X-ray, the relay, scheduled cash outs, agent top-ups, the
    remote MCP and Glim, each with Elysium's own mark (`public/brand/chains/elysium.png`)
    and gas in HYPE. `scripts/selftest-elysium-everywhere.mts` checks the lists
    both ways and fails on any ungated line of Elysium copy. A wrong value fails
    the build instead of going live.

Setting the flag before step 8 (no values yet) shows Elysium as "coming" in Glim,
/docs/chain#elysium and /verify, and nothing else. Leave it off until you want that.

### Static copy (it can't read the flag)

READMEs, npm and plugin manifests, SKILL.md files, server.json, AGENTS.md and the
contracts docs said Elysium support is "coming". The repo READMEs, AGENTS.md and the
package descriptions were switched to live on 10 November 2026. The plugin manifests, SKILL.md files,
the plugins README and server.json pin `@gloamtrade/mcp@0.8.0`, which has no Elysium, so
they keep "coming" until the next MCP release and its pin bump; the contracts docs are
the contracts owner's. To find what is left:

```bash
git grep -n Elysium -- ':!app/src' ':!videos' | grep coming
```

and switch each to "live" (keep Robinhood Chain, Tempo, Base and Ethereum first,
Elysium last, no partnership wording). Then release `@gloamtrade/sdk` and
`@gloamtrade/mcp` with the values in (pnpm publish), so the SDK docs the app now
shows match what npm installs.

### Not on Elysium yet (on purpose)

- **Bring money over (Relay):** live since 9 November 2026. `BRIDGE_DESTINATIONS` in
  `app/src/lib/bridge.ts` has an Elysium entry (USDC in, HYPE to USDC), and a private
  landing in the Elysium vault was proven end to end the same day (#243).
- **Private swaps:** no router on Elysium (`VAULT_SWAP_ROUTERS`, "not yet"). The SDK,
  MCP and app refuse a swap there by name.
- **Partner links:** Elysium is in `PUBLIC_MEMPOOL_CHAINS` (`app/src/lib/partnerCode.ts`),
  so only relay-sent link payments count there until it is checked that its sequencer
  shows nothing before a block. Take it out after that check.
- **Turnkey gas sponsorship:** Turnkey's gas station does not list Elysium, so a Gloam
  wallet there pays its own HYPE.

## Before you announce

- [x] Elysium's official mark is in: `app/public/brand/chains/elysium.png` (its avatar, circle-cropped), used for both networks.
- [ ] One small deposit, private send and cash out in the app, with gas shown in HYPE.
- [ ] The relayer pays for a relayed send; check its HYPE balance after.
- [ ] No partnership wording anywhere: Gloam supports Elysium, nothing more.
- [ ] Later, a release: `@gloamtrade/sdk` and `@gloamtrade/mcp` with the values in (publish with pnpm).

## Do not

- Do not set `NEW_OWNER`: the script refuses it, the guard is the owner.
- Do not reuse the deployer for anything before step 5 is done.
- Do not point the script at 99801 unless rehearsing (`ELYSIUM_ALLOW_TESTNET=1`).

## Elysium testnet (99801), now

Kinetiq's published testnet values are in `ELYSIUM_TESTNET` (`packages/sdk/src/elysium.ts`)
and were checked on chain on 7 November 2026: chain id 0x185d9, RPC
`https://testnet-rpc.elysium.kinetiq.xyz` (and Conduit's `https://rpc-elysium-testnet.t.conduit.xyz`),
explorer `https://elysium.kinetiq.xyz/testnet-explorer`, test USDC
`0x7D29d8047B905000459c0E80c34a26CeedcB47b2` (symbol USDC, 6 decimals), WHYPE
`0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234` (not a pool asset), Multicall3 at its usual
address, `eth_getLogs` over 20,000,000 blocks with a 10,000-log cap, about 110 ms a block.

It runs like Base Sepolia: the mainnet vault born guarded, the final keys, test USDC
only (500 / 25,000), the 0.5% cash-out fee. Network key `elysium`, behind its own switch
`NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED` and its pool.

1. Fund the deployer and relayer with testnet HYPE.
2. From `contracts/`: `export GUARD_CONTROLLER=<safe or owner wallet>` (plus
   `GUARD_CONTROLLER_EOA=1` for a wallet), then `source elysium-testnet-env.sh`
   (RPC defaults to Kinetiq's; it refuses any chain but 99801).
3. PoseidonT3, then `forge script script/DeployElysiumTestnet.s.sol:DeployElysiumTestnet --rpc-url $RPC_URL`
   (dry run), then the same with `--broadcast --slow`. Memo board as in step 5 above.
4. `./elysium-testnet-after-deploy.sh` writes `deployments/elysium-testnet.json` and the
   pool, block and memo into `ELYSIUM_TESTNET`.
5. Tests as in step 8, PR, merge; on Vercel set `NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED=1`.
   The testnet shows as Elysium with Testnet beside it. Gloam has no faucet there:
   test HYPE and USDC come from Kinetiq.
