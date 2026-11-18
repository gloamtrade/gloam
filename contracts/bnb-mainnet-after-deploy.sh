#!/bin/bash
# After the BNB Chain mainnet deploy (DEPLOY-BNB.md, step 8). Run from contracts/, with the
# same settings as the deploy still set (source bnb-mainnet-env.sh, or export them):
#   RPC_URL=... DEPLOYER=0x... ./bnb-mainnet-after-deploy.sh
# Optional:
#   GUARD_CONTROLLER=0x...      the controller the deploy named (default: the Gloam Owner Safe)
#   ACCEPT_CONTROLLER_TX=0x...  GUARD_CONTROLLER's acceptController() on the guard (step 7);
#                               it is checked and recorded
# It stops unless the guard's controller is GUARD_CONTROLLER with no handover pending: run it
# after the Safe accepts the guard (step 7), never before, so the pool is only switched on in
# packages/sdk/src/bnb.ts once the deployer no longer runs the guard. A controller other than
# the Safe also needs BNB_ALLOW_OTHER_CONTROLLER=1.
#   BNB_STABLE_LIMITS, BNB_NATIVE_LIMITS, BNB_BDX_LIMITS   if the deploy used other limits than the
#                               defaults (see bnb-mainnet-env.sh); each is checked against the chain
# It reads the deploy back from the chain and stops at the first thing that is not as the
# runbook set it. If all is right it writes deployments/bnb-mainnet.json and the switch-on:
# the pool and its deploy block (and the memo board, if it was deployed) in
# packages/sdk/src/bnb.ts, the one file the app, the SDK and the MCP read BNB Chain from.
# Reads only: it sends nothing and needs no key.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:/Users/duke/.nvm/versions/node/v24.11.1/bin:$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1

: "${RPC_URL:?set RPC_URL, a BNB Chain mainnet RPC}"
CHAIN=56
NAME="BNB Chain mainnet"
# BROADCAST_DIR and OUT are for bnb-mainnet-rehearsal.sh only, which runs all of this on a local fork.
BROADCAST_DIR=${BROADCAST_DIR:-broadcast}
RUN=$BROADCAST_DIR/DeployBnbMainnet.s.sol/$CHAIN/run-latest.json
MRUN=$BROADCAST_DIR/DeployGloamPayMemo.s.sol/$CHAIN/run-latest.json
OUT=${OUT:-deployments/bnb-mainnet.json}
SDK_BNB=${SDK_BNB:-../packages/sdk/src/bnb.ts}
# What the relayer should hold before the flag is turned on (DEPLOY-BNB.md, step 2): about
# an hour of relayed sends at the hourly cap (GLOAM_RELAY_HOURLY_SPEND_56, default 0.05 BNB).
RELAYER_TARGET=${RELAYER_TARGET:-0.05}

DEPLOYER=${DEPLOYER:?set DEPLOYER, the address that ran the deploy}
SAFE=0x8E74b2b85b40f36771f92392b42BBaeacDC75507
GUARD_CONTROLLER=${GUARD_CONTROLLER:-$SAFE}
TREASURY=0xB3900ac9350903218e4c7597bAb0f008F01B30B8
RELAYER=0xb1E994586E62994648a0b866BF33F2EDd942512e
ZERO=0x0000000000000000000000000000000000000000
FEE_BPS=50
USDT=0x55d398326f99059fF775485246999027B3197955
USDC=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d
BDX=0x6ad12E761b438beA3EA09F6C6266556Bb24C2181
# Where everything lands from the planned deployer 0xec99...6b60 at nonce 0: the same
# addresses as on Elysium (deployments/elysium-mainnet.json).
PLANNED_POSEIDON=0x62c435CE6886fa91e3b0e91500c6dC9219723457
PLANNED_POOL=0x89d3042390204f57b8b4F8949D3c2203E4002164
# Code hashes as on every other chain.
POSEIDON_T3_CODE=0x354b26999e434f8256d168395315e1f51fc15bf49bf2e6bb58fc549bd597e7da
MEMO_CODE=0xf24e84ff514b7b8e3eba03c4b7ac70bbeb8b799b5fd3006d552a34362cf5edae
# The three Groth16 verifiers hold the final keys in their code, so their hash is the same at any address.
KEY_CODES=(
  "ShieldVerifierFinal 0xf6a771ca5059d079059ea1352d0d962ac87766169a6c87504d0adcc568531a37"
  "UnshieldVerifierFinal 0x29aa6c0a70397a3fd697f4c7add0599da4d137b61e659d95f390c0ed4247c55a"
  "TransferVerifierFinal 0x82a755477429f574f86070c02778a87b4806e6fc9ba7c26076dfe74af57947e2"
)
# The adapters, the DualProofVerifier and the vault hold the addresses of what they point at,
# so these match only at the planned addresses. Read from Elysium's live contracts on
# 18 Nov 2026; test/DeployBnb.t.sol checks a fresh build lands on the same hashes.
PLANNED_CODES=(
  "ShieldIVerifierFinal 0xabdd6484a23bcb1c26d272c7ed95c616e6a55838f0d819ca33eb4f7ff276eadb"
  "UnshieldIVerifierFinal 0x560633c29a286559c39d0731926915bd132904c6f4cb36983afa97a9a8aca91b"
  "TransferIVerifierFinal 0x8bfdc146365f01d330cd0e4d54a0346c24b74dd3a48f53027e293d989b29159a"
  "DualProofVerifier 0xa3b1c3d3f4fc9393ffdee6ab52ec8590e2d07ba230dd236ee8837d97e81e45ef"
  "ShieldPoolPayments 0x6c08d853f894304930eb234dac17256cdbe0bf1141c3c0df2ef61690603c629d"
)

fail() { echo "STOP: $*" >&2; echo "Nothing was written. Fix it, or tell the team before turning $NAME on." >&2; exit 1; }
ok() { echo "ok    $*"; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
same() { [ "$(lc "$1")" = "$(lc "$2")" ]; }
call() { cast call "$@" --rpc-url "$RPC_URL"; }
codehash() { cast code "$1" --rpc-url "$RPC_URL" | cast keccak; }
# How often a piece of text appears in BNB_MAINNET's block of the file, and swapping it there.
SDK_BLOCK=BNB_MAINNET
count() { NAME="$SDK_BLOCK" OFF="$2" perl -0ne 'if (/(export const \Q$ENV{NAME}\E: BnbMainnetInput = \{.*?\n\};)/s) { my $b = $1; my $c = () = $b =~ /\Q$ENV{OFF}\E/g; print $c + 0 } else { print -1 }' "$1"; }
swap() { NAME="$SDK_BLOCK" OFF="$2" ON="$3" perl -0pi -e 's/(export const \Q$ENV{NAME}\E: BnbMainnetInput = \{.*?\n\};)/my $b = $1; $b =~ s{\Q$ENV{OFF}\E}{$ENV{ON}}; $b/se' "$1"; }

# The switch-on, as BNB_MAINNET in packages/sdk/src/bnb.ts reads before the deploy. Each line exactly once there.
POOL_OFF='  pool: null,'
BLOCK_OFF='  deployBlock: null,'
MEMO_OFF='  payMemo: null,'
MEMO_BLOCK_OFF='  payMemoBlock: null,'

[ -f "$RUN" ] || fail "$RUN is missing: run this from the contracts/ folder the deploy ran in."
[ -f "$SDK_BNB" ] || fail "$SDK_BNB is missing."
for t in "$POOL_OFF" "$BLOCK_OFF" "$MEMO_OFF" "$MEMO_BLOCK_OFF"; do
  n=$(count "$SDK_BNB" "$t")
  [ "$n" = "1" ] || fail "$SDK_BNB does not read as before the switch-on ('$t' found $n times, not once): already switched on?"
done
[ "$(cast chain-id --rpc-url "$RPC_URL")" = "$CHAIN" ] || fail "$RPC_URL is not chain $CHAIN."

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
  echo "pool $POOL block $BLOCK, guard $GUARD, no memo board yet (step 6)"
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
# Nothing is written until the guard is in GUARD_CONTROLLER's hands (the Safe), with no handover pending.
same "$GUARD_CONTROLLER" "$SAFE" || [ "${BNB_ALLOW_OTHER_CONTROLLER:-0}" = 1 ] || fail "GUARD_CONTROLLER is $GUARD_CONTROLLER, not the Gloam Owner Safe $SAFE. Set BNB_ALLOW_OTHER_CONTROLLER=1 only if that was the plan."
same "$GUARD_CONTROLLER" "$DEPLOYER" && fail "GUARD_CONTROLLER is the deployer: the guard must be handed to the Safe before BNB Chain is switched on."
if same "$CONTROLLER" "$DEPLOYER" && same "$PENDING" "$GUARD_CONTROLLER"; then
  fail "GUARD_CONTROLLER $GUARD_CONTROLLER has not called acceptController() on the guard yet (step 7). Run this again once it has."
fi
same "$CONTROLLER" "$GUARD_CONTROLLER" || fail "the guard's controller is $CONTROLLER, not GUARD_CONTROLLER $GUARD_CONTROLLER."
same "$PENDING" "$ZERO" || fail "the guard has another controller handover pending ($PENDING)."
ok "guard controller is $GUARD_CONTROLLER, accepted, nothing pending"
if same "$GUARD_CONTROLLER" "$SAFE"; then
  owners=$(call "$SAFE" 'getOwners()(address[])' | tr -d ' ')
  thr=$(call "$SAFE" 'getThreshold()(uint256)')
  [ "$owners" = "[0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8,0x0b827E40443579391F7Df83A563A276Ce8d8C4df,0xf9B744fC1E018bf82Dc84Be7A9AD2b34A2DeD3d7]" ] || fail "the Safe's owners on BNB Chain are $owners, not the three Gloam Owner signers."
  [ "$thr" = "2" ] || fail "the Safe's threshold on BNB Chain is $thr, not 2."
  ok "the Safe on BNB Chain is the Gloam Owner Safe: the same three signers, 2 of 3"
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

# The assets: each token is what it should be, each limit in its own decimals.
lim() { # spec decimals -> "per total"
  python3 - "$1" "$2" <<'PY'
import sys
spec, dec = sys.argv[1].strip().lower(), int(sys.argv[2])
MAX = 2**128 - 1
if spec == "max":
    print(MAX, MAX)
else:
    per, total = (int(x.replace("_", "").replace(",", "")) for x in spec.split("/"))
    print(per * 10**dec, total * 10**dec)
PY
}
ASSETS_JSON="{}"
check_asset() { # symbol address spec
  local sym=$1 a=$2 spec=$3 dec want got human
  if [ "$a" = "$ZERO" ]; then
    dec=18
  else
    [ "$(call "$a" 'symbol()(string)')" = "\"$sym\"" ] || fail "$a is not $sym."
    dec=$(call "$a" 'decimals()(uint8)')
  fi
  want=$(lim "$spec" "$dec")
  got=$(call "$POOL" 'depositLimit(address)(uint128,uint128)' "$a" | awk '{print $1}' | paste -sd' ' -)
  [ "$got" = "$want" ] || fail "$sym limit is '$got', not '$want' ($spec in $dec decimals)."
  human=$([ "$spec" = max ] && echo "no limit" || echo "$spec")
  ok "$sym ($dec decimals): $human"
  ASSETS_JSON=$(jq -c --arg s "$sym" --arg a "$a" --argjson d "$dec" --arg p "${want% *}" --arg t "${want#* }" '. + {($s): {address: $a, decimals: $d, perDeposit: $p, total: $t}}' <<<"$ASSETS_JSON")
}
check_asset USDT "$USDT" "${BNB_STABLE_LIMITS:-max}"
check_asset USDC "$USDC" "${BNB_STABLE_LIMITS:-max}"
check_asset BNB "$ZERO" "${BNB_NATIVE_LIMITS:-max}"
check_asset BDX "$BDX" "${BNB_BDX_LIMITS:-100000/2000000}"
# BDX is Beldex's LayerZero OFT: the token is its own OFT (token() is itself).
same "$(call "$BDX" 'token()(address)')" "$BDX" || fail "BDX is not the LayerZero OFT (token() is not itself)."
ok "BDX is the canonical OFT"

# The code, the same as on the other chains.
[ "$(codehash "$POSEIDON")" = "$POSEIDON_T3_CODE" ] || fail "PoseidonT3's code is not circomlibjs's."
[ -z "$MEMO" ] || [ "$(codehash "$MEMO")" = "$MEMO_CODE" ] || fail "the memo board's code differs from the other chains'."
ok "PoseidonT3${MEMO:+ and the memo board} byte for byte the other chains'"
if same "$POOL" "$PLANNED_POOL" && same "$POSEIDON" "$PLANNED_POSEIDON"; then
  for c in "${PLANNED_CODES[@]}"; do
    read -r name hash <<<"$c"
    [ "$(codehash "$(addr "$name")")" = "$hash" ] || fail "$name's code differs from Elysium's."
  done
  ok "the vault, its verifiers and adapters are byte for byte Elysium's, at the same addresses"
else
  echo "note  the addresses differ from the planned ones (the deployer's nonce was not 0); the vault's code embeds them, so its hash is not compared"
fi

RELAYER_BAL=$(cast balance "$RELAYER" --rpc-url "$RPC_URL" --ether)
echo "relayer 0xb1E9…512e balance: $RELAYER_BAL BNB"
if awk -v b="$RELAYER_BAL" -v t="$RELAYER_TARGET" 'BEGIN { exit !(b < t) }'; then
  echo "note  the relayer holds under $RELAYER_TARGET BNB: fund it (step 2) before the flag is turned on, or relayed sends stop."
fi

# The deployment record.
contract() { jq -n --arg n "$1" --arg a "$(addr "$1")" '{($n): $a}'; }
VERIFIERS=$(jq -s 'add' <(contract ShieldVerifierFinal) <(contract UnshieldVerifierFinal) <(contract UnshieldIVerifierFinal) <(contract TransferVerifierFinal) <(contract TransferIVerifierFinal))
jq -n \
  --arg date "$(date -u +%Y-%m-%d)" --argjson chainId "$CHAIN" --arg pool "$POOL" --argjson block "$BLOCK" --arg tx "$POOL_TX" \
  --arg poseidon "$POSEIDON" --arg dual "$DUAL" --arg shieldI "$SHIELD_I" --arg guard "$GUARD" \
  --arg controller "$CONTROLLER" --arg pending "$PENDING" --arg acceptCtl "${ACCEPT_CONTROLLER_TX:-}" \
  --arg memo "$MEMO" --arg memoBlock "$MEMO_BLOCK" --arg memoTx "$MEMO_TX" \
  --argjson verifiers "$VERIFIERS" --argjson assets "$ASSETS_JSON" \
  --arg deployer "$DEPLOYER" --arg treasury "$TREASURY" --arg relayer "$RELAYER" \
  --arg poseidonCode "$POSEIDON_T3_CODE" \
  '{
    deployedAt: $date,
    network: "BNB Chain",
    chainId: $chainId,
    testnet: false,
    note: "BNB Chain mainnet (BNB Smart Chain): ShieldPoolPayments on the ceremony'"'"'s final keys, with the 0.5% cash-out fee, owned from its deploy by a VaultOwnerGuard (no proof checker can be replaced, ownership cannot move). Deployed with script/DeployBnbMainnet.s.sol (DEPLOY-BNB.md) and read back by bnb-mainnet-after-deploy.sh. Gas is paid in BNB. USDT and USDC have 18 decimals here.",
    ceremony: "final (13 contributors, drand 6561386, release ceremony-final)",
    deployer: $deployer,
    owner: $guard,
    guard: { address: $guard, controller: $controller, pendingController: (if $pending == "0x0000000000000000000000000000000000000000" then null else $pending end), acceptControllerTx: (if $acceptCtl == "" then null else $acceptCtl end) },
    feeRecipient: $treasury,
    withdrawFeeBps: 50,
    relayer: $relayer,
    rpc: "https://bsc-rpc.publicnode.com",
    explorer: "https://bscscan.com",
    contracts: ({
      ShieldPoolPayments: $pool, deployBlock: $block, deployTx: $tx,
      PoseidonT3: $poseidon, PoseidonT3CodeHash: $poseidonCode,
      DualProofVerifier: $dual, ShieldIVerifier: $shieldI, VaultOwnerGuard: $guard
    } + $verifiers + (if $memo == "" then {} else {GloamPayMemo: $memo, GloamPayMemoDeployBlock: ($memoBlock | tonumber), GloamPayMemoDeployTx: $memoTx} end)),
    assets: $assets
  }' > "$OUT"
ok "wrote $OUT"

# The switch-on: the pool and its block, and the memo board when there is one.
swap "$SDK_BNB" "$POOL_OFF" "  pool: \"$POOL\","
swap "$SDK_BNB" "$BLOCK_OFF" "  deployBlock: ${BLOCK}n,"
ON=("  pool: \"$POOL\"," "  deployBlock: ${BLOCK}n,")
if [ -n "$MEMO" ]; then
  swap "$SDK_BNB" "$MEMO_OFF" "  payMemo: \"$MEMO\","
  swap "$SDK_BNB" "$MEMO_BLOCK_OFF" "  payMemoBlock: ${MEMO_BLOCK}n,"
  ON+=("  payMemo: \"$MEMO\"," "  payMemoBlock: ${MEMO_BLOCK}n,")
fi
for t in "${ON[@]}"; do
  [ "$(count "$SDK_BNB" "$t")" = "1" ] || { echo "STOP: could not write the switch-on into $SDK_BNB. Undo with: git checkout -- $SDK_BNB" >&2; exit 1; }
done
ok "$NAME filled in: the pool and its block${MEMO:+, and the memo board,} in $SDK_BNB"
echo
git --no-pager diff --stat -- "$SDK_BNB" 2>/dev/null || true
echo
echo "Next: step 9 (verify the source), then the switch-on PR."
