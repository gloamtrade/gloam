/**
 * Reading a Starknet payment channel over JSON-RPC (any Starknet node gives
 * the same answers: the page passes Gloam's read-only proxy, scripts the node
 * itself), and making the disclosure from an open private account: the
 * channels it is in, what each holds, and the maker's signature.
 *
 * Pure reads plus local hashing. The channel keys come from the account's own
 * viewing key, on this device: an incoming channel's key is sealed to it in the
 * pool (ECDH on the Stark curve), an outgoing one is derived from it.
 */
import { ec, hash, num, shortString, Signer, stark, typedData, type RpcProvider } from "starknet";
import {
  channelMarker,
  cleanStarknetLabel,
  readChannel,
  starknetChannelTypedData,
  verifyStarknetChannel,
  type ChannelPayment,
  type StarknetChannelDeps,
  type StarknetChannelProof,
  type StarknetChannelReader,
  type StarknetProofNetwork,
} from "./starknetChannel";

const ENC_NOTE_CREATED = hash.getSelectorFromName("EncNoteCreated");
/** 'VALID', what an account's is_valid_signature answers (older accounts answer 1). */
const VALID = BigInt(shortString.encodeShortString("VALID"));
/** Note ids per event query (a node caps the keys in one filter). */
const IDS_PER_QUERY = 16;
const MAX_EVENT_PAGES = 12;

/** The node's JSON-RPC error code (starknet.js RpcError), or null for a network failure. */
function rpcCode(e: unknown): number | null {
  const c = (e as { code?: unknown; baseError?: { code?: unknown } } | null)?.baseError?.code ?? (e as { code?: unknown } | null)?.code;
  return typeof c === "number" ? c : null;
}
/** Contract not found, contract error, execution error: the account can't vouch. */
const REFUSED = new Set([20, 40, 41]);

export function rpcChannelReader(provider: RpcProvider, pool: string, fromBlock: number): StarknetChannelReader {
  const call = async (entrypoint: string, calldata: bigint[]) =>
    (await provider.callContract({ contractAddress: pool, entrypoint, calldata: calldata.map((x) => num.toHex(x)) })).map((x) => BigInt(x));
  return {
    publicKey: async (user) => (await call("get_public_key", [user]))[0] ?? 0n,
    channelExists: async (marker) => ((await call("channel_exists", [marker]))[0] ?? 0n) !== 0n,
    subchannelInfo: async (id) => {
      const [salt = 0n, encToken = 0n] = await call("get_subchannel_info", [id]);
      return { salt, encToken };
    },
    subchannelExists: async (marker) => ((await call("subchannel_exists", [marker]))[0] ?? 0n) !== 0n,
    note: async (id) => ({ packed: (await call("get_note", [id]))[0] ?? 0n }),
    noteEvents: async (ids) => {
      const found = new Map<bigint, { block: number; tx: string }>();
      const want = new Set(ids);
      for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
        const batch = ids.slice(i, i + IDS_PER_QUERY).map((x) => num.toHex(x));
        let token: string | undefined;
        let pages = 0;
        do {
          const r = await provider.getEvents({
            address: pool,
            from_block: { block_number: fromBlock },
            to_block: "latest",
            keys: [[ENC_NOTE_CREATED], batch],
            chunk_size: 1000,
            ...(token ? { continuation_token: token } : {}),
          });
          for (const e of r.events) {
            const id = BigInt(e.keys[1] ?? "0x0");
            if (BigInt(e.from_address) === BigInt(pool) && want.has(id) && typeof e.block_number === "number") {
              found.set(id, { block: e.block_number, tx: e.transaction_hash });
            }
          }
          token = r.continuation_token;
          pages++;
        } while (token && pages < MAX_EVENT_PAGES);
      }
      const times = new Map<number, number>();
      for (const block of new Set([...found.values()].map((x) => x.block))) {
        const b = (await provider.getBlockWithTxHashes(block)) as { timestamp?: number };
        if (typeof b.timestamp === "number") times.set(block, b.timestamp);
      }
      const out = new Map<bigint, { at: number; tx: string }>();
      for (const [id, x] of found) {
        const at = times.get(x.block);
        if (at !== undefined) out.set(id, { at, tx: x.tx });
      }
      return out;
    },
    isValidSignature: async (account, h, signature) => {
      try {
        const r = await provider.callContract({
          contractAddress: num.toHex(account),
          entrypoint: "is_valid_signature",
          calldata: [h, num.toHex(signature.length), ...signature],
        });
        const v = BigInt(r[0] ?? "0x0");
        return v === VALID || v === 1n;
      } catch (e) {
        if (REFUSED.has(rpcCode(e) ?? -1)) return false;
        throw e;
      }
    },
  };
}

/** The checks' outside world for one network this page reads. */
export function channelDeps(input: {
  network: StarknetProofNetwork;
  provider: RpcProvider;
  pool: string | null;
  chainId: string;
  fromBlock: number;
}): StarknetChannelDeps {
  const reader = input.pool ? rpcChannelReader(input.provider, input.pool, input.fromBlock) : null;
  return {
    reader: (n) => (n === input.network ? reader : null),
    pool: (n) => (n === input.network ? input.pool : null),
    chainId: () => input.chainId,
    messageHash: (td, account) => typedData.getMessageHash(td as never, account),
  };
}

/* ---------- the maker's side ---------- */

const P = ec.starkCurve.CURVE.Fp.ORDER;
const tag = (t: string) => BigInt(shortString.encodeShortString(t));
const H = (...v: bigint[]) => ec.starkCurve.poseidonHashMany(v);
const sub = (a: bigint, b: bigint) => (((a - b) % P) + P) % P;

/** The x coordinate of `secret` times the curve point whose x is `x` (either y gives the same x). */
function sharedX(secret: bigint, x: bigint): bigint {
  const Fp = ec.starkCurve.CURVE.Fp;
  const y2 = Fp.add(Fp.add(Fp.mul(Fp.mul(x, x), x), Fp.mul(ec.starkCurve.CURVE.a, x)), ec.starkCurve.CURVE.b);
  const y = Fp.sqrt(y2);
  const point = ec.starkCurve.ProjectivePoint.fromAffine({ x, y });
  return point.multiply(secret).toAffine().x;
}

export type ChannelRef = {
  /** "received": payments to this account; "sent": payments it made. */
  side: "received" | "sent";
  sender: string;
  recipient: string;
  channelKey: bigint;
  recipientKey: bigint;
};

export type ChannelMaker = {
  address: string;
  viewingKey: bigint;
  accountKey: bigint;
  network: StarknetProofNetwork;
  provider: RpcProvider;
  pool: string;
  chainId: string;
  fromBlock: number;
};

const MAX_CHANNELS = 64;

/** Every channel this account is in with another account, checked against the pool's marker. */
export async function listChannels(m: ChannelMaker): Promise<ChannelRef[]> {
  const call = async (entrypoint: string, calldata: bigint[]) =>
    (await m.provider.callContract({ contractAddress: m.pool, entrypoint, calldata: calldata.map((x) => num.toHex(x)) })).map((x) => BigInt(x));
  const me = BigInt(m.address);
  const vk = m.viewingKey;
  const myKey = (await call("get_public_key", [me]))[0] ?? 0n;
  const out: ChannelRef[] = [];
  const exists = async (ck: bigint, s: bigint, r: bigint, rpk: bigint) => ((await call("channel_exists", [channelMarker(ck, s, r, rpk)]))[0] ?? 0n) !== 0n;

  // To this account: each channel's key and sender, sealed to its viewing key.
  const incoming = Number((await call("get_num_of_channels", [me]))[0] ?? 0n);
  for (let c = 0; c < Math.min(incoming, MAX_CHANNELS); c++) {
    const [eph = 0n, encKey = 0n, encSender = 0n] = await call("get_channel_info", [me, BigInt(c)]);
    if (eph === 0n) continue;
    const x = sharedX(vk, eph);
    const ck = sub(encKey, H(tag("ENC_CHANNEL_KEY_TAG:V1"), x));
    const sender = sub(encSender, H(tag("ENC_SENDER_ADDR_TAG:V1"), x));
    if (sender === me || !(await exists(ck, sender, me, myKey))) continue;
    out.push({ side: "received", sender: num.toHex(sender), recipient: num.toHex(me), channelKey: ck, recipientKey: myKey });
  }

  // From this account: its outgoing channels, in order, each recipient sealed with its own key.
  for (let s = 0; s < MAX_CHANNELS; s++) {
    const id = H(tag("OUTGOING_CHANNEL_ID_TAG:V1"), me, vk, BigInt(s), 0n);
    const [salt = 0n, encRecipient = 0n] = await call("get_outgoing_channel_info", [id]);
    if (salt === 0n) break;
    const recipient = sub(encRecipient, H(tag("ENC_RECIPIENT_ADDR_TAG:V1"), me, vk, BigInt(s), 0n, salt));
    if (recipient === me) continue;
    const rpk = (await call("get_public_key", [recipient]))[0] ?? 0n;
    const ck = H(tag("CHANNEL_KEY_TAG:V1"), me, vk, recipient, rpk);
    if (rpk === 0n || !(await exists(ck, me, recipient, rpk))) continue;
    out.push({ side: "sent", sender: num.toHex(me), recipient: num.toHex(recipient), channelKey: ck, recipientKey: rpk });
  }
  return out;
}

/** What a channel holds now, as a reader would read it (the screen shows it before anything is shared). */
export async function previewChannel(m: ChannelMaker, ref: ChannelRef): Promise<{ payments: ChannelPayment[]; outside: number }> {
  const r = rpcChannelReader(m.provider, m.pool, m.fromBlock);
  const { payments, outside } = await readChannel(r, ref.channelKey, BigInt(ref.recipient), ref.recipientKey);
  return { payments, outside };
}

/** The signed disclosure of one channel for `verifier` until `expiresAt`, checked the way a reader will. */
export async function makeChannelProof(m: ChannelMaker, ref: ChannelRef, verifier: string, expiresAt: number): Promise<StarknetChannelProof> {
  const label = cleanStarknetLabel(verifier);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Pick an expiry in the future.");
  const unsigned: Omit<StarknetChannelProof, "signature"> = {
    v: 1,
    kind: "starknet-channel",
    network: m.network,
    pool: num.toHex(BigInt(m.pool)),
    sender: num.toHex(BigInt(ref.sender)),
    recipient: num.toHex(BigInt(ref.recipient)),
    channelKey: num.toHex(ref.channelKey),
    by: ref.side === "received" ? "recipient" : "sender",
    verifier: label,
    expiresAt,
  };
  const td = starknetChannelTypedData(unsigned, m.chainId);
  const sig = await new Signer(num.toHex(m.accountKey)).signMessage(td as never, m.address);
  const signature = stark.formatSignature(sig).map((x) => num.toHex(BigInt(x)));
  const proof: StarknetChannelProof = { ...unsigned, signature };
  const r = await verifyStarknetChannel(proof, channelDeps({ network: m.network, provider: m.provider, pool: m.pool, chainId: m.chainId, fromBlock: m.fromBlock }));
  const bad = r.checks.find((c) => c.state !== "pass");
  if (bad) throw new Error(bad.detail ?? "This can't be shared yet.");
  return proof;
}
