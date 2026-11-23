/**
 * Self-test: sending Gloam email updates (lib/updatesMailRender, lib/updatesMail,
 * api/updates/mail, api/updates/unsubscribe, /unsubscribe).
 *
 *  - markdown: headings, paragraphs, lists, links, bold and italic render; every
 *    character the admin types is escaped, only https/http/mailto links (or a site
 *    path) become links, and random markup never leaves a tag we didn't write
 *  - the email: one column, the hosted mark, the green label, the footer with
 *    the reason, the unsubscribe link and the web link, and a plain-text part
 *  - batching: 100 messages a call at most, one person per message (no CC/BCC),
 *    each with their own unsubscribe link and RFC 8058 headers
 *  - who: the list as it stood when the update started; later sign-ups don't
 *    get it on a resume or a retry, and people who leave first are skipped
 *  - never twice: a double click starts one update; two senders at once send
 *    once; a sender that dies after Resend took a batch, or whose answer got
 *    lost, resends with the same key and nobody gets it twice; a batch with no
 *    answer for a day is counted unknown and never sent again; 429 backs off
 *  - refused: a bad address is split out and counted failed, then retried; a used-up
 *    quota or a refused key stops the send and puts people back for a resume
 *  - one-click unsubscribe by POST; a GET or opening the page changes nothing;
 *    the page's button does it
 *  - RESEND_API_KEY unset: nothing sends, and the admin says why
 *  - admin only, from the site; the archive shows only what went out, and
 *    nothing about who got it
 *
 * Uses the in-process store (GLOAM_PARTNERS_STORE=memory) and a fake Resend:
 * no email is sent and nothing reaches any host.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-updates-mail.mts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stubs: Record<string, string> = {
  "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)),
  "next/headers": fileURLToPath(new URL("./next-headers-stub.cjs", import.meta.url)),
};
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

process.env.GLOAM_PARTNERS_STORE = "memory";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.UPDATES_FROM;
delete process.env.UPDATES_REPLY_TO;
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "test";
env.ADMIN_ACCESS_CODE = "a-long-random-admin-code-for-the-updates-mail-selftest";
env.GLOAM_RATE_LIMIT_KEY = "cd".repeat(32);
const KEY = "re_test_not_a_real_key_0123456789";
env.RESEND_API_KEY = KEY;

const render = await import("../src/lib/updatesMailRender");
const mail = await import("../src/lib/updatesMail");
const list = await import("../src/lib/updatesList");
const { resetMemoryKv } = await import("../src/lib/partnersKv");
const { createAdminSession, ADMIN_COOKIE } = await import("../src/lib/adminAuth");
const mailRoute = await import("../src/app/api/updates/mail/route");
const oneClick = await import("../src/app/api/updates/unsubscribe/route");

const g = globalThis as { __testCookies?: Record<string, string>; __gloamPartnersMem?: Map<string, { v: unknown }> };
let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  n++;
};

// ============================================================ markdown and escaping
const TAGS = /<\/?(?:h2|h3|h4|p|ul|ol|li|strong|em|a|br)\b[^>]*>/g;
/** Body HTML with our own tags taken out: anything left that looks like a tag came from the input. */
function leftover(html: string): string {
  return html.replace(TAGS, "");
}
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
}
const bodyHtml = (md: string) => render.blocksToEmailHtml(render.parseMarkdown(md));

{
  const md = [
    "# Solana is live",
    "Private payroll now runs on **Solana**, with *receipts* and __more__.",
    "Read https://www.gloam.trade/docs/payroll.",
    "",
    "## What changed",
    "- Up to **15** a transaction",
    "- [The docs](/docs/payroll) and [mail us](mailto:hello@gloam.trade)",
    "  carried on",
    "",
    "3. three",
    "4. four",
    "",
    "### Small print",
    "snake_case_name stays, \\*not italic\\*, 2 * 3 * 4.",
  ].join("\n");
  const blocks = render.parseMarkdown(md);
  eq(
    blocks.map((b) => b.t),
    ["heading", "paragraph", "heading", "list", "list", "heading", "paragraph"],
    "headings, paragraphs and lists, in order",
  );
  const html = render.blocksToEmailHtml(blocks);
  ok(html.includes(">Solana is live</h2>"), "# is the first heading under the title");
  ok(html.includes(">What changed</h3>") && html.includes(">Small print</h4>"), "## and ### step down");
  ok(/<strong[^>]*>Solana<\/strong>/.test(html) && /<em[^>]*>receipts<\/em>/.test(html) && /<strong[^>]*>more<\/strong>/.test(html), "bold and italic");
  ok(html.includes('href="https://www.gloam.trade/docs/payroll"') && html.includes(">https://www.gloam.trade/docs/payroll</a>."), "a bare link, without the full stop");
  ok(html.includes('href="https://www.gloam.trade/docs/payroll" class="gl-link"'), "a site path points at the site");
  ok(html.includes('href="mailto:hello@gloam.trade"'), "mailto links");
  ok(html.includes('<ol start="3"'), "an ordered list keeps its first number");
  ok(html.includes("and <a") && html.includes("<br>carried on</li>"), "a line under an item carries on that item");
  ok(html.includes("snake_case_name stays, *not italic*, 2 * 3 * 4."), "underscores inside words and escaped stars stay text");
  ok(html.includes("Private payroll now runs on <strong") && html.includes("<br>Read "), "a new line is a line break");
  eq(leftover(html).includes("<"), false, "no tag but ours");

  const text = render.blocksToText(blocks);
  ok(text.includes("The docs (https://www.gloam.trade/docs/payroll) and mail us (hello@gloam.trade)"), "plain text keeps each address after its words");
  ok(text.includes("3. three\n4. four") && text.includes("- Up to 15 a transaction"), "plain text lists");
  ok(!/[<>]/.test(text.replace(/\(https?:[^)]*\)/g, "")), "plain text has no markup");
}

// injection: nothing the admin types becomes markup
{
  const nasty = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click](data:text/html;base64,PHNjcmlwdD4=)",
    "[click](//evil.example/x)",
    "[click](https://user:pass@evil.example/)",
    '[x](https://a.example/?q="><script>alert(1)</script>)',
    "[x](https://a.example/ onmouseover=alert(1))",
    "**<b>bold</b>** _<i>it</i>_",
    '"quotes" & \'apostrophes\' < > &amp;',
    "javascript:alert(1)",
    "https://a.example/\"onmouseover=\"alert(1)",
  ].join("\n\n");
  const html = bodyHtml(nasty);
  ok(!/<script|<img|<b>|<i>|onerror=|onmouseover=/i.test(leftover(html).replace(/&lt;|&gt;|&quot;/g, "")) || !leftover(html).includes("<"), "no tag or handler from the body");
  eq(leftover(html).includes("<"), false, "every < from the body is escaped");
  ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "a script tag is shown as text");
  ok(html.includes("&quot;quotes&quot; &amp; &#39;apostrophes&#39; &lt; &gt; &amp;amp;"), "quotes, ampersands and brackets escaped");
  for (const h of hrefs(html)) ok(/^(https?:\/\/[^"<>\s]+|mailto:[^"<>\s]+)$/.test(h) && !h.includes("@evil") && !h.startsWith("https://evil"), `only safe links: ${h}`);
  ok(!hrefs(html).some((h) => /javascript|data:/i.test(h)), "no javascript: or data: link");
  eq(render.safeHref("javascript:alert(1)"), null, "javascript: refused");
  eq(render.safeHref("//evil.example"), null, "protocol-relative refused");
  eq(render.safeHref("https://user:pw@evil.example"), null, "user:password@ refused");
  eq(render.safeHref("/docs"), "https://www.gloam.trade/docs", "a path is the site's");
  eq(render.safeHref("https://x.example/a b"), null, "a space ends a link");

  // the subject is escaped in the title, the heading and the preheader
  const e = render.renderUpdateEmail({ subject: 'Hi <img src=x onerror="1">', body: "Body <b>x</b>", day: "2026-11-22", webUrl: "https://www.gloam.trade/updates/x", unsubscribeUrl: "https://www.gloam.trade/unsubscribe?token=abc" });
  ok(!e.html.includes("<img src=x") && e.html.includes("<title>Hi &lt;img src=x onerror=&quot;1&quot;&gt;</title>"), "subject escaped in <title>");
  ok(!e.html.includes("<b>x</b>") && e.html.includes("Body &lt;b&gt;x&lt;/b&gt;"), "body escaped in the email");
  ok(!/<script|<svg|<iframe|<form|<object/i.test(e.html), "no script, SVG, frame or form in the email");

  // random markup, many times over: never a stray tag, never an unsafe link
  const alphabet = ["<", ">", '"', "'", "&", "*", "_", "[", "]", "(", ")", "#", "-", "1.", "\n", "\n\n", " ", "a", "b", ":", "/", "\\", "javascript:", "https://x.example/", "mailto:a@b.co", "data:", "onerror=", "<script>", "**", "__"];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let clean = true;
  for (let i = 0; i < 3000; i++) {
    let s = "";
    const len = 1 + Math.floor(rand() * 40);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
    const h = bodyHtml(s);
    if (leftover(h).includes("<") || leftover(h).includes(">") || hrefs(h).some((x) => !/^(https?:\/\/|mailto:)/.test(x) || /["<>\s]/.test(x))) {
      clean = false;
      console.error("unsafe output for", JSON.stringify(s), h);
      break;
    }
  }
  ok(clean, "3,000 random bodies: no stray tag, no unsafe link");
}

// the whole email
{
  const e = render.renderUpdateEmail({
    subject: "Private payroll is live",
    body: "First paragraph is the preview line.\n\n- one",
    day: "2026-11-22",
    webUrl: "https://www.gloam.trade/updates/2026-11-22-private-payroll-is-live",
    unsubscribeUrl: render.UNSUBSCRIBE_MARK,
  });
  ok(e.html.startsWith("<!doctype html>"), "a full document");
  ok(e.html.includes("max-width:600px"), "one column, 600px at most");
  ok(e.html.includes('src="https://www.gloam.trade/brand/kit/email/gloam-email-header.png"'), "the header art is a hosted PNG");
  ok(e.html.includes('src="https://www.gloam.trade/brand/kit/email/gloam-email-header-dark.png"') && e.html.includes(".gl-dark-img{display:block!important"), "a dark header for dark mode");
  ok(/class="gl-dark-img" style="display:none;max-height:0;overflow:hidden;mso-hide:all;"/.test(e.html), "the dark header is hidden unless dark mode shows it");
  ok(e.html.includes("@font-face{font-family:Aeonik;font-style:normal;font-weight:300;src:url(https://www.gloam.trade/fonts/Aeonik-Light.woff2)"), "Aeonik from the site where a mail app loads web fonts");
  ok(e.html.includes("background:#F4F4F5") && e.html.includes('class="gl-card"'), "a white card on the app's ground");
  ok(e.html.includes("#2E7D53") && e.html.includes("Gloam update, 22 November 2026"), "the green label with the day");
  ok(e.html.includes('content="light dark"') && e.html.includes("prefers-color-scheme:dark"), "dark mode colours for mail apps that use them");
  ok(e.html.includes("background:#FFFFFF"), "the card is white");
  ok(e.html.includes("You get Gloam updates because you signed up on gloam.trade or entered a Gloam contest."), "the footer says why");
  ok(e.html.includes(`href="${render.UNSUBSCRIBE_MARK}"`) && e.html.includes('href="https://www.gloam.trade/updates/2026-11-22-private-payroll-is-live"'), "unsubscribe and web links in the footer");
  ok(e.html.includes(">First paragraph is the preview line."), "the preheader is the first line");
  ok(e.text.startsWith("Private payroll is live\n\nFirst paragraph is the preview line.\n\n- one\n"), "plain text: subject, then body");
  ok(e.text.includes(`Unsubscribe: ${render.UNSUBSCRIBE_MARK}`) && e.text.includes("View on the web: https://www.gloam.trade/updates/"), "plain text footer");
  ok(!/\u2014/.test(e.html + e.text), "no em dashes");
  eq(render.checkUpdate("", "x"), "Add a subject.", "a subject is needed");
  eq(render.checkUpdate("x", "   "), "Write the update first.", "a body is needed");
  ok(render.checkUpdate("a\nb", "x")?.includes("one line"), "a subject is one line");
  ok(render.checkUpdate("x".repeat(151), "x")?.includes("150"), "subject length");
  ok(render.checkUpdate("x", "x".repeat(20_001))?.includes("20,000"), "body length");
  ok(render.checkUpdate("x", `see ${render.UNSUBSCRIBE_MARK}`) !== null, "the link mark can't be typed into a body");
  eq(render.checkUpdate("Fine", "Fine"), null, "a good update passes");
}

// a paragraph that is one link and nothing else is a button
{
  const blocks = render.parseMarkdown("Read on.\n\n[Open Gloam](https://www.gloam.trade/app)\n\nSee [the docs](/docs) too.\n\nhttps://www.gloam.trade\n\n[Bad](javascript:alert(1))\n\n[Two](https://a.example) [links](https://b.example)");
  eq(blocks.map((b) => b.t).join(","), "paragraph,button,paragraph,paragraph,paragraph,paragraph", "only a lone [label](link) is a button");
  const btn = blocks[1] as { t: "button"; href: string; label: string };
  eq(btn.href, "https://www.gloam.trade/app", "the button's link");
  eq(btn.label, "Open Gloam", "the button's label");
  const tricky = render.parseMarkdown('[<b>Go</b> "now"](https://www.gloam.trade)');
  eq(tricky[0]?.t, "button", "a label with markup is still a button");
  const html = render.blocksToEmailHtml(tricky);
  ok(html.includes("&lt;b&gt;Go&lt;/b&gt; &quot;now&quot;") && !html.includes("<b>"), "the button label is escaped");
  ok(html.includes('class="gl-btn"') && html.includes('href="https://www.gloam.trade/"'), "a filled button cell with the link");
  eq(render.blocksToText(blocks.slice(1, 2)), "Open Gloam: https://www.gloam.trade/app", "plain text: label and link");
  eq(render.summaryOf(render.parseMarkdown("[Open Gloam](https://www.gloam.trade/app)")), "Open Gloam", "a button alone still gives a preview line");
  ok(!render.blocksToEmailHtml(render.parseMarkdown("[Bad](javascript:alert(1))")).includes("javascript"), "no button for an unsafe link");
}

// ============================================================ a fake Resend
type Sent = { from: string; to: string[]; cc?: unknown; bcc?: unknown; reply_to: string; subject: string; html: string; text: string; headers?: Record<string, string>; tags?: unknown };
type Script = (ctx: { messages: Sent[]; key: string | null; call: number }) => "deliver" | "deliver-then-500" | "deliver-then-throw" | Response | Error | null;

class FakeResend {
  delivered: Sent[] = [];
  calls: { key: string | null; size: number; status: number }[] = [];
  keys = new Map<string, { hash: string; status: number; body: string }>();
  script: Script | null = null;
  reject = new Set<string>();
  /** Answer a rejected address as Resend's 400 validation_error instead of 422. */
  rejectAs400 = false;

  count(email: string) {
    return this.delivered.filter((m) => m.to.includes(email)).length;
  }

  fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(String(url), "https://api.resend.com/emails/batch", "only Resend's batch endpoint");
    const h = new Headers(init?.headers);
    assert.equal(h.get("authorization"), `Bearer ${KEY}`);
    assert.ok(h.get("user-agent"), "Resend wants a User-Agent");
    const raw = String(init?.body ?? "");
    const messages = JSON.parse(raw) as Sent[];
    const key = h.get("idempotency-key");
    const call = this.calls.length;
    const record = (status: number) => this.calls.push({ key, size: messages.length, status });
    const hash = createHash("sha256").update(raw).digest("hex");
    // an Error never reached Resend; a scripted answer (a 429, a 403) comes before Resend looks at the key
    const act = this.script?.({ messages, key, call }) ?? "deliver";
    if (act instanceof Error) {
      record(0);
      throw act;
    }
    if (act instanceof Response) {
      record(act.status);
      return act;
    }
    if (key) {
      const prev = this.keys.get(key);
      if (prev && prev.hash !== hash) {
        record(409);
        return Response.json({ statusCode: 409, name: "invalid_idempotent_request", message: "Same key, new body." }, { status: 409 });
      }
      if (prev) {
        record(prev.status);
        return new Response(prev.body, { status: prev.status, headers: { "Content-Type": "application/json" } });
      }
    }
    if (messages.some((m) => m.to.some((t) => this.reject.has(t)))) {
      const status = this.rejectAs400 ? 400 : 422;
      record(status);
      return Response.json({ statusCode: status, name: "validation_error", message: "Invalid `to` field." }, { status });
    }
    // Resend took it: it goes out, and the answer is kept for the key
    this.delivered.push(...messages);
    const body = JSON.stringify({ data: messages.map((_, i) => ({ id: `em_${call}_${i}` })) });
    if (key) this.keys.set(key, { hash, status: 200, body });
    if (act === "deliver-then-500") {
      record(500);
      return Response.json({ statusCode: 500, name: "application_error", message: "Oops." }, { status: 500 });
    }
    if (act === "deliver-then-throw") {
      record(0);
      throw new TypeError("fetch failed");
    }
    record(200);
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

let clock = Date.UTC(2026, 10, 22, 12, 0, 0);
const slept: number[] = [];
function opts(fake: FakeResend, extra: Partial<import("../src/lib/updatesMail").SendOptions> = {}) {
  return {
    fetch: fake.fetch,
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    minGapMs: 0,
    ...extra,
  };
}

async function addSubscribers(count: number, prefix = "p") {
  for (let i = 0; i < count; i++) await list.subscribeToUpdates(`${prefix}${i}@example.com`, i % 3 === 0 ? "site" : i % 3 === 1 ? "settings" : "sign-in");
}

/** Sends until done or stopped, like the admin page does. */
async function sendAll(id: string, o: ReturnType<typeof opts>, max = 50) {
  let p = await mail.sendStep(id, o);
  for (let i = 0; i < max && !p.done && !p.stopped; i++) p = await mail.sendStep(id, o);
  return p;
}

function stored(): { key: string; text: string }[] {
  const mem = g.__gloamPartnersMem ?? new Map();
  return [...mem.entries()]
    .filter(([k]) => k.startsWith(list.UPDATES_PREFIX))
    .map(([k, e]) => ({ key: k, text: e.v instanceof Set ? [...e.v].join(",") : e.v instanceof Map ? JSON.stringify([...e.v]) : String(e.v) }));
}

// ============================================================ batching and per-person messages
resetMemoryKv();
{
  await addSubscribers(250);
  const subs = await list.listUpdatesSubscribers();
  const fake = new FakeResend();
  const { update, existing } = await mail.startUpdate("Private payroll is live", "Hello **list**.\n\nMore at /docs.", clock);
  eq(existing, false, "a new update");
  eq(update.id, "2026-11-22-private-payroll-is-live", "the id is the day and the subject");
  eq(await mail.getPublishedUpdate(update.id), null, "not public before anything went out");

  const p = await sendAll(update.id, opts(fake));
  eq(p.done, true, "done");
  eq([p.sent, p.failed, p.unknown, p.left, p.pending], [250, 0, 0, 0, 0], "250 sent");
  eq(fake.calls.map((c) => c.size), [100, 100, 50], "three batch calls: 100, 100, 50");
  ok(fake.calls.every((c, i) => c.key === `gloam-update/${update.id}/${i + 1}`), "each batch has its own idempotency key");
  eq(fake.delivered.length, 250, "one message per person");
  ok(subs.every((s) => fake.count(s.email) === 1), "everyone got exactly one");
  for (const m of fake.delivered) {
    assert.equal(m.to.length, 1, "one address in To");
    assert.equal(m.cc, undefined, "no CC");
    assert.equal(m.bcc, undefined, "no BCC");
    const s = subs.find((x) => x.email === m.to[0])!;
    assert.equal(m.headers?.["List-Unsubscribe"], `<https://www.gloam.trade/api/updates/unsubscribe?token=${s.token}>`, "their own one-click link");
    assert.equal(m.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "RFC 8058 one-click");
    assert.ok(m.html.includes(`href="https://www.gloam.trade/unsubscribe?token=${s.token}"`), "their own unsubscribe link in the HTML");
    assert.ok(m.text.includes(`Unsubscribe: https://www.gloam.trade/unsubscribe?token=${s.token}`), "and in the text");
    assert.ok(!m.html.includes(render.UNSUBSCRIBE_MARK) && !m.text.includes(render.UNSUBSCRIBE_MARK), "no mark left");
    assert.ok(subs.every((o) => o.token === s.token || !m.html.includes(o.token)), "nobody else's token");
    assert.equal(m.from, "Gloam <updates@gloam.trade>");
    assert.equal(m.reply_to, "hello@gloam.trade");
    assert.equal(m.subject, "Private payroll is live");
    assert.ok(m.html.includes(`href="https://www.gloam.trade/updates/${update.id}"`), "the web version");
  }
  n += 13;

  // the archive
  const pub = await mail.getPublishedUpdate(update.id);
  eq(pub, { id: update.id, subject: "Private payroll is live", body: "Hello **list**.\n\nMore at /docs.", day: "2026-11-22" }, "public: subject, body and day only");
  eq((await mail.listPublishedUpdates()).map((u) => u.id), [update.id], "listed");

  // nothing left behind that holds an email, apart from the list itself
  const left = stored().filter((e) => !e.key.includes(":sub:"));
  ok(!left.some((e) => e.key.includes(":batch:")), "no pending batch left");
  ok(!left.some((e) => e.key.includes("@") || (e.text.includes("@") && !e.key.endsWith(`mail:${update.id}`))), "no email kept outside the list and the update text");

  // sending it again sends nothing
  const before = fake.delivered.length;
  const again = await mail.sendStep(update.id, opts(fake));
  eq([again.done, fake.delivered.length], [true, before], "a finished update sends nothing more");
  const restart = await mail.startUpdate("Private payroll is live", "Hello **list**.\n\nMore at /docs.", clock);
  eq([restart.existing, restart.update.id, restart.update.status], [true, update.id, "sent"], "the same text again is the same update, already sent");
}

// ============================================================ who it goes to: the list when it started
resetMemoryKv();
{
  await addSubscribers(150);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("The list as it was", "Body.", clock);
  await list.subscribeToUpdates("late@example.com", "site");
  // one batch, then the step's time is up
  const first = await mail.sendStep(update.id, opts(fake, { budgetMs: 5_000, afterResendAccepted: () => void (clock += 6_000) }));
  eq(first.left, 50, "the rest of the 150 are left, not the late joiner");
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent], [true, 150], "the 150 who were on the list get it");
  eq(fake.count("late@example.com"), 0, "someone who joined after it started doesn't");
  await list.subscribeToUpdates("later@example.com", "site");
  const again = await mail.sendStep(update.id, opts(fake));
  eq([again.done, fake.count("later@example.com"), fake.delivered.length], [true, 0, 150], "a finished update sends nothing, to new people either");

  // a start that died after its id was taken is finished by the next click
  const mem = g.__gloamPartnersMem!;
  const { update: u2 } = await mail.startUpdate("Half started", "Body.", clock);
  const k = `${list.UPDATES_PREFIX}mail:${u2.id}`;
  const r = JSON.parse(String(mem.get(k)!.v)) as { audienceAt: number | null };
  r.audienceAt = null;
  mem.set(k, { v: JSON.stringify(r) } as never);
  mem.delete(`${list.UPDATES_PREFIX}mail:${u2.id}:to`);
  const listKey = `${list.UPDATES_PREFIX}mails`;
  mem.set(listKey, { v: (mem.get(listKey)!.v as string[]).filter((x) => x !== u2.id) } as never);
  const again2 = await mail.startUpdate("Half started", "Body.", clock);
  eq([again2.existing, again2.update.id], [true, u2.id], "the same update");
  ok(!!again2.update.audienceAt && mem.has(`${list.UPDATES_PREFIX}mail:${u2.id}:to`), "its audience is set");
  ok((await mail.listUpdatesForAdmin()).some((u) => u.id === u2.id), "and the admin sees it");
  const p2 = await sendAll(u2.id, opts(fake));
  eq(p2.sent, 152, "it goes to the list as it is now");
}

// ============================================================ double click, two senders at once
resetMemoryKv();
{
  await addSubscribers(230);
  const fake = new FakeResend();
  const [a, b] = await Promise.all([mail.startUpdate("Two tabs", "Same text.", clock), mail.startUpdate("Two tabs", "Same text.", clock)]);
  eq(a.update.id, b.update.id, "two clicks start one update");
  eq((await mail.listUpdatesForAdmin()).length, 1, "one update stored");
  const [p1, p2] = await Promise.all([mail.sendStep(a.update.id, opts(fake)), mail.sendStep(a.update.id, opts(fake))]);
  ok(p1.busy !== p2.busy, "the second sender at once is told busy and sends nothing");
  const p = await sendAll(a.update.id, opts(fake));
  eq(p.sent, 230, "230 sent");
  const subs = await list.listUpdatesSubscribers();
  ok(subs.every((s) => fake.count(s.email) === 1), "nobody got it twice");
}

// ============================================================ crash after Resend took a batch
resetMemoryKv();
{
  await addSubscribers(250);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("Crash test", "Body.", clock);
  let crashed = false;
  const dying = opts(fake, {
    afterResendAccepted: (seq: number) => {
      if (seq === 2 && !crashed) {
        crashed = true;
        throw new Error("the function died");
      }
    },
  });
  await assert.rejects(mail.sendStep(update.id, dying), /died/, "the step dies after batch 2 went out");
  eq(fake.delivered.length, 200, "two batches went out before it died");
  const mid = await mail.progressOf((await mail.getUpdate(update.id))!);
  eq([mid.sent, mid.pending], [100, 1], "the store heard of one; the other is pending");
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent, p.unknown], [true, 250, 0], "the resume finishes");
  eq(fake.delivered.length, 250, "nobody got it twice across the crash");
  const resent = fake.calls.filter((c) => c.key === `gloam-update/${update.id}/2`);
  eq(resent.length, 2, "batch 2 went again with the same key, and Resend answered from its record");
  const subs = await list.listUpdatesSubscribers();
  ok(subs.every((s) => fake.count(s.email) === 1), "each person once");
}

// ============================================================ the stored email changed between tries: never sent again
resetMemoryKv();
{
  await addSubscribers(120);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("Changed between tries", "Body.", clock);
  await assert.rejects(
    mail.sendStep(update.id, opts(fake, { afterResendAccepted: () => { throw new Error("the function died"); } })),
    /died/,
  );
  eq(fake.delivered.length, 100, "batch 1 went out, then the step died");
  // as if a deploy changed how the email is drawn: the same key would now carry a different body
  const mem = g.__gloamPartnersMem!;
  const k = `${list.UPDATES_PREFIX}mail:${update.id}`;
  const recNow = JSON.parse(String(mem.get(k)!.v)) as { html: string };
  recNow.html = recNow.html.replace("You get Gloam updates", "You get updates from Gloam");
  mem.set(k, { v: JSON.stringify(recNow) } as never);
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent, p.unknown], [true, 20, 100], "Resend's 409 marks the batch unknown; the rest are sent");
  eq(fake.delivered.length, 120, "and batch 1 never went twice");
}

// ============================================================ a lost answer, then the same key
resetMemoryKv();
{
  await addSubscribers(150);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("Lost answer", "Body.", clock);
  // batch 1's answer is a 500 and batch 2's connection drops, both after Resend took them
  fake.script = ({ key }) => (key?.endsWith("/1") ? "deliver-then-500" : key?.endsWith("/2") ? "deliver-then-throw" : "deliver");
  slept.length = 0;
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent], [true, 150], "sent despite two lost answers");
  eq(fake.delivered.length, 150, "the retries with the same key sent nothing twice");
  ok(slept.length >= 2, "backed off before each retry");
}

// ============================================================ no answer for a day: unknown, never again
resetMemoryKv();
{
  await addSubscribers(150);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("A day late", "Body.", clock);
  // Resend takes the first batch, the answer is lost, and the connection stays down until the step gives up
  let tries = 0;
  fake.script = ({ key }) => (key?.endsWith("/1") ? (tries++ === 0 ? "deliver-then-throw" : new TypeError("fetch failed")) : "deliver");
  const first = await mail.sendStep(update.id, opts(fake, { budgetMs: 2_000 }));
  eq([first.pending, first.sent, first.done], [1, 0, false], "the batch with no answer stays pending");
  ok(first.stopped?.includes("nobody gets it twice"), "and the admin is told to resume");
  eq(fake.delivered.length, 100, "it did go out once");
  // the store's record of Resend's answer is lost too: from Resend's side the key lapses after 24 hours
  fake.keys.clear();
  fake.script = null;
  clock += 24 * 60 * 60 * 1000;
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent, p.unknown], [true, 50, 100], "after a day the batch is unknown, the rest are sent");
  eq(fake.delivered.length, 150, "the lapsed batch was never sent again");
  const subs = await list.listUpdatesSubscribers();
  ok(subs.every((s) => fake.count(s.email) === 1), "each person once");
}

// ============================================================ 429: back off, same key
resetMemoryKv();
{
  await addSubscribers(120);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("Rate limited", "Body.", clock);
  slept.length = 0;
  fake.script = ({ call }) =>
    call === 1 ? Response.json({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." }, { status: 429, headers: { "retry-after": "2" } }) : "deliver";
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent], [true, 120], "sent after the wait");
  ok(slept.includes(2000), "waited for retry-after");
  eq(fake.calls[1]!.key, fake.calls[2]!.key, "the retry used the same key");
  eq(fake.delivered.length, 120, "once each");
}

// ============================================================ a bad address, quota, refused key
resetMemoryKv();
{
  await addSubscribers(40);
  await list.subscribeToUpdates("reject-me@example.com", "site");
  const fake = new FakeResend();
  fake.reject.add("reject-me@example.com");
  const { update } = await mail.startUpdate("One bad address", "Body.", clock);
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent, p.failed], [true, 40, 1], "the refused address is split out and counted failed");
  eq(fake.count("reject-me@example.com"), 0, "it never went out");
  ok((await list.listUpdatesSubscribers()).filter((s) => s.email !== "reject-me@example.com").every((s) => fake.count(s.email) === 1), "the rest once each");
  const listed = (await mail.listUpdatesForAdmin())[0]!;
  ok(listed.note?.includes("refused an address"), "the admin sees why");
  fake.reject.clear();
  await list.subscribeToUpdates("joined-after@example.com", "site");
  await mail.retryFailed(update.id);
  const p2 = await sendAll(update.id, opts(fake));
  eq(fake.count("joined-after@example.com"), 0, "a retry doesn't reach people who joined after the update started");
  eq([p2.done, p2.sent, p2.failed], [true, 41, 0], "retry failed sends it once it's accepted");
  eq(fake.count("reject-me@example.com"), 1, "once");
  eq(fake.delivered.length, 41, "nobody else twice");
}
resetMemoryKv();
{
  // Resend's errors page lists a bad field as 400 validation_error: one such address
  // must not stall the send (it used to stop every step at the same first batch)
  await addSubscribers(40);
  await list.subscribeToUpdates("bad-400@example.com", "site");
  const fake = new FakeResend();
  fake.reject.add("bad-400@example.com");
  fake.rejectAs400 = true;
  const { update } = await mail.startUpdate("A 400 address", "Body.", clock);
  const p = await sendAll(update.id, opts(fake));
  eq([p.done, p.sent, p.failed], [true, 40, 1], "a 400 validation_error is split out like a 422, the rest go");
  eq(fake.count("bad-400@example.com"), 0, "and it never went out");
}
resetMemoryKv();
{
  await addSubscribers(250);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("Quota", "Body.", clock);
  fake.script = ({ call }) =>
    call === 1 ? Response.json({ statusCode: 429, name: "daily_quota_exceeded", message: "Daily quota." }, { status: 429 }) : "deliver";
  const p = await mail.sendStep(update.id, opts(fake));
  ok(p.stopped?.includes("daily sending limit"), "a used-up quota stops the send");
  eq([p.sent, p.pending, p.left, p.done], [100, 0, 150, false], "the refused batch is back in line");
  const p2 = await sendAll(update.id, opts(fake));
  eq([p2.done, p2.sent], [true, 250], "resume finishes it");
  eq(fake.delivered.length, 250, "once each");

  const fake2 = new FakeResend();
  fake2.script = () => Response.json({ statusCode: 403, name: "validation_error", message: "The gloam.trade domain is not verified." }, { status: 403 });
  const { update: u2 } = await mail.startUpdate("Unverified", "Body.", clock);
  const r = await mail.sendStep(u2.id, opts(fake2));
  ok(r.stopped?.includes("RESEND_API_KEY") && r.stopped.includes("not verified"), "a refused key or domain says what to check");
  eq([r.sent, r.pending, r.left], [0, 0, 250], "nobody is marked sent");
  eq(fake2.delivered.length, 0, "nothing went out");
}

// ============================================================ unsubscribing mid-send
resetMemoryKv();
{
  await addSubscribers(150);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("Mid send", "Body.", clock);
  // a step with no time starts no batch; then someone leaves before their batch
  const subs = await list.listUpdatesSubscribers();
  const sorted = [...subs].sort((a, b) => (a.email < b.email ? -1 : 1));
  const leaver = sorted.find((s) => fake.count(s.email) === 0)!;
  await list.unsubscribeToken(leaver.token);
  const p = await sendAll(update.id, opts(fake));
  eq(fake.count(leaver.email), 0, "someone who left before their batch gets nothing");
  eq(p.sent, 149, "the rest get it");
}

// ============================================================ one-click unsubscribe
resetMemoryKv();
{
  await addSubscribers(3);
  const [a, b, c] = await list.listUpdatesSubscribers();
  const form = (token: string, body = "List-Unsubscribe=One-Click", extra = "") =>
    new Request(`https://www.gloam.trade/api/updates/unsubscribe?token=${token}${extra}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  const r1 = await oneClick.POST(form(a!.token));
  eq(r1.status, 200, "one-click POST answers 200");
  ok((await r1.text()).includes("unsubscribed"), "in plain words");
  ok(!(await list.listUpdatesSubscribers()).some((s) => s.email === a!.email), "and the person is off the list");
  const fakeTok = "z".repeat(32);
  const r2 = await oneClick.POST(form(fakeTok));
  eq([r2.status, await r2.text()], [200, "You're unsubscribed from Gloam updates.\n"], "a made-up token gets the same answer");
  const multipart = new FormData();
  multipart.set("List-Unsubscribe", "One-Click");
  const r3 = await oneClick.POST(new Request(`https://www.gloam.trade/api/updates/unsubscribe?token=${b!.token}`, { method: "POST", body: multipart }));
  eq(r3.status, 200, "multipart one-click works too");
  ok(!(await list.listUpdatesSubscribers()).some((s) => s.email === b!.email), "off the list");

  // a GET never unsubscribes: link checkers open links
  const g1 = await oneClick.GET(new Request(`https://www.gloam.trade/api/updates/unsubscribe?token=${c!.token}`));
  eq(g1.status, 303, "a GET goes to the page");
  eq(g1.headers.get("location"), `https://www.gloam.trade/unsubscribe?token=${c!.token}`, "with the token");
  ok((await list.listUpdatesSubscribers()).some((s) => s.email === c!.email), "and changes nothing");

  // opening the page asks; it doesn't unsubscribe
  const page = await import("../src/app/unsubscribe/page");
  await page.default({ searchParams: Promise.resolve({ token: c!.token }) });
  ok((await list.listUpdatesSubscribers()).some((s) => s.email === c!.email), "opening /unsubscribe?token= changes nothing");
  // the page's button
  const fromPage = await oneClick.POST(form("", `token=${c!.token}&from=page`));
  eq(fromPage.status, 303, "the button goes back to the page");
  eq(fromPage.headers.get("location"), "https://www.gloam.trade/unsubscribe?done=1", "which says it's done");
  ok(!(await list.listUpdatesSubscribers()).some((s) => s.email === c!.email), "and the person is off the list");
  eq(await list.unsubscribeToken(c!.token), false, "the token is spent");
}

// ============================================================ sending off without RESEND_API_KEY
resetMemoryKv();
{
  await addSubscribers(5);
  const fake = new FakeResend();
  const { update } = await mail.startUpdate("Made while on", "Body.", clock);
  delete env.RESEND_API_KEY;
  const cfg = mail.publicMailConfig();
  eq([cfg.on, cfg.from, cfg.replyTo], [false, "Gloam <updates@gloam.trade>", "hello@gloam.trade"], "off, with the defaults shown");
  ok(cfg.reason?.includes("RESEND_API_KEY"), "and why");
  ok(!JSON.stringify(cfg).includes("re_"), "no key in what the admin sees");
  await assert.rejects(mail.sendTest("S", "B", "hello@gloam.trade", opts(fake)), mail.MailOffError, "no test");
  await assert.rejects(mail.startUpdate("New one", "Body.", clock), mail.MailOffError, "no new update");
  await assert.rejects(mail.sendStep(update.id, opts(fake)), mail.MailOffError, "no step");
  eq(fake.calls.length, 0, "Resend never called");

  g.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
  const post = (body: unknown) =>
    mailRoute.POST(
      new Request("https://www.gloam.trade/api/updates/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "https://www.gloam.trade", host: "www.gloam.trade" },
        body: JSON.stringify(body),
      }),
    );
  const r = await post({ action: "test", subject: "S", body: "B", to: "hello@gloam.trade" });
  const j = (await r.json()) as { ok: boolean; error?: { message: string } };
  eq(r.status, 409, "the route refuses");
  ok(j.error?.message.startsWith("Sending is off:"), "and says so plainly");
  const got = (await (await mailRoute.GET()).json()) as { ok: boolean; data: { mail: { on: boolean; reason: string } } };
  eq(got.data.mail.on, false, "the admin GET says sending is off");
  ok(got.data.mail.reason.includes("RESEND_API_KEY"), "and why");

  env.RESEND_API_KEY = KEY;
  env.UPDATES_FROM = "not an address";
  eq(mail.publicMailConfig().on, false, "a bad UPDATES_FROM keeps sending off");
  env.UPDATES_FROM = "Gloam Team <News@Gloam.Trade>";
  env.UPDATES_REPLY_TO = "team@gloam.trade";
  eq([mail.publicMailConfig().on, mail.publicMailConfig().from, mail.publicMailConfig().replyTo], [true, "Gloam Team <news@gloam.trade>", "team@gloam.trade"], "UPDATES_FROM and UPDATES_REPLY_TO are used");
  delete env.UPDATES_FROM;
  delete env.UPDATES_REPLY_TO;
  g.__testCookies = {};
}

// ============================================================ the admin route
resetMemoryKv();
{
  await addSubscribers(12);
  const fake = new FakeResend();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const req = (body: unknown, headers: Record<string, string> = {}) =>
      new Request("https://www.gloam.trade/api/updates/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "https://www.gloam.trade", host: "www.gloam.trade", ...headers },
        body: JSON.stringify(body),
      });
    g.__testCookies = {};
    eq((await mailRoute.GET()).status, 401, "no session, no admin GET");
    eq((await mailRoute.POST(req({ action: "start", subject: "S", body: "B" }))).status, 401, "no session, no send");
    g.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
    eq((await mailRoute.POST(req({ action: "start", subject: "S", body: "B" }, { origin: "https://evil.example" }))).status, 403, "another site can't send");
    eq((await mailRoute.POST(req({ action: "start", subject: "S", body: "B" }, { "Content-Type": "text/plain" }))).status, 403, "a form post can't send");

    // a test: one message, [Test], no unsubscribe headers, nothing stored
    const t = await mailRoute.POST(req({ action: "test", subject: "Hello", body: "Hi **there**", to: " Hello@Gloam.trade " }));
    eq(t.status, 200, "test sent");
    eq(fake.delivered.length, 1, "one test message");
    const tm = fake.delivered[0]!;
    eq([tm.to, tm.subject], [["hello@gloam.trade"], "[Test] Hello"], "to the address typed, marked [Test]");
    eq(tm.headers, undefined, "no unsubscribe headers on a test");
    ok(tm.html.includes('href="https://www.gloam.trade/unsubscribe"'), "its unsubscribe link has no token");
    eq(fake.calls[0]!.key, null, "a test has no idempotency key");
    eq((await mail.listUpdatesForAdmin()).length, 0, "a test stores nothing");
    eq((await mailRoute.POST(req({ action: "test", subject: "Hello", body: "Hi", to: "nope" }))).status, 400, "a bad test address");

    // start, then send in steps
    const s = (await (await mailRoute.POST(req({ action: "start", subject: "Hello", body: "Hi **there**" }))).json()) as { data: { id: string; existing: boolean } };
    const s2 = (await (await mailRoute.POST(req({ action: "start", subject: "Hello", body: "Hi **there**" }))).json()) as { data: { id: string; existing: boolean } };
    eq([s2.data.id, s2.data.existing], [s.data.id, true], "a second click gives back the same update");
    const step = (await (await mailRoute.POST(req({ action: "send", id: s.data.id }))).json()) as { ok: boolean; data: { done: boolean; sent: number } };
    eq([step.ok, step.data.done, step.data.sent], [true, true, 12], "one step sends a small list");
    eq((await mailRoute.POST(req({ action: "send", id: "../etc" }))).status, 400, "a bad id");
    eq((await mailRoute.POST(req({ action: "send", id: "no-such-update" }))).status, 400, "an unknown id");
    eq((await mailRoute.POST(req({ action: "start", subject: "Two\nlines", body: "B" }))).status, 400, "a bad subject");

    const listed = (await (await mailRoute.GET()).json()) as { data: { subscribers: number; mail: { on: boolean }; updates: { id: string; sent: number; done: boolean }[] } };
    eq([listed.data.subscribers, listed.data.mail.on], [12, true], "the admin sees the count and that sending is on");
    eq(listed.data.updates.map((u) => [u.id, u.sent, u.done]), [[s.data.id, 12, true]], "and the update with its count");
    ok(!JSON.stringify(listed).includes("@example.com"), "and no subscriber's email");
    ok(!JSON.stringify(listed).includes(KEY), "and never the key");
  } finally {
    globalThis.fetch = realFetch;
    g.__testCookies = {};
  }
}

// ============================================================ delivery: Resend's webhook
{
  const { createHmac } = await import("node:crypto");
  const dlv = await import("../src/lib/updatesDelivery");
  const hook = await import("../src/app/api/updates/webhook/route");
  resetMemoryKv();
  const SECRET = `whsec_${Buffer.from("a-test-signing-secret-32-bytes!!").toString("base64")}`;
  const sign = (id: string, ts: number, body: string, secret = SECRET) =>
    `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const now = Math.floor(Date.now() / 1000);

  // the signature
  const b = '{"type":"email.delivered"}';
  ok(dlv.verifyWebhook(SECRET, { id: "msg_1", timestamp: String(now), signature: sign("msg_1", now, b) }, b, now), "a good signature passes");
  ok(dlv.verifyWebhook(SECRET, { id: "msg_1", timestamp: String(now), signature: `v1,bm9wZQ== ${sign("msg_1", now, b)}` }, b, now), "one good signature among several passes");
  ok(!dlv.verifyWebhook(SECRET, { id: "msg_1", timestamp: String(now), signature: sign("msg_1", now, b) }, `${b} `, now), "a changed body fails");
  ok(!dlv.verifyWebhook(SECRET, { id: "msg_2", timestamp: String(now), signature: sign("msg_1", now, b) }, b, now), "another id fails");
  ok(!dlv.verifyWebhook(SECRET, { id: "msg_1", timestamp: String(now - 600), signature: sign("msg_1", now - 600, b) }, b, now), "a call older than five minutes fails");
  ok(!dlv.verifyWebhook(`whsec_${Buffer.from("another-secret-of-32-bytes-long!").toString("base64")}`, { id: "msg_1", timestamp: String(now), signature: sign("msg_1", now, b) }, b, now), "another secret fails");
  ok(!dlv.verifyWebhook(SECRET, { id: "msg_1", timestamp: String(now), signature: null }, b, now), "no signature fails");

  const call = (id: string, event: unknown, opts: { ts?: number; secret?: string } = {}) => {
    const body = JSON.stringify(event);
    const ts = opts.ts ?? now;
    return hook.POST(
      new Request("https://www.gloam.trade/api/updates/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(ts), "svix-signature": sign(id, ts, body, opts.secret) },
        body,
      }),
    );
  };
  delete env.RESEND_WEBHOOK_SECRET;
  eq((await call("m0", { type: "email.delivered" })).status, 503, "no secret set: tracking is off");
  ok(!dlv.deliveryTrackingOn(), "and says so");
  env.RESEND_WEBHOOK_SECRET = SECRET;
  ok(dlv.deliveryTrackingOn(), "on once the secret is set");
  eq((await call("m0", { type: "email.delivered" }, { secret: `whsec_${Buffer.from("not-the-secret-not-the-secret!!!").toString("base64")}` })).status, 401, "a forged call is refused");

  await list.subscribeToUpdates("bad@example.com", "site");
  await list.subscribeToUpdates("spam@example.com", "contest");
  await list.subscribeToUpdates("full@example.com", "sign-in");
  const U = "2026-11-23-gloam-this-week";
  const ev = (type: string, emailId: string, to: string, extra: Record<string, unknown> = {}) => ({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: emailId, to: [to], subject: "x", tags: { update: U }, ...extra },
  });
  eq((await call("e1", ev("email.delivered", "em_1", "ok@example.com"))).status, 200, "a delivery is taken");
  eq((await call("e1", ev("email.delivered", "em_1", "ok@example.com"))).status, 200, "the same call again is fine");
  await call("e2", ev("email.delivered", "em_1", "ok@example.com")); // Resend's own retry under a new id
  await call("e3", ev("email.delivered", "em_2", "two@example.com"));
  await call("e4", ev("email.bounced", "em_3", "bad@example.com", { bounce: { type: "Permanent", subType: "General", message: "No such user" } }));
  await call("e5", ev("email.complained", "em_4", "spam@example.com"));
  await call("e6", ev("email.bounced", "em_5", "full@example.com", { bounce: { type: "Transient", subType: "MailboxFull", message: "Mailbox full" } }));
  await call("e7", ev("email.opened", "em_1", "ok@example.com"));
  await call("e8", { type: "email.bounced", data: { email_id: "em_9", to: ["stray@example.com"], bounce: { type: "Permanent" } } });
  // tags as a list of { name, value } count the same
  await call("e9", { type: "email.delivered", data: { email_id: "em_6", to: ["six@example.com"], tags: [{ name: "update", value: U }] } });

  eq(await dlv.deliveryCounts(U), { delivered: 3, bounced: 2, complained: 1, delayed: 0 }, "counted once per email, opens ignored, soft bounce counted");
  const left = (await list.listUpdatesSubscribers()).map((x) => x.email);
  ok(!left.includes("bad@example.com"), "a hard bounce comes off the list");
  ok(!left.includes("spam@example.com"), "a spam report comes off the list");
  ok(left.includes("full@example.com"), "a full mailbox stays on it");
  const probs = await dlv.listDeliveryProblems();
  eq(probs.map((p) => [p.email, p.kind, p.removed, p.updateId]), [
    ["stray@example.com", "bounced", false, null],
    ["spam@example.com", "complained", true, U],
    ["bad@example.com", "bounced", true, U],
  ], "the admin sees each hard bounce and spam report, newest first");
  ok(probs[2]!.detail.includes("No such user"), "with Resend's reason");

  // the admin reads it with the sent updates
  g.__testCookies = { [ADMIN_COOKIE]: createAdminSession()! };
  const got = (await (await mailRoute.GET()).json()) as { data: { tracking: boolean; problems: unknown[] } };
  eq([got.data.tracking, got.data.problems.length], [true, 3], "the admin sees tracking on and the problems");

  // the store fails partway through a hard bounce: Resend's retry still takes the address off
  await list.subscribeToUpdates("retry-bounce@example.com", "site");
  const memStore = g.__gloamPartnersMem!;
  const realGet = memStore.get.bind(memStore);
  let broke = false;
  memStore.get = ((k: string) => {
    if (!broke && k.includes(":sub:")) {
      broke = true;
      throw new Error("store down");
    }
    return realGet(k);
  }) as typeof memStore.get;
  const bounce = ev("email.bounced", "em_r", "retry-bounce@example.com", { bounce: { type: "Permanent", message: "No such user" } });
  ok((await call("r1", bounce)).status >= 500, "a failure partway answers 5xx, so Resend tries again");
  memStore.get = realGet as typeof memStore.get;
  eq((await call("r1", bounce)).status, 200, "the retry is taken");
  ok(!(await list.listUpdatesSubscribers()).some((x) => x.email === "retry-bounce@example.com"), "and the address is off the list");
  eq((await dlv.listDeliveryProblems()).filter((p) => p.email === "retry-bounce@example.com").length, 1, "listed once");
  await call("r1", bounce);
  eq((await dlv.listDeliveryProblems()).filter((p) => p.email === "retry-bounce@example.com").length, 1, "a third delivery of the same call changes nothing");

  // an address that bounced for good or marked spam never comes back, by form or by import
  const back1 = await list.subscribeToUpdates("retry-bounce@example.com", "site");
  eq(back1, { added: false, suppressed: true }, "a bounced address can't be signed up again");
  const back2 = await list.subscribeToUpdates("spam@example.com", "contest");
  eq(back2, { added: false, suppressed: true }, "a spam report keeps the import from adding it back");
  g.__testCookies = {};
  delete env.RESEND_WEBHOOK_SECRET;
}

// ============================================================ an update listed twice shows once
resetMemoryKv();
{
  await addSubscribers(3);
  const { update } = await mail.startUpdate("Listed twice", "Body.", clock);
  const mem2 = g.__gloamPartnersMem!;
  const listKey = `${list.UPDATES_PREFIX}mails`;
  mem2.set(listKey, { v: [update.id, ...(mem2.get(listKey)!.v as string[])] } as never);
  eq((await mail.listUpdatesForAdmin()).filter((u) => u.id === update.id).length, 1, "two starts at once list it once for the admin");
}

// ============================================================ the list sources: only the updates list
{
  const src = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../src/lib/updatesMail.ts", import.meta.url)), "utf8");
  ok(!/testers|contest|partners\.ts|partnerAddresses|from "\.\/partners"/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "the sender reads no other list");
  ok(src.includes("UPDATES_IDS") && src.includes("subscriberKey"), "it reads the updates list");
}

console.log(`updates mail: ${n} passed`);
