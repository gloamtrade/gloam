# Deploy Gloam to Ethereum

The runbook for bringing the Gloam vault to Ethereum mainnet (`1`). You run this with
your own keys; no agent and no CI deploys it. Ethereum Sepolia, its testnet, runs the
same contract, keys and deploy script path ([`DEPLOY-ETHEREUM-SEPOLIA.md`](./DEPLOY-ETHEREUM-SEPOLIA.md)),
so it is the rehearsal for the shared code, and a local fork of Ethereum mainnet is the
rehearsal for this chain (see [Rehearsal](#rehearsal-on-a-fork)). The step list is
[Steps](#steps) below: about ten minutes once the wallets are funded.

Done: Ethereum mainnet is live since 26 October 2026 (vault `0x39E2…0194`, deploy block
`26276183`, memo board `0x8699…f135`). The steps below are the record of that deploy.

Ethereum gets the mainnet contract, `ShieldPoolPayments`, through the shared
`contracts/script/MainnetDeploy.sol`, the same deploy as Robinhood Chain, Tempo and
Base, with native ETH listed.

## What this deploys

1. PoseidonT3 (the 2-input hasher) from circomlibjs bytecode, the same code as on the
   other chains.
2. The final-key Groth16 verifiers (shield, cash out, private send), their adapters and
   the `DualProofVerifier`. No pool is created unless they accept final-key proofs and
   reject dev-key ones.
3. `ShieldPoolPayments` (payments only, no swap code), with deposit limits on (before
   the shield verifier, so no deposit can land unlimited), the shield verifier set, each
   asset listed, the 0.25% cash-out fee to the treasury, the
   ownership handoff to the owner wallet started, and setup ended. Then every setting
   is read back and any mismatch fails the run.
4. Optional, recommended: the payment-memo board (`GloamPayMemo`), so a recipient can
   find a payment by scanning the chain with their Gloam address. It costs gas to post
   to, and the relay pays for relayed memos, so it can wait.

Not in this deploy: private swaps on Ethereum, and the Relay bridge into Ethereum
(Ethereum stays a chain money can be brought over from, into the other chains).

## Network

| | Ethereum mainnet |
| --- | --- |
| chainId | 1 |
| RPC for sends (deploy) | https://ethereum-rpc.publicnode.com |
| RPC for log scans | https://rpc.mevblocker.io (old state, `eth_getLogs` over 10,000 blocks) |
| Explorer | https://etherscan.io |
| Gas | ETH |

Public RPCs checked on 25 October 2026 for `eth_getLogs`:

| RPC | What it serves |
| --- | --- |
| `rpc.mevblocker.io` | Old state and logs; any range up to 10,000 blocks, or any range under 10,000 logs. The app's default |
| `ethereum-rpc.publicnode.com` | Only the last ~10,000 blocks of logs and 128 blocks of state ("Archive requests require a personal token") |
| `gateway.tenderly.co/public/mainnet` | Old logs, but a wide range with many logs comes back cut short with no error |
| `eth.drpc.org`, `1rpc.io`, `cloudflare-eth.com`, `eth-mainnet.public.blastapi.io` | 10,000, 50, 800 and 10 blocks; too small |
| `eth.llamarpc.com`, `eth.merkle.io`, `rpc.ankr.com/eth` | Down, rate limited, or a key needed |

So the app reads Ethereum through MEV Blocker with 10,000-block spans, and the server
must have its own RPC: set `GLOAM_RPC_URL_1` to a private archive RPC (Alchemy,
QuickNode, a paid publicnode token) before Ethereum is switched on. The server tries it
first and MEV Blocker after it.

## Assets and limits

Checked on chain on 25 October 2026 (`symbol()`, `name()`, `decimals()`). At deploy, deposit limits
were 500 per deposit and 25,000 in total for each stablecoin; ETH 0.2
per deposit and 10 in total (about $471 and $23,550 at Chainlink's ETH/USD that day,
$2,354.93). Since then the mainnet limits were raised through the timelock (50,000 per deposit and
2,500,000 in total for each stablecoin, ETH 20 and 1,000), and the cash-out fee went from
0.25% to 0.5% on 3 November 2026.

| Asset | Address | Name on chain | Decimals | Per deposit (raw) | Total (raw) |
| --- | --- | --- | --- | --- | --- |
| USDC (Circle) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | USD Coin | 6 | `500000000` | `25000000000` |
| USDT (Tether) | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | Tether USD | 6 | `500000000` | `25000000000` |
| USDG (Paxos) | `0xe343167631d89B6Ffc58B88d6b7fB0228795491D` | Global Dollar | 6 | `500000000` | `25000000000` |
| PYUSD (Paxos for PayPal) | `0x6c3ea9036406852006290770BEdFcAbA0e23A0e8` | PayPal USD | 6 | `500000000` | `25000000000` |
| EURC (Circle) | `0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c` | Euro Coin | 6 | `500000000` | `25000000000` |
| ETH (native) | `0x0000000000000000000000000000000000000000` | | 18 | `200000000000000000` | `10000000000000000000` |

- **USDT.** Its `transfer`, `transferFrom` and `approve` return nothing, and `approve`
  refuses to change one non-zero allowance into another. The pool pulls and pays out
  with low-level calls that accept no return data (proven on the fork, below). The app,
  the MCP server and the SDK examples set a stale USDT allowance to 0 before approving a
  deposit (`approvalSteps` in the SDK). Tether's transfer fee is off (`basisPointsRate`
  0); if Tether ever turned it on, every USDT deposit would revert with
  `FeeOnTransferNotSupported`: nothing taken, nothing stuck.
- **EURC is a euro stablecoin.** The app never counts it as a dollar.
- **Issuer controls.** Circle, Tether and Paxos can each freeze an address on their
  tokens. If one froze the vault's own address, that asset would be frozen in the vault
  for everyone; the other assets and the rest of the vault keep working.

## Roles and funding

| Role | Address | Has now (25 Oct) | Needs |
| --- | --- | --- | --- |
| Deployer | `0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411` | 0 ETH, nonce 0 | **0.01 ETH** |
| Owner (browser wallet) | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` | 0.00073 ETH | nothing more (accepting costs about 28,400 gas) |
| Treasury (cash-out fees) | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` | | nothing |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` | 0 ETH | **0.04 ETH** to start |

Measured on a local fork of Ethereum mainnet (below):

| Step | Gas |
| --- | --- |
| PoseidonT3 | 2,157,126 |
| Verifiers, adapters, `DualProofVerifier` | 2,420,145 |
| `ShieldPoolPayments` | 3,686,378 |
| Setup calls (limits on, shield verifier, 6 assets, fee, owner handoff, end setup) | 510,440 |
| Memo board (optional) | 152,323 |
| **Whole deploy, deployer** | **8,926,412** (8,774,089 without the memo board) |
| `acceptOwnership()`, owner | 28,358 |

What that costs:

| Gas price | Whole deploy | `acceptOwnership` |
| --- | --- | --- |
| 0.03 gwei (25 Oct: 0.035) | 0.00027 ETH (about $0.63) | 0.000001 ETH |
| 1 gwei | 0.0089 ETH (about $21) | 0.00003 ETH |
| 5 gwei | 0.045 ETH (about $105) | 0.00014 ETH |
| 20 gwei | 0.18 ETH (about $420) | 0.00057 ETH |

Why 0.01 ETH for the deployer: at Monday's likely 0.03 to 0.1 gwei the deploy costs
under 0.001 ETH, but the node checks each transaction's gas limit times its max fee
against the balance before taking it. The pool is the biggest (about 4.8M gas with
forge's estimate margin), so with forge capped at 1 gwei it needs 0.0048 ETH in hand at
that point. 0.01 ETH covers that, the rest, and a deploy at up to about 1 gwei. Deploy
only while `cast gas-price` reads under 0.5 gwei.

PoseidonT3 goes out through an ethers v5 script, which by default tips 1.5 gwei: about
0.0033 ETH on Ethereum, ten times the rest of the deploy on a quiet day. Set
`PRIORITY_FEE_GWEI=0.01` (step 2) and it tips that instead.

Why 0.04 ETH for the relayer: the relay pays the gas of every relayed private send and
cash out. Measured on the fork with real final-key proofs:

| Relayed call | Gas | At 0.035 gwei | At 1 gwei | At 3 gwei (the ceiling) |
| --- | --- | --- | --- | --- |
| Private send | about 1.88M | 0.000066 ETH ($0.15) | 0.0019 ETH ($4.43) | 0.0056 ETH ($13.30) |
| Cash out, USDT | about 0.45M | 0.000016 ETH | 0.00045 ETH | 0.0014 ETH |
| Cash out, ETH | about 0.68M | 0.000024 ETH | 0.00068 ETH | 0.0020 ETH |

Deposits are paid by the person depositing (about 1.28M gas for USDT, 1.45M for ETH).

The relay calls itself low, and stops relaying, once its balance is under 4.8M gas times
the gas price (never more than the 3 gwei ceiling): 0.0144 ETH at the ceiling, 0.00024
ETH at 0.05 gwei. What it can spend is the balance above that line. With 0.04 ETH:

| Gas price | Low below | Private sends of room |
| --- | --- | --- |
| 0.05 gwei (25 Oct) | 0.00024 ETH | about 420 |
| 0.2 gwei | 0.00096 ETH | about 100 |
| 1 gwei | 0.0048 ETH | about 18 |
| 3 gwei (the ceiling) | 0.0144 ETH | about 4 to 5 |

Top it up as it runs down; `/api/relay` shows `lowBalance` per chain.

## The relay's gas ceiling

The relay will not pay any gas price on Ethereum. `GLOAM_RELAY_MAX_GAS_GWEI_1` (Vercel
server env, never `NEXT_PUBLIC_`) sets the ceiling in gwei; unset it is **3 gwei**.
`off` turns it off; a value that is not a number keeps 3. The other chains have no
ceiling unless `GLOAM_RELAY_MAX_GAS_GWEI_<chainId>` sets one.

- Over the ceiling the relay sends nothing: a private send, cash out, payroll payment or
  memo is refused with code `gas_high` and "Ethereum gas is high right now; try again
  shortly." before the dry run, and the app says so next to Hide my wallet. Turning Hide
  my wallet off sends from the wallet, which pays its own gas.
- Under it, a send never offers more than 1.5 times the ceiling per unit of gas (4.5
  gwei), so a spike between the check and inclusion is bounded too.
- A cash out for later still schedules while gas is high. When it comes due it waits,
  still scheduled and still cancellable, and is looked at again every 5 minutes until
  gas is back under the ceiling; after 3 days it gives up and nothing moves.
- `/api/relay` reports `gasHigh`, `gasGwei` and `maxGasGwei` per chain; the relay stays
  `enabled` while gas is high.

At 3 gwei a relayed private send costs Gloam about $13. Lower the ceiling (for example
`GLOAM_RELAY_MAX_GAS_GWEI_1=1`, about $4.40 a send) if that is more than the relay
should spend; raise it only on purpose.

## Prereqs

- Foundry and Node, run from `contracts/`. `contracts/lib/forge-std` checked out
  (`git submodule update --init contracts/lib/forge-std`) and
  `contracts/circuits/node_modules` installed (circomlibjs, ethers:
  `(cd contracts/circuits && npm install)`).
- The wallets funded (step 1).
- For the same addresses as the other chains, the deployer must have sent nothing yet on
  Ethereum (`cast nonce` shows 0; it did on 25 October). Then:

| Nonce | Contract | Address |
| --- | --- | --- |
| 0 | PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| 2 | Shield verifier (`ShieldIVerifierFinal`) | `0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465` |
| 7 | `DualProofVerifier` | `0x1421353d471dF6C847713aee391Db38978fE714a` |
| 8 | `ShieldPoolPayments` (the vault) | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` |
| 20 | `GloamPayMemo` (after 11 setup calls) | `0x8699D015087dE6D25d55d5ceB63b34b9d773f135` |

Each was empty on Ethereum on 25 October 2026. If the nonce is not 0 the addresses
differ, which is fine: the after-deploy script reads them from the run.

## Before you broadcast: check the chain's deploy gas

Forge works out each transaction's gas limit from its own simulation, which uses the
gas rules in `foundry.toml`, not the chain's. If a chain has repriced contract creation
(Ethereum Sepolia did by October 2026: a deploy there costs about 6.7 times what it costs
on Ethereum mainnet or Base), every deploy transaction runs out of gas and burns its
nonce. So, once the settings are sourced, ask the chain what the smallest verifier costs
(`ethereum-mainnet-env.sh` in step 2 does this for you and prints STOP when it is over
500,000):

```bash
cast estimate --rpc-url $RPC_URL --create $(forge inspect ShieldVerifierFinal bytecode)
```

About 390,000 (Ethereum mainnet, Base and Base Sepolia on 25 October 2026) means the
broadcasts below work as written. Anything well above 500,000 means the chain charges
more than forge expects: add `--gas-estimate-multiplier 1000` to every `--broadcast`
command (you only pay for the gas used), and check the deployer can cover ten times
the estimated cost.

## Steps

About ten minutes once the wallets are funded, most of it waiting for blocks. Run every
block in one terminal, from `contracts/` in a clean checkout of `main` (for example a
fresh worktree): the after-deploy script in step 7 writes the switch-on into `app/` and
`packages/` there. The key is read without echo, so it lands in no file and no shell
history.

### Step 1: fund the wallets

Send ETH on Ethereum from any wallet or exchange that holds it. Send nothing from the
deployer itself: its first transaction must be PoseidonT3.

| Wallet | Has (25 Oct) | Send |
| --- | --- | --- |
| Deployer `0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411` | 0, nonce 0 | **0.01 ETH** |
| Owner `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` | 0.00073 ETH | nothing |
| Relayer `0xb1E994586E62994648a0b866BF33F2EDd942512e` | 0 | **0.04 ETH** |

0.05 ETH in all, about $117 at 25 October's $2,348. From the fork rehearsal, at that
evening's gas (0.045 gwei): the whole deploy is 8,926,412 gas, 0.0004 ETH ($0.94);
at the 0.5 gwei go-limit, 0.0045 ETH. The deployer needs 0.01 because the node checks
each transaction's gas limit times its max fee (1 gwei, step 4) against the balance,
and the vault's limit is 4.79M gas: 0.0048 ETH in hand at that point. Accepting
ownership is 28,358 gas, 0.0000013 ETH today, so the owner's 0.00073 covers it up to
about 20 gwei. A relayed private send is about 1.85M gas, 0.000085 ETH today; 0.04 ETH
is about 450 sends today, 18 at 1 gwei, 4 or 5 at the relay's 3 gwei ceiling (see
"Roles and funding" above).

```bash
for a in 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 0xb1E994586E62994648a0b866BF33F2EDd942512e; do
  echo "$a $(cast balance $a --rpc-url https://ethereum-rpc.publicnode.com --ether)"; done
```

### Step 2: settings and gas

```bash
cd contracts
source ethereum-mainnet-env.sh
```

It reads the deployer key hidden, then prints each value next to what it must be: the
chain (1), the deployer (`0x891E…F411`), its nonce (0), its balance (0.01), the gas price
(about 0.04 gwei on 25 October), each asset's symbol and decimals (USDC, USDT, USDG,
PYUSD and EURC, 6 each, and ETH) and the deploy-gas check (what Ethereum charges to
create `ShieldVerifierFinal`, about 389,744). It ends with "Ready for step 3".

- **WAIT** means gas is over 0.5 gwei. Do not start; source the file again later.
- **STOP** means Ethereum is charging more to create a contract than forge expects (see
  "Before you broadcast" above). Add `--gas-estimate-multiplier 1000` to every
  `--broadcast` and `--resume` command below and make sure the deployer holds ten times
  the deploy's cost. If it stopped because there was no estimate at all, the RPC did not
  answer: source the file again.

### Step 3: PoseidonT3

```bash
POSEIDON_T3_ONLY=1 PRIORITY_FEE_GWEI=0.01 node circuits/scripts/deploy-poseidon.mjs
# prints: chainId 1 deployer 0x891E… nonce 0, then "Poseidon2 0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4"
export POSEIDON2=0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4   # or the address it printed
cast code $POSEIDON2 --rpc-url $RPC_URL | cast keccak
# must print 0x354b26999e434f8256d168395315e1f51fc15bf49bf2e6bb58fc549bd597e7da (same code as the other chains)
```

`PRIORITY_FEE_GWEI=0.01` tips 0.01 gwei instead of ethers' 1.5 gwei (0.0033 ETH for
this step alone).

### Step 4: the vault

```bash
# Dry run: nothing is sent. It must end with "All checks passed".
forge script $SCRIPT --rpc-url $RPC_URL

# Only if the dry run passed. Pays at most 1 gwei per unit of gas, tips 0.01 gwei.
forge script $SCRIPT --rpc-url $RPC_URL --broadcast --slow --with-gas-price 1gwei --priority-gas-price 0.01gwei
```

`--slow` waits for each transaction before the next (about 12 seconds a block, so about
four minutes for all 19). If gas jumps over 1 gwei mid-run the next transaction waits in
the mempool. The run ends with "All checks passed" again, read back from the chain.

#### If it stops partway

Never start a step again fresh once one of its transactions has landed, and send nothing
else from the deployer until step 5 is done.

- **PoseidonT3 (step 3) errored.** Run `cast nonce $DEPLOYER --rpc-url $RPC_URL`. If it
  is 1 and the code hash above matches, PoseidonT3 landed: go on to step 4. If it is 0,
  nothing landed: run step 3 again. Never run step 3 once the nonce is 1: a second
  PoseidonT3 moves every address after it.
- **The vault broadcast (step 4) stopped.** A fresh run deploys a second set of verifiers
  and a second vault at later nonces, so the vault would not be at
  `0x39e28cde55cab798874746ac52cb4b5cc99a0194`, and it pays the deploy twice. First see
  where it stopped (a transaction still pending shows as a gap between the two nonces;
  wait for it):

  ```bash
  POOL=0x39e28cde55cab798874746ac52cb4b5cc99a0194   # or the address the run printed
  cast nonce $DEPLOYER --rpc-url $RPC_URL; cast nonce $DEPLOYER --block pending --rpc-url $RPC_URL
  cast code $POOL --rpc-url $RPC_URL | wc -c        # 3 means no code yet
  ```

  - **The vault has no code yet:** only ever resume. It sends the rest of the same run,
    from `broadcast/`, at the same nonces:

    ```bash
    forge script $SCRIPT --rpc-url $RPC_URL --resume --slow --with-gas-price 1gwei --priority-gas-price 0.01gwei
    ```

  - **The vault has code:** finish the setup by hand, as the deployer. Read what is done:

    ```bash
    cast call $POOL 'setupMode()(bool)' --rpc-url $RPC_URL          # true until endSetup
    cast call $POOL 'depositLimitsOn()(bool)' --rpc-url $RPC_URL
    cast call $POOL 'shieldVerifier()(address)' --rpc-url $RPC_URL   # 0x0 until set
    for a in $(echo $LIMIT_ASSETS | tr ',' ' '); do echo "$a $(cast call $POOL 'depositLimit(address)(uint128,uint128)' $a --rpc-url $RPC_URL | tr '\n' ' ')"; done
    cast call $POOL 'withdrawFeeBps()(uint16)' --rpc-url $RPC_URL; cast call $POOL 'feeRecipient()(address)' --rpc-url $RPC_URL
    cast call $POOL 'pendingOwner()(address)' --rpc-url $RPC_URL
    ```

    Then send only the calls still missing, in this order, waiting for each one. The
    shield verifier is the run's `ShieldIVerifierFinal` (`0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465`
    from a deployer that started at nonce 0); the limits are the pairs in
    `ethereum-mainnet-env.sh`:

    ```bash
    F="--private-key $DEPLOYER_PK --rpc-url $RPC_URL --gas-price 1gwei --priority-gas-price 0.01gwei"
    cast send $POOL 'turnOnDepositLimits()' $F
    cast send $POOL 'setShieldVerifier(address)' 0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465 $F
    cast send $POOL 'setDepositLimit(address,uint128,uint128)' <asset> <perDeposit> <total> $F   # each asset still 0 0
    cast send $POOL 'setWithdrawFee(uint16,address)' 25 0xB3900ac9350903218e4c7597bAb0f008F01B30B8 $F
    cast send $POOL 'transferOwnership(address)' 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 $F
    cast send $POOL 'endSetup()' $F   # last: it cannot be undone
    ```

    The after-deploy script in step 7 then checks every setting the same way as for a
    run that went through in one go.
- **The memo board (step 5) stopped** before the board has code: resume it, never a
  fresh broadcast:

  ```bash
  forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL --resume --slow --with-gas-price 1gwei --priority-gas-price 0.01gwei
  ```
- **Accepting ownership (step 6) failed:** nothing changed. Press the button again.
- **The after-deploy script (step 7) printed STOP:** it wrote nothing. Read the line. If
  ownership is not accepted yet, do step 6 and run it again. If a setting is off, do not
  announce the vault and tell the team before anything else is sent.

### Step 5: the memo board

```bash
forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL
forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL --broadcast --slow --with-gas-price 1gwei --priority-gas-price 0.01gwei
# prints GloamPayMemo 0x8699D015087dE6D25d55d5ceB63b34b9d773f135
```

No owner, holds nothing. After the vault, so it does not move the vault's address. It
costs 152,323 gas to deploy; the relay pays for relayed memos after that.

### Step 6: accept ownership

Open `http://127.0.0.1:4730` with the owner wallet and press **Accept on Ethereum**. The
page checks the vault is waiting for your wallet, switches the wallet to Ethereum, sends
`acceptOwnership()` and waits until the owner reads back as yours. It moves no funds and
costs about 28,400 gas. Copy the transaction hash it shows.

### Step 7: read back, record, switch on

```bash
ACCEPT_TX=0x...   ./ethereum-mainnet-after-deploy.sh
```

It sends nothing and needs no key. It reads the deploy back and stops at the first
thing that is off: every transaction of both runs succeeded and came from the deployer;
owner `0x76b7…D4D8` with nothing pending; setup ended and limits on; 0.25% to the
treasury; the vault's verifiers are the run's, their code is the final-key verifiers',
and they accept final-key proofs and refuse dev-key ones
(`script/CheckCeremonyKeys.s.sol`, reads only); each asset's symbol, decimals and
limit; and PoseidonT3, the memo board, the verifiers and the vault byte for byte the
other chains'. It prints the relayer's balance and says so if it is under 0.04 ETH.

Then it writes `contracts/deployments/ethereum-mainnet.json` and makes the switch-on:

```diff
--- app/src/lib/mainnet.ts and packages/sdk/src/mainnet.ts
-  1: { pool: null, deployBlock: null },
+  1: { pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", deployBlock: <vault block> },   (<vault block>n in the SDK)
--- app/src/lib/networks.ts (the ethereum-mainnet entry)
-    payMemo: null,
+    payMemo: { address: "0x8699D015087dE6D25d55d5ceB63b34b9d773f135", deployBlock: <memo block>n, emitsPoster: false },
--- packages/sdk/src/constants.ts (Ethereum's mainnet spec)
-  ethereum: { ..., payMemo: null, ...
+  ethereum: { ..., payMemo: "0x8699D015087dE6D25d55d5ceB63b34b9d773f135", ...
--- packages/sdk/src/incoming.ts (PAY_MEMO_BOARDS)
+  1: { address: "0x8699D015087dE6D25d55d5ceB63b34b9d773f135", deployBlock: <memo block>n, emitsPoster: false },
```

That is all the app, API, relay, remote MCP, Glim, docs, SDK, local MCP and mppx-gloam
read. Run it a second time and it refuses: the files no longer read as before the
switch-on.

### Step 8: verify the source

On Etherscan, with an Etherscan API V2 key, and on Sourcify, which needs no key:

```bash
read -rsp "Etherscan API key (hidden): " ETHERSCAN_API_KEY; echo; export ETHERSCAN_API_KEY
RUN=broadcast/DeployEthereumMainnet.s.sol/$CHAIN/run-latest.json
jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractAddress) \(.contractName)"' $RUN |
while read -r addr name; do
  src=$(grep -rlE --include='*.sol' "^contract $name( |\{)" src | head -1)
  forge verify-contract "$addr" "$src:$name" --chain $CHAIN --verifier etherscan --rpc-url $RPC_URL --guess-constructor-args --watch
  forge verify-contract "$addr" "$src:$name" --chain $CHAIN --verifier sourcify --watch
done
for v in "etherscan --rpc-url $RPC_URL" sourcify; do
  forge verify-contract 0x8699D015087dE6D25d55d5ceB63b34b9d773f135 src/GloamPayMemo.sol:GloamPayMemo --chain $CHAIN --verifier $v --watch
done
```

PoseidonT3 is raw circomlibjs bytecode with no Solidity source; the code hash check in
step 3 stands in for verification. `ShieldPoolPayments` takes `(poseidon2, verifier)` =
`($POSEIDON2, <DualProofVerifier>)` if you ever pass them by hand.

### Step 9: the switch-on PR

Set `GLOAM_RPC_URL_1` on Vercel first: a private archive RPC (server env, never
`NEXT_PUBLIC_`). The public ones cannot rebuild the vault tree, so do not merge without
it. Then, from the repo root, with step 7's changes in the tree:

```bash
cd ..
(cd packages/sdk && npm test) && (cd mcp && npm test) && (cd packages/mppx-gloam && npm test)
(cd app && npx tsc --noEmit && ls scripts/selftest-*.mts | xargs -P 6 -n 1 sh -c '../mcp/node_modules/.bin/tsx "$0" > /dev/null 2>&1 || echo "FAIL $0"')
git checkout -b ethereum-mainnet-on
git add contracts/deployments/ethereum-mainnet.json app/src/lib/mainnet.ts app/src/lib/networks.ts \
  packages/sdk/src/mainnet.ts packages/sdk/src/constants.ts packages/sdk/src/incoming.ts
git commit -m "Ethereum mainnet on: its vault and memo board in the app and the SDK"
git push -u origin ethereum-mainnet-on
gh pr create --base main --fill
```

The app self-tests print nothing when they all pass (about a minute). The tests need no
edit: the ones about Ethereum check the real vault and memo board once
`MAINNET_POOLS[1]` is in. If you deployed Base the same day in the same tree, make this
one PR for both (add `contracts/deployments/base-mainnet.json` too).

The repo's Markdown does not switch on by itself. In the same PR, say Ethereum mainnet is
live with its vault, block and memo board where these say it is next or not deployed:
`README.md` (the opening line, the Ethereum section), `AGENTS.md`, `DEPLOY.md` (the mainnet
table), `SECURITY.md` (the opening line), `contracts/README.md`, `contracts/ARCHITECTURE.md`
and `contracts/PRODUCTION.md` (tick the Ethereum box).

Before the PR is merged, check the relayer holds its 0.04 ETH. Later, when you want
them: a release with the pool in, `@gloamtrade/sdk` 0.4.x, `@gloamtrade/mcp` 0.6.x and
`@gloamtrade/mppx-gloam` 0.3.x (publish with pnpm).

## Rehearsal on a fork

Done on 25 October 2026 and repeatable:

- **The runbook.** An anvil fork of Ethereum mainnet (`anvil --fork-url
  https://gateway.tenderly.co/public/mainnet --auto-impersonate`), as the real deployer
  at nonce 0 with no key (`DEPLOYER` alone and `forge script --unlocked --sender`, as in
  `script/DeployerBroadcast.sol`; the owner impersonated for step 6). `ethereum-mainnet-env.sh`
  sourced against the live chain, then steps 3 to 7 as written: the PoseidonT3 code hash
  matched, the dry run ended "All checks passed", the broadcast sent 19 transactions
  (6,616,963 gas; 8,926,412 with PoseidonT3 and the memo board), every contract landed at
  the address in the table above, the after-deploy script stopped before ownership was
  accepted and wrote nothing, then passed every check, wrote the record and the
  switch-on, and refused to run a second time. Every SDK, MCP, mppx-gloam and app test
  passed with that switch-on in, with and without Base's next to it.
- **The vault on real tokens.** `test/fork/EthereumMainnetFork.t.sol` deploys with these
  settings on a fork, has the owner accept, then puts real USDT and ETH through the vault
  with proofs made with the ceremony's final keys (`test/fixtures/ethereum-fork-proofs.json`,
  from `circuits/scripts/gen-ethereum-fork-proofs.mjs`): USDT's approve rule, a deposit
  of each, a private send, a cash out of each with the 0.25% fee, and the fees collected
  by the treasury.

```bash
ETH_FORK=1 forge test --match-path test/fork/EthereumMainnetFork.t.sol -vv
```

`test/DeployChains.t.sol` checks that every mainnet deploy script, this one included,
refuses every chain but its own.

## After the deploy: switching Ethereum on

Step 7 makes the switch-on and step 9 ships it. What else goes with it:

- Vercel server env: `GLOAM_RPC_URL_1`, a private archive RPC (required: the public
  ones cannot rebuild the vault tree), and `GLOAM_RELAY_MAX_GAS_GWEI_1` only to move the
  ceiling off 3 gwei.
- A release with the pool in: `@gloamtrade/sdk` 0.4.x, `@gloamtrade/mcp` 0.6.x and
  `@gloamtrade/mppx-gloam` 0.3.x (publish with pnpm).
- Tests: none to edit. The ones about Ethereum (`packages/sdk/test/ethereum.selftest.mjs`,
  `mainnet.selftest.mjs`, `app/scripts/selftest-ethereum.mts`) read `MAINNET_POOLS[1]` and
  check the real vault and its memo board once they are in, and the ones that used chain
  1 as "a chain with no Gloam pool" (`packages/mppx-gloam/test/charge.test.ts`,
  `packages/sdk/test/requests.selftest.mjs`, `selftest-partners.mts`,
  `selftest-claim-codes.mts`) use Polygon instead.

## Do not

- Deploy with dev keys, or point the vault at a dev-key verifier. The script refuses.
- Deploy while gas is high: check `cast gas-price` first and keep `--with-gas-price`.
- List a rebasing or fee-on-transfer token. Listing a new asset or raising a limit later
  takes the 3-day timelock; lowering one (down to 0 to close deposits) is immediate.
- Switch Ethereum on before `GLOAM_RPC_URL_1` is set on the server.
- Run the after-deploy script before accepting ownership: it stops, and nothing is
  switched on.
- Lose `contracts/broadcast/` before the after-deploy script has run: it is gitignored
  and holds the only local record of the run.
