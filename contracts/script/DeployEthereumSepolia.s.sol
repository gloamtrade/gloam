// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MainnetDeploy} from "./MainnetDeploy.sol";

/**
 * Gloam on Ethereum Sepolia (chainId 11155111), Ethereum's testnet: the same
 * payments pool, final keys, beta deposit limits and cash-out fee as the
 * mainnets. The deploy itself is MainnetDeploy, shared with
 * Robinhood Chain, Tempo and Base, so a dry run here is a rehearsal of the
 * Ethereum mainnet one.
 *
 * The USER runs this. It is NOT executed by CI or by any agent. Runbook:
 * DEPLOY-ETHEREUM-SEPOLIA.md, settings in contracts/ethereum-sepolia-env.sh.
 *
 * Before running:
 *   1. Keys: the script deploys the ceremony-final verifiers (src/verifiers/final)
 *      and refuses to create the pool unless they accept final-key proofs and
 *      reject dev-key ones (MainnetDeploy._requireCeremonyKeys).
 *   2. Deploy PoseidonT3 only:  POSEIDON_T3_ONLY=1 node circuits/scripts/deploy-poseidon.mjs
 *      From a deployer with no transactions on this chain that lands at
 *      0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4 and this script's pool at
 *      0x39e28cde55cab798874746ac52cb4b5cc99a0194, the same as on the other chains.
 *
 *   export DEPLOYER_PK=0x...            # funded deployer (gas is paid in Sepolia ETH)
 *   export DEPLOYER=0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411   # the key must be this address's
 *   export RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
 *   export POSEIDON2=0x...              # PoseidonT3 from step 2
 *   # Circle's test USDC and EURC, and Paxos's test USDG and PYUSD (Paxos testnet docs),
 *   # all 6 decimals, checked on-chain 2026-10-25. 0x0 lists native ETH (18 decimals).
 *   # No Tether-issued USDT exists on Sepolia, so none is listed.
 *   # The three lists below go in the same order: USDC, USDG, PYUSD, EURC, ETH.
 *   export LIMIT_ASSETS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,0xfBb2A78CceEb415b00300925e464C3E44E6e06b0,0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9,0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4,0x0000000000000000000000000000000000000000
 *   export LIMIT_PER_DEPOSIT=500000000,500000000,500000000,500000000,200000000000000000                # 500 each stablecoin; 0.2 ETH
 *   export LIMIT_TOTAL=25000000000,25000000000,25000000000,25000000000,10000000000000000000            # 25,000 each stablecoin; 10 ETH
 *   # Cash-out fee: deposits and private transfers are free, unshield keeps this share of the
 *   # amount for FEE_RECIPIENT (paid out by collectFees(asset)). Capped at 100 bps (1%) in the contract.
 *   export WITHDRAW_FEE_BPS=50          # 0.5%; this is the default when unset
 *   export FEE_RECIPIENT=0xB3900ac9350903218e4c7597bAb0f008F01B30B8   # the treasury
 *   export NEW_OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8       # it must call acceptOwnership()
 *   export NEW_OWNER_EOA=1              # the owner is a wallet, not a multisig, as on the other chains
 *
 * Run (Sepolia blocks hold 60M gas; the largest call here, the pool, is about
 * 11.9 KB of code, under the 24 KB limit). Dry run first, then:
 *   forge script script/DeployEthereumSepolia.s.sol:DeployEthereumSepolia --rpc-url $RPC_URL --broadcast --slow
 *
 * After: record the pool address and deploy block in ETHEREUM_SEPOLIA_POOL
 * (app/src/lib/mainnet.ts and packages/sdk/src/mainnet.ts).
 */
contract DeployEthereumSepolia is MainnetDeploy {
    uint256 constant ETHEREUM_SEPOLIA = 11155111;

    function run() external {
        _deployMainnet(ETHEREUM_SEPOLIA, true);
    }
}
