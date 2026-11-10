/**
 * @gloamtrade/sdk: Gloam's private path as a reusable package.
 *
 * Shielded balances, private transfers, and private payments that any app or
 * agent can plug into. It runs on the chains Gloam deploys to: Robinhood Chain,
 * Tempo, Base, Ethereum and Elysium on mainnet (the ceremony's final keys), and
 * their testnets (dev keys on the Robinhood Chain and Tempo testnets; Base
 * Sepolia and Ethereum Sepolia run the mainnet pool and keys; Elysium's testnet
 * appears once its pool is filled in). Each is a separate
 * deployment of the same shielded-pool design: pick a network
 * (mainnetNetwork("tempo"), gloamNetworks(), or GLOAM_NETWORKS for the
 * testnets), pass its `chainId` and `poolAddress`, and prove with
 * circuitArtifactUrls(circuit, chainId). The Gloam vault app is the reference
 * implementation.
 *
 * Surface (all live and exported below):
 *
 *   note      note commitment + nullifier (Poseidon), field math
 *   merkle    depth-20 incremental Merkle tree + circom path builder
 *   sync      rebuild the pool tree from chain -> membership paths for spends
 *   witness   unshield / transfer / sealedSwap witness builders
 *   proofs    proof-of-funds + proof-of-payment witnesses, verifier context
 *   prove     injected Groth16 prover (artifactProver) + proof packing
 *   rates     sealed-rate math + size-privacy policy (pure)
 *   builders  shieldBound | unshield | privateSend | privateTrade intents
 *   swap      private swaps: the routers, pools, routes and quotes, the same
 *             planning as the Gloam app, on every chain with a router
 *   swapIntent quoteSwap, buildSwapIntent, sendSwap, and a swap's refund and
 *             exit (readSwapOutcome, buildSwapRefund, buildSwapExit). A swap
 *             hides who swapped, not the tokens or the amounts
 *   fee       the vault's cash-out fee, read live
 *   x402      private agent payments over HTTP 402 (settle-then-prove)
 *   x402Cashout scheme gloam-cashout: a private payer cashes out to a public
 *             payee (a gateway's splitter), and the gateway's verifier
 *   receive   receive tags: seal a payment so only its payee can open it
 *   sweep     payee side: move a received payment to a fresh note (final)
 *   requests  payment request links (pay my Gloam address, with a private note)
 *   incoming  payee side: find payments sealed to your key and read their notes
 *   api       GloamApiClient: the partner API (relay with a key, proofs, links)
 *   commerce  pay privately and put a receipt leaf in a merkle root you publish;
 *             the calls an agent signs, for a signing allowlist
 *   constants pool + verifier addresses, chain ids, networks (mainnet and
 *             testnet), assets + launch deposit limits, cash-out fee and recipient
 *             check, circuit files
 *   limits    the vault's deposit limits, read live
 *   mainnet   MAINNET_POOLS, BASE_SEPOLIA_POOL and ETHEREUM_SEPOLIA_POOL, the
 *             one place those pool addresses live
 *
 * Environment split: the crypto/math core is pure and runs anywhere. Proving
 * (snarkjs + artifacts) and storage (notes, keys) are injected, so the same core
 * serves the browser app and the node MCP signer. Private swaps go through the
 * swap routers (swapIntent). The old sealed trade (buildPrivateTradeIntent,
 * sealedSwap) is retired: its on-chain path reverts on every live pool.
 */

export const SDK_VERSION = "0.7.0";

export * from "./intents.js";
export * from "./rates.js";
export * from "./privacy.js";
export * from "./constants.js";
export * from "./mainnet.js";
export * from "./elysium.js";
export * from "./poseidon.js";
export * from "./note.js";
export * from "./merkle.js";
export * from "./proof.js";
export * from "./witness.js";
export * from "./proofs.js";
export * from "./prove.js";
export * from "./builders.js";
export * from "./limits.js";
export * from "./fee.js";
export * from "./swap.js";
export * from "./swapIntent.js";
export * from "./sync.js";
export * from "./x402.js";
export * from "./x402Cashout.js";
export * from "./receiveTag.js";
export * from "./sweep.js";
export * from "./requests.js";
export * from "./shortLink.js";
export * from "./incoming.js";
export { PAYMENT_NOTE_MAX, cleanPaymentNote } from "./paymentNote.js";
export * from "./relay.js";
export * from "./rpc.js";
export * from "./api.js";
export * from "./commerce.js";
