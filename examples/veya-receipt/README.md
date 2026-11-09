# veya-receipt

The leaf the Gloam MCP server sends [VEYA](https://veyanet.tech) for one payment.
A receipt hashes into one `bytes32` with `paymentReceiptLeaf` from
`@gloamtrade/sdk`, the server posts that leaf and the agent id, and VEYA writes
the leaf to `storeCommitment` on `Veya.sol`. The amount and the payee are not in
the leaf.

## Run it

```bash
# from the repo root
pnpm install
npx tsx examples/veya-receipt/veya-receipt.ts
```

That hashes a sample record, which is not a real payment, and prints what would
go to VEYA. It takes no key, uses no network and sends nothing. Pass a record of
your own to hash that instead. A record comes from `buildPaymentReceipt`, and
[`examples/san-verano`](../san-verano) makes one end to end:

```bash
npx tsx examples/veya-receipt/veya-receipt.ts record.json
```

## How it works in the MCP server

Set `GLOAM_VEYA_ANCHOR_URL` next to the check's settings. The
[MCP README](../../mcp/README.md#the-receipt-after-a-payment) has the details.

| Step | Who | What |
| --- | --- | --- |
| 1 | VEYA | Answers the check with an allow and a check id. |
| 2 | MCP server | Pays privately. |
| 3 | MCP server | Once the payment lands, proves it with the check id as the receipt's verifier, and keeps the record in its encrypted note store. |
| 4 | MCP server | Posts `{"leaf": "0x…", "agent_id": "…"}` to `GLOAM_VEYA_ANCHOR_URL`, and nothing else. |
| 5 | VEYA | Writes the leaf to `storeCommitment` and answers with the transaction. |

## What to know

- **No anchoring wallet.** VEYA writes the leaf, so you hold no key for it and pay
  no gas for it. VEYA's hosted MCP write tools take a private key
  (`payerPrivateKey`); this flow does not use them, so never give them one, and
  never send a note secret anywhere.
- **`anchored` means VEYA named the leaf and its transaction.** The result gives
  it as `anchorTx`. The server does not read the chain to confirm the write, so
  look it up if it matters. VEYA writes a leaf once, so sending the same one again
  is safe.
- **VEYA can't open a leaf.** It sees a hash and the agent id. Only someone
  holding the record can recompute the leaf and see what it commits to.
- **The time is public.** An anchor shows when it was written, shortly after the
  payment.
- **What a leaf proves.** Anyone holding the record can check it with
  `checkPaymentReceipt`: a private payment of that asset and at least that amount
  was made by that transaction, for that check id. It does not show who received
  it, because the payer picks the payment note's key. `Veya.sol` does not check
  the leaf, it only stores it.
- **Keep the record off chain.** It holds the transaction hash and the receipt's
  public signals. Only the leaf goes to VEYA.
