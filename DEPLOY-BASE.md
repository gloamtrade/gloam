# Deploy Gloam to Base

The runbook for bringing the Gloam vault to Base. You run this with your own keys;
no agent and no CI deploys it. Base Sepolia (`84532`), the testnet, went first and is
live since 24 October 2026. Base mainnet (`8453`) follows on the same scripts: its
step list is [Base mainnet](#base-mainnet) below, about ten minutes once the wallets
are funded.

Both chains get the mainnet contract, `ShieldPoolPayments`, through the shared
`contracts/script/MainnetDeploy.sol`, the same deploy as Robinhood Chain and Tempo.
Base Sepolia is a dress rehearsal of Base mainnet, so it runs the ceremony's final
keys too, with test funds. The older testnets run the dev keys only
because they were deployed before the ceremony.

## What this deploys

1. PoseidonT3 (the 2-input hasher) from circomlibjs bytecode, the same code as on
   Robinhood Chain and Tempo.
2. The final-key Groth16 verifiers (shield, cash out, private send), their adapters
   and the `DualProofVerifier`. No pool is created unless they accept final-key proofs
   and reject dev-key ones.
3. `ShieldPoolPayments` (payments only, no swap code), with deposit limits on (before
   the shield verifier, so no deposit can land unlimited), the shield verifier set, each
   asset listed, the 0.25% cash-out fee to the treasury, the
   ownership handoff to the owner wallet started, and setup ended. Then every setting
   is read back and any mismatch fails the run.
4. Optional, recommended: the payment-memo board (`GloamPayMemo`), so a recipient can
   find a payment by scanning the chain with their Gloam address.

Not in this deploy, next: private swaps on Base (router v2 on Uniswap v4) and the
Relay bridge into Base.

## Network

| | Base Sepolia (first) | Base mainnet |
| --- | --- | --- |
| chainId | 84532 | 8453 |
| RPC for sends | https://sepolia.base.org | https://mainnet.base.org |
| RPC for log scans | https://base-sepolia-rpc.publicnode.com (50,000-block `eth_getLogs`) | https://base-rpc.publicnode.com (50,000-block `eth_getLogs`) |
| Explorer | https://sepolia.basescan.org | https://basescan.org |
| Gas | ETH (test ETH) | ETH |

The official RPCs are fine for sending, but not for scanning logs: Base Sepolia's
caps `eth_getLogs` at a 200-block range and Base mainnet's refuses it. Use a private
RPC for the server (`GLOAM_RPC_URL_84532`, `GLOAM_RPC_URL_8453`) once Base is on.

## Assets and limits

Checked on chain on 24 October 2026 (`symbol()`, `decimals()`). Deposit limits match the
other chains: 500 per deposit and 25,000 in total for each stablecoin. ETH gets 0.2 per
deposit and 10 in total: about $467 and $23,400 at Chainlink's ETH/USD on Base that day
($2,337), round numbers just under the stablecoin caps.

| Asset | Base Sepolia | Base mainnet | Decimals | Per deposit (raw) | Total (raw) |
| --- | --- | --- | --- | --- | --- |
| USDC (Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | `500000000` | `25000000000` |
| EURC (Circle) | `0x808456652fdb597867f38412077A9182bf77359F` | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | 6 | `500000000` | `25000000000` |
| USDT (bridged Tether) | none | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` | 6 | `500000000` | `25000000000` |
| ETH (native) | `0x0000000000000000000000000000000000000000` | same | 18 | `200000000000000000` | `10000000000000000000` |

- There is no Tether or Circle-grade USDT on Base Sepolia, so the testnet
  lists USDC, EURC and ETH only.
- USDT on Base is Tether bridged from Ethereum through Base's standard bridge (L1 token
  `0xdAC17F958D2ee523a2206206994597C13D831ec7`), not issued by Tether on Base. It has no
  blacklist and no upgrade key.
- USDC and EURC are Circle's upgradeable tokens with a blacklist. If Circle ever
  blacklisted the vault's own address, that asset would be frozen in the vault for
  everyone; other assets and the rest of the vault keep working. This is the same for
  USDC wherever it is listed.

## Roles

| Role | Address | Needs |
| --- | --- | --- |
| Deployer | `0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411` | 0.004 ETH on Base mainnet (step 1 below), 0.01 test ETH on Base Sepolia |
| Owner (browser wallet) | `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` | 0.001 ETH on each chain, for `acceptOwnership()` |
| Treasury (cash-out fees) | `0xB3900ac9350903218e4c7597bAb0f008F01B30B8` | nothing |
| Relayer | `0xb1E994586E62994648a0b866BF33F2EDd942512e` | 0.005 ETH on Base mainnet to start, 0.02 test ETH on Base Sepolia |

Base mainnet's amounts are worked out from the fork rehearsal in its step 1. Base
Sepolia's, for the record: the whole deploy (PoseidonT3, the pool with its verifiers and
setup calls, and the memo board) uses about 8.8M gas. At Base's gas price on 24
October 2026 (0.006 gwei) the forge part is about 0.00004 ETH, plus an L1 data fee
under 0.0000001 ETH. The PoseidonT3 step costs more than the rest together, about
0.0033 ETH, because its ethers v5 script adds a 1.5 gwei tip; a rehearsal of the whole
runbook on a local Base Sepolia fork spent 0.0033 ETH. 0.01 ETH leaves room for that
and for gas running much higher. A relayed
private send uses about 2M gas, about 0.000012 ETH at that price, so 0.01 ETH is
several hundred sends; the relay reports low balance below the cost of two sends.
The relayer is the same key as on the other chains (`GLOAM_RELAYER_PRIVATE_KEY`); any
extra relay key in `GLOAM_RELAYER_PRIVATE_KEYS` needs the same top-up.

Faucets for Base Sepolia (test funds):

- Test ETH: the Coinbase Developer Platform faucet (portal.cdp.coinbase.com, Faucets,
  Base Sepolia), or the Alchemy, QuickNode or Superchain faucets.
- Test USDC and EURC: faucet.circle.com, pick Base Sepolia. Send some to the wallet you
  will test deposits from.

## Prereqs

- Foundry and Node, run from `contracts/`. `contracts/lib/forge-std` checked out
  (`git submodule update --init contracts/lib/forge-std`) and
  `contracts/circuits/node_modules` installed (circomlibjs, ethers:
  `(cd contracts/circuits && npm install)`).
- The deployer funded on the chain you deploy to.
- For the same addresses as Robinhood Chain and Tempo, the deployer must have sent
  nothing yet on that chain (`cast nonce` shows 0). Then PoseidonT3 lands at
  `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4`, the `DualProofVerifier` at
  `0x1421353d471dF6C847713aee391Db38978fE714a`, the shield verifier at
  `0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465` and the vault at
  `0x39e28cde55cab798874746ac52cb4b5cc99a0194`. The memo board comes next: at
  `0x01B3172d9900Cb26d57E986429b9b23854c74598` on Base Sepolia (nonce 17) and
  `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC` on Base mainnet (nonce 18, one more
  setup call for USDT). Each was empty on Base mainnet on 25 October 2026. If
  the nonce is not 0 the addresses differ, which is fine: on Base mainnet the
  after-deploy script reads them from the run.

## Before you broadcast: check the chain's deploy gas

Forge works out each transaction's gas limit from its own simulation, which uses the
gas rules in `foundry.toml`, not the chain's. If a chain has repriced contract creation
(Ethereum Sepolia did by October 2026: a deploy there costs about 6.7 times what it costs
on Ethereum mainnet or Base), every deploy transaction runs out of gas and burns its
nonce. So, once the settings are sourced, ask the chain what the smallest verifier costs:

```bash
cast estimate --rpc-url $RPC_URL --create $(forge inspect ShieldVerifierFinal bytecode)
```

About 390,000 (Ethereum mainnet, Base and Base Sepolia on 25 October 2026) means the
broadcasts below work as written. Anything well above 500,000 means the chain charges
more than forge expects: add `--gas-estimate-multiplier 1000` to every `--broadcast`
command (you only pay for the gas used), and check the deployer can cover ten times
the estimated cost. On Base mainnet, `base-mainnet-env.sh` (step 2) runs this check
and prints STOP when it is over 500,000.

## Base Sepolia

Done on 24 October 2026 (`contracts/deployments/base-sepolia.json`). The steps as run:

Run every block in one terminal, from `contracts/`. The key is read without echo, so
it lands in no file and no shell history.

### Step 1: settings

```bash
cd contracts
export PATH="$HOME/.foundry/bin:$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1
export RPC_URL=https://sepolia.base.org CHAIN=84532
read -rsp "Deployer private key (hidden): " DEPLOYER_PK; echo; export DEPLOYER_PK
cast wallet address --private-key "$DEPLOYER_PK"   # must print 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411
cast nonce 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411 --rpc-url $RPC_URL   # 0 for the same addresses as the other chains
cast balance 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411 --rpc-url $RPC_URL --ether
```

### Step 2: PoseidonT3

```bash
POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
# prints: chainId 84532 ... nonce 0, then "Poseidon2 0x..." (Poseidon2 is PoseidonT3, the 2-input hasher)
export POSEIDON2=0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4   # or the address it printed
cast code $POSEIDON2 --rpc-url $RPC_URL | cast keccak
# must print 0x354b26999e434f8256d168395315e1f51fc15bf49bf2e6bb58fc549bd597e7da (same code as Robinhood Chain and Tempo)
```

### Step 3: the vault

```bash
export LIMIT_ASSETS=0x036CbD53842c5426634e7929541eC2318f3dCF7e,0x808456652fdb597867f38412077A9182bf77359F,0x0000000000000000000000000000000000000000
export LIMIT_PER_DEPOSIT=500000000,500000000,200000000000000000
export LIMIT_TOTAL=25000000000,25000000000,10000000000000000000
export WITHDRAW_FEE_BPS=25 FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8
export NEW_OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 NEW_OWNER_EOA=1
SCRIPT=script/DeployBaseSepolia.s.sol:DeployBaseSepolia

# Dry run: nothing is sent. It must end with "All checks passed".
forge script $SCRIPT --rpc-url $RPC_URL

# Only if the dry run passed:
forge script $SCRIPT --rpc-url $RPC_URL --broadcast --slow
```

Read back the vault and its deploy block:

```bash
RUN=broadcast/DeployBaseSepolia.s.sol/$CHAIN/run-latest.json
POOL=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="ShieldPoolPayments") | .contractAddress' $RUN)
HASH=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="ShieldPoolPayments") | .hash' $RUN)
BLOCK=$(cast receipt $HASH blockNumber --rpc-url $RPC_URL)
DUAL=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="DualProofVerifier") | .contractAddress' $RUN)
SHIELDI=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="ShieldIVerifierFinal") | .contractAddress' $RUN)
echo "chain $CHAIN pool $POOL deployBlock $BLOCK tx $HASH poseidonT3 $POSEIDON2 dual $DUAL shieldVerifier $SHIELDI"
```

### Step 4 (optional, recommended): the payment-memo board

After the vault, so it does not move the vault's address. No owner, holds nothing.

```bash
forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL               # dry run
forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL --broadcast --slow
MRUN=broadcast/DeployGloamPayMemo.s.sol/$CHAIN/run-latest.json
MEMO=$(jq -r '.transactions[0].contractAddress' $MRUN)
MEMO_BLOCK=$(cast receipt $(jq -r '.transactions[0].hash' $MRUN) blockNumber --rpc-url $RPC_URL)
echo "memo $MEMO deployBlock $MEMO_BLOCK"
```

### Step 5: verify the source

On Basescan, with an Etherscan API V2 key (one key covers every Etherscan chain; if the
key's plan leaves Base out, the call says so and Sourcify below still works):

```bash
read -rsp "Etherscan API key (hidden): " ETHERSCAN_API_KEY; echo; export ETHERSCAN_API_KEY
jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractAddress) \(.contractName)"' $RUN |
while read -r addr name; do
  src=$(grep -rlE --include='*.sol' "^contract $name( |\{)" src | head -1)
  forge verify-contract "$addr" "$src:$name" --chain $CHAIN --verifier etherscan \
    --rpc-url $RPC_URL --guess-constructor-args --watch
done
```

On Sourcify (no key; Blockscout shows Sourcify sources):

```bash
jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractAddress) \(.contractName)"' $RUN |
while read -r addr name; do
  src=$(grep -rlE --include='*.sol' "^contract $name( |\{)" src | head -1)
  forge verify-contract "$addr" "$src:$name" --chain $CHAIN --verifier sourcify --watch
done
```

Add the memo board the same way (`src/GloamPayMemo.sol:GloamPayMemo`, no constructor
arguments). PoseidonT3 is raw circomlibjs bytecode with no Solidity source; its code
hash check in step 2 stands in for verification. `ShieldPoolPayments` takes
`(poseidon2, verifier)` = `($POSEIDON2, $DUAL)` if you ever pass them by hand:
`--constructor-args $(cast abi-encode "constructor(address,address)" $POSEIDON2 $DUAL)`.

### Step 6: accept ownership

The vault's owner is still the deployer until the owner wallet accepts. With the
browser wallet `0x76b7…D4D8` on Base Sepolia, open the vault on
sepolia.basescan.org, Contract, Write Contract, connect, and call `acceptOwnership()`
(Blockscout's Write tab works the same once Sourcify has the source). It moves no
funds. Check it:

```bash
cast call $POOL 'owner()(address)' --rpc-url $RPC_URL    # 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8
cast call $POOL 'pendingOwner()(address)' --rpc-url $RPC_URL   # 0x0000000000000000000000000000000000000000
```

### Step 7: fund the relayer

Send 0.02 test ETH to `0xb1E994586E62994648a0b866BF33F2EDd942512e` on Base Sepolia.

### What to paste back

```
chain 84532 pool 0x... deployBlock ... tx 0x...
poseidonT3 0x... dual 0x... shieldVerifier 0x...
memo 0x... memoDeployBlock ...        (if step 4 ran)
owner accepted: yes/no   relayer funded: yes/no
```

## Base mainnet

About ten minutes once the wallets are funded. Run every block in one terminal, from
`contracts/` in a clean checkout of `main` (for example a fresh worktree): the
after-deploy script in step 7 writes the switch-on into `app/` and `packages/` there.

Rehearsed on 25 October 2026 on an anvil fork of Base mainnet, as the real deployer at
nonce 0 with no key (the deployer and the owner impersonated): steps 3 to 7 as written.
Every address and code hash matched the other chains, the after-deploy script stopped
before ownership was accepted and wrote nothing, then passed every check and switched
Base on, and refused to run a second time.

### What lands where

From the deployer `0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411` at nonce 0 (checked on
25 October 2026: nonce 0, every address below empty on Base):

| Nonce | Contract | Address |
| --- | --- | --- |
| 0 | PoseidonT3 | `0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4` |
| 2 | ShieldIVerifierFinal (the shield verifier) | `0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465` |
| 7 | DualProofVerifier | `0x1421353d471dF6C847713aee391Db38978fE714a` |
| 8 | ShieldPoolPayments (the vault) | `0x39e28cde55cab798874746ac52cb4b5cc99a0194` |
| 18 | GloamPayMemo (memo board, after the 9 setup calls) | `0xfCa1887e77f738ef9C5751974b3f3873d029F2DC` |

If the nonce is not 0 the addresses differ. That is fine; the after-deploy script reads
them from the run.

### Step 1: fund the wallets

Send ETH on Base (chain 8453) from any wallet or exchange that holds ETH there. Send
nothing from the deployer itself: its first transaction must be PoseidonT3.

| Wallet | Has (25 Oct) | Send |
| --- | --- | --- |
| Deployer `0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411` | 0 | **0.004 ETH** |
| Owner `0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8` | 0 | **0.001 ETH** |
| Relayer `0xb1E994586E62994648a0b866BF33F2EDd942512e` | 0 | **0.005 ETH** |

0.01 ETH in all, about $23.50 at 25 October's $2,348. Measured on the fork, priced at
Base's gas on 25 October (0.006 gwei):

| What | Gas | At 0.006 gwei |
| --- | --- | --- |
| PoseidonT3 (1 tx) | 2,157,126 | 0.000013 ETH |
| Vault, verifiers and setup (17 txs) | 6,515,529 | 0.000039 ETH |
| Memo board (1 tx) | 152,323 | 0.000001 ETH |
| L1 data fee, all 19 deploy txs | | 0.0000001 ETH |
| acceptOwnership (owner) | 28,358 | 0.0000002 ETH |
| A relayed private send with its message | about 1,960,000 | 0.000012 ETH |
| A relayed cash out | 436,000 to 663,000 | 0.000004 ETH |

- Deployer, 0.004: the deploy is 8,824,978 gas, 0.000053 ETH today. 0.004 covers it
  at 75 times today's gas, and covers PoseidonT3 even if `PRIORITY_FEE_GWEI` is left off
  (ethers then tips 1.5 gwei: 0.0033 ETH).
- Owner, 0.001: accepting costs under 0.000001 ETH; the rest is for later owner calls
  (lowering a limit, the timelock).
- Relayer, 0.005: about 400 relayed private sends at today's gas, or 40 at ten times
  it. The relay calls itself low below 4.8M gas times the gas price (0.00003 ETH today).

Check them:

```bash
for a in 0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 0xb1E994586E62994648a0b866BF33F2EDd942512e; do
  echo "$a $(cast balance $a --rpc-url https://mainnet.base.org --ether)"; done
```

### Step 2: settings

```bash
cd contracts
source base-mainnet-env.sh
```

It reads the deployer key hidden (no file, no shell history), then prints each value
next to what it must be: the chain (8453), the deployer (`0x891E…F411`), its nonce (0),
its balance (0.004), the gas price (about 0.006 gwei; go on under 0.1), each asset's
symbol and decimals (USDC 6, EURC 6, USDT 6, ETH) and the deploy-gas check (what Base
charges to create `ShieldVerifierFinal`, about 389,744). It ends with "Ready for step 3".

If it prints **STOP** instead, Base is charging more to create a contract than forge
expects (see "Before you broadcast" above). Add `--gas-estimate-multiplier 1000` to every
`--broadcast` and `--resume` command below and make sure the deployer holds ten times
the deploy's cost. If it stopped because there was no estimate at all, the RPC did not
answer: source the file again.

### Step 3: PoseidonT3

```bash
POSEIDON_T3_ONLY=1 PRIORITY_FEE_GWEI=0.002 node circuits/scripts/deploy-poseidon.mjs
# prints: chainId 8453 deployer 0x891E… nonce 0, then "Poseidon2 0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4"
export POSEIDON2=0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4   # or the address it printed
cast code $POSEIDON2 --rpc-url $RPC_URL | cast keccak
# must print 0x354b26999e434f8256d168395315e1f51fc15bf49bf2e6bb58fc549bd597e7da
```

`PRIORITY_FEE_GWEI=0.002` tips 0.002 gwei instead of ethers' 1.5, so this step costs
about 0.00002 ETH instead of 0.0033.

### Step 4: the vault

```bash
forge script $SCRIPT --rpc-url $RPC_URL                      # dry run: must end with "All checks passed"
forge script $SCRIPT --rpc-url $RPC_URL --broadcast --slow   # 17 transactions
```

`--slow` waits for each transaction before the next. Base makes a block every 2
seconds, so all 17 take under a minute. The run ends with "All checks passed" again,
read back from the chain.

### If it stops partway

The same rules as every chain: never start a step again fresh once one of its
transactions has landed, and send nothing else from the deployer until step 5 is done.

- **PoseidonT3 (step 3) errored.** Run `cast nonce $DEPLOYER --rpc-url $RPC_URL`. If it
  is 1 and the code hash above matches, PoseidonT3 landed: go on to step 4. If it is 0,
  nothing landed: run step 3 again. Never run step 3 once the nonce is 1: a second
  PoseidonT3 moves every address after it.
- **The vault broadcast (step 4) stopped.** A fresh run deploys a second set of verifiers
  and a second vault at later nonces, so the vault would not be at
  `0x39e28cde55cab798874746ac52cb4b5cc99a0194` and the memo board would move too. First
  see where it stopped (a transaction still pending shows as a gap between the two
  nonces; wait for it):

  ```bash
  POOL=0x39e28cde55cab798874746ac52cb4b5cc99a0194   # or the address the run printed
  cast nonce $DEPLOYER --rpc-url $RPC_URL; cast nonce $DEPLOYER --block pending --rpc-url $RPC_URL
  cast code $POOL --rpc-url $RPC_URL | wc -c        # 3 means no code yet
  ```

  - **The vault has no code yet:** only ever resume. It sends the rest of the same run,
    from `broadcast/`, at the same nonces:

    ```bash
    forge script $SCRIPT --rpc-url $RPC_URL --resume --slow
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
    `base-mainnet-env.sh`:

    ```bash
    F="--private-key $DEPLOYER_PK --rpc-url $RPC_URL"
    cast send $POOL 'turnOnDepositLimits()' $F
    cast send $POOL 'setShieldVerifier(address)' 0x69Fa6d2De0A66dA718DF022cEe98485AfDb03465 $F
    cast send $POOL 'setDepositLimit(address,uint128,uint128)' <asset> <perDeposit> <total> $F   # each asset still 0 0
    cast send $POOL 'setWithdrawFee(uint16,address)' 25 0xB3900ac9350903218e4c7597bAb0f008F01B30B8 $F
    cast send $POOL 'transferOwnership(address)' 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 $F
    cast send $POOL 'endSetup()' $F   # last: it cannot be undone
    ```

    The after-deploy script in step 7 then checks every setting the same way as for a
    run that went through in one go.
- **The memo board (step 5) stopped** before the board has code: resume it
  (`forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL --resume --slow`),
  never a fresh broadcast.
- **Accepting ownership (step 6) failed:** nothing changed. Press the button again.
- **The after-deploy script (step 7) printed STOP:** it wrote nothing. Read the line. If
  ownership is not accepted yet, do step 6 and run it again. If a setting is off, do not
  announce the vault and tell the team before anything else is sent.

### Step 5: the memo board

```bash
forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL
forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url $RPC_URL --broadcast --slow
# prints GloamPayMemo 0xfCa1887e77f738ef9C5751974b3f3873d029F2DC
```

No owner, holds nothing. After the vault, so it does not move the vault's address.

### Step 6: accept ownership

Open `http://127.0.0.1:4730` with the owner wallet and press **Accept on Base**. The page
checks the vault is waiting for your wallet, switches the wallet to Base, sends
`acceptOwnership()` and waits until the owner reads back as yours. It moves no funds.
Copy the transaction hash it shows.

### Step 7: read back, record, switch on

```bash
ACCEPT_TX=0x...   ./base-mainnet-after-deploy.sh
```

It sends nothing and needs no key. It reads the deploy back and stops at the first
thing that is off: every transaction of both runs succeeded and came from the deployer;
owner `0x76b7…D4D8` with nothing pending; setup ended and limits on; 0.25% to the
treasury; the vault's verifiers are the run's, their code is the final-key verifiers',
and they accept final-key proofs and refuse dev-key ones
(`script/CheckCeremonyKeys.s.sol`, reads only); each asset's symbol, decimals and
limit; and PoseidonT3, the memo board, the verifiers and the vault byte for byte the
other chains'. It prints the relayer's balance and says so if it is under 0.005 ETH.

Then it writes `contracts/deployments/base-mainnet.json` and makes the switch-on:

```diff
--- app/src/lib/mainnet.ts and packages/sdk/src/mainnet.ts
-  8453: { pool: null, deployBlock: null },
+  8453: { pool: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", deployBlock: <vault block> },   (<vault block>n in the SDK)
--- app/src/lib/networks.ts (the base-mainnet entry)
-    payMemo: null,
+    payMemo: { address: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", deployBlock: <memo block>n, emitsPoster: false },
--- packages/sdk/src/constants.ts (Base's mainnet spec)
-  base: { ..., payMemo: null, ...
+  base: { ..., payMemo: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", ...
--- packages/sdk/src/incoming.ts (PAY_MEMO_BOARDS)
+  8453: { address: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", deployBlock: <memo block>n, emitsPoster: false },
```

That is all the app, API, relay, remote MCP, Glim, docs, SDK, local MCP and
mppx-gloam read. Run it a second time and it refuses: the files no longer read as
before the switch-on.

### Step 8: verify the source

On Basescan, with an Etherscan API V2 key (one key covers every Etherscan chain), and on
Sourcify, which needs no key:

```bash
read -rsp "Etherscan API key (hidden): " ETHERSCAN_API_KEY; echo; export ETHERSCAN_API_KEY
RUN=broadcast/DeployBaseMainnet.s.sol/$CHAIN/run-latest.json
jq -r '.transactions[] | select(.transactionType=="CREATE") | "\(.contractAddress) \(.contractName)"' $RUN |
while read -r addr name; do
  src=$(grep -rlE --include='*.sol' "^contract $name( |\{)" src | head -1)
  forge verify-contract "$addr" "$src:$name" --chain $CHAIN --verifier etherscan --rpc-url $RPC_URL --guess-constructor-args --watch
  forge verify-contract "$addr" "$src:$name" --chain $CHAIN --verifier sourcify --watch
done
for v in "etherscan --rpc-url $RPC_URL" sourcify; do
  forge verify-contract 0xfCa1887e77f738ef9C5751974b3f3873d029F2DC src/GloamPayMemo.sol:GloamPayMemo --chain $CHAIN --verifier $v --watch
done
```

PoseidonT3 is raw circomlibjs bytecode with no Solidity source; its code hash in step 3
stands in for verification.

### Step 9: the switch-on PR

From the repo root, with step 7's changes in the tree:

```bash
cd ..
(cd packages/sdk && npm test) && (cd mcp && npm test) && (cd packages/mppx-gloam && npm test)
(cd app && npx tsc --noEmit && ls scripts/selftest-*.mts | xargs -P 6 -n 1 sh -c '../mcp/node_modules/.bin/tsx "$0" > /dev/null 2>&1 || echo "FAIL $0"')
git checkout -b base-mainnet-on
git add contracts/deployments/base-mainnet.json app/src/lib/mainnet.ts app/src/lib/networks.ts \
  packages/sdk/src/mainnet.ts packages/sdk/src/constants.ts packages/sdk/src/incoming.ts
git commit -m "Base mainnet on: its vault and memo board in the app and the SDK"
git push -u origin base-mainnet-on
gh pr create --base main --fill
```

The app self-tests print nothing when they all pass (about a minute). The tests need no edit: the ones
about Base mainnet check the real vault and memo board once `MAINNET_POOLS[8453]` is in.
If you deploy Ethereum the same day, run its step 7 in the same tree and make this one
PR for both (add `contracts/deployments/ethereum-mainnet.json` too).

The repo's Markdown does not switch on by itself. In the same PR, say Base mainnet is live
with its vault, block and memo board where these say it is next or not deployed: `README.md`
(the opening line, the Base section), `AGENTS.md`, `DEPLOY.md` (the mainnet table),
`SECURITY.md` (the opening line), `contracts/README.md`, `contracts/ARCHITECTURE.md` and
`contracts/PRODUCTION.md` (tick the Base mainnet box).

Before the PR is merged: set `GLOAM_RPC_URL_8453` on Vercel to a private Base RPC
(server env, never `NEXT_PUBLIC_`; Base's own RPC refuses `eth_getLogs`), and check the
relayer holds its 0.005 ETH. Later, when you want them: publish `@gloamtrade/sdk` with
the pool in, then `@gloamtrade/mppx-gloam` and `@gloamtrade/mcp` (with pnpm).

## Do not

- Run `DeployBaseMainnet` before Base Sepolia has been tested end to end.
- Run step 3 or step 4 of Base mainnet a second time from the start once anything has
  landed: see "If it stops partway".
- Run the after-deploy script before accepting ownership: it stops, and nothing is
  switched on.
- Deploy with dev keys, or point a Base vault at a dev-key verifier. The script refuses.
- List a rebasing or fee-on-transfer token. Listing a new asset or raising a limit later
  takes the 3-day timelock; lowering one (down to 0 to close deposits) is immediate.
- Lose `contracts/broadcast/` before the after-deploy script has run: it is gitignored
  and holds the only local record of the run.
