import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { liveMainnetNames, mainnetPool } from "@/lib/mainnet";
import { ELYSIUM } from "@/lib/elysium";
import { SWAP_REF_MAX, SWAP_REF_WORDS, swapNetworks } from "@/lib/swapLink";

/** Where a swap link fills in a swap now (lib/swapLink): the docs follow each network's switch. */
const SWAP_NETWORKS = swapNetworks();

export const metadata: Metadata = {
  title: "Partner program and API",
  description:
    "Add private payments to your app with a Gloam API key or a link with your partner code, set your own fee, and see attributed volume by source. Full v1 API reference with curl examples. Partner fees are not charged yet, on mainnet or testnet.",
};

const ERRORS: [string, number | string, string][] = [
  ["missing_key", 401, "No Authorization header. Send Authorization: Bearer gloam_live_... (mainnet) or gloam_test_... (testnet)"],
  ["invalid_key", 401, "Not a Gloam key, or a key that was revoked or rotated."],
  ["key_env_mismatch", 403, "A live key on a testnet, or a test key on a mainnet."],
  ["rate_limited", 429, "Over 300 requests in a minute for this key. Retry-After says when to retry."],
  ["invalid_json", 400, "The body is not a JSON object."],
  ["bad_request", 400, "A relay field is malformed (proof, root, nullifier, commitments, asset, to, amount, memo). Relayed memos are capped at 2,048 bytes."],
  ["network", 400, `chainId is not a network the relay serves (${ELYSIUM ? `4663, 4217, 8453, 1 or ${ELYSIUM.chainId}` : "4663, 4217, 8453 or 1"} on mainnet; 46630, 42431, 84532 or 11155111 on testnet).`],
  ["bad_action", 400, "action is not transfer, unshield, memo, swap or swapExit."],
  ["no_swap, swap_router, swap_asset, same_asset, BadRoute", 400, "Private swaps are not live on that network, or the router, an asset or the route is not one Gloam knows there."],
  ["SwapExpired, swap_router_old", 409, "The swap's time ran out, or it was made for an earlier router. Get a new quote and prove again."],
  ["swap_small, swaps_paused, note_wait", "422 or 429", "On a chain where gas is dear, the swap is under the relay's floor, or the relay is pausing swaps or this note for the hour. Nothing was sent."],
  ["unshield_tx, nothing_waiting, no_exit", "400 or 409", "A refund or exit names no vault payment to its escrow, nothing waits there, or its router has no exit."],
  ["check_failed", 503, "The relay could not read the chain for a check. Nothing was sent. Try again shortly."],
  ["screened", 403, "A cash out to a sanctioned address. The relay says nothing more."],
  ["asset_policy", 403, "On Tempo, the token issuer's policy blocks this cash out."],
  ["AlreadySpent", 409, "The note was already spent."],
  ["UnknownRoot", 409, "The proof was made against a vault state the pool no longer knows. Resync and prove again."],
  ["not_seen", 409, "A payment message for a payment that is not in the vault yet."],
  ["in_flight", 409, "The same proof is already being relayed. Wait for that send to finish instead of retrying."],
  ["vault_recipient", 400, "A cash out to the vault or the memo board itself. Pick a wallet address instead."],
  ["InvalidProof, InsufficientPoolBalance, ...", 422, "The dry run against the pool reverted, with the pool's own reason. Nothing was sent."],
  ["relay_off, relay_empty", 503, "The relay is not set up, or out of gas, on this network."],
  ["spend_cap", 429, "The relay reached its hourly limit on this network, or your account reached its share of it. Nothing was sent. Try again later."],
  ["memo_busy", 429, "The relay's hourly budget for payment messages on this network is used up. Nothing was sent. Try later, or post the message from your own wallet."],
  ["gas_most", 422, "This send costs more gas than the relay pays for its kind. Nothing was sent."],
  ["gas_high", 503, "Gas on this chain is over the relay's ceiling (Ethereum mainnet: 3 gwei). Nothing was sent. Try again shortly, or submit the call yourself."],
  ["rpc", 502, "The network did not answer. Try again."],
  ["bad_tx, tx_not_found, tx_failed, not_a_deposit, too_old", "400 to 422", "Deposit attribution: the hash is malformed, not found, failed, not a deposit into Gloam's vault, or older than 24 hours."],
  ["already_attributed", 409, "That transaction is already counted to a partner."],
  ["bad_code, code_not_live", "400 or 404", "A payment request's partnerCode: not a link code, or one that is revoked, expired or not yours."],
  ["invalid_proof", 400, "Not a Gloam proof, or a damaged one."],
  ["bad_tag, unknown_network, unknown_asset, bad_amount", 400, "Payment request fields."],
  ["no_live_pool, unknown_network", 404, "No live vault on that network, or an unknown network in the path."],
  ["unavailable", 503, "Reading the vault took too long. Try again shortly."],
  ["keys_unconfigured, storage_unavailable", 503, "The server is missing its key pepper or its store."],
  ["internal", 500, "Our fault. The requestId helps us find it."],
];

export default function DocsPartnersPage() {
  return (
    <DocsLayout
      title="Partner program and API"
      lede="Add private payments to your app with one API key, or send people to Gloam with a link that carries your partner code. You set your own fee, and what your key or your links bring in is counted to you, checked on chain. Partner fees are not charged yet, on mainnet or testnet."
      glance={[
        { label: "Base URL", value: "https://gloam.trade/api/v1" },
        { label: "Auth", value: "Bearer API key" },
        { label: "Format", value: "JSON, version 1" },
        { label: "Partner fees", value: "Not charged yet" },
      ]}
      quickLinks={[
        { href: "/partners", label: "Partner program" },
        { href: "/partners/dashboard", label: "Open the portal" },
        { href: "/docs/sdk", label: "SDK" },
        { href: "/docs/privacy-model", label: "What stays private" },
      ]}
    >
      <h2>How the program works</h2>
      <p>
        Your users keep their own keys and their own money. They prove each payment
        in their browser or agent with the <Link href="/docs/sdk">SDK</Link>. Your
        server sends the proven payment through the Gloam relay with your API key,
        and that is how a payment is counted to you.
      </p>
      <ul>
        <li>
          <strong>Sign in</strong> at <Link href="/partners/dashboard">/partners/dashboard</Link>{" "}
          with your wallet. You sign a short message (Sign-In with Ethereum); it
          costs nothing and moves no money.
        </li>
        <li>
          <strong>Make a key.</strong> It is shown once. Gloam keeps only a keyed
          fingerprint of it (HMAC-SHA256 with a server secret), so nobody can read
          it back. Rename, rotate (a new secret, the old one stops at once) or
          revoke it any time.
        </li>
        <li>
          <strong>Set your fee</strong> and a payout address per network.
        </li>
        <li>
          <strong>Relay payments with the key.</strong> The portal shows your
          volume, your would-be fees and every payment, updated every 20 seconds.
        </li>
        <li>
          <strong>Or send people with a link.</strong> Make a link code in the
          portal and put it in your <Link href="#link-codes">pay and swap links</Link>{" "}
          as <code>p=</code>. Payments, cash outs and swaps opened from them are
          counted to you once Gloam has checked them on chain.
        </li>
      </ul>
      <p>
        The portal and its CSV files show where each one came from: via API key,
        via link, or matched on chain (past cash outs to your own receiving
        addresses, <Link href="#matched-on-chain">below</Link>), with the
        vault&apos;s own cash-out fee on each.
      </p>

      <h2>What you can charge, and why</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Payment</th>
              <th>Your fee</th>
              <th>Limit</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Private payment</td>
              <td>Flat, per payment</td>
              <td>$0.00 to $1.00</td>
              <td>The amount is hidden from everyone, the relay included, so a share of it cannot be worked out.</td>
            </tr>
            <tr>
              <td>Cash out</td>
              <td>Share of the amount</td>
              <td>0% to 1%</td>
              <td>The token and amount leaving the vault are public on chain.</td>
            </tr>
            <tr>
              <td>Deposit</td>
              <td>Share of the amount</td>
              <td>0% to 1%</td>
              <td>The token and amount entering the vault are public too.</td>
            </tr>
            <tr>
              <td>Private swap</td>
              <td>None</td>
              <td>No setting</td>
              <td>Counted to you with its input token and amount, which are public on chain, but there is no partner fee on swaps.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Fees are in the token the user moved, paid to your payout address on that
        network. A payment message (the encrypted heads-up after a private
        payment) carries no fee. A change to your setting applies to new payments;
        earlier ones keep the fee they were counted with.
      </p>

      <h2>Partner fees: not charged yet</h2>
      <p>
        Gloam runs on {liveMainnetNames()} mainnet, and on the testnets.
        On every network, the portal records what your key brought in and the fee
        your setting would have earned, and every figure is labeled that way. No
        partner fee is taken from anyone, and every API response says{" "}
        <code>&quot;charged&quot;: false</code>.
      </p>
      <p>
        Gloam&apos;s own fee is separate. On mainnet a cash out costs 0.5%, kept
        by the vault; direct deposits and private payments are free. Your partner fee is
        not added on top of that yet.
      </p>
      <p>
        Taking a partner fee for real needs a fee output inside the
        zero-knowledge circuits and the vault contract, so the fee is part of the
        proof and nobody can skip or change it. The mainnet pools do not have
        that yet (see the <Link href="/docs/production">production gate</Link>).
        Until then, a dashboard figure is an attribution count, not money owed.
      </p>
      <p>
        USD figures use $1 for dollar stablecoins and the live ETH price at the time of the
        payment. EURC (a euro stablecoin) and stock tokens are counted but not valued.
      </p>

      <h2>Authentication and limits</h2>
      <p>
        Send the key in the <code>Authorization</code> header on every call except
        the index at <code>GET /api/v1</code>. Live keys (<code>gloam_live_</code>)
        work on the mainnets; test keys (<code>gloam_test_</code>) on the testnets.
        Keep the key on your server: the API sends no CORS headers, so browsers on
        other sites cannot call it.
      </p>
      <pre>
        <code>{`curl https://gloam.trade/api/v1/me \\
  -H "Authorization: Bearer $GLOAM_API_KEY"`}</code>
      </pre>
      <p>
        Each key gets 300 requests a minute across every endpoint. Responses carry{" "}
        <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code> and{" "}
        <code>X-RateLimit-Reset</code> (unix seconds); a 429 adds{" "}
        <code>Retry-After</code>. The relay also keeps its own per-sender and
        per-network caps, and an hourly limit on the gas it pays, of which one
        sender may use a share. Your partner account is the sender, so all your
        keys count together. Until Gloam approves your account, the IP you call
        from counts as a sender too.
      </p>
      <p>
        Payment messages sent with a key share a small hourly budget on each
        network with every other partner&apos;s keys, the same size as the budget
        for messages sent without a key (60 an hour on Ethereum). Once Gloam
        approves your account, your keys use the larger one. Ask us when you
        need it. One IP can make three new partner accounts a day.
      </p>

      <h2>Responses and errors</h2>
      <p>
        Every response is JSON in the same envelope, with{" "}
        <code>Cache-Control: no-store</code> and a <code>Gloam-Api-Version: 1</code>{" "}
        header. Quote the <code>requestId</code> when you ask us about a call.
      </p>
      <pre>
        <code>{`// success
{ "v": 1, "ok": true, "data": { ... }, "requestId": "req_5e0c2a91d4b7f310" }

// failure
{ "v": 1, "ok": false,
  "error": { "code": "invalid_key", "message": "This API key is not valid. It may have been revoked or rotated." },
  "requestId": "req_9b3f..." }`}</code>
      </pre>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {ERRORS.map(([code, status, meaning]) => (
              <tr key={code}>
                <td>
                  <code>{code}</code>
                </td>
                <td>{status}</td>
                <td>{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Relay a payment</h2>
      <p>
        <code>POST /api/v1/relay</code> takes the same body as the app&apos;s own
        relay. It screens, dry-runs and submits exactly as the app does, then
        counts the payment to you. The proof is the authorization and a cash
        out&apos;s recipient is fixed inside it, so the relay can only submit or
        refuse a payment, never redirect it.
      </p>
      <pre>
        <code>{`# a live key on mainnet (4663, 4217), a test key on testnet (46630, 42431)

# a private payment (transfer): counted as a private payment, flat fee
curl https://gloam.trade/api/v1/relay \\
  -H "Authorization: Bearer $GLOAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 4663,
    "action": "transfer",
    "proof": "0x...", "root": "0x...", "nullifier": "0x...",
    "commitments": ["0x...", "0x..."]
  }'

# a cash out (unshield): counted with its public token and amount
  -d '{ "chainId": 4217, "action": "unshield", "proof": "0x...", "root": "0x...",
        "nullifier": "0x...", "asset": "0x20c0...", "to": "0xRecipient", "amount": "250000000" }'

# a payment message (memo, on testnet): relayed, not counted
  -d '{ "chainId": 46630, "action": "memo", "paymentCommitment": "0x...", "memo": "0x..." }'`}</code>
      </pre>
      <pre>
        <code>{`{
  "v": 1, "ok": true,
  "data": {
    "hash": "0x9c1e...",
    "chainId": 4663, "network": "robinhood-mainnet", "action": "transfer",
    "attribution": {
      "recorded": true,
      "kind": "private_payment",
      "activity": {
        "id": "act_...", "kind": "private_payment", "network": "robinhood-mainnet",
        "txHash": "0x9c1e...", "ts": 1791302400000,
        "asset": null, "amount": null, "volumeUsd": null,
        "feeUsd": 0.05, "feeToken": null, "feeBasis": "$0.05 per private payment"
      }
    },
    "charged": false
  },
  "requestId": "req_..."
}`}</code>
      </pre>
      <p>
        The hash comes back as soon as the transaction is sent; wait for the
        receipt yourself. <code>attribution.recorded</code> is false with a reason
        (<code>not_billable</code> for memos) when nothing was counted; a payment
        that was sent is never failed over accounting. <code>GET /api/v1/relay</code>{" "}
        says which networks the relay can submit on right now.
      </p>

      <h2 id="swaps">Private swaps</h2>
      <p>
        A private swap spends one note from the private balance, buys the other
        asset on a public DEX, and lands it back in the vault as a new note, all
        in one transaction the relay sends. It hides who swapped. The tokens and
        the amounts are public, like any trade on that DEX. Swaps are live on
        mainnet, on the networks <code>GET /api/v1/swaps</code> lists.
      </p>
      <p>
        <code>POST /api/v1/relay</code> takes a swap with{" "}
        <code>&quot;action&quot;: &quot;swap&quot;</code> and the same body as the
        app&apos;s relay. The note&apos;s unshield proof pays a one-time escrow
        address worked out from the new note, a refund note and the route, so the
        relay can only send the swap as proved or refuse it. Keep both new notes
        (the new note and the refund note) before you send: if the swap cannot
        land, the refund note, and on the newest routers the exit key made from
        it, are how the money comes back.
      </p>
      <pre>
        <code>{`# a private swap: counted to you with its input token and amount, no partner fee
curl https://gloam.trade/api/v1/relay \
  -H "Authorization: Bearer $GLOAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 4663,
    "action": "swap",
    "router": "0x...",
    "spend":   { "proof": "0x...", "root": "0x...", "nullifier": "0x...", "asset": "0x...", "amount": "100000000" },
    "deposit": { "proof": "0x...", "commitment": "0x...", "asset": "0x...", "amount": "..." },
    "refund":  { "proof": "0x...", "commitment": "0x...", "asset": "0x...", "amount": "..." },
    "route": [ { "currency0": "0x...", "currency1": "0x...", "fee": 500, "tickSpacing": 10, "hooks": "0x..." } ],
    "exitKey": "0x...", "deadline": "1793000000"
  }'

# a refund: the same call, with the refund note's proof and the transaction
# that paid the escrow; relayed, not counted
  -d '{ "chainId": 4663, "action": "swap", ..., "unshieldTx": "0x..." }'

# an exit (newest routers): the escrow's money to the address the exit key signed for; relayed, not counted
  -d '{ "chainId": 4663, "action": "swapExit", "router": "0x...", "asset": "0x...",
        "key": { "nullifier": "0x...", "amountIn": "...", "outCommitment": "0x...", "assetOut": "0x...",
                 "amountOut": "...", "refundCommitment": "0x...", "refundAmount": "...",
                 "routeHash": "0x...", "exitKey": "0x...", "deadline": "..." },
        "to": "0xYourWallet", "signature": "0x...", "unshieldTx": "0x..." }'`}</code>
      </pre>
      <p>
        A swap is counted to you as <code>private_swap</code>, with its input
        token and amount, which the chain shows, and no partner fee. Whether it is
        a new swap is read from the vault just before it is sent: a note that is
        already spent can only take the refund path, and a refund or an exit is
        sent but not counted. Its transaction is still claimed for you, so no one
        can count it later as a deposit or a swap. Nothing is charged.
      </p>
      <p>
        <code>GET /api/v1/swaps</code> lists each network&apos;s swaps: whether they
        are live, the router new swaps use, what it swaps between, and the earlier
        routers the relay keeps for refunds of swaps made with them.{" "}
        <code>POST /api/v1/swaps/quote</code> prices one, read only, with the
        app&apos;s planning and the swap tab&apos;s stops, plus the SDK&apos;s on every
        chain: price impact over 2% (<code>maxImpactBps</code> sets it, 0 to 10000)
        and two dollar stablecoins more than 2% apart. A live key quotes the
        mainnets and a test key the testnets. Each quote is a few dozen chain
        reads, so it has its own limit: 20 a minute per partner account, all its
        keys together, and 20 per IP. For more, the SDK&apos;s{" "}
        <code>quoteSwap</code> prices the same way from your own RPC.
      </p>
      <pre>
        <code>{`curl https://gloam.trade/api/v1/swaps/quote \
  -H "Authorization: Bearer $GLOAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "network": "robinhood-mainnet", "assetIn": "0x5fc5...d168", "assetOut": "0x0000000000000000000000000000000000000000", "amountIn": "100000000" }'

{
  "v": 1, "ok": true,
  "data": {
    "network": "robinhood-mainnet", "chainId": 4663,
    "router": "0x...", "routerVersion": 2, "venue": "v4",
    "assetIn": "0x5fc5...d168", "assetOut": "0x0000...0000",
    "amountIn": "100000000", "feeBps": 25,
    "available": "99750000", "amountOut": "...", "cost": "...", "leftover": "...",
    "route": [ { ... } ], "hops": 1, "impactBps": 3, "pegBps": null,
    "warnings": [],
    "stop": null,
    "limits": { "maxIn": "...", "outRoom": "..." },
    "relay": { "enabled": true, "gasHigh": false }, "floorUsd": null,
    "stops": { "maxImpactBps": 200, "maxPegGapBps": 200 },
    "valueChecked": false,
    "deadlineSeconds": 1800, "quotedAt": 1793000000000, "ttlMs": 15000,
    "public": "A private swap hides who swapped. The tokens and the amounts are public, like any trade on the DEX it goes through."
  },
  "requestId": "req_..."
}`}</code>
      </pre>
      <p>
        <code>amountIn</code> is the value of the note the swap spends, in base
        units, as a string. <code>stop</code> is the first thing that would keep
        the swap from going, or null: <code>too_thin</code> and{" "}
        <code>over_room</code> come with <code>fitsIn</code>, about the most that
        would pass; <code>refund_wont_fit</code> with <code>maxIn</code>, the most
        one swap can spend so its refund note fits the vault&apos;s limit (split
        the note first); <code>swap_small</code> with <code>floorUsd</code>, the
        smallest swap the relay sends right now where gas is dear. The others are{" "}
        <code>no_route</code>, <code>too_small</code>, <code>off_peg</code>,{" "}
        <code>no_fill</code>, <code>price_moving</code>, <code>impact_unknown</code>,{" "}
        <code>vault_closed</code>,{" "}
        <code>relay_off</code>, <code>gas_high</code> and the reads that failed.
        Pass <code>&quot;via&quot;: &quot;wallet&quot;</code> for a swap you send
        yourself, which skips the relay&apos;s own stops. Market prices are not
        compared here (<code>valueChecked: false</code>): the app&apos;s swap tab
        does that with marks from off chain.
      </p>

      <h2>Count a deposit</h2>
      <p>
        Deposits come from the user&apos;s own wallet, not the relay, so your app
        reports them: <code>POST /api/v1/deposits</code> with the transaction hash.
        The server reads the transaction from the chain. It must be a successful
        deposit into Gloam&apos;s vault, at most 24 hours old, and not already
        counted to anyone; the first partner to report it gets it. A swap&apos;s new
        note and a refund note go in through a swap router, so they are never
        anyone&apos;s deposit.
      </p>
      <pre>
        <code>{`curl https://gloam.trade/api/v1/deposits \\
  -H "Authorization: Bearer $GLOAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "chainId": 4663, "txHash": "0x..." }'

# 201: { "v": 1, "ok": true, "data": { "activity": { "kind": "deposit", "symbol": "USDG", "amount": "250000000", ... }, "charged": false } }`}</code>
      </pre>

      <h2>Your volume and fees</h2>
      <p>
        <code>GET /api/v1/activity?limit=50</code> returns what the portal shows:
        totals, counts by kind and network, public volume and would-be fees by
        token, the last 14 days, and up to 200 recent payments.
      </p>
      <pre>
        <code>{`{
  "totals": { "privatePayments": 128, "cashOuts": 9, "deposits": 4, "privateSwaps": 3,
              "publicVolumeUsd": 5210.5, "swapVolumeUsd": 300, "commissionUsd": 19.43, "unpriced": 0 },
  "byNetwork": { "robinhood": { "private_payment": 90, ... }, "tempo": { ... } },
  "byAsset": [ { "symbol": "USDG", "network": "robinhood", "volume": "4210.5", "commission": "8.42" } ],
  "daily": [ { "day": "2026-10-06", "privatePayments": 12, "cashOuts": 1, "deposits": 0, "swaps": 1,
               "volumeUsd": 250, "commissionUsd": 1.23 } ],
  "recent": [ ... ],
  "fees": { "privatePaymentCents": 5, "cashoutBps": 25, "depositBps": 0 },
  "charged": false
}`}</code>
      </pre>

      <h2>Vaults and the leaf list</h2>
      <p>
        <code>GET /api/v1/vaults</code> (or one network:{" "}
        <code>/vaults/robinhood-mainnet</code>, <code>/vaults/tempo-mainnet</code>,{" "}
        {mainnetPool(8453) ? <><code>/vaults/base-mainnet</code>, </> : null}
        {mainnetPool(1) ? <><code>/vaults/ethereum-mainnet</code>, </> : null}
        <code>/vaults/robinhood</code>, <code>/vaults/tempo</code>,{" "}
        <code>/vaults/base</code> (Base Sepolia) or{" "}
        <code>/vaults/ethereum</code> (Ethereum Sepolia)) gives each
        network&apos;s vault address, the
        tokens it takes, whether the relay is up, and a fresh read of the tree size
        and root, plus <code>leafCapacity</code> and <code>leavesLeft</code> for
        how much room the note tree has.
      </p>
      <p>
        <code>GET /api/v1/vaults/&#123;network&#125;/leaves</code> is the vault&apos;s
        public leaf list: every commitment in order, with its leaf index, block and
        transaction. Rebuild the Merkle tree from it and check the root with the
        pool&apos;s <code>isKnownRoot</code> before you prove against it; the SDK&apos;s{" "}
        <code>syncTree</code> does the same from the chain.
      </p>
      <pre>
        <code>{`curl https://gloam.trade/api/v1/vaults/tempo-mainnet \\
  -H "Authorization: Bearer $GLOAM_API_KEY"

# data.vault: { "network": "tempo-mainnet", "chainId": 4217, "pool": "0x...",
#   "assets": [ { "symbol": "USDC.e", ... } ], "relay": { "enabled": true, ... },
#   "chain": { "block": "37...", "leafCount": 412, "root": "0x..." } }`}</code>
      </pre>

      <h2>Check a proof</h2>
      <p>
        <code>POST /api/v1/proofs/verify</code> checks a proof of funds (
        <code>gloamfunds1:</code>), proof of payment (<code>gloampay1:</code>),
        payroll total (<code>gloamroll1:</code>) or exact balance (
        <code>gloambal1:</code>) on the server, with the same checks the{" "}
        <Link href="/verify">/verify</Link> page runs: the zero-knowledge proof, who
        it was made for, that it points at Gloam&apos;s own vault, that its plain
        fields match, and the live chain checks. <code>ok</code> is true only when
        every check passes and the proof has not expired. <code>network</code> names
        the chain the proof was made on; check <code>network.testnet</code> before
        you rely on it, since a testnet proof passes every check with test funds.
      </p>
      <pre>
        <code>{`curl https://gloam.trade/api/v1/proofs/verify \\
  -H "Authorization: Bearer $GLOAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "proof": "gloamfunds1:eyJ2IjoxLCJraW5kIjoi..." }'

# data: { "format": "gloamfunds1", "kind": "funds", "ok": true, "expired": false,
#   "checks": [ { "label": "The proof checks out", "state": "pass", ... },
#               { "label": "Made for \\"Acme Bank\\"", "state": "pass", ... }, ... ],
#   "claims": { "chainId": 4663, "asset": "0x5fc5...", "threshold": "1000000000", ... },
#   "network": { "chainId": 4663, "key": "robinhood-mainnet", "name": "Robinhood Chain", "testnet": false } }`}</code>
      </pre>

      <h2>Payment request links</h2>
      <p>
        <code>POST /api/v1/payment-requests</code> makes a link that opens Pay in the
        Gloam app with the details filled in. The details ride after the{" "}
        <code>#</code>, so the payer&apos;s browser never sends them to a server.
        This endpoint builds the link and keeps nothing; you can also build the same
        link yourself (see <Link href="/docs/private-pay">private pay</Link>).
      </p>
      <pre>
        <code>{`curl https://gloam.trade/api/v1/payment-requests \\
  -H "Authorization: Bearer $GLOAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "to": "gloamr1.AbC...", "network": "robinhood-mainnet", "asset": "USDG",
        "amount": "1250", "note": "Invoice 042", "name": "Acme",
        "partnerCode": "<your link code>" }'

# 201: data.url = "https://gloam.trade/app/vault?tab=move&mode=pay#to=gloamr1...&amount=1250&asset=0x5fc5...&p=<your link code>"`}</code>
      </pre>
      <p>
        <code>partnerCode</code> is optional: one of your account&apos;s live link
        codes, added as <code>p=</code> so the payment counts to you. Built by
        hand, the same link to a wallet looks like this:
      </p>
      <pre>
        <code>{`https://gloam.trade/app/vault?tab=move&mode=pay#to=0x...&amount=25&asset=USDG&chain=robinhood-mainnet&name=Motion&p=<your link code>`}</code>
      </pre>

      <h2 id="swap-link">Trade privately with one link</h2>
      <p>
        A trading app can add a &quot;Trade privately with Gloam&quot; button that
        opens the Swap tab with the swap filled in. It works like a payment
        request link: it only fills in the form. Nothing swaps on its own. The
        person checks the live quote and taps Swap privately. No API key is
        needed.
      </p>
      <pre>
        <code>{`https://gloam.trade/app/vault?tab=swap#from=<token>&to=<token>&amount=<amount>&chain=<network>&p=<your link code>`}</code>
      </pre>
      <ul>
        <li>
          <code>from</code>: the token to pay with, by symbol or address on that
          network. <code>to</code>: the token to get, the same way.
        </li>
        <li>
          <code>amount</code>: optional, in whole tokens of <code>from</code>{" "}
          (<code>100</code> is 100 USDG), not base units.
        </li>
        <li>
          <code>chain</code>: the same network keys as a payment request link.
          Private swaps run on{" "}
          {SWAP_NETWORKS.map((k, i) => (
            <span key={k}>
              {i > 0 ? (i === SWAP_NETWORKS.length - 1 ? " and " : ", ") : ""}
              <code>{k}</code>
            </span>
          ))}{" "}
          now. A network without private swaps fills in nothing.
        </li>
        <li>
          <code>p</code>: your <Link href="#link-codes">link code</Link>. With a
          live one, the person sees &quot;From Motion&quot; with the name from your
          Gloam account, and the swap counts to you once it lands.
        </li>
        <li>
          <code>ref</code>: optional, a name for a link with no code, shown as
          what the link says. It counts for nothing. Up to {SWAP_REF_MAX}{" "}
          characters and {SWAP_REF_WORDS} words: letters, digits, spaces and{" "}
          <code>. &amp; &apos; _ -</code>. A web address, markup or a name with
          Gloam in it is left out.
        </li>
      </ul>
      <p>
        Only tokens the swap router lists on that network can be swapped. They
        are in <Link href="/docs/private-swaps#pairs">what you can swap</Link>,
        and <code>GET /api/v1/swaps</code> lists them by address. Any other
        token is left out, and the person is told why.
      </p>
      <p>
        For example, Motion sending someone to buy TSLA with 100 USDG on
        Robinhood Chain:
      </p>
      <pre>
        <code>{`https://gloam.trade/app/vault?tab=swap#from=USDG&to=TSLA&amount=100&chain=robinhood-mainnet&p=<Motion's link code>

# the same with addresses
https://gloam.trade/app/vault?tab=swap#from=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&to=0x322F0929c4625eD5bAd873c95208D54E1c003b2d&amount=100&chain=robinhood-mainnet&p=<Motion's link code>`}</code>
      </pre>
      <p>
        The person sees &quot;From Motion&quot; and &quot;Swap 100 USDG for
        TSLA&quot; above the swap, with the live quote and every check the Swap
        tab makes: price impact, the vault&apos;s limits and the relay. If they
        are not signed in, they sign in and the swap stays filled in. With no
        private USDG, or too little, it offers Add USDG privately and Bring money
        over, and keeps the swap ready in that tab while they do.
      </p>
      <p>
        A swap hides who swapped, not the tokens or the amounts. The Gloam relay
        sends it, so the person&apos;s wallet never shows, while the two tokens
        and the two amounts are public, like any trade on that DEX. Keep the
        fields after the <code>#</code>: browsers never send that part to a
        server.
      </p>

      <h2 id="link-codes">Link codes: count what your links bring in</h2>
      <p>
        A link code is how Gloam knows a payment or a swap came from your link. It
        is 20 random letters and digits that Gloam makes and keeps, mapped to your
        partner account. A name in a link (<code>name</code>, <code>ref</code>)
        is whatever its maker typed, so it never counts; only a live code does.
      </p>
      <ul>
        <li>
          <strong>Get one</strong> in the portal under Link codes, or ask us and we
          issue one to your account. One code can go in every link you make. Label
          it, and revoke it any time: links with a revoked or expired code still
          open, but nothing from them counts from then on. What they counted stays.
        </li>
        <li>
          <strong>Use it</strong> as <code>p=&lt;code&gt;</code> after the{" "}
          <code>#</code> of a <Link href="#swap-link">swap link</Link> or a{" "}
          <Link href="/docs/private-pay">pay link</Link>.
        </li>
        <li>
          <strong>Your name in links.</strong> Once Gloam approves your
          account&apos;s name, people who open your links see &quot;From Motion&quot;
          with a Gloam partner mark. A name is a plain name: letters A to Z,
          digits and spaces, no Gloam, no web address, at most 32 characters and
          4 words. A rename shows only once
          Gloam approves it again. Until then links show no partner name, and still
          count to you. To ask, message{" "}
          <a href="https://x.com/gloamtrade">@gloamtrade on X</a> from your
          project&apos;s account.
        </li>
        <li>
          <strong>Through the Gloam relay</strong> (the default for payments and
          cash outs, and the only way for swaps): the payer&apos;s app hands your
          code to the relay with the proof. Once the relay has checked the payment
          and dry-run it, just before it goes out, the relay ties your code to that
          exact payment: the note it spends, the root and what it pays out, whatever
          proof carries them. Once sent, it ties your code to the transaction&apos;s
          hash, and counts the transaction once it lands. A request the relay turns
          down ties nothing, and one that then surely didn&apos;t go out is untied.
          A cash out the relay sends later keeps your code with its job, and counts
          only for the transaction the relay sends for that job.
          <br />
          The rule for a transaction the relay sent: it counts to the first code
          tied to that exact payment before its block, otherwise to the code the
          relay sent it with, otherwise to nobody. A wallet registration never
          counts for it. So a code goes with a payment only if the relay was asked
          to send that very payment with it, before it landed: a copy of a landed
          proof ties nothing, another spend of the same note (other outputs, other
          root) never inherits a code, and a payment from your link that failed on
          chain and was sent again with another code stays yours. On Ethereum and
          Base, where pending calldata is public, the relay ties by the
          transaction&apos;s hash only.
        </li>
        <li>
          <strong>From the payer&apos;s own wallet:</strong> before the wallet is
          asked, the app registers the payment with your code and a one-way hash of
          something only that send has: a private payment&apos;s new note
          commitment, or a cash out&apos;s proof. The transaction counts only if it
          carries that value and the registration came before its block&apos;s
          second began. Knowing the payment in advance is not enough to register
          it. If two different codes register the same payment in time, it counts
          for neither; a registration made too late plays no part. A registration
          that matches no transaction is gone after an hour. A payment sent from a
          wallet in the same second as its block doesn&apos;t count; that is the
          price of the rule. Gloam takes wallet registrations only where a
          transaction can&apos;t be read before its block (Robinhood Chain, Tempo
          and their testnets). On Ethereum and Base, where pending transactions
          are public early, only payments sent through the relay count to links.
          {ELYSIUM ? " Elysium counts the same way for now, until it is checked that its sequencer shows nothing early." : ""}
        </li>
        <li>
          <strong>What counts:</strong> Gloam reads each transaction on its chain
          and counts it only if it is a real action in Gloam&apos;s vault that fits
          the link: a private payment or a cash out to a wallet for a pay link, a
          private swap through Gloam&apos;s router for a swap link. A transaction
          counts once, for one partner, within seven days of landing. A transaction
          that landed can&apos;t be tied to a code afterwards: a relay-sent one
          counts only from the ties the relay made when it sent it, and a
          wallet registration counts only if it was made before anyone could read
          the transaction. One exception: a payment whose transaction failed on
          chain can be sent again by anyone holding its proof. Sent again through
          the relay, it counts to the first code tied to that payment, which is the
          resender&apos;s if the failed send had none (on Ethereum and Base{ELYSIUM ? " and Elysium" : ""}, always
          the resender&apos;s).
        </li>
        <li>
          <strong>What is kept:</strong> the transaction&apos;s public facts only:
          hash, chain, kind, token, amount, the vault&apos;s fee, time, and you.
          Never the payer&apos;s wallet, their IP, the address a cash out paid, or
          anything else that ties a person to your link beyond the public
          transaction. A private payment has no token or amount to keep.
        </li>
        <li>
          <strong>What you see:</strong> your cash outs, deposits and swaps one by
          one, with their transaction, network, token, amount, time and the link
          code they came through, since those are public on chain anyway. Private
          payments only as a count per day, and only for days that have ended
          (UTC), in the portal, its CSV files and the API alike: never one by one,
          never with a hash, an amount, a time or the code they came through, and
          never in &quot;last activity&quot;. So a payment can&apos;t be tied to an
          invoice or a moment, even if you make one code per invoice.
        </li>
        <li>
          <strong>Nothing is charged,</strong> the same as for your API key.
        </li>
      </ul>

      <h3 id="fee-split-grade">Which figures could carry a fee split</h3>
      <p>
        Fee-split grade, because the partner&apos;s side is proven: API-key counts
        (your key sent or reported the transaction), relay-bound link counts (the
        relay sent that very transaction, and yours was the first code tied to its
        payment), and matched-on-chain
        counts (the cash out paid an address that signed for you). Attribution
        grade: link counts the payer&apos;s own wallet registered. They are bound to
        the payment before it is sent, so nobody else can claim them, but the
        payer&apos;s app chooses the code. The dashboards and the transactions CSV
        show which is which (&quot;by wallet&quot;, &quot;Link bound by&quot;).
      </p>
      <p>
        The limits, plainly. A code is not a secret: it is in every link you
        share, so anyone can pay through it, you included, and a payer can choose
        a code for their own payment. Gloam can&apos;t see which link a person
        opened, only that the payment was tied to a code before it was sent. A
        payment that failed on chain and was sent again counts as described above.
        Mainnet and testnet are counted apart, and testnet is never valued in
        dollars.
      </p>
      <p>
        A count that was missed when the transaction landed (the app was closed,
        the relay&apos;s own step ran out of time) is made later by the
        app&apos;s count call, which finds the same ties, or for a cash out by
        the on-chain match below. If the relay stopped right after sending, before
        tying the transaction&apos;s hash: on Robinhood Chain and Tempo the tie to
        the payment, kept an hour, still lets the app&apos;s count call, or for a
        cash out the on-chain match, count it within that hour; a payment or a
        swap comes back only through the app&apos;s count call; on Ethereum and
        Base that link count is lost, and so is a scheduled cash out&apos;s on any
        chain.
      </p>
      <p>
        Counting is the Gloam app&apos;s and the relay&apos;s job, not yours. The
        endpoints the app calls are <code>POST /api/partners/register</code>, which
        takes <code>{`{ chainId, nullifierHash, bindHash, code, flow: "pay" }`}</code>,
        and <code>POST /api/partners/attribute</code>, which takes{" "}
        <code>{`{ chainId, txHash }`}</code>. They take only requests whose Origin
        is gloam.trade. That stops other websites from calling them from a
        visitor&apos;s browser; it does not stop a script, which can send any
        Origin. What stops a script from claiming a payment is the tie above,
        made before the payment exists.
      </p>

      <h2 id="matched-on-chain">Matched on chain: past cash outs</h2>
      <p>
        For what came before your links, send us your own receiving addresses per
        mainnet. Each address proves it is yours by signing a short message
        (EIP-191) that names you, the chain and the date; we send you the
        messages. Gloam reads every mainnet vault&apos;s cash outs from the day it
        deployed and counts the ones that paid one of your proven addresses,
        shown as &quot;matched on chain&quot;. A cash out to your address counts
        to you even if it was opened from another partner&apos;s link; one sent
        with an API key stays with that key&apos;s partner. Only your addresses
        and their signatures are kept, nothing about who sent the money. A
        transaction is never counted twice.
      </p>
      <p>
        Past private payments can&apos;t be matched: inside the vault the payee and
        the amount are hidden, from Gloam too. Swaps can&apos;t either: a
        swap&apos;s output goes back into the vault as a private balance, not to
        an address. Only cash outs to your public addresses can be found this way.
      </p>

      <h2>Public figures</h2>
      <p>
        <code>GET /api/v1/stats</code> returns what{" "}
        <Link href="/transparency">/transparency</Link> shows for each network: what
        the vault holds, and counts of deposits, private transfers, cash outs and
        payment messages. Aggregates only, cached about a minute.
      </p>

      <h2>With the SDK</h2>
      <p>
        <code>GloamApiClient</code> in <code>@gloamtrade/sdk</code> wraps every
        endpoint, unwraps the envelope and throws <code>GloamApiError</code> with the
        code, status and request id.
      </p>
      <pre>
        <code>{`import { GloamApiClient, settleGloamPayment, buildSwapIntent, sendSwap } from "@gloamtrade/sdk";

const gloam = new GloamApiClient({ apiKey: process.env.GLOAM_API_KEY! });

await gloam.me();                                   // test the key
const { hash, attribution } = await gloam.relay(sendIntent);
await gloam.attributeDeposit({ chainId: 4663, txHash });
const report = await gloam.verifyProof(proofText);
const { url } = await gloam.paymentRequest({ to, asset: "USDG", amount: "25" });

// x402 sellers: sweep received payments through the relay with your key
await settleGloamPayment({ ...params, submit: gloam.submitter() });

// private swaps: quote, prove locally, keep the recovery record, send with your key
const quote = await gloam.swapQuote({ chainId: 4663, assetIn, assetOut, amountIn });
const intent = await buildSwapIntent({ client, chainId: 4663, note, path, assetOut, shieldProver, unshieldProver });
await sendSwap({ intent, client, save: keepRecord, submit: gloam.swapSubmitter() });`}</code>
      </pre>

      <h2>What is recorded</h2>
      <ul>
        <li>
          <strong>Per payment:</strong> network, kind, transaction hash, time,
          where it came from (your key, your link code, or matched on chain), and
          the fee your setting gave it.
        </li>
        <li>
          <strong>Only for deposits, cash outs and private swaps:</strong> the
          token and amount (for a swap, what went in) and the vault&apos;s own
          cash-out fee on it, which the chain already shows.
        </li>
        <li>
          <strong>Never:</strong> notes, secrets, balances, private amounts, who
          received a private payment, a payer&apos;s wallet or IP, or the address
          a cash out paid. Your API key is never stored, only its keyed
          fingerprint.
        </li>
      </ul>
    </DocsLayout>
  );
}
