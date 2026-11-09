/**
 * The agent's wallet, behind the previews.
 *
 * The engine signs through a CallSender. This one passes calls on to the kit's
 * own wallet only while an approved preview is running, and only the calls
 * that preview named: for a deposit, an approve of the vault for exactly the
 * amount (or a reset to 0 first, where the token needs it) and one shieldBound
 * of exactly that asset and amount; for a cash out sent from the wallet, an
 * unshield of exactly that asset, amount and recipient. Anything else, or
 * anything outside a preview, is refused before it reaches the wallet, as a
 * NotSentError, so the engine knows nothing went out.
 *
 * onSign, when given, sees each batch decoded and can still say no: a kit with
 * its own approval screen shows the exact calls there.
 */
import { decodeFunctionData, isAddressEqual, type Address, type Hex } from "viem";
import { NotSentError, type Call, type CallSender } from "@gloamtrade/game-plugin-gloam/engine";

const ABIS = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "shieldBound",
    stateMutability: "payable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "commitments", type: "bytes32[2]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "unshield",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "postMemo", stateMutability: "nonpayable", inputs: [{ name: "paymentCommitment", type: "bytes32" }, { name: "memo", type: "bytes" }], outputs: [] },
] as const;

/** A call as the wallet will sign it, decoded. Proofs and sealed messages are shortened; they are not secrets. */
export interface DecodedCall {
  to: Address;
  fn: "approve" | "shieldBound" | "transfer" | "unshield" | "postMemo";
  args: Record<string, string>;
  value: string;
  data: Hex;
}

/** What one running preview lets the wallet sign. */
export type Expectation =
  | { kind: "shield"; pool: Address; asset: Address; amountWei: bigint; native: boolean }
  | { kind: "private"; pool: Address; board: Address | null; cashOut?: { asset: Address; to: Address; amountWei: bigint } }
  | { kind: "none" };

export type SignHook = (calls: DecodedCall[], context: { previewId: string | null; action: string }) => boolean | Promise<boolean>;

function decode(call: Call): DecodedCall {
  let d;
  try {
    d = decodeFunctionData({ abi: ABIS, data: call.data });
  } catch {
    throw new NotSentError(`A call to ${call.to} is not one a Gloam action makes. Nothing was signed.`);
  }
  const names = ABIS.find((a) => a.name === d.functionName)!.inputs.map((i) => i.name);
  const args: Record<string, string> = {};
  (d.args ?? []).forEach((v, i) => {
    const s = Array.isArray(v) ? `[${v.join(", ")}]` : String(v);
    args[names[i]!] = s.length > 80 ? `${s.slice(0, 34)}…${s.slice(-10)}` : s;
  });
  return { to: call.to, fn: d.functionName, args, value: (call.value ?? 0n).toString(), data: call.data };
}

/** Why `calls` are not what `e` allows, or null when they are. */
export function callsProblem(e: Expectation, calls: Call[]): string | null {
  if (!calls.length) return "No calls.";
  if (e.kind === "none") return "This action signs nothing with the wallet.";
  const decoded = calls.map((c) => ({ c, d: decodeFunctionData({ abi: ABIS, data: c.data }) }));
  if (e.kind === "shield") {
    const last = decoded[decoded.length - 1]!;
    for (const { c, d } of decoded.slice(0, -1)) {
      if (d.functionName !== "approve") return `Only approvals may come before the deposit, not ${d.functionName}.`;
      if (!isAddressEqual(c.to, e.asset)) return `The approval is on ${c.to}, not on the asset previewed (${e.asset}).`;
      const [spender, amt] = d.args as readonly [Address, bigint];
      if (!isAddressEqual(spender, e.pool)) return `The approval is for ${spender}, not the vault.`;
      if (amt !== e.amountWei && amt !== 0n) return `The approval is for ${amt}, not the ${e.amountWei} previewed.`;
      if ((c.value ?? 0n) !== 0n) return "An approval carries no value.";
    }
    if (last.d.functionName !== "shieldBound") return `The last call is ${last.d.functionName}, not the deposit.`;
    if (!isAddressEqual(last.c.to, e.pool)) return `The deposit goes to ${last.c.to}, not the vault.`;
    const [a, amt] = last.d.args as unknown as readonly [Address, bigint];
    if (!isAddressEqual(a, e.asset) || amt !== e.amountWei) return "The deposit is not the asset and amount previewed.";
    if ((last.c.value ?? 0n) !== (e.native ? e.amountWei : 0n)) return "The deposit carries a value other than the one previewed.";
    return null;
  }
  for (const { c, d } of decoded) {
    if (d.functionName === "transfer" && isAddressEqual(c.to, e.pool)) continue;
    if (d.functionName === "postMemo" && e.board && isAddressEqual(c.to, e.board)) continue;
    if (d.functionName === "unshield" && isAddressEqual(c.to, e.pool) && e.cashOut) {
      const [, , , a, to, amt] = d.args as readonly [Hex, Hex, Hex, Address, Address, bigint];
      if (isAddressEqual(a, e.cashOut.asset) && isAddressEqual(to, e.cashOut.to) && amt === e.cashOut.amountWei) continue;
      return "The cash out is not the asset, recipient and amount previewed.";
    }
    return `${d.functionName} on ${c.to} is not part of this preview.`;
  }
  if (decoded.some(({ c }) => (c.value ?? 0n) !== 0n)) return "A private payment carries no value.";
  return null;
}

export interface GuardedSender extends CallSender {
  /** Run fn with the wallet allowed to sign what `expect` names, and nothing else. One at a time. */
  within<T>(expect: Expectation, context: { previewId: string | null; action: string }, fn: () => Promise<T>): Promise<T>;
}

export function guardedSender(inner: CallSender, onSign?: SignHook): GuardedSender {
  let active: { expect: Expectation; context: { previewId: string | null; action: string } } | null = null;
  return {
    address: inner.address,
    async sendCalls(calls) {
      if (!active) throw new NotSentError("The wallet signs only inside an approved preview. Nothing was signed.");
      const described = calls.map(decode);
      const problem = callsProblem(active.expect, calls);
      if (problem) throw new NotSentError(`${problem} Nothing was signed.`);
      if (onSign && !(await onSign(described, active.context))) throw new NotSentError("The approval was declined. Nothing was signed.");
      return inner.sendCalls(calls);
    },
    async within(expect, context, fn) {
      if (active) throw new Error("Another Gloam action is running. Try again when it is done.");
      active = { expect, context };
      try {
        return await fn();
      } finally {
        active = null;
      }
    },
  };
}
