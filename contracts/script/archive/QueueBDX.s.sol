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
 * Opens the Ethereum and Base mainnet vaults to Beldex's BDX, through each
 * vault's 3-day public timelock. Until the limit lands BDX has a zero limit
 * and the vault refuses it as a deposit (shieldBound checks the limit before
 * it pulls a token). Private sends and cash-outs never look at the limit.
 * The chain is picked by block.chainid (Ethereum 1 or Base 8453 only): point
 * --rpc-url at the chain.
 *
 * The USER runs this. It is NOT executed by CI or by any agent.
 *
 * Step 1, now: queue the limit on each chain (a public ChangeQueued event).
 * --interactives 1 makes forge ask for the owner key; nothing is stored.
 *   cd contracts
 *   forge script script/archive/QueueBDX.s.sol:QueueBDX --sig "queue()" \
 *     --rpc-url https://ethereum-rpc.publicnode.com \
 *     --sender 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 --interactives 1 --broadcast
 *   forge script script/archive/QueueBDX.s.sol:QueueBDX --sig "queue()" \
 *     --rpc-url https://mainnet.base.org \
 *     --sender 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8 --interactives 1 --broadcast
 *
 * Step 2, 3 days later (and within the 14-day grace window): the same two
 * lines with --sig "execute()". It runs the change once its delay has passed
 * and checks the limit landed as queued.
 *
 * Any time, no key, nothing sent (live limit, target, queued eta, calldata):
 *   forge script script/archive/QueueBDX.s.sol:QueueBDX --sig "status()" \
 *     --rpc-url https://ethereum-rpc.publicnode.com
 *   forge script script/archive/QueueBDX.s.sol:QueueBDX --sig "status()" \
 *     --rpc-url https://mainnet.base.org
 *
 * Forge simulates the whole run on a fork first and sends nothing if any call
 * would revert. --ledger works in place of --interactives 1.
 *
 * The token: BDX is Beldex's LayerZero OFT, the same verified contract
 * (Sourcify exact match, contracts/MyOFT.sol:BELDEX) at the same address on
 * both chains, 9 decimals. Plain OpenZeppelin v5.4.0 ERC-20: no transfer fee,
 * no rebasing, transfer and transferFrom return true (the vault's own
 * received == amount check holds). Its owner (a 2-of-2 Safe,
 * 0x5be316030e6D1fae8E364c49256720Bf69059D30) can mint, set LayerZero peers
 * (which can mint on arrival) and pause; pause stops only mint and burn, never
 * transfers, so a note in BDX can always be cashed out.
 *
 * Limits are in BDX's own units (9 decimals): perDeposit caps one deposit,
 * total caps what the vault holds of it. 100,000 per deposit and 2,000,000 in
 * total, about $7,150 and $143,000 at $0.0715 (CoinGecko "beldex",
 * 2026-10-29). Lowering a limit later is instant (lowerDepositLimit), e.g. to
 * (0, 0) in an incident; raising one goes through this timelock again.
 */
contract QueueBDX is Script {
    /// @notice The vault and its owner are the same address on both chains.
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;

    uint256 constant ETHEREUM = 1;
    uint256 constant BASE = 8453;

    /// @notice Beldex's BDX (LayerZero OFT), the same address on Ethereum and Base.
    address constant BDX = 0x6ad12E761b438beA3EA09F6C6266556Bb24C2181;
    uint8 constant BDX_DECIMALS = 9;

    /// @notice 100,000 BDX per deposit (~$7,150 at $0.0715).
    uint128 constant PER_DEPOSIT = 100_000e9;
    /// @notice 2,000,000 BDX in the vault at most (~$143,000 at $0.0715).
    uint128 constant TOTAL = 2_000_000e9;

    /// @notice The exact setter call the change is queued under (its id is keccak256 of it).
    function changeCall() public pure returns (bytes memory) {
        return abi.encodeCall(IVaultLimits.setDepositLimit, (BDX, PER_DEPOSIT, TOTAL));
    }

    function queue() external {
        IVaultLimits v = _checkVault();
        _checkToken();
        (uint128 per, uint128 total) = v.depositLimit(BDX);
        if (per == PER_DEPOSIT && total == TOTAL) {
            console2.log("already set, nothing to queue: BDX");
            return;
        }
        // A new asset only: never queue over a limit someone already set.
        require(per == 0 && total == 0, "BDX already has a limit: review this script");
        bytes memory call_ = changeCall();
        uint256 eta = v.changeEta(keccak256(call_));
        if (eta != 0 && block.timestamp <= eta + 14 days) {
            console2.log("already queued, executable from (unix)", eta);
            return;
        }
        vm.startBroadcast();
        (, uint256 newEta) = v.queueChange(call_);
        vm.stopBroadcast();
        console2.log("queued BDX, executable from (unix)", newEta);
    }

    function execute() external {
        IVaultLimits v = _checkVault();
        _checkToken();
        bytes memory call_ = changeCall();
        uint256 eta = v.changeEta(keccak256(call_));
        if (eta == 0) {
            console2.log("not queued (or already run), nothing to do: BDX");
            return;
        }
        if (block.timestamp < eta) {
            console2.log("not ready yet, executable from (unix)", eta);
            return;
        }
        require(block.timestamp <= eta + 14 days, "expired: queue it again");
        (uint128 per, uint128 total) = v.depositLimit(BDX);
        require(per == 0 && total == 0, "BDX limit changed since the queue: review this script");
        vm.startBroadcast();
        v.executeChange(call_);
        vm.stopBroadcast();
        (per, total) = v.depositLimit(BDX);
        require(per == PER_DEPOSIT && total == TOTAL, "limit did not land as queued");
        console2.log("executed: BDX per / total", uint256(per), uint256(total));
    }

    function status() external view {
        IVaultLimits v = IVaultLimits(VAULT);
        bytes memory call_ = changeCall();
        (uint128 per, uint128 total) = v.depositLimit(BDX);
        console2.log(_chainName(), "chain", block.chainid);
        console2.log("now (unix)", block.timestamp);
        console2.log("BDX", BDX, IERC20Meta(BDX).symbol());
        console2.log("  decimals              ", uint256(IERC20Meta(BDX).decimals()));
        console2.log("  vault owner ok        ", v.owner() == OWNER);
        console2.log("  timelock mode         ", !v.setupMode() && v.depositLimitsOn());
        console2.log("  live limit per / total", uint256(per), uint256(total));
        console2.log("  target per / total    ", uint256(PER_DEPOSIT), uint256(TOTAL));
        console2.log("  queued eta (0 = none) ", v.changeEta(keccak256(call_)));
        console2.log("  queueChange calldata:");
        console2.logBytes(abi.encodeCall(IVaultLimits.queueChange, (call_)));
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == ETHEREUM) return "Ethereum";
        if (block.chainid == BASE) return "Base";
        revert("Ethereum (1) or Base (8453) mainnet only");
    }

    function _checkVault() internal view returns (IVaultLimits v) {
        _chainName();
        v = IVaultLimits(VAULT);
        require(v.owner() == OWNER, "vault owner changed: review this script");
        require(!v.setupMode() && v.depositLimitsOn(), "vault not in timelock mode");
    }

    /// @dev BDX is still the token the limit was sized for.
    function _checkToken() internal view {
        require(BDX.code.length > 0, "no BDX contract on this chain");
        require(IERC20Meta(BDX).decimals() == BDX_DECIMALS, "BDX decimals changed");
        require(keccak256(bytes(IERC20Meta(BDX).symbol())) == keccak256("BDX"), "BDX symbol changed");
    }
}
