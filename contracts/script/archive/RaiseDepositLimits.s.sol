// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/// @notice The part of the live vault (ShieldPoolPayments) this script touches.
interface IVaultLimits {
    function owner() external view returns (address);
    function setupMode() external view returns (bool);
    function depositLimitsOn() external view returns (bool);
    function depositLimit(address asset) external view returns (uint128 perDeposit, uint128 total);
    function changeEta(bytes32 id) external view returns (uint256);
    function setDepositLimit(address asset, uint128 perDeposit, uint128 total) external;
    function queueChange(bytes calldata call) external returns (bytes32 id, uint256 eta);
    function executeChange(bytes calldata call) external;
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
}

/**
 * Raises the beta deposit limits 100x on the four mainnet vaults (Robinhood
 * Chain, Base, Ethereum, Tempo), through each vault's 3-day public timelock.
 * The chain is picked by block.chainid, so the same script runs on all four:
 * point --rpc-url at the chain. Every asset with a nonzero limit today goes to
 * exactly 100 times its current perDeposit and total; nothing else changes.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 * Step 1, now: queue every raise on each chain (each one is a public
 * ChangeQueued event). Read the key once, run the four chains, drop the key:
 *   read -s "OWNER_PK?Vault owner key: "; echo
 *   forge script script/archive/RaiseDepositLimits.s.sol:RaiseDepositLimits --sig "queue()" \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key "$OWNER_PK" --broadcast
 *   forge script script/archive/RaiseDepositLimits.s.sol:RaiseDepositLimits --sig "queue()" \
 *     --rpc-url https://mainnet.base.org --private-key "$OWNER_PK" --broadcast
 *   forge script script/archive/RaiseDepositLimits.s.sol:RaiseDepositLimits --sig "queue()" \
 *     --rpc-url https://ethereum-rpc.publicnode.com --private-key "$OWNER_PK" --broadcast
 *   forge script script/archive/RaiseDepositLimits.s.sol:RaiseDepositLimits --sig "queue()" \
 *     --rpc-url https://rpc.tempo.xyz --private-key "$OWNER_PK" --broadcast
 *   unset OWNER_PK
 *
 * Step 2, 3 days later (and within the 14-day grace window): the same four
 * lines with --sig "execute()". It runs every change whose delay has passed and
 * checks each limit landed as queued.
 *
 * Any time, no key, nothing sent (live limit, queued eta and target per asset):
 *   forge script script/archive/RaiseDepositLimits.s.sol:RaiseDepositLimits --sig "status()" \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com
 *   (and the same with each of the other three RPCs)
 *
 * Forge simulates the whole run on a fork first and sends nothing if any call
 * would revert. --interactives 1 (forge asks for the key) or --ledger work in
 * place of --private-key. Tempo needs no extra flag: the
 * --gas-estimate-multiplier in the Tempo deploy scripts is for the 30M-gas cap
 * on a ~25M-gas pool deploy, and a queueChange is well under 100k. Gas there is
 * paid in a USD stablecoin, so the owner needs a little of one.
 *
 * Calls per chain: Robinhood Chain 30, Base 4, Ethereum 6, Tempo 4 (one
 * queueChange each, then one executeChange each).
 *
 * Limits are in each token's own units: perDeposit caps one deposit (and on
 * Robinhood Chain one swap's output), total caps what the vault holds of it.
 * Every new value is the live value read on chain on 2026-10-29 times 100;
 * queue() refuses to run unless the live limit still equals the old value, and
 * checks new == old * 100 for every asset, so queue and execute send the same
 * bytes. Dollar values are rough: Robinhood Chain swap assets at the
 * 2026-10-23 prices QueueSwapAssets was sized with, ETH at $2,325, EURC at
 * $1.11 and GLOAM at $1.70 (CoinGecko, 2026-10-29).
 *
 * Left alone (zero limit, so the vault refuses them as deposits, and they stay
 * that way): native ETH (address(0)) on Robinhood Chain, and address(0) on
 * Tempo, which has no native coin. A zero limit times 100 is still zero.
 *
 * Lowering a limit later stays instant (lowerDepositLimit), e.g. back to the
 * old values or to (0, 0) in an incident; raising again goes through this
 * timelock. Limits can never be switched off.
 */
contract RaiseDepositLimits is Script {
    /// @notice The vault and its owner are the same address on all four chains.
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;

    uint256 constant ROBINHOOD = 4663;
    uint256 constant BASE = 8453;
    uint256 constant ETHEREUM = 1;
    uint256 constant TEMPO = 4217;

    uint256 constant FACTOR = 100;

    struct Asset {
        string symbol;
        address token; // address(0) = the chain's native ETH
        uint8 decimals;
        uint128 oldPerDeposit; // live on 2026-10-29
        uint128 oldTotal;
        uint128 perDeposit; // oldPerDeposit * 100
        uint128 total; // oldTotal * 100
    }

    /// @notice What each asset's limit is raised to on the current chain.
    function assets() public view returns (Asset[] memory) {
        if (block.chainid == ROBINHOOD) return _robinhood();
        if (block.chainid == BASE) return _base();
        if (block.chainid == ETHEREUM) return _ethereum();
        if (block.chainid == TEMPO) return _tempo();
        revert("not a Gloam mainnet: Robinhood Chain, Base, Ethereum or Tempo only");
    }

    /// @notice Robinhood Chain (4663): USDG and GLOAM (Add lists them), then the
    ///         28 swap assets QueueSwapAssets opened, in its order.
    function _robinhood() internal pure returns (Asset[] memory a) {
        a = new Asset[](30);
        // Paxos Global Dollar, 6 decimals
        a[0] = Asset("USDG", 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        // $GLOAM
        a[1] = Asset("GLOAM", 0xDcD885F5c60b3aD49F6D58718696417314e8724d, 18, 25_000e18, 250_000e18, 2_500_000e18, 25_000_000e18); // 25,000 / 250,000 -> 2,500,000 / 25,000,000 (~$4.25M / ~$42.5M at $1.70)
        // Swap assets (QueueSwapAssets, sized 2026-10-23 at about $1,000 / $25,000)
        a[2] = Asset("WETH", 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73, 18, 0.42e18, 10e18, 42e18, 1_000e18); // 0.42 / 10 -> 42 / 1,000 (~$101k / ~$2.40M at $2,400)
        a[3] = Asset("USDe", 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34, 18, 500e18, 25_000e18, 50_000e18, 2_500_000e18); // 500 / 25,000 -> 50,000 / 2,500,000 (~$50k / ~$2.50M at $0.9998)
        a[4] = Asset("U", 0xcE24439F2D9C6a2289F741120FE202248B666666, 18, 500e18, 25_000e18, 50_000e18, 2_500_000e18); // 500 / 25,000 -> 50,000 / 2,500,000 (~$50k / ~$2.50M at $0.9991)
        a[5] = Asset("cbBTC", 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4, 8, 0.012e8, 0.31e8, 1.2e8, 31e8); // 0.012 / 0.31 -> 1.2 / 31 (~$98k / ~$2.53M at $81,700)
        a[6] = Asset("PONS", 0x39dBED3a2bd333467115dE45665cC57F813C4571, 18, 3_900e18, 98_000e18, 390_000e18, 9_800_000e18); // 3,900 / 98,000 -> 390,000 / 9,800,000 (~$100k / ~$2.50M at $0.2554)
        a[7] = Asset("CASHCAT", 0x020bfC650A365f8BB26819deAAbF3E21291018b4, 18, 9_600e18, 240_000e18, 960_000e18, 24_000_000e18); // 9,600 / 240,000 -> 960,000 / 24,000,000 (~$100k / ~$2.49M at $0.1039)
        a[8] = Asset("VIRTUAL", 0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31, 18, 1_500e18, 38_000e18, 150_000e18, 3_800_000e18); // 1,500 / 38,000 -> 150,000 / 3,800,000 (~$100k / ~$2.53M at $0.6666)
        a[9] = Asset("SPY", 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 18, 1.3e18, 33e18, 130e18, 3_300e18); // 1.3 / 33 -> 130 / 3,300 (~$99k / ~$2.52M at $764.2)
        a[10] = Asset("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 18, 4.7e18, 120e18, 470e18, 12_000e18); // 4.7 / 120 -> 470 / 12,000 (~$100k / ~$2.56M at $213.7)
        a[11] = Asset("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 18, 2.6e18, 66e18, 260e18, 6_600e18); // 2.6 / 66 -> 260 / 6,600 (~$98k / ~$2.49M at $377.5)
        a[12] = Asset("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 18, 4e18, 100e18, 400e18, 10_000e18); // 4 / 100 -> 400 / 10,000 (~$100k / ~$2.50M at $250.4)
        a[13] = Asset("SPCX", 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 18, 6.8e18, 170e18, 680e18, 17_000e18); // 6.8 / 170 -> 680 / 17,000 (~$101k / ~$2.52M at $148)
        a[14] = Asset("CRCL", 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5, 18, 12e18, 290e18, 1_200e18, 29_000e18); // 12 / 290 -> 1,200 / 29,000 (~$104k / ~$2.51M at $86.63)
        a[15] = Asset("META", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 18, 1.5e18, 39e18, 150e18, 3_900e18); // 1.5 / 39 -> 150 / 3,900 (~$97k / ~$2.52M at $646.6)
        a[16] = Asset("MSTR", 0xec262a75e413fAfD0dF80480274532C79D42da09, 18, 6.8e18, 170e18, 680e18, 17_000e18); // 6.8 / 170 -> 680 / 17,000 (~$100k / ~$2.49M at $146.6)
        a[17] = Asset("GOOGL", 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 18, 3.1e18, 77e18, 310e18, 7_700e18); // 3.1 / 77 -> 310 / 7,700 (~$101k / ~$2.50M at $324.4)
        a[18] = Asset("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 18, 2.9e18, 72e18, 290e18, 7_200e18); // 2.9 / 72 -> 290 / 7,200 (~$101k / ~$2.50M at $346.9)
        a[19] = Asset("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 18, 1.9e18, 48e18, 190e18, 4_800e18); // 1.9 / 48 -> 190 / 4,800 (~$98k / ~$2.48M at $517.2)
        a[20] = Asset("PLTR", 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, 18, 5.1e18, 130e18, 510e18, 13_000e18); // 5.1 / 130 -> 510 / 13,000 (~$100k / ~$2.54M at $195.3)
        a[21] = Asset("AMD", 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 18, 1.9e18, 49e18, 190e18, 4_900e18); // 1.9 / 49 -> 190 / 4,900 (~$98k / ~$2.52M at $515)
        a[22] = Asset("COIN", 0x6330D8C3178a418788dF01a47479c0ce7CCF450b, 18, 5.9e18, 150e18, 590e18, 15_000e18); // 5.9 / 150 -> 590 / 15,000 (~$101k / ~$2.56M at $170.5)
        a[23] = Asset("AMC", 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B, 18, 340e18, 8_500e18, 34_000e18, 850_000e18); // 340 / 8,500 -> 34,000 / 850,000 (~$100k / ~$2.50M at $2.947)
        a[24] = Asset("HIMS", 0xCceE82fE024c36fA15E1005edE3E9e4787e23D09, 18, 34e18, 860e18, 3_400e18, 86_000e18); // 34 / 860 -> 3,400 / 86,000 (~$99k / ~$2.50M at $29.08)
        a[25] = Asset("INTC", 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681, 18, 11e18, 290e18, 1_100e18, 29_000e18); // 11 / 290 -> 1,100 / 29,000 (~$96k / ~$2.53M at $87.08)
        a[26] = Asset("TSM", 0x58FfE4a942d3885bAa22D7520691F611EF09e7AA, 18, 2.4e18, 60e18, 240e18, 6_000e18); // 2.4 / 60 -> 240 / 6,000 (~$100k / ~$2.50M at $417.4)
        a[27] = Asset("GLD", 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 18, 2.7e18, 68e18, 270e18, 6_800e18); // 2.7 / 68 -> 270 / 6,800 (~$100k / ~$2.51M at $369.2)
        a[28] = Asset("QQQ", 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 18, 1.4e18, 35e18, 140e18, 3_500e18); // 1.4 / 35 -> 140 / 3,500 (~$99k / ~$2.49M at $710.6)
        a[29] = Asset("MU", 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD, 18, 1.1e18, 28e18, 110e18, 2_800e18); // 1.1 / 28 -> 110 / 2,800 (~$97k / ~$2.46M at $877.5)
    }

    /// @notice Base (8453): Circle's USDC and EURC, bridged USDT, native ETH.
    function _base() internal pure returns (Asset[] memory a) {
        a = new Asset[](4);
        a[0] = Asset("USDC", 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[1] = Asset("EURC", 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 EUR (~$56k / ~$2.78M at $1.11)
        a[2] = Asset("USDT", 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[3] = Asset("ETH", address(0), 18, 0.2e18, 10e18, 20e18, 1_000e18); // 0.2 / 10 -> 20 / 1,000 (~$46k / ~$2.33M at $2,325)
    }

    /// @notice Ethereum (1): USDC, USDT, USDG, PYUSD, EURC, native ETH.
    function _ethereum() internal pure returns (Asset[] memory a) {
        a = new Asset[](6);
        a[0] = Asset("USDC", 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[1] = Asset("USDT", 0xdAC17F958D2ee523a2206206994597C13D831ec7, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[2] = Asset("USDG", 0xe343167631d89B6Ffc58B88d6b7fB0228795491D, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[3] = Asset("PYUSD", 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[4] = Asset("EURC", 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 EUR (~$56k / ~$2.78M at $1.11)
        a[5] = Asset("ETH", address(0), 18, 0.2e18, 10e18, 20e18, 1_000e18); // 0.2 / 10 -> 20 / 1,000 (~$46k / ~$2.33M at $2,325)
    }

    /// @notice Tempo (4217): the four TIP-20 stablecoins, 6 decimals each.
    function _tempo() internal pure returns (Asset[] memory a) {
        a = new Asset[](4);
        a[0] = Asset("USDC.e", 0x20C000000000000000000000b9537d11c60E8b50, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[1] = Asset("pathUSD", 0x20C0000000000000000000000000000000000000, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[2] = Asset("USDT0", 0x20C00000000000000000000014f22CA97301EB73, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
        a[3] = Asset("OUSD", 0x20c0000000000000000000006a37DA5C996874BE, 6, 500e6, 25_000e6, 50_000e6, 2_500_000e6); // 500 / 25,000 -> 50,000 / 2,500,000 ($50k / $2.5M)
    }

    /// @notice The exact setter call each change is queued under (its id is keccak256 of it).
    function changeCall(Asset memory x) public pure returns (bytes memory) {
        return abi.encodeCall(IVaultLimits.setDepositLimit, (x.token, x.perDeposit, x.total));
    }

    function queue() external {
        IVaultLimits v = _checkVault();
        Asset[] memory a = assets();
        _checkPlan(a);
        vm.startBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            if (per == a[i].perDeposit && total == a[i].total) {
                console2.log("already raised, skipped:", a[i].symbol);
                continue;
            }
            // 100x of what is live, never of a value that has since changed
            // (lowered in an incident, say): review the script if this fires.
            require(per == a[i].oldPerDeposit && total == a[i].oldTotal, "live limit is not the old value: review");
            bytes memory call_ = changeCall(a[i]);
            uint256 eta = v.changeEta(keccak256(call_));
            if (eta != 0 && block.timestamp <= eta + 14 days) {
                console2.log("already queued, skipped:", a[i].symbol, eta);
                continue;
            }
            (, uint256 newEta) = v.queueChange(call_);
            console2.log("queued", a[i].symbol, "executable from (unix)", newEta);
        }
        vm.stopBroadcast();
    }

    function execute() external {
        IVaultLimits v = _checkVault();
        Asset[] memory a = assets();
        _checkPlan(a);
        bool[] memory ran = new bool[](a.length);
        vm.startBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            bytes memory call_ = changeCall(a[i]);
            uint256 eta = v.changeEta(keccak256(call_));
            if (eta == 0) {
                console2.log("not queued (or already run), skipped:", a[i].symbol);
                continue;
            }
            if (block.timestamp < eta) {
                console2.log("not ready yet, skipped:", a[i].symbol, eta);
                continue;
            }
            require(block.timestamp <= eta + 14 days, "expired: queue it again");
            // A limit lowered after the queue (lowerDepositLimit) is left lowered:
            // this run does not undo it. cancelChange drops the queued raise.
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            if (per != a[i].oldPerDeposit || total != a[i].oldTotal) {
                console2.log("live limit changed since the queue, skipped:", a[i].symbol);
                continue;
            }
            v.executeChange(call_);
            ran[i] = true;
            console2.log("executed", a[i].symbol);
        }
        vm.stopBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            if (!ran[i]) continue;
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            require(per == a[i].perDeposit && total == a[i].total, "limit did not land as queued");
        }
    }

    function status() external view {
        IVaultLimits v = IVaultLimits(VAULT);
        Asset[] memory a = assets();
        console2.log("chain", block.chainid, "now (unix)", block.timestamp);
        for (uint256 i = 0; i < a.length; i++) {
            bytes memory call_ = changeCall(a[i]);
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            console2.log(a[i].symbol, a[i].token);
            console2.log("  live limit per / total", uint256(per), uint256(total));
            console2.log("  target per / total    ", uint256(a[i].perDeposit), uint256(a[i].total));
            console2.log("  queued eta (0 = none) ", v.changeEta(keccak256(call_)));
            console2.log("  queueChange calldata:");
            console2.logBytes(abi.encodeCall(IVaultLimits.queueChange, (call_)));
        }
        // The zero-limit assets this script leaves alone, read live.
        if (block.chainid == ROBINHOOD || block.chainid == TEMPO) {
            (uint128 per, uint128 total) = v.depositLimit(address(0));
            console2.log("left alone: address(0), live per / total", uint256(per), uint256(total));
        }
    }

    function _checkVault() internal view returns (IVaultLimits v) {
        v = IVaultLimits(VAULT);
        require(v.owner() == OWNER, "vault owner changed: review this script");
        require(!v.setupMode() && v.depositLimitsOn(), "vault not in timelock mode");
    }

    /// @dev Every new value is exactly 100x the old one, and every token still
    ///      has the decimals the limits were read with.
    function _checkPlan(Asset[] memory a) internal view {
        for (uint256 i = 0; i < a.length; i++) {
            require(a[i].oldPerDeposit != 0 && a[i].oldTotal != 0, "zero limit in the plan");
            require(
                a[i].perDeposit == a[i].oldPerDeposit * FACTOR && a[i].total == a[i].oldTotal * FACTOR,
                "new limit is not 100x the old one"
            );
            if (a[i].token != address(0)) {
                require(IERC20Meta(a[i].token).decimals() == a[i].decimals, "decimals changed");
            }
        }
    }
}
