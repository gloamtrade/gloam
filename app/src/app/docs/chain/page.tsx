import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { baseSepoliaPool, ethereumSepoliaPayMemo, ethereumSepoliaPool, liveMainnetCountWords, liveMainnetNames, mainnetPool, type MainnetChainId } from "@/lib/mainnet";
import { BASE_MAINNET_TOKENS, BASE_SEPOLIA_TOKENS, ELYSIUM_MAINNET_TOKENS, ETHEREUM_MAINNET_TOKENS, ETHEREUM_SEPOLIA_TOKENS, RH_MAINNET_TOKENS, TEMPO_MAINNET_TOKENS } from "@/lib/tokens";
import { DEFAULT_MAX_GAS_GWEI } from "@/lib/relay/gasCeiling";
import { getNetwork } from "@/lib/networks";
import { VAULT_SWAP_ROUTERS, swapMainnets, swapV3Live } from "@/lib/vaultSwap";
import { GLOAM_OWNER, GLOAM_RELAYERS, GLOAM_TREASURY, MAINNET_POSEIDON_T3 } from "@/lib/contractDirectory";
import { ELYSIUM, ELYSIUM_FLAG, ELYSIUM_LIVE_SINCE, ELYSIUM_RPC_DISPLAY, ELYSIUM_TESTNET, ELYSIUM_TESTNET_FLAG } from "@/lib/elysium";
import { CASH_OUT_FEE_PERCENT } from "@/lib/cashOutFee";

export const metadata: Metadata = {
  title: "Networks",
  description:
    `Gloam runs one private core on ${liveMainnetCountWords()}, ${liveMainnetNames()}, ${ELYSIUM && !ELYSIUM_TESTNET ? "each but Elysium with a testnet" : "each with a testnet"}. Chain IDs, RPCs, pools, assets, deposit limits, and the integration details for each chain.`,
};

/** A mainnet pool address, or a placeholder until it is filled in on deploy day. */
function MainnetPoolAddress({ chainId }: { chainId: MainnetChainId }) {
  const p = mainnetPool(chainId);
  return p ? <code>{p.pool}</code> : <>Published at launch</>;
}

function MainnetDeployBlock({ chainId }: { chainId: MainnetChainId }) {
  const p = mainnetPool(chainId);
  return p ? <code>{p.deployBlock.toString()}</code> : <>Published at launch</>;
}

/** Base Sepolia's pool, or a placeholder until it is filled in after its deploy. */
function BaseSepoliaPoolAddress() {
  const p = baseSepoliaPool();
  return p ? <code>{p.pool}</code> : <>Not deployed yet</>;
}

/** Base's pools are in once their addresses are filled in (lib/mainnet.ts). */
const BASE_SEPOLIA_LIVE = baseSepoliaPool() !== null;
const BASE_MAINNET_LIVE = mainnetPool(8453) !== null;
/** Ethereum's pool is in once MAINNET_POOLS[1] is filled in (lib/mainnet.ts). */
const ETHEREUM_LIVE = mainnetPool(1) !== null;
/** Base's and Ethereum's mainnet memo boards, filled in with their vaults (lib/networks.ts). */
const BASE_MAINNET_MEMO = getNetwork("base-mainnet").payMemo;
const ETHEREUM_MAINNET_MEMO = getNetwork("ethereum-mainnet").payMemo;

/** Ethereum Sepolia's pool and memo board, once filled in after its deploy (lib/mainnet.ts). */
const ETHEREUM_SEPOLIA = ethereumSepoliaPool();
const ETHEREUM_SEPOLIA_MEMO = ethereumSepoliaPayMemo();


/** "Four mainnets", "Five mainnets": the count as the heading writes it. */
const MAINNETS_HEADING = liveMainnetCountWords().replace(/^./, (c) => c.toUpperCase());
/** Elysium's vault sits at the address the other mainnets share, when its deployer nonce was 0 (DEPLOY-ELYSIUM.md). */
const ELYSIUM_SAME_VAULT = ELYSIUM !== null && ELYSIUM.pool.toLowerCase() === "0x39e28cde55cab798874746ac52cb4b5cc99a0194";

/** A mainnet swap router, or "Not deployed" where there is none. */
function SwapRouterAddress({ chainId }: { chainId: MainnetChainId }) {
  const r = VAULT_SWAP_ROUTERS[chainId];
  return r ? <code>{r}</code> : <>Not deployed</>;
}

export default function DocsNetworksPage() {
  return (
    <DocsLayout
      title="Networks"
      lede={`One private core, ${liveMainnetCountWords()}. ${liveMainnetNames()}, ${ELYSIUM && !ELYSIUM_TESTNET ? "each but Elysium with a testnet" : "each with a testnet"}.`}
      glance={[
        { label: "Robinhood Chain mainnet", value: "4663" },
        { label: "Tempo mainnet", value: "4217" },
        { label: "Base mainnet", value: "8453" },
        { label: "Ethereum mainnet", value: "1" },
        ...(ELYSIUM ? [{ label: "Elysium mainnet", value: String(ELYSIUM.chainId) }] : []),
        { label: "Testnets", value: ELYSIUM_TESTNET ? "46630 · 42431 · 84532 · 11155111 · 99801" : "46630 · 42431 · 84532 · 11155111" },
        { label: "Gas", value: ELYSIUM ? "ETH; stablecoins on Tempo; HYPE on Elysium" : "ETH; stablecoins on Tempo" },
      ]}
    >
      <h2>{MAINNETS_HEADING}, one shielded pool design</h2>
      <p>
        Gloam is not a chain. It is a shielded-pool contract plus verifiers,
        deployed to the chains where the money already moves. The same circuits,
        the same vault design, and the same SDK run on every network. What
        differs is the asset each chain leads with: USDG, $GLOAM, PONS and CASHCAT
        on Robinhood Chain, dollar stablecoins on Tempo, USDC, EURC, USDT and ETH on Base and
        Ethereum, with USDG and PYUSD on Ethereum too{ELYSIUM ? ", and USDC on Elysium" : ""}. The app switches networks at runtime
        and points at the right pool for each.
      </p>

      <h2 id="mainnet">Mainnet</h2>
      <p>
        Gloam went live on Robinhood Chain and Tempo mainnet on 21 October 2026,
        13:00 UTC, and on Base and Ethereum mainnet on 26 October 2026
        {ELYSIUM ? `, then on Elysium mainnet on ${ELYSIUM_LIVE_SINCE}` : ""}. The
        vault has the same address on{" "}
        {ELYSIUM && !ELYSIUM_SAME_VAULT ? "the first four" : `all ${liveMainnetCountWords().split(" ")[0]}`}. The mainnet pools
        (<code>ShieldPoolPayments</code>) take shield, private send, cash out
        and proofs, and have no swap code.{" "}
        <Link href="/docs/private-swaps">Private swaps</Link>{" "}
        run through a separate router on {swapMainnets()}, which uses
        only the vault&apos;s normal calls
        {swapV3Live(8453) && swapV3Live(1)
          ? "."
          : `; ${[...(swapV3Live(8453) ? [] : ["Base"]), ...(swapV3Live(1) ? [] : ["Ethereum"])].join(" and ")} ${swapV3Live(8453) || swapV3Live(1) ? "has" : "have"} no swap router yet.`}
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th />
              <th>Robinhood Chain</th>
              <th>Tempo</th>
              <th>Base</th>
              <th>Ethereum</th>
              {ELYSIUM && <th>Elysium</th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Chain ID</td>
              <td>
                <code>4663</code>
              </td>
              <td>
                <code>4217</code>
              </td>
              <td>
                <code>8453</code>
              </td>
              <td>
                <code>1</code>
              </td>
              {ELYSIUM && (
                <td>
                  {<code>{ELYSIUM.chainId}</code>}
                </td>
              )}
            </tr>
            <tr>
              <td>RPC</td>
              <td>
                <code>https://rpc.mainnet.chain.robinhood.com</code>
              </td>
              <td>
                <code>https://rpc.tempo.xyz</code>
              </td>
              <td>
                <code>https://mainnet.base.org</code>
              </td>
              <td>
                <code>https://rpc.mevblocker.io</code>
              </td>
              {ELYSIUM && (
                <td>
                  <code>{ELYSIUM_RPC_DISPLAY}</code>
                </td>
              )}
            </tr>
            <tr>
              <td>Explorer</td>
              <td>
                <a href="https://robin.etherscan.io" target="_blank" rel="noreferrer">
                  robin.etherscan.io
                </a>
              </td>
              <td>
                <a href="https://explore.tempo.xyz" target="_blank" rel="noreferrer">
                  explore.tempo.xyz
                </a>
              </td>
              <td>
                <a href="https://basescan.org" target="_blank" rel="noreferrer">
                  basescan.org
                </a>
              </td>
              <td>
                <a href="https://etherscan.io" target="_blank" rel="noreferrer">
                  etherscan.io
                </a>
              </td>
              {ELYSIUM && (
                <td>
                  {<a href={ELYSIUM.explorerUrl} target="_blank" rel="noreferrer">
                    {ELYSIUM.explorerUrl.replace(/^https:\/\//, "")}
                  </a>}
                </td>
              )}
            </tr>
            <tr>
              <td>Pool</td>
              <td>
                <MainnetPoolAddress chainId={4663} />
              </td>
              <td>
                <MainnetPoolAddress chainId={4217} />
              </td>
              <td>
                <MainnetPoolAddress chainId={8453} />
              </td>
              <td>
                <MainnetPoolAddress chainId={1} />
              </td>
              {ELYSIUM && (
                <td>
                  {<code>{ELYSIUM.pool}</code>}
                </td>
              )}
            </tr>
            <tr>
              <td>Deploy block</td>
              <td>
                <MainnetDeployBlock chainId={4663} />
              </td>
              <td>
                <MainnetDeployBlock chainId={4217} />
              </td>
              <td>
                <MainnetDeployBlock chainId={8453} />
              </td>
              <td>
                <MainnetDeployBlock chainId={1} />
              </td>
              {ELYSIUM && (
                <td>
                  {<code>{ELYSIUM.deployBlock.toString()}</code>}
                </td>
              )}
            </tr>
            <tr>
              <td>Swap router</td>
              <td>
                <SwapRouterAddress chainId={4663} />
              </td>
              <td>
                <SwapRouterAddress chainId={4217} />
              </td>
              <td>
                <SwapRouterAddress chainId={8453} />
              </td>
              <td>
                <SwapRouterAddress chainId={1} />
              </td>
              {ELYSIUM && <td>Not deployed</td>}
            </tr>
            <tr>
              <td>Swaps on</td>
              <td>Uniswap v4 (USDG, $GLOAM, PONS, CASHCAT, WETH, stock tokens and more)</td>
              <td>Tempo&apos;s stablecoin exchange (the four stablecoins)</td>
              <td>{swapV3Live(8453) ? "Uniswap v4 (USDC, USDT, EURC, ETH)" : "Not yet"}</td>
              <td>{swapV3Live(1) ? "Uniswap v4 (USDC, USDT, USDG, EURC, ETH)" : "Not yet"}</td>
              {ELYSIUM && <td>Not yet</td>}
            </tr>
            <tr>
              <td>Gas</td>
              <td>ETH, also a pool asset</td>
              <td>Paid in stablecoins</td>
              <td>ETH, also a pool asset</td>
              <td>ETH, also a pool asset; the relay waits while gas is above {DEFAULT_MAX_GAS_GWEI[1]} gwei</td>
              {ELYSIUM && <td>HYPE, not a pool asset</td>}
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Assets and deposit limits</h3>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Chain</th>
              <th>Address</th>
              <th>Decimals</th>
            </tr>
          </thead>
          <tbody>
            {RH_MAINNET_TOKENS.map((t) => (
              <tr key={`rh-${t.address}`}>
                <td>{t.symbol === "GLOAM" ? "$GLOAM" : t.symbol}</td>
                <td>Robinhood Chain</td>
                <td>
                  <code>{t.address}</code>
                </td>
                <td>{t.decimals}</td>
              </tr>
            ))}
            {TEMPO_MAINNET_TOKENS.map((t) => (
              <tr key={`tempo-${t.address}`}>
                <td>{t.symbol}</td>
                <td>Tempo</td>
                <td>
                  <code>{t.address}</code>
                </td>
                <td>{t.decimals}</td>
              </tr>
            ))}
            {BASE_MAINNET_LIVE &&
              BASE_MAINNET_TOKENS.map((t) => (
                <tr key={`base-${t.address}`}>
                  <td>{t.symbol}</td>
                  <td>Base</td>
                  <td>
                    <code>{t.address}</code>
                  </td>
                  <td>{t.decimals}</td>
                </tr>
              ))}
            {ETHEREUM_LIVE &&
              ETHEREUM_MAINNET_TOKENS.map((t) => (
                <tr key={`eth-${t.address}`}>
                  <td>{t.symbol}</td>
                  <td>Ethereum</td>
                  <td>
                    <code>{t.address}</code>
                  </td>
                  <td>{t.decimals}</td>
                </tr>
              ))}
            {ELYSIUM_MAINNET_TOKENS.map((t) => (
              <tr key={`elysium-${t.address}`}>
                <td>{t.symbol}</td>
                <td>Elysium</td>
                <td>
                  <code>{t.address}</code>
                </td>
                <td>{t.decimals}</td>
              </tr>
            ))}
            {["Robinhood Chain", BASE_MAINNET_LIVE ? "Base" : null, ETHEREUM_LIVE ? "Ethereum" : null]
              .filter((c): c is string => c !== null)
              .map((c) => (
                <tr key={`eth-native-${c}`}>
                  <td>ETH</td>
                  <td>{c}</td>
                  <td>Native, no token address</td>
                  <td>18</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <ul>
        <li>
          <strong>Deposit limits.</strong> Each stablecoin: 50,000 per
          deposit and 2,500,000 in total. ETH on Base and Ethereum: 20 per
          deposit and 1,000 in total. $GLOAM: 2,500,000 per deposit and
          25,000,000 in total. PONS: 390,000 and 9,800,000. CASHCAT: 960,000 and
          24,000,000.{ELYSIUM ? " USDC on Elysium: 500 per deposit and 25,000 in total at launch." : ""} The app
          shows the room left before you sign.
        </li>
        <li>
          <strong>Never limited:</strong> private payments and cash outs.
        </li>
        <li>
          <strong>Changes are public.</strong> Raising a limit or adding an
          asset waits a public 3-day timelock. The owner can lower limits or
          close deposits at once, which never stops a withdrawal.
        </li>
        <li>
          <strong>Fees.</strong> Direct deposits and private payments are free. A
          cash out costs {CASH_OUT_FEE_PERCENT}, kept by the pool. A private swap pays the same {CASH_OUT_FEE_PERCENT}
          on the amount swapped, plus a price buffer (0.5% on Robinhood Chain,
          0.1% on Tempo{swapV3Live(8453) || swapV3Live(1) ? ", and on Base and Ethereum 0.1% between two dollar stablecoins and 0.5% otherwise" : ""})
          whose unused part goes to the swap treasury. Money{" "}
          <Link href="/docs/bridge#costs">bridged in from another chain</Link> pays
          the bridge&apos;s fees.
        </li>
      </ul>

      <h3>Keys and accounts</h3>
      <ul>
        <li>
          <strong>Proving keys</strong>, the final keys from the 13-contributor
          trusted setup (drand round 6561386, release{" "}
          <a
            href="https://github.com/gloamtrade/gloam/releases/tag/ceremony-final"
            target="_blank"
            rel="noreferrer"
          >
            ceremony-final
          </a>
          ). Mainnet proofs must use them; the Robinhood Chain and Tempo
          testnets keep the dev keys.
        </li>
        <li>
          <strong>PoseidonT3</strong> (every mainnet), <code>{MAINNET_POSEIDON_T3}</code>
        </li>
        <li>
          <strong>Owner</strong>, <code>{GLOAM_OWNER}</code>. One wallet at
          launch; a multisig is planned. It cannot withdraw pooled funds: there
          is no admin withdraw. Each vault&apos;s ownership moves to the owner
          guard, which forwards only limit and fee changes and the sweep of
          coin sent by mistake; read{" "}
          <code>owner()</code> on a vault to see which holds it.
        </li>
        <li>
          <strong>Treasury</strong>, <code>{GLOAM_TREASURY}</code>. Cash-out
          fees go here since 24 October. The swap routers also send what a swap
          does not use here; that address is fixed in each router and cannot
          change. The routers have no upgrade. Tempo&apos;s has no owner;
          Robinhood Chain&apos;s owner can add a pool with 3 days of public
          notice and take one off at once, and nothing else.
        </li>
        <li>
          <strong>Relayer</strong>, <code>{GLOAM_RELAYERS[0]}</code>. Run by the
          Gloam team. It only submits already-proven transactions and pays the
          gas; it cannot move or redirect money.
        </li>
      </ul>
      <p>
        Every address on every network, with what each vault reads on chain
        right now and a CSV download, is on{" "}
        <Link href="/verify#contracts">Verify</Link>.
      </p>

      <h2>Robinhood Chain</h2>
      <p>
        An Arbitrum Orbit L2 built for financial services and real-world assets,
        and the surface where tokenized stocks and onchain culture already
        settle. Standard EVM tooling and Uniswap-class paths exist. Gloam adds
        the private layer next to them.
      </p>
      <ul>
        <li>
          <strong>Mainnet chain ID</strong>, 4663
        </li>
        <li>
          <strong>Mainnet RPC</strong>,{" "}
          <code>https://rpc.mainnet.chain.robinhood.com</code>
        </li>
        <li>
          <strong>Mainnet pool</strong>, <MainnetPoolAddress chainId={4663} />
        </li>
        <li>
          <strong>Mainnet assets</strong>, USDG, $GLOAM, PONS and CASHCAT to add
          privately, with deposit limits of 390,000 PONS per deposit and 9,800,000 in
          total, and 960,000 CASHCAT per deposit and 24,000,000 in total, the limits
          live now. Stock tokens, WETH and the other swap tokens come in through a
          private swap.
        </li>
        <li>
          <strong>Opening next</strong>, native ETH (11 per deposit, 110 in total),
          Artificial Inu ($AI, 400,000 and 4,000,000) and Orbio.so ($ORBIO, 1,000,000
          and 10,000,000), each set through the vault&apos;s 3-day timelock. Add offers
          each one once its limit is live on chain. ETH and WETH are separate
          balances in the vault: a private swap uses WETH, and native ETH notes
          can&apos;t go through the swap router.
        </li>
        <li>
          <strong>Mainnet swap router</strong> (GloamVaultSwapV4, Uniswap v4),{" "}
          <SwapRouterAddress chainId={4663} />
        </li>
        <li>
          <strong>Testnet chain ID</strong>, 46630
        </li>
        <li>
          <strong>Native gas</strong>, ETH
        </li>
        <li>
          <strong>Testnet RPC</strong>,{" "}
          <code>https://rpc.testnet.chain.robinhood.com</code>
        </li>
        <li>
          <strong>Testnet vault (sealed pool)</strong>,{" "}
          <code>0x72406D9597807A46f730d8b4fDBC5aC45Dc1d740</code>
        </li>
        <li>
          Official docs,{" "}
          <a
            href="https://docs.robinhood.com/chain/connecting/"
            target="_blank"
            rel="noreferrer"
          >
            docs.robinhood.com/chain
          </a>
        </li>
      </ul>

      <h2>Tempo</h2>
      <p>
        Tempo is a payments-first, EVM-compatible L1 (Reth) built around
        stablecoins, incubated by Stripe and Paradigm. It is the natural home
        for private payments: the chain is designed for moving money, and Gloam
        makes the amounts and balances private while settlement stays verifiable.
        Gloam is live on Tempo mainnet, and on the Moderato testnet for practice.
      </p>
      <ul>
        <li>
          <strong>Mainnet chain ID</strong>, 4217
        </li>
        <li>
          <strong>Mainnet RPC</strong>, <code>https://rpc.tempo.xyz</code>
        </li>
        <li>
          <strong>Mainnet explorer</strong>, <code>https://explore.tempo.xyz</code>
        </li>
        <li>
          <strong>Mainnet pool</strong>, <MainnetPoolAddress chainId={4217} />
        </li>
        <li>
          <strong>Mainnet assets</strong>, USDC.e, pathUSD, USDT0 and OUSD
          (TIP-20, 6 decimals)
        </li>
        <li>
          <strong>Mainnet swap router</strong>{" "}
          (GloamVaultSwapTempo, Tempo&apos;s stablecoin exchange),{" "}
          <SwapRouterAddress chainId={4217} />
        </li>
        <li>
          <strong>Testnet name</strong>, Tempo Moderato
        </li>
        <li>
          <strong>Testnet chain ID</strong>, 42431
        </li>
        <li>
          <strong>Native currency</strong>, USD (gas is paid in a stablecoin,
          not ETH)
        </li>
        <li>
          <strong>Testnet RPC</strong>, <code>https://rpc.moderato.tempo.xyz</code>
        </li>
        <li>
          <strong>Testnet explorer</strong>,{" "}
          <code>https://explore.testnet.tempo.xyz</code>
        </li>
        <li>
          <strong>Testnet sealed pool (hardened)</strong>,{" "}
          <code>0x841DC046Ea3CC842BA3A855731472c6Eb0F2d5eb</code>
        </li>
        <li>
          <strong>Testnet shieldable asset</strong>, PathUSD (6-decimal stablecoin),{" "}
          <code>0x20c0000000000000000000000000000000000000</code>
        </li>
      </ul>

      <h3>Integration notes (what is different from an ETH chain)</h3>
      <p>
        Tempo is stablecoin-native, so the vault integration differs from an
        ETH-gas chain in a few concrete ways. If you build against Tempo, these
        are the things that bite:
      </p>
      <ul>
        <li>
          <strong>No native value transfers.</strong> Tempo does not carry value
          in <code>msg.value</code>. You shield an ERC-20 stablecoin, not a
          native coin, so the shield path always moves a token with{" "}
          <code>transferFrom</code>, never a payable call.
        </li>
        <li>
          <strong>6-decimal accounting.</strong> Tempo stablecoins use 6
          decimals, not 18. Amounts, notes, and disclosures normalize decimals
          per asset. Do not assume 1e18.
        </li>
        <li>
          <strong>30M gas cap per transaction.</strong> Proof-verifying calls
          are heavy, so deploys and some calls run near the cap. Tune your gas
          estimate multiplier down (we deploy at ~1.12x) rather than letting an
          estimator overshoot the 30,000,000 limit.
        </li>
        <li>
          <strong>Testnet faucet is an RPC method.</strong> Fund a testnet
          address with the <code>tempo_fundAddress</code> RPC call rather than a
          web faucet. The in-app &quot;Get testnet funds&quot; link uses it.
        </li>
      </ul>

      <p>
        On Tempo the product is private stablecoin payments, for people and for
        agents: shield a stablecoin, pay and send to a receive tag without
        showing your size, swap one stablecoin for another from your private
        balance, prove a balance when you have to, and cash out to a public
        balance whenever you want it public. Tokenized-equity markets
        are a Robinhood Chain testnet feature and do not appear on Tempo.
      </p>

      <h2 id="base">Base</h2>
      <p>
        Base is an Ethereum L2 (OP Stack) where a lot of USDC already moves.
        Gloam on Base is the same vault as on the other mainnets:{" "}
        <code>ShieldPoolPayments</code>, the ceremony&apos;s final keys,
        deposit limits and the {CASH_OUT_FEE_PERCENT} cash-out fee. Base Sepolia, the testnet,
        went live on 24 October 2026 and Base mainnet on 26 October 2026, on
        the same code.{" "}
        {BASE_MAINNET_LIVE
          ? "Both are live: Base mainnet, and Base Sepolia as its testnet."
          : BASE_SEPOLIA_LIVE
            ? "Base Sepolia is live as a testnet. Base mainnet is not deployed yet, so the app does not offer it."
            : "Neither is deployed yet, so the app does not offer Base. This section is what to expect."}
      </p>
      <ul>
        <li>
          <strong>Mainnet chain ID</strong>, 8453
        </li>
        <li>
          <strong>Mainnet RPC</strong>, <code>https://mainnet.base.org</code>
        </li>
        <li>
          <strong>Mainnet explorer</strong>, <code>https://basescan.org</code>
        </li>
        <li>
          <strong>Mainnet pool</strong>,{" "}
          {BASE_MAINNET_LIVE ? <MainnetPoolAddress chainId={8453} /> : <>Not deployed yet</>}
        </li>
        <li>
          <strong>Mainnet payment-message board</strong>,{" "}
          {BASE_MAINNET_MEMO ? <code>{BASE_MAINNET_MEMO.address}</code> : <>Not deployed yet</>}
        </li>
        <li>
          <strong>Mainnet assets</strong>,{" "}
          {BASE_MAINNET_TOKENS.filter((t) => t.kind === "stablecoin").map((t) => t.symbol).join(", ")}{" "}
          (6 decimals each), ETH, and Beldex&apos;s BDX (9 decimals). USDC and EURC are Circle&apos;s; USDT is Tether bridged from
          Ethereum over Base&apos;s standard bridge.
        </li>
        <li>
          <strong>Testnet name</strong>, Base Sepolia
        </li>
        <li>
          <strong>Testnet chain ID</strong>, 84532
        </li>
        <li>
          <strong>Testnet RPC</strong>, <code>https://sepolia.base.org</code>
        </li>
        <li>
          <strong>Testnet explorer</strong>, <code>https://sepolia.basescan.org</code>
        </li>
        <li>
          <strong>Testnet pool</strong>, <BaseSepoliaPoolAddress />
        </li>
        <li>
          <strong>Testnet assets</strong>, Circle&apos;s test{" "}
          {BASE_SEPOLIA_TOKENS.map((t) => t.symbol).join(" and ")} and test ETH.
          There is no USDT on Base Sepolia. Faucets are in the{" "}
          <Link href="/docs/testnet#base">testnet guide</Link>.
        </li>
        <li>
          <strong>Native gas</strong>, ETH, and ETH is a pool asset here (it is
          not on Robinhood Chain mainnet)
        </li>
        <li>
          <strong>Deposit limits on Base mainnet</strong>, each stablecoin 50,000
          per deposit and 2,500,000 in total; ETH 20 per deposit and 1,000 in total
        </li>
        <li>
          <strong>Deposit limits on Base Sepolia</strong>, each stablecoin 500 per
          deposit and 25,000 in total; ETH 0.2 per deposit and 10 in total
        </li>
        <li>
          <strong>BDX on Base mainnet</strong>, 100,000 per deposit and 2,000,000 in total, set through
          the vault&apos;s 3-day timelock. Add offers BDX once that limit is live on chain.
        </li>
      </ul>

      <h3>Integration notes for Base</h3>
      <ul>
        <li>
          <strong>Base Sepolia runs the mainnet keys.</strong> It is a testnet,
          but the same contract, keys and cash-out fee as Base mainnet,
          so proofs for chain 84532 use the final keys, not the dev keys the
          other testnets use.
        </li>
        <li>
          <strong>Log reads.</strong> Base&apos;s own public RPCs cap{" "}
          <code>eth_getLogs</code> at 200 blocks (Sepolia) or refuse it
          (mainnet), and rebuilding the vault tree needs logs. Gloam reads Base
          through publicnode (50,000 blocks a read); use your own RPC if you
          sync often.
        </li>
        <li>
          <strong>EURC is a euro stablecoin.</strong> The app never counts it as
          a dollar.
        </li>
        <li>
          <strong>Issuer controls.</strong> Circle can blacklist an address on
          USDC and EURC. If it ever blacklisted the vault itself, that asset
          would be frozen in the vault; other assets keep working.
        </li>
        <li>
          <strong>{swapV3Live(8453) ? "As on the other chains." : "Not on Base yet."}</strong>{" "}
          {swapV3Live(8453) ? "" : "Private swaps, next, through a router on Uniswap v4. "}Bringing money
          over from another chain (the Relay bridge), payments, payroll, payment
          requests, claim links and proofs work as on the other chains.{" "}
          {BASE_MAINNET_MEMO
            ? "Base and Base Sepolia each have a payment-message board, so a payment can be found by scanning with your Gloam address."
            : "Base Sepolia has its payment-message board, so a payment can be found by scanning with your Gloam address; Base mainnet gets its own when it is deployed."}
        </li>
      </ul>

      <h2 id="ethereum">Ethereum</h2>
      <p>
        Gloam on Ethereum mainnet is the same vault as on the other mainnets:{" "}
        <code>ShieldPoolPayments</code>, the ceremony&apos;s final keys,
        deposit limits and the {CASH_OUT_FEE_PERCENT} cash-out fee. Its testnet is
        Ethereum Sepolia, below, on the same contract and keys.{" "}
        {ETHEREUM_LIVE
          ? "Ethereum mainnet is live."
          : "It is not deployed yet, so the app does not offer it. This section is what to expect."}
      </p>
      <ul>
        <li>
          <strong>Chain ID</strong>, 1
        </li>
        <li>
          <strong>Explorer</strong>, <code>https://etherscan.io</code>
        </li>
        <li>
          <strong>Pool</strong>, {ETHEREUM_LIVE ? <MainnetPoolAddress chainId={1} /> : <>Not deployed yet</>}
        </li>
        <li>
          <strong>Payment-message board</strong>,{" "}
          {ETHEREUM_MAINNET_MEMO ? <code>{ETHEREUM_MAINNET_MEMO.address}</code> : <>Not deployed yet</>}
        </li>
        <li>
          <strong>Assets</strong>, {ETHEREUM_MAINNET_TOKENS.filter((t) => t.kind === "stablecoin").map((t) => t.symbol).join(", ")} (6
          decimals each), ETH, and Beldex&apos;s BDX (9 decimals). USDC and EURC are Circle&apos;s, USDT is
          Tether&apos;s, USDG and PYUSD are issued by Paxos.
        </li>
        <li>
          <strong>Deposit limits</strong>, each stablecoin 50,000 per deposit and
          2,500,000 in total; ETH 20 per deposit and 1,000 in total
        </li>
        <li>
          <strong>BDX</strong>, 100,000 per deposit and 2,000,000 in total, set through the
          vault&apos;s 3-day timelock. Add offers BDX once that limit is live on chain.
        </li>
      </ul>

      <h3>Integration notes for Ethereum</h3>
      <ul>
        <li>
          <strong>Gas.</strong> A private send costs about 1.9M gas and a cash
          out about 0.5M to 0.7M; a deposit, which you pay yourself, about 1.3M
          to 1.5M. The Gloam relay pays for relayed sends and cash outs, so
          while Ethereum gas is above {DEFAULT_MAX_GAS_GWEI[1]} gwei it waits
          and says so. A cash out for later still schedules and goes out once
          gas is back under that. With Hide my wallet off, your wallet sends
          and pays its own gas.
        </li>
        <li>
          <strong>USDT approvals.</strong> Tether&apos;s token refuses to
          change one non-zero approval into another, so a deposit after an old
          approval asks for two: one back to zero, then the exact amount.{" "}
          <code>approvalSteps</code> in the SDK gives the calls to send.
        </li>
        <li>
          <strong>Log reads.</strong> Most public Ethereum RPCs serve only
          recent logs or a few blocks a read. Gloam reads Ethereum through MEV
          Blocker (<code>https://rpc.mevblocker.io</code>), 10,000 blocks a
          read; use your own RPC if you sync often.
        </li>
        <li>
          <strong>EURC is a euro stablecoin.</strong> The app never counts it as
          a dollar.
        </li>
        <li>
          <strong>Issuer controls.</strong> Circle, Tether and Paxos can each
          freeze an address on their tokens. If one froze the vault itself, that
          asset would be frozen in the vault; other assets keep working.
        </li>
        <li>
          <strong>{swapV3Live(1) && ETHEREUM_MAINNET_MEMO ? "As on the other chains." : "Not on Ethereum yet."}</strong>{" "}
          {[
            ...(swapV3Live(1) ? [] : ["Private swaps."]),
            ...(ETHEREUM_MAINNET_MEMO ? [] : ["The payment-message board: until it is deployed, a payment there goes by claim link or sealed code."]),
          ].join(" ")}{" "}
          Bringing money over into Ethereum works, and Ethereum stays a chain you can bring money over from.
        </li>
      </ul>

      <h2 id="ethereum-sepolia">Ethereum Sepolia</h2>
      <p>
        Ethereum Sepolia is Ethereum&apos;s testnet. Gloam runs it like Base
        Sepolia: the mainnet vault (<code>ShieldPoolPayments</code>, the
        ceremony&apos;s final keys, deposit limits and the 0.25% cash-out
        fee), deployed from the same address and nonce as the other chains,
        so the vault sits at the same address.{" "}
        {ETHEREUM_SEPOLIA
          ? "It is live in the app under Testnet."
          : "It is not deployed yet, so the app does not offer it. This section is what to expect."}
      </p>
      <ul>
        <li>
          <strong>Chain ID</strong>, 11155111
        </li>
        <li>
          <strong>RPC</strong>, <code>https://ethereum-sepolia-rpc.publicnode.com</code>
        </li>
        <li>
          <strong>Explorer</strong>, <code>https://sepolia.etherscan.io</code>
        </li>
        <li>
          <strong>Pool</strong>,{" "}
          {ETHEREUM_SEPOLIA ? (
            <>
              <code>{ETHEREUM_SEPOLIA.pool}</code>, deploy block <code>{ETHEREUM_SEPOLIA.deployBlock.toString()}</code>
            </>
          ) : (
            <>Not deployed yet</>
          )}
        </li>
        <li>
          <strong>Payment-message board</strong>,{" "}
          {ETHEREUM_SEPOLIA_MEMO ? <code>{ETHEREUM_SEPOLIA_MEMO.pool}</code> : <>Not deployed yet</>}
        </li>
        <li>
          <strong>Assets</strong>, Circle&apos;s test USDC and EURC, Paxos&apos;s
          test USDG and PYUSD ({ETHEREUM_SEPOLIA_TOKENS.map((t) => t.symbol).join(", ")},
          6 decimals each) and Sepolia ETH. Tether issues no USDT on Sepolia.
          Faucets are in the <Link href="/docs/testnet#ethereum">testnet guide</Link>.
        </li>
        <li>
          <strong>Deposit limits</strong>, each stablecoin 500 per deposit and
          25,000 in total; ETH 0.2 per deposit and 10 in total
        </li>
      </ul>

      <h3>Integration notes for Ethereum Sepolia</h3>
      <ul>
        <li>
          <strong>It runs the mainnet keys.</strong> Proofs for chain 11155111
          use the final keys, not the dev keys of the older testnets.
        </li>
        <li>
          <strong>Reads.</strong> publicnode is at the chain head but keeps
          only about the last 10,000 blocks of Sepolia (a day and a half), and
          rebuilding the vault tree needs every log since the deploy block.
          Tenderly&apos;s public gateway keeps the whole history but can trail
          the head by a minute or two. Gloam reads the head, receipts and
          recent logs from publicnode and older logs and state from Tenderly;
          the SDK&apos;s <code>gloamReadTransport(network)</code> splits reads
          the same way. Use your own RPC if you sync often.
        </li>
        <li>
          <strong>EURC is a euro stablecoin.</strong> The app never counts it as
          a dollar.
        </li>
        <li>
          <strong>Not on Ethereum Sepolia.</strong> Private swaps and bringing
          money over from another chain. Payments, payroll, payment requests,
          claim links and proofs work as on the other chains.
        </li>
      </ul>

      {ELYSIUM_FLAG && (
        <>
          <h2 id="elysium">Elysium</h2>
          {ELYSIUM ? (
            <>
              <p>
                Elysium is Kinetiq&apos;s Hyperliquid L2, an Arbitrum Orbit chain
                that settles to HyperEVM, with HYPE as its gas coin. Gloam on
                Elysium mainnet is the same vault as on the other mainnets:{" "}
                <code>ShieldPoolPayments</code>, the ceremony&apos;s final keys,
                deposit limits and the {CASH_OUT_FEE_PERCENT} cash-out fee. One thing is new: its
                owner is a <code>VaultOwnerGuard</code> from the deploy itself, so
                its proof checkers can never be replaced and its ownership can
                never move.{ELYSIUM_TESTNET ? " Its testnet is below." : " There is no Gloam testnet on Elysium yet."}
              </p>
              <ul>
                <li>
                  <strong>Chain ID</strong>, {ELYSIUM.chainId}
                </li>
                <li>
                  <strong>RPC</strong>, <code>{ELYSIUM_RPC_DISPLAY}</code>
                </li>
                <li>
                  <strong>Explorer</strong>, <code>{ELYSIUM.explorerUrl}</code>
                </li>
                <li>
                  <strong>Pool</strong>, <code>{ELYSIUM.pool}</code>, from block{" "}
                  <code>{ELYSIUM.deployBlock.toString()}</code>
                </li>
                <li>
                  <strong>Payment-message board</strong>,{" "}
                  {ELYSIUM.payMemo ? <code>{ELYSIUM.payMemo.address}</code> : <>Not deployed yet</>}
                </li>
                <li>
                  <strong>Assets</strong>, USDC ({ELYSIUM.usdcDecimals} decimals). HYPE, the gas
                  coin, is not listed.
                </li>
                <li>
                  <strong>Deposit limits</strong>, 500 USDC per deposit and 25,000 in total at
                  launch, raised only through the vault&apos;s 3-day timelock
                </li>
                <li>
                  <strong>Bring money over</strong> into Elysium USDC from other chains through
                  Relay, or swap HYPE into USDC on Elysium. Private swaps are not on Elysium yet.
                </li>
              </ul>
            </>
          ) : (
            <p>
              Coming. Elysium is Kinetiq&apos;s Hyperliquid L2, with HYPE as its gas
              coin. Gloam plans to support Elysium mainnet from the day it
              launches, on the same vault and keys as the other mainnets, with
              USDC first. It is not live yet, so the app does not offer it. Its
              chain ID, RPC, pool and assets go here once the vault is deployed.
            </p>
          )}
        </>
      )}

      {ELYSIUM_TESTNET_FLAG && (
        <>
          <h2 id="elysium-testnet">Elysium testnet</h2>
          <p>
            {ELYSIUM_TESTNET
              ? "Elysium's testnet runs like Base Sepolia: the mainnet vault, owned by a VaultOwnerGuard from its deploy, on the ceremony's final keys, with test USDC only and gas in test HYPE."
              : "Coming: Elysium's testnet, run like Base Sepolia on the mainnet vault and keys, with test USDC. Its pool goes here once it is deployed."}
          </p>
          <ul>
            <li>
              <strong>Chain ID</strong>, 99801
            </li>
            <li>
              <strong>RPC</strong>, <code>{ELYSIUM_TESTNET?.rpcUrl ?? "https://testnet-rpc.elysium.kinetiq.xyz"}</code>
            </li>
            <li>
              <strong>Explorer</strong>, <code>https://elysium.kinetiq.xyz/testnet-explorer</code>
            </li>
            <li>
              <strong>Test USDC</strong>, <code>0x7D29d8047B905000459c0E80c34a26CeedcB47b2</code> (6 decimals)
            </li>
            {ELYSIUM_TESTNET && (
              <li>
                <strong>Pool</strong>, <code>{ELYSIUM_TESTNET.pool}</code>, from block{" "}
                <code>{ELYSIUM_TESTNET.deployBlock.toString()}</code>
              </li>
            )}
            <li>
              <strong>Blocks</strong>, about every 100 ms. The public RPCs cap a log read at 10,000 logs, not at a
              block range.
            </li>
          </ul>
        </>
      )}

      <h2>Switching networks in the app</h2>
      <p>
        The network selector in the app header lists every Gloam network and
        marks each one Mainnet or Testnet. The selector points the app at that chain&apos;s
        pool, explorer and, on a testnet, its faucet. The registry lives in one
        place (<code>networks.ts</code>) so the same shield, private send, cash
        out, and selective-disclosure flows run against whichever chain is
        active. Test funds never move to mainnet.
      </p>

      <h2>Honest status</h2>
      <p>
        Mainnet is live on all {liveMainnetCountWords().split(" ")[0]} chains. It uses
        the final keys from the multi-party ceremony that closed on 17 October
        with 13 contributors, and deposit limits cap what the pools take.
        The code was reviewed internally before launch; that review finished on
        20 October with no Critical or High findings open. Kann Audits then
        reviewed the vault contracts (<Link href="/security">report, 1 November 2026</Link>) and found no Critical, High
        or Medium issues; the swap routers, circuits, app and relay were not
        part of it. The mainnet pools are new, so their anonymity set is
        thin at first. The testnets run on development keys with test funds, and
        stay open for practice. See the{" "}
        <Link href="/docs/production">production gate</Link> for what is done
        and what is still ahead.
      </p>
    </DocsLayout>
  );
}
