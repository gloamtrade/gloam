# BNB Chain mainnet deploy settings (DEPLOY-BNB.md, step 3).
# Set RPC_URL first, then source it from contracts/:
#   export RPC_URL=...              a BNB Chain mainnet RPC (a keyed one is fine here: it stays in
#                                   this shell). https://bsc-dataseed.bnbchain.org works for the deploy.
#   export GUARD_CONTROLLER=0x...   optional: who runs the vault's owner guard. Default: the Gloam Owner
#                                   Safe 0x8E74b2b85b40f36771f92392b42BBaeacDC75507, replayed on BNB Chain
#                                   first (step 1). The owner wallet 0x76b7...D4D8 with
#                                   GUARD_CONTROLLER_EOA=1 only if the Safe is not there.
#   source bnb-mainnet-env.sh
#
# Limits, each written in whole tokens and turned into raw units with the token's own
# decimals() read on chain (USDT and USDC have 18 here, BDX 9). "max" is no limit
# (type(uint128).max). Defaults: the policy live on Base on 18 Nov 2026.
#   BNB_STABLE_LIMITS   USDT and USDC, "max" or "<per deposit>/<total>", default max
#   BNB_NATIVE_LIMITS   BNB,           "max" or "<per deposit>/<total>", default max
#   BNB_BDX_LIMITS      BDX,           "max" or "<per deposit>/<total>", default 100000/2000000
# The key is read hidden, so it lands in no file and no shell history.
[ -f foundry.toml ] && [ -f script/DeployBnbMainnet.s.sol ] || { echo "STOP: source this from the contracts/ folder."; return 1 2>/dev/null || exit 1; }
if [ -z "${RPC_URL:-}" ]; then
  echo "STOP: set RPC_URL first (see the top of this file)."
  return 1 2>/dev/null || exit 1
fi
export PATH="$HOME/.foundry/bin:/Users/duke/.nvm/versions/node/v24.11.1/bin:$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1
export CHAIN=56

_chain=$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)
if [ "$_chain" != 56 ]; then
  echo "STOP: $RPC_URL answers chain id '${_chain:-nothing}', not 56 (BNB Smart Chain mainnet)."
  unset _chain
  return 1 2>/dev/null || exit 1
fi

BNB_USDT=0x55d398326f99059fF775485246999027B3197955
BNB_USDC=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d
BNB_BDX=0x6ad12E761b438beA3EA09F6C6266556Bb24C2181
BNB_SAFE=0x8E74b2b85b40f36771f92392b42BBaeacDC75507
export BNB_USDT BNB_USDC BNB_BDX

# One token: its symbol must be what we list, its decimals are read, never assumed.
_tok() { # name address expected-symbol -> sets _dec_<name>
  local sym dec
  sym=$(cast call "$2" 'symbol()(string)' --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"')
  dec=$(cast call "$2" 'decimals()(uint8)' --rpc-url "$RPC_URL" 2>/dev/null)
  if [ "$sym" != "$3" ] || ! [[ "$dec" =~ ^[0-9]+$ ]]; then
    echo "STOP: $2 answers symbol '${sym:-nothing}' and decimals '${dec:-nothing}', not $3."
    return 1
  fi
  eval "_dec_$1=$dec"
}
_tok usdt "$BNB_USDT" USDT && _tok usdc "$BNB_USDC" USDC && _tok bdx "$BNB_BDX" BDX || { unset _chain; return 1 2>/dev/null || exit 1; }

# "max", or "<per>/<total>" in whole tokens, to raw units with `dec` decimals: prints "per total".
_lim() { # spec decimals
  python3 - "$1" "$2" <<'PY'
import sys
spec, dec = sys.argv[1].strip().lower(), int(sys.argv[2])
MAX = 2**128 - 1
if spec == "max":
    print(MAX, MAX); sys.exit(0)
try:
    per, total = (int(x.replace("_", "").replace(",", "")) for x in spec.split("/"))
except Exception:
    print("bad"); sys.exit(0)
p, t = per * 10**dec, total * 10**dec
print("bad" if not (0 < p <= t <= MAX) else f"{p} {t}")
PY
}
read -r _usdt_per _usdt_total <<<"$(_lim "${BNB_STABLE_LIMITS:-max}" "$_dec_usdt")"
read -r _usdc_per _usdc_total <<<"$(_lim "${BNB_STABLE_LIMITS:-max}" "$_dec_usdc")"
read -r _bnb_per _bnb_total <<<"$(_lim "${BNB_NATIVE_LIMITS:-max}" 18)"
read -r _bdx_per _bdx_total <<<"$(_lim "${BNB_BDX_LIMITS:-100000/2000000}" "$_dec_bdx")"
for _v in "$_usdt_per" "$_usdc_per" "$_bnb_per" "$_bdx_per"; do
  if [ "$_v" = bad ] || [ -z "$_v" ]; then
    echo "STOP: a limit setting is not \"max\" or \"<per deposit>/<total>\" in whole tokens with 0 < per <= total."
    unset _chain _v
    return 1 2>/dev/null || exit 1
  fi
done
# Listed in the deploy itself, so none of them waits on the 3-day timelock.
export LIMIT_ASSETS="$BNB_USDT,$BNB_USDC,0x0000000000000000000000000000000000000000,$BNB_BDX"
export LIMIT_PER_DEPOSIT="$_usdt_per,$_usdc_per,$_bnb_per,$_bdx_per"
export LIMIT_TOTAL="$_usdt_total,$_usdc_total,$_bnb_total,$_bdx_total"
# The mainnet cash-out fee since 3 Nov 2026: 0.5%, to the treasury.
export WITHDRAW_FEE_BPS=50 FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8
# The guard owns this vault: no NEW_OWNER on this path.
unset NEW_OWNER NEW_OWNER_EOA BNB_ALLOW_OTHER_ASSETS
export GUARD_CONTROLLER="${GUARD_CONTROLLER:-$BNB_SAFE}" GUARD_CONTROLLER_EOA=${GUARD_CONTROLLER_EOA:-0}
export SCRIPT=script/DeployBnbMainnet.s.sol:DeployBnbMainnet

printf "Deployer private key (hidden, then Enter): "
read -rs DEPLOYER_PK
echo
export DEPLOYER_PK
export DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK")
_nonce=$(cast nonce "$DEPLOYER" --rpc-url "$RPC_URL")
_gp=$(cast gas-price --rpc-url "$RPC_URL")

_human() { python3 -c "import sys; v=int(sys.argv[1]); d=int(sys.argv[2]); print('no limit' if v==2**128-1 else f'{v/10**d:,.0f}')" "$1" "$2"; }
echo "chain:      $_chain   must be 56"
echo "deployer:   $DEPLOYER   0xec9993765e249e8e9DC677B7BCB61F78b31c6b60 for the planned addresses"
echo "nonce:      $_nonce   must be 0 (PoseidonT3 is the first transaction)"
echo "balance:    $(cast balance "$DEPLOYER" --rpc-url "$RPC_URL" --ether) BNB   see DEPLOY-BNB.md step 2"
echo "gas:        $(cast to-unit "$_gp" gwei) gwei"
echo "USDT:       $_dec_usdt decimals, $(_human "$_usdt_per" "$_dec_usdt") per deposit, $(_human "$_usdt_total" "$_dec_usdt") in total"
echo "USDC:       $_dec_usdc decimals, $(_human "$_usdc_per" "$_dec_usdc") per deposit, $(_human "$_usdc_total" "$_dec_usdc") in total"
echo "BNB:        18 decimals, $(_human "$_bnb_per" 18) per deposit, $(_human "$_bnb_total" 18) in total"
echo "BDX:        $_dec_bdx decimals, $(_human "$_bdx_per" "$_dec_bdx") per deposit, $(_human "$_bdx_total" "$_dec_bdx") in total"
if [ "$_dec_usdt" != 18 ] || [ "$_dec_usdc" != 18 ] || [ "$_dec_bdx" != 9 ]; then
  echo "NOTE: decimals differ from the 18 / 18 / 9 read on 18 Nov 2026. The limits above follow the chain; check them, and packages/sdk/src/bnb.ts."
fi
_ctl_code=$(cast code "$GUARD_CONTROLLER" --rpc-url "$RPC_URL")
if [ "$_ctl_code" = 0x ]; then
  echo "controller: $GUARD_CONTROLLER is a plain wallet or not deployed   needs GUARD_CONTROLLER_EOA=1 (now $GUARD_CONTROLLER_EOA)"
  [ "$GUARD_CONTROLLER" = "$BNB_SAFE" ] && echo "            the Safe is not on BNB Chain yet: replay it first (DEPLOY-BNB.md step 1)"
else
  _owners=$(cast call "$GUARD_CONTROLLER" 'getOwners()(address[])' --rpc-url "$RPC_URL" 2>/dev/null)
  _thr=$(cast call "$GUARD_CONTROLLER" 'getThreshold()(uint256)' --rpc-url "$RPC_URL" 2>/dev/null)
  echo "controller: $GUARD_CONTROLLER is a contract: owners ${_owners:-?}, threshold ${_thr:-?}   must be 2 of the three signers"
fi
if [ "$_nonce" != 0 ]; then
  echo "NOTE: the deployer's nonce is $_nonce, not 0: the vault will not land at 0x89d3...2164. That is safe, but the planned addresses in DEPLOY-BNB.md no longer apply."
fi
# BNB Chain meters plain EVM gas: creating ShieldVerifierFinal was about 389,744 on Ethereum,
# Base and Elysium. A number far above it means something is off: do not broadcast.
_gas=$(cast estimate --rpc-url "$RPC_URL" --create $(forge inspect ShieldVerifierFinal bytecode) 2>/dev/null)
echo "deploy gas: ${_gas:-unknown} to create ShieldVerifierFinal   about 389,744 elsewhere"
if ! [[ "$_gas" =~ ^[0-9]+$ ]] || [ "$_gas" -gt 1000000 ]; then
  echo
  echo "################################################################################"
  echo "STOP. Creating a contract costs far more here than expected (${_gas:-no estimate})."
  echo "Do not broadcast as written. Do the dry run first and compare its gas. If there"
  echo "was no estimate at all, the RPC did not answer: source this file again."
  echo "################################################################################"
  echo
else
  echo "Ready for step 4 (PoseidonT3)."
fi
unset _chain _v _nonce _gp _gas _ctl_code _owners _thr _dec_usdt _dec_usdc _dec_bdx _usdt_per _usdt_total _usdc_per _usdc_total _bnb_per _bnb_total _bdx_per _bdx_total
