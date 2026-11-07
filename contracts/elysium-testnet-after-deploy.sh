#!/bin/bash
# After the Elysium testnet deploy (chain id 99801, script/DeployElysiumTestnet.s.sol). Run from
# contracts/, with the same settings as the deploy still set (source elysium-testnet-env.sh, or export them):
#   GUARD_CONTROLLER=0x... ./elysium-testnet-after-deploy.sh
# RPC_URL defaults to https://testnet-rpc.elysium.kinetiq.xyz and the USDC to Kinetiq's test USDC.
# Optional: ACCEPT_CONTROLLER_TX=0x... once GUARD_CONTROLLER has called acceptController() on the
# guard (only when it is not the deployer); it is checked and recorded.
# It reads the deploy back from the chain and stops at the first thing that is not as the
# runbook set it. If all is right it writes deployments/elysium-testnet.json and the switch-on:
# the pool and its deploy block (and the memo board, if it was deployed) into ELYSIUM_TESTNET in
# packages/sdk/src/elysium.ts, the one file the app, the SDK and the MCP read Elysium from.
# Reads only: it sends nothing and needs no key.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:/Users/duke/.nvm/versions/node/v24.11.1/bin:$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1

RPC_URL=${RPC_URL:-https://testnet-rpc.elysium.kinetiq.xyz}
ELYSIUM_USDC=${ELYSIUM_TESTNET_USDC:-0x7D29d8047B905000459c0E80c34a26CeedcB47b2}
: "${GUARD_CONTROLLER:?set GUARD_CONTROLLER, the guard controller the deploy named}"
CHAIN=99801
NAME="Elysium testnet"
RUN=broadcast/DeployElysiumTestnet.s.sol/$CHAIN/run-latest.json
MRUN=broadcast/DeployGloamPayMemo.s.sol/$CHAIN/run-latest.json
OUT=deployments/elysium-testnet.json
SDK_ELYSIUM=${SDK_ELYSIUM:-../packages/sdk/src/elysium.ts}
# What the relayer should hold before the testnet is offered.
# A starting figure: set it again once a relayed send's cost in test HYPE is known.
RELAYER_TARGET=${RELAYER_TARGET:-0.5}

DEPLOYER=0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411
TREASURY=0xB3900ac9350903218e4c7597bAb0f008F01B30B8
RELAYER=0xb1E994586E62994648a0b866BF33F2EDd942512e
ZERO=0x0000000000000000000000000000000000000000
FEE_BPS=50
# Where everything lands from a deployer that started at nonce 0, the same as on the other chains.
POSEIDON_T3=0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4
CANON_POOL=0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194
# Code hashes as on Robinhood Chain, Tempo, Base and Ethereum.
POSEIDON_T3_CODE=0x354b26999e434f8256d168395315e1f51fc15bf49bf2e6bb58fc549bd597e7da
MEMO_CODE=0xf24e84ff514b7b8e3eba03c4b7ac70bbeb8b799b5fd3006d552a34362cf5edae
# The three Groth16 verifiers hold the final keys in their code, so their hash is the same at any address.
KEY_CODES=(
  "ShieldVerifierFinal 0xf6a771ca5059d079059ea1352d0d962ac87766169a6c87504d0adcc568531a37"
  "UnshieldVerifierFinal 0x29aa6c0a70397a3fd697f4c7add0599da4d137b61e659d95f390c0ed4247c55a"
  "TransferVerifierFinal 0x82a755477429f574f86070c02778a87b4806e6fc9ba7c26076dfe74af57947e2"
)
# The adapters, the DualProofVerifier and the vault hold the addresses of what they point at,
# so these match only at the nonce-0 addresses.
CANON_CODES=(
  "ShieldIVerifierFinal 0x956f69128783bd1c3a7a487667bb29a9d146ed1894ce8cb904c629841e58e632"
  "UnshieldIVerifierFinal 0x02d8f09c54d2cec2595c0cd2d41b40a0c194a24ac31368c13f15a5ae03dad11e"
  "TransferIVerifierFinal 0xd8bf915c29086abdfb2bd9eff5ecf42b718e6d2defa62fc464660c8cf47e9e2a"
  "DualProofVerifier 0x1d93455a6dd1b0b9b4793ba446ce84e2c301263578674ab438013bcb8dbec5c6"
  "ShieldPoolPayments 0x58d9843b0c6d9b81fbbb015de6a2413a7443cc63476185edf43d882f672088f2"
)

fail() { echo "STOP: $*" >&2; echo "Nothing was written. Fix it, or tell the team before turning $NAME on." >&2; exit 1; }
ok() { echo "ok    $*"; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
same() { [ "$(lc "$1")" = "$(lc "$2")" ]; }
call() { cast call "$@" --rpc-url "$RPC_URL"; }
codehash() { cast code "$1" --rpc-url "$RPC_URL" | cast keccak; }
# How often a piece of text appears in one block of the file (ELYSIUM_TESTNET's, not
# ELYSIUM_MAINNET's, which has the same lines), and swapping it for another there.
SDK_BLOCK=ELYSIUM_TESTNET
count() { NAME="$SDK_BLOCK" OFF="$2" perl -0ne 'if (/(export const \Q$ENV{NAME}\E: ElysiumMainnetInput = \{.*?\n\};)/s) { my $b = $1; my $c = () = $b =~ /\Q$ENV{OFF}\E/g; print $c + 0 } else { print -1 }' "$1"; }
swap() { NAME="$SDK_BLOCK" OFF="$2" ON="$3" perl -0pi -e 's/(export const \Q$ENV{NAME}\E: ElysiumMainnetInput = \{.*?\n\};)/my $b = $1; $b =~ s{\Q$ENV{OFF}\E}{$ENV{ON}}; $b/se' "$1"; }

# The switch-on, as ELYSIUM_TESTNET in packages/sdk/src/elysium.ts reads before the deploy. Each line exactly once there.
POOL_OFF='  pool: null,'
BLOCK_OFF='  deployBlock: null,'
MEMO_OFF='  payMemo: null,'
MEMO_BLOCK_OFF='  payMemoBlock: null,'

[ -f "$RUN" ] || fail "$RUN is missing: run this from the contracts/ folder the deploy ran in."
[ -f "$SDK_ELYSIUM" ] || fail "$SDK_ELYSIUM is missing."
for t in "$POOL_OFF" "$BLOCK_OFF" "$MEMO_OFF" "$MEMO_BLOCK_OFF"; do
  n=$(count "$SDK_ELYSIUM" "$t")
  [ "$n" = "1" ] || fail "$SDK_ELYSIUM does not read as before the switch-on ('$t' found $n times, not once): already switched on?"
done
[ "$(cast chain-id --rpc-url "$RPC_URL")" = "$CHAIN" ] || fail "$RPC_URL is not chain $CHAIN (Elysium testnet)."
# This file ships in the npm package: never a keyed RPC into it (the SDK refuses one).
grep -A3 'export const ELYSIUM_TESTNET: ElysiumMainnetInput' "$SDK_ELYSIUM" | grep -q '  chainId: 99801,' || fail "ELYSIUM_TESTNET in $SDK_ELYSIUM does not name chain 99801."

created() { jq -r --arg n "$1" '[.transactions[] | select(.transactionType=="CREATE" and .contractName==$n)][0].contractAddress // empty' "$RUN"; }
createTx() { jq -r --arg n "$1" '[.transactions[] | select(.transactionType=="CREATE" and .contractName==$n)][0].hash // empty' "$RUN"; }
blockOf() { cast to-dec "$(cast receipt "$1" blockNumber --rpc-url "$RPC_URL")"; }
addr() { local a; a=$(created "$1"); [ -n "$a" ] || fail "the run has no $1."; cast to-check-sum-address "$a"; }

POOL=$(addr ShieldPoolPayments)
POOL_TX=$(createTx ShieldPoolPayments)
BLOCK=$(blockOf "$POOL_TX")
DUAL=$(addr DualProofVerifier)
SHIELD_I=$(addr ShieldIVerifierFinal)
GUARD=$(addr VaultOwnerGuard)
POSEIDON=$(cast to-check-sum-address "$(call "$POOL" 'poseidon2()(address)')")
MEMO=""; MEMO_TX=""; MEMO_BLOCK=""
if [ -f "$MRUN" ]; then
  MEMO=$(cast to-check-sum-address "$(jq -r '.transactions[0].contractAddress' "$MRUN")")
  MEMO_TX=$(jq -r '.transactions[0].hash' "$MRUN")
  MEMO_BLOCK=$(blockOf "$MEMO_TX")
  echo "pool $POOL block $BLOCK, guard $GUARD, memo board $MEMO block $MEMO_BLOCK"
else
  echo "pool $POOL block $BLOCK, guard $GUARD, no memo board yet (optional, step 5)"
fi

# Every transaction landed, all from the deployer.
RUNS=("$RUN"); [ -n "$MEMO" ] && RUNS+=("$MRUN")
for r in "${RUNS[@]}"; do
  bad=$(jq -r '[.receipts[] | select(.status != "0x1")] | length' "$r")
  [ "$bad" = "0" ] || fail "$bad transaction(s) in $r did not succeed."
  others=$(jq -r --arg d "$(lc "$DEPLOYER")" '[.transactions[] | select((.transaction.from | ascii_downcase) != $d)] | length' "$r")
  [ "$others" = "0" ] || fail "$others transaction(s) in $r were not sent by the deployer."
done
[ -z "$MEMO" ] || [ "$MEMO_BLOCK" -ge "$BLOCK" ] || fail "the memo board is older than the vault."
ok "every deploy transaction succeeded, all from the deployer"

# The vault as the runbook set it up.
[ "$(call "$POOL" 'setupMode()(bool)')" = "false" ] || fail "setup was not ended."
[ "$(call "$POOL" 'depositLimitsOn()(bool)')" = "true" ] || fail "deposit limits are off."
ok "setup ended, deposit limits on"
[ "$(call "$POOL" 'withdrawFeeBps()(uint16)')" = "$FEE_BPS" ] || fail "the cash-out fee is not $FEE_BPS bps."
same "$(call "$POOL" 'feeRecipient()(address)')" "$TREASURY" || fail "the fee does not go to the treasury."
ok "cash-out fee 0.5% to the treasury 0xB390…30B8"

# The owner guard: it owns the vault, nobody is offered it, and its filter refuses the proof checkers.
same "$(call "$POOL" 'owner()(address)')" "$GUARD" || fail "the vault's owner is not the deploy's VaultOwnerGuard."
same "$(call "$POOL" 'pendingOwner()(address)')" "$ZERO" || fail "someone is offered the vault."
same "$(call "$GUARD" 'vault()(address)')" "$POOL" || fail "the guard names another vault."
[ "$(call "$GUARD" 'isAllowedChange(bytes)(bool)' "$(cast calldata 'setVerifier(address)' 0x0000000000000000000000000000000000000001)")" = "false" ] || fail "the guard allows setVerifier."
[ "$(call "$GUARD" 'isAllowedChange(bytes)(bool)' "$(cast calldata 'setShieldVerifier(address)' 0x0000000000000000000000000000000000000001)")" = "false" ] || fail "the guard allows setShieldVerifier."
ok "the vault is owned by its guard $GUARD: no proof checker can be replaced, ownership cannot move"
CONTROLLER=$(cast to-check-sum-address "$(call "$GUARD" 'controller()(address)')")
PENDING=$(cast to-check-sum-address "$(call "$GUARD" 'pendingController()(address)')")
if same "$GUARD_CONTROLLER" "$DEPLOYER"; then
  same "$CONTROLLER" "$DEPLOYER" && same "$PENDING" "$ZERO" || fail "the guard's controller is $CONTROLLER (pending $PENDING), not the deployer."
  ok "guard controller is the deployer, as named"
elif same "$CONTROLLER" "$GUARD_CONTROLLER"; then
  same "$PENDING" "$ZERO" || fail "the guard has another controller handover pending ($PENDING)."
  ok "guard controller is $GUARD_CONTROLLER, accepted"
else
  same "$CONTROLLER" "$DEPLOYER" || fail "the guard's controller is $CONTROLLER, neither the deployer nor GUARD_CONTROLLER."
  same "$PENDING" "$GUARD_CONTROLLER" || fail "the guard offers its controller seat to $PENDING, not GUARD_CONTROLLER."
  [ -z "${ACCEPT_CONTROLLER_TX:-}" ] || fail "ACCEPT_CONTROLLER_TX is set but GUARD_CONTROLLER has not accepted yet."
  echo "note  GUARD_CONTROLLER $GUARD_CONTROLLER has not called acceptController() yet. Until then the deployer runs the guard: limits and the fee only."
fi

# The verifiers: the deploy's own, holding the ceremony's final keys.
same "$(call "$POOL" 'verifier()(address)')" "$DUAL" || fail "the spend verifier is not the deploy's DualProofVerifier."
same "$(call "$POOL" 'shieldVerifier()(address)')" "$SHIELD_I" || fail "the shield verifier is not the deploy's."
for k in "${KEY_CODES[@]}"; do
  read -r name hash <<<"$k"
  [ "$(codehash "$(addr "$name")")" = "$hash" ] || fail "$name's code is not the final-key verifier's."
done
keys=$(POOL=$POOL forge script script/CheckCeremonyKeys.s.sol:CheckCeremonyKeys --rpc-url "$RPC_URL" 2>&1) || true
grep -q "ceremony keys ok" <<<"$keys" || { echo "$keys" | tail -20 >&2; fail "the vault's verifiers do not hold the ceremony's final keys."; }
ok "the deploy's verifiers, on the final keys: they accept final-key proofs and refuse dev-key ones"

# USDC: the token is what it should be, and its limit is 500 / 25,000 in its own decimals.
[ "$(call "$ELYSIUM_USDC" 'symbol()(string)')" = '"USDC"' ] || fail "$ELYSIUM_USDC is not USDC."
DEC=$(call "$ELYSIUM_USDC" 'decimals()(uint8)')
PER=$(python3 -c "print(500 * 10**$DEC)"); TOTAL=$(python3 -c "print(25000 * 10**$DEC)")
got=$(call "$POOL" 'depositLimit(address)(uint128,uint128)' "$ELYSIUM_USDC" | awk '{print $1}' | paste -sd' ' -)
[ "$got" = "$PER $TOTAL" ] || fail "USDC limit is '$got', not '$PER $TOTAL'."
ok "USDC ($DEC decimals) at 500 / 25,000"
HYPE=$(call "$POOL" 'depositLimit(address)(uint128,uint128)' "$ZERO" | awk '{print $1}' | paste -sd' ' -)
[ "$HYPE" = "0 0" ] || fail "native test HYPE is listed ($HYPE): the testnet takes USDC only."
ok "native test HYPE is not listed"

# The code, the same as on the other chains.
[ "$(codehash "$POSEIDON")" = "$POSEIDON_T3_CODE" ] || fail "PoseidonT3's code is not circomlibjs's."
[ -z "$MEMO" ] || [ "$(codehash "$MEMO")" = "$MEMO_CODE" ] || fail "the memo board's code differs from the other chains'."
ok "PoseidonT3${MEMO:+ and the memo board} byte for byte the other chains'"
if same "$POOL" "$CANON_POOL" && same "$POSEIDON" "$POSEIDON_T3"; then
  for c in "${CANON_CODES[@]}"; do
    read -r name hash <<<"$c"
    [ "$(codehash "$(addr "$name")")" = "$hash" ] || fail "$name's code differs from the other chains'."
  done
  ok "the vault, its verifiers and adapters are byte for byte the other chains', at the same addresses"
else
  echo "note  the addresses differ from the other chains (the deployer's nonce was not 0); the vault's code embeds them, so its hash is not compared"
fi

RELAYER_BAL=$(cast balance "$RELAYER" --rpc-url "$RPC_URL" --ether)
echo "relayer 0xb1E9…512e balance: $RELAYER_BAL test HYPE"
if awk -v b="$RELAYER_BAL" -v t="$RELAYER_TARGET" 'BEGIN { exit !(b < t) }'; then
  echo "note  the relayer holds under $RELAYER_TARGET test HYPE: fund it before the testnet is offered, or relayed sends stop."
fi

# The deployment record.
contract() { jq -n --arg n "$1" --arg a "$(addr "$1")" '{($n): $a}'; }
VERIFIERS=$(jq -s 'add' <(contract ShieldVerifierFinal) <(contract UnshieldVerifierFinal) <(contract UnshieldIVerifierFinal) <(contract TransferVerifierFinal) <(contract TransferIVerifierFinal))
jq -n \
  --arg date "$(date -u +%Y-%m-%d)" --argjson chainId "$CHAIN" --arg pool "$POOL" --argjson block "$BLOCK" --arg tx "$POOL_TX" \
  --arg poseidon "$POSEIDON" --arg dual "$DUAL" --arg shieldI "$SHIELD_I" --arg guard "$GUARD" \
  --arg controller "$CONTROLLER" --arg pending "$PENDING" --arg acceptCtl "${ACCEPT_CONTROLLER_TX:-}" \
  --arg memo "$MEMO" --arg memoBlock "$MEMO_BLOCK" --arg memoTx "$MEMO_TX" \
  --argjson verifiers "$VERIFIERS" \
  --arg usdc "$ELYSIUM_USDC" --argjson dec "$DEC" --arg per "$PER" --arg total "$TOTAL" \
  --arg deployer "$DEPLOYER" --arg treasury "$TREASURY" --arg relayer "$RELAYER" --arg rpc "$RPC_URL" \
  --arg poseidonCode "$POSEIDON_T3_CODE" \
  '{
    deployedAt: $date,
    network: "Elysium testnet",
    chainId: $chainId,
    testnet: true,
    note: "Elysium testnet: a testnet on the mainnet deploy, like Base Sepolia. ShieldPoolPayments on the ceremony'"'"'s final keys, test USDC at Base Sepolia'"'"'s testnet limits (500 / 25,000) and the 0.5% cash-out fee, owned from its deploy by a VaultOwnerGuard (no proof checker can be replaced, ownership cannot move). Deployed with script/DeployElysiumTestnet.s.sol and read back by elysium-testnet-after-deploy.sh. Gas is paid in test HYPE.",
    ceremony: "final (13 contributors, drand 6561386, release ceremony-final)",
    deployer: $deployer,
    owner: $guard,
    guard: { address: $guard, controller: $controller, pendingController: (if $pending == "0x0000000000000000000000000000000000000000" then null else $pending end), acceptControllerTx: (if $acceptCtl == "" then null else $acceptCtl end) },
    feeRecipient: $treasury,
    withdrawFeeBps: 50,
    relayer: $relayer,
    rpc: $rpc,
    contracts: ({
      ShieldPoolPayments: $pool, deployBlock: $block, deployTx: $tx,
      PoseidonT3: $poseidon, PoseidonT3CodeHash: $poseidonCode,
      DualProofVerifier: $dual, ShieldIVerifier: $shieldI, VaultOwnerGuard: $guard
    } + $verifiers + (if $memo == "" then {} else {GloamPayMemo: $memo, GloamPayMemoDeployBlock: ($memoBlock | tonumber), GloamPayMemoDeployTx: $memoTx} end)),
    assets: { USDC: { address: $usdc, decimals: $dec, perDeposit: $per, total: $total } }
  }' > "$OUT"
ok "wrote contracts/$OUT"

# The switch-on: the pool and its block, and the memo board when there is one.
swap "$SDK_ELYSIUM" "$POOL_OFF" "  pool: \"$POOL\","
swap "$SDK_ELYSIUM" "$BLOCK_OFF" "  deployBlock: ${BLOCK}n,"
ON=("  pool: \"$POOL\"," "  deployBlock: ${BLOCK}n,")
if [ -n "$MEMO" ]; then
  swap "$SDK_ELYSIUM" "$MEMO_OFF" "  payMemo: \"$MEMO\","
  swap "$SDK_ELYSIUM" "$MEMO_BLOCK_OFF" "  payMemoBlock: ${MEMO_BLOCK}n,"
  ON+=("  payMemo: \"$MEMO\"," "  payMemoBlock: ${MEMO_BLOCK}n,")
fi
for t in "${ON[@]}"; do
  [ "$(count "$SDK_ELYSIUM" "$t")" = "1" ] || { echo "STOP: could not write the switch-on into $SDK_ELYSIUM. Undo with: git checkout -- $SDK_ELYSIUM" >&2; exit 1; }
done
ok "$NAME filled in: the pool and its block${MEMO:+, and the memo board,} in $SDK_ELYSIUM"
echo
git --no-pager diff --stat -- "$SDK_ELYSIUM" 2>/dev/null || true
echo
echo "Next: the controller accepts (if it is not the deployer), verify the source, then run the SDK, MCP and app tests and open a PR."
