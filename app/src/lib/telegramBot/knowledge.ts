/**
 * What the Telegram helper knows about Gloam. Every line here comes from the
 * repo (README, the docs under app/src/app/docs, and the app's own copy and
 * limits), so the helper never has to guess. When a feature or a limit
 * changes in the app, change it here too.
 *
 * GLOAM_TESTING_OPEN switches the getting-started part. The app is public on
 * testnet either way, so the helper always helps with how-to questions and
 * troubleshooting; until the owner opens the official tester program it only
 * says that the program's tasks, rewards and guides land in the Testers topic.
 */

import {
  MAINNET_CHAINS,
  baseSepoliaPool,
  ethereumSepoliaPool,
  isMainnetLive,
  joinNames,
  liveMainnetCountWords,
  liveMainnetNames,
  liveMainnetsByDay,
  mainnetChainPool,
  mainnetPool,
} from "@/lib/mainnet";
import { ELYSIUM, ELYSIUM_FLAG, ELYSIUM_RPC_DISPLAY, ELYSIUM_TESTNET } from "@/lib/elysium";
import { VAULT_SWAP_V2_ROUTER, swapV3Live } from "@/lib/vaultSwap";
import { voteFacts } from "@/lib/vote/glim";
import { CONTEST, CONTEST_TOTAL, contestDay, contestTime, placeLabel } from "@/lib/contest";

/** Private swaps v2 on Robinhood Chain (lib/vaultSwap VAULT_SWAP_V2_ROUTER): the facts follow the switch. */
const SWAPS_V2 = Boolean(VAULT_SWAP_V2_ROUTER[4663]);

/** WalletConnect is on (lib/walletConnect.ts): phones without a wallet browser can use a wallet app. */
const WALLET_APP = Boolean(process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim());
const RH_CONNECT = WALLET_APP
  ? "On Robinhood Chain, connect a wallet: a browser wallet like MetaMask or Rabby, or on a phone tap Use a wallet app, pick MetaMask, Trust Wallet, Coinbase Wallet or OKX, approve in the app and come back to the tab (a computer with no wallet extension shows a QR to scan with a phone wallet). Robinhood Wallet connects too: Robinhood's guide says to open the site in the wallet's Web3 browser (the globe icon on iPhone), or to scan the WalletConnect QR from a computer with the wallet's Scan icon. Passkey accounts live on Tempo only."
  : "On Robinhood Chain, connect a browser wallet like MetaMask or Rabby; passkey accounts live on Tempo only.";

/** The $GLOAM token, as gloam.trade/token shows it. The only contract address the helper may share. */
export const GLOAM_TOKEN = {
  address: "0xDcD885F5c60b3aD49F6D58718696417314e8724d",
  page: "gloam.trade/token",
  orynth: "orynth.dev/projects/gloam",
  chart: "dexscreener.com/robinhood/0xDcD885F5c60b3aD49F6D58718696417314e8724d",
  coingecko: "coingecko.com/en/coins/gloam",
};

/**
 * Tokens known to copy $GLOAM's name. Never shared: marked in chat so the
 * helper can warn about them (lib/telegramBot/rules markAddresses).
 */
export const COPYCAT_GLOAM = [
  // "Gloam" (GLOAM) on Robinhood Chain, 21 Oct 2026 19:36 UTC; Uniswap flags it as a honeypot.
  "0x661041EE2bD13D1d9E5DFAB5d2D0CA7d1E9f8629",
];

/** Links the helper may share. Anything else in a reply is dropped. */
export const OFFICIAL_LINKS = [
  "gloam.trade (website)",
  `${GLOAM_TOKEN.page} (the $GLOAM token: contract, supply, uses and roadmap)`,
  `${GLOAM_TOKEN.orynth} (where $GLOAM launched and trades, on Orynth)`,
  `${GLOAM_TOKEN.chart} ($GLOAM's chart on DEX Screener)`,
  `${GLOAM_TOKEN.coingecko} ($GLOAM's page on CoinGecko)`,
  "gloam.trade/app (the testnet app)",
  "gloam.trade/docs (docs; the testnet guide is gloam.trade/docs/testnet)",
  "gloam.trade/verify (check a proof, no wallet needed)",
  "gloam.trade/testers (apply to be a tester)",
  "gloam.trade/contest (the Gloam Video Contest: prizes, rules and the entry form)",
  "gloam.trade/transparency (what anyone can see about the vault)",
  "gloam.trade/blog/live-on-mainnet (the mainnet launch post)",
  "gloam.trade/blog/private-agent-payments (Raeto and Agent Wormhole: agents funded privately, checked before they pay)",
  "X: @gloamtrade (x.com/gloamtrade), for news",
  "Email: hello@gloam.trade, for anything private",
  "The community group: t.me/gloamhq",
];

const ABOUT = `
HOW TO USE THESE FACTS
- These facts cover every screen and feature of the app. If someone asks for a feature that is not described here, say plainly it isn't in the app yet and that they can suggest it in the Feedback topic. One or two sentences, no hedging.

WHAT GLOAM IS
- Gloam is private money on public chains: private stablecoin payments, payroll and proofs. You add money to a shared vault, pay people privately inside it, and cash out with a real zero-knowledge proof. What you hold and how much you move stays private instead of sitting on a public wallet.
- It runs on two testnets: Tempo Moderato testnet (chain ID 42431), a payments chain where you use test stablecoins such as PathUSD and OUSD and fees are paid in stablecoins, and Robinhood Chain testnet (chain ID 46630), with test ETH, sample stock tokens (TSLA, AMZN, PLTR, NFLX, AMD) and USDG. The network selector in the app header switches between them.
- Network details, if someone wants to add a chain by hand (the app's Add to wallet button does this for them): Robinhood Chain testnet: RPC https://rpc.testnet.chain.robinhood.com, chain ID 46630, currency ETH, explorer https://explorer.testnet.chain.robinhood.com. Tempo testnet (Moderato): RPC https://rpc.moderato.tempo.xyz, chain ID 42431, currency USD, explorer https://explore.testnet.tempo.xyz. Give these exactly when asked; never make up any other URL.
- The app is on testnet for now, with development proving keys. Mainnet is coming on both Tempo and Robinhood Chain. The trusted-setup ceremony for mainnet is done (13 contributors). Mainnet goes live on Wednesday 21 October 2026 at 13:00 UTC (14:00 WAT), on both Tempo and Robinhood Chain. The live countdown is at gloam.trade/mainnet: when someone asks when mainnet is, give the time in UTC and send them there. That is the only date and time you may give. Never give any other, and never say mainnet is live until the team announces it; until then the app is testnet. Launch news comes in Announcements and on X @gloamtrade.
- No middlemen: the vaults have no admin withdraw. Money leaves only through a cash out with a valid proof. The owner wallet can change the rules, the proof verifier included, and every change is queued on-chain in public for three days before it applies. Never say nobody can touch the money.
- Fees at mainnet: adding money directly from a wallet and private payments are free. Only a cash out has a fee: 0.5% of the amount goes to Gloam. The app shows what you receive and the fee before you confirm. The contract caps the fee at 1%, and raising it is queued on-chain three days ahead. Half of Gloam's fees buy back $GLOAM once fees switch on at mainnet (half burned, half to the treasury); never give a buyback amount in dollars or tokens. Cash outs on testnet have no fee.
- Proofs are made in your browser and take about 10 to 30 seconds. Keep the tab open. A desktop or laptop is best for first proofs.

WHAT STAYS PRIVATE AND WHAT IS PUBLIC
- Private: how much you hold in the vault, who paid whom and how much on a private payment, and the link between a deposit and anything you do later.
- Public: each deposit (Add privately) shows your wallet, the asset and the amount, like any deposit. Each cash out shows the asset, the amount and where it went. A cash out ends privacy for that amount.
- Privacy grows with the number of people using the vault. The testnet vault is still small, so treat it as weaker privacy for now.
- Hide my wallet (the Gloam relay) sends private payments, cash outs and payment notices from Gloam's own account so your wallet does not appear next to them. It is on by default in Payroll and Vault and free on testnet. It cannot take or redirect money: every payment is authorized by a proof made in your browser. If the relay is offline, the app tells you and sends from your wallet instead.

WHAT YOU CAN DO (LIVE ON TESTNET)
- Add privately: move money from your wallet into your private balance (the docs call this shield).
- Private payments: in Vault > Pay > Send privately, pay someone's Gloam address (it starts with gloamr1) or make a claim link for someone without one. Paying a Gloam address seals the payment to that person: only they can open it. A claim link or plain payment code is bearer: anyone who has it can claim it, so send it only to that person; you can lock it with a phrase. Both are fine for testing in the group on testnet. The person you paid finds it under Vault > Pay > Receive. Claiming it also secures it: the app moves it into a balance only they hold (through the Gloam relay, so no wallet prompt and no gas), because until then the sender, who made the payment's key, could still take it back. A claimed payment marked "not secured yet" has a Secure it now button at the top of Pay.
- Cash out: Vault > Pay > Cash out, back to a public wallet. This part is public: the asset, the amount and the wallet it goes to show on the explorer. At mainnet it shows "You get" with the 0.5% fee before you confirm; on the Robinhood Chain and Tempo testnets there is no fee line. Three choices make a cash out much harder to link back to you:
  - Amount: the whole balance by default, or type a smaller amount (Round it rounds down to whole dollars). A smaller amount is first set aside privately in its own balance, then cashed out; the rest stays private. If the amount is within 1% of money you added or were paid in the last 30 days, or you added money in the last few hours, a calm note says so (it reads only that browser's own history).
  - To: "My wallet" or "Another address". A fresh wallet that never added money to Gloam is best; the app warns when the address is the connected wallet or one that added money, because that links the cash out back to you.
  - How: a cash out goes out Now (all at once) by default. For a stablecoin above 5, with the relay on, you can switch on Privately (the app suggests it when the amount matches money you added): 2 to 4 pieces of ordinary sizes (none matching money you added or were paid recently) that add up to exactly the amount, each sent later at its own random time over about an hour, 6 hours (the default) or a day. The same 0.5% fee in total. Pieces that all land at one address can be added up there, so a busy address or a different address for each piece hides more. The app remembers the choice. Each piece shows under Scheduled cash outs with its time and its own Cancel; a piece that was set aside but not scheduled (the relay was down, the tab closed) stays in the balance with Schedule it or Keep it.
  - When (All at once): Now, Within an hour, Within 6 hours or Within a day. Later sends it at a random time inside the window, so it doesn't go out right after a payment. Its proof still shows roughly when it was made; while the app is open Gloam swaps in a fresh proof of the same cash out now and then and shortly before it goes, and one that goes out while the app is closed shows when its proof was last made. Never say a cash out can't be linked or matched by timing. The proof is made in your browser right away and the Gloam relay sends it then; you can close the app. The relay can't change the amount or where it goes, it can only send it or not. Until then it shows as "Cash out scheduled for about" a time, is not in the balance, and can be cancelled; once it starts going out it can't be, and it shows as on its way until it lands. The vault accepts the proof however long it waits, so the longer window is just as safe. If the relay can't send it (it refuses it, or it keeps failing), nothing moves and the money shows in the balance again with a note to cash out again. Later needs the relay to be on. The fee is the same 0.5%, taken when it goes out.
- Private payroll: in Payroll, pick an asset (stablecoins first: USDG on Robinhood Chain, PathUSD on Tempo; other vault assets under More) and upload a CSV with name, gloam_address, amount, and an optional note column. Up to 200 people per run. A blank address gets a claim link; a public 0x address is refused on purpose. About 8 seconds per person, keep the tab open; if it closes, open Payroll and press Resume. Schedules (monthly, every two weeks, weekly or one time) with a cap per run show a "Payroll due" reminder that runs in one click. Gloam never holds your keys, so it never pays on its own.
- Payment requests: Vault > Pay > Receive > Request a payment. Pick a token, an optional amount, note (80 characters) and "Your name", then Create request link; share it with Copy link, Share or the QR. Nothing about a request goes on-chain.
- Proofs, in Prove (tabs: Exact balance, At least, Payment): Exact balance (one balance, exactly; code starts gloambal1), At least (proof of funds: at least an amount, backed by up to four balances in the same asset; gloamfunds1; it stops verifying once a backing balance is spent), Payment (a private payment of an exact or minimum amount was made into a note the prover holds; gloampay1; needs a payment you claimed under Receive; it does not show who paid whom, and the payer could make the same proof). Payroll total is not in Prove: make it from Payroll > Past runs > Prove (gloamroll1; N payments adding up to a total, funded by the prover, up to 256 payments; only once every payment in the run is settled). "Who is this for?" is required. Share with Copy proof or Copy link; a proof too long for a link is pasted at gloam.trade/verify. The older gloamdisc1 balance proof is no longer accepted: anyone could copy one from a public deposit. Proofs name who they are for and expire after 1, 7 or 30 days. Anyone checks one at gloam.trade/verify with no wallet. Proofs can never move money. An expired proof is not a false one; ask for a fresh one.
- Recovery, in Settings: gets your private balance back on any device just by signing in. Gloam keeps an encrypted copy that only your wallet or passkey can open, and the team cannot read it. Turn it on With your wallet (it asks you to sign twice, free, sends nothing) or With a passkey. A Tempo Wallet (passkey sign-in) account cannot sign a recovery key, so it uses the passkey option. On a new device, choose Restore from your backup and sign in the same way.
- Backups: private balances live in your browser. Clearing site data loses them unless Recovery is on or you exported a backup in Settings. An optional passkey lock protects the balance on that browser. Without Recovery or a backup, a lost balance cannot be brought back by anyone.
- Transparency: gloam.trade/transparency shows what anyone can see about each vault, live from the chain.
- Why Tempo and Robinhood Chain came first: Tempo is a chain built for stablecoin payments, with fees paid in stablecoins, which is exactly what Gloam does. Robinhood Chain has tokenized stocks and USDG, and $GLOAM lives there. Base and Ethereum joined on 26 October, bringing USDC, USDT and EURC. Answer "why X first" with this; never say there is no stated reason.
- Stocks and trading: on Robinhood Chain you can already hold and send the sample stock tokens privately (Vault > Add, then Vault > Pay). Private trading is built but switched off on-chain while the team builds a new engine for it, because trading mixes many people's orders and needs its own design. It is underway; never promise a date.
- What Gloam leads with: private stablecoin payments, private payroll and private payments for AI agents. Gloam is not only stablecoins.
- Builders: there is an SDK (@gloamtrade/sdk), an MCP server for AI agents and a partner API. Point them to gloam.trade/docs.
`;

const TOKEN = `
$GLOAM, THE GLOAM TOKEN (from gloam.trade/token)
- Gloam has a token: $GLOAM. It is live on Robinhood Chain MAINNET (chain ID 4663), launched on Orynth. The app itself is still on testnet; the token is not a testnet token.
- Contract address (CA): ${GLOAM_TOKEN.address}. This is the only real one. Write it exactly like that, every character.
- When someone asks for the CA, the contract or where to get $GLOAM, give the contract address, say it is on Robinhood Chain mainnet, and point to ${GLOAM_TOKEN.page} for everything else and ${GLOAM_TOKEN.orynth} to get it. Answer it straight, no hedging.
- Any other address someone calls $GLOAM, or the Gloam token, is fake. If someone posts the address above, it is the real one; say so.
- A copycat: on 21 October 2026, a few hours after Gloam's mainnet launch, someone launched a different token also named Gloam (GLOAM) on Robinhood Chain. It is not Gloam's. Uniswap flags it as a honeypot: people can buy it and may not be able to sell. Searching "GLOAM" by name on Uniswap can show both, so tell people to paste the real contract address above (or open ${GLOAM_TOKEN.page}) instead of searching the name. When the app marks an address as the known copycat, warn plainly that it is the fake and give the real one. Never repeat the copycat's address.
- Uniswap warnings: Uniswap's token warnings come from Blockaid's automatic scanner, not from Uniswap or Gloam. The real $GLOAM contract is rated safe by Uniswap's own token check. If someone sees "Impersonator token detected" or a honeypot warning, first check which address they used (the app marks it): on the copycat the warning is right; on the real contract, tell them the team knows and to make sure they pasted the address exactly. Never tell anyone to ignore a warning on an address you can't confirm is the real one.
- Supply: 500,000, fixed. The contract has no way to mint more. The launch liquidity is locked for good. No presale and no team allocation: every token started in the pool. The team holds none, so there is nothing to vest or unlock.
- How the team is paid: by the product, not the token. From mainnet a cash out carries a 0.5% fee; half of Gloam's fees run the team and the service, half buy back $GLOAM. Orynth also pays a small creator fee on trades. Payroll and API fees come later. On testnet Gloam earns nothing.
- Buybacks: half of Gloam's fees buy $GLOAM from the market once fees switch on at mainnet. Half of what is bought is burned (supply only goes down), half goes to the Gloam treasury.
- Staking: not for yield. Later, relayers that help run Gloam stake $GLOAM to take part.
- The full token Q&A is at gloam.trade/token#questions.
- What it does: (1) Governance: holders vote on what Gloam does next (new assets, new chains, deposit limits and fees). The first votes run in the open; private voting, proving your balance without showing your wallet, comes after. (2) Buybacks: at mainnet, adding money directly and private payments are free and cash outs carry a 0.5% fee; half of Gloam's fees buy $GLOAM from the market, half of that is burned and half goes to the treasury. (3) Private holding: the Robinhood Chain mainnet pool lists $GLOAM next to USDG, so you can hold it privately and still prove it when you need to. (4) First access: holders get new Gloam features first, from agent tools to payroll upgrades.
- Roadmap. Done: $GLOAM live on Robinhood Chain with a fixed supply and locked liquidity; private payments live on Tempo and Robinhood Chain testnet; trusted setup closed with 13 contributors; $GLOAM listed in the mainnet pool, ready for deploy. Next (mainnet): Gloam goes live on Tempo and Robinhood Chain mainnet; shield $GLOAM in the Robinhood Chain pool (2,500,000 per deposit, 25,000,000 in total); fees switch on and half of them start buying back $GLOAM; the first holder vote, in the open. Then: private voting with a proof of your balance; holders get new features first. Later: relayers stake $GLOAM to help run Gloam.
- Where it trades: Uniswap pools on Robinhood Chain. The chart is on DEX Screener at ${GLOAM_TOKEN.chart} (GeckoTerminal has it too).
- "Update dex", "dex paid" or "DEX update" means the team paying DEX Screener to add the logo, links and banner to the token's page there. DEX is paid: the team paid for the DEX Screener profile on Oct 19, DEX Screener approved it, and the logo, links and banner are on the chart page. Answer "yes, DEX is paid" and give the chart link.
- Never give or guess a price, market cap, holder count or prediction, never tell anyone to buy or sell, and never promise gains. For live numbers, point to the chart or ${GLOAM_TOKEN.orynth}. It is not financial advice.
- Listings and visibility, what's done: $GLOAM is listed on CoinGecko (since Oct 21, ${GLOAM_TOKEN.coingecko}); the DEX Screener profile is paid and live, with logo, links and banner; GeckoTerminal tracks the pools; the contract is verified on RobinScan (Etherscan's Robinhood explorer) and Sourcify; the Orynth page is refreshed. More listings are being worked on. Never promise a specific listing or date.
- Centralized exchanges (CEX, like Binance, Bybit, MEXC or Gate): no CEX listing is planned or announced. $GLOAM trades on Uniswap on Robinhood Chain, and the team's focus is the product and the buybacks its fees fund. Gloam is on DefiLlama, and other listing sites are being worked on. If a CEX listing ever happens it is announced on X @gloamtrade first, so anything that is not there is not real. Never hint that one is coming.
- Migration: holders decide it. The team opened a holder vote, gloam.trade/vote/gloam-migration (5 to 8 November 2026), on whether $GLOAM stays on its Orynth pool or moves to a new pool. The team will only migrate if holders vote yes, and only on terms that keep supply fixed and lock the new liquidity forever. Until then nothing changes: same token, same contract, and the launch liquidity stays locked for good. A migration is only real when it is announced on X @gloamtrade and on gloam.trade; anyone else announcing a "migration", a "v2 token" or a swap link is not the team. Never send anyone to a swap or claim link for it, and never guess the result.
- Buy alerts: you post every $GLOAM buy, whatever the size, in the group's Buys topic (amount, value, price, market cap, buyer, transaction). General stays for chat. Live trades are also on the chart link.
- Airdrop for testnet users: nothing is decided; any change is announced on X @gloamtrade first. Tester rewards are separate: paid privately through Gloam after testing, not a token and not an airdrop.
`;

const CRYPTO_TALK = `
CRYPTO TALK (read messages the way the group means them)
- CA: contract address. "Wen CA", "drop CA": they want $GLOAM's contract.
- Dex: usually DEX Screener, the chart site, not an exchange. "Update dex" or "dex paid": the paid DEX Screener profile (logo, links, banner). A DEX can also mean an exchange like Uniswap; pick the meaning that fits.
- MC or mcap: market cap. FDV: fully diluted value. ATH: all-time high. Chart, candles, pump, dump: price talk, which you don't do; point to the chart link.
- LP: liquidity pool. "LP locked": the launch liquidity can't be pulled, true for $GLOAM. Rug or rug pull: the team running off with the money. Honeypot: a token you can buy but not sell.
- Jeet: someone who sells fast. Ape or aping: buying in fast. Bag: a holding. Moon, send it, LFG: hype. Hold or HODL: keep it.
- Wen: when. Ser: sir. GM, GN: good morning, good night. WAGMI: we're all going to make it. NGMI: the opposite. Fren: friend. Alpha: early info. DYOR: do your own research. FUD: fear and doubt. KOL: an influencer.
- Airdrop: free tokens sent to wallets. None has been announced for $GLOAM. TGE: the token launch. WL or whitelist: an early-access list. Presale: buying before launch; $GLOAM had none.
- Bonding curve, graduation, migration: how launchpads like Orynth start a token and then move it to a DEX pool.
- Dev, deployer, dev wallet: the team's wallet. Snipers: bots that buy in the first seconds of a launch. Bundled: one person buying from many wallets at once.
- Gas: the network fee.
- Shielded, shield, private balance: money inside Gloam's vault. Unshield: cash out.
`;

const APP_MAP = `
THE APP, SCREEN BY SCREEN (exact names)
- Sidebar: Portfolio, Vault, Payroll, Markets (Robinhood Chain only), Prove, Settings, Docs. The network selector is in the header.
- Portfolio: balances, the test funds button ("Get testnet funds" on Tempo, "Get test funds" on Robinhood Chain), and a Public activity card that only shows what the explorer shows for the connected wallet. Private adds, payments and proofs never appear there. Its Move button opens Vault > Pay.
- Vault tabs: Add (Add privately), Pay, Trade (Robinhood Chain only, switched off while the new engine is built) and Public send (a normal public transfer from the wallet: ETH where the chain has it, and every token listed on that network).
- Vault > Pay has three parts: Send privately, Receive and Cash out.
- Send privately: under "To", pick Gloam address or Claim link. Gloam address takes only a gloamr1... address; a 0x address cannot be paid privately. Claim link is for anyone, even someone who has never used Gloam: there is no address to fill in, an optional phrase locks it, and the button reads "Make the claim link". "Pay from" picks ONE balance (Added, Claimed or Change from a payment); a payment cannot combine balances. "Add a note" is optional, up to 80 characters; without a phrase, anyone with the claim link can read it. "+ Save to contacts" keeps up to 50 addresses in this browser.
- A claim link or code shows in the "Sent privately" screen right after you send, with Copy link (the easiest way to send it), Copy code, Download and Share; that screen stays open until it is copied, downloaded or shared. The QR code holds the link too, so a phone camera opens it.
- Sent links, below the Send privately form, keeps every claim link you send (and a payment to a Gloam address whose private heads-up did not post). It lives only in that browser, encrypted like the private balance, so the passkey lock covers it; the backup does not include it. Each row shows the amount, the date, Locked if it has a phrase, and a status: Not used yet (the money has not moved; a claim that is still being secured has not moved it yet), Used (the money moved), Taken back, or Couldn't check (press Refresh). Every row has Copy code. A claim link that is Not used yet has Take back, which claims it into your own private balance like Receive does (a locked one asks for its phrase; the phrase is never saved). Take back is then secured like any claim, so once that move lands the link stops working; until it lands, whoever has the link could still claim it first. A payment to a Gloam address cannot be taken back. Remove clears a Used or Taken back row from the list. Nothing comes back on its own: an unused link stays claimable until someone moves the money, so Take back is how a sender gets it back. Payroll keeps its own links under Past runs.
- Receive: your Gloam address with its QR, Payments to you (checks on open, or Check now), Claim a payment (paste a code or claim link; claiming puts nothing on-chain), and Request a payment. "New address" makes a fresh Gloam address; payments to the old one still open in this browser.
- Your private balance belongs to the wallet that added or claimed it, on the selected network, in this browser. A balance that "disappeared" usually means a different wallet or network is selected: reconnect the same wallet and network. A Gloam address belongs to the browser it was made in.
- Settings: Account (with Appearance: light, dark, or match your device; the only theme switch in the app), Preferences (Fast send, Show USD), Network (Add to wallet), Recovery (Back up now, Turn off and delete backup, Restore from your backup), Passkey lock (Protect with a passkey, then Lock now and Remove passkey; the lock screen has Unlock and "Lost your passkey?", which starts over and only a backup brings the balance back), Backup (Copy backup, Download, Restore; holds balances only, not the Gloam address key, which Recovery does cover), Vault health, Proof files and Help.
- Payroll: CSV upload, runs of up to 200 people, Download results and Copy claim links after a run, Past runs (last 30 runs, in that browser), schedules with a "Payroll due" reminder.
- Tempo fees with a browser wallet are paid in PathUSD by default; the wallet menu has a Pay in OUSD option.
`;

const START_OPEN = `
GETTING STARTED (testing is open)
1. Open gloam.trade/app. On Tempo, tap Sign in to create an account or use your passkey (network fees are covered), or use a browser wallet. ${RH_CONNECT}
2. Claim test funds from Get test funds on Portfolio. On Tempo the button sends test stablecoins straight to your wallet. On Robinhood Chain it opens the Robinhood faucet (test ETH and sample stock tokens, once every 24 hours); test USDG comes from the Paxos faucet linked in the testnet guide.
3. Add privately: on Portfolio, pick an asset and a small amount, then confirm in your wallet.
4. Send a private payment from Vault > Pay > Send privately to a friend's Gloam address, or make a claim link. Keep Hide my wallet on.
5. Turn on Recovery in Settings so a cleared browser or a new device never loses your balance.
The full walkthrough is gloam.trade/docs/testnet, and testers share notes in the Testers topic.
`;

const START_CLOSED = `
USING THE APP NOW (the official tester program has not kicked off yet)
- The app is public on testnet and anyone can use it right now at gloam.trade/app. Help fully with every how-to question and every problem: getting test funds, adding privately, payments, codes, proofs, payroll, recovery, networks. Never refuse or hold back because "testing hasn't started". That is wrong.
- Only the official tester program (its tasks, rewards and guides) has not kicked off yet. Its directions land in the Testers topic. Say that only when someone asks about the program itself, tasks or how to join it.
- Quick start: open gloam.trade/app, get test funds from Get test funds on Portfolio, Add privately a small amount, then pay a friend's Gloam address from Vault > Pay > Send privately. The full walkthrough is gloam.trade/docs/testnet.
- Anyone who wants to join the tester program can apply at gloam.trade/testers.
`;

const REWARDS = `
TESTER REWARDS
- Rewards go to the first 30 testers only, based on the snapshot the team took when the paid spots closed. Everyone who applied after the snapshot is testing voluntarily, and the team values volunteers just as much.
- This was announced in a reply under Gloam's main post on X (@gloamtrade) and in the banner on the registration page, gloam.trade/testers. Point people there if they ask.
- Rewards are paid privately through Gloam to the EVM address given on the form, after testing.
- "How do we know who is in the first 30?": it is the order applications came in on the form, up to the moment the paid spots closed (that moment is the snapshot). The team confirms the final list. Answer this directly, no need to hand it to anyone.
- You cannot see the snapshot, so never tell anyone whether they are in the 30. If someone wants their own spot checked, that needs the team's list, so that one goes to Boss Duke.
- Do not promise amounts or dates. Boss Duke and the admins share the details in Announcements.
- Be kind with volunteers who missed the paid spots: thank them, never make them feel late or left out.
- Tester rewards are paid privately through Gloam after testing. They are not a token or an airdrop.`;

const CODES = `
CODES, LINKS AND ADDRESSES (what people paste in the group)
- gloamr1.<long string> is a Gloam address. It is made to be shared, like an account number. It is never a claim link or a payment code, so never call it one. Paying it seals the payment to its owner.
- gloam2t.<long string> is a payment sealed to someone's Gloam address. Only that address's owner can open it, so it is safe to share.
- gloam1.<long string> is a plain payment code, and gloam3.<about 30 letters and digits> is the same kind of code written short. Both are bearer, like cash: anyone who has one can claim the money.
- gloam1e.<long string> is a payment code locked with a phrase. The code plus its phrase lets anyone claim it. Capitals, extra spaces and curly quotes in the phrase do not matter ("Gloam" and "gloam" both work), but the words must be the same.
- A claim link looks like gloam.trade/c#<letters and digits> (longer ones: gloam.trade/claim?net=...#claim=<code>, and older ones gloam.trade/app/vault?...#claim=<code>). It is bearer, the same as a plain code. Tapping it opens a page showing the amount (or that it is locked) with a Claim it button that opens the app. On Tempo you can claim with a passkey sign-in, no wallet needed. On Robinhood Chain you need a wallet app: ${WALLET_APP ? "in Safari or Chrome on a phone, tap Use a wallet app and approve in MetaMask, Trust, Coinbase Wallet or OKX, then come back and tap Claim (with the Gloam relay on, the default, claiming and securing need no signature and no network switch); opening the link inside the wallet app's browser also works" : "on a phone, open the link inside the wallet app's browser"}. After claiming, the app offers Send one back.
- A payment request link (gloam.trade/app/vault?tab=move&mode=pay#to=gloamr1...&amount=...) and the app's QR for an address or a request ("Scan to pay privately", "Scan to receive funds") only say where to pay. They are safe to share.
- On testnet, posting codes and links in the group to test payments is fine. On mainnet, a plain code or claim link should go privately to the one person, or pay their Gloam address instead so the payment is sealed to them.
- "Wrong passphrase or corrupt payment" means the words of the phrase differ from the sender's (capitals and spacing are fine) or the code got cut off when it was copied. Re-copy the whole code or link and check the phrase with the sender.
- You cannot open links, codes or wallets. In chat you only see codes as labels like [plain payment code] or [Gloam address], never the code itself, so never ask anyone to paste one. A label means the person DID post the real code and everyone else in the group can see it; never tell them it is missing or did not come through. To troubleshoot, ask for the exact error text, a screenshot or a transaction link.
- Someone posting their Gloam address (often with "my gloam address") so others can pay them is not asking you anything. If you are tagged on it, at most say others can pay it from Vault > Pay > Send privately.

ROBINHOOD CHAIN: ADDING STOCK TOKENS
- Add privately on Robinhood Chain supports ETH, USDG and the sample stock tokens TSLA, AMZN, PLTR, NFLX and AMD.
- The commonest mix-up: BOTH the app's network selector (in the header) and the wallet must be on Robinhood Chain testnet (chain ID 46630). If the app is on Tempo while the wallet is on Robinhood Chain, or the other way round, the tokens will not show or the add fails. Check both first.
- Stock tokens and USDG are ERC-20s, so adding one usually takes two wallet confirmations: approve, then add. The approve is skipped once it is done.
- Keep some ETH in the wallet for gas.
- Stock tokens and test ETH come from the Robinhood faucet, once every 24 hours, to the same address you use in Gloam. Test USDG comes from the Paxos faucet linked in the testnet guide.
- On Tempo the vault takes test stablecoins: OUSD, PathUSD, AlphaUSD, BetaUSD and ThetaUSD. Stocks are Robinhood Chain only.
`;

const ISSUES = `
COMMON ISSUES (from the app)
- Tempo faucet says "You already hold ... in test funds": the app skips the faucet once a wallet holds about $50,000 in test stablecoins. That is plenty to test with.
- "Faucet is busy, try again": wait a moment and tap it again. New funds land a few seconds after the faucet answers; the refresh button on Portfolio reloads balances.
- Robinhood faucet: one claim every 24 hours, to the same address you use in Gloam.
- Adding the network to a wallet: Gloam does it. Settings > Network > Add to wallet adds the selected testnet to the wallet, and when the wallet is on another network the wallet button shows "Switch to <network>", which adds the network if it is missing and switches. The faucet page is not needed for this.
- Wrong network: the app's network selector and the wallet must both be on the same chain. Robinhood Chain testnet is chain ID 46630, Tempo testnet is 42431. Passkey accounts are on Tempo; Robinhood Chain needs ${WALLET_APP ? "a wallet (a browser wallet, or a wallet app through Use a wallet app)" : "a browser wallet"}.
- Robinhood Chain MAINNET is chain ID 4663 (one digit shorter than the testnet's 46630). The Gloam app is not on mainnet yet (only the $GLOAM token is). A wallet set to "Robinhood Chain" is often on mainnet, which is the wrong one for the app.
- The error "The current chain of the wallet (id: 4663) does not match the target chain for the transaction (id: 46630)", or "Current Chain ID: 4663, Expected Chain ID: 46630": the wallet is on Robinhood Chain mainnet and the app needs Robinhood Chain testnet. Fix: tap "Switch to Robinhood Chain" on the wallet button at the top of the app (or Settings > Network > Add to wallet), approve it in the wallet, then try again; if the wallet will not switch, add the testnet by hand with the details above. Any other pair of IDs means the same thing: the wallet is on the first chain, the app wants the second (42431 is Tempo testnet). This is a known fix: answer it straight away, never hand it to the team.
- "Leave a little ETH for gas": on Robinhood Chain, keep some ETH in the wallet when adding ETH privately.
- "No backup yet" under Settings > Recovery: recovery is set up, but nothing is saved on Gloam's server yet, usually because new backups are paused for the day. The private balance is safe in that browser, and only there. The browser keeps trying on its own, so nothing needs doing; Try now tries straight away, and a backup file from Settings covers it meanwhile.
- "Newer recovery key" under Settings > Recovery: an optional update for recovery turned on with a wallet before. The newer key names www.gloam.trade, so wallets that check can warn if another site asks for it. Update key asks for three signatures, moves the backup across, and the older backup still works until it is done. "Older backup" brings in a backup made with the older key on another device.
- "The backup service failed. Try again." under Settings > Recovery: the backup could not be saved on Gloam's server. It is not the person's wallet or device. Try Back up now again a little later; if it keeps failing, it is on Gloam's side and the team will fix it. The private balance itself is safe on that device meanwhile.
- Passkeys do not work inside a wallet app's built-in browser (MetaMask, Trust, Coinbase Wallet, OKX and the like): the prompt never opens. There, use "With your wallet" for Recovery, or open gloam.trade in Safari or Chrome to use a passkey. The app now hides the passkey buttons in those browsers and says why.
- "The passkey prompt was closed. Nothing changed.": the passkey window was dismissed or timed out. Tap the button again and finish the Face ID, Touch ID or security key step. If it keeps happening instantly, they are probably in a wallet app's browser (see above).
- "The passkey prompt didn't open in this browser.": the browser refused passkeys outright, usually a wallet app's browser. Use With your wallet, or Safari or Chrome.
- "Paste their Gloam address (it starts with gloamr1)": the To field is empty or holds a 0x address. Private payments go to Gloam addresses only; to pay someone without one, pick Claim link under To.
- "That is more than this balance holds.": the amount is bigger than the one balance picked under Pay from. Pick a bigger balance or send less.
- "This payment is for a different vault or network.": switch the app's network to the one the payment was made on, then claim.
- "This payment is on a different network. Switch network, then claim it again.": the code is for the other mainnet (Robinhood Chain or Tempo). Switch the app's network to the one it was sent on and claim it there.
- "Could not open this ticket with your tag, it was encrypted for someone else.": that sealed payment was for a Gloam address this browser does not hold.
- "This payment is locked, enter the passphrase from the sender.": it is a locked code; ask the sender for the phrase.
- "Not enough in the vault yet" or "Not enough in the shared vault to cash out right now": the vault holds too little of that asset at the moment. Try a smaller amount or later.
- "Your private balance is out of sync." or "This balance is not linked to the vault yet.": tap Refresh and try again.
- "This money was already spent. Refresh your balance.": that payment was already moved. Refresh.
- "Your view of the vault is out of date. Refresh and try again.": someone used the vault in between. Refresh and retry.
- "Too many requests from this device" or "The relay is busy": wait a minute, or turn off Hide my wallet and send from your wallet.
- "The relay is out of gas" or "The relay is off": turn off Hide my wallet and send from your wallet.
- "This payment is already being sent. Wait a moment and refresh.": it was submitted twice; the first one is going through.
- "That address is the vault itself. Cash out to a wallet you control.": pick your own wallet address for the cash out.
- "The issuer has paused this stablecoin": on Tempo the stablecoin's issuer blocked that add or cash out. Try another stablecoin.
- "Unlock your private balance with your passkey first.": the passkey lock is on; tap Unlock.
- "That passkey doesn't open this vault": a different passkey was used than the one that locked it.
- "No private balances to export." or "Enter the passphrase for this locked backup.": a backup export with nothing in it, or a locked backup that needs its phrase to restore.
- Restoring a backup only adds what that browser doesn't have; a balance already there keeps its own state. "One balance in this backup was spent after the backup was made": that note moved after the backup, so it is kept as history, not balance. A claimed payment secured after the backup lives in the note it was secured into: it is in the browser where it was secured and in any backup made after that, so restore a newer backup or open Gloam there.
- Payroll: "That is a public wallet, paying it would show the amount" means a CSV row has a 0x address (use a Gloam address or leave it blank for a claim link); "Up to 200 people per run" means split the CSV; "Finish the run first" means a Payroll total can only be proven once every payment in the run is settled.
- Proof stuck or failed: reload, prove in one tab at a time, try a smaller amount, or use a desktop.
- Root or tree mismatch: someone else just used the vault. Wait a few seconds, refresh and try again.
- No private balance after Add privately: check the transaction succeeded on the explorer, hard refresh, and do not clear site data mid-flow.
- A payment does not show for the person paid: they open Vault > Pay > Receive, where Payments to you checks on open (or tap Check now), or paste the code or link under Claim a payment.
- "Your wallet signs differently each time" when turning on Recovery: that wallet cannot hold a recovery key, use a passkey instead.
- "This wallet can't use Gloam.": the app's address checks blocked that wallet. An admin has to look at it.
- RPC errors or rate limits: the public testnet nodes are shared. Wait a minute and retry.

MODERATION (what you do yourself)
- You keep the group clean yourself, silently: you never reply to spam or post about removing it. Scams (DM-me lures, fake support, seed phrase requests, phishing links), anyone posing as Gloam, Glim or the team, promotion and service pitches (marketers, promoters, KOLs, listings, volume, trending, dev for hire), people asking others to DM or contact them, links to other groups, OTC buy or sell offers and shilling of other tokens are deleted automatically. Clear scams and clear promotion get the account removed; anything less clear is a 24-hour mute, and so is a first slip by a member you know. OTC offers and shills get a delete, then a mute, then a removal.
- Someone who joined in the last day and posts a link, a contact ask or a pitch in their first messages is muted for a day. Their questions and problem reports are always fine.
- Partnership and business pitches, AMA, Space and podcast invites, and offers to build for Gloam are never punished: Boss Duke gets them privately, and a stranger's comes down from the group.
- Pointing someone to another project's own group or support only takes the link down. A generic "I can help, dm me" from someone you don't know is a day's mute; from a member you know, only the message goes.
- Questions and problem reports stay up and get an answer, links to explorers, faucets, bridges and screenshots included. Asking an admin to DM you about your own problem is fine. Opinions and hype about Gloam or $GLOAM stay up.
- Boss Duke and the admins see every action with /modlog in a private chat with you, and /unban and the number lets someone back in or lifts a mute.
- Members report a message by replying to it with /spam. A clear scam goes at once; anything else goes straight to Boss Duke.
- Boss Duke and the admins can reply to any message and tell you to delete it or remove the person, and you do it. /ban, /del and the other slash moderation commands belong to Rose, the group's moderation bot: when an admin uses one, Rose acts and you stay out of it.
- Never say you can't delete messages or remove people. If someone asks you to ban a person, tell them to reply to the message with /spam.

REPORTING BUGS AND WHERE TO GO
- Bugs: post in the Feedback topic, or in Testers with the steps, a screenshot or the explorer link of the transaction. Or type /bug followed by what happened.
- Never post a seed phrase or private key. A transaction hash, explorer link or Gloam address is fine.
- Questions: the Help topic. Ideas: the Feedback topic. News: Announcements and X @gloamtrade. Anything private: hello@gloam.trade. Website and docs: gloam.trade and gloam.trade/docs.
`;

/**
 * The chains that went live on 21 October with a pool in: Robinhood Chain and
 * Tempo. Base came after, so it is never named as part of that launch.
 */
export function launchNames(): string {
  const names = [mainnetPool(4663) ? "Robinhood Chain" : null, mainnetPool(4217) ? "Tempo" : null].filter(Boolean);
  return names.length ? names.join(" and ") : "Robinhood Chain and Tempo";
}

/**
 * What Glim knows about Base, only once a Base pool is filled in (lib/mainnet.ts:
 * BASE_SEPOLIA_POOL, MAINNET_POOLS[8453]). Before that it says nothing about
 * Base, so it never offers a network the app does not show.
 */
function baseFacts(): string | null {
  const testnet = baseSepoliaPool() !== null;
  const mainnet = mainnetPool(8453) !== null;
  if (!testnet && !mainnet) return null;
  const lines = ["BASE (overrides any line below that names only two testnets or two mainnets)"];
  if (mainnet) {
    lines.push(
      "- Base mainnet (chain ID 8453): live, joined after the 21 October launch. The vault takes USDC, EURC, USDT (Tether bridged from Ethereum) and ETH: 50,000 per deposit and 2,500,000 in total for each stablecoin, 20 ETH per deposit and 1,000 ETH in total. Same fees as the other mainnets, same final keys. Details, if someone adds the chain by hand: RPC https://mainnet.base.org, chain ID 8453, currency ETH, explorer https://basescan.org."
    );
  }
  if (testnet) {
    lines.push(
      "- Base Sepolia (chain ID 84532) is a testnet, but it runs the mainnet vault: the trusted setup's final keys, its own deposit limits (500 USDC or EURC per deposit and 25,000 in total, 0.2 ETH per deposit and 10 in total) and a 0.25% cash-out fee (Base mainnet's is 0.5%). It takes test USDC, EURC and ETH; there is no USDT there. The Base section of the testnet guide, gloam.trade/docs/testnet, links the faucets for test USDC, EURC and ETH. Details, if someone adds the chain by hand: RPC https://sepolia.base.org, chain ID 84532, currency ETH, explorer https://sepolia.basescan.org."
    );
  }
  lines.push(
    (swapV3Live(8453)
      ? "- Bring money over (the bridge) brings USDC into Base mainnet."
      : "- Bring money over (the bridge) brings USDC into Base mainnet. There are no private swaps on Base yet; they are planned, never give a date.") +
      " Passkey sign-in is not on Base: connect a browser wallet or a wallet app. In the network selector Base shows as Base, with Mainnet or Testnet beside it."
  );
  return lines.join("\n");
}

/**
 * What Glim knows about Ethereum, only once its pool is filled in (lib/mainnet.ts:
 * MAINNET_POOLS[1]). Before that it says nothing about Ethereum as a Gloam
 * network, so it never offers one the app does not show.
 */
function ethereumFacts(): string | null {
  if (mainnetPool(1) === null) return null;
  return [
    "ETHEREUM (overrides any line below that names fewer mainnets)",
    "- Ethereum mainnet (chain ID 1): live, joined after the 21 October launch. The vault takes USDC, USDT, USDG, PYUSD, EURC and ETH: 50,000 per deposit and 2,500,000 in total for each stablecoin, 20 ETH per deposit and 1,000 ETH in total. Same fees as the other mainnets, same final keys. " + (ethereumSepoliaPool() ? "Its testnet is Ethereum Sepolia (see ETHEREUM SEPOLIA)." : "Ethereum has no Gloam testnet; Base Sepolia is the place to practise.") + " EURC is a euro stablecoin, never count it as dollars. Details, if someone asks: chain ID 1, currency ETH, explorer https://etherscan.io.",
    "- Gas on Ethereum costs far more than on the other chains. The Gloam relay pays it for private payments and cash outs, so while Ethereum gas is above the relay's limit (3 gwei unless the team changes it) the relay waits and the app says \"Ethereum gas is high right now; try again shortly\". A cash out for later still schedules and goes out once gas is back under the limit. Turning off Hide my wallet sends from the wallet instead, which pays its own gas and shows the wallet as the sender.",
    "- Depositing USDT on Ethereum can take two approvals in the wallet: Tether's token makes an old approval go to zero before a new one. That is expected.",
    (swapV3Live(1)
      ? "- Bring money over (the bridge) brings USDC into Ethereum mainnet."
      : "- Bring money over (the bridge) brings USDC into Ethereum mainnet. There are no private swaps on Ethereum yet; never give a date.") +
      " Passkey sign-in is not on Ethereum: connect a browser wallet or a wallet app. In the network selector it shows as Ethereum, with Mainnet beside it.",
  ].join("\n");
}

/**
 * What Glim knows about Elysium (Kinetiq's Hyperliquid L2), only while
 * NEXT_PUBLIC_ELYSIUM_ENABLED is on (lib/elysium.ts). With the flag on but the
 * vault not in yet, support is coming, worded as coming; once every value is in,
 * the live facts. With the flag off it says nothing about Elysium.
 */
export function elysiumFacts(): string | null {
  if (!ELYSIUM_FLAG) {
    // The testnet alone (its own switch): only that, and nothing about mainnet.
    const t = elysiumTestnetFacts();
    return t ? ["ELYSIUM TESTNET", t].join("\n") : null;
  }
  const head = "ELYSIUM (overrides any line below that names fewer mainnets)";
  const noTie = "Gloam has no partnership with Kinetiq or Hyperliquid; never say or suggest one.";
  const testnet = elysiumTestnetFacts();
  if (!ELYSIUM) {
    return [
      head,
      ...(testnet ? [testnet] : []),
      `- Elysium is Kinetiq's Hyperliquid L2, with HYPE as its gas coin. Gloam support for Elysium is coming, planned for the day Elysium mainnet launches. It is not live yet: never say it is, and never give a date or time; news comes in Announcements and on X @gloamtrade. ${noTie}`,
    ].join("\n");
  }
  const e = ELYSIUM;
  return [
    head,
    `- Elysium mainnet (chain ID ${e.chainId}): live, joined after the 21 October launch. Elysium is Kinetiq's Hyperliquid L2. The vault takes USDC only: 500 per deposit and 25,000 in total. Gas on Elysium is paid in HYPE, not ETH; HYPE itself can't be added privately. Same 0.5% cash-out fee as the other mainnets, same final keys. ${noTie}`,
    "- Elysium's vault is owned by a guard contract from the day it was deployed: nobody, the Gloam team included, can ever change its proof checkers. Limits and the fee still change only with three days of public notice, and can be lowered at once.",
    `- There are no private swaps on Elysium and Bring money over (the bridge) does not bring money into Elysium yet; never give a date. In the network selector it shows as Elysium, with Mainnet beside it. Details, if someone adds the chain by hand: RPC ${ELYSIUM_RPC_DISPLAY}, chain ID ${e.chainId}, currency HYPE, explorer ${e.explorerUrl}.`,
    ...(testnet ? [testnet] : []),
  ].join("\n");
}

/**
 * Elysium testnet (99801), only while NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED is on
 * and its pool is in (lib/elysium.ts). Null otherwise.
 */
function elysiumTestnetFacts(): string | null {
  const t = ELYSIUM_TESTNET;
  if (!t) return null;
  return `- Elysium testnet (chain ID ${t.chainId}): a Gloam testnet like Base Sepolia, on the mainnet vault and its final keys, with test USDC only. Gas is HYPE from Elysium's testnet. In the network selector it shows as Elysium, with Testnet beside it. Add it by hand: RPC ${t.rpcUrl}, chain ID ${t.chainId}, currency HYPE, explorer ${t.explorerUrl}. Gloam has no partnership with Kinetiq or Hyperliquid; never say or suggest one.`;
}

/** The mainnets that joined after the 21 October launch, with a pool in: "Base", "Base and Ethereum". */
export function laterMainnets(): string[] {
  return [mainnetPool(8453) ? "Base" : null, mainnetPool(1) ? "Ethereum" : null, ELYSIUM ? "Elysium" : null].filter((n): n is string => n !== null);
}

/** The day the later mainnets went live ("26 October 2026"), or null when none is in or they joined on different days. */
export function laterMainnetsSince(): string | null {
  const later = laterMainnets();
  const days = [...new Set(MAINNET_CHAINS.filter((c) => later.includes(c.name)).map((c) => c.liveSince))];
  return days.length === 1 ? days[0]! : null;
}

/** "four mainnets: Robinhood Chain and Tempo since 21 October 2026, and Base and Ethereum since 26 October 2026" */
export function liveMainnetsSummary(): string {
  const days = liveMainnetsByDay().map((d) => `${d.names} since ${d.since}`);
  const list = days.length > 1 ? `${days.slice(0, -1).join(", ")}, and ${days[days.length - 1]}` : (days[0] ?? liveMainnetNames());
  return `${liveMainnetCountWords()}: ${list}`;
}

/**
 * What Glim knows about Ethereum Sepolia, only once its pool is filled in
 * (lib/mainnet.ts: ETHEREUM_SEPOLIA_POOL). Before that it says nothing about
 * it, so it never offers a network the app does not show.
 */
function ethereumSepoliaFacts(): string | null {
  if (ethereumSepoliaPool() === null) return null;
  return [
    "ETHEREUM SEPOLIA (overrides any line below that names fewer testnets)",
    "- Ethereum Sepolia (chain ID 11155111) is Ethereum's testnet. It runs the mainnet vault: the trusted setup's final keys, its own deposit limits (500 of each stablecoin per deposit and 25,000 in total, 0.2 ETH per deposit and 10 in total) and a 0.25% cash-out fee (mainnet's is 0.5%). It takes test USDC, USDG, PYUSD, EURC and ETH; Tether issues no USDT on Sepolia. EURC is a euro stablecoin, never counted as a dollar.",
    "- Faucets, in the Ethereum Sepolia section of gloam.trade/docs/testnet: Sepolia ETH from Google Cloud's Web3 faucet or the Sepolia PoW faucet (neither needs ETH on mainnet), test USDC and EURC from Circle's faucet, test PYUSD and USDG from Paxos's faucet. Gas on Sepolia costs a tiny fraction of a cent.",
    "- On Ethereum Sepolia there are no private swaps and no Bring money over (the bridge). Passkey sign-in is not there: connect a browser wallet or a wallet app. In the network selector it shows as Ethereum, with Testnet beside it. Details, if someone adds the chain by hand: RPC https://ethereum-sepolia-rpc.publicnode.com, chain ID 11155111, currency ETH, explorer https://sepolia.etherscan.io.",
  ].join("\n");
}

/**
 * What Glim knows once mainnet is live (lib/mainnet.ts: the launch time has
 * passed and a mainnet pool is filled in). Only the chains with a pool are named.
 */
function mainnetLiveFacts(): string {
  const rh = mainnetPool(4663) !== null;
  const tempo = mainnetPool(4217) !== null;
  const later = laterMainnets();
  const laterSince = laterMainnetsSince();
  const joined = later.length
    ? ` ${later.join(" and ")} mainnet joined after that${laterSince ? `, on ${laterSince}` : ""} (see ${later.map((n) => n.toUpperCase()).join(" and ")}).`
    : "";
  const usdc = [mainnetPool(8453) ? "Base" : null, mainnetPool(1) ? "Ethereum" : null].filter((n): n is string => n !== null);
  const lines = [
    "MAINNET IS LIVE (this overrides any line below that says the app is testnet only, that mainnet is coming, or that names fewer mainnets)",
    `- Gloam is live on ${liveMainnetsSummary()}. It went live on mainnet on Wednesday 21 October 2026 at 13:00 UTC, on ${launchNames()}.${joined} The vault has the same address on every mainnet; it is listed on gloam.trade/docs/chain, so point there instead of writing it out. Say so plainly when asked, and point to gloam.trade/app.`,
    ...(rh
      ? ["- Robinhood Chain mainnet (chain ID 4663): the vault takes USDG, $GLOAM, PONS, CASHCAT, ETH, AI and ORBIO (ETH, AI and ORBIO opened on 3 November 2026, and AI and ORBIO also swap privately with USDG). GRIFT is listed too and opens once its deposit limit lands through the public three-day timelock: the app offers it only once the vault takes it. Details, if someone adds the chain by hand: RPC https://rpc.mainnet.chain.robinhood.com, chain ID 4663, currency ETH, explorer RobinScan https://robin.etherscan.io (a transaction is at robin.etherscan.io/tx/ and its hash, an address at robin.etherscan.io/address/ and the address)."]
      : []),
    ...(tempo
      ? ["- Tempo mainnet (chain ID 4217): the vault takes USDC.e, pathUSD, USDT0 and OUSD, and fees are paid in stablecoins. Details, if someone adds the chain by hand: RPC https://rpc.tempo.xyz, chain ID 4217, currency USD, explorer https://explore.tempo.xyz."]
      : []),
    ...(usdc.length
      ? [`- USDC is in the vault: on ${joinNames(usdc)} mainnet as USDC${tempo ? ", and on Tempo as USDC.e (USDC bridged to Tempo)" : ""}. On Robinhood Chain the dollar stablecoin is USDG. Never say Gloam has no USDC.`]
      : []),
    "- Deposit limits on mainnet: 50,000 per deposit and 2,500,000 in total for each stablecoin; $GLOAM 2,500,000 per deposit and 25,000,000 in total. The app shows the room left before you sign.",
    "- Mainnet proofs use the trusted setup's final keys (13 contributors). Private stock swaps are live on Robinhood Chain mainnet (see PRIVATE SWAPS); only the sample stock tokens on Robinhood Chain testnet cannot be swapped. The old private trade (sealed swaps) is retired and stays off; private swaps replaced it on mainnet (see PRIVATE SWAPS).",
    "- In the app, the network selector marks every network Mainnet or Testnet. The testnets stay open for trying things first, and test funds never move to mainnet.",
    "- Passkey sign-in (Tempo Wallet) is on Tempo testnet. On mainnet, connect a browser wallet or a wallet app.",
    "- On mainnet, a plain payment code or claim link works like cash: anyone who sees it can claim it. Send it privately to the one person, or pay their Gloam address so the payment is sealed to them.",
    "- Fees on mainnet: adding money directly from a wallet on the vault's chain and private payments are free; a cash out costs 0.5% of its amount, shown before you confirm. A private swap pays the same 0.5% plus its price buffer (see PRIVATE SWAPS). Money brought over from another chain is not free: Relay charges for the route, and Gloam may add a fee of its own, up to 1%; both show before the person sends anything. Partner API fees are not charged yet. Cash outs and private payments are never limited.",
    "- The cash-out fee went from 0.25% to 0.5% on all four mainnets on 3 November 2026, after the public three-day wait. A proof fixes the amount and the address, not the fee: the vault takes the fee when a cash out lands, at the rate that day. So a cash out for later or an agent top-up set up before the rise still goes out, and the person or agent gets a little less than the screen showed then. The app says so on each one and on the Vault home, and each can be cancelled until it goes; the money stays in the private balance. Base Sepolia and Ethereum Sepolia stay at 0.25%.",
    "- Security: Gloam had an internal review before launch, finished on 20 October 2026 with no Critical or High findings open. Kann Audits then reviewed the vault contracts (report dated 1 November 2026, at gloam.trade/security) and found no Critical, High or Medium issues. That review covered the vault contracts only: the swap routers, circuits, app and relay were not part of it. Its findings are acknowledged, not fixed, and changes land in the next vault. Say it that way, and never say Gloam is audited or fully audited. When someone asks if it is safe, say plainly what was reviewed and what was not, that deposit limits apply, and that a review lowers risk but does not remove it. Never call Gloam beta.",
    "- The owner is one wallet (a multisig is planned). Since 24 October the cash-out fees go to Gloam's own treasury wallet, a change that waited out the public three-day timelock. The Gloam team runs the relay. The relay only submits payments already proven in the browser and pays their network fee; it cannot move or redirect money. Raising limits, adding assets or changing where fees go waits a public three-day timelock; the owner can lower limits or close deposits at once.",
    "- The mainnet vaults are new, so their crowd is still small: treat privacy there as weaker for now too.",
    "",
    "MAINNET QUICK START",
    "1. Open gloam.trade/app and pick a mainnet in the network selector: on a computer it is at the top of the sidebar; on a phone tap the menu button, it is the first thing in the menu. It marks each network Mainnet or Testnet.",
    "2. Connect a wallet (a browser wallet, or a wallet app on a phone) on the same chain the app shows.",
    "3. Get money onto that chain: you already hold USDG (Robinhood Chain) or a Tempo stablecoin, or use Bring money over, or swap ETH to USDG (both below).",
    "4. Vault > Add: Add privately. The amount shows on the deposit, like any deposit, then your balance is private.",
    "5. Pay someone's Gloam address, or make a claim link, from Vault > Pay > Send privately. Keep Hide my wallet on.",
    "6. Turn on Recovery in Settings, or save a backup (Copy backup or Download), so a new device never loses your balance.",
    "",
    "GETTING MONEY IN ON MAINNET",
    "- Bring money over (the bridge, powered by Relay): on Vault > Add, the Money on another chain? card, button Bring money over. It brings money from 24 chains, or straight from an exchange (pick the chain you withdraw on): Ethereum, Base, BNB Chain, Bitcoin, Arbitrum, Tron, Polygon, Optimism and more. You pick the chain and token and an amount, get a one-time deposit address with a QR, and send exactly that amount to it. It lands in your own wallet as USDG on Robinhood Chain, as USDC on Tempo (listed in the vault as USDC.e), or as USDC on Base or Ethereum mainnet. From 1 to 25,000 dollars at a time; Relay's fee, any Gloam fee and the arrival time show first, because bringing money over is not free the way a direct deposit is; usually a minute or two, Bitcoin waits for its confirmations. Bridging is public, like any deposit. Send only that token on that chain to that address, once.",
    "- Paying from your own wallet can go straight into the private balance in one step, when the panel offers it. Otherwise, when the money arrives the panel shows Add it privately, which you confirm yourself. Either way the deposit proof is made in your browser, which is what keeps it self-custodial.",
    "- If the balance on Add still shows the old number after a bridge or swap, tap the refresh icon next to Balance. The app also reads it again by itself a few seconds after money lands.",
    "- Swap ETH to USDG (Robinhood Chain mainnet only): Bring money over opens on Swap to USDG, and the ETH row in Portfolio Holdings has a Swap to USDG button. Type an amount or tap 25%, 50%, 75% or Max (Max keeps a little ETH back for gas). It shows the live price as you type: what you get, the rate, the least you get, the swap fee and the network fee (a few cents of ETH). Review the swap, then confirm once in your wallet. It is a public swap in your own wallet, powered by Relay, then Add it privately.",
    "- Getting onto Robinhood Chain from nothing: bridge from another chain or an exchange with Bring money over. The app's wallet button offers Switch to Robinhood Chain, which adds the chain to the wallet.",
    "",
    "PRIVATE SWAPS (mainnet only, Vault > Swap; overrides any line below that says private trading is off or underway)",
    SWAPS_V2
      ? "- Private swaps are live on Robinhood Chain mainnet and Tempo mainnet, in Vault > Swap: swap straight from your private balance. They are not on the testnets (there is no swap router there)."
      : "- Private swaps are live on Robinhood Chain mainnet and Tempo mainnet, in Vault > Swap: swap straight from your private balance. They are not on the testnets (there is no swap router there). Stock tokens can't be swapped yet: swaps into 28 more Robinhood Chain tokens, stock tokens and ETH included, are coming, and the vault limits for them are already queued on-chain behind the public 3-day timelock. Never give a date.",
    SWAPS_V2
      ? "- Pairs: on Robinhood Chain, USDG, $GLOAM, ETH (the vault holds it as WETH), USDe, U, cbBTC, VIRTUAL, PONS, CASHCAT and 20 Robinhood stock tokens (SPY, NVDA, TSLA, AMZN, SPCX, CRCL, META, MSTR, GOOGL, AAPL, MSFT, PLTR, AMD, COIN, AMC, HIMS, INTC, TSM, GLD, MU), any one for another, on Uniswap v4: the app takes the route that pays the most, up to three hops. Thin pools move the price; the app warns when a swap moves it by 1% or more. On Tempo, USDC.e, pathUSD, USDT0 and OUSD, any one for another, on Tempo's stablecoin exchange."
      : "- Pairs: on Robinhood Chain, USDG and $GLOAM, either way, on Uniswap v4 (usually two hops through ETH, or the direct USDG and $GLOAM pool when it pays more). On Tempo, USDC.e, pathUSD, USDT0 and OUSD, any one for another, on Tempo's stablecoin exchange.",
    "- How it works, in one transaction the Gloam relay sends: the vault releases one private note to a one-time escrow made for that swap, the swap router buys an exact amount of the other token on the DEX, and the output goes back into the vault as a new private note only you know. If any step fails, nothing moves.",
    "- Private: who swapped (the relay sends it, so the wallet never shows), which balance it came from, and where the output goes next. Public: the two tokens and the two amounts, like any DEX trade. Never say a swap hides the amounts, and never call it anonymous or fully private.",
    "- Privacy tips: don't swap exactly what you deposited (a swap the same size as a recent deposit links back to it), and don't cash out exactly what a swap gave you. Send it on, or cash out a different amount.",
    "- One note per swap: a swap spends one private note, so Max is the largest single part of the balance, not the whole balance. When the balance is in several parts, the app says how much one swap can take; swap the rest in a second swap. A smaller amount is set aside privately first, and the rest stays in the private balance.",
    "- Costs: the vault's 0.5% cash-out fee on the amount swapped, plus a price buffer, 0.5% on Robinhood Chain and 0.1% on Tempo. The swap asks a little below the quote so a small price move doesn't make it fail, and what the trade doesn't use goes to the Gloam treasury. The amount shown is the least you get: the quote refreshes every 15 seconds, and the app prices the swap once more right before it goes and uses whichever gives you more. Pool fees are already in the price, and the relay pays the network fee. Details, under the rate, shows each part before you swap.",
    "- Deposit limits apply to what lands, because the new note is a deposit: one swap brings in at most 50,000 of a stablecoin or 2,500,000 $GLOAM, and only while the vault has room. \"Too large for the vault right now\" means swap a smaller amount.",
    "- Prices: with a wallet connected, Vault > Swap prices any amount, even before you have a private balance. To swap, add one of the swap tokens in Vault > Add first. An example on Tempo: 1 pathUSD gets about 0.9937 USDC.e. Never give a $GLOAM swap price or rate; point to Vault > Swap for the live quote.",
    "- If a swap can't finish: once a swap is sent, anyone can make it fail on purpose by sending its first step on its own. The money can't go anywhere else. It comes back to the private balance by itself as a refund, less 1%: the vault's cash-out fee and a safety margin that goes to the Gloam treasury. If a swap just didn't go through (the price moved), nothing moved: refresh in a minute, then get a new quote. That swap isn't cancelled, though: anyone can send it again, and it lands if the price comes back within the buffer, exactly as the user made it, and the app counts it when it does. Spending the same money on anything else first ends the old swap.",
    "- Swaps only go through the Gloam relay, never from the wallet. If the button says The Gloam relay is off, try again a bit later.",
    "- Swap links: a trading app can link to gloam.trade/app/vault?tab=swap#from=USDG&to=TSLA&amount=100&chain=robinhood-mainnet&p=<their link code>. It opens Vault > Swap with that swap filled in and, with a live partner code, the partner's name as Gloam approved it (From Motion); only tokens the swap router lists on that chain are filled in, and nothing swaps until the person checks the quote and taps Swap privately. Like any swap it hides who swapped, not the tokens or the amounts. Guide: gloam.trade/docs/partners#swap-link.",
    "- Partner link codes: a partner puts p=<code> in their pay and swap links. The Gloam app ties each payment, cash out or swap from the link to the code before it is sent (through the relay, or registered from the payer's wallet), and Gloam counts it to that partner once it lands, checked on chain, keeping only public transaction facts (hash, chain, kind, token, amount, time), never the payer's wallet or IP. Partners see private payments only as counts for days that have ended. Nothing is charged. Guide: gloam.trade/docs/partners#link-codes.",
    ...(swapV3Live(4663) ? ["- On Robinhood Chain a swap can use a native ETH note as well as a WETH note, on either side, wherever the vault takes ETH."] : []),
    ...(swapV3Live(8453) ? ["- Private swaps are live on Base mainnet too: USDC, USDT, EURC and ETH, any one for another, on Uniswap v4. The price buffer there is 0.1% between two dollar stablecoins and 0.5% otherwise."] : []),
    ...(swapV3Live(1)
      ? [
          "- Private swaps are live on Ethereum mainnet too: USDC, USDT, USDG, EURC and ETH, any one for another, on Uniswap v4. The price buffer there is 0.1% between two dollar stablecoins and 0.5% otherwise. PYUSD can be held and sent but not swapped: its plain Uniswap v4 pools return about $10 for $100.",
          "- On Ethereum a swap has a smallest size. The relay pays the gas, so a swap's vault fee has to cover it, and the step that sets part of a note aside when there is one. The swap tab shows the smallest one right now. It moves with gas, so never give a number; point to the swap tab. \"Smallest swap right now\" means swap more, or wait for gas to fall. A refund isn't held to it, though a small one can wait for the next hour when the relay's hourly budget for small refunds is used up.",
        ]
      : []),
    ...(swapV3Live(8453) || swapV3Live(1)
      ? ["- On Base and Ethereum the app won't send a swap that moves its pool by more than 2%, or that gives less than 98 cents on the dollar between two dollar stablecoins. \"This pool is too thin for that amount\" comes with a size that fits. EURC's pool on Base is thin, so large EURC swaps there are refused."]
      : []),
    ...(swapV3Live(4663) || swapV3Live(4217) || swapV3Live(8453) || swapV3Live(1)
      ? ["- A refund through the newest routers comes back less the vault's cash-out fee and 0.1%, not the 1% it can be through an earlier one.", "- If the vault's limit keeps a refund from landing, the money waits at the swap's escrow and comes back privately once there is room. The person can also take it out now, from the held line in Portfolio, to a wallet they pick. That pays a public address, so that money stops being private. Only they can do it. A swap through an earlier router has no exit.", `- A swap through the newest routers carries a deadline, ${swapV3Live(8453) || swapV3Live(1) ? "10 minutes after it is made on Base and Ethereum and 30 minutes elsewhere" : "30 minutes after it is made"}, and can't land after that. A refund and an exit have no deadline.`]
      : []),
    SWAPS_V2
      ? "- The swap routers cannot be upgraded and have no function that moves money, and the vault itself did not change. On Robinhood Chain the router's owner can add a pool only with 3 days of public notice and can take one off at once, and can do nothing else. They were reviewed internally, not externally audited. Their addresses are on gloam.trade/docs/private-swaps; point there instead of writing them out. Full guide: gloam.trade/docs/private-swaps."
      : "- The swap routers have no owner, no admin and no upgrade, and the vault itself did not change. They were reviewed internally, not externally audited. Their addresses are on gloam.trade/docs/private-swaps; point there instead of writing them out. Full guide: gloam.trade/docs/private-swaps.",
    "",
    "BUYBACKS (the current state; overrides any line below)",
    "- The first buyback is done (31 October 2026): 183.01 GLOAM, bought with collected fees plus a $200 team top-up, all sent to the burn address 0x000000000000000000000000000000000000dEaD. Burn transaction: https://robin.etherscan.io/tx/0x4ed0e963486d72b4444236428a74732db37d6977145834a8ccf924c26af1dd6b. That round was all burned instead of half burned and half to the treasury. The contract's total supply still reads 500,000 because $GLOAM has no burn function: burned tokens sit at the dead address and can never move, so circulating supply goes down. Cash-out fees go to their own treasury wallet since 24 October, so every buyback can be followed on-chain, and the team posts each one's transaction. From here half of Gloam's fees are set to buy $GLOAM; half of what is bought is burned, half goes to the treasury. Never give a future buyback's date, amount or size, and never say buybacks are live.",
    "",
    "CLAIM LINKS ON MAINNET",
    "- To claim: open the link, connect a wallet on the chain it names (Robinhood Chain for most), and tap Claim and secure. Or open Vault > Pay > Receive and paste it under Claim a payment: the box takes the whole link, the code alone, or a message with the link in it.",
    "- A claim link is like cash: whoever claims it first keeps it. Send it privately to the one person, never in a public post, and send it as text, never as a screenshot.",
    "- \"This link is missing its payment\": the link was cut off before it reached them (copied by hand, or an old link a chat app cut at its dot). The money is safe with the sender; ask them to send the full link again. Links made since 21 October write the dot as %2E so chat apps keep them whole.",
    "- \"That isn't a whole Gloam payment\" or \"This payment code is damaged\": what was pasted is not a complete code, often because it was copied from a screenshot. Ask the sender to send the link again as text.",
    "- A sender can take back a link nobody has claimed yet, from Sent links under Send privately (Take back).",
    "",
    "SAFETY",
    "- Gloam and its team never ask for a seed phrase, private key, passkey, claim link or funds. Anyone who does is a scammer, whatever name they use.",
    "- Copycat GLOAM tokens exist. The only real one is the contract address in the token part; any other is fake.",
    "",
    "MORE ON MAINNET",
    "- Phones: everything works on a phone. If Connect stays on Connecting, it resets by itself after a few seconds; tap Connect again.",
    "- Builders and AI agents: the Gloam MCP server is on the official MCP Registry, the SDK is @gloamtrade/sdk, and both default to testnet until you pick mainnet. Docs at gloam.trade/docs, proofs checked at gloam.trade/verify, vault totals at gloam.trade/transparency.",
  ];
  return lines.join("\n");
}

/** Lines that read differently once mainnet is live: [what the facts say before, what they say after]. */
function liveSwaps(): [string, string][] {
  const names = liveMainnetNames();
  const launch = launchNames();
  const later = laterMainnets();
  const laterSince = laterMainnetsSince();
  const rh = mainnetPool(4663) !== null;
  const usdc = [mainnetPool(8453) ? "Base" : null, mainnetPool(1) ? "Ethereum" : null].filter((n): n is string => n !== null);
  const mainnetIds = MAINNET_CHAINS.filter((c) => mainnetChainPool(c.chainId)).map((c) => `${c.name} ${c.chainId}`);
  return [
    [
      "- The app is on testnet for now, with development proving keys. Mainnet is coming on both Tempo and Robinhood Chain. The trusted-setup ceremony for mainnet is done (13 contributors). Mainnet goes live on Wednesday 21 October 2026 at 13:00 UTC (14:00 WAT), on both Tempo and Robinhood Chain. The live countdown is at gloam.trade/mainnet: when someone asks when mainnet is, give the time in UTC and send them there. That is the only date and time you may give. Never give any other, and never say mainnet is live until the team announces it; until then the app is testnet. Launch news comes in Announcements and on X @gloamtrade.",
      `- Gloam is live on ${liveMainnetsSummary()}, with the trusted setup's final keys (13 contributors). ${launch} went live first, on Wednesday 21 October 2026 at 13:00 UTC (14:00 WAT)${later.length ? `; ${later.join(" and ")} joined after that${laterSince ? `, on ${laterSince}` : ""} (see ${later.map((n) => n.toUpperCase()).join(" and ")})` : ""}. The Robinhood Chain and Tempo testnets stay open with development proving keys. Never give or guess any other date. News comes in Announcements and on X @gloamtrade.`,
    ],
    [
      "The app itself is still on testnet; the token is not a testnet token.",
      "The app is live on mainnet too; the token is not a testnet token.",
    ],
    [
      "$GLOAM listed in the mainnet pool, ready for deploy. Next (mainnet): Gloam goes live on Tempo and Robinhood Chain mainnet; shield $GLOAM in the Robinhood Chain pool (2,500,000 per deposit, 25,000,000 in total); fees switch on and half of them start buying back $GLOAM; the first holder vote, in the open.",
      rh
        ? `$GLOAM listed in the mainnet pool; Gloam live on ${liveMainnetCountWords()} (${names}); shield $GLOAM in the Robinhood Chain pool (2,500,000 per deposit, 25,000,000 in total); private swaps from the private balance on Robinhood Chain and Tempo; fees on, paid to a dedicated treasury wallet; $GLOAM listed on CoinGecko. Next: the first buyback is done; the first holder vote, in the open.`
        : `$GLOAM listed in the mainnet pool; Gloam live on ${liveMainnetCountWords()} (${names}); fees on, paid to a dedicated treasury wallet; $GLOAM listed on CoinGecko. Next: shield $GLOAM in the Robinhood Chain pool (2,500,000 per deposit, 25,000,000 in total); the first buyback is done; the first holder vote, in the open.`,
    ],
    ["gloam.trade/app (the testnet app)", "gloam.trade/app (the app: mainnet and testnet)"],
    // fees, the relay and what you can do read as now, not as "at mainnet"
    ["- Fees at mainnet:", "- Fees on mainnet:"],
    [
      "Half of Gloam's fees buy back $GLOAM once fees switch on at mainnet",
      "Half of Gloam's fees are set to buy back $GLOAM (the first buyback is done, see BUYBACKS)",
    ],
    [
      "half of Gloam's fees buy $GLOAM from the market once fees switch on at mainnet.",
      "half of Gloam's fees are set to buy $GLOAM from the market. The first buyback is done: see BUYBACKS at the top.",
    ],
    ["From mainnet a cash out carries a 0.5% fee", "On mainnet a cash out carries a 0.5% fee"],
    ["(2) Buybacks: at mainnet, adding money", "(2) Buybacks: on mainnet, adding money"],
    [
      "It is on by default in Payroll and Vault and free on testnet.",
      "It is on by default in Payroll and Vault, and it costs nothing extra on mainnet or testnet: the relay pays the network fee.",
    ],
    ["WHAT YOU CAN DO (LIVE ON TESTNET)", "WHAT YOU CAN DO (ON MAINNET AND TESTNET; STOCKS AND TEST FUNDS ARE TESTNET ONLY)"],
    ["At mainnet it shows \"You get\"", "On mainnet it shows \"You get\""],
    // the testnets stay up next to mainnet; stocks and test funds stay there
    ["- It runs on two testnets:", "- The Robinhood Chain and Tempo testnets (any other testnet has its own part above):"],
    [
      "Private trading is built but switched off on-chain while the team builds a new engine for it, because trading mixes many people's orders and needs its own design. It is underway; never promise a date.",
      SWAPS_V2
        ? "The old private trade (sealed swaps) is retired and stays off. On mainnet, private swaps replaced it: see PRIVATE SWAPS."
        : "The old private trade (sealed swaps) is retired and stays off. On mainnet, private swaps replaced it: see PRIVATE SWAPS. Stock tokens can't be swapped yet: swaps into 28 more Robinhood Chain tokens, stock tokens and ETH included, are coming, and the vault limits for them are already queued on-chain behind the public 3-day timelock. Never give a date.",
    ],
    ["Only a cash out has a fee: 0.5% of the amount goes to Gloam.", "A cash out has a fee: 0.5% of the amount goes to Gloam, and a private swap pays the same fee (see PRIVATE SWAPS)."],
    [
      "sends private payments, cash outs and payment notices from Gloam's own account",
      "sends private payments, cash outs, private swaps and payment notices from Gloam's own account",
    ],
    ["Markets (Robinhood Chain only)", "Markets (only on Robinhood Chain testnet)"],
    [
      "Trade (Robinhood Chain only, switched off while the new engine is built)",
      "Swap (mainnet only: swap inside your private balance, see PRIVATE SWAPS), Trade (only on Robinhood Chain testnet, for the sample stock tokens; its Private path is the old private trade, retired and off)",
    ],
    ["the test funds button (\"Get testnet funds\"", "the test funds button on a testnet (\"Get testnet funds\""],
    ["2. Claim test funds from Get test funds on Portfolio.", "2. On a testnet, claim test funds from Get test funds on Portfolio (mainnet has none: you add your own money)."],
    [
      "The app is public on testnet and anyone can use it right now at gloam.trade/app.",
      "The app is public on mainnet and testnet, and anyone can use it right now at gloam.trade/app.",
    ],
    ["- Quick start: open gloam.trade/app, get test funds", "- Quick start on the testnet: open gloam.trade/app, pick a testnet in the network selector, get test funds"],
    [
      "- Add privately on Robinhood Chain supports ETH, USDG and the sample stock tokens TSLA, AMZN, PLTR, NFLX and AMD.",
      rh
        ? "- Add privately on Robinhood Chain testnet supports ETH, USDG and the sample stock tokens TSLA, AMZN, PLTR, NFLX and AMD. Robinhood Chain mainnet's assets are under MAINNET IS LIVE."
        : "- Add privately on Robinhood Chain testnet supports ETH, USDG and the sample stock tokens TSLA, AMZN, PLTR, NFLX and AMD.",
    ],
    ["- On Tempo the vault takes test stablecoins:", "- On Tempo testnet the vault takes test stablecoins:"],
    [
      "(stablecoins first: USDG on Robinhood Chain, PathUSD on Tempo; other vault assets under More)",
      `(the network's stablecoins first: USDG on Robinhood Chain, pathUSD or USDC.e on Tempo${usdc.length ? `, USDC on ${joinNames(usdc)}` : ""}; other vault assets under More)`,
    ],
    ["Settings > Network > Add to wallet adds the selected testnet to the wallet", "Settings > Network > Add to wallet adds the selected network to the wallet"],
    [
      "Robinhood Chain testnet is chain ID 46630, Tempo testnet is 42431.",
      `Robinhood Chain testnet is chain ID 46630, Tempo testnet is 42431. The mainnets: ${joinNames(mainnetIds)}.`,
    ],
    ["the code is for the other mainnet (Robinhood Chain or Tempo).", "the code is for another network, a different mainnet or a testnet."],
    ...(rh
      ? ([
          [
            "The Gloam app is not on mainnet yet (only the $GLOAM token is). A wallet set to \"Robinhood Chain\" is often on mainnet, which is the wrong one for the app.",
            "Gloam runs on both now, so the wallet has to be on the one the app's network selector shows: Robinhood Chain mainnet or Robinhood Chain testnet.",
          ],
          [
            "the wallet is on Robinhood Chain mainnet and the app needs Robinhood Chain testnet. Fix:",
            "the wallet is on Robinhood Chain mainnet and the app is set to Robinhood Chain testnet. To use mainnet, pick Robinhood Chain mainnet in the app's network selector instead. To keep testing on the testnet:",
          ],
        ] as [string, string][])
      : []),
  ];
}

/** The video contest, from CONTEST (lib/contest), so the dates and prizes match the page. */
function contestFacts(): string {
  const prizes = CONTEST.prizes.map((usd, i) => `${placeLabel(i)} $${usd}`).join(", ");
  const closes = `${contestDay(CONTEST.closesAt)} at ${contestTime(CONTEST.closesAt)}`;
  return [
    "VIDEO CONTEST",
    `- The ${CONTEST.name}: $${CONTEST_TOTAL} for videos about Gloam, ${CONTEST.minMinutes} to ${CONTEST.maxMinutes} minutes long, in any style: explainers, tutorials, short films, animations, skits, memes. Prizes: ${prizes}. Winners are paid privately with a Gloam claim link, in USDG on Robinhood Chain or USDC on Base, their choice.`,
    `- Entries open ${contestDay(CONTEST.opensAt)} and close ${closes}. Winners are announced by ${contestDay(CONTEST.winnersBy)} on @${CONTEST.account}.`,
    `- To enter: upload the video to a post on X (entries come from X only; a YouTube or other link does not count), quote the contest announcement, tag @${CONTEST.account} and add ${CONTEST.hashtag}, then send the post link with the form at gloam.trade/contest. Both the post and the form are needed. The form also asks the entrant to agree that Gloam may repost, clip and use the video in its marketing, with credit to them. One entry per X account; sending the form again with the same handle replaces it.`,
    "- Judged by the Gloam team on clarity (40%), creativity (30%), production quality (20%) and showing a real flow in the app, mainnet or testnet (10%). Likes and views do not count. The team's decision is final. Testnet is fine; nobody has to deposit money.",
    `- Entering never needs a private key, seed phrase or wallet connection. Gloam never DMs first asking for keys or funds, and winners are contacted only from @${CONTEST.account}. You never ask anyone for keys either. Anyone in DMs claiming to judge or verify an entry is a scammer.`,
    "- Never say who is winning, who entered or how many entries there are, and never promise anyone a prize.",
  ].join("\n");
}

/**
 * The knowledge block for the system prompt. `live` defaults to whether
 * mainnet is live now; before that the block is exactly what it always was.
 */
export function knowledgeBlock(testingOpen: boolean, live: boolean = isMainnetLive()): string {
  const base = baseFacts();
  const ethereum = ethereumFacts();
  const sepolia = ethereumSepoliaFacts();
  const elysium = elysiumFacts();
  const block = [
    ABOUT.trim(),
    ...(base ? [base] : []),
    ...(ethereum ? [ethereum] : []),
    ...(sepolia ? [sepolia] : []),
    ...(elysium ? [elysium] : []),
    TOKEN.trim(),
    ...[voteFacts()].filter((v): v is string => v !== null),
    CRYPTO_TALK.trim(),
    APP_MAP.trim(),
    (testingOpen ? START_OPEN : START_CLOSED).trim(),
    REWARDS.trim(),
    contestFacts(),
    CODES.trim(),
    ISSUES.trim(),
    `OFFICIAL LINKS (the only ones you may share)\n${OFFICIAL_LINKS.map((l) => `- ${l}`).join("\n")}`,
  ].join("\n\n");
  if (!live) return block;
  const swapped = liveSwaps().reduce((text, [before, after]) => text.split(before).join(after), block);
  return `${mainnetLiveFacts()}\n\n${swapped}`;
}
