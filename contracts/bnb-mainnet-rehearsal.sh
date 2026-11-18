#!/bin/bash
# The whole BNB Chain runbook (DEPLOY-BNB.md) on a local anvil fork of BNB Chain mainnet,
# with no key: anvil sends as any address, so the planned deployer 0xec99...6b60 deploys
# at its live nonce, the Safe accepts the guard as itself, and nothing ever reaches the
# real chain. Run it before the real deploy, from contracts/:
#   ./bnb-mainnet-rehearsal.sh
# Optional: FORK_URL (default BNB Chain's dataseed), PORT (default 8556), FORK_BLOCK (default
# five blocks behind the head, so every node behind FORK_URL already has it).
#
# It runs, in order: the Safe replay (step 1), PoseidonT3 (step 4), the deploy (step 5),
# the memo board (step 6), the Safe's acceptController (step 7), then the read-back
# (step 8) into a scratch folder, so the repo's broadcast/, deployments/bnb-mainnet.json
# and packages/sdk/src/bnb.ts are left as they are. It prints each address, the gas each
# step used and what it would cost at the fork's gas price.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:/Users/duke/.nvm/versions/node/v24.11.1/bin:$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1

FORK_URL=${FORK_URL:-https://bsc-dataseed.bnbchain.org}
PORT=${PORT:-8556}
RPC=http://127.0.0.1:$PORT
DEPLOYER=0xec9993765e249e8e9DC677B7BCB61F78b31c6b60
SAFE=0x8E74b2b85b40f36771f92392b42BBaeacDC75507
OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8
WORK=$(mktemp -d)
trap 'kill $ANVIL 2>/dev/null || true; rm -rf "$WORK"' EXIT

LIVE=$(cast block-number --rpc-url "$FORK_URL")
FORK_BLOCK=${FORK_BLOCK:-$((LIVE - 5))}
anvil --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK" --port "$PORT" --auto-impersonate --silent &
ANVIL=$!
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$RPC")" = 56 ] || { echo "STOP: the fork is not chain 56." >&2; exit 1; }
GP=$(cast gas-price --rpc-url "$FORK_URL")
echo "fork of BNB Chain at block $(cast block-number --rpc-url "$RPC") (head $LIVE), live gas price $(cast to-unit "$GP" gwei) gwei"
[ "$(cast nonce $DEPLOYER --rpc-url "$RPC")" = 0 ] || echo "note  the deployer's nonce is not 0 on BNB Chain: the planned addresses will not hold"
# The deployer gets exactly what DEPLOY-BNB.md step 2 says to fund it with (DEPLOYER_FUND, BNB), so the
# rehearsal shows that is enough; the owner wallet, which sends the Safe replay, gets a little too.
DEPLOYER_FUND=${DEPLOYER_FUND:-0.01}
cast rpc anvil_setBalance "$DEPLOYER" "$(cast to-hex "$(cast to-wei "$DEPLOYER_FUND")")" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$OWNER" "$(cast to-hex "$(cast to-wei 0.01)")" --rpc-url "$RPC" >/dev/null
TOTAL_GAS=0
# Adds a transaction's gas to TOTAL_GAS and leaves it in G (no subshell, so the total keeps it).
used() { G=$(cast receipt "$1" gasUsed --rpc-url "$RPC"); G=$(cast to-dec "$G" 2>/dev/null || echo "$G"); TOTAL_GAS=$((TOTAL_GAS + G)); }
cost() { python3 -c "print(f'{$1 * $GP / 1e18:.6f}')"; }
# cast send on the fork, as an unlocked address: prints the hash, and stops unless the receipt
# says the transaction succeeded (cast's JSON has no "success": its receipt's status is 0x1).
sent() {
  local out
  # options first: after --create <code> cast reads everything as constructor arguments
  out=$(cast send --unlocked --rpc-url "$RPC" --json "$@") || { echo "STOP: cast send failed." >&2; exit 1; }
  jq -e '(.status // .data.status) == "0x1"' <<<"$out" >/dev/null || { echo "STOP: a transaction did not succeed on the fork: $(jq -c '{status, transactionHash}' <<<"$out")" >&2; exit 1; }
  jq -r '.transactionHash // .data.transactionHash' <<<"$out"
}

# Step 1: the Safe, from its creation calldata, sent by anyone (here the owner wallet).
FACTORY=$(jq -r .factory test/fixtures/bnb-safe-replay.json)
DATA=$(jq -r .calldata test/fixtures/bnb-safe-replay.json)
TX=$(sent "$FACTORY" "$DATA" --from "$OWNER")
used "$TX"
[ "$(cast code $SAFE --rpc-url "$RPC")" != 0x ] || { echo "STOP: the Safe replay did not create 0x8E74...5507." >&2; exit 1; }
echo "ok    step 1  Safe $SAFE: owners $(cast call $SAFE 'getOwners()(address[])' --rpc-url "$RPC"), threshold $(cast call $SAFE 'getThreshold()(uint256)' --rpc-url "$RPC"); gas $G ($(cost $G) BNB)"

# Step 4: PoseidonT3, the deployer's first transaction.
POSEIDON_CODE=$(jq -r .bytecode test/fixtures/Poseidon2.json)
TX=$(sent --from "$DEPLOYER" --create "$POSEIDON_CODE")
used "$TX"
POSEIDON2=$(cast receipt "$TX" contractAddress --rpc-url "$RPC")
echo "ok    step 4  PoseidonT3 $POSEIDON2 (planned 0x62c435CE6886fa91e3b0e91500c6dC9219723457); gas $G ($(cost $G) BNB)"

# Step 5: the deploy, with bnb-mainnet-env.sh's defaults (computed the same way: max, and BDX from its decimals).
DEC_BDX=$(cast call 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181 'decimals()(uint8)' --rpc-url "$RPC")
MAX=$(python3 -c "print(2**128-1)")
export POSEIDON2 DEPLOYER DEPLOYER_PK="" GUARD_CONTROLLER=$SAFE GUARD_CONTROLLER_EOA=0 BNB_ALLOW_OTHER_ASSETS=0 GLOAM_ALLOW_REDEPLOY=0
export LIMIT_ASSETS="0x55d398326f99059fF775485246999027B3197955,0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d,0x0000000000000000000000000000000000000000,0x6ad12E761b438beA3EA09F6C6266556Bb24C2181"
export LIMIT_PER_DEPOSIT="$MAX,$MAX,$MAX,$(python3 -c "print(100000 * 10**$DEC_BDX)")"
export LIMIT_TOTAL="$MAX,$MAX,$MAX,$(python3 -c "print(2000000 * 10**$DEC_BDX)")"
export WITHDRAW_FEE_BPS=50 FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8
unset NEW_OWNER NEW_OWNER_EOA
export FOUNDRY_BROADCAST="$WORK/broadcast"
forge script script/DeployBnbMainnet.s.sol:DeployBnbMainnet --rpc-url "$RPC" --broadcast --slow --unlocked --sender "$DEPLOYER" > "$WORK/deploy.log" 2>&1 || { tail -30 "$WORK/deploy.log" >&2; echo "STOP: the deploy failed on the fork." >&2; exit 1; }
grep -q "Guard checks passed" "$WORK/deploy.log" || { tail -30 "$WORK/deploy.log" >&2; exit 1; }
RUN="$WORK/broadcast/DeployBnbMainnet.s.sol/56/run-latest.json"
bad=$(jq -r '[.receipts[] | select(.status != "0x1")] | length' "$RUN")
[ "$bad" = 0 ] || { echo "STOP: $bad deploy transaction(s) did not succeed on the fork." >&2; exit 1; }
SUM=0; for h in $(jq -r '.receipts[].transactionHash' "$RUN"); do used "$h"; SUM=$((SUM + G)); done; G=$SUM
POOL=$(jq -r '[.transactions[] | select(.contractName=="ShieldPoolPayments")][0].contractAddress' "$RUN")
GUARD=$(jq -r '[.transactions[] | select(.contractName=="VaultOwnerGuard")][0].contractAddress' "$RUN")
echo "ok    step 5  vault $(cast to-check-sum-address $POOL) (planned 0x89d3042390204f57b8b4F8949D3c2203E4002164), guard $(cast to-check-sum-address $GUARD) (planned 0x633B24cf4C48CF68cB815BC87C110c47E218B4af), $(jq '.transactions | length' "$RUN") transactions; gas $G ($(cost $G) BNB)"

# Step 6: the memo board.
forge script script/DeployGloamPayMemo.s.sol:DeployGloamPayMemo --rpc-url "$RPC" --broadcast --slow --unlocked --sender "$DEPLOYER" > "$WORK/memo.log" 2>&1 || { tail -20 "$WORK/memo.log" >&2; exit 1; }
MRUN="$WORK/broadcast/DeployGloamPayMemo.s.sol/56/run-latest.json"
[ "$(jq -r '.receipts[0].status' "$MRUN")" = 0x1 ] || { echo "STOP: the memo board's deploy did not succeed on the fork." >&2; exit 1; }
used "$(jq -r '.receipts[0].transactionHash' "$MRUN")"
echo "ok    step 6  memo board $(cast to-check-sum-address "$(jq -r '.transactions[0].contractAddress' "$MRUN")") (planned 0xb692c86B13f65a123f45cF9A21580b2dDC7B8a79); gas $G ($(cost $G) BNB)"

# Step 8 before step 7 must stop: nothing is switched on while the deployer still runs the guard.
cp ../packages/sdk/src/bnb.ts "$WORK/bnb-early.ts"
if early=$(RPC_URL=$RPC DEPLOYER=$DEPLOYER GUARD_CONTROLLER=$SAFE BROADCAST_DIR="$WORK/broadcast" OUT="$WORK/early.json" SDK_BNB="$WORK/bnb-early.ts" ./bnb-mainnet-after-deploy.sh 2>&1); then
  echo "STOP: the read-back passed before the Safe accepted the guard." >&2; exit 1
fi
grep -q "has not called acceptController" <<<"$early" || { echo "$early" | tail -5 >&2; echo "STOP: the early read-back stopped for another reason." >&2; exit 1; }
cmp -s ../packages/sdk/src/bnb.ts "$WORK/bnb-early.ts" && [ ! -e "$WORK/early.json" ] || { echo "STOP: the early read-back wrote something." >&2; exit 1; }
echo "ok    step 8 before step 7 stops and writes nothing"

# Step 7: the Safe accepts the guard (on chain: a 2 of 3 Safe transaction, data 0x9bc21c0c, whose
# gas the signer who executes it pays; here the fork sends as the Safe, so it holds the gas).
cast rpc anvil_setBalance "$SAFE" "$(cast to-hex "$(cast to-wei 0.01)")" --rpc-url "$RPC" >/dev/null
TX=$(sent "$GUARD" 0x9bc21c0c --from "$SAFE")
used "$TX"
echo "ok    step 7  the Safe accepted the guard; gas $G"

echo "total gas $TOTAL_GAS, $(cost $TOTAL_GAS) BNB at $(cast to-unit "$GP" gwei) gwei"
echo "the deployer, funded with $DEPLOYER_FUND BNB, has $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether) BNB left"

# Step 8: the read-back, into the scratch folder.
cp ../packages/sdk/src/bnb.ts "$WORK/bnb.ts"
RPC_URL=$RPC DEPLOYER=$DEPLOYER GUARD_CONTROLLER=$SAFE ACCEPT_CONTROLLER_TX=$TX BROADCAST_DIR="$WORK/broadcast" OUT="$WORK/bnb-mainnet.json" SDK_BNB="$WORK/bnb.ts" \
  ./bnb-mainnet-after-deploy.sh
echo
echo "The SDK file the read-back wrote (scratch copy):"
grep -nE "^  (pool|deployBlock|payMemo|payMemoBlock):" "$WORK/bnb.ts"
echo
echo "Rehearsal passed. Nothing was sent to BNB Chain; the fork is gone when this exits."
