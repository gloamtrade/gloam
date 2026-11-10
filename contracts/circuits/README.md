# Gloam circuits

**Proof system:** Groth16 on BN254. Circuits are written in Circom 2.1.6 (`pragma circom 2.1.6` in every file) with circomlib 2.0.5, and proved and verified with snarkjs 0.7.5, in the browser and in Node. Pool circuits are checked on-chain by snarkjs-exported Solidity verifiers; the proofs a holder shares with others are checked off-chain.

**Trusted setup: two key sets.** The testnet keys come from a 2^16 Powers of Tau file and a single phase-2 step. For the vault's circuits (shield, transfer, unshield) and the sealed swap, that step is a public beacon with a fixed, published value and no secret entropy, so anyone can make a proof those keys accept: the testnet pools prove nothing about who owns a note. The proof circuits (funds, payroll total, receipt) have one contribution of throwaway random entropy, which whoever made them could have kept. Testnet keys are never for mainnet. Mainnet uses the multi-party ceremony's final keys (13 contributors, beacon drand round 6561386, release `ceremony-final`; see [`../ceremony`](../ceremony)): `../src/verifiers/final` on chain and `app/public/circuits/final` in the app, hash-pinned. `scripts/gen-key-fixtures.mjs` makes real proofs with both sets (`../script/KeyCheckProofs.sol`), and the mainnet deploy refuses to create a pool unless its verifiers accept the final-key proofs and reject the dev ones (audit M-2, pre-mainnet GATE 2).

**Do not deploy a mock verifier that always returns true on a funded pool.**

## Circuits

| Circuit | Source | Constraints | Public inputs | Checked by | Status (mainnet and testnet) |
| --- | --- | --- | --- | --- | --- |
| shield | `shield/shield.circom` | 390 | `commitment, amount, asset` | On-chain, `ShieldIVerifier` via `shieldBound()` | Live |
| transfer (1 in, 2 out) | `transfer/transfer.circom` | 6,270 | `root, nullifier, newCommitment0, newCommitment1` | On-chain, `DualProofVerifier` (4 inputs) | Live |
| unshield | `unshield/unshield.circom` | 5,491 | `root, nullifier, asset, amount, recipient` | On-chain, `DualProofVerifier` (5 inputs) | Live |
| sealedSwap | `sealedSwap/sealedSwap.circom` | 6,649 | `root, nullifier, newCommitmentOut, newCommitmentChange, assetIn, assetOut, amountOutMin, rateIn, rateOut` | On-chain verifier built, not wired (`sealedSwapVerifier = 0`) | **Disabled** |
| solvency (proof of funds) | `solvency/solvency.circom` | 22,244 | `root, asset, threshold, context, nullifier[0..3]` | Off-chain, gloam.trade/verify | Live |
| receipt (proof of payment) | `receipt/receipt.circom` | 5,510 | `root, commitment, asset, minAmount, reveal, shownAmount, context` | Off-chain, gloam.trade/verify | Live |
| payroll_total | `payroll_total/payroll_total.circom` | 37,278 | `asset, total, count, paymentsHash, context` | Off-chain, gloam.trade/verify | Live |

All Merkle membership uses `common/merkle_poseidon.circom` at depth 20. Browser artifacts live in `app/public/circuits/` (`shield`, `transfer`, `unshield`, `sealed_swap`, `funds` for solvency, `receipt`, `payroll_total`) with the testnet dev keys; the mainnet final keys for the six ceremony circuits are in `app/public/circuits/final/` (the `.wasm` files are shared).

**`context`** (solvency, receipt, payroll_total) is `keccak256(abi.encode("gloam.proof.v1", kind, chainId, pool, expiresAt, verifier)) mod p`. It binds the label naming who the proof is for and its expiry into the proof, so a `gloamfunds1`, `gloampay1` or `gloamroll1` proof forwarded to someone else still shows who it was made for. The older `gloamdisc1` balance disclosure reuses the shield circuit and has no `context`, so it carries no recipient or expiry.

## Note scheme (Poseidon)

Must match `src/lib/NoteLibPoseidon.sol` and `app/src/lib/notePoseidon.ts`.

```
secret        ← random field element (wallet / browser only)
amount        ← uint256
asset         ← address (0 = native)

commitment = Poseidon(secret, amount, asset)
nullifier  = Poseidon(secret, commitment)
root       = PoseidonMerkle(commitment, path…)   // depth 20
```

## Pool circuits

### Shield (deposit)

Proves the inserted leaf opens to the public `(amount, asset)` under some secret, so a deposit cannot embed more value than it sends (audit C1). **Private:** `secret`.

### Unshield

**Private:** `secret`, Merkle path to `commitment`.  
**Public (order fixed, `PROOF_LAYOUT_VERSION = 2`):**

| Index | Name | Notes |
| --- | --- | --- |
| 0 | `root` | Must be a known pool root |
| 1 | `nullifier` | Marks note spent |
| 2 | `asset` | `uint160` cast |
| 3 | `amount` | Exact exit amount |
| 4 | `recipient` | `uint160`, bound so a relayer cannot redirect the payout |

**Constraints:** `commitment = H(secret, amount, asset)`; Merkle path proves `commitment` is in the tree at `root`; `nullifier = H(secret, commitment)`; range checks.

### Transfer

Spend one note into two new commitments (payment + change), same asset.

| Index | Name |
| --- | --- |
| 0 | `root` |
| 1 | `nullifier` |
| 2 | `newCommitment0` (payment) |
| 3 | `newCommitment1` (change) |

**Private:** secret, amount/asset of spent note, split amounts, new secrets, Merkle path.  
Value conservation: `amount_in = amount_out0 + amount_out1`.

### Sealed swap (disabled)

Built and compiled, but private trade is switched off pending audit of its solvency accounting. See [`../SEALED_TRADE.md`](../SEALED_TRADE.md).

## Verifiers (`src/verifiers/`)

| Contract | Role | On a live pool? |
| --- | --- | --- |
| `ShieldVerifier` + `ShieldIVerifier` | Groth16 shield proof | Yes, as `shieldVerifier` |
| `UnshieldVerifier` + `UnshieldIVerifier` | Groth16 unshield proof | Yes, behind `DualProofVerifier` |
| `TransferVerifier` + `TransferIVerifier` | Groth16 transfer proof | Yes, behind `DualProofVerifier` |
| `DualProofVerifier` | Routes 5 inputs to unshield, 4 to transfer | Yes, as `verifier` |
| `SealedSwapVerifier` + `SealedSwapIVerifier` | Groth16 sealed swap proof | **No** (`sealedSwapVerifier = 0`) |
| `ScaffoldUnshieldVerifier` / `ScaffoldIVerifier` | Old placeholder | **Never** on a funded pool |
| `RejectVerifier` | Always false (locks a path) | Tests / emergency lock only |

The table is the testnet set. The mainnet pools use the same contracts built from the final keys (`src/verifiers/final`, `*Final`), behind the same `DualProofVerifier`, and have no sealed swap verifier at all.

Live addresses: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Mainnet pools (`ShieldPoolPayments`, final keys): Robinhood Chain `4663`, Tempo `4217`, Base `8453` and Ethereum `1` at `0x39e28cde55cab798874746ac52cb4b5cc99a0194`, and Elysium `99901` at `0x89d3042390204f57b8b4F8949D3c2203E4002164`. Testnet pools (dev keys): Robinhood Chain `46630` `0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740`, Tempo `42431` `0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb`. Earlier pools (including the Phase-1 keccak pool `0x2BD9…`) are superseded.

## App helpers

| Module | Role |
| --- | --- |
| `app/src/lib/notePoseidon.ts` | Note commitments and nullifiers |
| `app/src/lib/merklePoseidon.ts` | Poseidon tree = Solidity |
| `app/src/lib/treeSync.ts` | Rebuild leaves from pool events |
| `app/src/lib/proverPoseidon.ts`, `proverTransfer.ts` | Witness builders |
| `app/src/lib/proveClient.ts` | Browser snarkjs |
| `app/src/lib/proofs/` | Proof of funds, payment and payroll total (prove + verify) |

## Tools

```bash
# one-time
cargo install --git https://github.com/iden3/circom.git --tag v2.1.9 circom   # any compiler >= 2.1.6
cd contracts/circuits
npm i
npm run check-tools

# compile one pool circuit
mkdir -p build/unshield
circom unshield/unshield.circom --r1cs --wasm --sym -o build/unshield -l node_modules

# proof-of-funds / payment / payroll circuits: compile, dev setup, copy artifacts to the app
node scripts/build-proof-circuits.mjs
node scripts/test-proof-circuits.mjs
```

### Deploy the pool stack (testnet)

```bash
cd contracts && forge build
cd circuits
npm i   # circomlibjs ethers snarkjs
export DEPLOYER_PK=0x...
export RPC_URL=https://rpc.testnet.chain.robinhood.com
node scripts/deploy-phase2.mjs
# → writes deployments/poseidon-testnet.json
```

Then in Vercel / app env:

```
NEXT_PUBLIC_POSEIDON_SHIELD_POOL=0x...   # ShieldPoolPoseidon
NEXT_PUBLIC_HASH_SCHEME=poseidon
NEXT_PUBLIC_SHIELD_DEPLOY_BLOCK=<deploy block>
```

## Safety

- Two key sets: the dev-ceremony keys are for the testnets only (never present them as production or use them on mainnet); mainnet uses the ceremony's final keys.
- Unit tests may use `MockVerifier`; production never does.
- Every regeneration of a proving key invalidates proofs made with the previous key; for the pool circuits the on-chain verifier must also be redeployed and switched through the 3-day timelock.
