# Tempo expansion: design and positioning

Status: **live on Tempo mainnet (`4217`) from 21 October 2026.** Pool
`0x39e28cde55cab798874746ac52cb4b5cc99a0194` (`ShieldPoolPayments`, payments only, deploy block
`45172561`) on the trusted setup's final keys, listing USDC.e, pathUSD,
USDT0 and OUSD with deposit limits (50,000 per deposit, 2,500,000 in total
for each). Direct deposits and private payments are free; a cash out costs 0.5%. It was
reviewed internally before launch, and Kann Audits has since reviewed the vault
contracts (report, 1 November 2026) and found no Critical, High or Medium issues. Tempo Moderato
stays up as the testnet: current pool
`0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb` (redeployed 2026-09-29, block
37411195, no admin withdraw, timelocked rule changes) and memo board
`0x3ca88712e9219b5EE4c82D31cAfEaB64C9E9b4E3`, on dev keys with test funds. Shield
PathUSD and other test stablecoins, private send, cash out, payroll, proofs and
the relay all run there. The sealed trade is off on both, as on Robinhood Chain; private swaps from the private balance are live on Tempo mainnet (`GloamVaultSwapTempo`). The
sections below are the original design, annotated with what shipped (re-checked
2026-10-10).

Gloam started as one product on two chains: the flagship on Robinhood Chain
(tokenized-equity privacy) and an expansion on Tempo (private stablecoin
payments for people and agents). Same shielded-pool protocol, two chain-specific
frames. Base and Ethereum mainnet joined on 26 October 2026, on the same
vault. The runtime network toggle (Phase 0) is already shipped: see
`app/src/lib/networks.ts`, `app/src/components/app/NetworkProvider.tsx`,
`NetworkSelector.tsx`.

Tempo testnet (Moderato): chainId 42431, RPC https://rpc.moderato.tempo.xyz,
explorer https://explore.testnet.tempo.xyz, native currency USD, EVM (Reth).
Mainnet: chainId 4217, RPC https://rpc.tempo.xyz. Verified against
docs.tempo.xyz on 2026-09-07. Mainnet explorer: https://explore.tempo.xyz.

## 1. Why Tempo, and why now

Tempo (Stripe + Paradigm, payments-first EVM L1) states the problem in its own
words: every stablecoin payment leaks the amount, the sender, and the recipient.
That is Gloam's thesis, validated by the chain itself. Stablecoin payments is
also the single most winner-correlated solution tag in the Colosseum corpus
(see the Copilot landscape memo), and Tempo is the chain built for exactly that
asset. Private stablecoin payments on Tempo is the highest-EV frame available.

## 2. Tempo Zones: the lane marker, not the threat

Tempo announced Zones: operator-run private execution environments (parallel
chains anchored to Mainnet). Zones and Gloam are different privacy models for
different users, and Tempo's own writeup draws the line for us.

| Axis | Tempo Zones | Gloam |
| --- | --- | --- |
| Who sees payments | The zone operator sees all (by design, for compliance) | No one; only the user holds the note secret |
| Trust model | Permissioned, operator-run | Permissionless, self-custodial |
| Privacy tech | Private ledger + validity proofs to Mainnet | ZK proofs + anonymity set |
| Target user | Enterprises: payroll, treasury, settlement | Individuals and agents |
| Anonymity set | None (operator knows all) | Yes, the product |
| Agents | Not addressed | Native (MCP server, x402) |

Tempo's blog explicitly frames the ZK / shielded-pool approach as too complex
and not enterprise-compliant, and positions Zones as the enterprise answer. That
is a lane marker: Gloam is the permissionless, self-custodial, agent-native
privacy Zones deliberately is not. We do not compete with Zones for enterprise
payroll. We serve the users Zones cannot: individuals who want self-custodial
privacy with no operator, and agents that transact without leaking a spend
history. Positioning must never claim Tempo "lacks privacy"; it has Zones. Gloam
is a different kind of privacy on the same chain.

## 3. The crux: compliance controls travel with the token

On Tempo, every token natively enforces issuer allowlist / blocklist / freeze,
across all zones, verified cryptographically by Mainnet. A permissionless
shielded pool hides the beneficial holder, which removes the issuer's ability to
freeze or blocklist that holder. So a naive Gloam pool over a compliance-
enforcing Tempo stablecoin is in direct tension with the issuer's requirements.
This is a real design constraint and it gates asset choice.

Resolution, which is also the differentiator (the "compliant privacy" frame that
won for Encifher and Mercantill):

- **Selective disclosure (live on mainnet and testnet).** The older `gloamdisc1` disclosure
  names no party, and anyone can make one for any deposit from public chain
  data, so it is no longer made and never verifies. The newer proof of funds, proof of
  payment and payroll total proofs (`gloamfunds1`, `gloampay1`, `gloamroll1`)
  carry a label naming who they are for and an expiry, bound into the proof and
  verified off-chain at gloam.trade/verify. Next: extend the target set to an
  issuer or auditor scope.
- **Issuer viewing key (new, Tempo-specific; design stub in the SDK, not
  built).** An optional issuer-scoped view
  capability so a regulated stablecoin issuer can satisfy oversight without the
  public seeing anything. This is the bridge between Zones (operator sees all)
  and pure anonymity (no compliance at all): private from the public, self-
  custodial, still issuer-compliant.
- **Freeze compatibility.** A design path where an issuer freeze on Mainnet can
  be honored against shielded notes (e.g., a freeze list checked in-circuit or
  at unshield). Edge checks shipped (TIP-403 policy checked before deposits and
  cash outs); in-circuit freeze lists remain an open design item. See section 7.

Asset strategy given the constraint:

1. Launch on a Tempo asset that does not require issuer holder-level control
   (native USD gas asset behavior, a testnet faucet token, or a non-freezing
   stablecoin) to prove the rails end to end.
2. Add the issuer-viewing-key path so compliance-enforcing stablecoins become
   supportable, and lead the pitch with that (private and compliant).
3. Never silently shield a compliance-enforcing token in a way that breaks its
   issuer controls and hide that from the user. Honesty rule applies.

Shipped: step 1 with PathUSD (6 decimals) and other test stablecoins, plus
TIP-403 edge checks. Step 2 is not built.

## 4. What deployed on Tempo (Phase 1, done)

- **Contracts.** Deployed on Tempo Moderato: the shielded pool,
  DualProofVerifier (unshield + transfer, `0x82F4…03A2`) and the shield verifier
  (`0x7836…6Eb3`), with sealed swaps disabled (H1), same as Robinhood. The
  current pool `0x841D…d5eb` was redeployed 2026-09-29 with no admin withdraw and
  timelocked rule changes; it supersedes `0xeD0b…2276` (2026-09-16) and
  `0x3eeE…D30b`. The memo board `0x3ca8…b4E3` is deployed from the fixed source,
  so its event does not record the poster. Live surface: shield, private send,
  cash out, selective disclosure and proofs, payroll, payment requests, relay.
- **Asset registration.** Tempo blocks native `msg.value`, so the pool shields
  ERC-20 stablecoins only, PathUSD (6 decimals) first. Native USD decimals do not
  affect shields.
- **Deploy block.** Recorded (37411195) and wired into the `tempo` entry in
  `networks.ts`, whose status is `live`.
- **Consumer migration.** Done: components read `useNetwork()`, lib resolvers
  read `getActiveNetwork()`, Tempo is in the wagmi config, and notes are keyed
  by chainId, so each network has its own vault.

## 5. Agent payments: the winning combo, plus privacy

Colosseum evidence: MCPay won 1st in Stablecoins with x402 + MCP + stablecoin
payments; Mercantill won on agent audit trails and controls. Neither has privacy.
The pure agent-privacy frameworks (Aegis, Agent-Cred) shipped no product and
lost. Gloam takes MCPay's winning surface and adds the private settlement and
selective disclosure it lacks:

- Add x402 to the MCP server: an agent hits a 402, pays in stablecoins, Gloam
  settles the payment privately through the pool on Tempo. **Shipped** (SDK
  `settleGloamPayment`, MCP `gloam_fetch_paid` / `gloam_verify_payment`).
- Carry Gloam's encrypted note reference in Tempo's native memo field. **Shipped
  differently:** the sealed payment note travels in the x402 payment header (or
  the MPP credential), not in Tempo's memo field.
- `gloam_execute_private_pay` MCP tool: build a private stablecoin send,
  broadcast, return a disclosure proof the agent can hand an auditor.
  **Shipped** for the send: it broadcasts and returns the payment header and the
  change note; an auditor proof comes from the separate proof tools.

## 6. Positioning lines (honest)

- Protocol: the privacy layer for onchain finance, for people and the agents
  acting for them.
- Tempo: private, self-custodial stablecoin payments. The permissionless
  complement to Zones, with selective disclosure a user can hand an issuer or
  auditor.
- Say "live on Tempo mainnet", with Moderato as the
  testnet. Never say "fully audited": it was reviewed internally, and Kann
  Audits reviewed the vault contracts only. Never claim the sealed trade is live; private
  swaps are live on Tempo mainnet (who swapped stays private, the pair and the amounts are public).

## 7. Open questions and risks

- **Freeze / blocklist enforcement against shielded notes.** Enforce issuer
  controls at the public shield / unshield edges (where tokens actually move),
  keep privacy in the middle. See `contracts/audit/TEMPO-COMPLIANCE-DESIGN.md`.
  Shipped as read-only TIP-403 checks before deposits and cash outs (app,
  `/api/screen`, relay); the token enforces the same policy on-chain regardless.
  An issuer freeze of the pool's own balance would still freeze every note of
  that asset (audit F-2), so a non-freezing asset remains the safe mainnet
  choice.
- **Native USD decimals on Tempo.** Resolved: native `msg.value` is blocked, so
  the pool shields ERC-20 stablecoins only (PathUSD is 6 decimals).
- **World's Fair timing (Sep 14 to Oct 12).** Past: the window closed on 12 October 2026.
- **Do Zones make a public-Mainnet shielded pool redundant in judges' eyes?**
  Mitigate by leading with the self-custodial + permissionless + agent lane and
  the compliance-compatible disclosure, which Zones does not offer.

## 8. Sequence

1. Phase 0 (done): runtime network registry, provider, header selector.
2. Design sign-off on section 3 (compliance reconciliation) and section 7
   (freeze path): edge checks done; issuer viewing key still open.
3. Phase 1 (done): pool + verifiers on Tempo Moderato, PathUSD, `tempo` live,
   consumers on `useNetwork()`. Redeployed 2026-09-16 (hardening) and
   2026-09-29 (no admin withdraw, timelocked rule changes).
4. Phase 2 (done, on Tempo mainnet since 21 October 2026): x402 + MCP private-pay surface.
5. Phase 3 (open): issuer-viewing-key selective disclosure as a headline feature.
6. Mainnet (21 October 2026): `ShieldPoolPayments` on Tempo mainnet, final keys,
   deposit limits, payments only.
