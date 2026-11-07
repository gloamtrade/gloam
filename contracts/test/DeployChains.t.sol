// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployRobinhoodMainnet} from "../script/DeployRobinhoodMainnet.s.sol";
import {DeployTempoMainnet} from "../script/DeployTempoMainnet.s.sol";
import {DeployBaseSepolia} from "../script/DeployBaseSepolia.s.sol";
import {DeployBaseMainnet} from "../script/DeployBaseMainnet.s.sol";
import {DeployEthereumMainnet} from "../script/DeployEthereumMainnet.s.sol";
import {DeployEthereumSepolia} from "../script/DeployEthereumSepolia.s.sol";
import {DeployElysiumTestnet} from "../script/DeployElysiumTestnet.s.sol";

interface IRun {
    function run() external;
}

/**
 * Every mainnet deploy script (all on the shared MainnetDeploy) runs on its own
 * chain only: on any other chain Gloam knows, on the local test chain and on
 * the testnets next to its mainnet, it stops before it reads a key or sends
 * anything. A deploy pointed at the wrong RPC cannot land a pool there.
 */
contract DeployChainsTest is Test {
    /// Chains a deploy could be pointed at by mistake: every Gloam chain, Ethereum's testnets, and the local chain.
    uint256[] chains = [uint256(1), 4663, 46630, 4217, 42431, 8453, 84532, 11155111, 99801, 99901, 560048, 17000, 31337];

    function _refusesAllBut(IRun script, uint256 own) internal {
        for (uint256 i = 0; i < chains.length; i++) {
            if (chains[i] == own) continue;
            vm.chainId(chains[i]);
            vm.expectRevert(bytes("wrong chain for this script"));
            script.run();
        }
    }

    function test_ethereum_mainnet_runs_only_on_chain_1() public {
        _refusesAllBut(IRun(address(new DeployEthereumMainnet())), 1);
    }

    function test_ethereum_sepolia_runs_only_on_11155111() public {
        _refusesAllBut(IRun(address(new DeployEthereumSepolia())), 11155111);
    }

    function test_base_mainnet_runs_only_on_8453() public {
        _refusesAllBut(IRun(address(new DeployBaseMainnet())), 8453);
    }

    function test_base_sepolia_runs_only_on_84532() public {
        _refusesAllBut(IRun(address(new DeployBaseSepolia())), 84532);
    }

    function test_robinhood_mainnet_runs_only_on_4663() public {
        _refusesAllBut(IRun(address(new DeployRobinhoodMainnet())), 4663);
    }

    function test_elysium_testnet_runs_only_on_99801() public {
        _refusesAllBut(IRun(address(new DeployElysiumTestnet())), 99801);
    }

    function test_tempo_mainnet_runs_only_on_4217() public {
        _refusesAllBut(IRun(address(new DeployTempoMainnet())), 4217);
    }
}
