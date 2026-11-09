"use client";

import { useState, type FormEvent } from "react";
import { portal, PortalError, type KeyView } from "./client";
import { ago, Card, CopyButton, fullDate, Notice } from "./ui";

type Reveal = { name: string; secret: string; rotated: boolean };

function SecretReveal({ reveal, onDone }: { reveal: Reveal; onDone: () => void }) {
  return (
    <div className="gl-card border-foreground/20 p-5 sm:p-6" role="status">
      <p className="text-[15px] text-foreground">
        {reveal.rotated ? `New secret for "${reveal.name}"` : `Your new key, "${reveal.name}"`}
      </p>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-mute">
        Copy it now and keep it on your server. This is the only time it is shown; Gloam keeps a fingerprint of it, not the key.
        {reveal.rotated ? " The old secret has already stopped working." : ""}
      </p>
      <div className="mt-4 flex min-w-0 items-center gap-1 rounded-xl bg-surface py-1 pl-4 pr-1">
        <span data-testid="key-secret" className="tnum min-w-0 flex-1 select-all py-2 text-[13.5px] leading-snug text-foreground [overflow-wrap:anywhere]">
          {reveal.secret}
        </span>
        <CopyButton text={reveal.secret} label="Copy key" />
      </div>
      <button type="button" onClick={onDone} className="btn btn-ink btn-sm mt-4">
        I saved it
      </button>
    </div>
  );
}

function KeyRow({ k, onChanged, onReveal }: { k: KeyView; onChanged: () => void; onReveal: (r: Reveal) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(k.name);
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const revoked = k.revokedAt !== null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof PortalError ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`px-5 py-4 sm:px-6 ${revoked ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await portal(`/keys/${k.id}`, { method: "PATCH", body: { name } });
                  setEditing(false);
                  onChanged();
                });
              }}
            >
              <input
                aria-label="Key name"
                className="gl-input h-10 max-w-[260px] text-[14px]"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <button type="submit" disabled={busy || !name.trim()} className="btn btn-ink btn-sm">
                Save
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => (setEditing(false), setName(k.name))}>
                Cancel
              </button>
            </form>
          ) : (
            <p className="flex min-w-0 items-center gap-2 text-[15px] text-foreground">
              <span className="truncate">{k.name}</span>
              <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11.5px] text-mute">
                {k.env === "test" ? "Testnet" : "Mainnet"}
              </span>
              {revoked && <span className="shrink-0 rounded-full bg-danger-soft px-2 py-0.5 text-[11.5px] text-danger">Revoked</span>}
            </p>
          )}
          <p className="tnum mt-1 truncate text-[13px] text-mute">{k.display}</p>
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-x-6 text-[12.5px] max-sm:w-full sm:w-[240px]">
          <div>
            <dt className="text-faint">Made</dt>
            <dd className="text-soft" title={fullDate(k.createdAt)}>
              {ago(k.rotatedAt ?? k.createdAt)}
              {k.rotatedAt ? ", rotated" : ""}
            </dd>
          </div>
          <div>
            <dt className="text-faint">Last used</dt>
            <dd className="text-soft">{revoked ? `revoked ${ago(k.revokedAt)}` : ago(k.lastUsedAt)}</dd>
          </div>
        </dl>
        {!revoked && !editing && (
          <div className="flex shrink-0 items-center gap-1 max-sm:-ml-3 max-sm:w-full sm:w-[252px] sm:justify-end">
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(true)}>
              Rename
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm("rotate")}>
              Rotate
            </button>
            <button type="button" className="btn btn-quiet btn-sm text-danger" onClick={() => setConfirm("revoke")}>
              Revoke
            </button>
          </div>
        )}
      </div>

      {confirm && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13.5px] leading-relaxed text-soft">
            {confirm === "rotate"
              ? "Rotate makes a new secret for this key. The current secret stops working at once, so update your server first."
              : "Revoke stops this key for good. Requests with it will fail straight away."}
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(null)}>
              Keep it
            </button>
            <button
              type="button"
              disabled={busy}
              className={`btn btn-sm ${confirm === "revoke" ? "btn-danger" : "btn-ink"}`}
              onClick={() =>
                void run(async () => {
                  if (confirm === "rotate") {
                    const r = await portal<{ secret: string; key: KeyView }>(`/keys/${k.id}/rotate`, { method: "POST", body: {} });
                    onReveal({ name: r.key.name, secret: r.secret, rotated: true });
                  } else {
                    await portal(`/keys/${k.id}`, { method: "DELETE", body: {} });
                  }
                  setConfirm(null);
                  onChanged();
                })
              }
            >
              {busy ? "Working…" : confirm === "rotate" ? "Rotate key" : "Revoke key"}
            </button>
          </div>
        </div>
      )}
      {err && (
        <div className="mt-3">
          <Notice tone="danger">{err}</Notice>
        </div>
      )}
    </li>
  );
}

export function KeysPanel({
  keys,
  maxActive,
  liveKeys,
  onChanged,
}: {
  keys: KeyView[] | null;
  maxActive: number;
  liveKeys: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const active = (keys ?? []).filter((k) => k.revokedAt === null).length;

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Once Gloam runs on a mainnet the form has a live key button (first, so Enter makes one) and a test key button.
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const env = liveKeys && submitter?.value !== "test" ? "live" : "test";
    setBusy(true);
    setErr(null);
    try {
      const r = await portal<{ secret: string; key: KeyView }>("/keys", { method: "POST", body: { name: name.trim() || "Server", env } });
      setReveal({ name: r.key.name, secret: r.secret, rotated: false });
      setName("");
      onChanged();
    } catch (e) {
      setErr(e instanceof PortalError ? e.message : "Could not make a key. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {reveal && <SecretReveal reveal={reveal} onDone={() => setReveal(null)} />}

      <Card title="Make a key" action={<span className="tnum text-[12.5px] text-mute">{active} of {maxActive} active</span>}>
        <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="key-name" className="block text-[13px] text-mute">
              Name it for where it will live
            </label>
            <input
              id="key-name"
              className="gl-input mt-2"
              placeholder="Production server"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {liveKeys ? (
            <div className="flex shrink-0 flex-wrap gap-2">
              <button type="submit" value="live" disabled={busy || active >= maxActive} className="btn btn-ink btn-lg">
                {busy ? "Making…" : "Make a live key"}
              </button>
              <button type="submit" value="test" disabled={busy || active >= maxActive} className="btn btn-quiet btn-lg">
                Make a test key
              </button>
            </div>
          ) : (
            <button type="submit" disabled={busy || active >= maxActive} className="btn btn-ink btn-lg shrink-0">
              {busy ? "Making…" : "Make a test key"}
            </button>
          )}
        </form>
        <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
          {liveKeys
            ? "Live keys (gloam_live_) work on mainnet. Test keys (gloam_test_) work on the testnets."
            : "Test keys (gloam_test_) work on the testnets. Live keys (gloam_live_) open when Gloam launches on mainnet."}{" "}
          Keep keys on your server; the API does not answer browsers on other sites.
        </p>
        {err && (
          <div className="mt-3">
            <Notice tone="danger">{err}</Notice>
          </div>
        )}
      </Card>

      <Card title="Your keys" flush>
        {keys === null ? (
          <div className="h-[120px] motion-safe:animate-pulse" aria-busy="true" />
        ) : keys.length === 0 ? (
          <p className="px-5 py-10 text-center text-[14px] text-mute sm:px-6">No keys yet. Make one above.</p>
        ) : (
          <ul className="divide-y divide-line">
            {keys.map((k) => (
              <KeyRow key={k.id} k={k} onChanged={onChanged} onReveal={setReveal} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
