import type { Metadata } from "next";
import { ELYSIUM_ENABLED } from "@/lib/elysium";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { FlowDiagram } from "@/components/docs/FlowDiagram";
import { VAULT_SWAP_ROUTERS, VAULT_SWAP_V2_ROUTER, VAULT_SWAP_V3_ADDRESS, swapV3Live } from "@/lib/vaultSwap";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

/** Private swaps v3 (lib/vaultSwap VAULT_SWAP_V3_LIVE), chain by chain: the page follows each switch. */
const V3_RH = swapV3Live(4663);
const V3_TEMPO = swapV3Live(4217);
const V3_BASE = swapV3Live(8453);
const V3_ETHEREUM = swapV3Live(1);
const V3 = V3_RH || V3_TEMPO || V3_BASE || V3_ETHEREUM;
/** The chains that joined with v3, and every chain with swaps, for the sentences that name them. */
const NEW_CHAINS = [...(V3_BASE ? ["Base"] : []), ...(V3_ETHEREUM ? ["Ethereum"] : [])];
const and = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const WHERE = and(["Robinhood Chain", "Tempo", ...NEW_CHAINS]);
const V4_WHERE = and(["Robinhood Chain", ...NEW_CHAINS]);

export const metadata: Metadata = {
  title: "Private swaps",
  description: `Swap straight from your private balance on ${WHERE} mainnet. Who swapped stays private; the tokens and the amounts are public, like any DEX trade.`,
};

const VAULT = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const TREASURY = "0xB3900ac9350903218e4c7597bAb0f008F01B30B8";
const RH_V1_ROUTER = "0x34AB06208586A737Bf1607fa996Bc9162271c52d";
/** Private swaps v2 on Robinhood Chain (lib/vaultSwap VAULT_SWAP_V2_ROUTER): the page follows the switch. */
const V2 = Boolean(VAULT_SWAP_V2_ROUTER[4663]);

export default function DocsPrivateSwapsPage() {
  return (
    <DocsLayout
      title="Private swaps"
      lede={`Swap one token for another straight from your private balance, on ${WHERE} mainnet. Who swapped stays private. The tokens and the amounts are public, like any trade on a DEX.`}
      glance={[
        { label: "Where", value: NEW_CHAINS.length ? `${2 + NEW_CHAINS.length} mainnets` : "RH + Tempo mainnet" },
        { label: "Who swapped", value: "Private" },
        { label: "Amounts", value: "Public" },
        { label: "Sent by", value: "The Gloam relay" },
      ]}
    >
      <h2 id="how">How a swap works</h2>
      <FlowDiagram
        title="One swap, one transaction"
        steps={[
          {
            n: "1",
            title: "Out of the vault",
            body: "The vault releases one of your private notes to a one-time escrow address, made for this swap alone.",
          },
          {
            n: "2",
            title: "Swap on a DEX",
            body: `The swap router buys an exact amount of the other token on a public DEX: Uniswap v4 on ${V4_WHERE}, Tempo's stablecoin exchange on Tempo.`,
          },
          {
            n: "3",
            title: "Back in the vault",
            body: "The output goes straight back into the vault as a new private note that only you know.",
          },
        ]}
      />
      <p>
        All three steps run in one transaction. If any step fails, the whole
        swap reverts and nothing moves.
      </p>
      <p>
        The Gloam relay sends the transaction and pays its network fee, so your
        wallet never signs it or shows up next to it. Swaps always go through
        the relay. Sending one from your own wallet would put your wallet right
        next to the swap, so the app does not offer it.
      </p>
      {ELYSIUM_ENABLED && <p>Private swaps are not on Elysium yet: there is no swap router there.</p>}

      <h2 id="pairs">What you can swap</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Chain</th>
              <th>Pairs</th>
              <th>Where it trades</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Robinhood Chain</td>
              {V2 ? (
                <>
                  <td>
                    USDG, $GLOAM, {V3_RH ? "ETH, WETH" : "ETH (held as WETH)"}, USDe, U, cbBTC, VIRTUAL,
                    PONS, CASHCAT, AI, ORBIO and 20 Robinhood stock tokens (SPY, NVDA,
                    TSLA, AAPL and more), any one for another. AI and ORBIO swap
                    through their USDG pools, live since 3 November 2026.
                  </td>
                  <td>
                    Uniswap v4, in up to three hops over the router&apos;s
                    allowed pools, whichever route pays the most
                  </td>
                </>
              ) : (
                <>
                  <td>USDG and $GLOAM</td>
                  <td>
                    Uniswap v4, in two hops through ETH, or the direct USDG and
                    $GLOAM pool when it pays more
                  </td>
                </>
              )}
            </tr>
            <tr>
              <td>Tempo</td>
              <td>USDC.e, pathUSD, USDT0 and OUSD, any one for another</td>
              <td>Tempo&apos;s stablecoin exchange</td>
            </tr>
            {V3_BASE && (
              <tr>
                <td>Base</td>
                <td>USDC, USDT, EURC and ETH, any one for another</td>
                <td>Uniswap v4, in up to three hops over hookless pools, whichever route pays the most</td>
              </tr>
            )}
            {V3_ETHEREUM && (
              <tr>
                <td>Ethereum</td>
                <td>USDC, USDT, USDG, EURC and ETH, any one for another</td>
                <td>Uniswap v4, in up to three hops over hookless pools, whichever route pays the most</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {V3_ETHEREUM && (
        <p>
          PYUSD can be held and sent on Ethereum, but not swapped: its plain
          Uniswap v4 pools return about $10 for $100.
        </p>
      )}
      <p>
        An example on Tempo: 1 pathUSD gets about 0.9937 USDC.e, after the
        vault fee and the price buffer below. Prices move, so the app always
        shows the live quote.
      </p>
      <p>
        Swaps are on mainnet only, stock tokens included. The testnets have no
        swap router, so the sample stock tokens on Robinhood Chain testnet
        cannot be swapped there.
      </p>

      <h2 id="private-public">What stays private and what is public</h2>
      <p>
        <strong>Private:</strong>
      </p>
      <ul>
        <li>Who swapped. The Gloam relay sends it, so your wallet never shows.</li>
        <li>
          Which private balance it came from. The proof shows you own a note in
          the vault, not which one.
        </li>
        <li>Where the new balance goes next. It is a fresh note only you know.</li>
      </ul>
      <p>
        <strong>Public:</strong>
      </p>
      <ul>
        <li>The two tokens and the two amounts, as with any trade on a DEX.</li>
        <li>When it happened, and that it went through the Gloam swap router.</li>
      </ul>
      <p>
        On the explorer, one swap shows as the relay calling the router, the
        vault paying a one-time escrow address, a trade on the DEX, and a
        deposit from the router back into the vault. A private swap hides you,
        not the trade.
      </p>

      <h2 id="tips">Keep a swap from linking back to you</h2>
      <ul>
        <li>
          <strong>Don&apos;t swap exactly what you deposited.</strong> A swap the
          same size as a recent deposit is easy to match to it. Swap a
          different amount.
        </li>
        <li>
          <strong>Don&apos;t cash out exactly what you received.</strong>{" "}
          A cash
          out of the swap&apos;s exact output can be matched to the swap. Send it
          on, or cash out a different amount.
        </li>
        <li>
          <strong>Mind the crowd.</strong> The mainnet vaults are new, so there
          are few notes to hide among for now.
        </li>
      </ul>

      <h2 id="one-note">One note per swap</h2>
      <p>
        Your private balance can be made of several notes: each deposit,
        payment you claimed, or change from a payment is its own. A swap spends
        exactly one of them.
      </p>
      <p>
        So <strong>Max</strong> is your largest single note, not your whole
        balance. When your balance is in several parts, the app says how much
        one swap can take. Swap the rest in a second swap.
      </p>
      <p>
        Swap less than a note and the app first sets that part aside in a note
        of its own, privately and through the relay. The rest stays in your
        private balance. The app picks the note that matches your amount
        exactly, or else the smallest one that covers it.
      </p>

      <h2 id="costs">What it costs</h2>
      <ul>
        <li>
          <strong>Vault fee, {CASH_OUT_FEE_PERCENT} of the amount you swap.</strong> A swap takes
          the note out of the vault the same way a cash out does, so the vault
          keeps its usual cash-out fee.
        </li>
        <li>
          <strong>Price buffer, 0.5% on Robinhood Chain and 0.1% on Tempo.</strong>{" "}
          The swap asks for a little less than the quote, so a small price move
          before it lands does not make it fail. On Robinhood Chain that means
          every swap is planned to leave about 0.5% of its input unspent.
          Whatever the trade does not use is not returned to you: it goes to
          the Gloam treasury.
          {NEW_CHAINS.length > 0 && ` On ${and(NEW_CHAINS)} it is 0.1% between two dollar stablecoins and 0.5% otherwise.`}
        </li>
        <li>
          <strong>Pool fees</strong> are already in the quoted price.
        </li>
        <li>
          <strong>Network fee:</strong> the relay pays it.
          {V3_ETHEREUM &&
            " On Ethereum that sets a smallest swap: a swap's vault fee has to cover its gas, and the step that sets part of a note aside when there is one. The swap tab shows the smallest one right now, and it moves with gas."}
        </li>
      </ul>
      <p>
        Open <strong>Details</strong> under the rate to see each part before
        you swap: what you receive, the vault fee, the price buffer, the route,
        and who sends it.
      </p>
      <p>
        The amount shown is the least you get. The quote refreshes every 15
        seconds, and the app prices the swap once more just before it goes. If
        the price moved your way, you get the better amount. If it moved
        against you by more than the buffer, the swap does not go through and
        nothing moves.
      </p>
      <p>
        Deposit limits apply to what lands, because the new note is a
        deposit. One swap brings in at most 50,000 of a stablecoin, or 2,500,000
        $GLOAM, and only while the vault has room under its total.
        {V2 &&
          " Every other token has its own limits, and a token the vault does not take yet can't be swapped into. A swap also spends no more than its refund could bring back in one deposit, so a larger part of your balance is split first."}
      </p>

      {NEW_CHAINS.length > 0 && (
        <>
          <h2 id="stablecoins">Stablecoin pairs on {and(NEW_CHAINS)}</h2>
          <p>
            Two stablecoins can be far apart for a moment, and a pool can hold
            far less than it looks like. A pool that runs out of liquidity at
            the market price keeps filling at a worse one, so the app checks
            each quote before it shows it.
          </p>
          <ul>
            <li>
              <strong>A thin pool is refused.</strong> A swap that would move
              its pool by more than 2% doesn&apos;t go, and the app names a size
              that would. From 1% it warns. EURC&apos;s pool on Base is thin, so
              large EURC swaps there are refused.
            </li>
            <li>
              <strong>Two dollars stay close to a dollar.</strong> Below 98 cents
              on the dollar, before fees, the quote is refused. From 99.5 cents
              the app says so.
            </li>
            <li>
              <strong>The route is picked by what it pays.</strong> If the direct
              pool is one-sided, the swap goes through another stablecoin. USDT to
              USDG on Ethereum goes through USDC for this reason.
            </li>
          </ul>
        </>
      )}

      <h2 id="refund">If a swap can&apos;t finish</h2>
      <p>
        Once a swap is sent, its proofs are public. Anyone can copy its first
        step, the release from the vault, and send it on its own. That makes
        the swap fail on purpose. It cannot send your money anywhere else.
      </p>
      <p>
        Here is why. The escrow address is worked out from everything the swap
        must do: the note spent, your new note, a refund note and the route.
        Only the router can open it, and only to put the money back into the
        vault for you.
      </p>
      <p>
        So the money comes back to your private balance as a refund note, made
        in advance with the swap. You get back 99% of the note. The other 1%
        covers the vault&apos;s cash-out fee ({CASH_OUT_FEE_PERCENT} today), and what is left of
        it goes to the Gloam treasury. The app finishes the refund by itself,
        through the relay, the next time it syncs your balance.
        {V3 && " Through the newest routers the refund is the note less the vault's fee and 0.1%."}
      </p>
      <p>
        If a swap simply doesn&apos;t go through, for example because the price
        moved past the buffer, nothing moved and your money is safe in the
        vault. About a minute later the app moves it to a fresh private
        balance, through the relay. Then get a new quote. If you close the app
        first, the move finishes the next time you open it.
      </p>
      <p>
        Until then, a swap that didn&apos;t go through isn&apos;t cancelled. Its
        proofs stay valid, so anyone can send it again, and it lands if the
        price comes back within the buffer. It can only land exactly as you
        made it: the same output, into your new note. The app keeps that note
        until the chain settles it and counts it the moment it lands. That move
        ends the old swap for good, and so does spending the same money on
        anything else, such as a send.
      </p>
      <p>
        If the app never hears how a swap ended, it waits an hour. If nothing
        has landed by then, it makes the same move. Only one of the two can
        ever land, so your money is counted once either way.
      </p>
      {V3 && (
        <p>
          A swap through the newest routers carries a deadline, 30 minutes after
          it is made{NEW_CHAINS.length > 0 && `, or 10 on ${and(NEW_CHAINS)}`}. It can&apos;t land after that. A refund and an exit have no
          deadline.
        </p>
      )}

      {V3 && (
        <>
          <h3 id="exit">If the vault can&apos;t take the refund</h3>
          <p>
            A refund note is a deposit, so it needs room under the vault&apos;s
            limit for that token. If there is none, the money waits at the
            escrow. It stays yours, the app shows it as held, outside your
            balance, and it comes back privately by itself once there is room.
          </p>
          <p>
            You don&apos;t have to wait. Each swap names a one-time exit key, made
            from your refund note&apos;s secret, so only you can use it. Sign for a
            wallet and everything that arrived at the escrow goes there, and a
            copy of your signature can only pay that wallet. The relay can send
            it for you, so a new wallet needs no gas.
          </p>
          <p>
            <strong>An exit is public.</strong> Anyone can see that wallet and the
            amount next to the swap, so that money stops being private. A wallet
            you have never used keeps the rest of your balance apart from it.
            A swap made through an earlier router has no exit: its refund waits
            for room.
          </p>
        </>
      )}

      <h2 id="trust">What the router can and cannot do</h2>
      <ul>
        {V2 ? (
          <>
            <li>
              <strong>No upgrade, and nobody moves money.</strong> No one can
              change the routers&apos; code, the vault, the treasury or the
              exchange they use, and no function sends what passes through them
              anywhere but your new note, your refund note and the treasury
              {V3 ? ", or a wallet you signed for with the swap's exit key" : ""}.
            </li>
            <li>
              <strong>Allowed venues, changed in public.</strong>{" "}
              On {V4_WHERE} the router only uses Uniswap v4 pools on its
              allowlist. Its owner can add a pool only with 3 days of public
              notice on chain, and can take one off at once. A swap names its
              route in advance, so a pool added later can never be slipped into
              it. On Tempo the router only uses Tempo&apos;s stablecoin exchange.
            </li>
            <li>
              {V3_RH || NEW_CHAINS.length ? (
                <>
                  <strong>ETH and WETH.</strong> A note can be either one, and a
                  pool can hold either one. When they differ, the router converts
                  exactly what that pool trades, at the end of the route, inside
                  the swap, and keeps none of it.
                </>
              ) : (
                <>
                  <strong>ETH as WETH.</strong> The vault holds WETH. When a route
                  uses a pool that holds ETH, the router unwraps or wraps exactly
                  what that pool trades, inside the swap, and keeps none of it.
                </>
              )}
            </li>
            <li>
              <strong>Issuers keep their powers.</strong> Robinhood can pause a
              stock token or block an address, as Paxos can with USDG
              {NEW_CHAINS.length ? ", and Circle and Tether with theirs" : ""}. A swap in
              or out of a paused token fails and nothing moves; a refund in one
              waits until it can land.
            </li>
          </>
        ) : (
          <>
            <li>
              <strong>No owner, no admin, no upgrade.</strong> The routers have no
              settings anyone can change after deploy.
            </li>
            <li>
              <strong>Fixed venues.</strong>{" "}
              On Robinhood Chain the router only uses
              three Uniswap v4 pools fixed when it was deployed. On Tempo it only
              uses Tempo&apos;s stablecoin exchange.
            </li>
          </>
        )}
        <li>
          <strong>Exact output or nothing.</strong> The router checks that it
          got the full amount of your new note and paid no more than arrived
          from the vault. Otherwise the whole swap reverts.
          {V2 && " So even a pool that turns against a swap can keep at most its price buffer, the part that would go to the treasury, never your new note and never anyone else's money."}
        </li>
        <li>
          <strong>The vault is unchanged.</strong> The mainnet vault still has
          no swap code. The router uses only its normal calls: release a note
          with a proof, and deposit with a proof.
        </li>
        <li>
          <strong>Not part of the external review.</strong>{" "}
          <Link href="/security">Kann Audits</Link> reviewed the vault contracts,
          not the routers. The routers have had internal review only, most
          recently on 7 November 2026. An outside review of them is being
          sourced.
        </li>
      </ul>
      <p>
        The full list of risks is in the{" "}
        <Link href="/docs/threat-model#swaps">threat model</Link>.
      </p>

      <h2 id="contracts">Contracts</h2>
      <ul>
        <li>
          <strong>Robinhood Chain router</strong> ({V3_RH ? "GloamVaultSwapV4c" : V2 ? "GloamVaultSwapV4b" : "GloamVaultSwapV4"}),{" "}
          <code>{VAULT_SWAP_ROUTERS[4663]}</code>
        </li>
        {V3_RH && V2 && (
          <li>
            <strong>Earlier Robinhood Chain router</strong> (GloamVaultSwapV4b),
            which still finishes the refunds of swaps made through it,{" "}
            <code>{VAULT_SWAP_V2_ROUTER[4663]}</code>
          </li>
        )}
        {V2 && (
          <li>
            <strong>Earlier Robinhood Chain router</strong> (GloamVaultSwapV4),
            which still finishes the refunds of swaps made through it,{" "}
            <code>{RH_V1_ROUTER}</code>
          </li>
        )}
        <li>
          <strong>Tempo router</strong> ({V3_TEMPO ? "GloamVaultSwapTempo2" : "GloamVaultSwapTempo"}),{" "}
          <code>{VAULT_SWAP_ROUTERS[4217]}</code>
        </li>
        {V3_BASE && (
          <li>
            <strong>Base router</strong> (GloamVaultSwapV4c), <code>{VAULT_SWAP_V3_ADDRESS[8453]}</code>
          </li>
        )}
        {V3_ETHEREUM && (
          <li>
            <strong>Ethereum router</strong> (GloamVaultSwapV4c), <code>{VAULT_SWAP_V3_ADDRESS[1]}</code>
          </li>
        )}
        <li>
          <strong>Vault</strong>, the same address on every mainnet,{" "}
          <code>{VAULT}</code>
        </li>
        <li>
          <strong>Treasury</strong>, where unused input goes, fixed in each
          router, <code>{TREASURY}</code>
        </li>
      </ul>

      <h2 id="sealed-trade">The old sealed trade</h2>
      <p>
        Private swaps replace the first private trade design, the sealed swap.
        It tried to keep the size of a trade private too, but no tokens moved,
        so the pool could end up owing an asset it did not hold (audit H1). It
        is retired and stays off: the testnet pools have no sealed swap
        verifier set, and the mainnet vaults have no sealed swap code at all.
      </p>

      <h2 id="try">Try it</h2>
      <p>
        In the app, open <AppLink href="/app/vault?tab=swap">Vault &gt; Swap</AppLink>{" "}
        on a mainnet. Connect a wallet and you can check prices before you
        have a private balance. To swap, first add one of the tokens above in{" "}
        <AppLink href="/app/vault?tab=shield">Add</AppLink>. See also{" "}
        <Link href="/docs/privacy-model">what stays private</Link> and{" "}
        <Link href="/docs/chain#mainnet">networks</Link>.
      </p>

      <h2 id="build">Swaps in your app or agent</h2>
      <p>
        The same swaps, priced by the same planner, are in the SDK and the MCP server. A swap hides
        who swapped, not the tokens or the amounts. They check what the swap tab checks (the vault&apos;s
        limits, the relay&apos;s state and floor), and they stop price impact over 2% and a dollar pair
        more than 2% apart on every chain, where the swap tab only warns on Robinhood Chain and
        Tempo. The swap tab also weighs a swap against market prices; the SDK does that only when
        you pass prices, and the MCP server doesn&apos;t.
      </p>
      <ul>
        <li>
          SDK (<code>@gloamtrade/sdk</code> 0.5.0): <code>quoteSwap</code>, <code>buildSwapIntent</code>,{" "}
          <code>sendSwap</code>, and <code>readSwapOutcome</code>, <code>buildSwapRefund</code> and{" "}
          <code>buildSwapExit</code> to always get the money back. See the{" "}
          <a href="https://github.com/gloamtrade/gloam/tree/main/packages/sdk#private-swaps">SDK README</a>.
        </li>
        <li>
          Partner API: action <code>&quot;swap&quot;</code> on <code>POST /api/v1/relay</code>, and a read-only quote at{" "}
          <code>POST /api/v1/swaps/quote</code>. See{" "}
          <Link href="/docs/partners#swaps">the partner API</Link>.
        </li>
        <li>
          MCP server (<code>@gloamtrade/mcp</code>): <code>gloam_swap_quote</code>,{" "}
          <code>gloam_execute_private_swap</code> (proved on your machine, sent through the relay, under
          the agent&apos;s spending limits) and <code>gloam_finish_swap</code>. The hosted server quotes only.
        </li>
        <li>
          A link: a trading app can open the Swap tab with a swap filled in (
          <code>?tab=swap#from=USDG&amp;to=TSLA&amp;amount=100</code>). The person checks the quote and
          taps Swap privately. See{" "}
          <Link href="/docs/partners#swap-link">trade privately with one link</Link>.
        </li>
      </ul>
    </DocsLayout>
  );
}
