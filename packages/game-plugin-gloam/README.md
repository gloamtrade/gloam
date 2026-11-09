# @gloamtrade/game-plugin-gloam

Private stablecoin payments for Virtuals agents, built on the GAME framework.

An agent gets a private balance in Gloam's vault and can pay, get paid, cash
out and prove what it holds, without its payments and balance being public. It
works on Base and Robinhood Chain, the chains Virtuals agents use, under spending
limits its owner sets per asset and the agent cannot lift.

The plugin follows the pattern of the plugins in `game-node/plugins`: a class
with options, one getter per `GameFunction`, and `getWorker()`.

## Networks

| `GLOAM_NETWORK` | Network | Assets |
|---|---|---|
| `base` (default) | Base Sepolia, testnet | USDC, EURC, ETH |
| `robinhood-mainnet` | Robinhood Chain, mainnet | USDG, GLOAM, PONS, CASHCAT; ETH, AI, ORBIO and GRIFT once each limit lands |
| `base-mainnet` | Base, mainnet, once Gloam's Base vault is live | USDC, EURC, USDT, ETH |
| `elysium-mainnet` | Elysium, mainnet: coming, once the SDK has its values (gas in HYPE) | USDC |
| `elysium` | Elysium testnet (99801): coming, once the SDK has its pool (gas in HYPE) | Test USDC |

The same vault address on each: `0x39e28cde55cab798874746ac52cb4b5cc99a0194`.
Mainnet has deposit limits (50,000 of a stablecoin per deposit).

## Install

```bash
pnpm add @gloamtrade/game-plugin-gloam @virtuals-protocol/game
```

## Use

```ts
import { GameAgent } from "@virtuals-protocol/game";
import GloamPlugin from "@gloamtrade/game-plugin-gloam";

const gloam = new GloamPlugin({
  // Or GLOAM_LIMITS_FILE, not both.
  limits: {
    recipients: "any",
    assets: { USDC: { maxPerPayment: "5", maxPerDay: "20" } },
  },
  // Claim links are the money itself: they come to your code, never to the planner.
  onClaimLink: (c) => deliverSomehow(c.link),
});

const agent = new GameAgent(process.env.GAME_API_KEY!, {
  name: "Private Treasurer",
  goal: "Pay suppliers privately and prove funds when asked.",
  description: "Pays and gets paid with Gloam.",
  workers: [gloam.getWorker()],
});
await agent.init();
await agent.run(10, { verbose: true });
```

Environment (the agent's own, never passed through the planner; `env.example`
in the package lists it, named without the leading dot so it ships with the package):

```bash
GLOAM_NETWORK=base                      # or robinhood-mainnet
GLOAM_AGENT_PRIVATE_KEY=0x...           # the wallet that holds public funds and signs deposits
GLOAM_LIMITS_FILE=./limits.example.json # or pass `limits` in code (not both: that is refused)
# GLOAM_RPC_URL=...                     # your own RPC; an API key in it never reaches a message
# GLOAM_NOTE_KEY=...                    # store key; derived from the agent key when unset
# GLOAM_SUBMIT=wallet                   # default relay: the Gloam relay submits private sends
```

`limits.example.json` names USDC and ETH, which the Base Sepolia vault takes.
On `robinhood-mainnet` name USDG instead.

An ACP agent's Privy smart wallet can be the sender instead of a local key:
`new GloamPlugin({ sender: await acpCallSender(evmProvider, chainId) })`.

## Functions

| Function | What it does | Public on chain |
|---|---|---|
| `gloam_private_balance` | Private balance per asset, wallet balance, Gloam address, limits left today | Nothing |
| `gloam_add_privately` | Deposit from the wallet into the private balance | The deposit: wallet, asset, amount |
| `gloam_pay_privately` | Pay a Gloam address (`gloamr1.…`), a payment request link, or by claim link | A shielded transfer only |
| `gloam_receive` | `address`, `request` (a payment request link), `check` (pick up payments sent to it), `claim` (a claim link or a code sealed to the agent) | A shielded transfer only |
| `gloam_cash_out` | Private balance to a 0x address (0.5% fee on mainnet, 0.25% on Base Sepolia) | The exit: asset, amount, recipient |
| `gloam_prove_funds` | A proof it holds at least an amount, for one named reader | Nothing (the proof itself carries the backing notes' nullifiers) |
| `gloam_verify_proof` | Check a `gloamfunds1:` or `gloampay1:` proof against the chain | Nothing |

A payment spends one note, so the most one payment can be is the largest note
(`largestPayment` in the balance). A received payment counts only once it has
been moved into a fresh note only this agent knows.

A cash out to an address where the money would be lost is refused before
anything is split or sent, on the wallet path as well as through the relay: the
vault, the network's payment-message board, a token contract, a Gloam swap
router and the zero address.

The engine is `GloamAgent` (`plugin.agent`), usable without GAME: `add`, `pay`,
`payX402`, `payX402Cashout`, `payByClaimLink`, `requestPayment`, `checkIncoming`, `claim`, `cashOut`,
`proveFunds`, `provePayment`, `verifyProof`, `refresh`. Import it from
`@gloamtrade/game-plugin-gloam/engine` to load no GAME code. Two options are
for agent kits: `noteBackend` keeps the encrypted note store somewhere other
than a local file (it only ever sees ciphertext), and `apiKey` (or
`GLOAM_API_KEY`), a Gloam partner key, sends private payments and cash outs
through the partner relay and attributes deposits, so they count on the partner
dashboard. `payX402(requirements)` pays a Gloam x402 price privately and returns
the `X-PAYMENT` value. `payX402Cashout({ requirement, maxAmount })` pays an x402
price with scheme `gloam-cashout` on Robinhood Chain: it cashes out exactly the
quoted amount of USDG to the price's public `payTo` and returns the
`X-PAYMENT` value (`{ scheme, txHash, quoteId }`, base64 JSON). The payee and
the amount show on chain; the agent's wallet and private balance do not. The
tool pack in
[`examples/agent-kit-tools`](https://github.com/gloamtrade/gloam/tree/main/examples/agent-kit-tools)
is built on it.

What the proofs show:

- A proof of funds (`gloamfunds1:`) does not show the balance. It does carry
  the nullifiers of the notes behind it, so the reader can check they are
  unspent, and a reader who keeps them can tell when those notes are spent later.
  The notes behind it are marked, and a cash out of one first moves it to a
  fresh note with a private send to itself, as the app does, so the proof does
  not lead to where the money went or how much. If that move fails, nothing is
  cashed out. The move and the cash out land close together, so their timing
  can still hint at a link. Proofs made with an earlier version of this plugin
  left no mark: to be safe, pay those notes to the agent's own Gloam address
  (then `checkIncoming`) before cashing them out.
- A proof of payment (`gloampay1:`) shows that a private payment of an amount
  was made into a note, and when. It does not show who received it: the payer
  chose the payee note's key, so the payer could make the same proof. Ask the
  payee to confirm receipt.

## When an answer is lost

A send can go out and its answer never come back: a receipt wait that gives
up, a relay or smart wallet that throws after submitting. The plugin never
forgets a note once a send has started:

- The deposit's note, a payment's change and payment notes, a split's halves,
  a sweep's fresh note are kept as pending, and the note being spent stays
  held. The outcome says `unconfirmed`, with the hash when there is one. GAME
  hears it as done, with an instruction not to send it again and to refresh.
- `refresh()` (or `gloam_private_balance` with `refresh: "true"`) reads the
  chain and settles them: what landed becomes spendable, a payment's sealed
  message is posted to the board then, and a note is dropped only when it can
  never land: its transaction reverted, or the note its spend spends is spent
  while it is not in the vault (both read at one block).
- An unconfirmed payment, claim link sealed to an address, or cash out counts
  against the daily limit, and the same one (payee or address, asset, amount,
  and the caller's label when there is one; never the note, which a planner
  may reword) is refused while it may land. A second payment of the same
  amount to the same payee with no label waits until the first settles; if the
  first then turns out to carry another note, the second is not answered with
  it and nothing is sent (`earlier_payment_landed`: "If this is the same
  payment, it is already paid; ask again only for a different payment"). Asked
  again, it goes out. Each new note records which note its
  spend spends. After an hour with nothing on chain the same payment may be
  sent again, but only from that same note, so at most one of the two can
  land; a cash out keeps its note held for that same cash out. A retry that
  finds the first one landed says so (`alreadyPaid`, `alreadyCashedOut`) and
  sends nothing.
- `cancelPayment(handle)` (owner code) makes a payment whose answer was lost
  an hour ago never land, by spending the note it spends back to the agent; if
  the payment lands first, the cancel reverts and the payment counts.
- A sweep that may still land is not counted as secured: the scan stays on that
  payment, and a sweep with nothing on chain after an hour is tried again.
- A Gloam address is checked to be a real P-256 key, and the payment sealed to
  it, before any money moves.
- A payment message that can never be secured (one anyone could post, worth
  nothing) is recorded as `bad_note` once and skipped after.

## Limits

```json
{
  "recipients": "any",
  "actions": ["add", "pay", "cash_out"],
  "expiresAt": "2026-12-31",
  "assets": {
    "USDC": { "maxPerPayment": "5", "maxPerDay": "20" },
    "ETH": { "maxPerPayment": "0.002", "maxPerDay": "0.01" }
  }
}
```

- Every asset has its own caps, in its own units. A single cap for all assets
  is refused: "50" would mean 50 USDC and 50 ETH.
- Caps cover payments and cash outs over a rolling 24 hours. Adding to its own
  private balance is allowed or not (`actions`), never capped.
- `recipients` is `"any"` or a list of Gloam addresses, 0x addresses (cash outs)
  and `"claim-link"`.
- No limits means nothing moves. The MCP server's limits file
  (`{ "agents": { "<id>": … } }`, keyed by `GLOAM_AGENT_ID`) works too, as long
  as each asset has its own caps.
- Limits in code and `GLOAM_LIMITS_FILE` together are refused (nothing moves),
  so one never silently replaces the other.
- The limits are enforced by this plugin before it signs. The vault contract
  does not know them, so they bind the agent, not whoever holds its key.

## Keys and secrets

- The agent's key comes from its environment. No function takes a key, a note
  or a secret as an argument.
- Notes live in an encrypted file on the agent's machine (AES-256-GCM,
  `~/.gloam/game-notes.<agent>.json`), named to the planner only by handle.
- Every text a function returns, and every log line, is checked for known
  secrets and claim codes before it leaves, also when they are URL-encoded,
  wrapped in base64 or hex, written in decimal, as raw bytes or as a byte
  array; a note package written out as JSON loses its secret even when the
  plugin never saw it. A public RPC URL named in a message is left as is. Errors reach the planner as one short
  line, never with the RPC URL (which may carry an API key) or the request body.
- The GAME planner is Virtuals' hosted LLM: it sees amounts, handles, hashes,
  Gloam addresses and proofs. Balances stay out of the environment it reads
  each step unless you pass `shareBalances: true`.
- `gloam_receive` with `claim` takes `claim_link` from the planner. A plain
  claim link is a bearer secret, and it passes through Virtuals' hosted planner
  on its way in. The safe ways: have payers pay the agent's Gloam address
  (`gloamr1.…`, nothing secret); or have them seal the link to that address and
  pass the sealed code (`gloam2t.…`), which only this agent opens; or claim in
  your own code with `plugin.agent.claim(link)`, outside GAME.

## Test

```bash
pnpm --filter @gloamtrade/game-plugin-gloam test
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org pnpm --filter @gloamtrade/game-plugin-gloam test:fork
```

The fork tests run every flow against the Base Sepolia vault inside a local
anvil fork, with fresh keys funded in the fork, and then the money-safety cases:
a deposit, payment, split and sweep whose answer is lost while the transaction
sits in the mempool, a Gloam address that is not a real key, and a payment
message that can never be secured. They need Foundry's `anvil`.
`GLOAM_FORK_CACHE=<folder>` keeps the vault leaf cache (public data) between runs.
sepolia.base.org answers 200 blocks per log request, so its first vault read
takes about two minutes; the leaf cache makes later reads quick.

## Troubleshooting

- `limits_unset`: pass `limits` or set `GLOAM_LIMITS_FILE`.
- "No single private note holds …": add more privately, or pay less than `largestPayment`.
- "has no Gloam pool in this version": update `@gloamtrade/sdk` (Base mainnet appears once its vault is live).
- A slow first call: the vault tree is being read; it is cached under `~/.gloam/vault-cache`.

MIT licensed.
