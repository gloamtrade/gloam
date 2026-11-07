# Elysium testnet deploy settings (chain id 99801). Set this one first, then source it from contracts/:
#   export GUARD_CONTROLLER=0x...   who runs the vault's owner guard: a multisig, or the
#                                   owner wallet 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8
#                                   with GUARD_CONTROLLER_EOA=1
#   source elysium-testnet-env.sh
# RPC_URL defaults to Kinetiq's public testnet RPC, https://testnet-rpc.elysium.kinetiq.xyz
# (Conduit's https://rpc-elysium-testnet.t.conduit.xyz works too). Never an RPC with an API key
# in it here if you paste the command anywhere.
# The key is read hidden, so it lands in no file and no shell history.
[ -f foundry.toml ] && [ -f script/DeployElysiumTestnet.s.sol ] || { echo "STOP: source this from the contracts/ folder."; return 1 2>/dev/null || exit 1; }
if [ -z "${GUARD_CONTROLLER:-}" ]; then
  echo "STOP: set GUARD_CONTROLLER first (see the top of this file)."
  return 1 2>/dev/null || exit 1
fi
export RPC_URL=${RPC_URL:-https://testnet-rpc.elysium.kinetiq.xyz}
# Kinetiq's test USDC on Elysium testnet (6 decimals, checked on chain 7 November 2026).
export ELYSIUM_TESTNET_USDC=${ELYSIUM_TESTNET_USDC:-0x7D29d8047B905000459c0E80c34a26CeedcB47b2}
export PATH="$HOME/.foundry/bin:/Users/duke/.nvm/versions/node/v24.11.1/bin:$PATH" FOUNDRY_DISABLE_NIGHTLY_WARNING=1
export ELYSIUM_CHAIN_ID=99801 CHAIN=99801

_chain=$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)
if [ "$_chain" != 99801 ]; then
  echo "STOP: $RPC_URL answers chain id '${_chain:-nothing}', not 99801 (Elysium testnet)."
  unset _v _missing _chain
  return 1 2>/dev/null || exit 1
fi

# Test USDC only, at Base Sepolia's testnet limits: 500 per deposit, 25,000 in total, in its own decimals.
_dec=$(cast call "$ELYSIUM_TESTNET_USDC" 'decimals()(uint8)' --rpc-url "$RPC_URL" 2>/dev/null)
_sym=$(cast call "$ELYSIUM_TESTNET_USDC" 'symbol()(string)' --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"')
if ! [[ "$_dec" =~ ^[0-9]+$ ]]; then
  echo "STOP: $ELYSIUM_TESTNET_USDC answers no decimals() on this chain: is it the test USDC address?"
  unset _v _missing _chain _dec _sym
  return 1 2>/dev/null || exit 1
fi
export LIMIT_ASSETS=$ELYSIUM_TESTNET_USDC
export LIMIT_PER_DEPOSIT=$(python3 -c "print(500 * 10**$_dec)")
export LIMIT_TOTAL=$(python3 -c "print(25000 * 10**$_dec)")
# The cash-out fee: 0.5% to the treasury, Elysium mainnet's, so a test there runs mainnet's numbers.
export WITHDRAW_FEE_BPS=50 FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8
# The guard owns this vault: no NEW_OWNER on this path.
unset NEW_OWNER NEW_OWNER_EOA
export GUARD_CONTROLLER GUARD_CONTROLLER_EOA=${GUARD_CONTROLLER_EOA:-0}
# The deploy scripts refuse a DEPLOYER_PK that is not this address's key.
export DEPLOYER=0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411
export SCRIPT=script/DeployElysiumTestnet.s.sol:DeployElysiumTestnet

printf "Deployer private key (hidden, then Enter): "
read -rs DEPLOYER_PK
echo
export DEPLOYER_PK

echo "chain:      $_chain   must be 99801"
echo "deployer:   $(cast wallet address --private-key "$DEPLOYER_PK")   must be $DEPLOYER"
echo "nonce:      $(cast nonce $DEPLOYER --rpc-url "$RPC_URL")   must be 0"
echo "balance:    $(cast balance $DEPLOYER --rpc-url "$RPC_URL" --ether) test HYPE   enough for about 9M gas"
echo "gas:        $(cast to-unit $(cast gas-price --rpc-url "$RPC_URL") gwei) gwei"
echo "USDC:       $_sym, $_dec decimals   must be USDC, 6; limits $LIMIT_PER_DEPOSIT / $LIMIT_TOTAL raw (500 / 25,000)"
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
