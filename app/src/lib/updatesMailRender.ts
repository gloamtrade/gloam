/**
 * Gloam email updates: the text an admin writes, turned into an email.
 * No server code here, so the admin's live preview draws the same email the
 * list gets, and the public /updates pages read the same blocks.
 *
 * The body is a small piece of markdown: # headings (three levels),
 * paragraphs (a single newline is a line break), - or 1. lists, **bold**,
 * *italic*, [links](https://...) and bare https:// links. A paragraph that is
 * only one [link](https://...) becomes a button. Nothing else is markup: every character the admin types is escaped, so no HTML gets in.
 * A link is kept only when it is https, http or mailto (a path like /docs
 * points at the site); anything else stays as plain text.
 */

export const SITE = "https://www.gloam.trade";

export const SUBJECT_MAX = 150;
export const BODY_MAX = 20_000;

/**
 * Stands in for each person's unsubscribe link in the stored email. Only
 * letters, % and _, so escaping leaves it alone, and a body may not carry it.
 */
export const UNSUBSCRIBE_MARK = "%%GLOAM_UNSUBSCRIBE_URL%%";

/** The header art, light and dark (source: scripts/brand/email-header.html). */
export const HEADER_URL = `${SITE}/brand/kit/email/gloam-email-header.png`;
export const HEADER_DARK_URL = `${SITE}/brand/kit/email/gloam-email-header-dark.png`;

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "paragraph"; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "button"; href: string; label: string };

// ------------------------------------------------------------------ escaping

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The address a link may go to, or null. https, http and mailto only; a path
 * starting with one slash points at the site. No spaces, no control characters,
 * no user:password@ part (a link that reads as one host and opens another).
 */
export function safeHref(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 2000 || /[\s\u0000-\u001f\u007f<>"'`\\]/.test(s)) return null;
  if (s.startsWith("/") && !s.startsWith("//")) {
    try {
      return new URL(s, SITE).href;
    } catch {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(url.href) ? url.href : null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || !url.hostname.includes(".")) return null;
  return url.href;
}

// ------------------------------------------------------------------ parsing

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!>|~".split(""));
const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** The closing delimiter for emphasis opened at `from`, or -1. */
function closing(s: string, from: number, delim: string): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s.startsWith(delim, i)) {
      const before = s[i - 1];
      const after = s[i + delim.length];
      const okSides = i > from && before !== " " && (delim[0] !== "_" || !isWord(after));
      // a single * or _ that is really half of a double one is not this close
      const partOfDouble = delim.length === 1 && (s[i + 1] === delim || s[i - 1] === delim);
      if (okSides && !partOfDouble) return i;
    }
    i++;
  }
  return -1;
}

/** Inline markup in one line or paragraph. `inLink` keeps links out of a link's own text. */
export function parseInline(s: string, inLink = false): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    pushText(out, text);
    text = "";
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.has(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    // **bold** or __bold__
    if ((ch === "*" || ch === "_") && s[i + 1] === ch && s[i + 2] && s[i + 2] !== " " && (ch === "*" || !isWord(s[i - 1]))) {
      const end = closing(s, i + 2, ch + ch);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(s.slice(i + 2, end), inLink) });
        i = end + 2;
        continue;
      }
    }
    // *italic* or _italic_
    if ((ch === "*" || ch === "_") && s[i + 1] !== ch && s[i + 1] && s[i + 1] !== " " && (ch === "*" || !isWord(s[i - 1]))) {
      const end = closing(s, i + 1, ch);
      if (end > i + 1) {
        flush();
        out.push({ t: "em", c: parseInline(s.slice(i + 1, end), inLink) });
        i = end + 1;
        continue;
      }
    }
    // [text](address)
    if (ch === "[" && !inLink) {
      const close = s.indexOf("](", i + 1);
      // the address runs to its closing ), counting any ( ) inside it
      let end = -1;
      for (let j = close + 2, depth = 0; close > i && j < s.length && s[j] !== "\n"; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && depth-- === 0) {
          end = j;
          break;
        }
      }
      const label = close > i ? s.slice(i + 1, close) : "";
      if (close > i + 1 && end > close + 2 && !label.includes("\n") && !label.includes("[")) {
        const href = safeHref(s.slice(close + 2, end));
        flush();
        const c = parseInline(label, true);
        if (href) out.push({ t: "link", href, c });
        else {
          for (const node of c) {
            if (node.t === "text") pushText(out, node.v);
            else out.push(node);
          }
        }
        i = end + 1;
        continue;
      }
    }
    // a bare https:// or http:// address
    if (!inLink && (s.startsWith("https://", i) || s.startsWith("http://", i)) && !isWord(s[i - 1]) && s[i - 1] !== "/") {
      let end = i;
      while (end < s.length && !/[\s<>"'`]/.test(s[end]!)) end++;
      // trailing punctuation belongs to the sentence, and a ) only to an open (
      while (end > i) {
        const last = s[end - 1]!;
        if (/[.,;:!?*_]/.test(last)) end--;
        else if (last === ")" && (s.slice(i, end).match(/\(/g)?.length ?? 0) < (s.slice(i, end).match(/\)/g)?.length ?? 0)) end--;
        else break;
      }
      const raw = s.slice(i, end);
      const href = safeHref(raw);
      if (href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: raw }] });
        i = end;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

const HEADING = /^(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^[ \t]{0,3}[-*+][ \t]+(.*)$/;
const NUMBERED = /^[ \t]{0,3}(\d{1,6})[.)][ \t]+(.*)$/;
/** A paragraph that is one [label](address) and nothing else: a button. */
const BUTTON_LINE = /^\[[^\]\n]+\]\(\S+\)$/;

type OpenList = { ordered: boolean; start: number; items: string[] };

/** The body's blocks: headings, paragraphs and lists, in order. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list = null as OpenList | null;

  const endPara = () => {
    if (para.length === 1 && BUTTON_LINE.test(para[0]!)) {
      const c = parseInline(para[0]!);
      const only = c.length === 1 ? c[0]! : null;
      const label = only && only.t === "link" ? inlineText(only.c).trim() : "";
      if (only && only.t === "link" && label) {
        blocks.push({ t: "button", href: only.href, label });
        para = [];
        return;
      }
    }
    if (para.length) blocks.push({ t: "paragraph", c: parseInline(para.join("\n")) });
    para = [];
  };
  const endList = () => {
    if (list) blocks.push({ t: "list", ordered: list.ordered, start: list.start, items: list.items.map((x) => parseInline(x)) });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, "");
    if (!line.trim()) {
      endPara();
      endList();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      endPara();
      endList();
      blocks.push({ t: "heading", level: h[1]!.length as 1 | 2 | 3, c: parseInline(h[2]!) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      endPara();
      const ordered = n !== null;
      if (list && list.ordered !== ordered) endList();
      const open: OpenList = list ?? { ordered, start: n ? Number(n[1]) : 1, items: [] };
      list = open;
      open.items.push((b ? b[1]! : n![2]!).trim());
      continue;
    }
    if (list) {
      // a line under a list item carries on that item
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  endList();
  return blocks;
}

// ------------------------------------------------------------------ plain text

function inlineText(nodes: Inline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "br") out += "\n";
    else if (n.t === "link") {
      const label = inlineText(n.c);
      const shown = n.href.startsWith("mailto:") ? n.href.slice(7) : n.href;
      out += label === n.href || label === shown || `${label}/` === n.href ? shown : `${label} (${shown})`;
    } else out += inlineText(n.c);
  }
  return out;
}

/** The body as plain text, for the text part of the email. */
export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.t === "heading") return inlineText(b.c);
      if (b.t === "paragraph") return inlineText(b.c);
      if (b.t === "button") return `${b.label}: ${b.href.startsWith("mailto:") ? b.href.slice(7) : b.href}`;
      return b.items.map((it, i) => `${b.ordered ? `${b.start + i}.` : "-"} ${inlineText(it).replace(/\n/g, "\n   ")}`).join("\n");
    })
    .join("\n\n");
}

/** A short line from the start of the body: the inbox preview and the page description. */
export function summaryOf(blocks: Block[], max = 160): string {
  const first = blocks.find((b) => b.t === "paragraph") ?? blocks[0];
  if (!first) return "";
  const raw = first.t === "list" ? first.items.map(inlineText).join(", ") : first.t === "button" ? first.label : inlineText(first.c);
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20))}…`;
}

// ------------------------------------------------------------------ email HTML

const FONT = "Aeonik,-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";
const INK = "#0B0C0E";
const SOFT = "#34373C";
const MUTE = "#5F636A";
const LINE = "#E4E6E9";
const GREEN = "#2E7D53";
/** Around the card, and the card itself: the app's ground and panel. */
const GROUND = "#F4F4F5";
const CARD = "#FFFFFF";

function inlineHtml(nodes: Inline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += escapeHtml(n.v);
    else if (n.t === "br") out += "<br>";
    else if (n.t === "strong") out += `<strong class="gl-ink" style="font-weight:600;color:${INK};">${inlineHtml(n.c)}</strong>`;
    else if (n.t === "em") out += `<em style="font-style:italic;">${inlineHtml(n.c)}</em>`;
    else out += `<a href="${escapeHtml(n.href)}" class="gl-link" style="color:${INK};text-decoration:underline;text-underline-offset:3px;">${inlineHtml(n.c)}</a>`;
  }
  return out;
}

const H_STYLE: Record<1 | 2 | 3, string> = {
  1: `margin:32px 0 12px;font-size:22px;line-height:30px;font-weight:500;letter-spacing:-0.01em;color:${INK};`,
  2: `margin:28px 0 10px;font-size:18px;line-height:26px;font-weight:500;color:${INK};`,
  3: `margin:24px 0 8px;font-size:16px;line-height:24px;font-weight:600;color:${INK};`,
};

/** The body's blocks as email HTML: inline styles, tags every mail app knows. */
export function blocksToEmailHtml(blocks: Block[]): string {
  const p = `margin:0 0 16px;font-size:16px;line-height:26px;color:${SOFT};`;
  return blocks
    .map((b) => {
      if (b.t === "heading") {
        const tag = `h${b.level + 1}`;
        return `<${tag} class="gl-ink" style="${H_STYLE[b.level]}font-family:${FONT};">${inlineHtml(b.c)}</${tag}>`;
      }
      if (b.t === "paragraph") return `<p class="gl-soft" style="${p}font-family:${FONT};">${inlineHtml(b.c)}</p>`;
      if (b.t === "button") {
        // a "bulletproof" button: a filled cell with the link inside, so it
        // stays a button where a mail app drops padding or rounded corners on links
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td class="gl-btn" bgcolor="${INK}" style="border-radius:999px;background:${INK};"><a href="${escapeHtml(b.href)}" class="gl-btn-a" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:500;letter-spacing:-0.005em;color:#FFFFFF;text-decoration:none;border-radius:999px;">${escapeHtml(b.label)}</a></td></tr></table>`;
      }
      const tag = b.ordered ? "ol" : "ul";
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
      const items = b.items
        .map((it) => `<li class="gl-soft" style="margin:0 0 8px;font-size:16px;line-height:26px;color:${SOFT};font-family:${FONT};">${inlineHtml(it)}</li>`)
        .join("");
      return `<${tag}${start} style="margin:0 0 16px;padding:0 0 0 22px;">${items}</${tag}>`;
    })
    .join("\n");
}

export function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export type EmailInput = {
  subject: string;
  body: string;
  /** The UTC day it goes out, YYYY-MM-DD. */
  day: string;
  /** Where the update lives on the site. */
  webUrl: string;
  /** This person's unsubscribe page, or UNSUBSCRIBE_MARK to fill in per person. */
  unsubscribeUrl: string;
};

/** Checks a subject and body before anything is stored or sent. Null when fine. */
export function checkUpdate(subject: unknown, body: unknown): string | null {
  if (typeof subject !== "string" || !subject.trim()) return "Add a subject.";
  if (typeof body !== "string" || !body.trim()) return "Write the update first.";
  if (subject.trim().length > SUBJECT_MAX) return `Keep the subject under ${SUBJECT_MAX} characters.`;
  if (/[\r\n\u0000-\u001f\u007f]/.test(subject)) return "The subject has to be one line.";
  if (body.length > BODY_MAX) return `Keep the update under ${BODY_MAX.toLocaleString("en-US")} characters.`;
  if (subject.includes("%%GLOAM_") || body.includes("%%GLOAM_")) return "That text can't be in an update.";
  if (parseMarkdown(body).length === 0) return "Write the update first.";
  return null;
}

/**
 * The whole email, HTML and plain text, in Gloam's look: a white card on the
 * app's grey ground, the header art on top (the lockup under the green glow; a
 * hosted PNG, since Gmail and Outlook show no SVG), a green label with the day,
 * the subject large in Aeonik Light, the body, then the footer under the card:
 * why they get it, their own unsubscribe link and the web version.
 * Aeonik loads from the site where a mail app allows web fonts (Apple Mail,
 * iOS); elsewhere it falls back to the system sans. Mail apps with a dark mode
 * that honour prefers-color-scheme (Apple Mail, Outlook.com) get the app's
 * dark colours and the dark header.
 */
export function renderUpdateEmail(input: EmailInput): { html: string; text: string } {
  const subject = input.subject.trim();
  const blocks = parseMarkdown(input.body);
  const preheader = summaryOf(blocks, 140);
  const unsub = input.unsubscribeUrl === UNSUBSCRIBE_MARK ? UNSUBSCRIBE_MARK : escapeHtml(input.unsubscribeUrl);
  const web = escapeHtml(input.webUrl);
  const day = escapeHtml(fmtDay(input.day));
  const small = `margin:0;font-size:13px;line-height:20px;color:${MUTE};font-family:${FONT};`;
  const footLink = `color:${MUTE};text-decoration:underline;text-underline-offset:2px;`;
  const headerImg = (src: string) =>
    `<img src="${src}" width="600" alt="Gloam" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;">`;
  const fontFace = (weight: number, file: string) =>
    `@font-face{font-family:Aeonik;font-style:normal;font-weight:${weight};src:url(${SITE}/fonts/${file}.woff2) format("woff2");}`;

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>
${fontFace(300, "Aeonik-Light")}
${fontFace(400, "Aeonik-Regular")}
${fontFace(500, "Aeonik-Medium")}
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body{margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table{border-collapse:collapse;}
img{border:0;outline:none;text-decoration:none;}
@media (max-width:620px){.gl-pad{padding-left:24px!important;padding-right:24px!important;}.gl-title{font-size:28px!important;line-height:34px!important;}.gl-outer{padding:12px 8px 32px!important;}}
@media (prefers-color-scheme:dark){
.gl-ground{background:#08090A!important;}
.gl-card{background:#111214!important;}
.gl-ink,.gl-link{color:#F4F5F6!important;}
.gl-soft{color:#CDD0D4!important;}
.gl-mute,.gl-mute a{color:#9B9FA6!important;}
.gl-green{color:#8FD3AD!important;}
.gl-rule{border-color:#232529!important;}
.gl-btn{background:#F4F5F6!important;}
.gl-btn-a{color:#0B0C0E!important;}
.gl-light-img{display:none!important;max-height:0!important;}
.gl-dark-img{display:block!important;max-height:none!important;overflow:visible!important;}
}
[data-ogsc] .gl-ink,[data-ogsc] .gl-link{color:#F4F5F6!important;}
[data-ogsc] .gl-soft{color:#CDD0D4!important;}
[data-ogsc] .gl-mute,[data-ogsc] .gl-mute a{color:#9B9FA6!important;}
[data-ogsc] .gl-green{color:#8FD3AD!important;}
[data-ogsc] .gl-btn-a{color:#0B0C0E!important;}
[data-ogsb] .gl-btn{background:#F4F5F6!important;}
</style>
<!--[if mso]><style>body,table,td,p,a,li,h1,h2,h3,h4{font-family:Arial,sans-serif!important;}</style><![endif]-->
</head>
<body class="gl-ground" style="margin:0;padding:0;background:${GROUND};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="gl-ground" bgcolor="${GROUND}" style="background:${GROUND};">
<tr><td align="center" class="gl-outer" style="padding:32px 12px 40px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="gl-card" bgcolor="${CARD}" style="max-width:600px;background:${CARD};border-radius:24px;">
<tr><td style="padding:0;font-size:0;line-height:0;">
<a href="${SITE}" style="display:block;text-decoration:none;"><span class="gl-light-img" style="display:block;">${headerImg(HEADER_URL)}</span><!--[if !mso]><!--><span class="gl-dark-img" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${headerImg(HEADER_DARK_URL)}</span><!--<![endif]--></a>
</td></tr>
<tr><td class="gl-pad" style="padding:4px 40px 16px;">
<p class="gl-green" style="margin:0 0 12px;font-size:13px;line-height:20px;font-weight:500;color:${GREEN};font-family:${FONT};">Gloam update, ${day}</p>
<h1 class="gl-ink gl-title" style="margin:0 0 24px;font-size:34px;line-height:40px;font-weight:300;letter-spacing:-0.025em;color:${INK};font-family:${FONT};">${escapeHtml(subject)}</h1>
${blocksToEmailHtml(blocks)}
</td></tr>
<tr><td class="gl-pad" style="padding:8px 40px 36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="gl-rule" style="border-top:1px solid ${LINE};padding-top:20px;">
<p class="gl-ink" style="margin:0;font-size:15px;line-height:22px;font-weight:500;color:${INK};font-family:${FONT};">Gloam</p>
<p class="gl-mute" style="${small}">Private money on public chains.</p>
</td></tr></table>
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td class="gl-pad" align="center" style="padding:24px 40px 0;">
<p class="gl-mute" style="${small}">You get Gloam updates because you signed up on gloam.trade or entered a Gloam contest.</p>
<p class="gl-mute" style="${small}padding-top:6px;"><a href="${unsub}" style="${footLink}">Unsubscribe</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;<a href="${web}" style="${footLink}">View on the web</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;<a href="${SITE}" style="${footLink}">gloam.trade</a></p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;

  const text = [
    subject,
    "",
    blocksToText(blocks),
    "",
    "--",
    "You get Gloam updates because you signed up on gloam.trade or entered a Gloam contest.",
    `Unsubscribe: ${input.unsubscribeUrl}`,
    `View on the web: ${input.webUrl}`,
    "Gloam, private money on public chains. https://www.gloam.trade",
    "",
  ].join("\n");

  return { html, text };
}
