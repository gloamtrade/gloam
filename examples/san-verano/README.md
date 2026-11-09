# san-verano

A reference integration for San Verano's business agents on Robinhood Chain
mainnet (`4663`): pay a supplier privately in USDG, keep every payment checkable
against the city's nightly root, and keep the shop burn public.

Your question was how private transactions stay compatible with CityCommits and
the verification you already run. The short answer:

1. Each private payment is a real vault transaction the agent signs itself.
2. After it lands, the agent proves the payment with Gloam's receipt circuit,
   bound to a label you pick (for example `san-verano:sale:8812`).
3. You hash that proof into one `bytes32` leaf and put it in the nightly root
   next to your other records.
4. Anyone holding the record can check, at any time, that the leaf is in the
   root, the proof is valid, the vault had that state, and that transaction
   made that payment. The amount and the supplier are not in the root.
5. Burns stay what they are: a public ERC-20 transfer to `0x…dEaD`, so the
   agent passport keeps reading them.

Everything private here is `@gloamtrade/sdk` (`buildPrivatePaymentWithReceipt`,
`sweepReceivedNote`, `buildPaymentReceipt`, `paymentReceiptLeaf`,
`checkPaymentReceipt`, `agentSigningAllowlist`). viem only signs and reads.

## Run it

```bash
# from the repo root
pnpm install
npx tsx examples/san-verano/san-verano.ts
```

That is a dry run: no keys, no network, nothing signed or sent. It proves for
real (the transfer and receipt circuits, testnet dev keys, from the repo's
`app/public/circuits`), seals for real and builds the exact calls, then lands
them in a local model of the vault instead of a chain. The model keeps the
vault's tree, roots and spent notes; it does not check transfer proofs, which
only the vault does. Every hash it prints is local. It takes a few seconds.

You will see the two calls the agent signs for a payment, the supplier's sweep,
the receipt and its leaf, the burn call, a four-leaf nightly root with the
receipt in it, all eight record checks passing, and the allowlist entries.

## The flow

| Step | Who | What | On chain |
| --- | --- | --- | --- |
| 1 | Supplier | Makes a Gloam address once (`generateReceiveKey`), shares the `gloamr1.…` tag, keeps the key server-side. | Nothing |
| 2 | Agent | Holds USDG in its private balance (a deposit with `shieldBound`, done earlier). | The deposit is public |
| 3 | Agent | `buildPrivatePaymentWithReceipt`: a private send to the supplier's tag, the payment sealed so only the supplier opens it, and the plan for its receipt. | Nothing yet |
| 4 | Agent | Signs `transfer(...)` on the vault, then `postMemo(...)` on the payment board so the supplier finds it. | A nullifier and two commitments. No amount, no supplier |
| 5 | Supplier | Opens the payment and sweeps it into a note only it knows (`sweepReceivedNote`). Until then the agent could still spend it back, so treat the payment as final only when the sweep says `final: true`. | Another private transfer |
| 6 | Agent | `buildPaymentReceipt`: proves the payment against the vault's tree, bound to your label. Works after the sweep too. | Nothing |
| 7 | Agent | The shop burn: `transfer(0x…dEaD, amount)` on the token, as today. | Public, as today |
| 8 | City | Puts `record.leaf` in tonight's root and stores the record. | Your CityCommits root |

The agent never hands anyone a key. The city never holds one.

## Signing allowlist entries

These are every call an agent signs to use Gloam on Robinhood Chain mainnet, with
USDG and GRIFT. `sanVeranoAllowlist()` in the example (or
`agentSigningAllowlist({ chainId: 4663, assets })` in the SDK) returns them as
JSON for `tosign-allowlist.json`. Native value is 0 on every one.

| Id | To | Signature | Selector | Rules |
| --- | --- | --- | --- | --- |
| `erc20.usdg.approve` | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `approve(address,uint256)` | `0x095ea7b3` | spender is the vault; the exact deposit, not unlimited |
| `erc20.grift.approve` | GRIFT `0x9f4BA41F91a59A34e17eE8C9EB3A51363B11aBD5` | `approve(address,uint256)` | `0x095ea7b3` | same |
| `gloam.vault.shieldBound` | vault `0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194` | `shieldBound(address,uint256,bytes32,bytes)` | `0x67e763e0` | deposit; asset is USDG or GRIFT |
| `gloam.vault.transfer` | vault | `transfer(bytes,bytes32,bytes32,bytes32[2])` | `0xd02dddd1` | private send, and the supplier's sweep |
| `gloam.vault.unshield` | vault | `unshield(bytes,bytes32,bytes32,address,address,uint256)` | `0x67cca6c5` | cash out; the recipient should be the business's own wallet |
| `gloam.memo.postMemo` | payment board `0x01B3172d9900Cb26d57E986429b9b23854c74598` | `postMemo(bytes32,bytes)` | `0x82301844` | the payment's commitment and the sealed ticket |

The burn is `transfer(address,uint256)` (`0xa9059cbb`) on the token, already on
your list. A payment needs only `transfer` and `postMemo`. `postMemo` is
optional: if your city already passes messages between agents, hand the
supplier the sealed ticket (`gloam2t.…`) that way instead.

The vault checks a zero-knowledge proof on `shieldBound`, `transfer` and
`unshield`, and every argument is bound by it, so a signer cannot be tricked
into sending money somewhere else by an edited argument: the call just reverts.

## Putting the leaf in the nightly root

The leaf is one `bytes32`:

```
keccak256(abi.encode(
  string  "gloam.receipt-leaf.v1",
  uint256 chainId,        // 4663
  address pool,           // the vault
  bytes32 txHash,         // the vault transfer that made the payment
  uint256[7] signals      // the receipt's public signals, in circuit order:
                          // [root, commitment, asset, minAmount, reveal, shownAmount, context]
))
```

`abi.encode`, not `encodePacked`. The same thing in Solidity:

```solidity
bytes32 leaf = keccak256(abi.encode("gloam.receipt-leaf.v1", chainId, pool, txHash, signals)); // signals: uint256[7]
```

and in TypeScript, `paymentReceiptLeaf(record)` from the SDK. The SDK's tests pin
a vector that Solidity and `cast` both reproduce, so the encoding will not drift.

Treat the leaf as one more value in your tree. If your tree hashes its leaves
again (OpenZeppelin's StandardMerkleTree does), do that to this value too. The
example's `nightlyRoot` is a stand-in (sorted-pair keccak256, what
OpenZeppelin's `MerkleProof.verify` checks), not a suggestion to change yours.

Store the record next to the leaf, off chain. It holds no secret: it is the
proof, its public signals, the label, the expiry, the transaction hash and the
leaf. Lose the record and the leaf can no longer be checked.

## Checking a record later

`checkPaymentReceipt(record, { verifySnark, client })` runs every check and
says which passed:

| Check | What it confirms |
| --- | --- |
| `leaf` | The leaf recomputes from the record. Pass `leaf` to compare against the one in your root. |
| `fields` | The asset and amounts written in the record match the proof. |
| `context` | The label, expiry, chain and vault are the ones sealed into the proof. |
| `vault` | The record names Gloam's vault on that chain. |
| `snark` | The proof verifies against the receipt checking key (`verifyGroth16` with `receipt_vkey.json`; mainnet uses the final keys, `circuits/final/receipt_vkey.json`). |
| `chain` | Your client reads the record's chain. |
| `root` | The vault has had the proof's root (`isKnownRoot`; the vault keeps every root it ever had). |
| `payment` | The transaction succeeded and its `Transferred` event created this note as the payment, not as change. |

Then check the leaf against your root with your own merkle proof, as you do for
any record. A record also reads as a Gloam proof of payment:
`paymentProofText(record)` gives `gloampay1:…`, which anyone can paste into
[gloam.trade/verify](https://gloam.trade/verify), or check with the partner API
(`GloamApiClient.verifyProof`).

`expired` is reported apart from `ok`. Your root does not expire, but Gloam's
verify page fails a proof past its expiry; the default is 30 days, set it with
`receipt.expiresAt`.

## What is public and what is not

- **Public:** the agent's deposits (amount and asset), every cash out (amount,
  asset, recipient), the burns, the nightly root, and that the agent's wallet
  sent a vault transaction at a given time.
- **Private:** how much each payment was, who received it, and the agent's
  private balance.
- **The agent's wallet shows as the sender** of its vault transfer when it signs
  it itself. The amount and the supplier stay hidden, but the fact that this
  wallet paid someone privately at that time does not. Sending the transfer and
  the memo through the Gloam relay (`GLOAM_RELAY=1` here, `relayIntent` and
  `relayMemo` in the SDK) keeps the wallet out of it; the relay can only submit
  or refuse, never redirect money.
- **Whoever sees a record** sees its asset, its minimum (or amount, if you
  reveal it) and its transaction hash. Publish only the root to keep records
  private, or reveal a record to the party who needs it.
- **A receipt does not show who got paid.** The agent picks the payment note's
  key, so both sides can make the same proof. Who the payment was for comes from
  your record (the label), and the supplier's sweep is what makes it the
  supplier's.

## Honest limits

- **No on-chain receipt verifier.** The vault verifies deposit, transfer and
  cash-out proofs. Receipt proofs are checked off chain (snarkjs, the published
  checking key, gloam.trade/verify, the partner API). A Solidity contract can
  recompute the leaf and check the merkle path today; checking the receipt proof
  itself on chain would need a receipt verifier contract, which Gloam has not
  deployed.
- **GRIFT is queued, not live.** Its deposit limit is behind the vault's 3-day
  timelock and deposits revert until it lands. USDG works now.
- **Mainnet.** Mainnet runs on the final keys of the 13-contributor trusted setup,
  with deposit limits. It had an internal review on 20 October 2026, and
  Kann Audits reviewed the vault contracts (report, 1 November 2026) and found no
  Critical, High or Medium issues.

## Run it on Robinhood Chain testnet

The live mode signs and sends with the agent's own key. It defaults to Robinhood
Chain testnet (`46630`, dev keys, test USDG).

1. Get test ETH for gas from the
   [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com/) and
   test USDG from the [Paxos faucet](https://faucet.paxos.com/).
2. Give the agent a private balance: run
   [`examples/agent-shield`](../agent-shield) with `GLOAM_ASSET=USDG`. It prints
   the note's secret; keep it and the amount.
3. Run:

```bash
GLOAM_SV_LIVE=1 \
GLOAM_AGENT_KEY=0x... \
GLOAM_AGENT_NOTE_SECRET=0x... \
GLOAM_AGENT_NOTE_AMOUNT=10000000 \
GLOAM_PAY_AMOUNT=1 \
GLOAM_BURN_AMOUNT=0.1 \
npx tsx examples/san-verano/san-verano.ts
```

| Variable | What it does |
| --- | --- |
| `GLOAM_SV_LIVE` | `1` for a live run. Unset, it is the dry run. |
| `GLOAM_AGENT_KEY` | The agent's wallet key. It signs the transfer, the memo and the burn. |
| `GLOAM_AGENT_NOTE_SECRET` | Secret of the agent's private note that pays. |
| `GLOAM_AGENT_NOTE_AMOUNT` | That note's amount in base units (USDG has 6 decimals: `10000000` is 10 USDG). |
| `GLOAM_NETWORK` | `robinhood` (testnet, the default) or `robinhood-mainnet`. |
| `GLOAM_ASSET` | The asset of the note and the payment. Default `USDG`. |
| `GLOAM_PAY_AMOUNT` | What the supplier gets. Default `1`. |
| `GLOAM_PAY_NOTE` | A private line only the supplier reads. |
| `GLOAM_RECEIPT_FOR` | The label sealed into the receipt. Default `san-verano:sale:pilot`. |
| `GLOAM_SUPPLIER_TAG` | The supplier's `gloamr1.…` tag. The supplier then sweeps on its side. |
| `GLOAM_SUPPLIER_KEY_FILE` | A JSON file with the supplier's receive key, so this run sweeps as the supplier. With neither, the run makes a throwaway supplier. |
| `GLOAM_BURN_AMOUNT` | Burn this much after paying. Default none. |
| `GLOAM_BURN_TOKEN` | The token burned. Default the payment asset on testnet, GRIFT on mainnet. |
| `GLOAM_RELAY` | `1` sends the transfer, the memo and the sweep through the Gloam relay. |
| `GLOAM_RPC` | Your own RPC URL. |
| `GLOAM_CIRCUITS_DIR` | Where the circuit files are. Default the repo's `app/public/circuits`; missing files are downloaded from gloam.trade and checked against their SHA-256. |

It prints the agent's change note (keep its secret: it is the rest of the
balance), the supplier's fresh note when it sweeps, the receipt leaf, every
check against the chain, the record as JSON and as `gloampay1:…`.

On mainnet (`GLOAM_NETWORK=robinhood-mainnet`) the same code proves with the
final keys. Direct deposits and private payments are free; a cash out costs 0.5%.

See the [SDK docs](https://gloam.trade/docs/sdk) and
[private commerce with commitments](https://gloam.trade/docs/agents/commitments).
