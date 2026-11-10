# Deploy (Vercel)

One project. One domain. Docs live on the same app.

## Marketing + docs (`gloam.trade`)

| Field | Value |
| --- | --- |
| Root Directory | **`app`** |
| Framework | **Next.js** (auto) |
| Build Command | `pnpm run build` (or leave default) |
| Output Directory | **Leave empty** (do not set `.next`) |
| Install Command | `pnpm install` |
| Node | 20+ |

If Root Directory is the repo root instead of `app`, Vercel looks for `.next` at `/vercel/path0/.next` and fails with `ENOENT ... package.json`.

## Routes

| Path | Content |
| --- | --- |
| `/` | Landing |
| `/app` | The product: mainnet and testnet, switched in-app |
| `/app/trade?path=sealed` | Private trade (switched off on every network) |
| `/pitch` | Pitch deck |
| `/docs` | Docs overview |
| `/docs/*` | Guides and reference (`app/src/app/docs`): quickstart, sdk, agents, chain, bridge, payroll, proofs, private-swaps, privacy-model, threat-model, compare, production, partners and more |
| `/whitepaper` | Whitepaper |
| `/terms` `/privacy` `/cookies` `/disclosures` | Legal |

## Domains

- `gloam.trade` / `www` → this project (landing + `/docs` + `/app`)
- **No** `docs.gloam.trade` (use `/docs`)
- Product: `gloam.trade/app` (mainnet and testnet)
- Later: point `testnet.gloam.trade` at the same project (rewrite `/` → `/app` or keep path). No second codebase required.

## Docs

Canonical docs live in the app at `app/src/app/docs` and `app/src/app/whitepaper` (served from `gloam.trade/docs`). The old standalone `docs/` package was legacy and has been removed.

## Mainnet (deploy day)

Mainnet pools are not env vars. After each mainnet deploy (runbook: [`contracts/PRODUCTION.md`](./contracts/PRODUCTION.md)), fill `MAINNET_POOLS` in `app/src/lib/mainnet.ts` with the pool address and its deploy block; the deploy script prints both. Until a chain has both, that mainnet is hidden everywhere: the app, the API, the relay, the MCP server, Glim and proofs. Mainnet has been live since `MAINNET_LAUNCH_ISO` (21 October 2026, 13:00 UTC); stats count from it. The SDK keeps its own `MAINNET_POOLS` in `@gloamtrade/sdk`.

| Network | Pool (`ShieldPoolPayments`) | Deploy block |
| --- | --- | --- |
| Robinhood Chain mainnet `4663` | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` | `94194599` |
| Tempo mainnet `4217` | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` | `45172561` |
| Base mainnet `8453` | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` | `53109632` |
| Ethereum mainnet `1` | `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` | `26276183` |

Elysium mainnet (`99901`) is not in `MAINNET_POOLS`: its values live in `packages/sdk/src/elysium.ts` and show unless `NEXT_PUBLIC_ELYSIUM_ENABLED` is `0`, `false`, `off` or `no` (vault `0x89d3042390204f57b8b4F8949D3c2203E4002164`, block `3248495`). Runbook: [`DEPLOY-ELYSIUM.md`](./DEPLOY-ELYSIUM.md).

Base Sepolia (`84532`), Base's testnet, runs the mainnet pool too, so its pool is in `BASE_SEPOLIA_POOL` in the same file: `0x39e28cde55cab798874746ac52cb4b5cc99a0194` at block `49802958` (24 October 2026). Runbook: [`DEPLOY-BASE.md`](./DEPLOY-BASE.md).

Ethereum Sepolia (`11155111`) is the same: `ETHEREUM_SEPOLIA_POOL` in the same file holds its vault `0x465EbfcdE1e384C7B1e8388E1aFEA95438c7A0ef` at block `11992914` and its memo board `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` at block `11992942` (25 October 2026). Runbook: [`DEPLOY-ETHEREUM-SEPOLIA.md`](./DEPLOY-ETHEREUM-SEPOLIA.md).

| Variable (server only) | Value |
| --- | --- |
| `GLOAM_RPC_URL_4663` | A private Robinhood Chain mainnet RPC. The server tries it first, then the public `https://rpc.mainnet.chain.robinhood.com` |
| `GLOAM_RPC_URL_4217` | A private Tempo mainnet RPC. The server tries it first, then the public `https://rpc.tempo.xyz` |
| `GLOAM_RPC_URL_8453`, `GLOAM_RPC_URL_84532` | Private Base and Base Sepolia RPCs. The fallback is publicnode (`https://base-rpc.publicnode.com`, `https://base-sepolia-rpc.publicnode.com`), since Base's own public RPCs refuse wide `eth_getLogs` reads |
| `GLOAM_RPC_URL_1` | A private archive Ethereum RPC, **required**: the public ones serve only recent logs or a few blocks a read. The fallback is MEV Blocker (`https://rpc.mevblocker.io`) |
| `GLOAM_RELAY_MAX_GAS_GWEI_<chainId>` | The relay's gas ceiling on that chain, in gwei; `off` turns it off. Unset: 3 on Ethereum (`1`), none elsewhere. Over it the relay sends nothing (`gas_high`) and scheduled cash outs wait |
| `GLOAM_RELAY_HOURLY_SPEND_<chainId>` | The most the relay spends on gas in an hour on that chain, in its gas coin; `off` turns it off. Unset: 0.05 on Ethereum, 0.02 on Robinhood Chain, 0.01 on Base, 1 on Tempo, 1 HYPE on Elysium, none on the testnets. New sends stop at 80%, cash outs at 92%, and refunds and exits can use the rest |
| `GLOAM_RELAY_SENDER_SHARE_<chainId>` | The share of that chain's hourly cap one sender (an IP, or a partner account) may hold, in percent; `off` for none. Unset: 40. A sender may hold 200 sends' worth at the network's gas price, if that is more, up to 60%, so a 200-payment payroll fits at ordinary gas. Refunds and exits don't count toward it: where there's no swap floor, an IP's refunds and exits have a budget of their own, 2% of the cap or five of them, whichever is more |
| `GLOAM_RELAY_REVERT_SHARE_<chainId>` | The share of that chain's hourly cap one sender's reverted sends may burn, in percent; `off` for none. Unset: 10, or 20 sends' worth at the network's gas price if that is more, up to 60%. A send holds against it until its receipt shows it landed; one nobody saw land stays counted. Scheduled cash outs keep no IP, so they all hold as one sender against this share and the sender share |
| `GLOAM_RELAY_INFLIGHT_TTL_<chainId>` | How long, in seconds, one spend's lock lives on that chain (60 to 86,400). Unset: 900 on Ethereum, 180 elsewhere. A spend's last send is also kept on record for a day, and the spend is not sent again while that send may still land |
| `GLOAM_RELAY_IP_SENDS_<chainId>` | Sends one IP may ask for in 10 minutes on that chain; `off` leaves only the relay's own 400. Unset: 120 on Ethereum, none elsewhere |
| `GLOAM_RPC_URL_11155111` | A private Ethereum Sepolia RPC. The fallback is Tenderly's public gateway (`https://sepolia.gateway.tenderly.co`), then publicnode (`https://ethereum-sepolia-rpc.publicnode.com`), which keeps only about the last 10,000 blocks |
| `GLOAM_RELAY_MEMO_SECRET` | 32 or more random characters (`openssl rand -base64 32`). Signs the memo ticket the relay hands back with each private send, so the payer's heads-up gets its own few relayed messages. Unset, every relayed message but a partner key's shares one small allowance per payment, which a stranger can use up for a day |

Never put these behind `NEXT_PUBLIC_`. The same `GLOAM_RPC_URL_<chainId>` works for the testnets.

## Owner guard

Moves each mainnet vault's owner from the wallet `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` to [`VaultOwnerGuard`](./contracts/src/VaultOwnerGuard.sol), which forwards deposit limit and fee changes and the sweep of stray native coin, and nothing else. From then on `setVerifier` can never run on that vault and its ownership can never move. **It cannot be undone.** Nothing here runs from CI or an agent: the owner signs every step.

**When.** After all three of these:

1. The limit changes queued for 2 November are executed and the older 100x ones cancelled, on all four chains (`script/NoDepositLimits.s.sol`, `execute()` then `cancelStale()`). That script refuses a vault whose owner changed. The guard could run them (a queue entry survives an ownership move), but the handover is simpler to check on an empty queue.
2. An outside review has signed off one exact commit.
3. The trade-off below is accepted.

**Order.** Tempo, Ethereum, Base, Robinhood Chain: smallest vault first, in one sitting. From `contracts/`, with these for the commands below:

```bash
GUARD=<the address status() prints>
VAULT=0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194
OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8
S=script/DeployVaultOwnerGuard.s.sol:DeployVaultOwnerGuard
# Tempo https://rpc.tempo.xyz   Ethereum https://ethereum-rpc.publicnode.com
# Base https://base-rpc.publicnode.com   Robinhood Chain https://rpc.mainnet.chain.robinhood.com
```

1. **Freeze.** Check out the reviewed commit and `forge build`. Any change to the source, even a comment, moves the address. Set `GLOAM_OWNER_GUARD` in `app/src/lib/contractDirectory.ts` to the address and ship that first, so `/verify` reads a vault the guard holds as listed.
2. **Read the queue.** `node launch/queue-check.mjs` must exit 0. It rebuilds every chain's queue from its logs. If it flags a change, stop, work out who queued it, and cancel it with the owner wallet: once the guard holds the vault, nobody can.
3. **Read each chain.** `forge script $S --sig "status()" --rpc-url <RPC>` must give one address on all four, with the vault and factory code as expected, the owner wallet as owner, nobody offered, setup over.
4. **Deploy on each chain.** This moves nothing. The address does not depend on who sends it: the script deploys through the canonical CREATE2 factory, so only the salt and the init code decide it, and the init code is this build of `VaultOwnerGuard` with `$VAULT` and `$OWNER` (its first controller) as constructor arguments. Send it from the owner wallet, which owns the vault on all four chains; the old deployer `0x891E…F411` is retired and not needed. Forge asks for the key once.

   ```bash
   forge script $S --rpc-url <RPC> --sender $OWNER --interactives 1 --broadcast --slow
   ```

5. **Publish the source.** The constructor arguments go by hand: the creation transaction is the factory's, so forge cannot guess them.

   ```bash
   ARGS=$(cast abi-encode "constructor(address,address)" $VAULT $OWNER)
   forge verify-contract $GUARD src/VaultOwnerGuard.sol:VaultOwnerGuard --chain <id> --verifier sourcify --constructor-args $ARGS --watch
   forge verify-contract $GUARD src/VaultOwnerGuard.sol:VaultOwnerGuard --chain <id> --verifier etherscan --rpc-url <RPC> --constructor-args $ARGS --watch
   ```

6. **Read it yourself** (below), on at least one explorer.
7. **Hand over, chain by chain.** `node launch/serve-guard.mjs`, then open `http://127.0.0.1:4731/guard` in the browser with the owner wallet. Check that the address it shows is `$GUARD`: it works that out from this checkout's compile, and takes no address from a person or a link, because a look-alike at another address can carry the real runtime code with a controller handover already pending. It keeps both steps shut unless the code matches byte for byte and no handover is pending. Press **1. Offer the vault** (`transferOwnership(guard)` from the wallet) and **2. Accept through the guard** (`acceptVaultOwnership()`). Until step 2 the wallet is still the owner and can change its mind.
8. **Check that chain before the next.** `forge script $S --sig "check()" --rpc-url <RPC>` fails unless the guard owns the vault, nobody is offered it, setup is over, both proof checkers are as deployed and the filter refuses `setVerifier` and `setShieldVerifier`. Then, from the wallet, none of these may succeed (they simulate, nothing is sent):

   ```bash
   cast call $GUARD 'isAllowedChange(bytes)(bool)' $(cast calldata 'setVerifier(address)' $OWNER) --rpc-url <RPC>   # false
   cast call $GUARD 'queueChange(bytes)' $(cast calldata 'setVerifier(address)' $OWNER) --from $OWNER --rpc-url <RPC>   # reverts
   cast call $VAULT 'transferOwnership(address)' $OWNER --from $OWNER --rpc-url <RPC>   # reverts: NotOwner
   ```

9. **Hand the guard to the Safe, chain by chain.** The guard's controller is meant to be the Safe multisig, which is deployed and in the Safe app on Robinhood Chain (4663), Tempo (4217), Base (8453) and Ethereum (1). The owner wallet is its first controller: that is in the init code, so it fixes the address, and it is what signs step 7. Once `check()` passes on a chain, the wallet offers the guard to that chain's Safe, and the Safe claims it from the Safe app (`acceptController()` on `$GUARD`). Until the Safe claims it the wallet is still the controller, and `check()` fails while the handover is pending. Run `check()` again after, and read `controller()`:

   ```bash
   SAFE=<that chain's Safe, as the Safe app shows it>
   cast send $GUARD 'transferController(address)' $SAFE --interactive --rpc-url <RPC>   # the owner wallet's key
   cast call $GUARD 'controller()(address)' --rpc-url <RPC>   # $SAFE once it has accepted
   ```

   Elysium (99901) has no Safe yet. Its vault was born guarded (`deployments/elysium-mainnet.json`) and its guard stays with the owner wallet until a Safe exists there.
10. **After the last chain.** Record the guard, the four handover transactions and each chain's Safe as controller in `contracts/deployments/`. Update what names the wallet as owner: `contracts/README.md`, `contracts/ARCHITECTURE.md`, the root `README.md`, `/verify`, `/docs/chain`, `/docs/threat-model`, `/docs/production`, `/docs/compare`, `/whitepaper` and Glim's `telegramBot/knowledge.ts`. Those are written to stay true until then, and the claim "nobody can replace a proof checker" is safe to make only from this point, per chain.

**Read the source yourself.** The verified source is one file with no imports and no inheritance, so it can be read in one sitting. Check that:

- `IGuardedVault` at the top lists every vault function it can call. `setVerifier`, `setShieldVerifier`, `transferOwnership` and `endSetup` are not in it.
- Every write to the vault in the contract body is a typed `vault.<function>(...)` call. There is no `.call(`, `delegatecall`, `selfdestruct`, `assembly`, `fallback` or `receive` in the code (the words appear only in comments), and `vault` is `immutable`.
- `queueChange`, `executeChange` and `cancelChange` each carry `onlyAllowedChange(call)`, and `isAllowedChange` passes exactly two shapes: `setDepositLimit` at 100 bytes and `setWithdrawFee` at 68.
- Every function that writes is `onlyController`, except `acceptController`, which only the pending controller can call.
- The ABI on the explorer has 15 functions and nothing beyond those in the source.

**After it.** Owner actions go to the guard, with the same function names, so a call only changes its target, and once the Safe holds the guard they are signed in the Safe app. `/guard`'s last card does the three the controller needs while that is still the wallet. `script/NoDepositLimits.s.sol` and the finished queue scripts in `script/archive/` call the vault directly, so they stop at their owner check. The swap router's owner (`GloamVaultSwapV4b` on Robinhood Chain) is separate and stays the wallet: it can only queue and remove pools.

**The trade-off.** After this a bug in a proof checker can never be patched in place. The response is to leave the vault:

1. Close deposits at once: `lowerDepositLimit(asset, 0, 0)` for every asset on that chain, one transaction each, from `/guard`. There is no single switch, so keep the asset list ready.
2. Waive the fee at once: `lowerWithdrawFee(0)`.
3. Deploy a new vault with fixed checkers, and a new router, each new. If the fault is in a circuit or its keys, that means a new trusted setup first. The app sends new deposits there and shows the old vault as cash-out only.
4. People cash out of the old vault with `unshield` and deposit into the new one. That costs them privacy: the old crowd is gone and the new one starts empty.

Whether they can still exit depends on the bug:

| The bug | Can people exit? |
| --- | --- |
| Valid proofs still pass (a forgery bug, a bad circuit, leaked toxic waste) | Yes, nothing in the vault or the guard can block `unshield`. But neither can anything stop the attacker: `unshield` pays while `deposited[asset]` lasts, so it is a race, and anyone late gets `InsufficientPoolBalance`. A forged note can also be made by private `transfer`, unseen until it cashes out. |
| Valid proofs stop passing (a broken checker, or a chain changing or removing the BN254 precompiles) | **No, not ever.** Money behind the old checker stays where it is. Before the guard, a new checker could have rescued it after three days. |
| A bug in the deposit checker | Yes, and closing deposits stops it at once, since every deposit checks the limit. Notes already forged remain. This one could never be patched anyway: `setShieldVerifier` is one-way and already set. |

Three more things to know:

- Before the guard, a forgery bug already gave an attacker three days, because a new verifier had to wait out the same timelock in public. So the guard takes away the patch for a bug nobody is exploiting yet, not a fast response.
- What it costs most is people who never come back: an in-place patch protected them, and a new vault does not.
- Closing deposits also closes the refund path of a swap. A note sent to a swap's escrow but not swapped comes back through `shieldBound`, so it waits until the controller raises that asset's limit again through the timelock.

## Testnet vault env (optional)

Defaults are hard-coded for the current Robinhood Chain testnet vault. You do not need these env vars.

| Variable | Correct value | Do not set |
| --- | --- | --- |
| `NEXT_PUBLIC_POSEIDON_SHIELD_POOL` | `0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740` | `0x4F38…12D8F` (drainable, audit H-P1), `0xAc25…`, `0xaEbB…`, `0xA488…` (superseded). The app remaps all four to the current vault (`SUPERSEDED_POOLS` in `app/src/lib/config.ts`), but a clean env is better |
| `NEXT_PUBLIC_SHIELD_DEPLOY_BLOCK` | `126185021` | `90260331`, `90436718`, `110840714`, `120461692` (superseded pool history) |
| `NEXT_PUBLIC_HASH_SCHEME` | Legacy: leave it unset (`poseidon` is the default) | `keccak` (the Phase-1 pool, history only) |

**Hygiene:** omit these envs entirely if the hard-coded defaults are fine. A superseded pool address or deploy block is remapped at runtime; for the pre-sealed `0xA488…` and block `90260331`, Settings → vault health also shows a remapped warning.

Admin: `ADMIN_ACCESS_CODE` (server-only).

People counts: `GLOAM_METRICS_SALT` (server-only), 32 or more random characters (`openssl rand -hex 32`). The server turns each wallet that uses the app into HMAC-SHA256 of this secret and the address, and adds that to Redis HyperLogLog counters (`app/src/lib/peopleStore.ts`), so /admin shows how many different people use Gloam without keeping any address. Unset, it is derived from `GLOAM_RELAY_MEMO_SECRET` (HMAC-SHA256 of the memo secret and a fixed label), so counting runs on mainnet with no extra step; with neither set, nothing is counted. Set it once and keep it, and keep the memo secret too while it stands in: a new value counts everyone again. Keep it on Vercel only, never in Redis or behind `NEXT_PUBLIC_`.
