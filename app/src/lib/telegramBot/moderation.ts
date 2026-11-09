/**
 * Spam screening for the Gloam group, as pure functions with no network calls:
 * what a message is (promotion or a service pitch, a contact ask, a link to
 * another group, an OTC offer, another token's shill, a scam, someone posing as
 * the team), how sure the rules are, and what happens to the sender.
 *
 * bot.ts reads the sender's standing from the store, asks the model only about
 * messages the rules find unclear (answer.spamCheck), and acts. Every action is
 * silent in the group: no reply, no warning, no hand-off, so a spammer never
 * gets the attention that brings more of them.
 *
 * Ordinary members say a lot that looks like spam out of context ("admin pls
 * dm me, my deposit is stuck", "Gloam team, when is Base live?", a Basescan or
 * Drive link with a bug). The rules here only act on unambiguous wording; a
 * ban needs a sure rule and a sender with no history, and on launch day almost
 * everyone has none, so anything less sure is a day's mute at most.
 * scripts/selftest-telegram.mts checks the rules, the false positives included.
 */
import { BRIDGE_CHAINS } from "@/lib/bridge";
import { MARKET_DEFS } from "@/lib/markets";
import { knownTokens } from "@/lib/tokens";
import { COPYCAT_GLOAM, GLOAM_TOKEN } from "./knowledge";
import {
  BUG_WORDS,
  EMAIL_RE,
  INVITATION,
  LINK_RE,
  PROBLEM_HINT,
  SAFE_HOSTS,
  askingForHelp,
  hostOf,
  linkAllowed,
  looksLikeQuestion,
  negated,
  norm,
  onHost,
  ownAddress,
  ownWords,
  plain,
  says,
  scorable,
  spellings,
  wordCount,
} from "./rules";
import type { TgEntity } from "./telegram";

export type SpamCategory = "scam" | "impersonation" | "link_spam" | "contact_spam" | "promo" | "otc" | "shill";

/**
 * What the screen decided and how sure it is. `rule` names the rule, or
 * "model:<why it asked>". `sure`: the wording is unambiguous scam or promotion,
 * the only kind of rule verdict that bans someone with no history.
 */
export type Verdict = {
  category: SpamCategory;
  confidence: number;
  rule: string;
  source: "rule" | "model";
  sure?: boolean;
  /**
   * A fixed outcome instead of the usual plan. "delete": the message goes and
   * nothing is held against them (someone pointing people at another project's
   * group or support). "soft": a generic "I can help, dm me" from someone Glim
   * doesn't know is a day's mute; from a member it knows, only the delete.
   */
  outcome?: "delete" | "soft";
};

/** Deleted and the sender banned (sure) or muted for a day; a member Glim knows gets the mute either way on a first offence. */
export const BAN_CATEGORIES: ReadonlySet<SpamCategory> = new Set<SpamCategory>(["scam", "impersonation", "link_spam", "contact_spam", "promo"]);
/** Deleted; a second offence in 24 hours is a 24-hour mute, a third in a week a ban. */
export const LADDER_CATEGORIES: ReadonlySet<SpamCategory> = new Set<SpamCategory>(["otc", "shill"]);

/** A model verdict acts only this sure. Rule verdicts are 0.85 and up by construction. */
export const MODEL_ACT_AT = 0.8;
export const MUTE_SEC = 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// ---------------------------------------------------------------- words

const CONTACT_VERB = String.raw`(?:d\.?\s?m|p\.?\s?m|inbox|message|msg|contact|text|ping|write\s+to|reach\s+out\s+to|reach)`;
/** A DM as a thing, not an ask: "I sent a DM to the bot", "my DM to Duke". */
const DM_NOUN = String.raw`(?<!\b(?:a|the|my|your|our|his|her|their|sent|send|got|get|no|any|in|via|by|first)\s+)`;
/** "DM me", "inbox us", "hit me up", "my DMs are open", "DM for details". */
const CONTACT_ASK = new RegExp(
  String.raw`\b${CONTACT_VERB}\s+(?:me|us)\b|\bhit\s+(?:me|us)\s+up\b|\b(?:send|drop|shoot)\s+(?:me|us)\s+(?:a\s+)?(?:dm|pm|message|msg|line|text)\b|\b(?:my|our)\s+(?:dms?|inbox|pms?)\s+(?:is|are)\s+open\b|\bdms?\s+(?:are\s+)?open\b|${DM_NOUN}\b(?:d\.?\s?m|p\.?\s?m|inbox)\s+(?:for\s|to\s+(?:get|buy|join|receive|claim|discuss|know|learn|order|book|start|apply|register))|${DM_NOUN}\b(?:d\.?\s?m|p\.?\s?m|inbox)\s+(?:collab\w*|partnership|promo\w*|details|business|deals?|offers?)\b`,
  "gi",
);
/** What a contact ask is for, when it says. Business, money and support offers are sure; "details" alone is not. */
const PURPOSE_SURE =
  /\b(?:for|to\s+(?:get|discuss|talk\s+about|know|learn|hear))\s+(?:more\s+|the\s+|a\s+|some\s+)?(?:business|deals?|offers?|collab\w*|partnership|promo\w*|listing\w*|marketing|prices?|rates?|services?|signals?|calls?|profits?|invest\w*|trading|opportunit\w+|hir(?:e|ing)|support|help|assistance|recovery|refunds?|airdrop\w*|whitelist\w*|allocation\w*|presale)\b/i;
const PURPOSE_SOFT = /\b(?:for|to\s+(?:get|know|learn|hear))\s+(?:more\s+|the\s+|some\s+)?(?:details?|info\w*|proposal|work|gigs?)\b/i;
/** Someone with a problem asking for help: their own deposit, balance or wallet, or the ask put to an admin. */
const SELF_PROBLEM = /\b(?:my|mine|i\s+(?:can'?t|cannot|still|have|got|lost|sent|tried|did|didn'?t|need)|i'?m\s+(?:stuck|having|not))\b/i;
const TO_TEAM = /\b(?:admins?|mods?|moderators?|support|team|boss|devs?|duke|glim|founder|owner)\b[^.!?\n]{0,20}$/i;
/** ...put as a request: "admin pls dm me", "abeg make admin dm me". "Gloam support, DM me" is not one. */
const REQUEST = /\b(?:pls|plz|please|abeg|kindly|make|can|could|would|help)\b/i;
/** A help OFFER, which is how the support scam goes: "I can fix it", "your wallet". */
const SUPPORT_OFFER =
  /\b(?:i|we)\s*(?:can|will|'ll|could)\s+(?:fix|help|solve|resolve|recover|assist|sort|restore|unlock|retrieve)|\b(?:can|will)\s+(?:fix|solve|resolve|recover|restore|unlock|retrieve)\b|\b(?:your|ur)\s+(?:deposit|wallet|funds|issue|problem|balance|account|tokens?|money|transaction|tx)\b/i;
/** "dm me your wallet / seed / keys / phrase": always the scam. */
const SECRET_PULL = /\b(?:your|ur)\s+(?:wallet|seed|keys?|phrase|private\s+key|recovery|mnemonic|secret)\b/i;
/** A help offer that names someone's funds or a fix: the support scam. A generic "I can help, dm me" is not this. */
const SUPPORT_SCAM =
  /\b(?:can|will|'ll|could)\s+(?:fix|solve|resolve|recover|restore|unlock|retrieve)\b|\b(?:your|ur)\s+(?:deposit|wallet|funds|issue|problem|balance|account|tokens?|money|transaction|tx)\b/i;
/** An invitation to feature the team: an AMA, a Space, a podcast, "have the Gloam team on". A lead for Duke. */
const INVITE =
  /\b(?:love|like|want|invite|inviting|have|feature|host|hosting|bring)\b[^.!?\n]{0,40}\b(?:gloam|glim|the\s+team|duke|you\s+guys|your\s+team|your\s+founder)\b[^.!?\n]{0,30}\b(?:on|onto|as\s+(?:a\s+)?guests?|for\s+an?\s+(?:ama|space|podcast|interview|episode|stream|panel))\b|\b(?:amas?|spaces?|podcast|interview|episode|show|stream|panel)\b[^.!?\n]{0,60}\b(?:have|invite|feature|host|bring)\b[^.!?\n]{0,30}\b(?:gloam|glim|the\s+team|duke|your\s+team)\b/i;
/** "I offer to build a Gloam plugin", "we'd like to make an integration": building for Gloam is a lead, not a sale. */
const BUILD_FOR =
  /\b(?:i|we)\s*(?:'d\s+like\s+to|would\s+like\s+to|want\s+to|offer\s+to|can|could|will|'ll)\s+(?:build|make|create|develop|write|ship)\b[^.!?\n]{0,40}\b(?:gloam|glim|integration|plugin|sdk|extension|connector)\b/i;
/** A t.me link given as where to ask: "join t.me/x for Tempo questions". Deleted, never held against them. */
const TG_POINTER = /\bfor\s+(?:\w+\s+){0,3}(?:questions?|help|support|issues?|updates?|news|docs)\b|\b(?:support|help(?:desk)?)\s+is\s+(?:at|on)\b/i;
/** "They fixed mine", "they sorted mine in 5 min": the fake-support scammer's script, never part of a harmless pointer. */
const TESTIMONIAL = /\bthey\s+(?:fixed|helped|answered|sorted|solved|resolved|recovered|refunded|unlocked|restored)\b/i;
/** A t.me group named like support, a help desk, a fix or recovery service, or an admin. */
const SUPPORT_PATH = /support|help|desk|fix|recover|admin/i;
/** Names no real project's group has: recovery, a fix, a refund, a claim. */
const FAKE_NAME = /recover|refund|claim|fix/i;
/** A support, help, desk or admin name: a real project's only if nothing around it reads like the scam. */
const SUPPORT_NAME = /support|help|desk|admin/i;
/** Talk of lost funds: what the fake-support scam answers. */
const LOST_FUNDS = /\b(?:lost|missing|stolen|drained|hacked|scammed|recover\w*|refund\w*|funds?\s+(?:gone|missing|stuck))\b/i;
/** Any DM ask, to the sender or to someone else there: "dm the admin", "message them". */
const DM_ANY = /\b(?:d\.?\s?m|p\.?\s?m|inbox|message|text|contact)\s+(?:me|us|them|him|her|the\s+(?:admins?|mods?|support|team|agents?|owner)|an?\s+(?:admin|mod|agent))\b/i;
/** "This fixed it", "fixed mine": a link vouched for, the scammer's script. */
const LINK_TESTIMONIAL = /\b(?:this|it|that|they)\s+(?:fixed|solved|sorted|worked|helped|recovered|restored|unlocked)\b|\bfixed\s+(?:it|mine)\b/i;
/** A member asking whether a link is real: "got this link in DM, legit?". A victim, not the scam. */
const ASKS_ABOUT = /\b(?:legit|real|safe|scam|fake|trust\w*|official|genuine|phishing|is\s+(?:this|it|that)|anyone\s+(?:know|seen|tried|else)|should\s+i)\b/i;
/**
 * Real projects whose own Telegram groups members point to ("Relay support is
 * at t.me/relaysupport", "asked in t.me/tempo_community"). None of their groups
 * is in the repo to check, so a group whose name starts with one of them is
 * only ever deleted: never a ban, never an offence, whatever the wording.
 */
const REAL_PROJECTS = ["relay", "tempo", "base", "robinhood", "circle", "paxos", "alchemy", "raeto", "virtuals", "orynth", "dexscreener", "blockscout"];
/**
 * Exchanges and wallets with no Telegram support at all: a t.me group named
 * for one is always the fake-support scam.
 */
const NO_TELEGRAM_SUPPORT = /coinbase|binance|kraken|okx|bybit|kucoin|gate\.?io|metamask|phantom|ledger|trezor|trust\s?wallet|exodus|rabby|uniswap|robinhood\s?support/i;
/** "Check my bio", "link in bio", "see my profile". */
const BIO = /\b(?:check|see|visit|look\s+at|in|on)\s+(?:my|our)\s+(?:bio|profile|channel|page)\b|\blink\s+in\s+(?:my\s+|the\s+)?bio\b|\bbio\s+(?:for|has)\b/i;
const WHATSAPP = /\bwa\.me\/|\bchat\.whatsapp\.com\/|\bwhats\s?app\s+(?:me|us|\+?\d)|\b(?:signal|telegram|tg|whatsapp)\s*(?:me|:)\s*@?\w{4,}/i;
/** "contact @x", "join @x", "@x for listing": a handle given as the place to go. */
const CONTACT_HANDLE = new RegExp(
  String.raw`\b(?:${CONTACT_VERB}|talk\s+to|join|follow|check\s+out|visit|subscribe\s+to|add)\s+(?:me\s+|us\s+)?(?:at\s+|on\s+|via\s+)?@([a-z0-9_]{4,32})|@([a-z0-9_]{4,32})\s+(?:for|to\s+(?:get|buy|join))\s+(?:business|deals?|listing\w*|promo\w*|marketing|details|support|help|collab\w*|partnership|otc|signals?|calls?|more|gems?|alpha)`,
  "gi",
);

/** Services strangers sell to projects. */
const SERVICE =
  /\b(?:marketing|promotion(?:s|al)?|promo|kols?|influencers?|shill(?:ing|ers?)?|raids?|raiders?|calls?\s+(?:channel|group)|callers?|amas?|listings?|cmc|coinmarketcap|coingecko\s+listing|cex\s+listing|tier\s*[- ]?1|volume(?:\s+(?:bot|boost|service))?|trending|dexscreener\s+(?:trending|boost|ads?)|community\s+(?:growth|management|building|moderation)|(?:holders|members|investors)\s+(?:growth|reach|boost)|investor\s+reach|exposure|visibility|smart\s+contracts?\s+(?:development|dev|audits?)|(?:website|dapp|bot|app|token)\s+(?:development|developer|dev)|full[- ]?stack|web3\s+(?:development|developer|dev)|blockchain\s+(?:development|developer|dev)|graphic\s+design|logo\s+design|meme\s+(?:design|maker|creation)|stickers?\s+(?:design|pack)|video\s+(?:editing|editor)|ghost\s*writ\w+|copywrit\w+)\b/i;
/** "I offer", "our services", "for hire", "affordable": the selling half of a pitch. */
const FIRST_BUSINESS =
  /\b(?:(?:i|we)\s+(?:offer|provide|deliver|specialize\s+in|specialise\s+in|handle|run)|(?:i|we)\s+do\s+(?:cmc|coingecko|listings?|trending|volume|marketing|promotions?|kols?|amas?|raids?)|(?:my|our)\s+(?:services|agency|company|packages?|portfolio|clients?|network\s+of|team\s+(?:of|has|can|will))|for\s+hire|hire\s+(?:me|us)|available\s+for\s+(?:hire|work|projects?|gigs?|collab\w*)|affordable|guaranteed|price\s+list|(?:my|our)\s+rates)\b/i;
/** "Let's work together", "let's talk": a pitch's close, when a role or a service came before it. */
const LETS = /\blet'?s\s+(?:work|talk|collab\w*|connect|discuss|partner|grow|build|do\s+business)\b/i;
/** "We can boost", "I will promote": a first-person offer. */
const OFFER_VERB =
  /\b(?:i|we)\s*(?:can|will|could|would|'ll)\s+(?:help|assist|boost|grow|promote|push|market|scale|bring|get|list|pump|build|develop|design|manage|handle|provide|offer|deliver|increase|skyrocket)\b/i;
/** "I can help your project", "we will push your token". */
const OFFER_HELP =
  /\b(?:i|we)\s*(?:can|will|could|would|'ll)\s+(?:help|assist|boost|grow|promote|push|market|scale|bring|pump|skyrocket|increase|list|take)\s+(?:your|ur)\s+(?:project|token|coin|community|team|brand|chart|growth|marketing|holders|volume|visibility|presence)\b/i;
/** "I'm a professional crypto marketer", "we are a KOL agency", "I am a dev". */
const SELF_ROLE =
  /\b(?:i\s*'?\s*m|i\s+am|we\s*'?\s*re|we\s+are)(?:\s*an?\s+|\s+the\s+|\s+)(?:[\w-]+\s+){0,3}?(?:marketer|marketing\s+(?:expert|agency|team|manager|specialist|strategist|consultant)|promoter|promotion\s+(?:agency|team)|kol|influencer|shiller|caller|raider|growth\s+(?:hacker|manager|marketer)|listing\s+(?:agent|manager|expert)|developer|dev|designer|community\s+(?:manager|builder)|moderator|mod|advisor|consultant|ambassador|ama\s+host|copywriter|ghostwriter|video\s+editor|agency)\b/i;
/** Roles nobody in a project's group sells but promoters. */
const PROMO_ROLE = /\b(?:marketer|marketing|promoter|promotion|kol|influencer|shiller|caller|raider|growth|listing|agency)\b/i;
/** "Need a dev?", "need marketing?": the opener of a pitch, when a contact or bio follows. */
const NEED_ROLE =
  /\bneed\s+(?:an?\s+|any\s+|some\s+)?(?:dev|developer|marketer|promoter|moderator|mod|designer|kol|influencer|community\s+manager|listing|marketing|promotion|volume|trending|amas?|exposure|holders)\b/i;
const FOR_HIRE = /\b(?:devs?|developers?|designers?|marketers?|mods?|moderators?|promoters?)\s+(?:for\s+hire|available\s+for\s+hire)\b|\bhire\s+(?:me|us)\b/i;
/** Promotion vocabulary that is unambiguous when someone offers it. */
const PROMO_STRONG =
  /\b(?:promot\w+|promo|marketing|marketer|kols?|influencers?|listings?|cmc|coinmarketcap|volume\s+bot|trending|shill\w*|raids?|exposure|visibility|investor\s+reach|for\s+hire|advertis\w+|sponsor\w*)\b/i;
/** All promotion vocabulary, partnerships and collabs included, for the unclear and newcomer checks. */
const PROMO_WORD = new RegExp(`${PROMO_STRONG.source}|\\b(?:partnership|collab\\w*|ads)\\b`, "i");
/** Addressing the project as an outsider: "your project", "your token". */
const SECOND_PERSON = /\b(?:your|ur)\s+(?:project|token|coin|community|chart|brand|telegram|tg|group|holders|volume|marketing|listing|presence|visibility|growth|launch|website|dapp|socials?)\b/i;

/** "Who can I talk to", "can I speak with the dev", "I'd like to talk to the team". */
const TALK_TO_TEAM =
  /\b(?:who|how)\s+(?:can|do|should|could|would)\s+(?:i|we)\s+(?:talk|speak|reach|contact|get\s+in\s+touch|connect|chat|discuss)\b|\b(?:can|could|may)\s+i\s+(?:talk|speak|chat|discuss|connect)\s+(?:to|with)\s+(?:the\s+|a\s+|an\s+|your\s+)?(?:team|devs?|developers?|admins?|founders?|owners?|ceo|mods?|manager|management|someone\s+in\s+charge|project\s+lead)\b|\b(?:i|we)\s*(?:'d|would)?\s+(?:like|want|wanna|need)\s+to\s+(?:talk|speak|chat|discuss|connect)\s+(?:to|with)\s+(?:the\s+|a\s+|an\s+|your\s+)?(?:team|devs?|developers?|admins?|founders?|owners?|ceo|mods?|manager|management)\b|\bwho\s*(?:is|'s)\s+(?:the\s+)?(?:dev|admin|founder|owner|ceo|manager|in\s+charge)\s+here\b/i;
const BUSINESS =
  /\b(?:partnership|collab\w*|listing\w*|marketing|promot\w+|promo|business|proposal|investment|invest|opportunit\w+|offer|deal|amas?|kols?|cooperation|sponsor\w*|advertis\w+|ads|integrat\w+|payroll|contributors|clients?|customers?)\b/i;
/** "We'd like a partnership", "collab with your project", "open to a partnership". */
const PARTNER_PITCH =
  /\b(?:i|we)\s*(?:would\s+like|'d\s+like|want|wanna|are\s+looking|am\s+looking|are\s+interested|am\s+interested|'re\s+interested|'m\s+interested|propose|have\s+an?\s+(?:proposal|offer|deal)|are\s+open|offer|represent)\b[^.!?\n]{0,60}\b(?:partnership|collab\w*|cooperation|cross[- ]?promo\w*|joint\s+venture|sponsorship)|\b(?:partnership|collab\w*|cooperation|cross[- ]?promo\w*)\s+(?:with|for|between)\s+(?:your|ur|you|us)\b|\b(?:interested\s+in|open\s+to|looking\s+for)\s+(?:an?\s+)?(?:partnership|collab\w*|cooperation|cross[- ]?promo\w*)/i;

const OTC = /\botc\b/i;
const TRADE_OFFER =
  /\b(?:selling|wts|wtb|want(?:ing)?\s+to\s+(?:buy|sell)|looking\s+to\s+(?:buy|sell)|i\s+(?:sell|buy)|i\s*'?m\s+(?:selling|buying)|we\s*'?re\s+(?:selling|buying)|for\s+sale|buying\s+(?:in\s+)?bulk|sell(?:ing)?\s+(?:my|some|cheap|at|below)|buy(?:ing)?\s+(?:at|below|cheap))\b/i;
const WHO_TRADES = /\b(?:who|anyone|anybody|someone|somebody)\s*(?:'s|\s+is|\s+wants?\s+to|\s+willing\s+to|\s+here)?\s+(?:selling|buying|sell|buy|swap(?:ping)?)\b/i;
const OTC_TERMS = /\b(?:escrow|discount|below\s+(?:market|price)|cheap(?:er)?|bulk|deal|desk)\b/i;

const TICKER_RE = /(?<![\w$])\$([a-z][a-z0-9.]{0,11}[a-z0-9])(?![\w.])/gi;
/**
 * Tickers people name in normal talk here: $GLOAM, every asset the app lists
 * (stablecoins, the stock tokens, the swap and bridge tokens), and majors.
 */
const KNOWN_TICKERS = new Set(
  [
    ..."gloam eth weth btc wbtc sol usd usdc usdce usdt usdt0 usdg pathusd path ousd eurc pyusd dai op arb bnb zec xmr doge ton trx link avax hype mon".split(" "),
    ...knownTokens().map((t) => t.symbol),
    ...MARKET_DEFS.map((m) => m.symbol),
    ...BRIDGE_CHAINS.flatMap((c) => c.tokens.map((t) => t.symbol)),
  ].map((t) => t.toLowerCase().replace(/\./g, "")),
);
const PUMP =
  /\b(?:\d{2,5}\s?x|x\s?\d{2,5}|moon\w*|gems?|ape(?:\s+in|\s+now)?|aping|send(?:ing)?\s+it|pump(?:ing|s)?|low\s*cap|micro\s*cap|stealth\s+launch\w*|fair\s+launch\w*|just\s+launched|launching\s+(?:now|soon|today)|presale|don'?t\s+miss|early\s+(?:entry|gem|buyers?|birds?)|buy\s+now|get\s+in\s+(?:now|early|before)|going\s+(?:to\s+)?(?:\d+\s?x|parabolic|crazy|nuclear)|parabolic|next\s+(?:gem|big\s+thing)|printing|easy\s+money)\b/i;
const CA_WORD = /\b(?:ca|contract)\b/i;
const BUY_WORD = /\b(?:buy|ape|grab|get\s+in|load\s+up|chart)\b/i;
const EVM_ADDRESS = /\b0x[0-9a-f]{40}\b/gi;
/** A Solana-style mint ("...pump" on pump.fun, or base58 next to CA). */
const SOL_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
/** What makes a t.me link a pitch rather than a link someone shared. */
const TG_PITCH = /\b(?:signals?|calls?|gems?|alpha|vip|free|pumps?|\d{2,5}\s?x|earn|profits?|promot\w+|listing|marketing|airdrop\w*|giveaway\w*)\b/i;

const BRAND = String.raw`(?:gloam|glim)`;
const STAFF_ROLE = String.raw`(?:support(?:\s+team)?|team|admins?|mods?|moderators?|official|help\s*desk|customer\s+(?:care|service|support)|staff|devs?|developers?|founders?|co-?founders?|ceo|cto|management|security(?:\s+team)?|tech(?:nical)?\s+(?:team|support)|helpline|agents?|representatives?)`;
/** Claiming to be the team: "I'm from the Gloam team", "we are Gloam support", "Gloam support here", "on behalf of Gloam". */
const IMPOSTOR_CLAIM = new RegExp(
  String.raw`\b(?:i\s*'?\s*m|i\s+am|we\s*'?\s*re|we\s+are|this\s+is)(?:\s*an?\s+|\s+)(?:from\s+|with\s+|on\s+|part\s+of\s+|one\s+of\s+)?(?:the\s+|an?\s+)?(?:official\s+)?${BRAND}(?:'s)?\s+${STAFF_ROLE}\b(?!'s)|\b(?:on\s+behalf\s+of|representing)\s+(?:the\s+)?${BRAND}\b|^\W*(?:official\s+)?${BRAND}\s+${STAFF_ROLE}\b(?:\s+here\b)?`,
  "i",
);

/** An airdrop, giveaway, bonus or "first 100" offered ... */
const DROP_OFFER =
  /\b(?:airdrop\w*|giveaway\w*|give\s+away|free\s+(?:tokens?|usdt|usdc|eth|crypto|money|nfts?|mint|\$?\d)|bonus(?:es)?|rewards?|prizes?|winners?|first\s+\d+\s+(?:people|persons|users|members|holders|wallets)|claim\s+(?:your|ur)\s+(?:tokens?|airdrop|rewards?|bonus|allocation|prize|share))\b/i;
/** ... with the catch: claim now, connect, register, drop your wallet, DM me. */
const DROP_CTA =
  /\b(?:claim\s+(?:now|here|it|yours|today|fast|at)|connect\s+(?:your|ur)\s+wallets?|register|sign\s*up|(?:d\.?\s?m|p\.?\s?m|inbox)\s+(?:me|us)|send\s+(?:me|us)|click|visit|join\s+(?:now|here|us|the)|drop\s+(?:your|ur)\s+(?:wallets?|address(?:es)?|addy|evm|sol)|(?:comment|reply\s+with|post)\s+(?:your|ur)\s+(?:wallets?|address(?:es)?|addy)|participate|follow\s+(?:me|us|and)|retweet|tag\s+\d+\s+friends)\b/i;
/** Money schemes: passive income, daily profit, an account manager, signals. */
const MONEY_PITCH =
  /\b(?:passive\s+income|daily\s+(?:profits?|returns?|income)|guaranteed\s+(?:profits?|returns?)|investment\s+(?:plans?|platform|opportunit\w+|manager)|account\s+manager|trading\s+(?:signals?|mentor|mentorship)|forex|binary\s+options?|recover\s+(?:your\s+)?(?:lost|stolen|scammed)\s+(?:funds|crypto|money)|(?:earn|make)\s+\$?\d[\d,]*\s*(?:k|usd|usdt|dollars)?\s*(?:daily|weekly|a\s+day|per\s+day|a\s+week|per\s+week))\b/i;
/** "Follow me", "follow our channel": with a link off the allowed list or a handle, a pull somewhere else. */
const FOLLOW_ME = /\bfollow\s+(?:me|us|my|our)\b/i;
/** Thanks and greetings. */
const CHATTY = /\b(?:thanks?|thank\s+you|thx|ty|gm|gn|hi|hello|hey|welcome|lol|haha|same|nice|great|congrats|agreed|exactly)\b/i;
/** A link with a call to come and do something there. */
const LINK_CTA =
  /\b(?:join|click|sign\s*up|register|earn|free|bonus|mint|claim|connect|play|bet|casino|start\s+earning|passive|profits?|invest|trade\s+(?:now|here)|download|install)\b/i;

/** A promoter's display name: "GUL ceo promoter", "KOL Agency", "Crypto Marketing". Never spam on its own. */
const PROMO_NAME =
  /\b(?:promot\w*|marketing|marketer|kols?|listings?|agency|callers?|calls|shill\w*|pumps?|influencer|ads|advert\w*|cmc|coingecko|trending|volume|signals?|forex|investments?|recovery|crypto\s+ceo|web3\s+(?:marketing|growth|agency))\b/i;

// ---------------------------------------------------------------- links and handles

/**
 * Partners' and the chains' own accounts, which members point each other to
 * ("contact @relayprotocol", "follow @raetoai"). The partners on the site are in
 * components/LivePartners.tsx; keep this list next to it.
 */
export const PARTNER_HANDLES = [
  "raetoai", "raeto", "agentwormhole", "relayprotocol", "relaylink", "tempo", "tempoxyz", "base", "buildonbase", "ethereum",
  "virtualsprotocol", "virtuals_io", "robinhood", "robinhoodapp", "kannaudits", "kann_audits", "orynth", "dexscreener", "coingecko", "circle", "paxos",
];

/** A host that carries the brand: "gloam" anywhere, "glim" as its own word or with a staff word ("glimbot", "glim-support"). */
function brandDomain(host: string): boolean {
  return /gloam/.test(host) || /(?:^|[.-])glim(?:[.-]|bot|support|help|official|app|admin)/.test(host);
}

/**
 * A member asking whether a link is real ("got this link in DM, legit?"), or
 * sharing one right after their own problem without vouching for it: a likely
 * victim. The link comes down and the owner is told; nobody is removed. A
 * link vouched for ("this fixed it") or posted as a statement is not this.
 */
export function asksAboutLink(raw: string): boolean {
  const t = norm(raw);
  return t.includes("?") && ASKS_ABOUT.test(t) && !LINK_TESTIMONIAL.test(t);
}

/** A link vouched for, or on a domain that carries the brand: never the victim's own report. */
export function vouchedOrBranded(raw: string): boolean {
  const t = norm(raw);
  return LINK_TESTIMONIAL.test(t) || linksOf(t).some((l) => !linkAllowed(l) && brandDomain(hostOf(l).host));
}

/** A t.me link to anywhere but this group, its message links, Glim's stickers or Glim. */
function foreignTelegram(host: string, path: string): boolean {
  if (!["t.me", "telegram.me", "telegram.dog"].includes(host)) return false;
  return !/^\/(?:gloamhq|c\/\d+|addstickers\/glimbygloam|glimforgloambot)(?:[/?#]|$)/i.test(path);
}

export type ScreenInput = {
  /** The message text, codes already masked (scanCodes). */
  text: string;
  /** The sender's display name. */
  name: { first_name?: string; last_name?: string };
  /** Entities, for links hidden behind words (text_link) and mentions. */
  entities?: TgEntity[];
  /** Every link Telegram marked in the message (rules.entityLinks): url entities as written, text_link targets. */
  links?: string[];
  /** Where a forward came from, when it is one. */
  forwardedFrom?: string | null;
  /** Handles anyone may name: the bot, the team, the official accounts. Lower case, no "@". */
  okHandles: string[];
};

export type Screen = {
  /** What the rules are sure of, or null. */
  verdict: Verdict | null;
  /**
   * A business lead: a partnership pitch or "who do I talk to" about business.
   * Never a ban: from a stranger it comes down and goes to Duke privately; from
   * a member Glim knows it stays up, and goes to Duke too.
   */
  lead: Verdict | null;
  /** Spam-shaped but not sure: worth one model check for a sender with no history. The reason, or null. */
  unclear: string | null;
  /** What a newcomer's first messages may not hold (a link off the list, a contact ask, pitch wording), as a category. */
  gate: SpamCategory | null;
  /** Spam-shaped, acted on or not: the helper never replies to it. */
  quiet: boolean;
};

function linksOf(text: string, entities: TgEntity[] = [], marked: string[] = []): string[] {
  const hidden = entities.filter((e) => e.type === "text_link" && typeof e.url === "string").map((e) => e.url!);
  // an email's domain is not a link; a link Telegram marked is one, whatever its ending
  const found = [...(text.replace(EMAIL_RE, " ").match(LINK_RE) ?? []), ...hidden, ...marked];
  return [...new Set(found)];
}

function handlesOf(text: string): string[] {
  const bare = text.replace(EMAIL_RE, " ").replace(LINK_RE, " ");
  return [...bare.matchAll(/(?<![\w@./])@([a-z0-9_]{4,32})\b/gi)].map((m) => m[1]!.toLowerCase());
}

type Contact = {
  /** A contact ask said outright: not negated, not asking for help ("can someone DM me?"), not an invitation ("if you need help, dm me"). */
  any: boolean;
  /** One that is someone's own support ask ("admin pls dm me, my deposit is stuck"), not a solicitation. */
  support: boolean;
  /** One with a business, money or support-offer purpose. */
  sure: boolean;
  /** One with a soft purpose ("for details"). */
  soft: boolean;
};

function contactAsk(t: string): Contact {
  const out: Contact = { any: false, support: false, sure: false, soft: false };
  const offer = SUPPORT_OFFER.test(t);
  for (const m of t.matchAll(CONTACT_ASK)) {
    if (negated(t, m.index, m[0]) || askingForHelp(t, m)) continue;
    const before = t.slice(0, m.index);
    const sentenceStart = Math.max(...[".", "!", "?", "\n"].map((c) => before.lastIndexOf(c))) + 1;
    const lead = t.slice(sentenceStart, m.index);
    const after = t.slice(m.index + m[0].length);
    // "if you need help with the faucet, dm me" is a member offering a hand; with "your wallet" or "I can fix it" it is the scam
    if (!offer && (INVITATION.test(after) || INVITATION.test(lead))) continue;
    // their own problem, or the ask put to the team as a request: a support ask, never a solicitation
    const window = before.slice(-30);
    if (!offer && ((SELF_PROBLEM.test(t) && (PROBLEM_HINT.test(t) || BUG_WORDS.test(t))) || (TO_TEAM.test(window) && REQUEST.test(window)))) {
      out.support = true;
      continue;
    }
    out.any = true;
    const near = `${t.slice(Math.max(0, m.index - 60), m.index)} ${after.split(/[.!?\n]/)[0] ?? ""}`;
    // a business or money purpose, or the support scam's shape (a fix, someone's funds, their keys); a generic "I can help" is not sure
    if (PURPOSE_SURE.test(near) || SUPPORT_SCAM.test(t) || SECRET_PULL.test(t)) out.sure = true;
    else if (PURPOSE_SOFT.test(near)) out.soft = true;
  }
  return out;
}

function otherTickers(t: string): string[] {
  return [...t.matchAll(TICKER_RE)].map((m) => m[1]!.toLowerCase().replace(/\./g, "")).filter((x) => !KNOWN_TICKERS.has(x));
}

const COPYCAT = new Set(COPYCAT_GLOAM.map((a) => a.toLowerCase()));

function otherAddresses(raw: string): { evm: string[]; copycat: boolean; sol: string[] } {
  const evm = (raw.match(EVM_ADDRESS) ?? []).map((a) => a.toLowerCase()).filter((a) => a !== GLOAM_TOKEN.address.toLowerCase() && !ownAddress(a));
  const sol = (raw.match(SOL_ADDRESS) ?? []).filter((a) => /[a-z]/.test(a) && /[A-Z]/.test(a) && /\d/.test(a));
  return { evm: evm.filter((a) => !COPYCAT.has(a)), copycat: evm.some((a) => COPYCAT.has(a)), sol };
}

/** The display name as a reader sees it. */
function nameOf(n: ScreenInput["name"]): string {
  return plain(`${n.first_name ?? ""} ${n.last_name ?? ""}`).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Screens one message from someone who is not the team. Fast rules first; what
 * they can't settle comes back as `unclear` for one model check. Plain opinions
 * ("undervalued", "gm", hype about $GLOAM), questions and problem reports come
 * back clean, whatever links, handles or names they carry.
 */
export function screen(i: ScreenInput): Screen {
  const raw = i.text;
  const own = ownWords(raw);
  const readings = spellings(scorable(own));
  const links = linksOf(raw, i.entities, i.links);
  const hosts = links.map(hostOf);
  const tgLinks = hosts.filter((h) => foreignTelegram(h.host, h.path));
  // links to anywhere but the official pages, explorers, faucets, bridges, charts, wallets and file hosts (t.me apart)
  const offsite = links.filter((l, n) => {
    const h = hosts[n]!;
    if (linkAllowed(l) || ["t.me", "telegram.me", "telegram.dog"].includes(h.host)) return false;
    return !SAFE_HOSTS.some((s) => onHost(h.host, s));
  });
  const okHandles = [...i.okHandles, ...PARTNER_HANDLES];
  const handles = handlesOf(raw).filter((h) => !okHandles.includes(h));
  const brandHosts = offsite.map(hostOf).filter((h) => brandDomain(h.host));
  const question = raw.includes("?") || looksLikeQuestion(raw);
  // a problem report ("my deposit is stuck", "proof fails"); "I can help your project" is an offer, not a problem
  const problem = (PROBLEM_HINT.test(norm(raw)) && !OFFER_VERB.test(norm(raw))) || BUG_WORDS.test(norm(raw));
  const promoName = PROMO_NAME.test(nameOf(i.name));
  const addresses = otherAddresses(raw);
  const forwarded = i.forwardedFrom === "channel" || i.forwardedFrom === "chat";
  const words = wordCount(norm(raw));

  const hits: Verdict[] = [];
  const add = (category: SpamCategory, confidence: number, rule: string, sure: boolean, outcome?: Verdict["outcome"]) =>
    hits.push({ category, confidence, rule, source: "rule", sure, ...(outcome ? { outcome } : {}) });
  let lead: Verdict | null = null;
  /** An AMA, podcast or "have the team on" invite, or an offer to build for Gloam: a lead even when it reads like a pitch. */
  let invite: Verdict | null = null;
  let contact: Contact = { any: false, support: false, sure: false, soft: false };
  let tickers: string[] = [];
  let pitch = false;
  let gatePitch = false;
  let offer = false;
  let business = false;
  let talkToTeam = false;

  for (const t of readings) {
    const c = contactAsk(t);
    contact = { any: contact.any || c.any, support: contact.support || c.support, sure: contact.sure || c.sure, soft: contact.soft || c.soft };
    const bio = BIO.test(t);
    const whatsapp = WHATSAPP.test(t);
    const reach = c.any || bio || whatsapp;
    const others = otherTickers(t);
    tickers = tickers.length ? tickers : others;
    talkToTeam ||= TALK_TO_TEAM.test(t);
    business ||= BUSINESS.test(t);
    const selfRole = SELF_ROLE.exec(t);
    const firstBusiness = FIRST_BUSINESS.test(t);
    const offerVerb = OFFER_VERB.test(t);
    const close = LETS.test(t);
    const second = SECOND_PERSON.test(t);
    const strong = PROMO_STRONG.test(t) || SERVICE.test(t);
    offer ||= firstBusiness || FOR_HIRE.test(t) || (OFFER_HELP.test(t) && strong);
    pitch ||= PROMO_WORD.test(t) && (second || offerVerb || firstBusiness || Boolean(selfRole));
    // a newcomer offering a hand ("I can help with the CoinGecko form") is not pitching; selling to "your project" is
    gatePitch ||= strong && (second || firstBusiness || Boolean(selfRole && PROMO_ROLE.test(selfRole[0])));

    // posing as the team, in words, and pulling people somewhere: a contact ask, a handle or a link that isn't ours
    const pull = c.any || bio || whatsapp || handles.length > 0 || offsite.length > 0 || tgLinks.length > 0;
    if (says(IMPOSTOR_CLAIM, t) && pull) add("impersonation", 0.95, "support_impostor", true);

    // a domain off the allowed list that carries the brand: gloam-support.xyz, claim-gloam.xyz, glim-bot.app
    if (brandHosts.length) add("impersonation", 0.97, "brand_domain", true);

    // bait, money schemes, and the support offer that ends in a DM
    if (says(DROP_OFFER, t) && says(DROP_CTA, t)) add("scam", 0.9, "drop_bait", true);
    if (says(MONEY_PITCH, t) && (reach || offsite.length)) add("scam", 0.9, "money_pitch", true);
    if (c.any && SECRET_PULL.test(t)) add("scam", 0.95, "secret_pull", true);
    else if (c.any && SUPPORT_SCAM.test(t) && !SELF_PROBLEM.test(t)) add("scam", 0.92, "support_offer", true);
    else if (c.any && SUPPORT_OFFER.test(t) && !SELF_PROBLEM.test(t)) add("scam", 0.88, "help_offer", false, "soft");

    // contact and link spam
    // the fake-support scam: a group named for Gloam or Glim, or for support, a help desk, a fix or recovery, or one
    // vouched for with "they fixed mine"; a real project's own group, named in the message, is only a pointer
    const tgNames = tgLinks.map((h) => (h.path.replace(/^\//, "").split(/[/?#]/)[0] ?? "").toLowerCase());
    const realProject = (n: string) => REAL_PROJECTS.some((r) => n.startsWith(r)) && !NO_TELEGRAM_SUPPORT.test(n);
    if (tgNames.some((n) => /gloam|glim/.test(n))) add("impersonation", 0.97, "brand_telegram", true);
    else if (tgNames.some((n) => NO_TELEGRAM_SUPPORT.test(n))) add("scam", 0.97, "support_telegram", true);
    // recovery, a fix, a refund or a claim: no real project's group, whatever it starts with ("t.me/base_recovery_help")
    else if (tgNames.some((n) => FAKE_NAME.test(n))) add("scam", 0.97, "support_telegram", true);
    // a real project's own group, checked before the testimonial: "asked in t.me/tempo_community, they helped me".
    // A support, help, desk or admin name only passes with nothing around it that reads like the scam
    else if (tgNames.length && tgNames.every(realProject) && !TG_PITCH.test(t) && !strong) {
      if (tgNames.some((n) => SUPPORT_NAME.test(n)) && (TESTIMONIAL.test(t) || LOST_FUNDS.test(t) || DM_ANY.test(t))) add("scam", 0.9, "support_telegram", false, "soft");
      else add("link_spam", 0.9, "telegram_pointer", false, "delete");
    }
    else if (tgLinks.length && TESTIMONIAL.test(t)) add("scam", 0.95, "support_telegram", true);
    else if (tgNames.some((n) => SUPPORT_PATH.test(n))) add("scam", 0.95, "support_telegram", true);
    else if (tgLinks.length && !TG_PITCH.test(t) && !strong && TG_POINTER.test(t)) add("link_spam", 0.9, "telegram_pointer", false, "delete");
    else if (tgLinks.length) add("link_spam", 0.95, "telegram_link", TG_PITCH.test(t) || strong);
    if (whatsapp) add("contact_spam", 0.95, "whatsapp", strong || MONEY_PITCH.test(t) || c.sure);
    if (bio) add("contact_spam", 0.95, "bio_link", strong || NEED_ROLE.test(t) || Boolean(selfRole));
    for (const m of t.matchAll(CONTACT_HANDLE)) {
      const h = (m[1] ?? m[2] ?? "").toLowerCase();
      if (h && !okHandles.includes(h) && !negated(t, m.index, m[0])) add("contact_spam", 0.92, "contact_handle", strong || OTC.test(t));
    }
    if (c.sure) add("contact_spam", 0.9, "contact_purpose", true);
    else if (c.soft) add("contact_spam", 0.88, "contact_purpose", false);
    if (FOLLOW_ME.test(t) && (offsite.length || tgLinks.length || handles.length)) add("contact_spam", 0.88, "follow_me", false);
    if (offsite.length && LINK_CTA.test(t) && !question && !problem) add("link_spam", 0.88, "link_cta", false);

    // service and promotion pitches: only with promotion wording or a contact ask, else the model decides
    if (OFFER_HELP.test(t) && (strong || reach)) add("promo", 0.92, "offer_help", true);
    if (FOR_HIRE.test(t)) add("promo", 0.92, "for_hire", true);
    if (selfRole && (firstBusiness || (reach && (PROMO_ROLE.test(selfRole[0]) || strong)) || (strong && (offerVerb || close || second)))) {
      add("promo", 0.95, "self_pitch", true);
    }
    if (NEED_ROLE.test(t) && (reach || firstBusiness)) add("promo", 0.95, "need_pitch", true);
    if (SERVICE.test(t) && (reach || firstBusiness || ((offerVerb || close) && (second || promoName)))) add("promo", promoName ? 0.97 : 0.92, "service_pitch", true);
    if (PROMO_STRONG.test(t) && reach) add("promo", 0.93, "promo_contact", true);
    else if (PROMO_WORD.test(t) && reach) add("promo", 0.88, "promo_contact", false);
    if (promoName && (reach || firstBusiness || SERVICE.test(t))) add("promo", 0.93, "promo_name", true);
    if (forwarded && (offsite.length || tgLinks.length || handles.length) && (PUMP.test(t) || strong || LINK_CTA.test(t) || reach)) {
      add("promo", 0.9, "forwarded_promo", true);
    }

    // OTC buying and selling
    const trade = TRADE_OFFER.test(t) || WHO_TRADES.test(t);
    if (OTC.test(t) && (reach || (!question && (trade || OTC_TERMS.test(t))))) add("otc", 0.95, "otc_offer", true);
    else if (trade && reach) add("otc", 0.92, "trade_contact", true);
    else if (!question && TRADE_OFFER.test(t) && OTC_TERMS.test(t)) add("otc", 0.88, "trade_terms", true);

    // another token's shill
    if (others.length && PUMP.test(t)) add("shill", 0.92, "ticker_shill", true);
    if (addresses.evm.length && (PUMP.test(t) || others.length || (CA_WORD.test(t) && !question)) && !/\b(?:sent|send|paid|pay|received|tx|txn|transaction|wallet|address)\b/i.test(t)) {
      add("shill", 0.92, "ca_shill", true);
    }
    if (addresses.sol.length && (PUMP.test(t) || others.length || (CA_WORD.test(t) && !question))) add("shill", 0.9, "ca_shill", true);
    if (addresses.copycat && !question && (CA_WORD.test(t) || BUY_WORD.test(t) || PUMP.test(t))) add("shill", 0.9, "copycat_ca", true);

    // business leads: for Duke, never a ban
    if (!lead && says(PARTNER_PITCH, t)) lead = { category: "promo", confidence: 0.88, rule: "partnership_pitch", source: "rule", sure: false };
    if (!lead && TALK_TO_TEAM.test(t) && (BUSINESS.test(t) || promoName)) lead = { category: "promo", confidence: 0.88, rule: "talk_to_team", source: "rule", sure: false };
    if (INVITE.test(t)) invite = { category: "promo", confidence: 0.88, rule: "invite", source: "rule", sure: false };
    else if (BUILD_FOR.test(t) && !SECOND_PERSON.test(t) && !PROMO_STRONG.test(t)) invite ??= { category: "promo", confidence: 0.88, rule: "build_offer", source: "rule", sure: false };
  }

  // the strongest hit; a sure one, then a ban category, wins a tie
  const rank = (v: Verdict) => v.confidence + (v.sure ? 0.001 : 0) + (BAN_CATEGORIES.has(v.category) ? 0.0001 : 0);
  let verdict: Verdict | null = hits.sort((a, b) => rank(b) - rank(a))[0] ?? null;
  // an invite to feature the team, or to build for Gloam, goes to Duke even if it uses a pitch's words; scams and links still don't
  if (invite && (!verdict || (verdict.category === "promo" && !tgLinks.length && !offsite.length))) {
    verdict = null;
    lead = invite;
  }
  if (verdict) lead = null;

  let unclear: string | null = null;
  if (!verdict && !lead && !question && !problem && words >= 3) {
    const greeting = CHATTY.test(own) && words <= 6;
    if (promoName && words >= 5 && !greeting) unclear = "promo_name";
    else if (forwarded && (offsite.length || tickers.length || PUMP.test(own))) unclear = "forwarded";
    else if (contact.any) unclear = "contact_ask";
    else if (offsite.length) unclear = "offsite_link";
    // "I can help your team translate the docs", "I'm a developer, let's build": maybe a pitch, maybe a volunteer
    else if (pitch || offer || OFFER_HELP.test(own) || (SELF_ROLE.test(own) && (OFFER_VERB.test(own) || LETS.test(own) || SECOND_PERSON.test(own)))) unclear = "promo_words";
    else if (tickers.length) unclear = "ticker";
  }

  // a newcomer may ask anything and report any problem; their first messages may not pull people elsewhere or pitch
  let gate: SpamCategory | null = null;
  if (!question && !problem) {
    if (tgLinks.length || offsite.length) gate = "link_spam";
    else if (contact.any) gate = "contact_spam";
    else if (gatePitch || offer) gate = "promo";
  }

  const quiet =
    Boolean(verdict || lead || unclear) ||
    contact.any ||
    (offsite.length > 0 && !question && !problem) ||
    tickers.length > 0 ||
    offer ||
    (talkToTeam && business);

  return { verdict, lead, unclear, gate, quiet };
}

// ---------------------------------------------------------------- what happens to the sender

/** A past offence, kept a week. `sure` when a sure rule caught it: only those make a repeat a ban. */
export type Offence = { at: number; category: SpamCategory; sure?: boolean };

/** What Glim knows about a member when it is about to act. */
export type Standing = {
  /** Messages Glim saw from them before this one (kept 30 days). */
  priorMsgs: number;
  /** When Glim first saw them talk (kept 30 days), or null. */
  firstSeen: number | null;
  /** When they joined, when Glim saw it in the last 24 hours, or null. */
  joinedAt: number | null;
  /** Their offences in the last week, newest first. */
  offences: Offence[];
  /** An admin lifted a removal of theirs (/unban): Glim's guesses leave them alone for 30 days. */
  vouched: boolean;
  /** Clock hours, a day to three days ago, they talked in (the group's activity counters). */
  oldActiveHours: number;
};

/** A member who has been around and talked normally: seen talking over a day ago, and no offence this week. */
export function established(s: Standing, now: number): boolean {
  if (s.offences.some((o) => o.at > now - WEEK_MS)) return false;
  if (s.vouched) return true;
  if (s.priorMsgs >= 3 && s.firstSeen !== null && s.firstSeen <= now - DAY_MS) return true;
  return s.oldActiveHours >= 2;
}

/** Joined in the last 24 hours and these are among their first few messages. */
export function newcomer(s: Standing, now: number): boolean {
  return !s.vouched && s.joinedAt !== null && now - s.joinedAt < DAY_MS && s.priorMsgs < 3;
}

export type Plan = { ban: boolean; muteSec: number; why: string };

const BAN: Plan = { ban: true, muteSec: 0, why: "" };
const MUTE: Plan = { ban: false, muteSec: MUTE_SEC, why: "" };
const DELETE: Plan = { ban: false, muteSec: 0, why: "" };

/**
 * What happens after the message is deleted.
 *  - A ban needs a sure rule (unambiguous scam or promotion wording) and a
 *    sender with no history, or a repeat within the week where this offence or
 *    an earlier one was a sure rule. On launch day almost everyone has no
 *    history, so anything less sure, a model verdict and the newcomer check are
 *    a 24-hour mute, as many times as it takes, never a ban on their own.
 *  - A member Glim knows gets the mute on a first offence, whatever the rule.
 *  - OTC offers and shills: a delete, then a mute, then (sure ones) a ban.
 *  - A verdict with a fixed outcome: "delete" only deletes; "soft" mutes
 *    someone Glim doesn't know and only deletes for a member it knows.
 *  - With no standing (the store is down) Glim fails safe: only a sure rule
 *    bans, everything else is only deleted.
 */
export function planFor(v: Verdict, s: Standing | null, now: number, gate = false): Plan {
  const sure = v.source === "rule" && v.sure === true;
  const ladder = LADDER_CATEGORIES.has(v.category);
  if (v.outcome === "delete") return { ...DELETE, why: "pointing somewhere else, not held against them" };
  if (!s) return !ladder && sure ? { ...BAN, why: "sure rule, store down" } : { ...DELETE, why: "store down" };
  const week = s.offences.filter((o) => o.at > now - WEEK_MS);
  const day = s.offences.filter((o) => o.at > now - DAY_MS).length;
  const sureBefore = sure || week.some((o) => o.sure === true);
  if (ladder) {
    if (week.length >= 2 && sureBefore) return { ...BAN, why: "third offence this week" };
    if (day >= 1 || week.length >= 2) return { ...MUTE, why: "a repeat in 24 hours" };
    return { ...DELETE, why: "first offence" };
  }
  const known = established(s, now);
  if (v.outcome === "soft") return known ? { ...DELETE, why: "a member Glim knows" } : { ...MUTE, why: "someone Glim doesn't know" };
  if (week.length >= 1 && sureBefore) return { ...BAN, why: "a repeat this week, a sure rule among them" };
  if (gate) return { ...MUTE, why: "newcomer's first messages" };
  if (known) return { ...MUTE, why: "known member, first offence" };
  return sure ? { ...BAN, why: "sure rule, no history" } : { ...MUTE, why: "not sure enough to ban" };
}

// ---------------------------------------------------------------- the model check

/** The model's categories, as the screen's. */
const MODEL_CATEGORY: Record<string, SpamCategory> = {
  promo: "promo",
  contact: "contact_spam",
  link: "link_spam",
  otc: "otc",
  shill: "shill",
  scam: "scam",
  impersonation: "impersonation",
};

export type SpamCheck = { spam: boolean; category: SpamCategory | null; confidence: number };

/**
 * The model's answer, strict: one JSON object and nothing else, with a boolean
 * `spam`, a known `category` when it is spam, and a `confidence` from 0 to 1.
 * Anything else is no answer, and no answer is never an action.
 */
export function parseSpamCheck(raw: string | null | undefined): SpamCheck | null {
  const t = (raw ?? "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.spam !== "boolean" || typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return null;
  const category = typeof o.category === "string" ? (MODEL_CATEGORY[o.category.toLowerCase()] ?? null) : null;
  if (o.spam && !category) return null;
  return { spam: o.spam, category: o.spam ? category : null, confidence: o.confidence };
}
