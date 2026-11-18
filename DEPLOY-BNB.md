# Deploy Gloam to BNB Chain

Launch-day runbook for BNB Chain mainnet (BNB Smart Chain, chain id **56**, gas in BNB,
blocks about every 0.45 s). You run it with your own keys; no agent and no CI deploys it.
Every value was checked on chain on 18 November 2026, and the whole runbook was rehearsed
on a local fork of BNB Chain the same day (step 0), with every planned address landing
where this file says.

Same vault as every other mainnet (`ShieldPoolPayments`, the ceremony's final keys, the
0.5% cash-out fee to the treasury), through the shared `contracts/script/MainnetDeploy.sol`,
and **born guarded** like Elysium: in the same run the deploy hands ownership to a
`VaultOwnerGuard`, so its proof checkers can never be swapped and its ownership can never
move. The guard's controller is the Gloam Owner Safe (2 of 3), replayed on BNB Chain at its
usual address first.

The app shows BNB Chain only when `NEXT_PUBLIC_BNB_ENABLED` is `1` **and** the pool is in
(`packages/sdk/src/bnb.ts`). It is off by default: a preview build or a missing variable
hides it. With it off, BNB Chain appears nowhere.

## What is different on BNB Chain

- **USDT and USDC have 18 decimals here**, not 6. Every limit is computed from each token's
  `decimals()` read on chain (`bnb-mainnet-env.sh`), and the deploy script refuses a
  per-deposit limit under one whole token, so a raw value copied from Base (which would cap
  USDT at 0.00000005) stops the dry run.
- **The public RPCs keep about a day of logs.** publicnode keeps about 27 hours and answers
  an *empty list* for older blocks, as if nothing happened there. BNB Chain's own dataseeds
  refuse log reads. Every app, relay, SDK and MCP read for BNB Chain goes through a check
  (`guardPrunedLogs` in `packages/sdk/src/rpc.ts`): an empty answer about old blocks is
  checked against USDT's logs at the same blocks, and if those are missing too the read fails
  loudly instead of reading as "no deposits". So the server **needs a keyed RPC that keeps
  every log** (`GLOAM_RPC_URL_56`, step 10) before the flag goes on.
- **All four assets are listed in the deploy itself**, so none waits on the 3-day timelock.

## The plan

| Item | Value |
| --- | --- |
| Deployer | `0xec9993765e249e8e9DC677B7BCB61F78b31c6b60` (the Elysium deployer; nonce 0 on BNB Chain on 18 Nov 2026) |
| PoseidonT3 | `0x62c435CE6886fa91e3b0e91500c6dC9219723457` (deployer nonce 0, same as Elysium) |
| Vault (`ShieldPoolPayments`) | `0x89d3042390204f57b8b4F8949D3c2203E4002164` (nonce 8, same address and same code as Elysium) |
| `VaultOwnerGuard` | `0x633B24cf4C48CF68cB815BC87C110c47E218B4af` (nonce 16, after the four listings) |
| Memo board (`GloamPayMemo`) | `0xb692c86B13f65a123f45cF9A21580b2dDC7B8a79` (nonce 21) |
| Guard controller | Gloam Owner Safe `0x8E74b2b85b40f36771f92392b42BBaeacDC75507`, 2 of 3 |
| Fee | 0.5% of each cash out, to the treasury `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` |

These addresses hold only if the deployer sends nothing else on BNB Chain first. If its
nonce is not 0, everything still works; the addresses differ and the after-deploy script
records the real ones. The older `0x39E2…0194` vault address used on Base and Ethereum
cannot be reproduced on BNB Chain (that deployer's key is retired).

### Assets and launch limits (confirm before the deploy)

| Asset | Address | Decimals | Per deposit | Total |
| --- | --- | --- | --- | --- |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 | no limit | no limit |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | no limit | no limit |
| BNB | native, `address(0)` | 18 | no limit | no limit |
| BDX | `0x6ad12E761b438beA3EA09F6C6266556Bb24C2181` | 9 | 100,000 | 2,000,000 |

This mirrors what is live on Base today (read on chain 18 Nov 2026: USDC, EURC, USDT and ETH
at `type(uint128).max`, BDX at 100,000 / 2,000,000). "No limit" is `type(uint128).max`; the
app, SDK and MCP read it as no limit. BDX is Beldex's LayerZero OFT, the same contract and
owner as on Base and Ethereum (`token()` is itself). Lowering any limit later is instant
(the Safe calls `lowerDepositLimit` through the guard, down to 0 / 0 to close an asset);
raising one takes the 3-day timelock.

To launch with caps instead, set them in whole tokens before step 3 and they are converted
with each token's decimals:

```bash
export BNB_STABLE_LIMITS=50000/2500000    # USDT and USDC, like the older stablecoin caps
export BNB_NATIVE_LIMITS=20/1000          # BNB
export BNB_BDX_LIMITS=100000/2000000      # the default
```

Keep the same three set for step 8, which checks the chain against them.

## Cost (measured)

On the fork rehearsal (step 0), at BNB Chain's gas price of 0.05 gwei on 18 Nov 2026:

| Step | Gas | BNB at 0.05 gwei | BNB at 1 gwei |
| --- | --- | --- | --- |
| Safe replay | 306,200 | 0.000015 | 0.0003 |
| PoseidonT3 | 2,157,126 | 0.000108 | 0.0022 |
| Deploy (20 transactions) | 7,385,692 | 0.000369 | 0.0074 |
| Memo board | 152,323 | 0.000008 | 0.0002 |
| Safe accepts the guard | about 100,000 with the Safe's own overhead | 0.000005 | 0.0001 |
| **Total** | **about 10.1M** | **about 0.0005** | **about 0.01** |

On the same fork, a first deposit used about 1.69M gas, a private send 1.89M, a cash out
0.46M to 0.83M.

## Check first (stop if any fails)

All of these held on 18 Nov 2026. Run them again on the day.

```bash
export RPC_URL=https://bsc-dataseed.bnbchain.org
cast chain-id --rpc-url $RPC_URL                                                           # 56
cast nonce 0xec9993765e249e8e9DC677B7BCB61F78b31c6b60 --rpc-url $RPC_URL                    # 0
cast code 0x8E74b2b85b40f36771f92392b42BBaeacDC75507 --rpc-url $RPC_URL                     # 0x until step 1
for t in 0x55d398326f99059fF775485246999027B3197955 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181; do
  cast call $t 'symbol()(string)' --rpc-url $RPC_URL; cast call $t 'decimals()(uint8)' --rpc-url $RPC_URL
done                                                                                        # USDT 18, USDC 18, BDX 9
cast call 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181 'token()(address)' --rpc-url $RPC_URL   # itself: the OFT
cast code 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url $RPC_URL | wc -c              # Multicall3 is there
cast gas-price --rpc-url $RPC_URL                                                           # about 50000000 (0.05 gwei)
```

- [ ] **The keyed RPC for `GLOAM_RPC_URL_56`** keeps every log. Any provider's archive or
  full-history plan for BNB Chain will do (you pick it and make the account; no agent does).
  Check it with the same test the app runs: USDT logs in three blocks well over a day old must
  come back non-empty.
  ```bash
  K=<the keyed URL>; H=$(cast block-number --rpc-url $K)
  cast logs --from-block $((H-1000000)) --to-block $((H-999998)) --address 0x55d398326f99059fF775485246999027B3197955 --rpc-url $K | head -3
  ```
  Empty output means the plan prunes logs: pick another. Note its largest `eth_getLogs` range
  too (the app reads 50,000 blocks a call and splits on a range error).

## Steps

From `contracts/` in a fresh worktree of `main` (with `pnpm install` done, and
`cd circuits && npm install` for step 4).

0. **Rehearse on a fork.** No key, nothing leaves your machine:
   ```bash
   ./bnb-mainnet-rehearsal.sh
   ```
   It starts anvil on a fork of BNB Chain, replays the Safe, deploys from the planned
   deployer, adds the memo board, has the Safe accept the guard and runs the read-back into
   a temp folder. It must end with "Rehearsal passed" and print each planned address.
   `BNB_FORK=1 forge test --match-path test/fork/BnbMainnetFork.t.sol -vv` also pushes real
   USDT, BDX and BNB through the forked vault with final-key proofs.

1. **Replay the Gloam Owner Safe on BNB Chain.** Safe 1.5.0's factory, singletons and
   handlers are at their usual addresses on BNB Chain, so sending the Safe's exact creation
   calldata to the factory creates the same Safe (same address, same three signers, threshold
   2). Anyone can send it; the owner wallet `0x76b7…D4D8` already holds 0.0042 BNB there,
   enough for this and step 7.
   ```bash
   FACTORY=$(jq -r .factory test/fixtures/bnb-safe-replay.json)
   DATA=$(jq -r .calldata test/fixtures/bnb-safe-replay.json)
   cast call $FACTORY $DATA --rpc-url $RPC_URL           # must print ...8e74b2b85b40f36771f92392b42bbaeacdc75507
   cast send $FACTORY $DATA --rpc-url $RPC_URL --interactive   # or send the same data from the wallet you use
   cast call 0x8E74b2b85b40f36771f92392b42BBaeacDC75507 'getOwners()(address[])' --rpc-url $RPC_URL
   cast call 0x8E74b2b85b40f36771f92392b42BBaeacDC75507 'getThreshold()(uint256)' --rpc-url $RPC_URL   # 2
   ```
   The calldata is the input of the Safe's creation on Robinhood Chain (tx `0x7fd9f61f…484b`,
   12 Nov 2026). The Safe app lists BNB Chain (short name `bnb`); once the Safe has code it
   shows up there for the same signers.

2. **Fund, in BNB.** The deployer `0xec99…6b60`: **0.02 BNB** (the deploy uses about 0.0005
   at 0.05 gwei and 0.01 at 1 gwei; forge also wants headroom for its gas limits, 1.3x its
   estimates). The relayer `0xb1E9…512e`: **0.05 BNB** to start, an hour of relayed sends at
   the default cap. Send nothing from the deployer itself before step 6.

3. **Settings.**
   ```bash
   export RPC_URL=https://bsc-dataseed.bnbchain.org   # or your keyed RPC; it stays in this shell
   source bnb-mainnet-env.sh
   ```
   It refuses unless the RPC is chain 56 and each token's symbol is right, reads each
   token's decimals and sets the limits from them, sets the 0.5% fee to the treasury, names
   the Safe as `GUARD_CONTROLLER`, reads the deployer key hidden, and prints each value next
   to what it must be (nonce 0, the Safe's three owners and threshold 2, the gas to create a
   verifier).

4. **PoseidonT3.**
   ```bash
   POSEIDON_T3_ONLY=1 PRIORITY_FEE_GWEI=0.05 node circuits/scripts/deploy-poseidon.mjs
   export POSEIDON2=0x62c435CE6886fa91e3b0e91500c6dC9219723457   # or what it printed
   cast code $POSEIDON2 --rpc-url $RPC_URL | cast keccak            # 0x354b2699…e7da
   ```
   `PRIORITY_FEE_GWEI=0.05` tips what BNB Chain charges instead of ethers' fixed 1.5 gwei.

5. **The vault, born guarded.**
   ```bash
   forge script $SCRIPT --rpc-url $RPC_URL                       # dry run, must end "Guard checks passed"
   forge script $SCRIPT --rpc-url $RPC_URL --broadcast --slow
   ```
   One run, 20 transactions: verifiers (refused unless they hold the final keys), vault,
   limits on, shield verifier, the four listings, fee, guard, ownership to the guard, setup
   ended, guard accepts, controller seat offered to the Safe. It reads it all back and fails
   on any mismatch. If it stops partway, use `--resume`; never start fresh once a transaction
   landed.

6. **Memo board.**
   ```bash
   forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL --broadcast --slow
   ```

7. **The Safe accepts the guard.** A Safe transaction to the guard
   `0x633B24cf4C48CF68cB815BC87C110c47E218B4af` (or the address step 5 printed), value 0,
   data `0x9bc21c0c` (`cast sig 'acceptController()'`), two signatures. Note its hash.
   Until then the deployer can only do what the guard forwards (limits and the fee), never
   touch a verifier.

8. **Read back and record.**
   ```bash
   ACCEPT_CONTROLLER_TX=0x... ./bnb-mainnet-after-deploy.sh
   ```
   Reads only. Stops at the first thing off: every deploy transaction from the deployer and
   successful, setup ended, limits on, fee and treasury, the guard owns the vault and refuses
   `setVerifier`, the Safe is the controller with its three signers and threshold 2, the
   verifiers hold the final keys, each asset's limit in its own decimals, BDX is the OFT, and
   the vault, verifiers and adapters byte for byte Elysium's. If all is right it writes
   `deployments/bnb-mainnet.json` and the pool, block and memo board into
   `packages/sdk/src/bnb.ts`. It warns if the relayer holds under 0.05 BNB.

9. **Verify the source.** On BscScan (an Etherscan API V2 key works for chain 56) and on
   Sourcify, which needs no key, with the same loop as DEPLOY-ETHEREUM.md step 8 over
   `broadcast/DeployBnbMainnet.s.sol/56/run-latest.json` (`CHAIN=56`). The guard is
   `src/VaultOwnerGuard.sol:VaultOwnerGuard`, constructor `(vault, deployer)`; the memo board
   is `src/GloamPayMemo.sol:GloamPayMemo`. PoseidonT3 is raw circomlibjs bytecode; the code
   hash check in step 4 stands in for verification.

10. **The switch-on PR and Vercel.** From the repo root, on a branch:
    ```bash
    (cd packages/sdk && npm test) && (cd mcp && npm test)
    (cd app && npx tsc --noEmit && ../mcp/node_modules/.bin/tsx scripts/selftest-bnb.mts && ../mcp/node_modules/.bin/tsx scripts/selftest-bnb-everywhere.mts)
    ```
    Commit `packages/sdk/src/bnb.ts` and `contracts/deployments/bnb-mainnet.json`, PR,
    merge. Then on Vercel:

    | Variable | Where | Value |
    | --- | --- | --- |
    | `GLOAM_RPC_URL_56` | server only, **required** | the keyed RPC that keeps every log (Check first) |
    | `NEXT_PUBLIC_BNB_ENABLED` | build | `1` |
    | `NEXT_PUBLIC_BNB_LIVE_SINCE` | build, **required with the flag** | the day, as the copy writes dates: `21 November 2026` |
    | `GLOAM_RELAY_HOURLY_SPEND_56` | server, optional | BNB the relay may spend an hour, default `0.05` |
    | `GLOAM_RELAY_MAX_GAS_GWEI_56` | server, optional | the relay's gas price ceiling, default `1`; `off` for none |
    | `NEXT_PUBLIC_BNB_ARCHIVE_RPC_URL` | build, optional | an archive RPC for the browser's old logs. Not needed: without it the browser asks gloam.trade's `/api/rpc/56`, which reads through `GLOAM_RPC_URL_56`. If you set it, its key is in the page, so restrict it to gloam.trade |

    Redeploy. Set `GLOAM_RPC_URL_56` before or with the flag: without it, every read about
    blocks older than about a day fails loudly (on purpose), so the vault tree, stats and
    payment scans stop a day after launch.

    Then BNB Chain shows everywhere the app lists its chains, last among the mainnets, with
    its own mark (`public/brand/chains/56.png`) and gas in BNB.
    `scripts/selftest-bnb-everywhere.mts` checks the lists both ways and fails on any ungated
    BNB Chain copy.

### Static copy (it can't read the flag)

READMEs, `AGENTS.md`, npm and plugin manifests, SKILL.md files and `server.json` name five
mainnets. Once BNB Chain is live, find them with

```bash
git grep -n "Elysium" -- ':!app/src' ':!videos' ':!DEPLOY-*' | grep -i "mainnet"
```

and add BNB Chain last (no partnership wording). Then release `@gloamtrade/sdk` and
`@gloamtrade/mcp` with the pool in (pnpm publish), so what npm installs can reach the vault.

### Not on BNB Chain yet (on purpose)

- **Private swaps:** no router there. The SDK, MCP and app refuse a swap on BNB Chain by name.
- **Bringing money over into the BNB Chain vault (Relay):** BNB Chain stays a source chain
  for the bridge, as today. A private landing in the BNB Chain vault is not wired; add a
  `BRIDGE_DESTINATIONS` entry (`app/src/lib/bridge.ts`) after a landing is proven end to end.
- **Partner links:** BNB Chain has a public mempool, so it is in `PUBLIC_MEMPOOL_CHAINS`
  (`app/src/lib/partnerCode.ts`): only relay-sent link payments count there.
- **Short links:** no table ids for BNB Chain yet, so its claim and request links are written
  out in full (id 0), which every reader understands. Give ids in `packages/sdk/src/shortLink.ts`
  in a later release; ids are forever, so pick them once.
- **Turnkey gas sponsorship:** not checked for BNB Chain. A Gloam wallet there pays its own BNB.

## Before you announce

- [ ] One small deposit of each asset, a private send and a cash out in the app, with gas in BNB.
- [ ] The relayer paid for a relayed send; check its BNB balance after.
- [ ] `/stats` and `/transparency` show the deposits a day later (that proves `GLOAM_RPC_URL_56`
      serves old logs; with a pruned RPC they fail loudly instead).
- [ ] No partnership wording anywhere: Gloam supports BNB Chain, nothing more.

## Do not

- Do not set `NEW_OWNER`: the script refuses it, the guard is the owner.
- Do not use the deployer for anything before step 6 is done.
- Do not turn the flag on before `GLOAM_RPC_URL_56` is set.
- Do not put a keyed RPC in `packages/sdk/src/bnb.ts`: it ships on npm, and the SDK refuses to load with one.
