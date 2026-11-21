# Spike: Gloam on Solana via Helius Privacy Rings

A throwaway spike, outside the pnpm workspace and the app build. Localnet only:
no API key, no mainnet, no real money. Every key is generated fresh per run.

```bash
# the zolana CLI (cli-v0.10.0 release binary, checked against its SHA256SUMS)
zolana dev start            # surfpool :8899, Photon indexer :8784, local prover :3001
pnpm install --ignore-workspace
pnpm spike                  # one wallet: register, deposit, private transfer, withdraw
pnpm account-layer          # Gloam's account layer (below)
```

Both scripts passed on localnet on 2026-11-22 (SDK `@heliuslabs/spr@0.9.0-alpha`,
programs `shielded-pool-v1.0.0` / `user-registry-v1.0.0`, local prover).

## The account layer (`src/account-layer.ts`, `src/lib.ts`)

Each Gloam user gets a private Solana account that is not their main wallet.

- **Derivation.** The main wallet signs a fixed Gloam text (`accountMessage(index)`).
  The account seed is `HKDF-SHA256(signature, salt "gloam/solana-account/v1", info "account/<index>")`,
  32 bytes, which becomes an Ed25519 key (`SigningKey.fromEd25519Bytes`). The account's shielded
  nullifier and viewing keys come from that account key through the SDK's own `TSPP/derive/v1`
  derivation. See `deriveAccount` in `src/lib.ts`.
- **Storage.** Nothing is stored. Ed25519 signatures are deterministic, so the same main wallet
  re-derives the same accounts on any device. The main wallet is the backup. The app keeps the
  account key in memory for the session; a later build may cache it encrypted like our EVM notes.
- **Fees.** Gloam's relayer pays registration rent and every private transfer's fee, so the private
  accounts hold no SOL and are never funded from the main wallet. The fee payer is bound into the
  proof (`new ConfidentialTransfer(owner, inputs, feePayer)`), so a sponsored transfer names the relayer.
- **Rotation.** An account can move its whole balance privately to account `index + 1`.

What each transaction shows publicly (addresses found in the transaction bytes, localnet run):

| Step | Addresses visible |
| - | - |
| register private accounts | the private account, Gloam relayer |
| deposit (main wallet into private #0) | Alice main wallet, Alice private #0 |
| payment (Alice #0 to Bob #0) | Alice private #0, Bob private #0, Gloam relayer |
| rotation (Alice #0 to Alice #1) | Alice private #0, Alice private #1, Gloam relayer |
| cash out (Alice #1 to a fresh address) | Alice private #1, Gloam relayer, cash-out address |

Amounts and the asset stay encrypted in payments and rotations. Bob's main wallet never appears.

Limits of the Default Ring, measured:
- A deposit links the main wallet to the private account it funds.
- Every private transfer shows both private accounts, so a rotation links the old account to the new one.
  Rotation does not break long-term linking on the Default Ring; it only hides the amount.
- Hiding sender and recipient needs an anonymous Custom Ring, which is not live yet.

## Answers (docs, SDK and source)

**(a) Where the proof is made.** The SDK's default prover is Helius's attested AWS Nitro enclave behind
the Helius RPC, and proving "requires plaintext inputs of the complete user transaction data and nullifier keys"
(docs/privacy/integration/wallet.md, "On Proof Generation"). The prover is open source (`helius-labs/zolana/prover`,
Go/gnark) and the CLI ships a prebuilt binary. `createSprClient({ proverUrl })` points the SDK at any prover;
this spike proved everything with a local prover. "Local proof generation is coming soon": no browser proving today,
and the full proving-key set is up to 5.4 GB (zolana README).

**(b) The shielded keypair.** An Ed25519 signing key, a nullifier key and an X25519 viewing key. The last two are
HKDF-derived from the Ed25519 signature over the Solana off-chain message `TSPP/derive/v1`
(docs/privacy/concepts/encryption.md; SDK `keypair/derivation.d.ts`, `LocalKeys.fromDerivationSeed`).
The SDK takes any Ed25519 key (`ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed))`), so the private
account can be a key we derive. The SDK's `SigningKey.sign` refuses `TSPP/derive/` messages (`KEYPAIR_DERIVATION_INPUT`).
With the account layer the main wallet only signs Gloam's plain text, so wallet support for that off-chain envelope doesn't matter.

**(c) Rings.**
- **Default Ring:** hides the asset and amount. The sender's and recipient's addresses are public: both
  pubkeys are in the transfer bytes here. A deposit shows the source, asset, amount and the funded account.
  A withdrawal shows the destination, asset and amount.
- **Anonymous Custom Ring:** hides sender, recipient, asset and amount, with a relayer submitting. It supports
  only delegated decryption, so the ring's RPC provider can view balances and history, plus any ring auditor
  (concepts/encryption.md).
- **Status:** Custom Rings are "being audited, with a target mainnet release in Q4 2026"
  (integration/enterprise.md), with audits expected to conclude December 2026 (security.md). Not live.

**(d) Tokens.** SOL, SPL and Token-2022. Each SPL mint needs an interface PDA, which anyone can create; the
creator pays the rent. Read on mainnet 2026-11-22 at the PDA the SDK derives:
- **USDT:** the interface exists.
- **USDC and PYUSD:** absent. Someone has to create them, or the derivation needs checking with Helius.

**(e) Fees.** Ordinary Solana fees, which any sponsor can pay. On localnet:
- **Registration:** about 0.00159 SOL of registry rent per account.
- **Sponsored payment, rotation or cash out:** 10,000 lamports (two signatures). Nullifier rent came out of
  the tree's fee pool, not the payer.
- **Mainnet:** the tree has a fee schedule (`TreeFeeSchedule`); its values aren't published.
- **API key:** devnet and mainnet need a Helius API key, and the docs give no price.

**(f) Licences.** `@heliuslabs/spr` is Apache-2.0 (npm). `helius-labs/zolana` is Apache-2.0 (LICENSE, plus THIRD_PARTY_NOTICES).
Audits: Certora (Oct 2026) and zkSecurity (Aug 2026) are published; OtterSec is awaiting its report. Trusted setup was done 2 Nov 2026.
