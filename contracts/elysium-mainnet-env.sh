# Elysium mainnet deploy settings (DEPLOY-ELYSIUM.md, step 2).
# Set these three first, then source it from contracts/:
#   export RPC_URL=...              an Elysium mainnet RPC (a keyed one is fine here: it stays in
#                                   this shell, e.g. https://elysium-mainnet.g.alchemy.com/v2/<key>)
#   export ELYSIUM_USDC=0x...       USDC on Elysium (Kinetiq's or Circle's docs)
#   export GUARD_CONTROLLER=0x...   who runs the vault's owner guard: a multisig, or the
#                                   owner wallet 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8
#                                   with GUARD_CONTROLLER_EOA=1 if no Safe exists there yet
#   source elysium-mainnet-env.sh
# The key is read hidden, so it lands in no file and no shell history.
[ -f foundry.toml ] && [ -f script/DeployElysiumMainnet.s.sol ] || { echo "STOP: source this from the contracts/ folder."; return 1 2>/dev/null || exit 1; }
# Elysium mainnet is 99901 (0x1863d, Kinetiq's docs); 99801 only for a rehearsal (ELYSIUM_ALLOW_TESTNET=1).
export ELYSIUM_CHAIN_ID="${ELYSIUM_CHAIN_ID:-99901}"
if [ "$ELYSIUM_CHAIN_ID" != 99901 ] && [ "$ELYSIUM_CHAIN_ID" != 99801 ]; then
  echo "STOP: ELYSIUM_CHAIN_ID is $ELYSIUM_CHAIN_ID; Elysium mainnet is 99901."
  return 1 2>/dev/null || exit 1
fi
_missing=""
for _v in ELYSIUM_CHAIN_ID RPC_URL ELYSIUM_USDC GUARD_CONTROLLER; do
  [ -n "${!_v:-}" ] || _missing="$_missing $_v"
done
if [ -n "$_missing" ]; then
  echo "STOP: set$_missing first (see the top of this file)."
  unset _v _missing
  return 1 2>/dev/null || exit 1
fi
export PATH="$HOME/.foundry/bin:/Users/duke/.nvm/versions/node/v24.11.1/bin:$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1
export CHAIN=$ELYSIUM_CHAIN_ID

_chain=$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)
if [ "$_chain" != "$ELYSIUM_CHAIN_ID" ]; then
  echo "STOP: $RPC_URL answers chain id '${_chain:-nothing}', not ELYSIUM_CHAIN_ID $ELYSIUM_CHAIN_ID."
  unset _v _missing _chain
  return 1 2>/dev/null || exit 1
fi
if [ "$ELYSIUM_CHAIN_ID" = 99801 ] && [ "${ELYSIUM_ALLOW_TESTNET:-0}" != 1 ]; then
  echo "STOP: 99801 is Elysium's testnet. Set ELYSIUM_ALLOW_TESTNET=1 only for a rehearsal there."
  unset _v _missing _chain
  return 1 2>/dev/null || exit 1
fi

# USDC only at launch, at the Base launch caps: 500 per deposit, 25,000 in total, in USDC's own decimals.
_dec=$(cast call "$ELYSIUM_USDC" 'decimals()(uint8)' --rpc-url "$RPC_URL" 2>/dev/null)
_sym=$(cast call "$ELYSIUM_USDC" 'symbol()(string)' --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"')
if ! [[ "$_dec" =~ ^[0-9]+$ ]]; then
  echo "STOP: $ELYSIUM_USDC answers no decimals() on this chain: is it the USDC address?"
  unset _v _missing _chain _dec _sym
  return 1 2>/dev/null || exit 1
fi
export LIMIT_ASSETS=$ELYSIUM_USDC
export LIMIT_PER_DEPOSIT=$(python3 -c "print(500 * 10**$_dec)")
export LIMIT_TOTAL=$(python3 -c "print(25000 * 10**$_dec)")
# The mainnet cash-out fee since 3 Nov 2026: 0.5%, to the treasury.
export WITHDRAW_FEE_BPS=50 FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8
# The guard owns this vault: no NEW_OWNER on this path.
unset NEW_OWNER NEW_OWNER_EOA
export GUARD_CONTROLLER GUARD_CONTROLLER_EOA=${GUARD_CONTROLLER_EOA:-0}
export SCRIPT=script/DeployElysiumMainnet.s.sol:DeployElysiumMainnet

printf "Deployer private key (hidden, then Enter): "
read -rs DEPLOYER_PK
echo
export DEPLOYER_PK
# The deployer is whoever this key belongs to. The first deployer (0x891E...F411) was
# retired on 9 Nov 2026, so Elysium's vault address differs from the other chains;
# elysium-mainnet-after-deploy.sh reads the real addresses from the deploy.
export DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK")

echo "chain:      $_chain   must be $ELYSIUM_CHAIN_ID"
echo "deployer:   $DEPLOYER   the new wallet you funded"
echo "nonce:      $(cast nonce $DEPLOYER --rpc-url "$RPC_URL")   must be 0"
echo "balance:    $(cast balance $DEPLOYER --rpc-url "$RPC_URL" --ether) HYPE   see DEPLOY-ELYSIUM.md step 1"
echo "gas:        $(cast to-unit $(cast gas-price --rpc-url "$RPC_URL") gwei) gwei"
echo "USDC:       $_sym, $_dec decimals   must be USDC; limits $LIMIT_PER_DEPOSIT / $LIMIT_TOTAL raw (500 / 25,000)"
_ctl_code=$(cast code "$GUARD_CONTROLLER" --rpc-url "$RPC_URL")
if [ "$_ctl_code" = 0x ]; then
  echo "controller: $GUARD_CONTROLLER is a plain wallet   needs GUARD_CONTROLLER_EOA=1 (now $GUARD_CONTROLLER_EOA)"
else
  echo "controller: $GUARD_CONTROLLER is a contract (multisig)"
fi
# Forge sets each deploy's gas limit from the RPC's own estimate, times 1.3. An Orbit
# chain's estimate includes the parent chain's data cost, so it reads higher than on
# Ethereum or Base; Robinhood Chain, also Orbit, took the plain command. Ethereum
# Sepolia once charged far more to create a contract than its estimate said, and every
# deploy ran out of gas and burned its nonce: a number far above the others is that.
_gas=$(cast estimate --rpc-url "$RPC_URL" --create $(forge inspect ShieldVerifierFinal bytecode) 2>/dev/null)
echo "deploy gas: ${_gas:-unknown} to create ShieldVerifierFinal   about 389,744 on Ethereum and Base, a little more on an Orbit chain"
if ! [[ "$_gas" =~ ^[0-9]+$ ]] || [ "$_gas" -gt 2000000 ]; then
  echo
  echo "################################################################################"
  echo "STOP. Creating a contract costs far more here than expected (${_gas:-no estimate})."
  echo "Do not broadcast as written: a deploy could run out of gas and burn a nonce."
  echo "Do the dry run first and compare its gas. If a deploy is short, add"
  echo "  --gas-estimate-multiplier 300  to every --broadcast and --resume command,"
  echo "and check the deployer holds three times the deploy's cost. If there was no"
  echo "estimate at all, the RPC did not answer: source this file again."
  echo "################################################################################"
  echo
else
  echo "Ready for step 3 (PoseidonT3)."
fi
unset _v _missing _chain _dec _sym _gas _ctl_code
