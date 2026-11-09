// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "../src/GloamVaultSwapV4.sol";
import {GloamVaultSwapV4c} from "../src/GloamVaultSwapV4c.sol";
import {GloamVaultSwapTempo2} from "../src/GloamVaultSwapTempo2.sol";
import {DeployVaultSwapV4b} from "./DeployVaultSwapV4b.s.sol";

interface IPoolManagerState2 {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IWETHMeta2 {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

/**
 * Private swaps v3: GloamVaultSwapV4c on Robinhood Chain, Base and Ethereum, and
 * GloamVaultSwapTempo2 on Tempo. This script sends nothing and holds no key. The
 * routers go out from the owner's browser wallet, through the CREATE2 factory, on
 * contracts/launch/router.html (DEPLOY-ROUTER.md). Here is what that page must
 * match, and a dry run of it against live state, from contracts/:
 *
 *   forge script script/DeployVaultSwapV4c.s.sol:DeployVaultSwapV4c --sig "dryRun()" --rpc-url <chain's RPC>
 *
 * The vault, the treasury, the PoolManager and WETH are fixed for good. The pools
 * below are live at once; any pool added later waits out POOL_DELAY (3 days) after
 * the owner queues it, and the owner can remove one at once. Each list is pinned
 * by test/fixtures/router-next.json, with the address it lands at.
 *
 * Base and Ethereum: hookless pools only, picked from live state on 2026-10-31 by
 * quoting $100, $500 and $5,000 both ways against the same pairs on Uniswap v3.
 * Left out, checked on chain on 2026-11-01. PYUSD: $100 into its USDC pool returns
 * about $6. BDX: it has v4 pools on Base and Ethereum, but they hold about $1,100 at
 * most, nearly all at LP fees of 9% to 98%, and selling $100 of it returns under $10.
 */
contract DeployVaultSwapV4c is Script {
    address constant VAULT = 0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194;
    address constant TREASURY = 0xB3900ac9350903218e4c7597bAb0f008F01B30B8;
    address constant OWNER = 0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8;
    /// The keyless CREATE2 factory, the same address on all four chains.
    address constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant SALT = keccak256("gloam.vault-swap.v3");

    address constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    /// Uniswap's v4 deployments, checked 2026-10-31: the V4Quoter's and PositionManager's poolManager() both name these.
    address constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address constant ETHEREUM_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address constant ETHEREUM_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TEMPO_DEX = 0xDEc0000000000000000000000000000000000000;

    address constant BANNED_HOOK = 0x958541C0Ce2E1A158309f7d1b141963eDa31C880;
    /// PoolManager storage slot of its `pools` mapping (v4-core StateLibrary.POOLS_SLOT).
    bytes32 constant POOLS_SLOT = bytes32(uint256(6));

    // Base
    address constant B_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant B_USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant B_EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    // Ethereum
    address constant E_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant E_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant E_USDG = 0xe343167631d89B6Ffc58B88d6b7fB0228795491D;
    address constant E_EURC = 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c;
    // Robinhood Chain, past v2's deploy list
    address constant R_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant R_AI = 0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18;
    address constant R_ORBIO = 0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3;
    address constant FABLES_HOOK = 0x08E52564Bad99E05a694b4809F397edcA417A080;

    /// v2's 41 pools at deploy, in order, then AI's and ORBIO's.
    function robinhoodPools() public returns (PoolKey[] memory p) {
        PoolKey[] memory v2 = new DeployVaultSwapV4b().pools();
        p = new PoolKey[](v2.length + 4);
        for (uint256 i = 0; i < v2.length; i++) p[i] = v2[i];
        p[41] = PoolKey(R_AI, R_USDG, 8388608, 60, FABLES_HOOK); // AI / USDG dynamic fee, Fables fee hook
        p[42] = PoolKey(R_AI, R_USDG, 2300, 23, address(0)); // AI / USDG 0.23%, hookless
        p[43] = PoolKey(R_USDG, R_ORBIO, 8000, 80, address(0)); // USDG / ORBIO 0.8%, hookless
        p[44] = PoolKey(R_USDG, R_ORBIO, 8388608, 200, FABLES_HOOK); // USDG / ORBIO dynamic fee, Fables fee hook
    }

    function basePools() public pure returns (PoolKey[] memory p) {
        p = new PoolKey[](7);
        p[0] = PoolKey(address(0), B_USDC, 500, 10, address(0)); // ETH / USDC 0.05%, the hub
        p[1] = PoolKey(address(0), B_USDC, 3000, 60, address(0)); // ETH / USDC 0.3%, deeper at size
        p[2] = PoolKey(B_USDC, B_USDT, 7, 1, address(0)); // USDC / USDT 0.0007%
        p[3] = PoolKey(B_USDC, B_USDT, 6, 1, address(0)); // USDC / USDT 0.0006%
        p[4] = PoolKey(B_USDC, B_USDT, 4, 1, address(0)); // USDC / USDT 0.0004%
        p[5] = PoolKey(B_USDC, B_USDT, 100, 1, address(0)); // USDC / USDT 0.01%, wider range
        p[6] = PoolKey(B_EURC, B_USDC, 500, 10, address(0)); // EURC / USDC 0.05%, the only hookless one with depth
    }

    function ethereumPools() public pure returns (PoolKey[] memory p) {
        p = new PoolKey[](13);
        p[0] = PoolKey(address(0), E_USDC, 500, 10, address(0)); // ETH / USDC 0.05%
        p[1] = PoolKey(address(0), E_USDC, 100, 1, address(0)); // ETH / USDC 0.01%
        p[2] = PoolKey(address(0), E_USDT, 500, 10, address(0)); // ETH / USDT 0.05%
        p[3] = PoolKey(address(0), E_USDT, 100, 1, address(0)); // ETH / USDT 0.01%
        p[4] = PoolKey(E_USDC, E_USDT, 7, 1, address(0)); // USDC / USDT 0.0007%
        p[5] = PoolKey(E_USDC, E_USDT, 8, 1, address(0)); // USDC / USDT 0.0008%
        p[6] = PoolKey(E_USDC, E_USDT, 10, 1, address(0)); // USDC / USDT 0.001%
        p[7] = PoolKey(E_USDC, E_USDT, 100, 1, address(0)); // USDC / USDT 0.01%
        p[8] = PoolKey(E_USDC, E_USDG, 65, 1, address(0)); // USDC / USDG 0.0065%
        p[9] = PoolKey(E_USDC, E_USDG, 100, 1, address(0)); // USDC / USDG 0.01%
        p[10] = PoolKey(E_USDT, E_USDG, 100, 1, address(0)); // USDT / USDG 0.01%
        p[11] = PoolKey(E_EURC, E_USDC, 250, 3, address(0)); // EURC / USDC 0.025%
        p[12] = PoolKey(E_EURC, E_USDC, 300, 6, address(0)); // EURC / USDC 0.03%
    }

    /// One v4 chain's router: what the constructor is fixed to.
    function config(uint256 chainId) public returns (address poolManager, address weth, PoolKey[] memory pools) {
        if (chainId == 4663) return (RH_POOL_MANAGER, RH_WETH, robinhoodPools());
        if (chainId == 8453) return (BASE_POOL_MANAGER, BASE_WETH, basePools());
        if (chainId == 1) return (ETHEREUM_POOL_MANAGER, ETHEREUM_WETH, ethereumPools());
        revert("not a v4 chain");
    }

    /// The bytes the deploy page hands the factory, after the salt.
    function initCode(uint256 chainId) public returns (bytes memory) {
        if (chainId == 4217) {
            return abi.encodePacked(type(GloamVaultSwapTempo2).creationCode, abi.encode(VAULT, TREASURY, TEMPO_DEX));
        }
        (address pm, address weth, PoolKey[] memory pools) = config(chainId);
        return abi.encodePacked(type(GloamVaultSwapV4c).creationCode, abi.encode(VAULT, TREASURY, pm, weth, OWNER, pools));
    }

    /// Where the factory puts this chain's router.
    function predicted(uint256 chainId) public returns (address) {
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), FACTORY, SALT, keccak256(initCode(chainId))));
        return address(uint160(uint256(hash)));
    }

    /// Every check against live state, then the deploy in the local simulation only. Not through the
    /// factory: forge can't run it on a forked Base. The deploy page simulates the factory's call itself.
    function dryRun() external {
        uint256 id = block.chainid;
        require(VAULT.code.length > 0 && FACTORY.code.length > 0, "vault or factory missing");
        address at = predicted(id);
        require(at.code.length == 0, "already deployed");
        if (id == 4217) {
            require(TEMPO_DEX.code.length > 0, "the Stablecoin DEX is missing");
            GloamVaultSwapTempo2 t = new GloamVaultSwapTempo2{salt: SALT}(VAULT, TREASURY, TEMPO_DEX);
            require(address(t.vault()) == VAULT && t.treasury() == TREASURY && address(t.dex()) == TEMPO_DEX, "wiring");
        } else {
            _checkV4(id);
            (address pm, address weth, PoolKey[] memory pools) = config(id);
            _verifyV4(id, new GloamVaultSwapV4c{salt: SALT}(VAULT, TREASURY, pm, weth, OWNER, pools));
        }
        console2.log("router will land at:", at);
        console2.log("dry run only: nothing was sent");
    }

    function _checkV4(uint256 id) internal {
        (address pm, address weth, PoolKey[] memory p) = config(id);
        require(pm.code.length > 0, "pool manager missing");
        require(
            keccak256(bytes(IWETHMeta2(weth).symbol())) == keccak256("WETH") && IWETHMeta2(weth).decimals() == 18,
            "not WETH"
        );
        require(weth.balance >= IWETHMeta2(weth).totalSupply(), "WETH not fully backed");
        for (uint256 i = 0; i < p.length; i++) {
            require(p[i].hooks != BANNED_HOOK, "banned hook");
            require(id == 4663 || p[i].hooks == address(0), "hookless only here");
            bytes32 poolId = keccak256(abi.encode(p[i]));
            bytes32 slot0 = IPoolManagerState2(pm).extsload(keccak256(abi.encode(poolId, POOLS_SLOT)));
            require(uint160(uint256(slot0)) != 0, "pool not initialized");
        }
    }

    function _verifyV4(uint256 id, GloamVaultSwapV4c router) internal {
        (address pm, address weth, PoolKey[] memory p) = config(id);
        require(address(router.vault()) == VAULT && router.treasury() == TREASURY, "wiring");
        require(address(router.poolManager()) == pm && router.weth() == weth, "wiring");
        require(router.owner() == OWNER, "owner");
        for (uint256 i = 0; i < p.length; i++) {
            require(router.allowedPool(keccak256(abi.encode(p[i]))), "pool not allowed");
        }
    }
}
