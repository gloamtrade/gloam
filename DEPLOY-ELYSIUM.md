# Deploy Gloam to Elysium

Launch-day runbook for Elysium mainnet, Kinetiq's Hyperliquid L2 (Arbitrum Orbit,
settles to HyperEVM, gas in HYPE, one sequencer at launch). You run it with your own
keys; no agent and no CI deploys it. Elysium mainnet launches Sunday 9 November 2026.

Same vault as every other mainnet (`ShieldPoolPayments`, the ceremony's final keys,
deposit limits, 0.5% cash-out fee to the treasury), through the shared
`contracts/script/MainnetDeploy.sol`. One difference: **the vault is born guarded.**
In the same run the deploy hands ownership to a `VaultOwnerGuard` (Kann I-02 fix), so
its proof checkers can never be swapped and its ownership can never move. The guard's
controller is `GUARD_CONTROLLER` (a multisig), who can only change limits and the fee,
with the vault's 3-day notice for any raise.

Everything in the repo is ready and off. Elysium appears nowhere until
`NEXT_PUBLIC_ELYSIUM_ENABLED=1` **and** every value below is in.

## The values

One file holds them all: `packages/sdk/src/elysium.ts` (`ELYSIUM_MAINNET`). The app
reads it too, and each value can be overridden on Vercel by its
`NEXT_PUBLIC_ELYSIUM_*` variable (list at the top of `app/src/lib/elysium.ts`).

| Value | Who fills it | From |
| --- | --- | --- |
| `chainId` | you | Kinetiq's docs; `cast chain-id --rpc-url <RPC>` must agree. Not 99801 (testnet). |
| `rpcUrl` | you | A public https RPC that answers `eth_getLogs` |
| `explorerUrl` | you | The block explorer, no trailing slash |
| `usdc` (+ `usdcDecimals` if not 6) | you | Kinetiq's or Circle's docs, checked on chain |
| `pool`, `deployBlock`, `payMemo`, `payMemoBlock` | `elysium-mainnet-after-deploy.sh` | the deploy |

Plus, for the deploy only: `GUARD_CONTROLLER`, the multisig that will run the guard.

## Check first (stop if any fails)

- [ ] **Chain id** from Kinetiq's docs matches `cast chain-id --rpc-url $RPC_URL`, and is not 99801.
- [ ] **RPC** answers `eth_getLogs` over a wide range: `cast logs --from-block 0 --to-block 50000 --rpc-url $RPC_URL` returns or errors with its limit. If its limit is under 50,000 blocks, set `NEXT_PUBLIC_ELYSIUM_LOG_RANGE` to it.
- [ ] **USDC**: `cast call $ELYSIUM_USDC 'symbol()(string)'` is `USDC`, `decimals()(uint8)` is noted (6 expected), and the address is the one Circle or Kinetiq publish (one source says it is backed by native USDC on HyperEVM: confirm which contract is the canonical one, not a bridged look-alike). Check it has no transfer fee (the vault refuses fee-on-transfer tokens).
- [ ] **Orbit precompiles behave like Robinhood Chain's**: `cast call 0x0000000000000000000000000000000000000064 'arbChainID()(uint256)' --rpc-url $RPC_URL` returns the chain id, and `cast block latest --rpc-url $RPC_URL` shows normal block numbers and timestamps.
- [ ] **Gas in HYPE**: `cast gas-price` and the deploy-gas line from `elysium-mainnet-env.sh` (creating `ShieldVerifierFinal`, about 390k gas elsewhere, a little more on Orbit). Far above that means the parent-chain data cost is high: add `--gas-estimate-multiplier` as below.
- [ ] **Multicall3** at `0xcA11bde05977b3631167028862bE2a173976CA11` has code (the app batches reads through it; without it reads still work, slower).
- [ ] **A Safe** exists on Elysium for `GUARD_CONTROLLER`. If not, use the owner wallet `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` with `GUARD_CONTROLLER_EOA=1` and move it to a Safe later with `transferController`.
- [ ] **Deployer nonce is 0** (`cast nonce 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411`), so the vault lands at `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` like everywhere else.

## Steps

From `contracts/` in a fresh worktree of `main`.

1. **Fund, in HYPE.** Deployer `0x891E…F411`: enough for about 9M gas at the gas
   price you saw (keep a margin of several times that). Relayer
   `0xb1E994586E62994648a0b866BF33F2EDd942512e`: at least 0.5 HYPE to start (the
   after-deploy script warns under that; one relayed private send is about 1.9M gas).
   Send nothing from the deployer itself.
2. **Settings.**
   ```bash
   export ELYSIUM_CHAIN_ID=<id> RPC_URL=<rpc> ELYSIUM_USDC=<usdc> GUARD_CONTROLLER=<safe>
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
8. **Fill the rest of `packages/sdk/src/elysium.ts`**: `chainId`, `rpcUrl`,
   `explorerUrl`, `usdc` (and `usdcDecimals`). Then from the repo root:
   ```bash
   (cd packages/sdk && npm test) && (cd mcp && npm test)
   (cd app && npx tsc --noEmit && NEXT_PUBLIC_ELYSIUM_ENABLED=1 ../mcp/node_modules/.bin/tsx scripts/selftest-elysium.mts)
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
    the network selector, relay, remote MCP, /verify, Glim and /docs/chain all show
    Elysium. A wrong value fails the build instead of going live.

Setting the flag before step 8 (no values yet) shows Elysium as "coming" in Glim,
/docs/chain#elysium and /verify, and nothing else. Leave it off until you want that.

## Before you announce

- [ ] Replace `app/public/brand/chains/elysium.svg` (a plain stand-in) with Elysium's official mark.
- [ ] One small deposit, private send and cash out in the app, with gas shown in HYPE.
- [ ] The relayer pays for a relayed send; check its HYPE balance after.
- [ ] No partnership wording anywhere: Gloam supports Elysium, nothing more.
- [ ] Later, a release: `@gloamtrade/sdk` and `@gloamtrade/mcp` with the values in (publish with pnpm).

## Do not

- Do not set `NEW_OWNER`: the script refuses it, the guard is the owner.
- Do not reuse the deployer for anything before step 5 is done.
- Do not point the script at 99801 unless rehearsing (`ELYSIUM_ALLOW_TESTNET=1`).
