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
    function cancelChange(bytes calldata call) external;
    function lowerDepositLimit(address asset, uint128 perDeposit, uint128 total) external;
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * Takes the deposit limits off on the four mainnet vaults (Robinhood Chain,
 * Base, Ethereum, Tempo): every asset the vault takes today, plus BDX on Base
 * and Ethereum, goes to perDeposit = total = type(uint128).max, through each
 * vault's 3-day public timelock. depositLimitsOn is one-way, so "no limit" is
 * the largest limit the vault can hold. The app, SDK and MCP read any limit at
 * or above 2^127 as no limit. The chain is picked by block.chainid, so the same
 * script runs on all four: point --rpc-url at the chain.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 * --interactives 1 makes forge ask for the owner key once per run; nothing is
 * stored. --ledger works in place of it. Forge simulates the whole run on a
 * fork first and sends nothing if any call would revert.
 *
 *   cd contracts
 *   OWNER=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8
 *   S=script/NoDepositLimits.s.sol:NoDepositLimits
 *
 * Step 1, now: queue the max limit for every asset (public ChangeQueued events).
 *   forge script $S --sig "queue()" --rpc-url https://rpc.mainnet.chain.robinhood.com \
 *     --sender $OWNER --interactives 1 --broadcast
 *   forge script $S --sig "queue()" --rpc-url https://mainnet.base.org \
 *     --sender $OWNER --interactives 1 --broadcast
 *   forge script $S --sig "queue()" --rpc-url https://ethereum-rpc.publicnode.com \
 *     --sender $OWNER --interactives 1 --broadcast
 *   forge script $S --sig "queue()" --rpc-url https://rpc.tempo.xyz \
 *     --sender $OWNER --interactives 1 --broadcast
 *
 * Step 2, optional, any time: cancel the older, lower raises still queued
 * (RaiseDepositLimits' 100x on all four chains, executable from about Sun 1 Nov
 * 14:47 UTC, and QueueBDX's 100,000 / 2,000,000 if it was sent). Executed after
 * the max change, any of them would LOWER that limit again. Only the owner can
 * execute a change, and RaiseDepositLimits.execute() and QueueBDX.execute()
 * both skip or refuse when the live limit is not the value they expect, so this
 * is tidying, not a race. It skips entries that are not queued.
 *   forge script $S --sig "cancelStale()" --rpc-url <each of the four RPCs> \
 *     --sender $OWNER --interactives 1 --broadcast
 *
 * Step 3, 3 days after step 1 (and within the 14-day grace window): the same
 * four lines with --sig "execute()". It runs every max change whose delay has
 * passed and checks each limit is now max. BDX is the exception: on Base and
 * Ethereum its max change runs and the very next transaction lowers it to
 * 100,000 per deposit and 2,000,000 in total (lowerDepositLimit, no timelock),
 * and the run checks that cap landed. Forge sends the two back to back with
 * consecutive nonces, so they land in the same block or the next one.
 *
 * Any time, no key, nothing sent (live limit, max-queued eta, stale queued
 * change per asset):
 *   forge script $S --sig "status()" --rpc-url https://rpc.mainnet.chain.robinhood.com
 *   (and the same with each of the other three RPCs)
 *
 * Calls per chain (queue, cancelStale, execute each): Robinhood Chain 31,
 * Base 5, Ethereum 7, Tempo 4 (cancelStale: one fewer on Robinhood Chain, for
 * GRIFT, and on Base and Ethereum, for BDX: those have no older change queued).
 * Robinhood Chain's RPC can report the nonce ahead of forge; pass --slow there
 * so each queue waits for the one before it. Gas measured on forks: queueChange
 * ~54k, cancelChange ~27k, executeChange ~35k to 52k (Tempo's queueChange is
 * ~286k: a new storage slot costs more there). Ethereum is the tight one: the
 * owner holds about 0.0004 ETH, and the 7 queues are ~377k gas, so check
 * `cast gas-price` first and fund the owner if needed (forge refuses to start
 * if the balance cannot cover its estimate). cancelStale can be skipped there.
 * Tempo pays gas in a USD stablecoin (the owner's pathUSD); no extra flag is
 * needed.
 *
 * Left alone (zero limit, so the vault refuses them as deposits, and they stay
 * that way): native ETH (address(0)) on Robinhood Chain, and address(0) on
 * Tempo, which has no native coin.
 *
 * Since then (3 Nov 2026) QueueRobinhoodAssets listed native ETH, AI and ORBIO on
 * Robinhood Chain at 11 / 110 ETH, 400,000 / 4,000,000 AI and 1,000,000 /
 * 10,000,000 ORBIO. They are not in this script's queue (queued 30 Oct), so after
 * execute() those three keep their limits while the other 31 have none.
 *
 * Lowering a limit later stays instant (lowerDepositLimit), e.g. to (0, 0) in
 * an incident; raising again goes through this timelock.
 *
 * Overflow: the vault checks `amount > perDeposit || deposited + amount >
 * total` with amount and deposited as uint256, so with total = 2^128 - 1 the
 * sum cannot wrap (and checked math would revert, not pass, if it did).
 */
contract NoDepositLimits is Script {
    /// @notice The vault and its owner are the same address on all four chains.
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;

    uint256 constant ROBINHOOD = 4663;
    uint256 constant BASE = 8453;
    uint256 constant ETHEREUM = 1;
    uint256 constant TEMPO = 4217;

    uint256 constant GRACE = 14 days;

    /// @notice "No limit": the largest limit the vault can hold.
    uint128 constant MAX = type(uint128).max;

    /// @notice Beldex's BDX (LayerZero OFT), the same address on Ethereum and Base.
    address constant BDX = 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181;

    /// @notice BDX stays capped: 100,000 per deposit, 2,000,000 in total (9 decimals),
    ///         the values QueueBDX and the app describe. Its queued change can only set
    ///         max, so execute() runs it and lowers BDX to this cap in the next
    ///         transaction of the same run (lowerDepositLimit is instant, no timelock).
    uint128 constant BDX_PER_DEPOSIT = 100_000e9;
    uint128 constant BDX_TOTAL = 2_000_000e9;

    struct Asset {
        string symbol;
        address token; // address(0) = the chain's native ETH
        uint8 decimals;
        // The older, lower raise that may still be queued for this asset:
        // RaiseDepositLimits' 100x, or QueueBDX's 100,000 / 2,000,000 for BDX.
        uint128 stalePerDeposit;
        uint128 staleTotal;
    }

    /// @notice Every asset whose limit goes to max on the current chain.
    function assets() public view returns (Asset[] memory) {
        if (block.chainid == ROBINHOOD) return _robinhood();
        if (block.chainid == BASE) return _base();
        if (block.chainid == ETHEREUM) return _ethereum();
        if (block.chainid == TEMPO) return _tempo();
        revert("not a Gloam mainnet: Robinhood Chain, Base, Ethereum or Tempo only");
    }

    /// @notice Robinhood Chain (4663): USDG, GLOAM, then the 28 swap assets
    ///         (RaiseDepositLimits' order; stale = its 100x values), then GRIFT.
    function _robinhood() internal pure returns (Asset[] memory a) {
        a = new Asset[](31);
        a[0] = Asset("USDG", 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, 6, 50_000e6, 2_500_000e6);
        a[1] = Asset("GLOAM", 0xDcD885F5c60b3aD49F6D58718696417314e8724d, 18, 2_500_000e18, 25_000_000e18);
        a[2] = Asset("WETH", 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73, 18, 42e18, 1_000e18);
        a[3] = Asset("USDe", 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34, 18, 50_000e18, 2_500_000e18);
        a[4] = Asset("U", 0xcE24439F2D9C6a2289F741120FE202248B666666, 18, 50_000e18, 2_500_000e18);
        a[5] = Asset("cbBTC", 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4, 8, 1.2e8, 31e8);
        a[6] = Asset("PONS", 0x39dBED3a2bd333467115dE45665cC57F813C4571, 18, 390_000e18, 9_800_000e18);
        a[7] = Asset("CASHCAT", 0x020bfC650A365f8BB26819deAAbF3E21291018b4, 18, 960_000e18, 24_000_000e18);
        a[8] = Asset("VIRTUAL", 0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31, 18, 150_000e18, 3_800_000e18);
        a[9] = Asset("SPY", 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 18, 130e18, 3_300e18);
        a[10] = Asset("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 18, 470e18, 12_000e18);
        a[11] = Asset("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 18, 260e18, 6_600e18);
        a[12] = Asset("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 18, 400e18, 10_000e18);
        a[13] = Asset("SPCX", 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 18, 680e18, 17_000e18);
        a[14] = Asset("CRCL", 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5, 18, 1_200e18, 29_000e18);
        a[15] = Asset("META", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 18, 150e18, 3_900e18);
        a[16] = Asset("MSTR", 0xec262a75e413fAfD0dF80480274532C79D42da09, 18, 680e18, 17_000e18);
        a[17] = Asset("GOOGL", 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 18, 310e18, 7_700e18);
        a[18] = Asset("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 18, 290e18, 7_200e18);
        a[19] = Asset("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 18, 190e18, 4_800e18);
        a[20] = Asset("PLTR", 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, 18, 510e18, 13_000e18);
        a[21] = Asset("AMD", 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 18, 190e18, 4_900e18);
        a[22] = Asset("COIN", 0x6330D8C3178a418788dF01a47479c0ce7CCF450b, 18, 590e18, 15_000e18);
        a[23] = Asset("AMC", 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B, 18, 34_000e18, 850_000e18);
        a[24] = Asset("HIMS", 0xCceE82fE024c36fA15E1005edE3E9e4787e23D09, 18, 3_400e18, 86_000e18);
        a[25] = Asset("INTC", 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681, 18, 1_100e18, 29_000e18);
        a[26] = Asset("TSM", 0x58FfE4a942d3885bAa22D7520691F611EF09e7AA, 18, 240e18, 6_000e18);
        a[27] = Asset("GLD", 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 18, 270e18, 6_800e18);
        a[28] = Asset("QQQ", 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 18, 140e18, 3_500e18);
        a[29] = Asset("MU", 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD, 18, 110e18, 2_800e18);
        // San Verano's $GRIFT: a plain OpenZeppelin ERC-20 from the Pons v2 launcher (verified on
        // Sourcify), no transfer tax or rebase. New to the vault, so no older change to cancel.
        a[30] = Asset("GRIFT", 0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5, 18, 0, 0);
    }

    /// @notice Base (8453): USDC, EURC, USDT, native ETH, and BDX.
    function _base() internal pure returns (Asset[] memory a) {
        a = new Asset[](5);
        a[0] = Asset("USDC", 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 6, 50_000e6, 2_500_000e6);
        a[1] = Asset("EURC", 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42, 6, 50_000e6, 2_500_000e6);
        a[2] = Asset("USDT", 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2, 6, 50_000e6, 2_500_000e6);
        a[3] = Asset("ETH", address(0), 18, 20e18, 1_000e18);
        a[4] = Asset("BDX", BDX, 9, 100_000e9, 2_000_000e9);
    }

    /// @notice Ethereum (1): USDC, USDT, USDG, PYUSD, EURC, native ETH, and BDX.
    function _ethereum() internal pure returns (Asset[] memory a) {
        a = new Asset[](7);
        a[0] = Asset("USDC", 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 6, 50_000e6, 2_500_000e6);
        a[1] = Asset("USDT", 0xdAC17F958D2ee523a2206206994597C13D831ec7, 6, 50_000e6, 2_500_000e6);
        a[2] = Asset("USDG", 0xe343167631d89B6Ffc58B88d6b7fB0228795491D, 6, 50_000e6, 2_500_000e6);
        a[3] = Asset("PYUSD", 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8, 6, 50_000e6, 2_500_000e6);
        a[4] = Asset("EURC", 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c, 6, 50_000e6, 2_500_000e6);
        a[5] = Asset("ETH", address(0), 18, 20e18, 1_000e18);
        a[6] = Asset("BDX", BDX, 9, 100_000e9, 2_000_000e9);
    }

    /// @notice Tempo (4217): the four TIP-20 stablecoins, 6 decimals each.
    function _tempo() internal pure returns (Asset[] memory a) {
        a = new Asset[](4);
        a[0] = Asset("USDC.e", 0x20C000000000000000000000b9537d11c60E8b50, 6, 50_000e6, 2_500_000e6);
        a[1] = Asset("pathUSD", 0x20C0000000000000000000000000000000000000, 6, 50_000e6, 2_500_000e6);
        a[2] = Asset("USDT0", 0x20C00000000000000000000014f22CA97301EB73, 6, 50_000e6, 2_500_000e6);
        a[3] = Asset("OUSD", 0x20c0000000000000000000006a37DA5C996874BE, 6, 50_000e6, 2_500_000e6);
    }

    /// @notice The setter call the max change is queued under (its id is keccak256 of it).
    function maxCall(address token) public pure returns (bytes memory) {
        return abi.encodeCall(IVaultLimits.setDepositLimit, (token, MAX, MAX));
    }

    /// @notice The older, lower raise that may still sit in the queue for `x`.
    function staleCall(Asset memory x) public pure returns (bytes memory) {
        return abi.encodeCall(IVaultLimits.setDepositLimit, (x.token, x.stalePerDeposit, x.staleTotal));
    }

    function queue() external {
        IVaultLimits v = _checkVault();
        Asset[] memory a = assets();
        _checkTokens(a);
        vm.startBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            if (_isMax(v, a[i].token)) {
                console2.log("already no limit, skipped:", a[i].symbol);
                continue;
            }
            bytes memory call_ = maxCall(a[i].token);
            uint256 eta = v.changeEta(keccak256(call_));
            if (eta != 0 && block.timestamp <= eta + GRACE) {
                console2.log("already queued, skipped:", a[i].symbol, eta);
                continue;
            }
            (, uint256 newEta) = v.queueChange(call_);
            console2.log("queued", a[i].symbol, "executable from (unix)", newEta);
        }
        vm.stopBroadcast();
    }

    /// @notice Cancel the older, lower raises still queued (100x, BDX 100k / 2M).
    function cancelStale() external {
        IVaultLimits v = _checkVault();
        Asset[] memory a = assets();
        vm.startBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            bytes memory call_ = staleCall(a[i]);
            if (v.changeEta(keccak256(call_)) == 0) {
                console2.log("no stale change queued, skipped:", a[i].symbol);
                continue;
            }
            v.cancelChange(call_);
            console2.log("cancelled stale change", a[i].symbol);
        }
        vm.stopBroadcast();
    }

    function execute() external {
        IVaultLimits v = _checkVault();
        Asset[] memory a = assets();
        _checkTokens(a);
        bool[] memory ran = new bool[](a.length);
        vm.startBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            if (_isMax(v, a[i].token)) {
                console2.log("already no limit, skipped:", a[i].symbol);
                continue;
            }
            bytes memory call_ = maxCall(a[i].token);
            uint256 eta = v.changeEta(keccak256(call_));
            if (eta == 0) {
                console2.log("not queued, skipped (run queue()):", a[i].symbol);
                continue;
            }
            if (block.timestamp < eta) {
                console2.log("not ready yet, skipped:", a[i].symbol, eta);
                continue;
            }
            if (block.timestamp > eta + GRACE) {
                console2.log("expired, skipped (run queue() again):", a[i].symbol, eta);
                continue;
            }
            v.executeChange(call_);
            ran[i] = true;
            console2.log("executed", a[i].symbol);
            if (a[i].token == BDX) {
                // Next transaction, same run: BDX is never left without a limit.
                v.lowerDepositLimit(BDX, BDX_PER_DEPOSIT, BDX_TOTAL);
                console2.log("capped BDX at 100,000 per deposit, 2,000,000 total");
            }
        }
        vm.stopBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            if (ran[i] && a[i].token == BDX) {
                (uint128 per, uint128 total) = v.depositLimit(BDX);
                require(per == BDX_PER_DEPOSIT && total == BDX_TOTAL, "BDX cap did not land");
            } else if (ran[i]) {
                require(_isMax(v, a[i].token), "limit did not land as max");
            }
            if (v.changeEta(keccak256(staleCall(a[i]))) != 0) {
                console2.log("stale lower change still queued (run cancelStale()):", a[i].symbol);
            }
        }
    }

    function status() external view {
        IVaultLimits v = IVaultLimits(VAULT);
        Asset[] memory a = assets();
        console2.log("chain", block.chainid, "now (unix)", block.timestamp);
        console2.log("vault owner ok", v.owner() == OWNER, "timelock mode", !v.setupMode() && v.depositLimitsOn());
        for (uint256 i = 0; i < a.length; i++) {
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            uint256 maxEta = v.changeEta(keccak256(maxCall(a[i].token)));
            uint256 staleEta = v.changeEta(keccak256(staleCall(a[i])));
            console2.log(a[i].symbol, a[i].token, per == MAX && total == MAX ? "NO LIMIT" : "limited");
            console2.log("  live limit per / total  ", uint256(per), uint256(total));
            console2.log("  max queued eta (0 = no) ", maxEta);
            if (staleEta != 0) {
                console2.log(
                    "  STALE lower change queued: per / total", uint256(a[i].stalePerDeposit), uint256(a[i].staleTotal)
                );
                console2.log("    its eta (unix)        ", staleEta);
            }
        }
        // The zero-limit asset this script leaves alone, read live.
        if (block.chainid == ROBINHOOD || block.chainid == TEMPO) {
            (uint128 per, uint128 total) = v.depositLimit(address(0));
            console2.log("left alone: address(0), live per / total", uint256(per), uint256(total));
        }
    }

    function _isMax(IVaultLimits v, address token) internal view returns (bool) {
        (uint128 per, uint128 total) = v.depositLimit(token);
        return per == MAX && total == MAX;
    }

    function _checkVault() internal view returns (IVaultLimits v) {
        assets(); // chain guard
        v = IVaultLimits(VAULT);
        require(v.owner() == OWNER, "vault owner changed: review this script");
        require(!v.setupMode() && v.depositLimitsOn(), "vault not in timelock mode");
    }

    /// @dev Every token is still a contract with the decimals the list was built with.
    function _checkTokens(Asset[] memory a) internal view {
        for (uint256 i = 0; i < a.length; i++) {
            if (a[i].token == address(0)) continue;
            require(a[i].token.code.length > 0, "no token contract");
            require(IERC20Meta(a[i].token).decimals() == a[i].decimals, "decimals changed");
        }
    }
}
