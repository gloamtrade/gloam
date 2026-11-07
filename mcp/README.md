# @gloamtrade/mcp

Private stablecoin payments for AI agents on Tempo, Robinhood Chain, Base and Ethereum, powered by [`@gloamtrade/sdk`](../packages/sdk). The agent pays x402 and MPP resources, holds a shielded balance and gets paid, within spending limits it cannot lift: off-chain limits this server checks, and on Tempo an access key whose cap the protocol enforces.

Live on mainnet on Tempo (`4217`) and Robinhood Chain (`4663`) since 21 October 2026, and on Base (`8453`) and Ethereum (`1`) since 26 October 2026 (from 0.6.1). Elysium mainnet support is coming (`elysium-mainnet`, gas in HYPE), in a release that has its values. Robinhood gives agents an MCP server for **public** trading. Gloam gives them one for **private** payments, so who an agent pays, and how much, stays off the public chain.

## Mainnet or testnet

Every tool that touches a chain takes a `network`:

| `network` | What it is | Assets | Keys |
| --- | --- | --- | --- |
| `tempo-mainnet` | Tempo mainnet | USDC.e, pathUSD, USDT0, OUSD | Final ceremony keys |
| `robinhood-mainnet` | Robinhood Chain mainnet | USDG, GLOAM, PONS, CASHCAT, ETH, AI, ORBIO; GRIFT once its timelocked limit lands | Final ceremony keys |
| `base-mainnet` | Base mainnet | USDC, EURC, USDT, ETH | Final ceremony keys |
| `ethereum-mainnet` | Ethereum mainnet | USDC, USDT, USDG, PYUSD, EURC, ETH | Final ceremony keys |
| `tempo` | Tempo testnet (Moderato) | PathUSD and other test stablecoins | Dev keys |
| `robinhood` | Robinhood Chain testnet | Test ETH, test USDG | Dev keys |
| `base` | Base Sepolia | Test USDC, EURC, ETH | Final ceremony keys |
| `ethereum` | Ethereum Sepolia | Test USDC, USDG, PYUSD, EURC, ETH | Final ceremony keys |

`GLOAM_NETWORK` sets the network a tool uses when the agent names none. Unset, it is `robinhood` (testnet), as in earlier versions, so an existing setup never moves to mainnet by itself. For mainnet, set `GLOAM_NETWORK=tempo-mainnet` (or `robinhood-mainnet`, `base-mainnet` or `ethereum-mainnet`) and give the agent mainnet limits (see [Mainnet assets in limits](#mainnet-assets-in-limits)). A price an agent pays names its own network, and the server pays there only if that network is one it has a pool for.

On mainnet:

- **Payments, swaps, deposit limits.** On the mainnet pools this server makes deposits, private payments and sweeps, and private swaps on the mainnets with a swap router (see [Private swaps](#private-swaps)). A deposit is at most 50,000 of a stablecoin (20 ETH on Base and Ethereum, 2,500,000 GLOAM), checked before anything is proved; private payments are never limited.
- **Fees.** Deposits and private payments are free. Cashing out costs 0.5% (this server does not cash out; use the Gloam app or the SDK).
- **Final keys.** Proofs for mainnet use the final keys of the 13-contributor trusted setup, downloaded from `https://www.gloam.trade/circuits/final` and checked against the SHA-256 the SDK pins. Testnet proofs use the dev keys. The two are cached apart.
- **Review status.** The contracts and circuits were reviewed internally before launch with no Critical or High findings open, and an independent review on 23 October found no new exploitable contract flaw (fixes in the app areas it named were merged by 24 October). Kann Audits reviewed the vault contracts (report, 1 November 2026: [gloam.trade/security](https://gloam.trade/security)) and found no Critical, High or Medium issues; the routers, circuits, app, relay, this server and the SDK were not part of it. The mainnet pools are new, so the crowd of notes to hide among is small at first.
- **Pools come with the version.** A mainnet appears here once the SDK this package ships with has its pool. If `GLOAM_NETWORK` names a mainnet this version lacks, the server stops at startup and says so.
- **Your own RPC.** `GLOAM_RPC_URL_4217`, `GLOAM_RPC_URL_4663`, `GLOAM_RPC_URL_8453` and `GLOAM_RPC_URL_1` point Tempo, Robinhood Chain, Base and Ethereum mainnet at another RPC (any chain id works the same way).

**Base.** `GLOAM_NETWORK=base-mainnet` runs on Base mainnet (`8453`: USDC, EURC, USDT and ETH), live since 26 October 2026, and `GLOAM_NETWORK=base` on Base Sepolia (`84532`): test USDC, EURC and ETH on the mainnet pool and final keys. Base mainnet's deposit limits are 50,000 per stablecoin and 20 ETH per deposit, Base Sepolia's are 500 per stablecoin and 0.2 ETH per deposit. Both have a payment-message board.

**Ethereum.** `GLOAM_NETWORK=ethereum-mainnet` runs on Ethereum mainnet (`1`: USDC, USDT, USDG, PYUSD, EURC and ETH, 50,000 per stablecoin and 20 ETH per deposit), live since 26 October 2026. Its testnet is Ethereum Sepolia (`ethereum`), below. Gas costs more there: the Gloam relay waits while Ethereum gas is above its ceiling (3 gwei by default) and answers `gas_high`. A USDT shield clears an old USDT approval first, since Tether's token refuses to change one non-zero approval into another. `GLOAM_RPC_URL_1` points it at your own RPC.
**Ethereum Sepolia.** `GLOAM_NETWORK=ethereum` runs on Ethereum Sepolia (`11155111`: test USDC, USDG, PYUSD, EURC and ETH on the mainnet pool and final keys). `GLOAM_RPC_URL_11155111` points it at your own RPC.

## Install

One command per client. The server speaks MCP over stdio and needs Node.js 20 or newer.

```bash
claude mcp add gloam -- npx -y @gloamtrade/mcp          # Claude Code
codex mcp add gloam -- npx -y @gloamtrade/mcp           # Codex
code --add-mcp '{"name":"gloam","command":"npx","args":["-y","@gloamtrade/mcp"]}'   # VS Code
```

Any other client (Claude Desktop, Cursor, Gemini CLI, Windsurf):

```json
{ "mcpServers": { "gloam": { "command": "npx", "args": ["-y", "@gloamtrade/mcp"] } } }
```

As a plugin, with the skills that teach the agent to use it safely: `claude plugin marketplace add gloamtrade/gloam-plugins`, then `claude plugin install gloam@gloam` (Codex and Cursor too, see [integrations/plugins](../integrations/plugins)).

Nothing to install: paste `https://www.gloam.trade/mcp` into Claude (Settings, Connectors, Add custom connector), ChatGPT, Cursor or any client that connects by URL. That hosted server only reads and plans (networks, vault stats, payment request links, proof checks, MPP how-to) and never takes a key; to sign and pay, run this one.

With no settings the server reads and plans and never signs. To let the agent spend, give it a key and limits in `~/.gloam/agent.env`. The safest way, on Tempo, is an access key the owner's wallet caps onchain:

```bash
npx -y @gloamtrade/mcp authorize-access-key --network tempo-mainnet --owner 0xYOUR_TEMPO_ACCOUNT --generate --limit 10 --period 1d --expires 30d
```

That makes the agent's key, saves it with matching off-chain limits and `GLOAM_NETWORK=tempo-mainnet`, and prints what the owner signs. To practice first with test funds, use `--network tempo`. See [Onchain limits with a Tempo access key](#onchain-limits-with-a-tempo-access-key).

### Settings

The server reads its environment, then `~/.gloam/agent.env` (or the file in `GLOAM_ENV_FILE`). The environment wins, and only `GLOAM_*` lines are read from the file. Keep keys in that file (mode 600), not in an MCP client config. `npx -y @gloamtrade/mcp --help` lists the main settings.

| Setting | Meaning |
| --- | --- |
| `GLOAM_NETWORK` | Default network for tools: `tempo-mainnet`, `robinhood-mainnet`, `base-mainnet`, `ethereum-mainnet` (mainnet; `elysium-mainnet` is coming), `tempo`, `robinhood`, `base` or `ethereum` (testnet; `elysium`, Elysium testnet, is coming). Default `robinhood`. A mainnet here also puts the Tempo access key on Tempo mainnet |
| `GLOAM_AGENT_PRIVATE_KEY` | The agent's key. Without it the execute tools return plans |
| `GLOAM_TEMPO_ACCOUNT` | The owner's Tempo account. With it, the key is a Tempo access key acting for that account |
| `GLOAM_TEMPO_FEE_TOKEN` | Token to pay Tempo fees in, in access-key mode. Default: the protocol's choice |
| `GLOAM_NOTE_KEY` | Note store key (see [Notes stay in the server](#notes-stay-in-the-server)) |
| `GLOAM_LIMIT_*`, `GLOAM_LIMITS_FILE` | Off-chain spending limits (see [Spending limits](#spending-limits)) |
| `GLOAM_ENV_FILE` | Where the settings file is. Default `~/.gloam/agent.env` |
| `GLOAM_RPC_URL_<chainId>` | Another RPC for one network, e.g. `GLOAM_RPC_URL_4217` for Tempo mainnet |
| `GLOAM_MPP_SECRET_KEY` (or `MPP_SECRET_KEY`) | Key that binds the MPP challenges this server issues (at least 32 characters; the same key an mppx server uses). Default: derived from the note store key |

## Tools

| Tool | Type | What it does |
| --- | --- | --- |
| `gloam_info` | read | What Gloam is, its networks, and what the agent can do |
| `gloam_privacy_status` | read | Honest posture: what is public, what is private, mainnet limits and fees, how thin the anonymity set is |
| `gloam_swap_quote` | read | Price a private swap of one note's value, with everything that would stop it (see [Private swaps](#private-swaps)) |
| `gloam_execute_private_swap` | execute | **Real private swap.** Proves locally and sends through the Gloam relay; both new notes are kept first |
| `gloam_finish_swap` | execute | Settle a swap whose money waits at its escrow: the refund note, or an exit to an address you name |
| `gloam_plan_shield` | plan | Describe a shield before executing (no signing) |
| `gloam_execute_shield` | execute | **Real private deposit** on the chosen network. Mints a note, generates the Groth16 proof server-side with that network's keys, broadcasts `shieldBound()`, and returns a note handle |
| `gloam_execute_transfer` | execute | Public transfer of test ETH on Robinhood Chain testnet (funding while practicing). Amount and recipient are visible |
| `gloam_list_notes` | read | This server's notes as handles (network, asset, amount, status, creating tx) and the private balance per asset. `refresh` checks pending notes on chain |
| `gloam_receive_tag` | read | This server's receive tag (`gloamr1.…`), for others to pay it. Created on first use |
| `gloam_payment_requirements` | server | Price an agent resource in a private payment; returns the x402 requirements and the MPP challenge (`mpp.wwwAuthenticate`). `payTo` defaults to this server's receive tag |
| `gloam_pay_x402` | agent | Plan the private payment that satisfies a 402 challenge (x402 or MPP) |
| `gloam_execute_private_pay` | execute | **Real private payment** from a note handle: sync, prove, broadcast `transfer()`, keep the change. Returns the `X-PAYMENT` header, or for an MPP challenge the `Authorization: Payment` credential |
| `gloam_fetch_paid` | execute | Fetch a URL; on a Gloam 402 (MPP method `gloam`, or x402), pay privately and retry, all inside the server. Returns the response and, for MPP, the decoded `Payment-Receipt`. Also pays x402 `gloam-cashout` (a public payee on Robinhood Chain) with a cash out through the relay; needs `maxAmount` |
| `gloam_verify_payment` | server | Open a presented payment (x402 or MPP) with this server's receive key, verify it, sweep it into a fresh note, and say whether to grant access |
| `gloam_get_limits` | read | This agent's spending limits: tools, assets, per payment, per day, recipients, expiry |
| `gloam_get_spending_report` | read | Spent and left in the last 24 hours per asset, recent payments, refused attempts |
| `gloam_retry_veya_receipts` | execute | Offered with VEYA receipts on: see where a payment's receipt stands (it is built after the payment's answer), or retry one that failed. Pays nothing |

`gloam_execute_shield` is the private-execution rail: the agent ends up with a shielded balance only this server can spend. The agent sees a note handle such as `n-k3x9p2qw7m`, never the note's secret. When no signer is configured, every execute tool returns a plan instead of acting, and we never return a fake private fill.

The x402 tools are private agent payments (the MCPay pattern, but the settlement is private). `gloam_payment_requirements` prices a resource to the payee's receive tag. The paying agent calls `gloam_execute_private_pay` (or `gloam_fetch_paid` for the whole request), which settles a private send and seals the payment note to that tag, so only the payee can open it. The payee calls `gloam_verify_payment`, which opens the note, checks it binds the required amount and asset, and sweeps it into a fresh note before saying `grantAccess: true`. Unlike a Tempo Zone, no operator sees the transaction: it is private from the public and self-custodial, with an optional per-payment issuer-scoped compliance disclosure. See `TEMPO_EXPANSION.md`.

Scheme `gloam-cashout` is for gateways that pay out to a public address (a creator's splitter) in USDG on Robinhood Chain. `gloam_fetch_paid` pays it with a cash out of exactly the quoted amount from this server's notes to that address, through the Gloam relay, splitting a larger note privately first, and retries with `X-PAYMENT` = base64 JSON `{ scheme, txHash, quoteId }`. The payee and the amount are public; this server's wallet and balance are not. It needs `maxAmount`, and the same quote asked again is presented, never paid twice. With `gloam-private` offered too, `gloam-private` is paid unless `prefer` says `gloam-cashout`.

## Private swaps

A private swap takes one note out of the vault through a one-time escrow, trades it on a public DEX, and puts the result back as a new note, in one transaction the Gloam relay sends. It hides who swapped. The tokens and the amounts are public, like any trade on that DEX. The planning and the proofs are the SDK's, the same as the Gloam app's; the checks are listed below.

| Tool | What it does |
| --- | --- |
| `gloam_swap_quote` | Read only. The price of swapping `amount` of `from` into `to` (or a note's whole value, with `note`), the vault's fee read live, the route, and anything that would stop it (below) |
| `gloam_execute_private_swap` | Proves the swap here and sends it through the relay. Never from this server's wallet, which would put the wallet next to the swap on the explorer |
| `gloam_finish_swap` | For a swap whose money waits at its escrow: brings it back as the refund note, or sends it to a `to` address when the refund note can't take it |

- **One whole note.** A swap spends one note. With an `amount` below a note's value, the server first splits the note with a private send to its own notes (the amount and the change), waits for it, then swaps the note of the right size. Notes are never combined.
- **What stops a swap, on every network.** Price impact over the owner's cap: 2% unless `GLOAM_SWAP_MAX_IMPACT_BPS` says otherwise (in basis points, 0 to 10000). An agent's `maxImpactBps` can lower it for one swap, never raise it. Two dollar stablecoins more than 2% apart. A refund note the vault couldn't take back, an output the vault doesn't take or has no room for, the relay off or over its gas ceiling, and on Ethereum a swap under the relay's smallest. Not checked: the price against the market, which the Gloam app's swap tab also weighs with prices from outside the chain; this server passes none.
- **Limits.** A swap goes through the spending limits on the value it spends, and only when the owner lists `swap` in `tools` (`GLOAM_LIMIT_TOOLS=pay,swap`, or `"tools": [..., "swap"]` in the limits file). What it buys is limited too: one of `swapTo` when the owner sets it (`GLOAM_LIMIT_SWAP_TO=GLOAM,ETH`, or `"swapTo": ["GLOAM"]` in the file, symbols or 0x addresses), else one of the agent's own `assets`. An exit pays a public address, so it goes through the limits too, recipients included, but its amount is not counted again: the swap already counted it.
- **Where.** Only on a network with a swap router: Robinhood Chain and Tempo mainnet today, Base and Ethereum once their routers are switched on. Elsewhere the tools say swaps aren't live there, and swaps are not on Elysium yet when its support (coming) is in.
- **The relay.** `GLOAM_RELAY_URL` names a relay; unset, it is Gloam's. Swaps always go through a relay, whatever `GLOAM_USE_RELAY` says, so they need the note store (`GLOAM_NOTE_KEY`, or one derived from `GLOAM_AGENT_PRIVATE_KEY`) but no gas in the agent's wallet.
- **Getting money back.** Before anything is sent, the server keeps both notes the swap makes: the new note, and a refund note that also holds the swap's exit key. One of them lands. If the swapped note's unshield is ever sent on its own, its money waits at the swap's escrow: `gloam_list_notes` with `refresh` says so, and `gloam_finish_swap` brings it back as the refund note. If the refund note can't take it (the vault's fee rose, or the vault has no room for it now), the exit sends it to an address you name (on routers with an exit). A swap the relay refused leaves the note spendable again, and the refund note stays kept until that note is spent. The same holds for the split before a swap and for a payment: once the relay (or the wallet's RPC) has seen a send's proof, the notes it would make are kept, marked dead, and come back if it lands after all. A swap that went out and reverted or ran out of time leaves its proof public and valid until the note is spent, so the server moves the note whole to a fresh note of its own right away (a private send through the relay); until that move lands the note is held, no tool spends it, and `gloam_list_notes` with `refresh` tries the move again.

## Notes stay in the server

A private balance is a note, and whoever knows a note's secret can spend it. So the secrets never go to the agent. They live in an encrypted file inside this server, and the tools hand out handles plus facts that are not secret: network, asset, amount, status (`unspent`, `pending`, `spent`) and the transaction that created the note.

- `gloam_execute_shield` stores the minted note before anything is broadcast, then marks it unspent once the deposit confirms. If the deposit never goes out, the note is dropped.
- `gloam_execute_private_pay` takes a handle (or picks the smallest note that covers the price), reserves it so no other call can spend it at the same time, and stores the change as a new note. On success the input is marked spent. If nothing was broadcast, the input is spendable again. If a transaction went out but its result is unknown (a receipt that never came, or a broadcast whose reply was lost), the input, the change and the payment stay pending until `gloam_list_notes` with `refresh` settles them, and the spend counts against the limits.
- A payment spends one note. Notes are not combined, so a balance split across small notes may not cover one large payment.

| Setting | Meaning |
| --- | --- |
| `GLOAM_NOTE_KEY` | 32 random bytes in hex (`openssl rand -hex 32`). The store key. Recommended, and required for a server with no signer |
| (unset) | The store key is derived from `GLOAM_AGENT_PRIVATE_KEY` with HKDF-SHA256 under a Gloam note-store label, so it is never the signing key itself |
| `GLOAM_NOTE_STORE` | Where the store lives. Default `~/.gloam/notes.<agent>.json` |
| `GLOAM_EXPOSE_NOTE_SECRETS=1` | **Unsafe, legacy only.** Brings back the old behavior: shield and pay return note secrets, pay accepts `noteSecret`, and a `payTo` that is not a receive tag is paid with an unsealed note. Off by default. Read once at startup |

The store is AES-256-GCM over the whole file (amounts and counts are hidden too), bound to the agent id, written with mode `0600` under the same kind of lock as the spending log. A store that does not decrypt is never overwritten, since it holds the only copy of the money: fix the key or move the file. Back it up together with its key. Changing `GLOAM_NOTE_KEY`, or the signer when the key is derived, makes an existing store unreadable until the old key is back.

## Getting paid: sweep before you serve

In x402 the payer builds the payment note, so the payer knows its secret too. If a server served right after checking the payment, the payer could spend the note back before the server moved it. `gloam_verify_payment` closes that gap:

1. It opens the sealed note with this server's receive key (a note sealed to anyone else does not open).
2. It checks the note binds the required amount and asset, is the payment output of the presented transfer, and sits in Gloam's pool on that network (requirements naming any other pool are refused).
3. It sweeps the note: a private transfer of the whole amount into a fresh note only this server knows. The fresh note is stored before the sweep is sent.
4. Only when the sweep confirms does it return `grantAccess: true`. If the payer already spent the note, the sweep cannot land and the answer is `already_spent`. The same header presented twice gets `already_settled`.
5. If the sweep has not confirmed yet, the answer is `unconfirmed`. Present the same payment again: once the sweep is on chain it answers `grantAccess: true`, once. A sweep that never reached the node (unknown to it ten minutes on, with the payment still unspent) is sent again.

The sweep is signed by `GLOAM_AGENT_PRIVATE_KEY`, or sent through the Gloam relay with `GLOAM_USE_RELAY=1` (or `GLOAM_RELAY_URL`), so a payee needs no gas and its wallet never appears. With neither, the answer is `verified_not_final` and `grantAccess: false`. The sweep is not a spend under the limits: it can only move money this server just received into a note this server holds.

## MPP (Machine Payments Protocol)

The payment tools also speak [MPP](https://mpp.dev): `402` with `WWW-Authenticate: Payment …`, a retry with `Authorization: Payment …`, and a `Payment-Receipt`. Gloam is an MPP payment method, `gloam` with intent `charge` ([spec draft](../docs/mpp/draft-gloam-charge-00.md), library [`@gloamtrade/mppx-gloam`](../packages/mppx-gloam) for mppx servers and clients). The settlement is the same private send as x402, so spending limits, the note store and the sweep work exactly as above.

- **Paying.** `gloam_fetch_paid` reads `WWW-Authenticate`; when it offers `method="gloam"` it pays that (it is preferred over x402 when both are offered), retries with the credential in the field the challenge selects, and returns the decoded receipt. `gloam_execute_private_pay` takes the challenge (the `WWW-Authenticate` value) as `requirements` and returns `authorization`. This server pays in push mode (it broadcasts its own transfer); a challenge that only accepts pull, or with less than 30 seconds left, is refused before anything is proved.
- **Getting paid.** `gloam_payment_requirements` returns `mpp.wwwAuthenticate` next to the x402 requirements: an HMAC-bound challenge, valid for 10 minutes by default (`expiresInSeconds`). Pass the presented `Authorization` value to `gloam_verify_payment` as `payment`, and the price of the resource you are serving as `requirements` (the `WWW-Authenticate` value you issued, or the encoded requirements). Both are required. It checks that this server issued the challenge, that its price matches `requirements`, that it has not expired, that the credential is bound to that challenge, and that the payment note is the payment output of a `Transferred` event in Gloam's pool; then it sweeps as above. For a pull credential (the payer hands over its proven transfer instead of broadcasting it) it submits the transfer first. On `grantAccess: true`, serve with `paymentReceipt` as the `Payment-Receipt` header.

## Check before paying (Agent Wormhole)

A 402 is text the payee wrote, and the agent reads it before it pays. With `GLOAM_WORMHOLE_KEY` set, `gloam_execute_private_pay` and `gloam_fetch_paid` send each payment request to [Agent Wormhole](https://agentwormhole.com)'s check (`POST https://dashboard.agentwormhole.com/api/v1/check`) after the spending limits pass and before anything is proved. Only an `allow` pays.

- **Off by default.** No key, no call. Set it in `~/.gloam/agent.env` or the environment: `GLOAM_WORMHOLE_KEY=<your key>`.
- **What it sees.** The payment request only, as `{"content": ...}`: the decoded price, followed for `gloam_fetch_paid` by the 402 body the price came in. Never a note, a balance, the wallet, a key or the payment itself.
- **It fails closed.** `refuse`, `abstain`, any other answer, an `allow` with findings attached, an `allow` that scanned nothing, an HTTP error (402 means the account is out of checks), an unreadable answer (one over 64 KiB counts, and none is asked for compressed), or no answer within 5 seconds: the tool answers `status: "refused"`, `code: "wormhole_refused"`, names the findings by code (never the text they matched), and nothing is spent. The note stays spendable.
- **Attestation.** A paid result carries Agent Wormhole's `attestation` and `signature` under `wormhole`. They are kept for you to check, not verified here yet: Agent Wormhole has not published the canonical form of a `/check` attestation.
- **Settings.** `GLOAM_WORMHOLE_TIMEOUT_MS` (default 5000, 500 to 30000). `GLOAM_WORMHOLE_URL` points somewhere else (it must be https, or http on localhost); a key with an unusable URL refuses every payment rather than quietly turning the check off.

## Check the budget before paying (VEYA)

A Gloam note is spent with a proof, so wallet rules can't stop a payment. A budget only holds before the payment, on the server that keeps the notes. With `GLOAM_VEYA_KEY` set, `gloam_execute_private_pay` and `gloam_fetch_paid` ask [VEYA](https://veyanet.tech) whether this agent's budget covers the payment, after the spending limits and Agent Wormhole pass and before anything is proved. Only an exact `allow` pays.

- **Off by default.** No key, no call. To turn it on, set all three in `~/.gloam/agent.env` or the environment: `GLOAM_VEYA_KEY=<your key>`, `GLOAM_VEYA_URL=https://api.veyanet.tech/guard/v1/check` and `GLOAM_VEYA_AGENT_ID=<an id you choose>`.
- **What VEYA covers.** USDG on Robinhood Chain (`chain_id` 4663). A payment on another chain or in another asset is refused (`wrong_chain`, `asset_not_allowed`), so with the check on, this server pays only in USDG on Robinhood Chain. A new agent id gets its budget on its first check, 5 USDG as of 1 November 2026.
- **What VEYA sees.** With this on, VEYA sees the agent id, the chain, the asset, the amount and the payee's receive tag during the check, and nothing else: `{"agent_id", "chain_id", "asset", "amount", "payee", "resource_host": null}`. `amount` is base units as a decimal string. `chain_id` is how VEYA tells its chain. `resource_host` is always `null`, and no payment request text is sent, so VEYA learns nothing about what was bought. Never a note, a secret, a balance, a wallet or a key. Agent Wormhole, if on, still gets the payment request as before. What VEYA keeps after the check is VEYA's to say; this server can't limit it.
- **The agent id is opaque.** Pick any id that means nothing outside your setup. A value with a wallet address in it is refused, so a wallet never goes out as the id.
- **It fails closed.** Only a `200` with `{"decision": "allow"}` pays. `refuse`, any other answer, any other status, a redirect, an unreadable answer (one over 64 KiB counts, and none is asked for compressed), no answer within 5 seconds, or a missing or unusable setting: the tool answers `status: "refused"`, `code: "veya_refused"`, the spend is settled as failed, and nothing is spent. The note stays spendable. VEYA answers every check with a `200`, including its own `timeout` and `internal_error`, and those are refuses like any other.
- **Nothing at or below zero.** A price of zero or less is refused (`bad_amount`) before the spending limits and both checks, with the limits on or off, so it never reaches VEYA.
- **If VEYA wants more fields.** A `bad_request` refuse, or HTTP `400` or `422`, means VEYA could not use the check as sent. It refuses the payment like any other answer, with a message that names the fields sent, and the server never retries with more. If that happens, VEYA's format has changed and this server needs an update.
- **Both checks on.** Agent Wormhole goes first, then VEYA, and both must allow. A request Agent Wormhole refuses never reaches VEYA.
- **VEYA's reason.** A `reason` is untrusted text. Before the agent or the spending log sees it, it is stripped to letters, digits and `_.:-` and cut to 40 characters. VEYA's reasons are short codes, which come through as written: `unauthorized`, `bad_request`, `wrong_chain`, `asset_not_allowed`, `unknown_agent`, `agent_limit`, `budget_exceeded`, `timeout` and `internal_error`.
- **This server enforces it, off-chain.** The vault does not know about this check. It binds the agent only while the notes and the key are held by this server and nowhere else: anything else holding them can spend without asking VEYA.
- **Payments only.** VEYA checks `gloam_execute_private_pay` and `gloam_fetch_paid`. These skip it and go through the spending limits only: `gloam_execute_transfer` (a public send of test ETH on Robinhood Chain testnet), and a private swap and a swap's exit to an address (`gloam_finish_swap` with `to`), which run only when the owner lists `swap` in `tools`. Leave `swap` out if every private spend must pass VEYA.
- **A payment can fail after an allow.** VEYA is not told how a payment ended. If the proof, the send or the note fails after an allow, VEYA's running budget may sit ahead of what was really paid, and paying again is checked as a new payment. Compare with `gloam_get_spending_report` if the numbers matter.
- **Settings.** `GLOAM_VEYA_TIMEOUT_MS` (default 5000, 500 to 30000). `GLOAM_VEYA_URL` must be https, or http on localhost; a key with an unusable URL or agent id refuses every payment rather than quietly turning the check off.

### The receipt after a payment

VEYA's allow carries a check id (`attestation`). With `GLOAM_VEYA_ANCHOR_URL=https://api.veyanet.tech/guard/v1/anchor` set as well, this server proves each payment once it lands, with that id as the receipt's verifier, hashes the proof into one `bytes32` leaf, and sends VEYA the leaf. VEYA writes it to `storeCommitment` on `Veya.sol`, so you need no anchoring wallet. [`examples/veya-receipt`](../examples/veya-receipt) shows the leaf.

- **Off by default.** No `GLOAM_VEYA_ANCHOR_URL`, no receipt. It must be https, or http on localhost, on the same origin (scheme, host and port) as `GLOAM_VEYA_URL`, since the key goes to both. An unusable one refuses every payment rather than quietly turning receipts off.
- **What VEYA gets.** `{"leaf": "0x…", "agent_id": "…"}` with the same key as the check, and nothing else: never the record, the proof, the amount, the payee, a note or the transaction hash. VEYA can't open a leaf.
- **The check id.** Letters, digits and `_.:-`, at most 80 characters, with no wallet address in it. It is sealed into the proof as written, so it is checked, not cleaned.
- **How a leaf is tied to its check.** The id goes in before anything is hashed: it is the receipt's verifier, sealed into the proof's `context`, and `context` is one of the public signals the leaf hashes. So a different check id makes a different leaf. VEYA can't read the id back out of a leaf. Anyone holding the record can confirm it with `checkPaymentReceipt`.
- **What the write shows.** VEYA writes every receipt leaf with `storeCommitment(bytes16,bytes32)` under one fixed `bytes16`, `0xf390fb03d4d038add3736706029cbdd0`, the first 16 bytes of `keccak256("veya.guard.receipt-leaves.v1")`. It marks the entry as a receipt leaf, and it is the same for every agent.
- **No usable id, no payment.** With receipts on, an allow without a usable id does not pay: the tool answers `veya_refused`, decision `unchecked`, and nothing is spent. A payment can't be undone, and without the id it could never get its receipt. VEYA's running budget may already count that allow. With receipts off the id is optional, and a bad one is ignored.
- **It never holds up or changes the payment.** The payment's answer, with its `X-PAYMENT` header or MPP credential, comes back as soon as the payment lands, with `veya.receipt.status` `pending`, and the receipt is built and anchored after it. A challenge can't expire while a proof runs, so the agent is never pushed to pay twice. The work goes on in this server: keep it running until the receipt is done. On Robinhood Chain mainnet, reading the vault's tree alone took about 92 seconds on 1 November 2026.
- **Seeing where a receipt stands.** `gloam_retry_veya_receipts` returns each receipt's `status`, `leaf`, `anchorTx`, `checkId`, `note` and a `message`, waiting at most 30 seconds (`GLOAM_VEYA_RECEIPT_TIMEOUT_MS`, 500 to 30000) on work still going. `anchored` means VEYA answered 200 naming this leaf and a transaction, given as `anchorTx`; this server does not read the chain to confirm the write, so look that transaction up if it matters. `anchor_failed` means the receipt is built and kept, and the leaf is in the result. `receipt_failed` means there is no leaf yet.
- **A leaf goes out only once it is saved.** The record is written to the note store before its leaf is sent. If the store can't take it (another process holding it, a disk error), the leaf is not sent and the receipt reads `receipt_failed`, so a retry can never anchor a second, different leaf for the same payment.
- **The anchor takes seconds, and is safe to repeat.** VEYA writes to chain before it answers, which has taken 5.6 to 10 seconds, so the anchor has its own timeout, `GLOAM_VEYA_ANCHOR_TIMEOUT_MS` (default 20000, 500 to 30000). VEYA writes a leaf once: the same leaf again answers the first transaction with `duplicate: true`, and that also reads as `anchored`.
- **When the anchor can't finish.** `409` (the leaf is still being written), `502` and `503` (the chain write is not available) go again with the same leaf, up to three tries, then read as `anchor_failed`. `400`, `401`, `403` (`agent_limit`) and `404` (`unknown_agent`) are sent once, since sending them again would get the same answer, and the message says what is wrong. The leaf is kept either way, for `gloam_retry_veya_receipts`.
- **Retrying.** `gloam_retry_veya_receipts`, offered only with receipts on, builds a missing receipt and sends its leaf. It pays nothing and does not ask for a new check. It sends the same leaf again after an `anchor_failed`, and never sends one VEYA took. While a receipt is still being worked on, a retry joins that work instead of starting a second. For a payment that landed with no answer, call `gloam_list_notes` with `refresh` first.
- **What a receipt proves.** That a payment of at least the record's minimum amount, in its asset, was made into the vault by its transaction, as the payment and not the change, and that the proof is tied to VEYA's check id. It does not prove who received the payment, since the payee stays private, or that anything was delivered for it. The leaf on chain shows only that VEYA wrote that leaf; whoever holds the record checks the rest with `checkPaymentReceipt`.
- **The record stays here.** The full record is kept on the payment's note in the encrypted note store. It shows the asset, the minimum amount and the transaction hash, so no tool returns it.
- **Keys.** The receipt circuit's files are fetched and pinned like the others, on the key set that network's verifiers hold: the final keys on mainnet, dev keys on the older testnets.

## Spending limits

An agent that can sign can spend, so every tool that moves money checks the owner's limits first: `gloam_execute_private_pay` and `gloam_fetch_paid` (pay), `gloam_execute_transfer` (send) and `gloam_execute_shield` (shield). A spend that breaks a limit is refused before anything is proved or signed, with a plain reason the agent can act on, for example:

```json
{ "status": "refused", "code": "over_daily",
  "message": "That would bring the last 24 hours to 14 PathUSD, over the limit of 12 PathUSD a day. 2 PathUSD is left right now. More frees up from 2026-10-04T12:00:00.000Z." }
```

**No limits, no spending.** With a signer but no limits configured, every spend is refused. To run without limits on purpose, set `GLOAM_LIMITS=off` (spends are still logged).

### Where the limits are enforced

In two layers.

1. **Off-chain, by this MCP server, before it signs.** These are the limits below. The vault contract does not know about them. They bind the agent as long as its key is held only by this server; anyone who has the key directly is not bound.
2. **Onchain, by Tempo, with an access key.** When the key is a Tempo access key (`GLOAM_TEMPO_ACCOUNT`), the owner's AccountKeychain authorization caps what the key can move out of the owner's account each period, limits what it may call, and sets when it stops working. The protocol checks that on every transaction, so it holds even if this server, its host or the key itself is compromised. See [Onchain limits with a Tempo access key](#onchain-limits-with-a-tempo-access-key).

Use both: the off-chain limits give the agent per-payment caps, recipient lists and readable refusals; the onchain cap is the boundary that does not depend on this server behaving.

### What is protected, and what is not

Protected now:

- **The agent never holds a secret.** Note secrets stay in the server's encrypted store; the agent works with handles. A prompt-injected agent cannot paste a secret it never saw. Tests check that no tool result carries a note secret or a receive key.
- **Payments are sealed to the payee.** The payment note in the `X-PAYMENT` header is encrypted to the payee's receive tag, so the agent, a proxy or a log that sees the header cannot open it. A `payTo` that is not a receive tag is refused.
- **A payer cannot take a payment back.** `gloam_verify_payment` sweeps every payment into a fresh note before it grants access, and refuses when the note was already spent.
- **Limits still gate every spend** before anything is proved or signed, exactly as before.

Not protected:

- **Spending inside the limits.** A tricked agent can still pay an allowed recipient up to its caps. Keep `recipients` narrow and the caps small.
- **The host.** Whoever can read the store and its key (`GLOAM_NOTE_KEY`, or the signer key it is derived from) controls the notes. Treat the store and the key as money, keep the key out of the agent's reach, and back both up.
- **The resources it fetches.** `gloam_fetch_paid` returns the response body to the agent, and that body can carry its own prompt injection. The server will not fetch loopback, private, link-local or cloud-metadata addresses, including through a redirect (`GLOAM_FETCH_ALLOW_PRIVATE=1` lifts this for local testing); a host that changes its DNS answer between the check and the request is not fully covered.
- **A call whose answer never arrived.** A client that gives up on a slow call does not stop it, so a purchase is recorded in the note store before anything is spent. The same call again answers `payment_in_progress` while that payment runs or its outcome is not known, then returns the first answer or presents the first payment (`reused: true`). A retry asks the chain what became of the first send. If it never landed, the retry pays from the same note, so the contract lets only one of the two through however late the first arrives. An MPP challenge is paid once. A fixed x402 price can still be bought again on purpose: once an answer has reached the caller, the same call is a new purchase. A client that stays connected, drops a call without cancelling it, and retries only after it has finished looks like that too, so it pays again. A record goes a day after its payment last changed; naming a `note` makes a call a different purchase before then.
- **A payment whose retry fails.** The header is returned so the agent can present it again with `gloam_fetch_paid` (`paymentHeader`) without paying twice. The payer keeps no copy of the payment note's secret, so a payment the payee never redeems cannot be pulled back.
- **Payers on older versions** may still send an unsealed note. The payee sweeps it the same way, but anyone who saw that header could race the sweep, in which case the payee refuses and the payer has lost it.
- **Legacy mode.** With `GLOAM_EXPOSE_NOTE_SECRETS=1` none of the first two points hold.

### What you can limit

| Limit | Meaning |
| --- | --- |
| `tools` | Which money tools the agent may use: `pay`, `send`, `shield`, `swap`. Default `pay`, `send` and `shield`: `swap` is allowed only when listed |
| `assets` | Which assets it may move. Required, there is no "any" |
| `maxPerPayment` | Cap on a single payment, in the asset's units (e.g. `"5"` is 5 USDC.e) |
| `maxPerDay` | Cap over a rolling 24 hours, so a burst cannot straddle midnight |
| `recipients` | `"any"`, or a list of Gloam receive tags and `0x` addresses. Required. Shields go to the agent's own balance and skip this |
| `expiresAt` | After this the agent cannot spend. `"2026-12-31"` means through the end of that day (UTC); a full ISO timestamp is taken as written |

Assets are named by symbol or by `0x` token address (with `decimals` for a token Gloam does not know). Matching is by network and contract address, never by the symbol a payee writes into a 402 challenge, so a payment cannot slip through by relabeling a token. Private payments must also go through Gloam's own pool on that network.

| Network | Symbols |
| --- | --- |
| `tempo-mainnet` | `USDC.e`, `pathUSD`, `USDT0`, `OUSD` |
| `robinhood-mainnet` | `USDG`, `GLOAM`, `GRIFT`, `PONS`, `CASHCAT`, `AI`, `ORBIO`, `ETH` |
| `tempo` (testnet) | `PathUSD`, `OUSD`, `AlphaUSD`, `BetaUSD`, `ThetaUSD` |
| `robinhood` (testnet) | `ETH`, `USDG` |
| `base-mainnet` | `USDC`, `EURC`, `USDT`, `ETH` |
| `base` (Base Sepolia) | `USDC`, `EURC`, `ETH` |
| `ethereum-mainnet` | `USDC`, `USDT`, `USDG`, `PYUSD`, `EURC`, `ETH` |
| `ethereum` (Ethereum Sepolia) | `USDC`, `USDG`, `PYUSD`, `EURC`, `ETH` |

### Mainnet assets in limits

Mainnet and testnet are different chains, so each limit is for one of them. A symbol on both sides (`USDG`, `pathUSD`, `OUSD`, Base's `USDC`, `EURC` and `ETH`, and `PYUSD`, which Ethereum Sepolia lists too), or a token address on both (pathUSD and OUSD use the same address on Tempo mainnet and testnet), means the **testnet** asset unless the entry names a network. `ETH` or the zero address alone is Robinhood Chain testnet ETH. That way a config written for testnet never starts approving mainnet assets by itself. Mainnet-only symbols (`USDC.e`, `USDT0`, `GLOAM`, `USDT`) and mainnet-only addresses (USDG on Robinhood Chain, USDC on Base, every Ethereum token) name the mainnet asset directly. `USDT` alone is Base's; add `"network": "ethereum-mainnet"` for Ethereum's.

```json
{
  "agents": {
    "research-bot": {
      "recipients": ["gloamr1.MFkwEwYH...their-receive-tag"],
      "assets": {
        "USDC.e": { "maxPerPayment": "2", "maxPerDay": "20" },
        "pathUSD": { "network": "tempo-mainnet", "maxPerPayment": "2", "maxPerDay": "20" }
      }
    }
  }
}
```

With the environment variables, `GLOAM_LIMIT_NETWORK=tempo-mainnet` puts every asset in `GLOAM_LIMIT_ASSETS` on that network.

### Configure with a file (several agents)

Point `GLOAM_LIMITS_FILE` at a JSON file and pick the agent with `GLOAM_AGENT_ID` (default `default`). Each MCP server process runs as one agent. The file is read on every spend, so tightening a limit takes effect on the next call.

```json
{
  "agents": {
    "research-bot": {
      "tools": ["pay"],
      "recipients": ["gloamr1.MFkwEwYH...their-receive-tag"],
      "expiresAt": "2026-12-31",
      "assets": {
        "USDC.e": { "maxPerPayment": "5", "maxPerDay": "50" }
      }
    },
    "ops-agent": {
      "recipients": "any",
      "maxPerPayment": "250",
      "maxPerDay": "1000",
      "assets": {
        "USDG": { "network": "robinhood-mainnet" },
        "USDT0": {}
      }
    },
    "practice-bot": {
      "recipients": "any",
      "maxPerPayment": "5",
      "maxPerDay": "50",
      "assets": ["PathUSD", "USDG"]
    }
  }
}
```

The array form of `assets` uses the agent-level `maxPerPayment` and `maxPerDay` for each asset; the object form can set them per asset, or leave them out to use the agent's (an asset entry may also take `network` and, for an unknown token address, `decimals`). Agent-level caps count in each asset's own units, so they can only cover assets of one kind: the stablecoins together, or one other asset. An agent that may spend ETH or GLOAM next to stablecoins needs caps on that asset's own entry, or `"50"` would mean 50 ETH; a config that mixes them under one number is refused. In the example, `research-bot` and `ops-agent` spend on mainnet and `practice-bot` only on testnet. A config that does not parse, names an unknown asset, or leaves out a cap is treated as no permission: every spend is refused with the reason.

### Configure with environment variables (one agent)

```bash
GLOAM_AGENT_ID=research-bot
GLOAM_LIMIT_ASSETS=USDC.e,pathUSD        # required
GLOAM_LIMIT_NETWORK=tempo-mainnet        # optional: the network of every asset above (else testnet for shared symbols)
GLOAM_LIMIT_MAX_PER_PAYMENT=5            # required, applies to each asset
GLOAM_LIMIT_MAX_PER_DAY=50               # required, applies to each asset
GLOAM_LIMIT_RECIPIENTS=any               # required: any, or a comma list
GLOAM_LIMIT_EXPIRES=2026-12-31           # optional
GLOAM_LIMIT_TOOLS=pay,shield             # optional; add swap to allow private swaps
GLOAM_LIMIT_SWAP_TO=GLOAM,ETH            # optional: what a swap may buy (else the assets above)
GLOAM_SWAP_MAX_IMPACT_BPS=200            # optional: the most price impact a swap may take (default 200, 2%)
```

Use the file or the variables, not both. The variables have one pair of caps for every asset listed, so list one kind of asset there (stablecoins, or a single other asset such as ETH); for ETH next to stablecoins, use the file.

### The spending log

Every spend is written to a local JSON file before it is signed (`~/.gloam/spend-log.<agent>.json`, or `GLOAM_SPEND_LOG`). The check and that reservation happen under a lock, so two calls at once, or two server processes sharing the log, cannot both squeeze under the daily cap. Each entry is then settled as `sent`, `unconfirmed` (broadcast, receipt unknown), `reverted` or `failed`. Pending, sent and unconfirmed count against the limit; failed, reverted and refused do not. Refusals are logged too, so you can see what an agent tried. If the log cannot be read, the agent cannot spend.

`gloam_get_limits` shows the limits as the server sees them, and `gloam_get_spending_report` shows spent and remaining for the last 24 hours, the recent payments and the recent refusals. When there is no signer, the execute tools still return a plan, now with a `limits` preview saying whether it would be allowed.

## Onchain limits with a Tempo access key

Off-chain limits stop an agent that misbehaves through this server. They cannot stop someone who has the key. On Tempo an access key closes that gap. The owner's wallet authorizes the agent's key in Tempo's AccountKeychain precompile (`0xAAAAAAAA00000000000000000000000000000000`) with:

- **an expiry**, after which the key cannot sign;
- **a spending limit per stablecoin** that resets every period (or a one-time total);
- **call scopes**: approve the Gloam pool, and only the pool, as spender of the capped stablecoins, and call `shieldBound` and `transfer` on the pool. Any other call is rejected, and an access key can never deploy a contract.

The server then signs Tempo transactions for the owner's account with that key, and the protocol checks the restrictions on every one. So **the caps hold even if the MCP server is compromised**: whoever holds the key can move at most what is left of the current period's limit out of the owner's account, only into the Gloam pool, and only until the key expires or the owner revokes it. The owner's root key never touches the agent's machine. The off-chain limits stay on as the second layer.

### Set it up

1. Make the key and print what the owner signs. Nothing is signed or sent, and the key is never printed:

   ```bash
   npx -y @gloamtrade/mcp authorize-access-key --network tempo-mainnet --owner 0xOWNER --generate --limit 25 --period 1d --expires 30d
   ```

   `--network` is `tempo-mainnet` (mainnet) or `tempo` (testnet). An access key is authorized on one chain, so a key made on testnet does nothing on mainnet. Left out, it is Tempo mainnet when `GLOAM_NETWORK` names a mainnet, else Tempo testnet. `--generate` writes the new key, `GLOAM_TEMPO_ACCOUNT`, a note-store key and matching off-chain limits to `~/.gloam/agent.env` (mode 600), keeping anything already there; on mainnet it also writes `GLOAM_NETWORK` and `GLOAM_LIMIT_NETWORK`. To authorize a key you already have, use `--key <address>` or leave both out to use `GLOAM_AGENT_PRIVATE_KEY`. `--limit 25` is in the network's default stablecoin (USDC.e on mainnet, PathUSD on testnet); repeat `--limit USDT0=10` for more stablecoins, use `--period once` for a total that never resets, and `--json` for machine-readable output. From a checkout: `pnpm --filter @gloamtrade/mcp authorize-access-key --owner ...`.

2. The owner authorizes it from their own wallet, with one of the three printed options:
   - Tempo Wallet or any Tempo Accounts SDK provider: the printed `wallet_authorizeAccessKey` request (passkey accounts).
   - Foundry: the printed `cast send 0xAAAA... 'authorizeKey(...)' ... --interactive`, signed by the owner's root key.
   - Any wallet that can send a raw call from the owner account: the printed `to` and `data`.

3. **Reset any standing approval of the pool.** If the owner account ever approved the Gloam pool (the Gloam app approves it once, for an unlimited amount), the owner sets it back to 0 with the printed `approve(pool, 0)` command. See below for why.

4. Check it. This only reads the chain:

   ```bash
   npx -y @gloamtrade/mcp authorize-access-key --check --network tempo-mainnet --owner 0xOWNER
   ```

   It reports whether the key is authorized, its expiry, what is left of each limit and when it resets, its call scopes, and any pool allowance the cap would not count. It exits 0 only when all of that is in order.

5. Restart the agent's MCP server. It logs `Signer: Tempo access key 0x... for account 0x...` and, a moment later, the same check.

To change a limit without a new key, the owner calls `updateSpendingLimit(key, token, newLimit)` on the precompile. To stop the agent, the owner revokes the key with the printed `revokeKey` command; a revoked key can never be authorized again.

### What the cap covers, and what it does not

Covers:

- Every approval the key makes for a capped stablecoin (only increases count), and so every shield the agent funds from the owner's account.
- Which contracts and functions the key may call.
- When the key stops working. A revocation applies from the moment the owner's transaction lands.

Does not cover:

- **Allowances the owner already gave.** Tempo counts `transfer`, `transferWithMemo` and `approve` made by the key, not `transferFrom`. With a standing approval of the pool, `shieldBound` can pull up to that allowance without touching the limit. Keep the owner's approval of the pool at 0; `--check` and the startup check report it.
- **Money already in the private balance.** Shielded notes are spent with the note secrets in this server's store, not with the key, so a compromised host can take what is already shielded. The cap bounds how fast money can enter the pool from the owner's account; keep the shielded balance small and the store and its key safe (see [Notes stay in the server](#notes-stay-in-the-server)).
- **Network fees.** Fees for the key's transactions come from the owner account and are not counted against the limit.
- **Robinhood Chain.** It has no keychain. In access-key mode the same key signs there as its own address, bound by the off-chain limits and whatever that address holds.

### In the server

`GLOAM_AGENT_PRIVATE_KEY` is the access key and `GLOAM_TEMPO_ACCOUNT` the owner's account. On Tempo the signer is a viem Tempo access-key account (`Account.fromSecp256k1(key, { access: owner })`): transactions are Tempo transactions from the owner's account carrying a keychain signature by the key. `GLOAM_TEMPO_FEE_TOKEN` picks the fee token. A malformed `GLOAM_TEMPO_ACCOUNT`, or one equal to the key's own address (that would be the account's root key, with no limits), stops the server at startup instead of letting it sign some other way.

## Setup

From npm, there is nothing to build: `npx -y @gloamtrade/mcp` (see [Install](#install)). From a checkout:

```bash
pnpm install                              # from the repo root
pnpm --filter @gloamtrade/mcp start       # tsx src/index.ts, no build needed
pnpm --filter @gloamtrade/mcp build       # dist/index.js, the published server
pnpm --filter @gloamtrade/mcp smoke       # start dist/index.js over stdio and list its tools
```

The Gloam workspace packages (`@gloamtrade/sdk` and others) ship TypeScript source, so the build bundles them into `dist/index.js` with esbuild and leaves every other dependency to npm. It fails if the server imports a package missing from `dependencies`. Publish with pnpm so workspace versions are rewritten: `pnpm --filter @gloamtrade/mcp publish --access public`.

To execute with a raw key instead of an access key (only the off-chain limits bind it), give the server a funded signer, a note-store key and its limits. On Robinhood Chain mainnet, for example:

```bash
GLOAM_NETWORK=robinhood-mainnet \
GLOAM_AGENT_PRIVATE_KEY=0x<key holding a little USDG and ETH for gas> \
GLOAM_NOTE_KEY=$(openssl rand -hex 32) \
GLOAM_LIMIT_ASSETS=USDG GLOAM_LIMIT_NETWORK=robinhood-mainnet \
GLOAM_LIMIT_MAX_PER_PAYMENT=5 GLOAM_LIMIT_MAX_PER_DAY=20 GLOAM_LIMIT_RECIPIENTS=any \
pnpm --filter @gloamtrade/mcp start
```

To practice with test funds instead, use `GLOAM_NETWORK=robinhood`, a key funded from the [Robinhood Chain testnet faucet](https://faucet.testnet.chain.robinhood.com/), and `GLOAM_LIMIT_ASSETS=ETH` with small caps (no `GLOAM_LIMIT_NETWORK`).

The same lines can go in `~/.gloam/agent.env`. Keep the note key somewhere durable (not a fresh `openssl` each start): the store cannot be opened without it. Without the signer the server still runs and exposes every tool; execute tools just return plans. Without limits, execute tools refuse to spend (see above). For a hard boundary use a Tempo access key (above); on other chains a policy wallet such as a Turnkey server wallet plays that role.

Tests (no chain needed): `pnpm --filter @gloamtrade/mcp test` runs the spending limits, the note custody tests (store encryption and locking, shield to pay to sweep over a mock pool, the fetch round trip, the legacy flag, and a scan that no tool result carries a secret), the access key tests (the authorization encoding and scopes, keychain signing for the owner's account, fail-closed settings, the settings file and the CLI) and the mainnet tests (which networks a build offers, mainnet assets in limits, the key set per network).

## Connect an agent

The server speaks MCP over stdio. Point any MCP client at it (Claude Desktop, Cursor, or any platform that reads MCP server configs):

```json
{
  "mcpServers": {
    "gloam": {
      "command": "npx",
      "args": ["-y", "@gloamtrade/mcp"]
    }
  }
}
```

Keys and limits come from `~/.gloam/agent.env`. For several agents on one machine, give each its own file with `"env": { "GLOAM_ENV_FILE": "/home/me/.gloam/research-bot.env" }`, or share a `GLOAM_LIMITS_FILE` and set `GLOAM_AGENT_ID` per agent. To run a checkout instead of the npm package, use `"command": "node", "args": ["/absolute/path/to/gloam/mcp/dist/index.js"]` after a build.

Then the agent can shield into a private balance, pay for x402 and MPP resources privately, and get paid, alongside its public Robinhood activity.

## Status

- **Mainnet:** Tempo, Robinhood Chain, Base and Ethereum (Elysium support is coming), payments only, deposit limits, the trusted setup's final keys. Reviewed internally before launch and independently on 23 October; Kann Audits reviewed the vault contracts (report, 1 November 2026) and found no Critical, High or Medium issues.
- **Testnet:** Tempo Moderato and Robinhood Chain testnet on dev keys; Base Sepolia and Ethereum Sepolia on the final keys.
- **Circuit files** are fetched from `https://www.gloam.trade/circuits` (final keys under `/final`) on first use, checked against pinned SHA-256 and cached locally (`GLOAM_ARTIFACTS_DIR`).
- **Swaps.** Private swaps run here and in the Gloam app where the network has a swap router: who swapped stays private, the tokens and the amounts are public ([docs](https://gloam.trade/docs/private-swaps)). The old sealed trade is retired, and its planning tools are gone.
