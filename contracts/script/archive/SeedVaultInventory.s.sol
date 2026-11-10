// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/**
 * @notice Seed ShieldPoolPoseidon inventory so cash-out after sealed trade can succeed.
 * @dev Sealed swap creates out-notes without moving `deposited`. Unshield needs
 *      `deposited[asset] >= amount`. This script shields faucet tokens (and optional ETH)
 *      with throwaway commitments — dead leaves, real inventory.
 *
 *   export DEPLOYER_PK=0x...
 *   export RH_TESTNET_RPC=https://rpc.testnet.chain.robinhood.com
 *   # optional: SHIELD_POOL=0xaEbB…  TOKEN_AMT=1000000000000000000  ETH_AMT=0
 *
 *   forge script script/archive/SeedVaultInventory.s.sol \
 *     --rpc-url $RH_TESTNET_RPC --broadcast --gas-estimate-multiplier 200 -vvvv
 */
interface IShieldPool {
    function shield(address asset, uint256 amount, bytes32 commitment) external payable;
    function deposited(address asset) external view returns (uint256);
    function shieldVerifier() external view returns (address);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract SeedVaultInventory is Script {
    // Hardened Poseidon pool (C1/C2/C3). NEVER point this at the drainable
    // pre-C1 pool 0x4F38…12D8F (audit H-P1) — it has no shieldVerifier and is
    // unhardenable in place.
    address constant DEFAULT_POOL = 0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740;

    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address constant PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    address constant AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address me = vm.addr(pk);
        address poolAddr = vm.envOr("SHIELD_POOL", DEFAULT_POOL);
        uint256 tokenAmt = vm.envOr("TOKEN_AMT", uint256(1 ether));
        uint256 ethAmt = vm.envOr("ETH_AMT", uint256(0));

        IShieldPool pool = IShieldPool(poolAddr);

        // Audit H-P1 / C1: never seed a pool whose shield path is unbound. With
        // shieldVerifier == 0, anyone can shield() an over-valued commitment for
        // ~1 wei and unshield it against this seeded inventory. Harden the pool
        // (setShieldVerifier) before seeding.
        require(pool.shieldVerifier() != address(0), "unsafe: shieldVerifier unset (C1) - harden pool before seeding");

        address[5] memory tokens = [TSLA, AMZN, PLTR, NFLX, AMD];

        console2.log("pool", poolAddr);
        console2.log("seeder", me);
        console2.log("tokenAmt", tokenAmt);

        vm.startBroadcast(pk);

        if (ethAmt > 0) {
            bytes32 cEth = _throwawayCommitment(address(0), ethAmt, 0);
            pool.shield{value: ethAmt}(address(0), ethAmt, cEth);
            console2.log("seeded ETH", ethAmt);
        }

        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            uint256 bal = IERC20(t).balanceOf(me);
            if (bal < tokenAmt) {
                console2.log("skip low balance", t, bal);
                continue;
            }
            IERC20(t).approve(poolAddr, tokenAmt);
            bytes32 c = _throwawayCommitment(t, tokenAmt, i + 1);
            pool.shield(t, tokenAmt, c);
            console2.log("seeded token", t);
            console2.log("  deposited now", pool.deposited(t));
        }

        vm.stopBroadcast();
        console2.log("done");
    }

    function _throwawayCommitment(address asset, uint256 amount, uint256 salt) internal view returns (bytes32) {
        // Not a real note secret — inventory only. Leaf is unspendable by design.
        return keccak256(abi.encodePacked("gloam-inventory-seed", asset, amount, salt, block.timestamp, msg.sender));
    }
}
