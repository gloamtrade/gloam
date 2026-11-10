# Contract audit notes (Phase 1)

> **Historical (July 2026).** These notes cover the Phase-1 keccak `ShieldPool` (`0x2BD9…`, superseded). They do not describe the live vaults: for those see [`audit/REMEDIATION.md`](./audit/REMEDIATION.md), [`PRODUCTION.md`](./PRODUCTION.md) and the Kann Audits report (gloam.trade/security). The "Owner emergency withdraw" line below was later removed from source (2026-09-29); no live vault has it.

Date: 2026-07-14 · Scope: `ShieldPool` + `IncrementalMerkleTree` · Not a formal third-party audit.

## Intentional limitations (Phase 2)

| Item | Risk if ignored | Status |
| --- | --- | --- |
| Proof public inputs = root + nullifier only | Verifier that always returns true allows **arbitrary unshield** | **Do not set mock verifier on a funded pool** |
| Amount/asset not bound in proof | Wrong-amount unshield if verifier is weak | Phase 2 circuits |
| Keccak Merkle vs Poseidon | Circuit mismatch later | Documented; swap hash in library later |
| `emergencyWithdraw` | Owner can drain | **Removed** (2026-09-29). Owner has no fund-moving function; verifier/rate setters are timelocked (3 days) after `endSetup()` |

## Fixed in this pass

- Fee-on-transfer ERC-20 rejected (balance delta check)
- Safe ERC-20 call pattern (return data handling)
- Deploy docs: default verifier `address(0)` locks private exits
- Owner emergency withdraw for testnet recovery
- Tests: emergency withdraw, no-verifier unshield blocked

## Deploy checklist

1. `forge test` green  
2. `DEPLOYER_PK` funded on chain **46630**  
3. Deploy with **no** verifier unless production-grade  
4. Record address in `deployments/testnet.json`  
5. Do **not** open Shield UI deposit until you accept stuck-funds risk (no unshield without verifier) or ship Phase 2  

## Out of scope

Frontend, DEX routers, faucet tokens, mainnet.
