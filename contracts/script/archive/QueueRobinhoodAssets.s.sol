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
    function symbol() external view returns (string memory);
}

/**
 * Opens the Robinhood Chain mainnet vault to native ETH, AI and ORBIO, through
 * the vault's 3-day public timelock. Until a limit lands the asset has a zero
 * limit and the vault refuses it as a deposit. Private sends and cash-outs never
 * look at the limit.
 *
 * PONS and CASHCAT are not here: the vault already takes them (28 swap assets,
 * executed 2026-10-27), and two raises for each are already queued (100x from
 * 1 Nov, no limit from 2 Nov, script NoDepositLimits). Queueing them again here
 * would be a third change for the same limit.
 *
 * The USER runs this. It is NOT executed by CI or by any agent. --interactives 1
 * makes forge ask for the owner key; nothing is stored.
 *
 * Step 1, now: queue every limit (each one is a public ChangeQueued event).
 *   cd contracts
 *   forge script script/archive/QueueRobinhoodAssets.s.sol:QueueRobinhoodAssets --sig "queue()" \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com \
 *     --sender 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 --interactives 1 --broadcast --slow
 *
 * Step 2, 3 days later (and within the 14-day grace window): the same line with
 * --sig "execute()". It runs every change whose delay has passed and checks each
 * limit landed as queued.
 *
 * Any time, no key, nothing sent:
 *   forge script script/archive/QueueRobinhoodAssets.s.sol:QueueRobinhoodAssets --sig "status()" \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com
 *
 * Limits are in each asset's own units, about $25,000 per deposit and $250,000 in
 * total at the prices of 2026-10-31 (CoinGecko). A low total can be filled to
 * block deposits, swaps and swap refunds for that asset (audit L-03), so these sit
 * well above the first beta caps. To change one, change the two numbers on its
 * line here and in RH_MAINNET_ASSETS (packages/sdk/src/constants.ts). Lowering a
 * limit later is instant (lowerDepositLimit), e.g. to (0, 0) in an incident;
 * raising one goes through this timelock again.
 */
contract QueueRobinhoodAssets is Script {
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;

    struct Asset {
        string symbol;
        address token; // address(0) = the chain's native ETH
        uint8 decimals;
        uint128 perDeposit;
        uint128 total;
    }

    /// @notice What each asset's limit is set to. The comment on each line has the dollar values.
    function assets() public pure returns (Asset[] memory a) {
        a = new Asset[](3);
        a[0] = Asset("ETH", address(0), 18, 11e18, 110e18); // ~$24,735 / ~$247,353 at $2,248.66
        // Artificial Inu: a clone of DopplerERC20V1 whose owner (Doppler's Airlock) cannot reach lockPool again
        a[1] = Asset("AI", 0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18, 18, 400_000e18, 4_000_000e18); // ~$25,087 / ~$250,868 at $0.062717
        // Orbio.so: a plain ERC-20 from the Pons v2 launcher, no owner
        a[2] = Asset("ORBIO", 0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3, 18, 1_000_000e18, 10_000_000e18); // ~$24,697 / ~$246,972 at $0.024697
    }

    /// @notice The exact setter call a change is queued under (its id is keccak256 of it).
    function changeCall(Asset memory x) public pure returns (bytes memory) {
        return abi.encodeCall(IVaultLimits.setDepositLimit, (x.token, x.perDeposit, x.total));
    }

    function queue() external {
        IVaultLimits v = _checkVault();
        Asset[] memory a = assets();
        _checkTokens(a);
        vm.startBroadcast();
        for (uint256 i = 0; i < a.length; i++) {
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            if (per == a[i].perDeposit && total == a[i].total) {
                console2.log("already set, skipped:", a[i].symbol);
                continue;
            }
            // New assets only: never queue over a limit someone already set.
            require(per == 0 && total == 0, "already has a limit: review this script");
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
        _checkTokens(a);
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
            if (block.timestamp > eta + 14 days) {
                console2.log("expired, skipped (run queue() again):", a[i].symbol, eta);
                continue;
            }
            (uint128 per, uint128 total) = v.depositLimit(a[i].token);
            require(per == 0 && total == 0, "limit changed since the queue: review this script");
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
        console2.log("vault owner ok", v.owner() == OWNER, "timelock mode", !v.setupMode() && v.depositLimitsOn());
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
    }

    function _checkVault() internal view returns (IVaultLimits v) {
        require(block.chainid == 4663, "Robinhood Chain mainnet only");
        v = IVaultLimits(VAULT);
        require(v.owner() == OWNER, "vault owner changed: review this script");
        require(!v.setupMode() && v.depositLimitsOn(), "vault not in timelock mode");
    }

    /// @dev Every token is still a contract with the decimals the limits were sized with.
    function _checkTokens(Asset[] memory a) internal view {
        for (uint256 i = 0; i < a.length; i++) {
            if (a[i].token == address(0)) continue;
            require(a[i].token.code.length != 0, "not a contract");
            require(IERC20Meta(a[i].token).decimals() == a[i].decimals, "decimals changed");
        }
    }
}
