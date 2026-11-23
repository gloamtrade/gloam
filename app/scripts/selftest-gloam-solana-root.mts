/**
 * Self-test: what opens a Gloam account's private account on Solana
 * (lib/solanaRings/gloamRoot, lib/solanaRings/gloamCodes), never a Turnkey signature.
 *
 *  - passkey: the same passkey (synced to two devices) gives the same PRF output,
 *    so the same seed and the same private account address on both; another
 *    passkey or another account index gives another account; the PRF input is
 *    Solana's own (not the recovery backup's); the prompt is limited to the
 *    passkeys the person signs in with (Turnkey's credential ids); a closed
 *    prompt, a browser without PRF and a refused prompt read in plain words
 *  - backup code: made in the browser, 32 characters with a check; typed on a new
 *    device (any case, spaces, O for 0) it gives back the same secret and the same
 *    private account; a typo or a wrong length is refused
 *  - neither way takes anything from Turnkey: both roots are made on the
 *    person's device (the Gloam account itself signs no message at all:
 *    scripts/selftest-turnkey-solana.mts)
 *  - the code is kept sealed in this browser and never replaced; a recovery backup
 *    keyed by a passkey carries it and brings it back on a new device, one keyed by
 *    a wallet signature (Turnkey's, for a Gloam wallet) never does
 *  - a browser that keeps one code (made there by mistake, or brought in by a
 *    backup) never locks the person out: a code they type opens its own account
 *    and the kept one stays, and the setup card still offers the passkey and
 *    another code
 *
 * Runs the app's own storage and recovery code with an in-memory browser
 * (scripts/browser-shim) and a stand-in /api/recovery and WebAuthn. Nothing
 * leaves the process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-gloam-solana-root.mts
 */
import { localStorage, resetBrowser } from "./browser-shim.mjs";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getAddressDecoder } from "@solana/kit";

const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;

// The stand-in backup service: GET, PUT and DELETE on /api/recovery.
const backups = new Map<string, { c: string; n: number; t: number }>();
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "GET") {
    const id = new URL(String(url), "https://gloam.trade").searchParams.get("id")!;
    const b = backups.get(id);
    return b ? Response.json({ data: b }) : Response.json({ error: { message: "none" } }, { status: 404 });
  }
  const body = JSON.parse(String(init!.body)) as { id: string; c?: string; n?: number };
  if (method === "PUT") {
    const t = Date.now();
    backups.set(body.id, { c: body.c!, n: body.n!, t });
    return Response.json({ data: { n: body.n, t } });
  }
  if (method === "DELETE") {
    backups.delete(body.id);
    return Response.json({ ok: true });
  }
  throw new Error(`unexpected ${method}`);
}) as typeof fetch;

const root = await import("../src/lib/solanaRings/gloamRoot");
const codes = await import("../src/lib/solanaRings/gloamCodes");
const { accountFromSeed } = await import("../src/lib/solanaRings/account");
const recovery = await import("../src/lib/recovery");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const OWNER = getAddressDecoder().decode(new Uint8Array(randomBytes(32)));
const OTHER_OWNER = getAddressDecoder().decode(new Uint8Array(randomBytes(32)));

/** The private account a seed opens (the address someone pays privately). */
async function accountAddress(seed: Uint8Array): Promise<string> {
  return (await accountFromSeed(seed)).toSolanaSigner().address as string;
}

/* ---------------------------------------------------------------- a stand-in passkey */

/**
 * A passkey as WebAuthn's PRF extension gives it: HMAC-SHA256 under the
 * credential's own secret, over SHA-256("WebAuthn PRF" || 0x00 || input). A synced
 * passkey carries the same secret to every device it is on.
 */
type Passkey = { id: Uint8Array; secret: Buffer };
const newPasskey = (): Passkey => ({ id: new Uint8Array(randomBytes(32)), secret: randomBytes(32) });

function webauthn(on: readonly Passkey[], opts: { prf?: boolean; fail?: string; slow?: boolean } = {}) {
  const asked: CredentialRequestOptions[] = [];
  return {
    asked,
    api: {
      async get(options: CredentialRequestOptions) {
        asked.push(options);
        if (opts.fail) throw Object.assign(new Error(opts.fail), { name: opts.fail });
        const pk = options.publicKey!;
        assert.equal(pk.userVerification, "required");
        const allowed = (pk.allowCredentials ?? []).map((c) => Buffer.from(c.id as ArrayBuffer).toString("hex"));
        const pick = on.find((p) => allowed.length === 0 || allowed.includes(Buffer.from(p.id).toString("hex")));
        if (!pick) throw Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" });
        const input = Buffer.from(pk.extensions!.prf!.eval!.first as ArrayBuffer);
        const salt = createHash("sha256").update(Buffer.concat([Buffer.from("WebAuthn PRF"), Buffer.from([0]), input])).digest();
        const out = new Uint8Array(createHmac("sha256", pick.secret).update(salt).digest());
        return {
          id: b64url(pick.id),
          getClientExtensionResults: () => (opts.prf === false ? {} : { prf: { results: { first: out.buffer } } }),
        } as unknown as Credential;
      },
    },
  };
}

/** A clock for the prompt timing: a refusal after `ms`. */
const clock = (ms: number) => {
  let t = 0;
  return () => (t += ms);
};

/* ---------------------------------------------------------------- passkey */

await test("the same passkey opens the same private account on two devices; another passkey or index opens another", async () => {
  const signIn = newPasskey();
  const ids = [b64url(signIn.id)];
  const phone = webauthn([signIn]);
  const laptop = webauthn([signIn]);
  const r1 = await root.passkeyRoot({ rpId: "gloam.trade", credentialIds: ids, credentials: phone.api });
  const r2 = await root.passkeyRoot({ rpId: "gloam.trade", credentialIds: ids, credentials: laptop.api });
  assert.ok(same(r1, r2), "one passkey, one PRF output, on every device");
  const s1 = await root.accountSeedFromRoot(r1, "passkey", 0);
  const s2 = await root.accountSeedFromRoot(r2, "passkey", 0);
  assert.ok(same(s1, s2));
  const a = await accountAddress(s1);
  assert.equal(await accountAddress(s2), a, "the same private account on both");
  // the prompt: this site's rpId, only the passkeys the person signs in with, Solana's own PRF input
  const pk = phone.asked[0]!.publicKey!;
  assert.equal(pk.rpId, "gloam.trade");
  assert.deepEqual((pk.allowCredentials ?? []).map((c) => Buffer.from(c.id as ArrayBuffer).toString("hex")), [Buffer.from(signIn.id).toString("hex")]);
  const input = Buffer.from(pk.extensions!.prf!.eval!.first as ArrayBuffer);
  assert.ok(input.equals(createHash("sha256").update(root.PRF_SALT_TEXT).digest()), "the PRF input is SHA-256 of Solana's own text");
  assert.ok(!input.equals(createHash("sha256").update("gloam/recovery/prf/v1").digest()), "not the recovery backup's");
  // another passkey, another index, another kind: another account
  const other = await root.passkeyRoot({ rpId: "gloam.trade", credentialIds: [], credentials: webauthn([newPasskey()]).api });
  assert.notEqual(await accountAddress(await root.accountSeedFromRoot(other, "passkey", 0)), a);
  assert.notEqual(await accountAddress(await root.accountSeedFromRoot(r1, "passkey", 1)), a, "account 1 is another account");
  assert.ok(!same(await root.accountSeedFromRoot(r1, "code", 0), s1), "the kind is bound into the seed");
  // the derivation itself: HKDF-SHA256, Gloam's salt, kind and index in the info
  const { hkdfSync } = await import("node:crypto");
  const want = new Uint8Array(hkdfSync("sha256", r1, Buffer.from("gloam/solana-account/root/v1"), Buffer.from("passkey/account/0"), 32));
  assert.ok(same(s1, want));
});

await test("Turnkey's credential ids become the prompt's passkeys; ones that don't read leave the choice to the person", () => {
  const id = new Uint8Array(randomBytes(32));
  const list = root.credentialIdsFrom([b64url(id), Buffer.from(id).toString("base64")]);
  assert.equal(list?.length, 2);
  assert.ok(list!.every((x) => same(new Uint8Array(x), id)));
  assert.equal(root.credentialIdsFrom(["not base64!"]), null);
  assert.equal(root.credentialIdsFrom(["AAAA"]), null, "too short to be a credential id");
  assert.deepEqual(root.credentialIdsFrom([]), []);
});

await test("a passkey that can't, or a prompt that closed, says so plainly", async () => {
  const pk = newPasskey();
  const ids = [b64url(pk.id)];
  const cases: [Parameters<typeof webauthn>[1], number, string, RegExp][] = [
    [{ prf: false }, 5000, "unsupported", /can't open a private account in this browser/],
    [{ fail: "NotSupportedError" }, 5000, "unsupported", /can't open a private account in this browser/],
    [{ fail: "NotAllowedError" }, 5000, "cancelled", /prompt was closed/],
    [{ fail: "NotAllowedError" }, 10, "unsupported", /didn't open/],
    [{ fail: "AbortError" }, 5000, "cancelled", /prompt was closed/],
    [{ fail: "SecurityError" }, 5000, "failed", /gloam\.trade/],
    [{ fail: "UnknownError" }, 5000, "failed", /didn't respond/],
  ];
  for (const [opts, ms, code, text] of cases) {
    await assert.rejects(root.passkeyRoot({ rpId: "gloam.trade", credentialIds: ids, credentials: webauthn([pk], opts).api, now: clock(ms) }), (e: Error & { code?: string }) => {
      return e instanceof root.GloamRootError && e.code === code && text.test(e.message);
    });
  }
  // the person's own passkey isn't on this device: nothing to pick, said as a closed prompt
  await assert.rejects(root.passkeyRoot({ rpId: "gloam.trade", credentialIds: ids, credentials: webauthn([newPasskey()]).api, now: clock(5000) }), /prompt was closed/);
});

/* ---------------------------------------------------------------- backup code */

await test("an email sign-in's backup code opens the same private account on a new device", async () => {
  const secret = root.newCodeSecret();
  assert.equal(secret.length, 16);
  const code = await root.backupCodeFor(secret);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/, "32 characters, eight groups, no I, L, O or U");
  const here = await accountAddress(await root.accountSeedFromRoot(secret, "code", 0));
  // a new device: the person types the code they saved, any way they like
  for (const typed of [code, code.toLowerCase(), code.replace(/-/g, " "), code.replace(/-/g, ""), code.replace(/0/g, "O").replace(/1/g, "l")]) {
    const back = await root.secretFromBackupCode(typed);
    assert.ok(back && same(back, secret), typed);
    assert.equal(await accountAddress(await root.accountSeedFromRoot(back!, "code", 0)), here, "the same private account");
  }
  // a typo anywhere is caught by the check, never opened as some other account
  const plain = code.replace(/-/g, "");
  let caught = 0;
  for (let i = 0; i < plain.length; i++) {
    const swapped = plain[i] === "A" ? "B" : "A";
    if ((await root.secretFromBackupCode(plain.slice(0, i) + swapped + plain.slice(i + 1))) === null) caught++;
  }
  assert.equal(caught, plain.length, "every one-character typo is refused");
  for (const bad of ["", plain.slice(1), plain + "0", plain.slice(0, 31) + "U", "hello"]) assert.equal(await root.secretFromBackupCode(bad), null, bad);
  // two codes, two accounts
  assert.notEqual(await accountAddress(await root.accountSeedFromRoot(root.newCodeSecret(), "code", 0)), here);
  await assert.rejects(root.backupCodeFor(new Uint8Array(15)));
});

/* ---------------------------------------------------------------- kept, and in the backup */

await test("the code is kept sealed in this browser, and never replaced", async () => {
  assert.equal(await codes.keptCodeSecret(OWNER), null);
  const first = root.newCodeSecret();
  const kept = await codes.keepCodeSecret(OWNER, first);
  assert.ok(same(kept, first));
  const raw = localStorage.getItem(codes.STORE_KEY)!;
  assert.ok(raw && !raw.includes(Buffer.from(first).toString("hex")), "sealed: the secret isn't in storage as it is");
  // another code for the same account never replaces the one the person saved
  const second = root.newCodeSecret();
  const after = await codes.keepCodeSecret(OWNER, second);
  assert.ok(same(after, first), "the first stays, and is what the caller gets back");
  assert.ok(same((await codes.keptCodeSecret(OWNER))!, first));
  await assert.rejects(codes.keepCodeSecret("not-an-address", first));
  // plain logic
  assert.deepEqual(codes.parseCodes({ [OWNER]: "ab".repeat(16), bad: "ab".repeat(16), [OTHER_OWNER]: "zz" }), { [OWNER]: "ab".repeat(16) });
  assert.deepEqual(codes.mergeCodes({ [OWNER]: "ab".repeat(16) }, [{ owner: OWNER, secret: "cd".repeat(16) }, { owner: OTHER_OWNER, secret: "ef".repeat(16) }]), {
    [OWNER]: "ab".repeat(16),
    [OTHER_OWNER]: "ef".repeat(16),
  });
});

/** What a backup holds, opened with its keys (lib/recovery's format: iv, then AES-GCM over the payload, the id as additional data). */
async function backupPayload(keys: { id: string; key: string }): Promise<{ solana?: { owner: string; secret: string }[] }> {
  const blob = Buffer.from(backups.get(keys.id)!.c, "base64");
  const key = await crypto.subtle.importKey("raw", Buffer.from(keys.key, "base64"), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12), additionalData: new TextEncoder().encode(keys.id) }, key, blob.subarray(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

await test("a passkey backup carries the code and brings it back on a new device; a wallet-signature backup never carries it", async () => {
  const secret = (await codes.keptCodeSecret(OWNER))!;
  const opened = await accountAddress(await root.accountSeedFromRoot(secret, "code", 0));
  // keyed by a wallet signature (for a Gloam wallet, Turnkey's): no code in it
  // version 2 wallet keys name the wallet that signed (version 1 ones no longer save)
  const walletKeys = { ...(await recovery.keysFromSecret("wallet", new Uint8Array(randomBytes(32)))), wallet: "0x1111111111111111111111111111111111111111" };
  await recovery.connectRecovery(walletKeys, null);
  assert.ok(backups.has(walletKeys.id));
  assert.equal((await backupPayload(walletKeys)).solana, undefined, "a wallet-signature backup carries no code");
  await recovery.turnOffRecovery({ deleteBackup: true });
  // keyed by a passkey: the code goes in
  const passkeyKeys = await recovery.keysFromSecret("passkey", new Uint8Array(randomBytes(32)));
  await recovery.connectRecovery(passkeyKeys, null);
  assert.deepEqual((await backupPayload(passkeyKeys)).solana, [{ owner: OWNER, secret: Buffer.from(secret).toString("hex") }]);
  // a new device: nothing kept, then the passkey backup restores it
  resetBrowser();
  assert.equal(await codes.keptCodeSecret(OWNER), null, "a new device keeps nothing");
  await recovery.connectRecovery(passkeyKeys, null, { mustExist: true, save: false });
  const back = await codes.keptCodeSecret(OWNER);
  assert.ok(back && same(back, secret), "the code came back with the backup");
  assert.equal(await accountAddress(await root.accountSeedFromRoot(back!, "code", 0)), opened, "and opens the same private account");
});

await test("a browser that keeps one backup code still opens another the person types, and the passkey", async () => {
  await recovery.turnOffRecovery({ deleteBackup: false }).catch(() => {});
  resetBrowser();
  const owner = getAddressDecoder().decode(new Uint8Array(randomBytes(32)));
  const real = root.newCodeSecret(); // saved on the first device, where the money is
  const made = root.newCodeSecret(); // made on this one by pressing "Make my backup code"
  const realAccount = await accountAddress(await root.accountSeedFromRoot(real, "code", 0));
  assert.ok(same(await codes.codeRootFor(owner, made), made), "a code made here is kept and opens");
  // the person types the code they saved: it opens their account, and the one kept here stays
  const typed = await codes.codeRootFor(owner, real.slice(), true);
  assert.ok(same(typed, real), "a typed code opens as typed, even where another is kept");
  assert.equal(await accountAddress(await root.accountSeedFromRoot(typed, "code", 0)), realAccount, "and opens the account it made");
  assert.ok(same((await codes.keptCodeSecret(owner))!, made), "the kept code is never replaced");
  assert.ok(same(await codes.codeRootFor(owner, null), made), "left to pick, the kept code opens");
  // a code made on a screen from before another was kept is still refused
  await assert.rejects(codes.codeRootFor(owner, root.newCodeSecret()), /another backup code/);
  // the setup card: a kept code opens by default; the passkey and another code stay the person's to pick
  const view = (mode: "auto" | "passkey" | "code-new" | "code-show" | "code-enter", known: boolean, passkey: boolean, returning = true, fresh = false) =>
    root.gloamOpenView({ mode, known, passkey, returning, fresh });
  assert.equal(view("auto", true, true), "kept");
  assert.equal(view("passkey", true, true), "passkey", "the passkey opens even where a code is kept");
  assert.equal(view("code-enter", true, false), "code-enter", "another code can be typed where one is kept");
  assert.equal(view("auto", false, true), "passkey");
  assert.equal(view("auto", false, false, true), "code-enter");
  assert.equal(view("auto", false, false, false), "code-new");
  assert.equal(view("code-show", false, false, false, true), "code-show");
  const card = readFileSync(new URL("../src/components/app/GloamAccountParts.tsx", import.meta.url), "utf8");
  const kept = card.slice(card.indexOf('if (view === "kept")'), card.indexOf('if (view === "code-show"'));
  assert.ok(kept.includes('setMode("passkey")') && kept.includes('setMode("code-enter")'), "the kept-code card links to the passkey and to another code");
  assert.ok(/openWithCode\(secret, true\)/.test(card), "the code the person types opens as typed");
});

console.log(`selftest-gloam-solana-root: ${passed} passed`);
process.exit(0);
