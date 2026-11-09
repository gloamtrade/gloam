/**
 * TIP-403 transfer policies on Tempo (browser and server, read-only).
 *
 * Every TIP-20 stablecoin on Tempo points at a policy in the TIP-403 registry
 * precompile. On each transfer the token asks the registry whether the sender
 * and the recipient are authorized, and reverts with PolicyForbids if not.
 * Policy 0 rejects everyone, policy 1 allows everyone, and custom policies
 * (id 2 and up) are an issuer's allowlist, blocklist, or (TIP-1015) a compound
 * policy with separate sender and recipient lists.
 *
 * A Gloam deposit is a TIP-20 transfer from the user to the vault, and a cash
 * out is a transfer from the vault to a public address. Those are the only two
 * places value moves, so Gloam checks the issuer's policy at exactly those two
 * edges, before the user signs or the relay submits:
 *
 *   deposit:  the wallet may send, and the vault may receive
 *   cash out: the vault may send, and the recipient may receive
 *
 * The token enforces the same rule on-chain no matter what, so this check is an
 * early, clear stop, not the guarantee. If the RPC cannot be reached, callers
 * fail open and the chain still decides.
 *
 * A recipient's own receive policy (TIP-1028) is different: a payment it refuses
 * does not revert. Tempo holds it, and only the sender can claim it back, which
 * for a cash out is the vault or a swap router, and neither can. So the receive
 * policy must answer before anything is paid out: checkReceivePolicy throws
 * when it can't be read, and the relay refuses the send then.
 *
 * Everything here is eth_call only, through an injected reader, so it can be
 * tested without a network. See tip403Server.ts for the wired-up version.
 */
import type { Abi, Address } from "viem";
import { SCREEN_BLOCKED_MESSAGE } from "./screening";

/** TIP-403 policy registry precompile (tempo-std StdPrecompiles). */
export const TIP403_REGISTRY: Address = "0x403c000000000000000000000000000000000000";
/** TIP-1022 address registry precompile, which resolves virtual addresses. */
export const TEMPO_ADDRESS_REGISTRY: Address = "0xfDC0000000000000000000000000000000000000";
/**
 * Chains whose stablecoins carry TIP-403 policies: Tempo Moderato and Tempo
 * mainnet (pathUSD, USDT0 and OUSD carry custom issuer policies there). The
 * server only checks a chain Gloam runs on (tip403Server), so mainnet joins
 * once its pool is filled in.
 */
export const TIP403_CHAIN_IDS: readonly number[] = [42431, 4217];

export const ALWAYS_REJECT_POLICY_ID = 0n;
export const ALWAYS_ALLOW_POLICY_ID = 1n;

/** Which public edge of the vault a check is for. */
export type Tip403Flow = "deposit" | "cashout";
export type Tip403Role = "sender" | "recipient";
export type Tip403PolicyKind =
  | "always-allow"
  | "always-reject"
  | "allowlist"
  | "blocklist"
  | "compound"
  | "unknown";

export const tip20PolicyAbi = [
  { type: "function", name: "transferPolicyId", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const tip403RegistryAbi = [
  {
    type: "function",
    name: "policyData",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "uint64" }],
    outputs: [
      { name: "policyType", type: "uint8" },
      { name: "admin", type: "address" },
    ],
  },
  {
    type: "function",
    name: "isAuthorized",
    stateMutability: "view",
    inputs: [
      { name: "policyId", type: "uint64" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isAuthorizedSender",
    stateMutability: "view",
    inputs: [
      { name: "policyId", type: "uint64" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isAuthorizedRecipient",
    stateMutability: "view",
    inputs: [
      { name: "policyId", type: "uint64" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "validateReceivePolicy",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "authorized", type: "bool" },
      { name: "blockedReason", type: "uint8" },
    ],
  },
] as const;

export const addressRegistryAbi = [
  {
    type: "function",
    name: "resolveRecipient",
    stateMutability: "view",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ name: "effectiveRecipient", type: "address" }],
  },
] as const;

/** One eth_call. viem's PublicClient fits once wrapped (see tip403Server.ts). */
export type Tip403Call = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
};
export interface Tip403Reader {
  readContract(call: Tip403Call): Promise<unknown>;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
// TIP-20 tokens live at 0x20C0 followed by 10 zero bytes, then 8 derived bytes.
const TIP20_PREFIX = "0x20c000000000000000000000";
// TIP-1022 virtual addresses carry ten 0xFD bytes at byte offset 4.
const VIRTUAL_MAGIC = "fd".repeat(10);

export function isTip403Chain(chainId: unknown): boolean {
  return typeof chainId === "number" && TIP403_CHAIN_IDS.includes(chainId);
}

/** True for an address in the TIP-20 range (prefix only, not proof the token exists). */
export function isTip20Address(value: unknown): value is Address {
  return typeof value === "string" && EVM.test(value) && value.toLowerCase().startsWith(TIP20_PREFIX);
}

/** True for a TIP-1022 virtual address, which TIP-20 forwards to its master wallet. */
export function isVirtualAddress(value: unknown): boolean {
  return typeof value === "string" && EVM.test(value) && value.slice(10, 30).toLowerCase() === VIRTUAL_MAGIC;
}

export type Tip403Policy = {
  policyId: bigint;
  kind: Tip403PolicyKind;
  /** An issuer-paused token moves for no one. */
  paused: boolean;
};

/** The token's effective policy (TIP-20 transferPolicyId), its kind, and whether it is paused. */
export async function readTokenPolicy(reader: Tip403Reader, token: Address): Promise<Tip403Policy> {
  const [policyId, paused] = await Promise.all([
    reader.readContract({ address: token, abi: tip20PolicyAbi, functionName: "transferPolicyId" }) as Promise<bigint>,
    // Older tokens without paused() are treated as not paused.
    reader
      .readContract({ address: token, abi: tip20PolicyAbi, functionName: "paused" })
      .then((v) => v === true)
      .catch(() => false),
  ]);
  const id = BigInt(policyId);
  let kind: Tip403PolicyKind;
  if (id === ALWAYS_REJECT_POLICY_ID) kind = "always-reject";
  else if (id === ALWAYS_ALLOW_POLICY_ID) kind = "always-allow";
  else {
    try {
      const data = (await reader.readContract({
        address: TIP403_REGISTRY,
        abi: tip403RegistryAbi,
        functionName: "policyData",
        args: [id],
      })) as readonly [number, Address];
      const t = Number(data[0]);
      kind = t === 0 ? "allowlist" : t === 1 ? "blocklist" : t === 2 ? "compound" : "unknown";
    } catch {
      kind = "unknown";
    }
  }
  return { policyId: id, kind, paused };
}

/**
 * Whether `user` may act as `role` under `policyId`. Uses the directional
 * TIP-1015 calls (which understand compound policies) and falls back to the
 * original isAuthorized on chains that predate them. Throws if neither answers.
 */
export async function isAuthorizedAs(
  reader: Tip403Reader,
  policyId: bigint,
  user: Address,
  role: Tip403Role
): Promise<boolean> {
  if (policyId === ALWAYS_REJECT_POLICY_ID) return false;
  if (policyId === ALWAYS_ALLOW_POLICY_ID) return true;
  try {
    const v = await reader.readContract({
      address: TIP403_REGISTRY,
      abi: tip403RegistryAbi,
      functionName: role === "sender" ? "isAuthorizedSender" : "isAuthorizedRecipient",
      args: [policyId, user],
    });
    return v === true;
  } catch {
    const v = await reader.readContract({
      address: TIP403_REGISTRY,
      abi: tip403RegistryAbi,
      functionName: "isAuthorized",
      args: [policyId, user],
    });
    return v === true;
  }
}

/** A recipient as the token will see it: virtual addresses resolve to their master. */
async function effectiveRecipient(reader: Tip403Reader, to: Address): Promise<Address> {
  if (!isVirtualAddress(to)) return to;
  try {
    return (await reader.readContract({
      address: TEMPO_ADDRESS_REGISTRY,
      abi: addressRegistryAbi,
      functionName: "resolveRecipient",
      args: [to],
    })) as Address;
  } catch {
    return to;
  }
}

/** What a stablecoin's issuer policy says about the Gloam vault itself. */
export type Tip403AssetStatus = {
  chainId: number;
  token: Address;
  /** Decimal string, so the status survives JSON. */
  policyId: string;
  kind: Tip403PolicyKind;
  paused: boolean;
  pool: Address;
  /** The vault may receive this token (deposits work). */
  poolCanReceive: boolean;
  /** The vault may send this token (cash outs work). */
  poolCanSend: boolean;
};

export async function readAssetStatus(
  reader: Tip403Reader,
  chainId: number,
  token: Address,
  pool: Address
): Promise<Tip403AssetStatus> {
  const policy = await readTokenPolicy(reader, token);
  const [poolCanReceive, poolCanSend] = await Promise.all([
    isAuthorizedAs(reader, policy.policyId, pool, "recipient"),
    isAuthorizedAs(reader, policy.policyId, pool, "sender"),
  ]);
  return {
    chainId,
    token,
    policyId: policy.policyId.toString(),
    kind: policy.kind,
    paused: policy.paused,
    pool,
    poolCanReceive,
    poolCanSend,
  };
}

export const TIP403_PAUSED_MESSAGE =
  "The issuer has paused this stablecoin, so it can't be added or cashed out right now.";
export const TIP403_POOL_RECEIVE_MESSAGE =
  "This stablecoin's issuer doesn't allow the Gloam vault to receive it right now, so it can't be added.";
export const TIP403_POOL_SEND_MESSAGE =
  "This stablecoin's issuer is blocking transfers out of the Gloam vault right now, so it can't be cashed out. Balances stay in the vault until the issuer allows it again.";
export const TIP403_RECEIVE_POLICY_MESSAGE =
  "The receiving wallet's Tempo receive policy doesn't accept payments from Gloam, so this cash out would be held instead of arriving. Change that policy or cash out to another wallet.";
export const TIP403_RECEIVE_UNCHECKED_MESSAGE =
  "Couldn't read the receiving wallet's Tempo receive policy, so nothing was sent. Try again shortly.";

/**
 * The warning for the vault itself, if the issuer's policy (or a pause) would
 * stop this flow. With no flow, either direction counts. Null when clear.
 */
export function poolNotice(status: Tip403AssetStatus, flow?: Tip403Flow): string | null {
  if (status.paused) return TIP403_PAUSED_MESSAGE;
  if (flow !== "cashout" && !status.poolCanReceive) return TIP403_POOL_RECEIVE_MESSAGE;
  if (flow !== "deposit" && !status.poolCanSend) return TIP403_POOL_SEND_MESSAGE;
  return null;
}

export type Tip403Verdict =
  | { allowed: true }
  | {
      allowed: false;
      /**
       * pool: the issuer's policy stops the vault. wallet: it stops this address.
       * receive: the recipient's own TIP-1028 policy. unchecked: that policy could not be read.
       */
      reason: "pool" | "wallet" | "receive" | "unchecked";
      message: string;
    };

/**
 * TIP-1028: whether each recipient's own receive policy accepts `token` from
 * `sender`, the contract that pays it out. A virtual address is checked as the
 * wallet it forwards to. Throws when any of it can't be read, a virtual address
 * that can't be resolved included: a payment the policy refuses is held, not
 * reverted, so a caller that pays out refuses then.
 */
export async function checkReceivePolicy(
  reader: Tip403Reader,
  token: Address,
  sender: Address,
  addresses: readonly Address[]
): Promise<Tip403Verdict> {
  const accepted = await Promise.all(
    addresses.map(async (a) => {
      const to = isVirtualAddress(a)
        ? ((await reader.readContract({
            address: TEMPO_ADDRESS_REGISTRY,
            abi: addressRegistryAbi,
            functionName: "resolveRecipient",
            args: [a],
          })) as Address)
        : a;
      const [authorized] = (await reader.readContract({
        address: TIP403_REGISTRY,
        abi: tip403RegistryAbi,
        functionName: "validateReceivePolicy",
        args: [token, sender, to],
      })) as readonly [boolean, number];
      return authorized === true;
    })
  );
  if (accepted.some((ok) => !ok)) return { allowed: false, reason: "receive", message: TIP403_RECEIVE_POLICY_MESSAGE };
  return { allowed: true };
}

/**
 * Check public addresses against a stablecoin's TIP-403 policy for one edge of
 * the vault. On deposit each address must be an authorized sender; on cash out
 * an authorized recipient, and unless `receive` is false its own TIP-1028
 * receive policy must accept `sender` (the vault unless set: a swap's exit pays
 * from its escrow); with no flow, both. A wallet the issuer blocks gets the
 * same neutral line as sanctions screening. Throws on RPC failure; callers
 * decide, and refuse a payout whose receive policy could not be read.
 */
export async function checkTip403(input: {
  reader: Tip403Reader;
  status: Tip403AssetStatus;
  addresses: readonly Address[];
  flow?: Tip403Flow;
  sender?: Address;
  receive?: boolean;
}): Promise<Tip403Verdict> {
  const { reader, status, addresses, flow } = input;
  const notice = poolNotice(status, flow);
  if (notice) return { allowed: false, reason: "pool", message: notice };

  const policyId = BigInt(status.policyId);
  const roles: Tip403Role[] =
    flow === "deposit" ? ["sender"] : flow === "cashout" ? ["recipient"] : ["sender", "recipient"];
  const results = await Promise.all(
    addresses.flatMap((a) =>
      roles.map(async (role) =>
        isAuthorizedAs(reader, policyId, role === "recipient" ? await effectiveRecipient(reader, a) : a, role)
      )
    )
  );
  if (results.some((ok) => !ok)) {
    return { allowed: false, reason: "wallet", message: SCREEN_BLOCKED_MESSAGE };
  }

  if (flow === "cashout" && input.receive !== false) {
    // TIP-1028: a recipient can refuse senders itself; the payment would then be
    // held by Tempo's receive-policy guard rather than arrive.
    return checkReceivePolicy(reader, status.token, input.sender ?? status.pool, addresses);
  }
  return { allowed: true };
}

/** One short label for the explorer card: how open the issuer's policy is. */
export function policyLabel(status: Pick<Tip403AssetStatus, "kind" | "paused">): string {
  if (status.paused) return "Paused by issuer";
  switch (status.kind) {
    case "always-allow":
      return "Open to all";
    case "always-reject":
      return "Closed to all";
    case "allowlist":
      return "Allowlist";
    case "blocklist":
      return "Blocklist";
    case "compound":
      return "Sender and recipient lists";
    default:
      return "Issuer set";
  }
}
