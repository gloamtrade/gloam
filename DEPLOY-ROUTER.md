# Deploy the next swap router

The runbook for private swaps v3: `GloamVaultSwapV4c` on Robinhood Chain, Base and
Ethereum, and `GloamVaultSwapTempo2` on Tempo. The owner wallet deploys from a local
page in the browser. No agent, no CI and no script holds a key or sends anything.

**Don't deploy before an outside review.** This router moves user money and has not
had one. See [What to review first](#what-to-review-first).

## What this adds

- **Native ETH notes.** A swap can spend a native ETH note or make one, on Robinhood
  Chain, Base and Ethereum. WETH notes keep working. Either note can use a pool that
  holds ETH or one that holds WETH: the router converts at the ends of a route.
- **Base and Ethereum.** Uniswap v4, hookless pools only. See
  [stablecoin swaps](#stablecoin-swaps-on-base-and-ethereum).
- **An exit.** Money waiting at a swap's escrow can leave to an address the swap's
  one-time exit key signs for, when its refund can't land.
- **A deadline.** Each swap carries one in its escrow key, 30 minutes after it is made
  (`SWAP_DEADLINE_SECONDS`), or 10 on Base and Ethereum (`swapDeadlineSeconds`). The swap
  can't land after that. The deadline does not limit a forced refund: once someone has sent
  the swap's unshield alone, the money waits at the escrow and the same call puts it back as
  the refund note at any time, long after the deadline too. An exit has no deadline either.

## What it can't change

The deployed vault stays as it is. The routers before this one stay as they are too,
and a refund through them works the way it always has: it waits for room under the
vault's limit, with no exit. Only swaps made through the new router have one.

## The exit, and what it costs

A refund note is a deposit, so it needs room under the vault's limit for that asset.
The vault can't exempt it. While the limit is full, the money waits at the escrow.

Each swap names a throwaway exit key in its escrow key. The key comes from the refund
note's own secret, so whoever can spend the refund note can exit, and nobody else. The
escrow key fixes the exit key, so a caller who names another one gets another escrow,
and the vault rejects the proof. Nothing in a swap's proofs or calldata can sign for it.

The holder signs for an address. Anyone can send that signature, the relay included,
and it can only pay the address it names. The escrow pays that address itself, so the
money never passes through the router, and a token that blocks the router still pays an
exit. An exit can't go anywhere the money would stop for good: the escrow itself, the
router, the vault, the token's own contract, WETH or the PoolManager, or Tempo's DEX.
On Tempo, where a recipient's receive policy can hold a payment instead of refusing it,
`GloamVaultSwapTempo2` asks the TIP-403 registry first and reverts an exit the
recipient's policy would hold, and after the escrow pays it checks the recipient holds
the whole amount more, and reverts if not. The escrow opens once, so a refund and an exit can
never both happen.

**The trade-off: an exit is public.** It pays a public address the whole amount, next to
the swap. A refund stays private and costs up to 1%. An exit keeps everything that
arrived and gives up privacy for that one note. So the refund stays the normal way back.
The exit is for someone who would rather have the money now than wait for room.
A fresh address keeps the damage to that note, and the relay can pay the gas.

## Before you start

From `contracts/`, on the commit that was reviewed:

```sh
forge build
forge test
node launch/router-fixture.mjs   # rewrites nothing if the contracts are unchanged
git status                       # must show no change to test/fixtures/router-next.json
```

Dry run each chain. Nothing is sent, and no key is involved:

```sh
forge script script/DeployVaultSwapV4c.s.sol:DeployVaultSwapV4c --sig "dryRun()" --rpc-url https://rpc.mainnet.chain.robinhood.com
forge script script/DeployVaultSwapV4c.s.sol:DeployVaultSwapV4c --sig "dryRun()" --rpc-url https://mainnet.base.org
forge script script/DeployVaultSwapV4c.s.sol:DeployVaultSwapV4c --sig "dryRun()" --rpc-url https://ethereum-rpc.publicnode.com
```

Use a plain `forge build`. `--evm-version cancun`, which the fork tests need, builds
different bytecode, and the page refuses it.

**Any edit to the contracts moves the addresses,** a comment included, because the
bytecode carries a hash of its source. After one, run `router-fixture.mjs`, commit the
fixture, and update the addresses wherever they are pinned.

## Deploy

```sh
node launch/serve-router.mjs     # http://127.0.0.1:4732/router
```

Each chain has its own card, and they don't depend on each other. A card's Deploy stays
shut until the factory call has been simulated and lands at the pinned address, and
after it lands the card reads everything back: the code byte for byte, the vault, the
treasury, the PoolManager, WETH, the owner, every pool, and `escrowFor` against the
pinned escrow code.

| Chain | Router | Pools | Deploy gas |
| --- | --- | --- | --- |
| Robinhood Chain | `0x9CdA89fA6E6f796a1623C2086b2C710DCa64486d` | 45 | 4.8M |
| Base | `0x3A99f461bdbfc86fbd4e84ee80Bfb2fd73f3576a` | 7 | 3.7M |
| Ethereum | `0x2E0c06Ac42Cc6f0ecC3eDc86bC0d67F3c2DC7E6A` | 13 | 3.9M |
| Tempo | `0x991efFC6cA44BD578000d32C1351d78298BdBC0a` | no pools, its DEX | see the card |

These hold for the contracts in `test/fixtures/router-next.json`, which
`test_v3_predicted_addresses_are_pinned` checks.

## Switch a chain on

Deploying changes nothing. A chain goes live with one line in the app, and each chain's
switch stands alone.

1. Wait for the chain's card to read `Deployed and checked`.
2. If this is the first chain, publish the SDK. Its `VAULT_SWAP_ROUTERS` already lists
   these addresses, and the app and relay build against it, but an agent on an older npm
   version isn't refused a cash out to a router until it updates.
3. In `app/src/lib/vaultSwap.ts`, set `VAULT_SWAP_V3_LIVE[<chainId>]` to the router's address:
   `4663` Robinhood Chain, `8453` Base, `1` Ethereum, `4217` Tempo. It is `null` until then, and
   only the address pinned in `VAULT_SWAP_V3_ADDRESS` turns a chain on, so a typo stays off.
4. In the same PR, update `app/scripts/selftest-vault-swap.mts` and
   `app/scripts/selftest-swap-stable.mts`, which pin what ships: the `no chain is on` lines and
   the router expected first. The others follow the flags. Update the plain files listed below too.
5. Merge it. The swap tab, the docs, `/verify`, the vote exclusions and Glim all follow
   the flag. The cash-out guard needs no flag: it refuses these routers already.
6. Make one small real swap each way, one of them from an ETH note where the chain has
   one, and read both on the explorer.

This was rehearsed locally with all four chains on: `tsc` and the build passed, the docs
rendered each chain, and the swap tab quoted live pools on Base and Ethereum. Only the two
selftests that pin what ships failed, as step 4 expects.

**Which docs follow the flag.** `/docs/private-swaps`, `/docs/threat-model`, `/docs/chain`,
`/verify`, every page that names the swap chains (through `swapMainnets()`), the hosted MCP
server's text and Glim do, so they are true either side of a switch. `README.md`, `AGENTS.md`,
`mcp/README.md` and `packages/sdk/README.md` are plain files and can't: update their swap
lines in step 4.

**The switch only goes one way.** Once a chain has had a swap through the new router, do
not set its address back to `null`. The relay would stop knowing that router, and a refund or
an exit of a swap made through it would be refused. To stop swaps on a v4 chain, the owner
calls `removePool` for its pools: swaps through them revert with the note safe, and
refunds and exits never touch a pool. `GloamVaultSwapTempo2` has no owner and no pools.

## There is no fixed order

Deploying changes nothing for anyone, because no app or relay uses a router until it is
switched on. Each chain's deploy and switch stand alone. What matters is what each
step needs:

| Step | Needs | If it runs early |
| --- | --- | --- |
| Deploy on a chain | Outside review | Nothing breaks. The router sits unused. |
| New pool after deploy | The owner queues it, live 3 days later | Pools queued on the old router do not carry over. The list is in the constructor. |
| ETH swaps on Robinhood Chain | The vault's native ETH limit, ready 3 November at 17:08 UTC, executed | A swap into ETH reverts whole with `OverDepositLimit`, and the note stays in the vault. |
| AI and ORBIO on the new router | Their vault limits executed | The pools are live from deploy, but a swap into either reverts whole until the vault takes it. |
| The 0.50% cash-out fee (3 November, 15:30 UTC) | Nothing here | The router reads no fee. A quote made before it and landing after can come up short and revert whole, and the note stays. Through an older router a refund's 1% margin covers any fee the vault allows. Through a router with an exit a refund is sized from the fee when the swap is made, so if the fee rises past that with a proof still out, that refund can't land and the app offers the exit. The Ethereum floor halves by itself. |

## What happens to swaps in flight

A swap belongs to its router. Its escrow address comes from that router, and its
unshield proof names that escrow, so it can never land anywhere else.

- **Sent and landing:** finishes on the old router. Nothing about a switch touches it.
- **Reverted, proof still public:** it stays valid until the note is spent, as it does
  today. The app moves the note to a fresh one, which ends it.
- **Unshield sent alone:** the money waits at the old router's escrow. Only the old
  router can open it. The relay must keep every old router for this, for good: never
  remove one from the app's router list.

## Retiring the old router

1. Switch the chain on, as above. New quotes go to the new router, and the relay refuses
   a new swap on an older one with `swap_router_old`: a tab still holding an old quote gets
   a clear message and the note stays put. A refund through an older router still goes,
   because its note is already spent.
2. Wait at least an hour, the time the app gives a swap it never heard back from.
3. Optional, on Robinhood Chain: the owner calls `removePool` on `GloamVaultSwapV4b`
   for each pool. That stops swaps through it from any client. A swap still in flight
   reverts and its note stays safe, and refunds keep working, because they never touch a
   pool. It is a transaction per pool, and can't be undone except through the 3-day queue.

`GloamVaultSwapV4` and `GloamVaultSwapTempo` have no owner and can't be closed. They
stay callable for good by anyone holding a valid proof. That is harmless: they can only
do what they do now.

## Stablecoin swaps on Base and Ethereum

Holders voted for this. The router and the app carry it; each chain still waits for its
deploy and its switch.

**Pairs.** Base: USDC, USDT, EURC and ETH. Ethereum: USDC, USDT, USDG, EURC and ETH. Limits
are the vault's: 50,000 of a stablecoin per deposit, 2,500,000 in all. Every one of these
stablecoins has 6 decimals on these chains, and `selftest-swap-stable` pins that.

**Pools and depth, read on chain 2026-11-02 through Uniswap's quoter:**

| Pair | Best rate at $100 | At $10,000 | At $50,000 |
| --- | --- | --- | --- |
| Ethereum USDC to USDT | 1.0009 | 1.0009 | 1.0009 |
| Ethereum USDT to USDC | 0.9991 | 0.9991 | 0.9991 |
| Ethereum USDT to USDG, through USDC | 0.9990 | 0.9989 | 0.9989 |
| Ethereum USDC to EURC | 0.8956 | 0.8955 | 0.8954 |
| Base USDC to USDT | 1.0010 | 1.0008 | 0.8282, refused |
| Base USDT to USDC | 0.9990 | 0.9989 | 0.9987 |
| Base USDC to EURC | 0.8946 | 0.5563, refused | 0.1123, refused |
| Base EURC to USDC | 1.1141 | 0.1294, refused | 0.0263, refused |

**A pool that runs out at the market price keeps filling at a worse one.** It doesn't
revert: Base's EURC pool pays 13 cents on the dollar at $10,000. The router holds a swap to
the amount the person agreed to, so the app has to refuse a bad quote before anyone agrees:

- `IMPACT_STOP_BPS`: above 2% price impact the quote is refused, and the error names a size
  that fits. From 1% the tab warns.
- `PEG_STOP_BPS`: between two dollar stablecoins, under 98 cents on the dollar before fees
  is refused. Under 99.5 cents the tab says so.
- `VALUE_STOP_BPS`: at the marks the tab shows, a swap giving 4% less than it costs won't
  go, which is what covers EURC, as a euro pair has no peg. From 2% it warns.

All three are on Base and Ethereum only. Robinhood Chain and Tempo keep their rules.

**PYUSD stays out.** The vault lists it, but its hookless v4 pools on Ethereum return about
$10 for $100 at best. Its pools that fill at par run on per-LP hooks (for example
`0x1bBB87997C729706891Eb5C48A1767853c822888`), and the lists are hookless on these two
chains. A PYUSD note can be held, sent and cashed out, not swapped. To add one, the owner
queues the pool, 3 days of notice, after someone reads that hook.

## Ethereum: what a swap costs

Real proofs against the live vault, on a fork (`app/scripts/fork-router-v3.mts`):

| | Gas |
| --- | --- |
| A swap, one hop | 1.58M to 1.68M |
| A swap, two hops | 1.61M to 1.70M |
| A swap, three hops | 1.70M |
| A refund | 1.17M to 1.20M |
| An exit | 121k to 140k |

The relay pays. At $2,290 ETH a one-hop swap costs about **$3.89 per gwei**.

**So a swap on Ethereum has a floor.** Its vault fee has to cover the swap's own gas, or the
relay refuses it as `swap_small` before anything is sent (`lib/relay/swapFloor`). The floor moves
with gas and with the vault's fee, read live, and the swap tab shows it. Swapping part of a note
sets that part aside first, a private send of about 1.8M gas more. The relay can't tell that
send from any other, so its floor leaves it out. The swap tab counts it and shows the higher floor.

| Gas price | One swap | Smallest swap at 0.25% | At 0.50% |
| --- | --- | --- | --- |
| 0.04 gwei | $0.16 | $62 | $31 |
| 0.15 gwei | $0.58 | $234 | $117 |
| 1 gwei | $3.89 | $1,557 | $779 |
| 3 gwei, the relay's ceiling | $11.68 | $4,671 | $2,336 |

Why this shape:

- **Nothing extra is charged.** A swap under the floor isn't sent, and a person is told the
  size that would go.
- **Only the vault fee counts.** The price buffer can go to a trader who moves the price first,
  as the threat model says, so the floor leaves it out.
- **The floor is on the relay, not only the app.** Each hop past the first adds to it. The
  app asks 10% over it, so a small move in gas while a swap is proved doesn't turn it away.
- **A refund and an exit under the floor aren't refused for that.** They spend from an hourly
  budget instead, below. Each one must show the vault paid its escrow.

The vault's fee went from 0.25% to 0.50% on 3 November 2026, and the relay reads it each time.

**Refunds and exits show the vault's payment.** Everywhere, the app finds the transaction that
paid a swap's escrow and sends its hash. The relay reads that receipt and needs
`Unshielded(nullifier, asset, escrow, amount)` from the vault. A tab from before this sends no hash:
it is refused, nothing moves, and the next load finishes the refund. Money already waiting at an
escrow needs nothing else, as the app finds the transaction by its nullifier.

**Gas budgets on Ethereum, per hour.** A send holds its gas limit when it goes and gives back what
its receipt shows it didn't burn, so one nobody saw land stays counted. Receipts are watched for
50 s there, 30 s elsewhere.

| Budget | Size | What stays counted | Past it |
| --- | --- | --- | --- |
| Swaps | 20M gas | Gas of swaps that reverted | New swaps wait (`swaps_paused`) |
| Refunds and exits | 30M gas | Gas of those that reverted, and of all under the floor | Those under the floor wait. At or over it they go. |
| One note or escrow | 2 reverts | | That one waits (`note_wait`), and nobody else does |

A swap whose deadline is under a minute away is refused, as it could land late.

**The hourly spend cap, every chain.** The relay spends at most this much gas money in an hour,
across every kind of send (`lib/relay/spendCap`). New sends stop at 80% of it (`spend_cap`), cash
outs at 92%, and the last 8% is kept for refunds and exits alone. Past all of it, those wait too,
and an exit can still be sent from any wallet. A scheduled cash out that meets it tries again, like any refusal.

| Chain | Cap an hour | Peak hour so far, to 2 November |
| --- | --- | --- |
| Ethereum | 0.05 ETH | no sends yet |
| Base | 0.01 ETH | 15 sends, about 0.00016 ETH |
| Robinhood Chain | 0.02 ETH | 34 sends, about 0.0012 ETH |
| Tempo | 1, in its gas units | 1 send, about 0.0005 |

One sender (an IP, or a partner account) may hold a share of the cap in an hour, refunds and
exits apart: the larger of 40% of the cap and 200 sends like the one it is sending (their dry-run
gas at the network's gas price, unpadded), but never more than 60%. So one sender always leaves
part of the hour to everyone else, and a 200-person payroll from one browser fits its share up to
about 0.084 gwei on Ethereum, 0.034 on Robinhood Chain and 0.016 on Base (about 0.04, 0.02 and
0.006 on 2 November). A partner account no admin approved also counts as the IP it calls from, so
a second free account from one IP adds nothing. Where there's no swap floor (Base, Robinhood Chain,
Tempo), the refunds and exits an IP asks for hold against a budget of their own, 2% of the cap or
five of them at today's gas, whichever is more, so that IP's own sends never stand in their way.
`GLOAM_RELAY_HOURLY_SPEND_<chainId>` sets a chain's cap in its gas coin, or `off`, and
`GLOAM_RELAY_SENDER_SHARE_<chainId>` a sender's share in percent, or `off`. One IP may ask for
120 sends in 10 minutes on Ethereum, against 400 elsewhere: `GLOAM_RELAY_IP_SENDS_<chainId>`, or
`off`. Through the partner API the account is the sender, and for an account no admin approved
the calling IP too. On Base a send holds half again its
gas for the fee to post it to Ethereum, and settles at the fee its receipt shows.

**Gas limits by kind.** The relay checks each dry run against `SEND_GAS_MOST`: 1.2M for a cash
out, 2.6M for a swap or refund, 400k for an exit, four times that on Robinhood Chain, whose
estimates carry a parent-chain cost. Tempo has none.

**A refund through a router with an exit** is the note less the vault's fee and 0.1%, sized from
the fee when the swap is made. Through an older router it is 1%. A swap's deadline on Base and
Ethereum is 10 minutes.

**How Ethereum sends go out.** The relay sends to `GLOAM_RPC_URL_1` when it is set, and DEPLOY.md
asks for it before Ethereum is on. With none it sends to the first RPC in the chain's list that is
up, `rpc.mevblocker.io`, not a public mempool, though searchers there see transactions for
backruns. Its `/noreverts` endpoint isn't used. A send that went that way and got dropped would
leave a gap in that relay account's nonce.

**Before switching Ethereum on,** top up the relay. It held 0.04 ETH on 26 October. A swap at
0.04 gwei uses about 0.00007 ETH.

## What to review first

1. `GloamVaultSwap2.exit` and `exitDigest`: who can take the money, and whether anything
   public can stand in for the exit key.
2. `_open` and the `OPENING` state: `receive()` takes ETH from any sender in that state.
3. `GloamVaultSwapV4c._walk` and `unlockCallback`: conversion between ETH and WETH at
   the ends of a route, and that a pool can still take no more than the leftover.
4. `SwapEscrow2`: a new init code. Every escrow address depends on it. It asks the router
   that deploys it where to pay (`escrowPayee`): the router, or an exit's recipient. It
   leaves one byte of code (0xFE), so `_open` refuses an escrow opened before at once
   (`EscrowUsed`), and one whose constructor stops with no reason says so (`EscrowFailed`).
5. The escrow key, now ten fields: what it fixes, and that the app and the router hash
   it the same way. The deadline: that it stops a swap, and only a swap, never a forced
   refund or an exit.
   `GloamVaultSwapTempo2._beforeExit` and `_afterExit`: the receive policy read before an
   exit on Tempo, and the check that the money arrived.
6. The Base and Ethereum pool lists against live state on the day, and the depth table above.
7. The deploy page: that what it signs is what was reviewed.
8. The quote stops in `planVaultSwap`: thin pools, the dollar peg, and what a stablecoin swap
   does past them. They are in the app, not the router.
9. `lib/relay/swapFloor` and `assertSwapWorthSending`: the floor, the budgets and the feed.
