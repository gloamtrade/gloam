// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/**
 * @notice Optional: seed Uniswap V2-style pools for faucet stocks on RH testnet.
 * @dev Only works if you hold testnet ETH + faucet tokens and approve the router.
 *
 *   export DEPLOYER_PK=0x...
 *   export RH_TESTNET_RPC=https://rpc.testnet.chain.robinhood.com
 *   forge script script/archive/SeedTestnetLiquidity.s.sol --rpc-url $RH_TESTNET_RPC --broadcast
 *
 * If getPair is zero, addLiquidityETH will create the pair.
 */
interface IRouter02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract SeedTestnetLiquidity is Script {
    address constant ROUTER = 0x97F1909638C0238fe4CCf1a57C1d8666b911Cb6f;

    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address constant PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    address constant AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address me = vm.addr(pk);
        IRouter02 router = IRouter02(ROUTER);

        address[5] memory tokens = [TSLA, AMZN, PLTR, NFLX, AMD];
        // small seed: 0.5 token + 0.001 ETH each (adjust to balances)
        uint256 tokenAmt = 0.5 ether;
        uint256 ethAmt = 0.001 ether;

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            uint256 bal = IERC20(t).balanceOf(me);
            if (bal < tokenAmt) {
                console2.log("skip low balance", t, bal);
                continue;
            }
            IERC20(t).approve(ROUTER, tokenAmt);
            try router.addLiquidityETH{value: ethAmt}(t, tokenAmt, 0, 0, me, block.timestamp + 600) returns (
                uint256 a, uint256 b, uint256 liq
            ) {
                console2.log("seeded", t);
                console2.log(" token", a);
                console2.log(" eth", b);
                console2.log(" liq", liq);
            } catch {
                console2.log("failed seed", t);
            }
        }
        vm.stopBroadcast();
    }
}
