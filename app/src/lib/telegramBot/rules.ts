/**
 * The community helper's rules, as plain functions with no network calls:
 * when it speaks, what counts as a scam or a leaked secret, what a reply may
 * contain, and the welcome text. Kept pure so scripts/selftest-telegram.mts
 * can check every rule, including the false positives.
 */
import { createHash, timingSafeEqual } from "crypto";
import { english } from "viem/accounts";
import { baseSepoliaPool, ethereumSepoliaPool, isMainnetLive, liveMainnetNames, mainnetPool } from "@/lib/mainnet";
import { COPYCAT_GLOAM, GLOAM_TOKEN } from "./knowledge";
import type { TgMessage, TgPhotoSize, TgUser } from "./telegram";
import { ELYSIUM, ELYSIUM_RPC_DISPLAY, ELYSIUM_TESTNET } from "@/lib/elysium";

/** Forum topics in t.me/gloamhq, by message_thread_id. General messages carry no thread id. */
export const TOPIC = { general: 1, testers: 2, announcements: 3, help: 4, feedback: 5, buys: 798 } as const;

const TOPIC_NAME: Record<number, string> = {
  [TOPIC.general]: "General",
  [TOPIC.testers]: "Testers",
  [TOPIC.announcements]: "Announcements",
  [TOPIC.help]: "Help",
  [TOPIC.feedback]: "Feedback",
  [TOPIC.buys]: "Buys",
};

export function topicName(topic: number): string {
  return TOPIC_NAME[topic] ?? "General";
}

// ---------------------------------------------------------------- webhook

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Telegram's X-Telegram-Bot-Api-Secret-Token against ours, in constant time. No secret set means no access. */
export function webhookSecretOk(got: string | null | undefined, expected: string | null | undefined): boolean {
  const want = expected?.trim();
  if (!want || !got) return false;
  return timingSafeEqual(sha256(got), sha256(want));
}

// ---------------------------------------------------------------- messages

/** Curly quotes to straight ones, so patterns see one kind of apostrophe. */
export function norm(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
}

/** The message's words: text, or a photo's caption. */
export function messageText(msg: TgMessage): string {
  return (msg.text ?? msg.caption ?? "").trim();
}

/**
 * Every link Telegram marked in a message: a url entity as written, and where
 * a text_link (a link behind other words) points. Telegram knows every domain
 * ending, so these catch links the text pattern can't.
 */
export function entityLinks(msg: TgMessage): string[] {
  const text = msg.text ?? msg.caption ?? "";
  const out: string[] = [];
  for (const e of msg.entities ?? msg.caption_entities ?? []) {
    if (e.type === "url") {
      const link = text.slice(e.offset, e.offset + e.length).trim();
      if (link) out.push(link);
    } else if (e.type === "text_link" && typeof e.url === "string" && e.url.trim()) {
      out.push(e.url.trim());
    }
  }
  return out;
}

/** Which topic a group message is in. Replies inside General carry a thread id but are not topic messages. */
export function topicOf(msg: TgMessage): number {
  return msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : TOPIC.general;
}

/**
 * The message this one deliberately replies to, or null. In a forum topic every
 * message points at the topic's first message; that is not a reply.
 */
export function explicitReply(msg: TgMessage): TgMessage | null {
  const r = msg.reply_to_message;
  if (!r || r.forum_topic_created) return null;
  if (msg.is_topic_message && r.message_id === msg.message_thread_id) return null;
  return r;
}

function entitiesOf(msg: TgMessage) {
  return msg.entities ?? msg.caption_entities ?? [];
}

/** The bot is tagged by @username or by a mention of its account. */
export function mentionsBot(msg: TgMessage, me: Pick<TgUser, "id" | "username">): boolean {
  const text = messageText(msg);
  const handle = me.username ? `@${me.username}`.toLowerCase() : null;
  for (const e of entitiesOf(msg)) {
    if (e.type === "text_mention" && e.user?.id === me.id) return true;
    if (e.type === "mention" && handle && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle) return true;
  }
  return handle ? new RegExp(`(^|[^\\w])${escapeRe(handle)}(?![\\w])`, "i").test(text) : false;
}

/** The words someone added when tagging the bot: the text without its @handle. */
export function withoutTag(text: string, username?: string): string {
  const t = username ? text.replace(new RegExp(`(^|[^\\w])@${escapeRe(username)}(?![\\w])`, "gi"), "$1") : text;
  return t.replace(/\s+/g, " ").trim();
}

/** The persona's name used as a word ("hey Glim", "thanks glim!"). */
/**
 * Speaking to the helper by name: "Glim, ...", "hey glim", "thanks glim!",
 * "what do you think, glim?". Talking about it ("Glim's answer was wrong") is
 * not a call for it.
 */
export function namesPersona(text: string, name: string): boolean {
  if (!name) return false;
  const n = escapeRe(name);
  const t = text.replace(/^(?:@\w+[\s,:]*)+/, "").trim();
  const start = new RegExp(`^(?:(?:hey|hi|hello|yo|ok|okay|thanks|thank you|thx|pls|please|gm|oi)[\\s,]+)?${n}(?![\\p{L}\\p{N}_'\u2019])`, "iu");
  const end = new RegExp(`(?:^|[\\s,])${n}\\s*[?!.]*$`, "iu");
  return start.test(t) || end.test(t);
}

/** Group replies past this many words are cut back to whole paragraphs, then whole sentences. */
export const REPLY_MAX_WORDS = 75;

const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Keeps a group reply short when the model runs long. Numbered steps are left whole. */
export function trimReply(text: string, max = REPLY_MAX_WORDS): string {
  if (wordsIn(text) <= max || /^\s*\d+[.)]\s/m.test(text)) return text;
  const paras = text.split(/\n\s*\n/);
  let out = "";
  for (const p of paras) {
    const next = out ? `${out}\n\n${p}` : p;
    if (wordsIn(next) > max) break;
    out = next;
  }
  if (out) return out;
  let acc = "";
  for (const sentence of sentencesOf(paras[0]!)) {
    const next = acc ? `${acc} ${sentence}` : sentence;
    if (acc && wordsIn(next) > max) break;
    acc = next;
  }
  return acc.trim();
}

/**
 * A paragraph's sentences. A sentence ends at ".", "!" or "?" followed by a
 * space, so "gloam.trade/app" and "1." in a list stay inside their sentence.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=\D[.!?]["')\]]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Paragraphs this long, or longer, get split up. */
const DENSE_WORDS = 18;
/** Sentences this short ride along with the next one. */
const SHORT_SENTENCE = 8;

/**
 * Breaks dense paragraphs into short ones, two sentences each, with a blank
 * line between, so a reply reads like a text message and not a wall. Lists
 * and short paragraphs are left as written.
 */
export function spaceOut(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => {
      if (/^\s*(?:-|\d+[.)])\s/m.test(p) || p.includes("\n") || wordsIn(p) < DENSE_WORDS) return p;
      const s = sentencesOf(p);
      if (s.length < 2) return p;
      // one sentence per paragraph; a short one shares with its neighbour
      const chunks: string[] = [];
      for (const sentence of s) {
        const last = chunks[chunks.length - 1];
        if (last !== undefined && (wordsIn(last) < SHORT_SENTENCE || wordsIn(sentence) < SHORT_SENTENCE / 2) && wordsIn(last) + wordsIn(sentence) <= 22) {
          chunks[chunks.length - 1] = `${last} ${sentence}`;
        } else {
          chunks.push(sentence);
        }
      }
      return chunks.join("\n\n");
    })
    .join("\n\n");
}

export type Command = { name: string; args: string; forOther: boolean };

/** A slash command. `forOther` when it names a different bot (/help@otherbot). */
export function parseCommand(text: string, botUsername?: string): Command | null {
  const m = /^\/([a-z0-9_]{1,32})(?:@([a-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const target = m[2]?.toLowerCase();
  return {
    name: m[1]!.toLowerCase(),
    args: (m[3] ?? "").trim(),
    forOther: Boolean(target && target !== botUsername?.toLowerCase()),
  };
}

const REPORT_LEAD = String.raw`(?:(?:hey|hi|yo|ok|okay|so|pls|please|can\s+i\s+(?:get|have|see)|send(?:\s+me)?|give\s+me|show\s+me|get\s+me|the|a|my|today'?s|daily|full|group|24h|24\s*hours?|last\s+24\s*hours?)[\s,]+)*`;
const REPORT_ASK = new RegExp(
  String.raw`^\/?${REPORT_LEAD}(?:report|stats|statistics|summary)(?:\s+(?:pls|please|for\s+today|today|now))*[\s?.!]*$`,
  "i",
);
const DAY_ASK = new RegExp(
  String.raw`^${REPORT_LEAD}how\s+(?:was|is|did)\s+(?:today|the\s+day|the\s+group|it\s+go)(?:\s+(?:today|so\s+far))?[\s?.!]*$`,
  "i",
);

/**
 * The owner asking for the report in plain words, and nothing else: "report",
 * "daily report pls", "stats?", "how was today". Anything more ("summary of
 * the Help topic", "draft a post about the report") is a chat.
 */
export function wantsReport(text: string): boolean {
  const t = norm(text).trim();
  return REPORT_ASK.test(t) || DAY_ASK.test(t);
}

const PEOPLE = String.raw`(?:boss\s+duke|duke|the\s+team|an?\s+admin|the\s+admins)`;
const HAND_OFF = [
  /\badmins?\s+will\s+(?:follow\s+up|take\s+a\s+look|look\s+into|get\s+back|check)\b/i,
  new RegExp(
    String.raw`\b(?:i'll|i\s+will|let\s+me|i'm|i\s+am)\s+(?:talk(?:ing)?\s+to|ping(?:ing)?|tell(?:ing)?|tak(?:e|ing)\s+(?:this|it)\s+to|flag(?:ging)?\s+(?:this|it)\s+(?:to|for)|run(?:ning)?\s+(?:this|it)\s+by|pass(?:ing)?\s+(?:this|it)\s+(?:on\s+)?to|hand(?:ing)?\s+(?:this|it)\s+(?:over\s+)?to)\s+` + PEOPLE + String.raw`\b`,
    "i",
  ),
  new RegExp(String.raw`\b(?:flagging|passing|handing)\s+(?:this|it)\s+(?:on\s+|over\s+)?(?:to|for)\s+` + PEOPLE + String.raw`\b`, "i"),
  /\bi(?:'ve|\s+have)\s+(?:flagged|passed|handed|escalated)\s+(?:this|it)\b/i,
];

/** A reply that hands the person to an admin ("an admin will follow up", "flagging this for Boss Duke"). */
export function handsToAdmin(text: string): boolean {
  const t = norm(text);
  return HAND_OFF.some((re) => re.test(t));
}

/** The message tags one of these handles (lower case, no "@"), or mentions one of these accounts. */
export function tagsSomeone(msg: TgMessage, handles: string[], ids: number[] = []): boolean {
  for (const e of entitiesOf(msg)) if (e.type === "text_mention" && e.user && ids.includes(e.user.id)) return true;
  const text = messageText(msg).toLowerCase();
  return handles.some((h) => new RegExp(`(^|[^\\w@])@${escapeRe(h.toLowerCase())}(?![\\w])`).test(text));
}

const TOPIC_WORD =
  /\b(?:gloam|faucets?|proofs?|prove|payroll|recovery|backups?|wallets?|passkeys?|tempo|robinhood|networks?|chains?|deposits?|add(?:ed|ing)?|shield(?:ed|ing)?|cash(?:ing)?\s*out|withdraw\w*|claim\w*|codes?|links?|address(?:es)?|phrase|passphrase|balances?|vaults?|mainnet|testnet|tokens?|stocks?|usdg|pathusd|ousd|eth|gas|rewards?|testers?|testing|snapshot|airdrop|fees?|relay|send|sent|pay(?:ment)?s?|receiv\w*|move|portfolio|settings|transactions?|tx|docs|metamask|rabby|tsla|amzn|pltr|nflx|amd)\b/i;

/**
 * Too little to go on ("help", "it's not working", a bare tag): no Gloam word
 * and only a few words. The fallback then asks what happened instead of
 * handing it to an admin.
 */
export function isVague(text: string, persona: string): boolean {
  let t = norm(text).replace(/(?<![\w@])@\w+/g, " ");
  if (persona) t = t.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(persona)}(?=$|[^\\p{L}\\p{N}_])`, "giu"), "$1 ");
  t = t.replace(/[^\p{L}\p{N}'\s]/gu, " ");
  const words = t.split(/\s+/).filter(Boolean);
  return words.length === 0 || (words.length < 8 && !TOPIC_WORD.test(t));
}

/** Words that make a tag worth an answer: an ask, a problem, a request. */
const ASK_WORD =
  /\b(?:help|how|what|whats|why|where|when|wen|who|which|can|could|should|would|will|does|do|did|is|are|pls|plz|please|explain|tell|show|need|want|issue|problem|error|bug|stuck|fail\w*|broken|not|can't|cant|cannot|won't|didn't|doesn't|isn't|missing|lost|wrong|pending|gone)\b/i;

/**
 * A tag or a reply to the helper with nothing to answer: "haha thanks", "gm
 * glim", "you're the best", "lol". No question, no ask, no problem and no
 * Gloam word, and short. A bare tag is not chatter (the helper asks what they
 * need), and neither is a vague ask like "help".
 */
export function isChatter(text: string, persona: string): boolean {
  let t = norm(text).replace(/(?<![\w@])@\w+/g, " ").replace(URL_RE, " ");
  if (persona) t = t.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(persona)}(?=$|[^\\p{L}\\p{N}_])`, "giu"), "$1 ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return false;
  if (t.includes("?") || looksLikeQuestion(t) || ASK_WORD.test(t) || BUG_WORDS.test(t) || MY_PROBLEM.test(t) || TOPIC_WORD.test(t)) return false;
  return t.split(/\s+/).length <= 10;
}

// ---------------------------------------------------------------- triggers

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const GREETING = /^(?:(?:hi|hey|hello|yo|gm|hiya|guys|all|everyone|team|folks|pls|please|ok|okay|okk|so|hmm|wait|but|then|also|alright|bro|boss)\b[\s,!.:-]*)+/i;
const QUESTION_START =
  /^(?:how|what|why|where|when|wen|who|which|whats|can|could|would|will|should|does|do|did|is|are|has|have|any|anyone|anybody|i can't(?! wait)|i cant(?! wait)|i cannot|i can not|not working|error|pls|please explain|brief me|explain|tell me|walk me|show me|guide me|help me|teach me|i need help)(?![\p{L}\p{N}_])/iu;
/** "my ..." is a question only with a problem in it: "my balance is gone", not "my gloam address". */
const MY_PROBLEM =
  /\b(?:not|no longer|isn't|isnt|wasn't|won't|wont|can't|cant|cannot|didn't|didnt|doesn't|doesnt|missing|gone|disappeared|vanished|showing|shows|stuck|zero|empty|lost|wrong|failed|fails|error|broken|pending)\b/i;

/**
 * Reads like a question, which the helper answers unprompted in every topic
 * except Announcements. Conservative: a "?" or one of a few opening words.
 */
/** Words that hint a message is about Gloam or a problem, worth a quick check when it isn't phrased as a question. */
const HELP_HINT =
  /\b(?:gloam|glim|wallet|network|chain|faucet|tempo|robinhood|testnet|tokens?|deposit|add(?:ed|ing)?|privately|claim|code|phrase|error|can'?t|cannot|not working|stuck|fail\w*|issue|bug|testers?|rewards?|app|site|website|recovery|passkey|proofs?|payments?|send|receive|balance|eth|usdg|stocks?)\b/i;

/** A code, claim link, request or address label, as scanCodes leaves them in the text. */
const SHARED_LABEL = /\[(?:Gloam address|sealed payment|plain payment code|locked payment code|claim link[^\]]*|payment request link)\]/i;

/**
 * Someone sharing a payment, a claim link or their address for others to use,
 * like the app's own "Gloam private payment ... Ask me for the passphrase
 * separately" text. Not for the helper unless it also asks or reports a problem.
 */
export function isShare(text: string): boolean {
  if (!SHARED_LABEL.test(text)) return false;
  const rest = text.replace(new RegExp(SHARED_LABEL.source, "gi"), " ");
  return !rest.includes("?") && !BUG_WORDS.test(rest) && !/\b(?:help|how do i|can't|cant|cannot|won't|doesn't|didn't)\b/i.test(rest);
}

/** A problem or an ask in a message that is not phrased as a question: "can't", "stuck", "error", "how to". */
export const PROBLEM_HINT =
  /\b(?:can'?t|cannot|can not|couldn'?t|won'?t|doesn'?t|didn'?t|isn'?t|wasn'?t|not\s+(?:working|showing|loading|going|getting|seeing|able|sure)|stuck|fail\w*|errors?|issues?|problems?|bugs?|broken|missing|pending|wrong|lost|gone|disappeared|help|how\s+(?:do|can|to)|where\s+(?:do|is|can))\b/i;
/** Price and valuation talk: an opinion, never a question for Glim on its own ("undervalued", "20M level", "bullish"). */
const VALUATION =
  /\b(?:under\s*valued|over\s*valued|valuation|mcap|market\s*cap|fdv|\d+\s*(?:k|m|mil|million)\s+(?:level|mc|mcap|cap)|consolidat\w*|sideways|bullish|bearish|moon\w*|pump\w*|dump\w*|dip|ath|wagmi|ngmi|lfg|hodl|hold(?:ing)?|bags?|chart|support\s+level|resistance|\d+\s?x)\b/i;

/**
 * Worth asking the model whether the helper should reply to a message that is
 * not phrased as a question: a problem word in four words or more, or a longer
 * statement about Gloam (it may be a wrong claim). Price and valuation talk
 * with no problem in it never is.
 */
export function mayNeedHelp(text: string): boolean {
  const t = norm(text).replace(URL_RE, " ").trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (!HELP_HINT.test(t)) return false;
  const problem = PROBLEM_HINT.test(t);
  if (!problem && VALUATION.test(t)) return false;
  return (words >= 4 && problem) || words >= 7;
}

export function looksLikeQuestion(text: string): boolean {
  const t = norm(text)
    .replace(URL_RE, " ")
    .replace(/^(?:@\w+[\s,:]*)+/, "")
    .trim()
    .replace(GREETING, "")
    .trim();
  if (t.length < 8 || t.split(/\s+/).length < 2) return false;
  if (t.includes("?")) return true;
  // any sentence can carry the ask: "Okay. Brief me on what's to be done. How's it meant to go"
  return t
    .split(/(?<=[.!\n])\s+/)
    .map((part) => part.trim().replace(GREETING, "").trim())
    .some((part) => (/^my\b/i.test(part) ? MY_PROBLEM.test(part) : QUESTION_START.test(part)));
}

export const BUG_WORDS =
  /\b(?:bugs?|buggy|broken|crash(?:ed|es|ing)?|glitch(?:y|es)?|not (?:[a-z]+ ){0,2}working|isn't (?:[a-z]+ ){0,2}working|no longer works?|keeps? failing|doesn't work|does not work|didn't work|won't (?:load|open|work|connect|send|go through)|stuck|fail(?:s|ed|ing|ure)?|errors?)\b/i;
const NOT_A_BUG = /\b(?:no|zero|without|any|found no)\s+(?:bugs?|issues?|errors?)\b|\bbug[- ]free\b/i;

/** Reads like a bug report, for Testers and Feedback. Needs a few words and a problem word. */
export function looksLikeBugReport(text: string): boolean {
  const t = norm(text);
  if (t.split(/\s+/).filter(Boolean).length < 4) return false;
  return BUG_WORDS.test(t) && !NOT_A_BUG.test(t);
}

// ---------------------------------------------------------------- scams and secrets

const NEGATION = /\b(?:never|not|no one|nobody|don't|do not|won't|will not|shouldn't|should not|can't|cannot)\b|n't\b/i;

/**
 * Whether a match is negated in its own clause: "never share your seed phrase"
 * is advice, "don't worry, just send your seed phrase" is not.
 */
export function negated(text: string, index: number, match: string): boolean {
  const before = text.slice(Math.max(0, index - 40), index);
  const clause = before.slice(before.search(/[^,.;!?\n]*$/));
  return NEGATION.test(`${clause} ${match}`);
}

const SECRET_NOUN = String.raw`(?:(?:seed|recovery|secret|mnemonic|backup)\s*(?:phrase|words?)|private\s*keys?|12[- ]words?|24[- ]words?)`;
const SECRET_REQUEST = new RegExp(
  String.raw`\b(?:send|share|give|provide|submit|drop|paste|dm)\s+(?:it\s+|me\s+|us\s+)?(?:your|ur)\s+(?:wallet'?s?\s+)?` + SECRET_NOUN,
  "i",
);
const SECRET_QUESTION = new RegExp(String.raw`\bwhat(?:'s| is)\s+(?:your|ur)\s+(?:wallet'?s?\s+)?` + SECRET_NOUN, "i");
const OFFER_DM =
  /\b(?:dm|pm|inbox|message|text|contact|write to)\s+(?:me|us|@\w{3,})\b[^.!?\n]{0,40}?\b(?:for|to get|to receive)\s+(?:quick |instant |fast |direct )?(?:support|help|assistance|a fix|fixing|recovery|refunds?|your (?:issue|problem|funds|wallet))\b/i;
const SUPPORT_AT =
  /\b(?:support|help ?desk|customer (?:care|service)|tech(?:nical)? (?:team|support)|admins?|moderators?)\b[^.!?\n]{0,30}?\b(?:on|via|at|in|through)\s+(?:dm|pm|inbox|@\w{3,}|t\.me\/\w+)/i;
const ASKING = /\b(?:can|could|would|will|pls|plz|please)\s+(?:someone|anyone|somebody|an? (?:admin|mod|moderator)|the team|you)\b/i;
/** Paid shilling: volume, market cap, exposure, calls, KOLs, listings, offered to the project. */
const PROMO =
  /\b(?:trading\s+volume|more\s+volume|volume\s+(?:boost|bot|service)|higher\s+(?:mc|mcap|market\s*cap)|pump\s+(?:your|the)\s+(?:chart|token|coin)|fast\s+exposure|investor\s+reach|real\s+investors?|marketing\s+(?:services?|campaign|package)|promot(?:e|ion)\s+(?:your|the)\s+(?:project|token|coin)|promotion\s+services?|kols?\b|shill(?:ing|ers)?|calls?\s+(?:channel|group)|trending\s+(?:service|spot)|cmc\s+listing|coingecko\s+listing|listing\s+(?:service|agent)|ama\s+(?:service|session\s+with\s+our))\b/i;
/** "Follow him, he gives good signals", "join this caller, legit gems": pushing a call channel. */
const SHILL_FOLLOW =
  /\b(?:follow|join|check\s+out|subscribe\s+to)\s+(?:him|her|them|this\s+(?:guy|channel|caller|group)|my|our|his)\b[^.!?\n]{0,60}\b(?:signals?|calls?|gems?|alpha|legit|\d+x|x\s*moves?|pumps?)\b/i;
/** A post from a call channel: "80x move", "just tapped $2M market cap", "our call". */
const CALL_POST = /\b(?:\d+(?:\.\d+)?x\s+(?:move|gain|from)|x\d+\b|just\s+(?:tapped|hit)\s+\$?\d|from\s+our\s+(?:call|entry|alpha)|(?:gem|alpha|caller)'?s?\s+calls?|new\s+call\b|call\s+channel)/i;

/** A message forwarded or quoted from a channel or group that reads like a paid call. */
export function forwardedCall(text: string): boolean {
  return CALL_POST.test(norm(text)) || SHILL_FOLLOW.test(norm(text));
}

/** Asking to be contacted privately: "DM me", "D.m for collab", "inbox us for details". */
export const DM_ASK =
  /\b(?:d\.?\s?m|p\.?\s?m|inbox|message|contact|text)\s+(?:me|us)\b|\bhit\s+(?:me|us)\s+up\b|\b(?:d\.?\s?m|p\.?\s?m|inbox)\s+(?:me\s+|us\s+)?(?:for|to)\b|\b(?:d\.?\s?m|p\.?\s?m|inbox)\s+(?:collab\w*|partnership|promo\w*|details|business|deals?|offers?)\b/i;
/** "All holders DM me", "investors inbox me now": a stranger pulling the people with money into private chats. */
const DM_LURE =
  /\b(?:all\s+)?(?:holders?|investors?|buyers?|whales?)\b[^.!?\n]{0,30}?\b(?:dm|pm|inbox|message|text|contact)\s+(?:me|us)\b/i;
/**
 * "Everyone DM me", "DM me now": the same pull, but members say it too ("dm me
 * now lol"), so it comes down with a warning and never costs a place in the
 * group. "Testers, DM me if you want to pair up" is an invitation, left alone.
 */
const DM_CHAT =
  /\b(?:everyone|every\s*one|members?|testers?|users?|community|fam|guys)\b[^.!?\n]{0,30}?\b(?:dm|pm|inbox|message|text|contact)\s+(?:me|us)\b|\b(?:dm|pm|inbox|message)\s+(?:me|us)\s+(?:now|immediately|asap|urgently|quick(?:ly)?|right\s+now|fast)\b/i;
export const INVITATION = /^\W*(?:if|when)\s+(?:you|u|ya|anyone|someone|any\s+of\s+you)\b/i;
const WALLET_FIX =
  /\b(?:validate|validation|rectify|rectification|reactivate|synchroni[sz]e|resync|whitelist)\s+(?:your\s+|ur\s+|the\s+)?wallets?\b|\bsync\s+(?:your|ur)\s+wallets?\b|\bwallet\s+(?:validation|rectification|synchroni[sz]ation)\b/i;
/**
 * Endings that look like a domain's but are file types or wallet names, never
 * a top-level domain ("app.tsx", "duke.eth"). Any other ending of two or more
 * letters (or an encoded one, xn--) is read as a domain: new and country
 * endings (.ru, .cfd, .support) are where look-alike sites live.
 */
const NOT_A_TLD =
  "js|jsx|mjs|cjs|ts|tsx|json|jsonl|txt|csv|tsv|png|jpe?g|gif|webp|svg|pdf|html?|s?css|sol|eth|mp[34]|wav|ya?ml|toml|lock|log|env|ini|cfg|exe|dll|wasm|zkey|circom|rb|java|kt|swift|cpp|hpp|go|gz|tar|rar";
export const LINK_RE = new RegExp(
  `\\b(?:https?:\\/\\/[^\\s<>"']+|www\\.[^\\s<>"']+|t\\.me\\/[^\\s<>"']+|(?:[a-z0-9-]+\\.)+(?!(?:${NOT_A_TLD})(?![a-z0-9-]))(?:xn--[a-z0-9-]{2,59}|[a-z]{2,24})(?![a-z0-9-])(?:\\/[^\\s<>"']*)?)`,
  "gi"
);
const LURE =
  /\b(?:wallets?|claim(?:ing|ed)?|airdrops?|giveaways?|rewards?|bonus|free (?:tokens?|money|usdc|usdt|eth|crypto)|connect|whitelist|presale|mint|eligible|allocation)\b/i;
/**
 * Hosts people post here for good reasons (faucets, explorers, wallets, the
 * bridge, $GLOAM's pages and pool). Not flagged as phishing, and neither is any
 * link the helper may share itself.
 */
export const SAFE_HOSTS = [
  "gloam.trade",
  "x.com",
  "twitter.com",
  "robinhood.com",
  "robin.etherscan.io",
  "tempo.xyz",
  "paxos.com",
  "github.com",
  "metamask.io",
  "rabby.io",
  "relay.link",
  "uniswap.org",
  "orynth.dev",
  "dexscreener.com",
  "coingecko.com",
  "imgur.com",
  "prnt.sc",
  "loom.com",
  "youtube.com",
  "youtu.be",
  // explorers, faucets, bridges, exchanges and file hosts people paste with a problem
  "blockscout.com",
  "basescan.org",
  "etherscan.io",
  "base.org",
  "alchemy.com",
  "circle.com",
  "chain.link",
  "quicknode.com",
  "pk910.de",
  "coinbase.com",
  "binance.com",
  "kraken.com",
  "okx.com",
  "bybit.com",
  "coinmarketcap.com",
  "geckoterminal.com",
  "dextools.io",
  "drive.google.com",
  "docs.google.com",
];

export function hostOf(link: string): { host: string; path: string } {
  const bare = link.replace(/^https?:\/\//i, "").replace(/[).,!?;:'"]+$/, "");
  const slash = bare.indexOf("/");
  const host = (slash < 0 ? bare : bare.slice(0, slash)).toLowerCase().replace(/^www\./, "");
  const path = slash < 0 ? "" : bare.slice(slash);
  return { host, path };
}

export function onHost(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function isGroupLink(host: string, path: string): boolean {
  return host === "t.me" && /^\/gloamhq(?:[/?#]|$)/i.test(path);
}

/** Someone asking for help ("can someone DM me for help?") rather than offering it. */
export function askingForHelp(text: string, m: RegExpExecArray): boolean {
  const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length);
  const end = text.slice(m.index).search(/[.!?\n]/);
  return ASKING.test(around) || (end >= 0 && text[m.index + end] === "?");
}

export type ScamReason =
  | "secret_request"
  | "dm_support"
  | "dm_lure"
  | "wallet_fix"
  | "phishing_link"
  | "promo_spam"
  | "migration_airdrop"
  | "role_impostor"
  | "role_pitch"
  | "support_at";

/**
 * Reasons that take the message down with a warning but leave the person in
 * the group: they read like a scam, but ordinary members say them too.
 */
export const WARN_ONLY: ReadonlySet<ScamReason> = new Set<ScamReason>(["dm_lure", "role_pitch", "support_at"]);

/** "No presale and no team allocation": a drop word said to deny one. */
const NO_DROP = /\bno\s+(?:presales?|(?:team\s+|insider\s+)?allocations?|airdrops?|whitelists?|giveaways?)\b/gi;

/** Letters that only look Latin: Cyrillic and Greek ones, and small capitals ("\u1d0f\u1d21\u0274\u1d07\u0280"), which have no plain form in Unicode. */
const LOOKALIKE: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0456": "i", "\u04cf": "l",
  "\u03bf": "o", "\u03b1": "a", "\u0131": "i", "\u217c": "l",
  // Cyrillic and Greek capitals (and a few small letters) that read as Latin ones: "DМ mе" with a Cyrillic М
  "\u0410": "a", "\u0412": "b", "\u0415": "e", "\u041a": "k", "\u041c": "m", "\u041d": "h", "\u041e": "o", "\u0420": "p",
  "\u0421": "c", "\u0422": "t", "\u0425": "x", "\u0423": "y", "\u0406": "i", "\u0408": "j", "\u0405": "s",
  "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u0442": "t", "\u0443": "y", "\u0432": "b", "\u0458": "j", "\u0455": "s", "\u04bb": "h", "\u0501": "d",
  "\u0391": "a", "\u0392": "b", "\u0395": "e", "\u0396": "z", "\u0397": "h", "\u0399": "i", "\u039a": "k", "\u039c": "m",
  "\u039d": "n", "\u039f": "o", "\u03a1": "p", "\u03a4": "t", "\u03a5": "y", "\u03a7": "x",
  "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03c1": "p", "\u03c4": "t", "\u03c5": "u", "\u03c7": "x",
};
const SMALL_CAPS = "\u1d00\u0299\u1d04\u1d05\u1d07\ua730\u0262\u029c\u026a\u1d0a\u1d0b\u029f\u1d0d\u0274\u1d0f\u1d18\ua7af\u0280\ua731\u1d1b\u1d1c\u1d20\u1d21\u028f\u1d22";
[..."abcdefghijklmnopqrstuvwyz"].forEach((l, i) => (LOOKALIKE[SMALL_CAPS[i]!] = l));

/** Words split to dodge a filter: "re deploying", "air drop", "pre sale". */
const SPLIT_WORD = /\b(re|air|white|give|pre|snap)[\s-]+(deploy\w*|launch\w*|drop\w*|list\w*|away\w*|sale\w*|shot\w*|fund\w*|imburs\w*)/gi;

/**
 * Text as a reader sees it: full-width and fancy letters made plain, hidden
 * characters out, look-alike letters swapped, and letters spaced out
 * ("D M me", "A d m i n") or split ("re deploying") joined up again.
 */
export function plain(raw: string): string {
  return norm(raw)
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, "")
    .replace(/./gu, (ch) => LOOKALIKE[ch] ?? LOOKALIKE[ch.toLowerCase()] ?? ch)
    .replace(/\b[a-z](?:[ .][a-z]){1,}\b(?![.]?[a-z])/gi, (m) => m.replace(/[ .]/g, ""))
    .replace(SPLIT_WORD, "$1$2");
}

/**
 * The words that get scored: Glim's own token card and facts taken out (they
 * name presales and allocations next to Orynth and DEX Screener links, and a
 * member repeating them is no lure), and so are the labels scanCodes puts in
 * place of codes ("[claim link]" is a payment, not a claim pitch).
 */
export function scorable(raw: string): string {
  let text = plain(raw);
  for (const line of tokenCard().split("\n")) if (line.trim()) text = text.split(line.trim()).join(" ");
  return text.replace(new RegExp(SHARED_LABEL.source, "gi"), " ").replace(NO_DROP, " ");
}

const DIGIT_LETTER: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };

/**
 * The text, and the text with digits inside words read as letters
 * ("r3deploying airdr0p", "cla1m"), once with 1 as i and once as l. Numbers,
 * amounts ("0.1eth") and hex (addresses, hashes) are left alone.
 */
export function spellings(text: string): string[] {
  const as = (one: string) =>
    text.replace(/[a-z0-9@]+/gi, (w) => {
      if (/^0x/i.test(w) || /^[0-9a-f]{16,}$/i.test(w) || /^\d+[a-z]*$/i.test(w) || (w.match(/[a-z]/gi)?.length ?? 0) < 2) return w;
      return w.replace(/(?<=[a-z])[0-9@]|[0-9@](?=[a-z])/gi, (d) => (d === "1" ? one : d === "@" ? "a" : (DIGIT_LETTER[d] ?? d)));
    });
  return [...new Set([text, as("i"), as("l")])];
}

/** "We are redeploying the CA", "migrating to a new contract", "v2 token", "V2 coming". */
const MIGRATION =
  /\b(?:re-?deploy\w*|migrat\w*|relaunch\w*|new\s+(?:ca|contract|token)\b|v2\s+(?:token|contract|ca|is\s+(?:coming|live)|coming|launch\w*)\b|token\s+swap|contract\s+(?:swap|upgrade))/i;
/** What the fake migration promises: an airdrop, a snapshot, compensation. */
const DROP = /\b(?:airdrop\w*|snapshot\w*|compensat\w*|reimburs\w*|refund\w*|claim\w*)/i;
/** ...and the catch: talk to me privately, send me your transaction, register. */
const PRIVATE_ASK =
  /\b(?:send|dm|pm|inbox|message|text|contact)\s+(?:me|us)\b|\bhit\s+(?:me|us)\s+up\b|\b(?:send|share|drop)\s+(?:your\s+|ur\s+|any\s+)?(?:tx|txn|transaction)\b|\bto\s+register\b|\bregister\s+(?:for|your)\b/i;
/** "Send me 0.1 ETH", "transfer your funds to this wallet": a pull for money. An address is not money: "send me your address" is how people test payments. */
const FUNDS_PULL =
  /\b(?:send|transfer|pay)\s+(?:me|us)\s+(?:your\s+|ur\s+|some\s+|the\s+|any\s+|a\s+(?:little|bit|few)\s+(?:of\s+)?|[\d.,]+\s*)?(?:funds|money|cash|eth|usdc|usdt|usdg|crypto|tokens?|\$gloam|gas)\b(?!\s*(?:address|addr|code|link|hash))|\b(?:send|transfer|move)\s+(?:your\s+|ur\s+|the\s+|all\s+(?:your\s+)?|[\d.,]+\s*)?(?:funds|money|eth|usdc|usdt|usdg|crypto|tokens?|\$gloam)\s+to\s+(?:me|us|my|our|this|the\s+(?:new|safe|secure|below)|0x)/i;
/** "Connect your wallet", "verify your wallet": a pull for a signature. Pointing at gloam.trade itself is not. */
const WALLET_PULL = /\b(?:connect|verify|validate|link|sync|unlock|restore)\s+(?:your|ur)\s+wallets?\b/i;
/** "Send me your tx hash" ... */
const TX_PULL =
  /\b(?:send|share|drop|post|dm|pm|give|submit)\s+(?:me\s+|us\s+)?(?:your\s+|ur\s+|any\s+|the\s+)?(?:tx|txn|transaction)s?(?:\s*(?:hash|id)s?)?\b|\b(?:tx|txn|transaction)\s*(?:hash|id)\b[^.!?\n]{0,30}\b(?:dm|pm|inbox|to\s+register)\b/i;
/** ... for an airdrop, a refund or a snapshot: what the fake drop promises. A claim is not one (people claim payments here). */
const DROP_PROMISE = /\b(?:airdrop\w*|snapshot\w*|compensat\w*|reimburs\w*|refund\w*|whitelist\w*|allocation\w*)/i;
/** What makes an "if you want ..." the lure itself: doubling, early access, loading up, profit, free tokens, 10x. */
const PITCH_IF = /\b(?:double|bags?|early\s+access|load\s+up|profits?|free|\d+\s?x|airdrop\w*|allocation\w*|presale|whitelist\w*|returns?|invest\w*|signals?|gems?|pumps?|bonus\w*|rewards?|claim\w*)\b/i;

/**
 * "All holders DM me", said outright. In one message always, "if you want to
 * double your bag" included. Only where `glued` (several messages read
 * together) does an ask that goes on with a plain "if" or "when" stay a
 * member's offer of a hand: "holders, the docs are updated" then "dm me if you
 * get stuck". An if-clause with money or pitch words is the lure either way.
 */
function lures(text: string, glued = false): boolean {
  for (const m of text.matchAll(new RegExp(DM_LURE.source, "gi"))) {
    if (negated(text, m.index, m[0]) || asked(text, m.index, m[0].length) || askingForHelp(text, m as RegExpExecArray)) continue;
    const rest = text.slice(m.index + m[0].length);
    if (glued && /^\W*(?:if|when)\b/i.test(rest) && !PITCH_IF.test(rest.split(/[.!?\n]/)[0] ?? "")) continue;
    return true;
  }
  return false;
}

/** One message that announces the fake migration on its own: a redeploy or a new contract, and a drop or a snapshot. */
export function announcesMigration(raw: string): boolean {
  return spellings(scorable(raw)).some((t) => says(MIGRATION, t) && says(DROP, t));
}

/** A drop pitch: "airdrop", "presale", "allocation". Claims, rewards and snapshots are everyday talk here. */
const DROP_WORDS = /\b(?:airdrop|giveaway|whitelist|presale|allocation)\w*/i;

/** The sentence a match sits in, from the stop before it to the stop after it. */
function sentenceAt(text: string, index: number, length: number): string {
  const start = Math.max(...[".", "!", "?", "\n"].map((c) => text.lastIndexOf(c, index - 1))) + 1;
  const after = text.slice(index + length).search(/[.!?\n]/);
  return text.slice(start, after < 0 ? text.length : index + length + after + 1);
}

/** A match in a question ("is there an airdrop?", "can someone DM me?"): asked, not said. */
function asked(text: string, index: number, length: number): boolean {
  const s = sentenceAt(text, index, length);
  return /\?\s*$/.test(s) || ASKING.test(s);
}

/** Said outright somewhere in the text: a match that is neither negated in its clause nor in a question. */
export function says(re: RegExp, text: string): boolean {
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
    if (!negated(text, m.index, m[0]) && !asked(text, m.index, m[0].length)) return true;
  }
  return false;
}

/**
 * Obvious scam patterns, conservative on purpose: asking for a seed phrase or
 * private key, offering support in DMs, "validate/sync/rectify your wallet",
 * or a link to a strange site next to wallet, claim or airdrop wording. Safety
 * advice ("never share your seed phrase") and people asking for help are not
 * flagged. Look-alike letters, digits for letters ("airdr0p") and spaced-out
 * words are read the way a person reads them.
 */
export function scamReason(raw: string, glued = false, links: readonly string[] = []): ScamReason | null {
  const text = scorable(raw);
  let warned: ScamReason | null = null;
  for (const t of spellings(text)) {
    const why = wordsReason(t, text, glued, links);
    if (why && !WARN_ONLY.has(why)) return why;
    warned ??= why;
  }
  return warned;
}

/** scamReason for one spelling of the text; links are read from the text as written, plus the ones Telegram marked (`links`). */
function wordsReason(text: string, written: string, glued = false, links: readonly string[] = []): ScamReason | null {
  for (const re of [SECRET_REQUEST, SECRET_QUESTION]) {
    const m = re.exec(text);
    if (m && !negated(text, m.index, m[0])) return "secret_request";
  }
  for (const re of [OFFER_DM, SUPPORT_AT]) {
    const m = re.exec(text);
    if (m && !negated(text, m.index, m[0]) && !askingForHelp(text, m) && !/\b(?:gloamhq|gloamtrade)\b/i.test(m[0])) {
      // another project's support group ("Relay support is at t.me/relaysupport"): the link goes, the member stays
      if (re === SUPPORT_AT && /t\.me\/\w+$/i.test(m[0]) && !/\b(?:gloam|glim)/i.test(text)) return "support_at";
      return "dm_support";
    }
  }
  if (lures(text, glued)) return "dm_support";
  const shill = SHILL_FOLLOW.exec(text);
  if (shill && !negated(text, shill.index, shill[0])) return "promo_spam";
  // a shilling service that wants a private chat
  const pitches = text.match(new RegExp(PROMO.source, "gi"))?.length ?? 0;
  if (pitches && DM_ASK.test(text) && (pitches >= 2 || says(DM_ASK, text))) return "promo_spam";
  const fix = WALLET_FIX.exec(text);
  if (fix && !negated(text, fix.index, fix[0])) return "wallet_fix";
  // "we are redeploying the CA ... airdrop to holders ... send me your tx hash to register";
  // safety words around it ("careful", "not fake") change nothing, a negation or a question in its own sentence does
  if (says(MIGRATION, text) && says(DROP, text) && says(PRIVATE_ASK, text)) return "migration_airdrop";
  if (LURE.test(text)) {
    for (const link of [...(written.match(LINK_RE) ?? []), ...links]) {
      const { host } = hostOf(link);
      if (!linkAllowed(link) && (host === "t.me" || !SAFE_HOSTS.some((s) => onHost(host, s)))) return "phishing_link";
    }
  }
  const chat = DM_CHAT.exec(text);
  if (chat && !negated(text, chat.index, chat[0]) && !askingForHelp(text, chat) && !INVITATION.test(text.slice(chat.index + chat[0].length))) {
    return "dm_lure";
  }
  return null;
}

/**
 * A real pull for funds or secrets: send me money, a seed phrase or key,
 * connect or verify your wallet, a tx hash for an airdrop, holders into DMs.
 * The only thing a role in a name gets someone removed for.
 */
function realPull(text: string, glued = false): boolean {
  if (says(SECRET_REQUEST, text) || says(FUNDS_PULL, text) || lures(text, glued)) return true;
  if (says(WALLET_PULL, text) && !/\bgloam\.trade\b/i.test(text)) return true;
  return says(TX_PULL, text) && DROP_PROMISE.test(text);
}

const BIP39 = new Set(english);
const HEX64 = /(?<![0-9a-zA-Z/=])(0x)?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/g;
const KEY_HINT = /\b(?:private\s*key|priv\s*key|secret\s*key|pk|seed|mnemonic|note secret)\b/i;
const HASH_HINT = /\b(?:tx|txn|txid|transaction|hash|commitment|nullifier|root|block|explorer)\b/i;

/** Twelve or more BIP-39 words in a row, the shape of a seed phrase. */
export function hasSeedPhrase(text: string): boolean {
  let run = 0;
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (!w) continue;
    run = BIP39.has(w) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}

/**
 * 64 hex characters that read as a private key. A 0x value is a transaction
 * hash unless the message talks about keys; a bare one is a key unless it
 * talks about transactions. Links (/tx/0x...) are never keys.
 */
export function hasPrivateKey(text: string): boolean {
  for (const m of text.matchAll(HEX64)) {
    if (m[1] ? KEY_HINT.test(text) : !HASH_HINT.test(text)) return true;
  }
  return false;
}

export type Leak = "seed_phrase" | "private_key";

/** Someone pasted a seed phrase or a private key. */
export function secretLeak(text: string): Leak | null {
  if (hasSeedPhrase(text)) return "seed_phrase";
  if (hasPrivateKey(text)) return "private_key";
  return null;
}

// ---------------------------------------------------------------- impersonation and moderation

/** Digits and signs scammers swap in for letters. A 1 reads as an l ("GIoam") or an i ("Adm1n"), so names are read both ways. */
const CONFUSABLE: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "l" };

/**
 * Lower case, accents off, look-alikes swapped (small capitals and Cyrillic
 * letters too), separators other than "|" turned into spaces, and letters
 * spaced out ("A d m i n") joined up. `one` is what a 1 reads as.
 */
function skeleton(raw: string, one: "l" | "i" = "l"): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/./gu, (ch) => LOOKALIKE[ch] ?? ch)
    .replace(/./gu, (ch) => (ch === "1" ? one : (CONFUSABLE[ch] ?? ch)))
    .replace(/[^a-z|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z](?: [a-z]\b)+/g, (m) => m.replace(/ /g, ""))
    .trim();
}

/** A name read with a 1 as an l, and as an i. */
function skeletons(raw: string): string[] {
  return [...new Set([skeleton(raw, "l"), skeleton(raw, "i")])];
}

const STAFF = /\b(?:support|admin|admins|team|official|mod|mods|moderator|help|helpdesk|desk|care|service|services|announcements?|airdrop|claims?|rewards?|verify|verification|owner|owners|dev|devs|developer|developers|founder|cofounder|ceo|cto|bot|bots|hq|trade)\b/;
/** "gloamtrade", "glimbot", "gloamsupport": the brand and a staff word run together. */
const BRAND_STAFF_WORD = /\b(?:gloam|glim)(?:support|admins?|team|official|mods?|help|helpdesk|desk|care|service|bots?|hq|trade|devs?|owner)\b/;

/** Words that name a role in a project rather than a person. */
const ROLE = new Set([
  "owner", "owners", "dev", "devs", "developer", "developers", "founder", "founders", "cofounder", "ceo", "cto", "coo",
  "team", "admin", "admins", "mod", "mods", "moderator", "moderators", "support", "official", "officials", "helpdesk", "staff",
]);
/** Little words a role-only name can carry: "The Owner", "Co Founder", "Real Admin", "Customer Support". */
const ROLE_FILLER = new Set(["the", "co", "real", "project", "main", "head", "lead", "customer", "help", "desk", "care", "service", "services", "tech", "technical"]);
/** "Dev" alone is also a common first name, so on its own it is never a role-only name. */
const PERSONAL = new Set(["dev", "devs"]);

/** The name's words, once for each way it reads ("Adm1n" as "admln" and "admin"). */
function nameWords(u: { first_name?: string; last_name?: string }): string[][] {
  return skeletons(`${u.first_name ?? ""} ${u.last_name ?? ""}`).map((n) => n.replace(/\|/g, " ").split(" ").filter(Boolean));
}

/**
 * A display name that is only a role: "Owner", "Owner DEV", "Admin", "Support
 * Team", "The Founder", "Customer Support". Nobody in the group is called that
 * but someone posing as the team. "Dev" alone stays a name.
 */
function roleOnlyName(u: { first_name?: string; last_name?: string }): boolean {
  return nameWords(u).some((words) => {
    const roles = words.filter((w) => ROLE.has(w));
    return roles.length > 0 && words.every((w) => ROLE.has(w) || ROLE_FILLER.has(w)) && roles.some((w) => !PERSONAL.has(w));
  });
}

/**
 * Someone whose name carries a role ("Owner", "Dev Mike", "Support"). A real
 * pull for funds or secrets is a removal ("role_impostor"). A pitch (DM me, an
 * airdrop or presale, a CA migration) only comes down with a warning
 * ("role_pitch"): "Sam | Founder @ Acme" has a role in his name too. A role in
 * a name alone is nothing, and neither is a question: "Dev" asking "is there
 * an airdrop?" is fine. Only ever checked for people who are not the owner or
 * an admin.
 */
export function roleScam(u: { first_name?: string; last_name?: string }, raw: string, glued = false): ScamReason | null {
  const words = nameWords(u).flat();
  if (!words.some((w) => ROLE.has(w))) return null;
  const texts = spellings(scorable(raw));
  if (texts.some((t) => realPull(t, glued))) return "role_impostor";
  const strongRole = words.some((w) => ROLE.has(w) && !PERSONAL.has(w));
  const pitch = (t: string) =>
    (says(MIGRATION, t) && says(DROP_PROMISE, t)) || (strongRole && (says(DM_ASK, t) || says(DROP_WORDS, t)));
  return texts.some(pitch) ? "role_pitch" : null;
}

/** What a member's message comes down for, a removal before a warning: the words' own reason, or the name's. */
/**
 * `glued`: the text is several of one member's messages read together (the
 * split-scam joiner), where a harmless "holders, the docs are updated" and a
 * later "dm me if you get stuck" must not read as the lure.
 */
export function memberScam(u: { first_name?: string; last_name?: string }, raw: string, glued = false, links: readonly string[] = []): ScamReason | null {
  const words = scamReason(raw, glued, links);
  if (words && !WARN_ONLY.has(words)) return words;
  const role = roleScam(u, raw, glued);
  return role && !WARN_ONLY.has(role) ? role : (words ?? role);
}

/**
 * A short quote of what got someone removed, safe for the owner's note: codes
 * as their labels, a secret never, and every link, handle and command broken
 * so nothing in it can be tapped ("gloam-claim[.]xyz", "[@]helpdesk").
 */
export function defanged(raw: string, max = 160): string | null {
  const text = scanCodes(raw).masked;
  if (secretLeak(text)) return "[a seed phrase or key, not repeated]";
  const t = text
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/:\/\//g, "[:]//")
    .replace(/(?<=[\p{L}\p{N}_-])\.(?=\p{L}{2,})/gu, "[.]")
    .replace(/@(?=\w)/g, "[@]")
    .replace(/(^|\s)\/(?=[a-z])/gi, "$1[/]")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

const POINTING =
  /\b(?:scam(?:mer|mers|s|ming)?|fake|impostor|imposter|impersonat\w*|report(?:ed|ing)?|beware|watch\s+out|careful|phishing|spam(?:mer|mers|ming)?|bot\s+account|red\s+flag|don'?t\s+(?:trust|click|dm|reply|send|fall))\b/i;
/** "it says ...", "he said ...", "someone posted ...", and anything in quote marks: someone else's words, reported. */
const REPORTED =
  /\b(?:says|said|saying|tells|told\s+(?:me|us|people|everyone)|wrote|writes|posted|posting|messaged|dm'?d|dmed|is\s+like)\b[^.!?\n]*|"[^"\n]*"/gi;

/** What the sender says themselves: the message without the words it reports. */
export function ownWords(text: string): string {
  return norm(text).replace(REPORTED, " ");
}

/**
 * Someone pointing at a scam rather than running one: a warning word in the
 * message ("scam", "beware", "fake"), and the scam's words only where they
 * report it ("it says all holders DM me"). Their message may be taken down,
 * but it never costs them their place in the group. A scam with a warning
 * stuck on ("DM me for support. Beware of scammers") is still the scam:
 * those words are the sender's own. `scam` scores the own words (scamReason
 * unless the caller weighs the name too).
 */
export function pointsAtScam(text: string, scam: (s: string) => unknown = scamReason): boolean {
  return POINTING.test(norm(text)) && !scam(ownWords(text));
}
const STAFF_IN_HANDLE = /(?:support|admin|team|official|mod|help|desk|care|service|airdrop|claim|reward|verify|trade|hq|bot)/;

/**
 * A member passing themselves off as Gloam, Glim or the team: named "Gloam" or
 * "Glim" (look-alike letters included, "GIoam" with a capital i too), "Gloam
 * Support" and the like, a team tag such as "Duke | Gloam", or a handle like
 * gloam_support, or a name that is only a role ("Owner", "Admin", "Support
 * Team"). Only ever checked for people who are not the owner or an admin.
 */
export function impersonates(u: { first_name?: string; last_name?: string; username?: string }): boolean {
  const posing = skeletons(`${u.first_name ?? ""} ${u.last_name ?? ""}`).some((name) => {
    const words = name.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
    // a capital I looks like an l: "GIoam" reads as Gloam
    const asL = words.replace(/i/g, "l");
    const brandOnly = /^(?:gloam|glim)(?: (?:gloam|glim))*$/.test(words) || /^gloam$/.test(asL);
    const brandStaff = ((/\b(?:gloam|glim)\b/.test(words) || /\bgloam\b/.test(asL)) && STAFF.test(words)) || BRAND_STAFF_WORD.test(words);
    const teamTag = name.includes("|") && /\bgloam\b/.test(asL);
    return brandOnly || brandStaff || teamTag;
  });
  const badHandle = skeletons(u.username ?? "").some((h) => {
    const handle = h.replace(/\s+/g, "");
    return /(?:gloam|glim)/.test(handle) && STAFF_IN_HANDLE.test(handle.replace(/gloam|glim/g, " "));
  });
  return posing || badHandle || roleOnlyName(u);
}

export type ModAction = { remove: boolean };

/** How an order opens: an optional please or "can you", then the verb, with its object where the word alone means something else. */
const MOD_ORDER =
  /^(?:(?:please|pls|plz|ok|okay)[\s,]+)*(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+|pls\s+)?|go\s+ahead\s+and\s+)?(?:delete|remove|kick(?!\s+off\b)|ban|boot|block\s+(?:him|her|them|this|that)|throw\s+(?:him|her|them)\s+out|get\s+(?:him|her|them)\s+out|take\s+(?:it|this)\s+down)\b/;

/**
 * Rose's manual moderation commands. Rose owns them: when an admin types one,
 * Rose acts and Glim stays out of it, so one command never gets two bots
 * acting (and racing) on it.
 */
export const ROSE_COMMANDS = new Set([
  "ban", "unban", "kick", "mute", "unmute", "warn", "warns", "dban", "sban", "tban", "tmute",
  // Rose deletes the replied message (and purges) too.
  "del", "purge", "spurge",
]);

/**
 * An admin telling the helper to act on the message they replied to: /delete
 * (delete it), /spam (delete it and remove the person), or tagging the helper
 * with "delete", "remove", "kick" or "ban". Rose's own commands (/ban, /kick,
 * /del and the rest) are Rose's: the bot ignores them before getting here.
 * Null when it is not that. The words have to open the message as an order:
 * this bans people and deletes what they said, and "which block was the
 * snapshot?", "don't ban him" and "how do they remove the passkey?" are not.
 * `persona` is the helper's name, for "Glim, delete this".
 */
export function moderationAsk(text: string, command: string | null, tagged: boolean, persona = ""): ModAction | null {
  if (command) {
    if (command === "del" || command === "delete") return { remove: false };
    if (command === "spam" || command === "remove") return { remove: true };
    return null;
  }
  if (!tagged) return null;
  const said = norm(text).toLowerCase();
  const t = persona ? said.replace(new RegExp(`^(?:(?:hey|hi|hello|yo|ok|okay|pls|please|oi)[\\s,]+)?${escapeRe(persona.toLowerCase())}[\\s,:]+`, "u"), "") : said;
  if (!MOD_ORDER.test(t)) return null;
  const remove = /\b(?:kick|ban|boot|block\s+(?:him|her|them|this|that)|remove\s+(?:him|her|them|this\s+(?:guy|person|user|account|scammer))|throw\s+(?:him|her|them)\s+out|get\s+(?:him|her|them)\s+out)\b/.test(t);
  const del = /\b(?:delete|remove|take\s+(?:it|this)\s+down)\b/.test(t);
  return remove || del ? { remove } : null;
}

// ---------------------------------------------------------------- payment codes and addresses

/**
 * The Gloam strings people paste, by prefix (lib/notePackage, lib/receiveTag,
 * lib/payroll, lib/paymentRequest):
 *  - address: gloamr1.<key>, a Gloam address. Made to be shared.
 *  - sealed: gloam2t.<...>, a payment sealed to one Gloam address. Only that
 *    address's owner can open it, so it is safe to share.
 *  - plain: gloam1.<...>, a plain payment code, or its short form
 *    gloam3.<letters and digits>. A bearer secret: whoever has it can claim the money.
 *  - locked: gloam1e.<...>, a code locked with a phrase. The code plus the
 *    phrase claims it.
 *  - claim_link: ...#claim=<code>, as bearer as the plain code inside it, or
 *    a short one, gloam.trade/c#<letters and digits> (the same payment).
 *  - request_link: ...#to=gloamr1...&amount=..., only says where to pay.
 * A "Scan to pay privately" QR holds an address or a request, so it is safe too.
 */
export type CodeKind = "address" | "sealed" | "plain" | "locked" | "claim_link" | "request_link";

const CODE_LABEL: Record<CodeKind, string> = {
  address: "[Gloam address]",
  sealed: "[sealed payment]",
  plain: "[plain payment code]",
  locked: "[locked payment code]",
  claim_link: "[claim link]",
  request_link: "[payment request link]",
};

const NOT_URL = String.raw`[^\s<>"'()\[\]]`;
/** A link with #claim=<code> (or the encoded %23claim%3D), all of it. */
const CLAIM_LINK_RE = new RegExp(`${NOT_URL}*?(?:#|%23)claim(?:=|%3D)([A-Za-z0-9_.%=-]{20,})${NOT_URL}*`, "gi");
/**
 * A short claim link: gloam.trade/c#<base62> (www., a scheme, "/c/" or %23 for
 * the "#" all read), all of it. Only on gloam.trade: a lookalike host is left
 * for the scam checks to see.
 */
const SHORT_CLAIM_LINK_RE = new RegExp(String.raw`(?<![A-Za-z0-9.-])(?:https?(?::|%3A)(?:\/|%2F){2})?(?:www\.)?gloam\.trade(?:\/|%2F)c(?:\/|%2F)?(?:#|%23)[0-9A-Za-z]{20,}${NOT_URL}*`, "gi");
/** A payment request link: to=gloamr1... in the fragment or the query. */
const REQUEST_LINK_RE = new RegExp(`${NOT_URL}*?[#?&]to(?:=|%3D)gloamr1\\.[A-Za-z0-9_-]{20,}${NOT_URL}*`, "gi");
/** A bare code. Real ones run to dozens or hundreds of characters; "gloamr1." in a sentence is not one. */
// Links write the dot after the prefix as "=" (older ones "-", launch-day ones "%2E"), so a code cut
// from one is still caught.
// A short code (gloam3.<base62>, the same payment as a short claim link) is as bearer as a plain one.
const RAW_CODE_RE = /(?<![A-Za-z0-9])gloam(r1|2t|1e|1|3)(?:[.=-]|%2[Ee])[A-Za-z0-9_=-]{20,}/g;
/**
 * What a chat app leaves of a plain code it cut at "gloam1": the base64 JSON body ("eyJ..."), maybe
 * after "%2E", ".", "=" or "-". The claim box takes it as the code, so it is masked as one.
 */
const BARE_BODY_RE = /(?<![A-Za-z0-9_-])(?:%2[Ee]|[.=-])?eyJ[A-Za-z0-9_-]{100,}/g;
const RAW_KIND: Record<string, CodeKind> = { r1: "address", "2t": "sealed", "1e": "locked", "1": "plain", "3": "plain" };

/** What a claim link carries: a locked or sealed code keeps its own rules. */
function claimLinkKind(inner: string): { kind: CodeKind; label: string } {
  let code = inner;
  try {
    code = decodeURIComponent(inner);
  } catch {
    // keep it as written
  }
  if (/^gloam1e[.=-]/.test(code)) return { kind: "locked", label: "[claim link with a locked code]" };
  if (/^gloam2t[.=-]/.test(code)) return { kind: "sealed", label: "[claim link to a sealed payment]" };
  return { kind: "claim_link", label: CODE_LABEL.claim_link };
}

function sweepCodes(text: string, kinds: Set<CodeKind>, labels: boolean): string {
  let t = text;
  // cheap checks first, so a long message without codes never runs the link patterns
  if (/claim(?:=|%3D)/i.test(t)) {
    t = t.replace(CLAIM_LINK_RE, (_m, inner: string) => {
      const k = claimLinkKind(inner);
      kinds.add(k.kind);
      return labels ? k.label : " ";
    });
  }
  if (/gloam\.trade(?:\/|%2F)c/i.test(t)) {
    t = t.replace(SHORT_CLAIM_LINK_RE, () => {
      kinds.add("claim_link");
      return labels ? CODE_LABEL.claim_link : " ";
    });
  }
  if (/to(?:=|%3D)gloamr1\./i.test(t)) {
    t = t.replace(REQUEST_LINK_RE, () => {
      kinds.add("request_link");
      return labels ? CODE_LABEL.request_link : " ";
    });
  }
  t = t.replace(RAW_CODE_RE, (_m, p: string) => {
    const kind = RAW_KIND[p]!;
    kinds.add(kind);
    return labels ? CODE_LABEL[kind] : " ";
  });
  return t.replace(BARE_BODY_RE, () => {
    kinds.add("plain");
    return labels ? CODE_LABEL.plain : " ";
  });
}

export type CodeScan = {
  /** The text with each code or link swapped for a label such as [Gloam address]. */
  masked: string;
  /** The text with codes and links taken out, for reading the words around them. */
  rest: string;
  kinds: Set<CodeKind>;
};

/**
 * Finds Gloam codes, addresses and links in a message. The masked text is
 * what the rest of the bot reads: the scam and secret checks (a random code
 * body can look like a link or a key), memory, and the model, which then
 * never sees a bearer code and cannot mix an address up with a claim link.
 */
export function scanCodes(text: string): CodeScan {
  const kinds = new Set<CodeKind>();
  const masked = sweepCodes(text, kinds, true);
  return { masked, rest: sweepCodes(text, new Set(), false), kinds };
}

/** Codes that work like cash in the wrong hands (on mainnet): a plain code or a claim link. */
export function hasBearerCode(kinds: Set<CodeKind>): boolean {
  return kinds.has("plain") || kinds.has("claim_link");
}

const PHRASE_GIVEN =
  /\b(?:pass\s*phrase|phrase|pass\s*word|passcode|pwd?|pass|code\s*word)\s*(?:is|was|=|:|-)\s*\S|\b(?:pass\s*phrase|phrase|pass\s*word|pass)\s+["'\u201c\u2018]|\b(?:lock(?:ed)?|unlock)\s+(?:it\s+)?with\s+\S/i;
const PRIVATE_HINT = /\b(?:dm(?:ed|ing)?|pm|privately|in private|private message|inbox)\b/i;
const CHATTER = new Set(
  (
    "ok okay k kk thanks thank thx ty tysm lol lmao haha hahaha gm gn yes yeah yep yup no nope done sent nice cool great wow " +
    "hi hello hey sure wait claimed received got here this that code enjoy go test testing check please pls what why how who when where"
  ).split(" "),
);

/**
 * The words with a locked code (or a message right after one from the same
 * person) seem to give its phrase away: "phrase is Gloam", "pw: dusk", or just
 * the word on its own line. Not when they say they will send it privately, or
 * when it is a question.
 */
export function sharesPhrase(rest: string): boolean {
  const t = norm(rest).replace(/\s+/g, " ").trim();
  if (!t || t.includes("?") || PRIVATE_HINT.test(t)) return false;
  if (PHRASE_GIVEN.test(t)) return true;
  const word = t.replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019.!]+$/g, "");
  return /^\S{2,40}$/.test(word) && !CHATTER.has(word.toLowerCase()) && !/^(?:https?:|www\.|@|\/)/i.test(word);
}

// ---------------------------------------------------------------- pictures

/** The largest photo side the helper reads; Telegram keeps several sizes of each photo. */
export const PHOTO_LONG_SIDE = 1600;
/** Image files (screenshots sent as documents) it reads, at most this big. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_DOC_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ImageRef = { fileId: string; size: number | null };
export type ImageType = "image/jpeg" | "image/png" | "image/webp";

const longSide = (p: TgPhotoSize) => Math.max(p.width, p.height);
const area = (p: TgPhotoSize) => p.width * p.height;

/** The largest size with its long side at most PHOTO_LONG_SIDE, else the smallest bigger one. */
export function pickPhoto(sizes: TgPhotoSize[]): TgPhotoSize | null {
  const fits = sizes.filter((p) => longSide(p) <= PHOTO_LONG_SIDE).sort((a, b) => area(b) - area(a));
  if (fits[0]) return fits[0];
  return [...sizes].sort((a, b) => area(a) - area(b))[0] ?? null;
}

/** The picture in a message: a photo, or a PNG, JPEG or WebP file up to MAX_IMAGE_BYTES. One per message. */
export function imageRef(msg: TgMessage | null | undefined): ImageRef | null {
  if (!msg) return null;
  if (msg.photo?.length) {
    const p = pickPhoto(msg.photo);
    return p ? { fileId: p.file_id, size: p.file_size ?? null } : null;
  }
  const d = msg.document;
  if (!d || !IMAGE_DOC_TYPES.has((d.mime_type ?? "").toLowerCase())) return null;
  if (typeof d.file_size === "number" && d.file_size > MAX_IMAGE_BYTES) return null;
  return { fileId: d.file_id, size: d.file_size ?? null };
}

/** The image type from the file's first bytes, so a renamed file is never sent as an image. */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Captions this short next to a screenshot in Help, Testers or Feedback still get a look. */
export const SHORT_CAPTION_WORDS = 5;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------- sentinels

const SENTINEL = /\[\[\s*(SKIP|SECRET)\s*\]\]/gi;

export type Sentinel = "skip" | "secret" | null;

/**
 * The model's two signals: [[SKIP]] (a picture that needs no reply) and
 * [[SECRET]] (a picture showing a seed phrase or private key). SECRET wins.
 * Both are taken out of the text either way.
 */
export function readSentinel(raw: string): { sentinel: Sentinel; text: string } {
  let skip = false;
  let secret = false;
  const text = raw
    .replace(SENTINEL, (_m, w: string) => {
      if (w.toUpperCase() === "SECRET") secret = true;
      else skip = true;
      return " ";
    })
    .replace(/[ \t]+/g, " ")
    .trim();
  return { sentinel: secret ? "secret" : skip ? "skip" : null, text };
}

// ---------------------------------------------------------------- replies

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
export const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HANDLE_RE = /(?<![\w@.])@([A-Za-z0-9_]{3,32})\b/g;
const MAINNET_LIVE =
  /\bmainnet\s+(?:is\s+|has\s+)?(?:now\s+|already\s+)?(?:live|launched|out|open)\b|\b(?:live|launched|available|running)\s+on\s+mainnet\b/gi;
const DATE_WORD = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|march|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|20\d\d|next (?:week|month|year))`;
const MAINNET_DATE = new RegExp(
  String.raw`\bmainnet\b[^.!?\n]{0,60}\b${DATE_WORD}\b|\b${DATE_WORD}\b[^.!?\n]{0,60}\bmainnet\b`,
  "i",
);
const DATE_WORDS = new RegExp(String.raw`\b${DATE_WORD}\b`, "gi");
/**
 * The mainnet launch days: 21 October 2026 (Robinhood Chain and Tempo, at 13:00 UTC or 14:00 WAT
 * when a time is given), 26 October (Base and Ethereum) and 9 November (Elysium).
 */
const LAUNCH_DAY =
  /\b(?:(?:21|26)(?:st|th)?\s+oct(?:ober)?|oct(?:ober)?\s+(?:21|26)(?:st|th)?|9(?:th)?\s+nov(?:ember)?|nov(?:ember)?\s+9(?:th)?)\b/i;
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(utc|gmt|wat)\b/gi;

/** A mainnet date that is one of the real launch days, and nothing else. */
function officialLaunch(s: string): boolean {
  if (!LAUNCH_DAY.test(s)) return false;
  // only the months of the launch days named here: "21 October, or maybe November" is a hedge
  const months = new Set([...s.matchAll(new RegExp(LAUNCH_DAY.source, "gi"))].map((m) => (/nov/i.test(m[0]) ? "nov" : "oct")));
  const monthOk = (w: string) =>
    w === "2026" || (/^oct(?:ober)?$/i.test(w) && months.has("oct")) || (/^nov(?:ember)?$/i.test(w) && months.has("nov"));
  if ([...s.matchAll(DATE_WORDS)].some((m) => !monthOk(m[0]))) return false;
  for (const m of s.matchAll(CLOCK)) {
    const ampm = m[3]?.toLowerCase();
    const h = ampm ? (Number(m[1]) % 12) + (ampm === "pm" ? 12 : 0) : Number(m[1]);
    const utc = m[4]!.toLowerCase() === "wat" ? h - 1 : h;
    if (utc !== 13 || (m[2] ?? "00") !== "00") return false;
  }
  return true;
}
const HUMAN_CLAIM =
  /\bi(?:'m| am)\s+(?:a\s+)?(?:real\s+)?(?:human|person|duke|an?\s+admin|a\s+mod(?:erator)?|a\s+team\s+member|(?:on|part\s+of)\s+the\s+(?:gloam\s+)?team)\b|\bi(?:'m| am)\s+not\s+a\s+bot\b/i;
const AS_AN_AI = /[^.!?\n]*\bas an ai\b[^.!?\n]*[.!?]?\s*/gi;
const MAX_REPLY = 900;
/** A 0x contract or wallet address (40 hex characters; a 64-character hash does not match). */
const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/;
const TOKEN_WORD = String.raw`(?:\b(?:tokens?|tge|presale|fdv|market\s*cap|valuation)\b|(?<![\w$])\$[A-Za-z]{2,10}\b)`;
const MONEY = String.raw`(?:\$\s?\d[\d,.]*|\d[\d,.]*\s?(?:usd|usdc|usdt|cents?)\b)`;
/** A token next to a price in the same sentence: "$GLOAM at $0.05", "FDV of $20m", "$0.10 per token". */
const TOKEN_PRICE = new RegExp(
  String.raw`${TOKEN_WORD}[^.!?\n]{0,80}?${MONEY}|${MONEY}[^.!?\n]{0,40}?\b(?:per\s+token|a\s+token|each\s+token|fdv|market\s*cap|valuation)\b`,
  "i",
);

export type ReplyPolicy = {
  /** Handles the reply may name, without "@": admins, the asker, the bot. */
  handles: string[];
  /** Longest reply in characters, cut at a full sentence. The group's default is 900. */
  maxChars?: number;
  /** A private chat with the team: also never a contract address or a token price, even in a draft. */
  team?: boolean;
  /** Values that must never appear in a reply: the deployment's own keys and tokens. */
  secrets?: string[];
  /** Mainnet is live, so "mainnet is live" is true and may go out. Left out: worked out from the clock and the pools. */
  mainnetLive?: boolean;
  /** What the asker wrote: a 0x address they posted may come back in a group reply. */
  askerText?: string;
};

/** A link the helper may share: the website, the group, the X account, $GLOAM's pages on Orynth, DEX Screener and CoinGecko. */
export function linkAllowed(link: string): boolean {
  const { host, path } = hostOf(link);
  if (host === "gloam.trade") return true;
  if (host === "x.com" || host === "twitter.com") return /^\/gloamtrade(?:[/?#]|$)/i.test(path);
  if (host === "orynth.dev") return /^\/projects\/gloam(?:[/?#]|$)/i.test(path);
  if (host === "dexscreener.com") return path.toLowerCase().startsWith(`/robinhood/${GLOAM_TOKEN.address.toLowerCase()}`);
  if (host === "coingecko.com") return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?coins\/gloam(?:[/?#]|$)/i.test(path);
  // RobinScan, Robinhood Chain mainnet's explorer: a transaction or an address
  if (host === "robin.etherscan.io") return path === "" || /^\/(?:tx|address|token)\/0x[0-9a-fA-F]+(?:[/?#]|$)/.test(path);
  return isGroupLink(host, path);
}

const ANY_EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g;
const ABOUT_TOKEN = /\$gloam\b|\btoken\b/i;
/** An address in a reply, written with or without its 0x (40 hex characters standing alone, never part of a hash). */
const REPLY_ADDRESS = /(?<![0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;
/** A wallet name ("gloambuyback.eth"): it points at an address just as one does. */
const WALLET_NAME = /(?<![\w.-])(?:[a-z0-9-]+\.)+eth(?![\w-])/gi;
/** "Send your USDG to 0x..." (or to a wallet name): the helper never tells anyone to send money to an address. */
const SEND_TO_ADDRESS =
  /\b(?:send|transfer|deposit|move|pay)\b[^.!?\n]*?\bto\s+(?:(?:this|that|the|my|our)\s+(?:address|wallet)\s*:?\s*)?(?:(?<![0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{40}(?![0-9a-zA-Z])|(?:[a-z0-9-]+\.)+eth\b)/i;

/** The addresses in a reply, as 0x and lower case, and its wallet names, lower case. */
function addressesIn(s: string): string[] {
  return (s.match(REPLY_ADDRESS) ?? []).map((a) => `0x${a.replace(/^0x/i, "").toLowerCase()}`);
}
function walletNamesIn(s: string): string[] {
  return (s.match(WALLET_NAME) ?? []).map((n) => n.toLowerCase());
}

/** $GLOAM's contract and Gloam's mainnet pools (and Base Sepolia's and Ethereum Sepolia's): the addresses the helper may name on its own. */
export function ownAddress(a: string): boolean {
  const l = a.toLowerCase();
  if (l === GLOAM_TOKEN.address.toLowerCase()) return true;
  if (baseSepoliaPool()?.pool.toLowerCase() === l) return true;
  if (ethereumSepoliaPool()?.pool.toLowerCase() === l) return true;
  if (ELYSIUM?.pool.toLowerCase() === l) return true;
  return ([4663, 4217, 8453, 1] as const).some((id) => mainnetPool(id)?.pool.toLowerCase() === l);
}

/**
 * An address that must not go out, with or without its 0x: the known copycat
 * token in any letter case (a RobinScan link to it too), "send ... to 0x...",
 * and any address other than $GLOAM's (team chats) or other than $GLOAM's, a
 * pool's or one the asker posted (the group), so a mistyped or fake contract
 * never goes out. A wallet name (.eth) is held to the same rule as an address.
 */
function wrongAddress(s: string, team: boolean, posted: Set<string>): boolean {
  const found = addressesIn(s);
  const names = walletNamesIn(s);
  if (found.some((a) => COPYCAT.has(a)) || SEND_TO_ADDRESS.test(s)) return true;
  if (team) return found.some((a) => a !== GLOAM_TOKEN.address.toLowerCase()) || names.length > 0;
  // an address or wallet name the asker posted may come back about their wallet, never in a line that calls it the token or a contract
  return (
    found.some((a) => !ownAddress(a) && (!posted.has(a) || TOKEN_TALK.test(s))) || names.some((n) => !posted.has(n) || TOKEN_TALK.test(s))
  );
}

/**
 * A line about $GLOAM, a token, a contract or which address is the real one.
 * An address the asker posted is never repeated in one: "is 0x... the new CA?"
 * is how a fake contract gets a yes.
 */
const TOKEN_TALK = /\$gloam\b|\b(?:ca|contracts?|tokens?|addy|official|legit|genuine|verified|real one|right one|correct one)\b/i;

/**
 * "Gloam is audited", "the contracts were fully audited": not true. Kann Audits
 * reviewed the vault contracts only; the routers, circuits, app and relay were
 * not part of it. "Kann Audits reviewed the vault contracts" and "the routers
 * are not audited" are fine.
 */
const AUDITED_CLAIM =
  /\b(?:is|are|was|were|been|got|fully|already|externally|independently|professionally)\s+(?:fully\s+|externally\s+|independently\s+|professionally\s+)?audited\b/gi;

/** One sentence breaks a rule that dropping it fixes: an off-list link, email or handle, a wrong address, a price, a mainnet claim or date, an "audited" claim, posing as a person. */
function brokenSentence(s: string, team: boolean, okHandles: Set<string>, mainnetLive = false, posted = new Set<string>()): boolean {
  if ((s.match(LINK_RE) ?? []).some((l) => !linkAllowed(l))) return true;
  if ((s.match(EMAIL_RE) ?? []).some((e) => e.toLowerCase() !== "hello@gloam.trade")) return true;
  for (const m of s.matchAll(HANDLE_RE)) if (!okHandles.has(m[1]!.toLowerCase())) return true;
  if (wrongAddress(s, team, posted)) return true;
  if (TOKEN_PRICE.test(s)) return true;
  for (const m of s.matchAll(AUDITED_CLAIM)) if (!negated(s, m.index ?? 0, m[0])) return true;
  // $GLOAM really is on Robinhood Chain mainnet; the app is the part that is not, until mainnet is live
  if (!mainnetLive && !ABOUT_TOKEN.test(s)) {
    for (const m of s.matchAll(MAINNET_LIVE)) if (!negated(s, m.index ?? 0, m[0])) return true;
  }
  if (MAINNET_DATE.test(s) && !officialLaunch(s)) return true;
  return HUMAN_CLAIM.test(s);
}

/**
 * The reply without the sentences that break a rule, so one bad line never
 * costs the whole answer. Sentences end at a full stop, "!" or "?" before a
 * space, or at a line break; "1." in a list is not an end.
 */
function dropBroken(text: string, bad: (s: string) => boolean): { text: string; kept: number; dropped: number } {
  const parts = text.split(/(\n+|(?<=\D[.!?]["')\]]?)[ \t]+)/);
  let out = "";
  let kept = 0;
  let dropped = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const s = parts[i] ?? "";
    const sep = parts[i + 1] ?? "";
    if (!s.trim()) {
      out += sep;
    } else if (bad(s)) {
      dropped++;
      if (sep.includes("\n")) out = out.trimEnd() + sep;
    } else {
      kept++;
      out += s + sep;
    }
  }
  return { text: out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), kept, dropped };
}

/** Cuts at the last full sentence that fits. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  return (end > max / 3 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "")).trim();
}

/** Strips formatting the group should not see: headings, bold, emoji, em dashes, "As an AI". */
export function tidyReply(raw: string): string {
  return norm(raw)
    .replace(SENTINEL, " ")
    .replace(AS_AN_AI, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[*\u2022]\s+/gm, "- ")
    .replace(/\s*[\u2014\u2015]\s*/g, ", ")
    .replace(/\u2013/g, "-")
    .replace(EMOJI, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The model's reply, made safe to post, or null. Anything shaped like a seed
 * phrase, key or deployment secret, or a payment code or claim link, sinks the
 * whole reply. A sentence with an off-list link, email or handle, an address
 * that is not $GLOAM's, a token price, a claim that the app is on mainnet
 * (until it is) or a date for it other than the announced one, a claim that
 * Gloam is audited, or claiming to be a person is dropped, and the rest goes out. A group reply that lost most
 * of its sentences is not sent at all.
 */
export function cleanReply(raw: string, policy: ReplyPolicy): string | null {
  const text = clip(tidyReply(raw), policy.maxChars ?? MAX_REPLY);
  if (!text) return null;
  if (policy.secrets?.some((v) => v.length >= 8 && raw.includes(v))) return null;
  if (secretLeak(text)) return null;
  // a code or claim link read off a screenshot is never repeated; an address is fine
  if ([...scanCodes(text).kinds].some((k) => k !== "address" && k !== "request_link")) return null;
  const okHandles = new Set(["gloamtrade", "gloamhq", ...policy.handles.map((h) => h.toLowerCase())]);
  const live = policy.mainnetLive ?? isMainnetLive();
  const asked = policy.askerText ?? "";
  const posted = new Set([...addressesIn(asked), ...walletNamesIn(asked)]);
  const r = dropBroken(text, (s) => brokenSentence(s, Boolean(policy.team), okHandles, live, posted));
  if (!r.kept) return null;
  if (!policy.team && r.dropped * 2 > r.kept + r.dropped) return null;
  return r.text;
}

// ---------------------------------------------------------------- $GLOAM

/**
 * Every 0x contract or wallet address in chat text, marked for the model as
 * $GLOAM's real contract or not, so it never compares 42 characters by eye.
 */
export function markAddresses(text: string): string {
  return text.replace(ANY_EVM_ADDRESS, (a) =>
    a.toLowerCase() === GLOAM_TOKEN.address.toLowerCase()
      ? `${a} [the official $GLOAM contract]`
      : COPYCAT.has(a.toLowerCase())
        ? `${a} [the known copycat GLOAM token, a fake flagged as a honeypot, not Gloam's]`
        : `${a} [not the $GLOAM contract]`,
  );
}
const COPYCAT = new Set(COPYCAT_GLOAM.map((a) => a.toLowerCase()));

const CA_WORD = String.raw`(?:ca|c\.a\.?|contract(?:\s+(?:address|addy))?|token\s+(?:address|addy|contract)|addy)`;
const CA_ONLY = new RegExp(
  String.raw`^(?:(?:pls|please|yo|hey|hi|gm|ser|sir|bro|fam|admin|team|so|and|ok|okay|wen|drop|send|share|post|give(?:\s+(?:me|us))?|need|any|what'?s|whats|what\s+is|where'?s|wheres|where\s+is|the|ur|your|our|token|gloam|\$gloam|its)[\s,:]+)*${CA_WORD}(?:[\s,]+(?:pls|please|ser|sir|bro|fam|admin|again|here|(?:of|for)\s+(?:the\s+)?(?:token|\$?gloam)))*[\s?!.]*$`,
  "i",
);
const CA_ASKED =
  /\b(?:what(?:'s|\s+is)|whats|where(?:'s|\s+is)|drop|share|send|post|give\s+(?:me|us))\s+(?:the\s+|ur\s+|your\s+|our\s+|its\s+)?(?:\$?gloam\s+|token\s+)?(?:ca\b|contract\b(?!\s+(?:audit|code|source|logic|function|call|work|risk))|(?:token|contract)\s+address\b)/i;
const BUY_ASKED =
  /\b(?:where|how)\s+(?:can|do|should|to)\s+(?:i\s+|we\s+|one\s+)?(?:buy|purchase|ape(?:\s+into)?|get)\s+(?:some\s+)?(?:\$gloam|gloam\s+tokens?|the\s+gloam\s+token)\b|\b(?:where|how)\s+(?:can|do|should|to)\s+(?:i\s+|we\s+)?(?:buy|purchase|ape)\b[^.!?\n]{0,20}\b(?:\$?gloam|the\s+token)\b/i;

/** "CA?", "wen contract", "what's the CA", "where can I buy $GLOAM": asking for the token's address. A message that already has one is not asking. */
export function asksTokenAddress(raw: string): boolean {
  const t = norm(raw).replace(/(?<![\w@])@\w+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || wordCount(t) > 25 || EVM_ADDRESS.test(t)) return false;
  return CA_ONLY.test(t) || CA_ASKED.test(t) || BUY_ASKED.test(t);
}

/** The official answer to "CA?": the address, the facts that matter, and where the rest lives. */
export function tokenCard(): string {
  return [
    `$GLOAM on Robinhood Chain mainnet:\n${GLOAM_TOKEN.address}`,
    "Fixed supply of 500,000. Launch liquidity locked for good. No presale and no team allocation.",
    `Uses, tokenomics and roadmap: ${GLOAM_TOKEN.page}\nGet it on Orynth: ${GLOAM_TOKEN.orynth}\nChart: ${GLOAM_TOKEN.chart}`,
    "That address is the only real one. A copycat token also called GLOAM trades on Robinhood Chain too, so on Uniswap paste this address instead of searching the name. Not financial advice.",
  ].join("\n\n");
}

/** The same ask again soon after the card went up in that topic: the address, without the whole card. */
export function tokenPointer(name: string): string {
  return `Same one as just above, ${name}: ${GLOAM_TOKEN.address}. The rest is at ${GLOAM_TOKEN.page}.`;
}

// ---------------------------------------------------------------- names and welcomes

const NAME_LURE = /\b(?:admin|support|airdrop|giveaway|claim|official|helpdesk|moderator)\b/i;

/** A display name safe to repeat: no links, handles or control characters, and never "Support" or "Admin". */
export function cleanName(raw: string | undefined, fallback = "friend"): string {
  const name = norm(raw ?? "")
    // "duke.sol | Gloam": keep the person's part, and a wallet name (.sol, .eth) is a name, not a link
    .split(/\s+[|/\u00b7\u2022]\s+/)[0]!
    .replace(/\b([\p{L}\p{N}_-]+)\.(?:sol|eth|base|ton|bnb|arb|sui|apt|lens)\b/giu, "$1")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    // emoji, skin tones, flags and their joiners: the helper writes names plain
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{20E3}]/gu, "")
    .replace(LINK_RE, "")
    .replace(/@\w+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32)
    .trim();
  return name && !NAME_LURE.test(name) ? name : fallback;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type Joiner = { id: number; first: string; username?: string };

/** How many new members a welcome tags by name. */
export const WELCOME_TAGS = 30;
/**
 * Room for the tags, as HTML. Telegram caps a message at 4096 characters; 30
 * escaped mention links can run past that, so anyone who does not fit is
 * counted in "and N others" instead.
 */
const WELCOME_TAG_CHARS = 3_500;

/**
 * One welcome for a batch of new members, as Telegram HTML. People with a
 * username are tagged as @username; the rest get a mention link to their
 * account, so the tag works without a username.
 */
export function welcomeHtml(joiners: Joiner[], testingOpen: boolean): string {
  const tags: string[] = [];
  let used = 0;
  for (const j of joiners.slice(0, WELCOME_TAGS)) {
    const tag =
      j.username && /^[A-Za-z0-9_]{5,32}$/.test(j.username)
        ? `@${j.username}`
        : `<a href="tg://user?id=${Math.trunc(j.id)}">${escapeHtml(cleanName(j.first))}</a>`;
    if (used + tag.length + 2 > WELCOME_TAG_CHARS) break;
    tags.push(tag);
    used += tag.length + 2;
  }
  const others = joiners.length - tags.length;
  if (others > 0) tags.push(`${others} ${others === 1 ? "other" : "others"}`);
  const list = tags.length > 1 ? `${tags.slice(0, -1).join(", ")} and ${tags[tags.length - 1]}` : (tags[0] ?? "friends");
  const testing = testingOpen ? " Testers, your guide is pinned in the Testers topic." : "";
  // A warm hello and where to start, naming every mainnet with a vault in. No admin handles: they would ping the admins on every welcome, and the group shows who they are.
  return (
    `Welcome to Gloam, ${list}. Glad you're here.\n\n` +
    `Send and receive money privately on ${liveMainnetNames()} at gloam.trade/app. Questions go in Help.${testing}\n\n` +
    `Never share your keys with anyone.`
  );
}

// ---------------------------------------------------------------- memory

/** One line of a thread's recent history, as kept in the store. */
export type ChatLine = { n: string; t: string; b?: 1; /** when, in seconds (lines saved before this field have none) */ a?: number };

/** How long after the helper answers someone their next message counts as a follow-up to it. */
export const FOLLOW_UP_SEC = 15 * 60;

/**
 * The person is continuing a conversation with the helper: the last line in
 * the topic is the helper's, recent, and the line before it was theirs.
 */
export function isFollowUp(history: ChatLine[], name: string, nowSec: number): boolean {
  const last = history[history.length - 1];
  const before = history[history.length - 2];
  if (!last?.b || !before || before.b || before.n !== name) return false;
  return typeof last.a === "number" && nowSec - last.a <= FOLLOW_UP_SEC;
}

/**
 * Text fit to keep in a private chat's memory with the team, or null for
 * anything shaped like a seed phrase or key. Codes are kept as labels. Unlike
 * the group's memory it keeps line breaks (drafts) and scam-shaped text (an
 * admin asking how to answer a scammer).
 */
export function teamMemoryText(raw: string, max: number): string | null {
  const text = scanCodes(raw).masked;
  if (secretLeak(text)) return null;
  const t = text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Text fit to keep in thread memory, or null for anything that looks like a
 * secret or a scam. Codes and links are kept as their labels, never in full.
 */
export function memoryText(raw: string): string | null {
  const text = scanCodes(raw).masked;
  if (secretLeak(text) || scamReason(text)) return null;
  const t = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 400) : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- wrong network

/**
 * Chains people's wallets end up on, by id. Gloam is on the two testnets, and
 * each mainnet once its pool is in (Base, Base Sepolia, Ethereum and Ethereum
 * Sepolia too, once theirs are).
 */
const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum mainnet",
  4663: "Robinhood Chain mainnet",
  46630: "Robinhood Chain testnet",
  42431: "Tempo testnet",
  4217: "Tempo mainnet",
  8453: "Base mainnet",
  84532: "Base Sepolia testnet",
  11155111: "Ethereum Sepolia testnet",
  // Elysium, only while it is on (lib/elysium.ts)
  ...(ELYSIUM ? { [ELYSIUM.chainId]: "Elysium mainnet" } : {}),
  ...(ELYSIUM_TESTNET ? { [ELYSIUM_TESTNET.chainId]: "Elysium testnet" } : {}),
};

/** Hand-add details for a chain the app can ask for. */
const CHAIN_DETAILS: Record<number, string> = {
  42431: "RPC https://rpc.moderato.tempo.xyz, chain ID 42431, currency USD.",
  46630: "RPC https://rpc.testnet.chain.robinhood.com, chain ID 46630, currency ETH.",
  4663: "RPC https://rpc.mainnet.chain.robinhood.com, chain ID 4663, currency ETH.",
  4217: "RPC https://rpc.tempo.xyz, chain ID 4217, currency USD.",
  8453: "RPC https://mainnet.base.org, chain ID 8453, currency ETH.",
  84532: "RPC https://sepolia.base.org, chain ID 84532, currency ETH.",
  1: "RPC https://ethereum-rpc.publicnode.com, chain ID 1, currency ETH.",
  11155111: "RPC https://ethereum-sepolia-rpc.publicnode.com, chain ID 11155111, currency ETH.",
  ...(ELYSIUM ? { [ELYSIUM.chainId]: `RPC ${ELYSIUM_RPC_DISPLAY}, chain ID ${ELYSIUM.chainId}, currency HYPE.` } : {}),
  ...(ELYSIUM_TESTNET ? { [ELYSIUM_TESTNET.chainId]: `RPC ${ELYSIUM_TESTNET.rpcUrl}, chain ID ${ELYSIUM_TESTNET.chainId}, currency HYPE.` } : {}),
};

/** The fix once mainnet is live: the wallet and the app can each be on a mainnet or a testnet. */
function liveChainFix(name: string, m: ChainMismatch): string {
  const mainnets = new Set<number>([...([4663, 4217, 8453, 1] as const).filter((id) => mainnetPool(id)), ...(ELYSIUM ? [ELYSIUM.chainId] : [])]);
  const want = `${chainLabel(m.want)} (${m.want})`;
  const tempo = m.want === 42431 || m.want === 4217;
  const base = m.want === 84532 || m.want === 8453;
  const ethereum = m.want === 11155111 || m.want === 1;
  const elysium = (ELYSIUM !== null && m.want === ELYSIUM.chainId) || (ELYSIUM_TESTNET !== null && m.want === ELYSIUM_TESTNET.chainId);
  const button = tempo ? "Switch to Tempo" : base ? "Switch to Base" : ethereum ? "Switch to Ethereum" : elysium ? "Switch to Elysium" : "Switch to Robinhood Chain";
  const twin: Record<number, number> = {
    46630: 4663,
    4663: 46630,
    42431: 4217,
    4217: 42431,
    84532: 8453,
    8453: 84532,
    11155111: 1,
    1: 11155111,
    // Elysium, when both sides are on
    ...(ELYSIUM && ELYSIUM_TESTNET ? { [ELYSIUM.chainId]: ELYSIUM_TESTNET.chainId, [ELYSIUM_TESTNET.chainId]: ELYSIUM.chainId } : {}),
  };
  const tap = `tap "${button}" on the wallet button at the top of the app (or Settings > Network > Add to wallet), approve it in your wallet, then try again.`;
  // the wallet sits on the other side (mainnet or testnet) of the chain the app is set to
  const otherSide = twin[m.want] === m.wallet && (mainnets.has(m.wallet) || mainnets.has(m.want));
  const walletIsMain = mainnets.has(m.wallet);
  const why = otherSide
    ? `Your wallet is on ${chainLabel(m.wallet)} (${m.wallet}) and the app is set to ${want}. ` +
      (walletIsMain
        ? `For mainnet, pick ${chainLabel(m.wallet)} in the app's network selector. To stay on the testnet, ${tap}`
        : `For the testnet, pick ${chainLabel(m.wallet)} in the app's network selector. For mainnet, ${tap}`)
    : `Your wallet is on ${chainLabel(m.wallet)} and the app is on ${want}, so the wallet refuses the transaction. ${tap[0]!.toUpperCase()}${tap.slice(1)}`;
  const details = CHAIN_DETAILS[m.want];
  return `Easy one, ${name}. ${why}` + (details ? ` If your wallet won't switch, add the network by hand: ${details}` : "");
}

/** The wallet's network and the one the app wanted, from a pasted wrong-network error. */
export type ChainMismatch = { wallet: number; want: number };

/**
 * Reads viem's "The current chain of the wallet (id: 4663) does not match the
 * target chain for the transaction (id: 46630 ...)" and the "Current Chain ID /
 * Expected Chain ID" lines some wallets show. Null for anything else.
 */
export function chainMismatch(text: string): ChainMismatch | null {
  const t = text.replace(/\s+/g, " ");
  // Up to 9 digits: Ethereum Sepolia is 11155111.
  const viem = /current chain of the (?:wallet|connector) \(id: ?(\d{1,9})\) does not match the (?:target chain for the transaction|connection's chain) \(id: ?(\d{1,9})/i.exec(t);
  const lines = /current chain id:? ?(\d{1,9}).{0,40}?expected chain id:? ?(\d{1,9})/i.exec(t);
  const m = viem ?? lines;
  if (!m) return null;
  const wallet = Number(m[1]);
  const want = Number(m[2]);
  return wallet !== want ? { wallet, want } : null;
}

const chainLabel = (id: number) => CHAIN_NAMES[id] ?? `chain ${id}`;

/** The fix for a wrong-network error, in the helper's voice. Before mainnet is live, exactly as it always was. */
export function chainFix(name: string, m: ChainMismatch, mainnetLive: boolean = isMainnetLive()): string {
  if (mainnetLive) return liveChainFix(name, m);
  const want = m.want === 42431 ? "Tempo testnet (42431)" : m.want === 46630 ? "Robinhood Chain testnet (46630)" : chainLabel(m.want);
  const button = m.want === 42431 ? "Switch to Tempo" : "Switch to Robinhood Chain";
  const why =
    m.wallet === 4663
      ? "Your wallet is on Robinhood Chain mainnet (4663). Gloam runs on the testnet, so the wallet has to be on " + want + "."
      : `Your wallet is on ${chainLabel(m.wallet)} and the app is on ${want}, so the wallet refuses the transaction.`;
  return (
    `Easy one, ${name}. ${why} Tap "${button}" on the wallet button at the top of the app (or Settings > Network > Add to wallet), ` +
    `approve it in your wallet, then try again. If your wallet won't switch, add the testnet by hand: ` +
    (m.want === 42431
      ? "RPC https://rpc.moderato.tempo.xyz, chain ID 42431, currency USD."
      : "RPC https://rpc.testnet.chain.robinhood.com, chain ID 46630, currency ETH.")
  );
}

// ---------------------------------------------------------------- links to group messages

/** Message ids from links to the group's messages: t.me/gloamhq/209, t.me/gloamhq/5/350, t.me/c/123/5/350. At most 3. */
export function groupMessageIds(text: string, username = "gloamhq"): number[] {
  const re = new RegExp(String.raw`t\.me\/(?:${escapeRe(username)}|c\/\d+)\/(?:\d+\/)?(\d+)(?![\d/])`, "gi");
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const id = Number(m[1]);
    if (Number.isSafeInteger(id) && id > 0 && !out.includes(id)) out.push(id);
    if (out.length === 3) break;
  }
  return out;
}

/** "go answer it", "please reply to this", "answer this one": a team member asking the helper to answer a linked message. */
export function wantsGroupAnswer(text: string): boolean {
  return (
    /\b(?:go|pls|please|can you|could you|kindly|now)\s+(?:and\s+)?(?:answer|reply|respond)\b/i.test(text) ||
    /^\s*(?:\/answer\b|(?:answer|reply|respond)(?:\s+to)?(?:\s+(?:it|this|that|him|her|them|this one|that one))?\s*[.!:]?\s*(?:$|https?:|t\.me))/im.test(text)
  );
}
