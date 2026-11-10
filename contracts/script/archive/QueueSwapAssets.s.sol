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
 * Opens the Robinhood Chain mainnet vault to the swap assets, through the
 * vault's 3-day public timelock. Until a limit lands, an asset has a zero
 * limit and the vault refuses it, as a deposit and as a swap's output (both
 * go through shieldBound and the same check). Transfers and cash-outs never
 * look at the limit.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 * Step 1, now: queue every limit (each one is a public ChangeQueued event).
 *   read -s "OWNER_PK?Vault owner key: "; echo
 *   forge script script/archive/QueueSwapAssets.s.sol:QueueSwapAssets --sig "queue()" \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key "$OWNER_PK" --broadcast
 *   unset OWNER_PK
 *
 * Step 2, 3 days later (and within the 14-day grace window): run the same
 * line with --sig "execute()". It runs every change whose delay has passed and
 * checks each limit landed as queued.
 *
 * Any time, no key, nothing sent:
 *   forge script script/archive/QueueSwapAssets.s.sol:QueueSwapAssets --sig "status()" \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com
 *
 * Forge simulates the whole run on a fork first and sends nothing if any call
 * would revert. --interactives 1 (forge asks for the key) or --ledger work in
 * place of --private-key.
 *
 * Limits are in each token's own units: perDeposit caps one deposit or one
 * swap's output, total caps what the vault holds of it. They were sized to
 * USDG's (500 / 25,000) at the prices of 2026-10-23; see the PR for the
 * arithmetic. Lowering a limit later is instant (lowerDepositLimit); raising
 * one goes through this timelock again.
 */
contract QueueSwapAssets is Script {
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;

    struct Asset {
        string symbol;
        address token;
        uint8 decimals;
        uint128 perDeposit;
        uint128 total;
    }

    /// @notice What each asset's limit is set to. perDeposit is about $1,000 (twice
    ///         USDG's 500, so a full 500 USDG note still swaps in after a fall of up
    ///         to about half), total about $25,000 (USDG's). Dollar assets mirror
    ///         USDG exactly. Priced on 2026-10-23; the comment on each line has the
    ///         dollar values at that price.
    function assets() public pure returns (Asset[] memory a) {
        a = new Asset[](28);
        // aeWETH. v4 pools hold native ETH, so the router unwraps; v3 WETH/USDG 0.01% is the deepest
        a[0] = Asset("WETH", 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73, 18, 0.42e18, 10e18); // ~$1,008 / ~$23,995 at $2,400
        // Ethena USDe (LayerZero OFT): dollar asset, mirrors USDG
        a[1] = Asset("USDe", 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34, 18, 500e18, 25_000e18); // ~$500 / ~$24,995 at $0.9998
        // United Stables: dollar asset, mirrors USDG. Issuer can pause and freeze
        a[2] = Asset("U", 0xcE24439F2D9C6a2289F741120FE202248B666666, 18, 500e18, 25_000e18); // ~$500 / ~$24,977 at $0.9991
        // Coinbase BTC, 8 decimals. Issuer can pause and freeze
        a[3] = Asset("cbBTC", 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4, 8, 0.012e8, 0.31e8); // ~$980 / ~$25,327 at $81,700
        // launch limits ended at block 25,526,532; plain ERC-20 since
        a[4] = Asset("PONS", 0x39dBED3a2bd333467115dE45665cC57F813C4571, 18, 3_900e18, 98_000e18); // ~$996 / ~$25,029 at $0.2554
        // launch limits ended at block 25,347,067; plain ERC-20 since
        a[5] = Asset("CASHCAT", 0x020bfC650A365f8BB26819deAAbF3E21291018b4, 18, 9_600e18, 240_000e18); // ~$998 / ~$24,947 at $0.1039
        // CCIP cross-chain token, no pause or blocklist
        a[6] = Asset("VIRTUAL", 0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31, 18, 1_500e18, 38_000e18); // ~$1,000 / ~$25,330 at $0.6666
        // Robinhood stock tokens (one Stock implementation behind one beacon). Plain
        // balances; uiMultiplier only scales what wallets show. Robinhood can pause,
        // block an address and burn from any address, the same class of issuer power
        // USDG has.
        a[7] = Asset("SPY", 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 18, 1.3e18, 33e18); // ~$993 / ~$25,218 at $764.2
        a[8] = Asset("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 18, 4.7e18, 120e18); // ~$1,004 / ~$25,647 at $213.7
        a[9] = Asset("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 18, 2.6e18, 66e18); // ~$981 / ~$24,915 at $377.5
        a[10] = Asset("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 18, 4e18, 100e18); // ~$1,002 / ~$25,038 at $250.4
        a[11] = Asset("SPCX", 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 18, 6.8e18, 170e18); // ~$1,006 / ~$25,152 at $148
        a[12] = Asset("CRCL", 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5, 18, 12e18, 290e18); // ~$1,040 / ~$25,124 at $86.63
        a[13] = Asset("META", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 18, 1.5e18, 39e18); // ~$970 / ~$25,218 at $646.6
        a[14] = Asset("MSTR", 0xec262a75e413fAfD0dF80480274532C79D42da09, 18, 6.8e18, 170e18); // ~$997 / ~$24,930 at $146.6
        a[15] = Asset("GOOGL", 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 18, 3.1e18, 77e18); // ~$1,006 / ~$24,980 at $324.4
        a[16] = Asset("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 18, 2.9e18, 72e18); // ~$1,006 / ~$24,978 at $346.9
        a[17] = Asset("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 18, 1.9e18, 48e18); // ~$983 / ~$24,826 at $517.2
        a[18] = Asset("PLTR", 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, 18, 5.1e18, 130e18); // ~$996 / ~$25,386 at $195.3
        a[19] = Asset("AMD", 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 18, 1.9e18, 49e18); // ~$978 / ~$25,233 at $515
        a[20] = Asset("COIN", 0x6330D8C3178a418788dF01a47479c0ce7CCF450b, 18, 5.9e18, 150e18); // ~$1,006 / ~$25,568 at $170.5
        a[21] = Asset("AMC", 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B, 18, 340e18, 8_500e18); // ~$1,002 / ~$25,051 at $2.947
        a[22] = Asset("HIMS", 0xCceE82fE024c36fA15E1005edE3E9e4787e23D09, 18, 34e18, 860e18); // ~$989 / ~$25,010 at $29.08
        a[23] = Asset("INTC", 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681, 18, 11e18, 290e18); // ~$958 / ~$25,253 at $87.08
        a[24] = Asset("TSM", 0x58FfE4a942d3885bAa22D7520691F611EF09e7AA, 18, 2.4e18, 60e18); // ~$1,002 / ~$25,044 at $417.4
        a[25] = Asset("GLD", 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 18, 2.7e18, 68e18); // ~$997 / ~$25,106 at $369.2
        a[26] = Asset("QQQ", 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 18, 1.4e18, 35e18); // ~$995 / ~$24,870 at $710.6
        a[27] = Asset("MU", 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD, 18, 1.1e18, 28e18); // ~$965 / ~$24,571 at $877.5
    }

    /// @notice The exact setter call each change is queued under (its id is keccak256 of it).
    function changeCall(Asset memory x) public pure returns (bytes memory) {
        return abi.encodeCall(IVaultLimits.setDepositLimit, (x.token, x.perDeposit, x.total));
    }

    function queue() external {
        IVaultLimits v = _checkVault();
        Asset[] memory a = assets();
        _checkTokens(a);
        vm.startBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            bytes memory call_ = changeCall(a[i]);
            bytes32 id = keccak256(call_);
            uint256 eta = v.changeEta(id);
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
        console2.log("now (unix)", block.timestamp);
        for (uint256 i = 0; i < a.length; i++) {
            bytes memory call_ = changeCall(a[i]);
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            console2.log(a[i].symbol, a[i].token);
            console2.log("  live limit per / total", uint256(per), uint256(total));
            console2.log("  queued eta (0 = none)", v.changeEta(keccak256(call_)));
            console2.log("  queueChange calldata:");
            console2.logBytes(abi.encodeCall(IVaultLimits.queueChange, (call_)));
        }
    }

    function _checkVault() internal view returns (IVaultLimits v) {
        require(block.chainid == 4663, "Robinhood Chain mainnet only");
        v = IVaultLimits(VAULT);
        require(v.owner() == OWNER, "vault owner changed: review this script");
        require(!v.setupMode() && v.depositLimitsOn(), "vault not in timelock mode");
    }

    /// @dev Every token still has the decimals the limits were sized with.
    function _checkTokens(Asset[] memory a) internal view {
        for (uint256 i = 0; i < a.length; i++) {
            require(IERC20Meta(a[i].token).decimals() == a[i].decimals, "decimals changed");
        }
    }
}
