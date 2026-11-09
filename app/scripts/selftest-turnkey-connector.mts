/**
 * Self-test: the Gloam wallet's provider and who pays its gas
 * (lib/embeddedProvider, lib/embeddedGas, lib/turnkeyConnector's provider).
 *
 *  - chain handling: it starts on the chain it is given, switches to every
 *    chain the wagmi config registers (Gloam's four mainnets and their testnets,
 *    and a bridge origin chain) with no prompt, says so to wagmi, and refuses a
 *    chain it doesn't know with the standard 4902 error
 *  - each send is signed for the chain it goes to: the raw transaction's chain id
 *    is decoded here for every network, and it goes out on that chain's RPC only
 *  - personal_sign signs the same bytes as signMessage on the text, in either
 *    parameter order, which the recovery key depends on
 *  - gas: the wallet pays when it can; Turnkey sponsors only on a listed chain and
 *    only when the wallet can't; Tempo pays in its stablecoin and is never
 *    sponsored; with nothing to pay, nothing is sent and the app reads it as
 *    "never went out", in words a person can act on
 *  - a sponsored send hands back the hash as soon as there is one, and a failure
 *    after Turnkey took it never counts as "never went out"
 *  - only a refusal Turnkey answered counts as "never went out"
 *
 * The chains are in-process fakes and the signer is a throwaway local key: no
 * request leaves the process.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-turnkey-connector.mts
 */
import assert from "node:assert/strict";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  hexToNumber,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { arbitrum } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, robinhoodTestnet } from "../src/lib/chain";
import { baseMainnet, baseTestnet, ethereumMainnet, ethereumTestnet, tempoMainnet, tempoTestnet } from "../src/lib/networks";
import { EmbeddedMaybeSentError, EmbeddedNotSentError, makeEmbeddedProvider } from "../src/lib/embeddedProvider";
import {
  SPONSOR_SLOW_TEXT,
  TURNKEY_SPONSORABLE,
  gasBudget,
  noGasText,
  pickGasRoute,
  sponsorChainsFrom,
  SPONSOR_FAILED_TEXT,
  SPONSOR_UNSURE_TEXT,
  sendSponsored,
  sponsorableCall,
  submitRefused,
  type SponsorClient,
  waitForSponsoredHash,
} from "../src/lib/embeddedGas";
import { failedBeforeSend, surelyNotSent, walletDeclined, walletErrorText } from "../src/lib/walletErrors";
import type { EmbeddedSigner, SponsoredTx } from "../src/lib/turnkeyBridge";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const ME = privateKeyToAccount(`0x${"42".repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${"43".repeat(32)}`);
const VAULT = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ETH = 10n ** 18n;

// Every chain the app registers on mainnet, testnets first as wagmi.ts orders them, plus a bridge origin chain.
const CHAINS: readonly Chain[] = [
  robinhoodTestnet,
  tempoTestnet,
  baseTestnet,
  ethereumTestnet,
  robinhood,
  tempoMainnet,
  baseMainnet,
  ethereumMainnet,
  arbitrum,
];

/** One fake chain: its balance for ME, its prices, and what reached it. */
type Fake = { balance: bigint; gasPrice: bigint; raw: Hex[]; methods: string[]; estimateFails?: boolean };
const fakes = new Map<number, Fake>();
function fake(id: number): Fake {
  let f = fakes.get(id);
  if (!f) fakes.set(id, (f = { balance: 0n, gasPrice: 1_000_000_000n, raw: [], methods: [] }));
  return f;
}
function resetFakes() {
  fakes.clear();
}

function transportFor(chainId: number): Transport {
  return custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const f = fake(chainId);
      f.methods.push(method);
      switch (method) {
        case "eth_chainId":
          return toHex(chainId);
        case "eth_getBalance":
          return toHex(f.balance);
        case "eth_gasPrice":
          return toHex(f.gasPrice);
        case "eth_maxPriorityFeePerGas":
          return toHex(f.gasPrice / 10n);
        case "eth_getBlockByNumber":
          return { number: "0x10", baseFeePerGas: toHex(f.gasPrice), timestamp: "0x1", hash: `0x${"ab".repeat(32)}`, transactions: [] };
        case "eth_estimateGas":
          if (f.estimateFails) throw new Error("execution reverted");
          return toHex(100_000n);
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_sendRawTransaction": {
          const raw = (params as Hex[])[0]!;
          f.raw.push(raw);
          return keccak256(raw);
        }
        case "eth_call":
          return `0x${"00".repeat(31)}01`;
        default:
          throw new Error(`fake chain ${chainId}: no ${method}`);
      }
    },
  });
}

type Sponsored = SponsoredTx[];
function signerWith(sponsored?: Sponsored): EmbeddedSigner {
  return sponsored
    ? {
        account: ME,
        sponsoredSend: async (tx) => {
          sponsored.push(tx);
          return `0x${"5f".repeat(32)}`;
        },
      }
    : { account: ME };
}

function providerFor(opts: { signer?: EmbeddedSigner | null; sponsorChains?: ReadonlySet<number>; initialChainId?: number; changes?: number[] } = {}) {
  return makeEmbeddedProvider({
    chains: CHAINS,
    transportFor,
    signer: () => (opts.signer === undefined ? signerWith() : opts.signer),
    sponsorChains: opts.sponsorChains,
    sponsorTargetsFor: () => ({ vault: VAULT, tokens: [USDC] }),
    initialChainId: opts.initialChainId,
    onChainChanged: (id) => opts.changes?.push(id),
  });
}

const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, 1_000_000n] });
const SHIELD_ABI = [
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
] as const;
const depositData = (amount: bigint, asset: `0x${string}` = USDC) =>
  encodeFunctionData({ abi: SHIELD_ABI, functionName: "shieldBound", args: [asset, amount, keccak256(toHex("commitment")), "0x1234"] });
const NATIVE = "0x0000000000000000000000000000000000000000";

/* ------------------------------------------------------------ chains */

await test("starts on the chain it is given, or the first registered one", async () => {
  assert.equal(await providerFor({ initialChainId: 8453 }).request({ method: "eth_chainId" }), "0x2105");
  assert.equal(await providerFor().request({ method: "eth_chainId" }), toHex(46630));
  // an id the app doesn't register is ignored, not trusted
  assert.equal(await providerFor({ initialChainId: 999 }).request({ method: "eth_chainId" }), toHex(46630));
});

await test("switches to every Gloam network and a bridge origin chain, with no prompt, and tells wagmi", async () => {
  const changes: number[] = [];
  const p = providerFor({ changes });
  for (const id of [4663, 4217, 8453, 1, 42431, 84532, 11155111, 42161, 46630]) {
    assert.equal(await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(id) }] }), null);
    assert.equal(hexToNumber((await p.request({ method: "eth_chainId" })) as Hex), id);
    assert.equal(await p.request({ method: "net_version" }), String(id));
  }
  assert.deepEqual(changes, [4663, 4217, 8453, 1, 42431, 84532, 11155111, 42161, 46630]);
  // switching to the chain it is on says nothing
  p.setChainId(46630);
  assert.equal(changes.length, 9);
});

await test("refuses a chain the app doesn't register with 4902, and stays put", async () => {
  const p = providerFor({ initialChainId: 4663 });
  await assert.rejects(p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(137) }] }), (e: { code?: number }) => e.code === 4902);
  const add = (id: number) => ({ chainId: toHex(id), chainName: `chain ${id}`, rpcUrls: ["https://rpc.invalid"] });
  await assert.rejects(p.request({ method: "wallet_addEthereumChain", params: [add(137)] }), (e: { code?: number }) => e.code === 4902);
  assert.equal(await p.request({ method: "wallet_addEthereumChain", params: [add(8453)] }), null);
  assert.equal(await p.request({ method: "eth_chainId" }), toHex(4663));
});

await test("no account until the signer is there, then exactly its address", async () => {
  assert.deepEqual(await providerFor({ signer: null }).request({ method: "eth_accounts" }), []);
  await assert.rejects(providerFor({ signer: null }).request({ method: "personal_sign", params: ["0x00", ME.address] }), (e: { code?: number }) => e.code === 4100);
  assert.deepEqual(await providerFor().request({ method: "eth_requestAccounts" }), [ME.address]);
});

await test("reads go to the chain the wallet is on, and only there", async () => {
  resetFakes();
  const p = providerFor({ initialChainId: 8453 });
  fake(8453).balance = 7n;
  assert.equal(await p.request({ method: "eth_getBalance", params: [ME.address, "latest"] }), "0x7");
  p.setChainId(1);
  await p.request({ method: "eth_gasPrice" });
  assert.deepEqual(fake(8453).methods, ["eth_getBalance"]);
  assert.deepEqual(fake(1).methods, ["eth_gasPrice"]);
});

await test("personal_sign signs what signMessage signs, in either parameter order", async () => {
  const p = providerFor();
  const text = "www.gloam.trade wants you to sign in with your Ethereum account:\nGloam recovery";
  const want = await ME.signMessage({ message: text });
  assert.equal(await p.request({ method: "personal_sign", params: [toHex(text), ME.address] }), want);
  assert.equal(await p.request({ method: "personal_sign", params: [ME.address, toHex(text)] }), want);
  // through viem, the way wagmi's signMessage reaches a connector
  const client = createWalletClient({ account: ME.address, transport: custom(p) });
  assert.equal(await client.signMessage({ account: ME.address, message: text }), want);
});

await test("eth_signTypedData_v4 signs the typed data it is given", async () => {
  const typed = {
    domain: { name: "Gloam", version: "1", chainId: 4663 },
    types: { Note: [{ name: "amount", type: "uint256" }] },
    primaryType: "Note" as const,
    message: { amount: 5n },
  };
  const want = await ME.signTypedData(typed);
  const json = JSON.stringify(typed, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.equal(await providerFor().request({ method: "eth_signTypedData_v4", params: [ME.address, json] }), want);
});

await test("each send is signed for its own chain and goes out on that chain only", async () => {
  for (const chain of CHAINS) {
    resetFakes();
    fake(chain.id).balance = ETH;
    const p = providerFor({ initialChainId: chain.id });
    const hash = (await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: USDC, data: approveData }] })) as Hex;
    const sent = fake(chain.id).raw;
    assert.equal(sent.length, 1, `${chain.name}: one raw transaction`);
    assert.equal(hash, keccak256(sent[0]!));
    const tx = parseTransaction(sent[0]!);
    assert.equal(tx.chainId, chain.id, `${chain.name}: signed for chain ${chain.id}`);
    assert.equal(tx.to?.toLowerCase(), USDC.toLowerCase());
    assert.equal(tx.data, approveData);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: sent[0]! as never })).toLowerCase(), ME.address.toLowerCase());
    for (const [id, f] of fakes) if (id !== chain.id) assert.equal(f.raw.length, 0, `nothing sent on ${id}`);
  }
});

await test("a send names the chain it is for: a chainId in the request wins over the current chain", async () => {
  resetFakes();
  fake(4663).balance = ETH;
  const p = providerFor({ initialChainId: 8453 });
  await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: USDC, data: approveData, chainId: toHex(4663) }] });
  assert.equal(parseTransaction(fake(4663).raw[0]!).chainId, 4663);
  assert.equal(fake(8453).raw.length, 0);
});

await test("a send for another wallet, or with no recipient, never goes out", async () => {
  resetFakes();
  fake(4663).balance = ETH;
  const p = providerFor({ initialChainId: 4663 });
  await assert.rejects(p.request({ method: "eth_sendTransaction", params: [{ from: OTHER.address, to: USDC, data: approveData }] }), EmbeddedNotSentError);
  await assert.rejects(p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, data: approveData }] }), EmbeddedNotSentError);
  assert.equal(fake(4663).raw.length, 0);
});

/* ------------------------------------------------------------ gas */

await test("gas: the wallet pays when it holds enough, even on a sponsored chain", async () => {
  resetFakes();
  fake(8453).balance = ETH;
  const sponsored: Sponsored = [];
  const p = providerFor({ initialChainId: 8453, signer: signerWith(sponsored), sponsorChains: new Set([8453]) });
  await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: USDC, data: approveData }] });
  assert.equal(fake(8453).raw.length, 1);
  assert.equal(sponsored.length, 0);
});

await test("gas: a wallet with no ETH on a sponsored chain goes through Turnkey's gas station, for the approve and the deposit", async () => {
  resetFakes();
  const sponsored: Sponsored = [];
  const p = providerFor({ initialChainId: 4663, signer: signerWith(sponsored), sponsorChains: new Set([4663]) });
  const hash = await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: USDC, data: approveData }] });
  assert.equal(hash, `0x${"5f".repeat(32)}`);
  await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: VAULT, data: depositData(1_000_000n) }] });
  assert.deepEqual(sponsored, [
    { chainId: 4663, from: ME.address, to: USDC, data: approveData, value: undefined, coin: "ETH" },
    { chainId: 4663, from: ME.address, to: VAULT, data: depositData(1_000_000n), value: undefined, coin: "ETH" },
  ]);
  assert.equal(fake(4663).raw.length, 0, "nothing signed or sent by the wallet itself");
});

await test("gas: only the vault deposit and its approve are sponsored, never any other call", async () => {
  resetFakes();
  const sponsored: Sponsored = [];
  const p = providerFor({ initialChainId: 8453, signer: signerWith(sponsored), sponsorChains: new Set([8453]) });
  const stranger = "0x000000000000000000000000000000000000dEaD";
  const others: [`0x${string}`, `0x${string}`][] = [
    // a public token send
    [USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [stranger, 1n] })],
    // an approve to anyone but the vault
    [USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [stranger, 1n] })],
    // any contract, any calldata
    ["0x1111111111111111111111111111111111111111", "0xdeadbeef"],
    // the deposit's calldata sent to another contract
    ["0x2222222222222222222222222222222222222222", depositData(1n)],
    // approve(vault) sent to a contract that isn't a token Add lists (one whose approve could burn gas)
    ["0x3333333333333333333333333333333333333333", approveData],
  ];
  for (const [to, data] of others) {
    await assert.rejects(p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to, data }] }), EmbeddedNotSentError);
  }
  assert.equal(sponsored.length, 0);
  const targets = { vault: VAULT as `0x${string}`, tokens: [USDC as `0x${string}`] };
  assert.equal(sponsorableCall({ to: VAULT, data: depositData(1n), value: 0n, targets }), true);
  assert.equal(sponsorableCall({ to: USDC, data: approveData, value: 0n, targets }), true);
  assert.equal(sponsorableCall({ to: USDC.toLowerCase(), data: approveData, value: 0n, targets }), true, "the token's address in any case");
  assert.equal(sponsorableCall({ to: "0x3333333333333333333333333333333333333333", data: approveData, value: 0n, targets }), false, "approve(vault) on a contract that isn't a listed token");
  assert.equal(sponsorableCall({ to: USDC, data: approveData, value: 0n, targets: { ...targets, tokens: [] } }), false, "no listed tokens: no approve");
  assert.equal(sponsorableCall({ to: USDC, data: approveData, value: 1n, targets }), false, "an approve carrying value");
  assert.equal(sponsorableCall({ to: VAULT, data: depositData(1n), value: 0n, targets: null }), false, "no vault on the chain");
  assert.equal(sponsorableCall({ to: VAULT, data: "0x", value: 0n, targets }), false);
});

await test("gas: a call whose estimate reverts is never sponsored, even a vault deposit with a gas limit given", async () => {
  resetFakes();
  fake(8453).estimateFails = true;
  const sponsored: Sponsored = [];
  const p = providerFor({ initialChainId: 8453, signer: signerWith(sponsored), sponsorChains: new Set([8453]) });
  // with no gas limit the wallet's own send fails on the estimate; with one, the chain answers
  // (here a fake that takes it; a real chain refuses a wallet with no ETH). Either way: not Turnkey's.
  await assert.rejects(p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: VAULT, data: depositData(1n) }] }));
  await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: VAULT, data: depositData(1n), gas: toHex(400_000n) }] }).catch(() => null);
  assert.equal(sponsored.length, 0);
  assert.deepEqual(pickGasRoute({ chainId: 1, balance: 0n, value: 0n, cost: null, sponsorable: true, sponsorChains: new Set([1]) }), { kind: "self" });
});

await test("gas: a native ETH deposit can be sponsored, but only when the wallet holds the ETH itself", async () => {
  resetFakes();
  const sponsored: Sponsored = [];
  const p = providerFor({ initialChainId: 8453, signer: signerWith(sponsored), sponsorChains: new Set([8453]) });
  fake(8453).balance = 1000n; // the value, and nothing for gas
  await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: VAULT, value: toHex(1000n), data: depositData(1000n, NATIVE) }] });
  assert.equal(sponsored[0]?.value, 1000n);
  fake(8453).balance = 999n;
  await assert.rejects(
    p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: VAULT, value: toHex(1000n), data: depositData(1000n, NATIVE) }] }),
    (e: Error) => e instanceof EmbeddedNotSentError && /doesn't hold enough ETH/.test(walletErrorText(e)),
  );
  assert.equal(sponsored.length, 1);
});

await test("gas: no ETH and no sponsorship: nothing is sent, the app reads it as never sent, in plain words", async () => {
  for (const sponsorChains of [new Set<number>(), new Set([8453])]) {
    resetFakes();
    // sponsorship listed for another chain, or a signer with no sponsored send, is no sponsorship here
    const p = providerFor({ initialChainId: 4663, sponsorChains });
    const client = createWalletClient({ account: ME.address, chain: robinhood, transport: custom(p) });
    let err: unknown;
    try {
      await client.sendTransaction({ account: ME.address, chain: robinhood, to: USDC, data: approveData });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "it threw");
    assert.ok(failedBeforeSend(err) && surelyNotSent(err), "viem's wrapping keeps it readable as never sent");
    assert.equal(walletErrorText(err), noGasText("no-gas", robinhood.name, "ETH"));
    assert.ok(!/—/.test(walletErrorText(err)), "no em dash");
    assert.equal(fake(4663).raw.length, 0);
  }
});

await test("gas: Tempo pays in its stablecoin: no ETH checks, never sponsored, sent by the wallet", async () => {
  for (const chain of [tempoTestnet, tempoMainnet]) {
    resetFakes();
    const sponsored: Sponsored = [];
    const p = providerFor({ initialChainId: chain.id, signer: signerWith(sponsored), sponsorChains: new Set([chain.id, 4217, 42431]) });
    await p.request({ method: "eth_sendTransaction", params: [{ from: ME.address, to: USDC, data: approveData }] });
    assert.equal(sponsored.length, 0);
    assert.equal(fake(chain.id).raw.length, 1);
    assert.ok(!fake(chain.id).methods.includes("eth_getBalance"), "no gas-coin balance read on Tempo");
  }
});

await test("gas route table", () => {
  const S = new Set([4663, 8453]);
  const route = (chainId: number, balance: bigint | null, cost: bigint | null, value = 0n, sponsorable = true) =>
    pickGasRoute({ chainId, balance, value, cost, sponsorable, sponsorChains: S }).kind;
  assert.equal(route(4663, 10n, 10n), "self");
  assert.equal(route(4663, 9n, 10n), "sponsored");
  assert.equal(route(4663, 9n, 10n, 0n, false), "none", "not a vault call: not sponsored");
  assert.equal(route(4663, 9n, null), "self", "no estimate: never sponsored");
  assert.equal(route(1, 9n, 10n), "none");
  assert.equal(route(1, null, 10n), "self");
  assert.equal(route(8453, 20n, 10n, 15n), "sponsored");
  assert.equal(route(8453, 20n, 10n, 10n), "self");
  assert.equal(route(8453, 5n, 10n, 10n), "none");
  assert.equal(route(4217, 0n, 10n), "stablecoin");
  assert.equal(route(42431, null, null), "stablecoin");
  assert.deepEqual(pickGasRoute({ chainId: 1, balance: 0n, value: 1n, cost: 1n, sponsorable: true, sponsorChains: new Set([1]) }), { kind: "none", why: "no-funds" });
});

await test("gas budget: a fifth over gas times price, plus room for the L1 fee on OP Stack chains", () => {
  assert.equal(gasBudget(4663, 100_000n, 10n), 1_200_000n);
  assert.equal(gasBudget(1, 100_000n, 10n), 1_200_000n);
  assert.equal(gasBudget(8453, 100_000n, 10n), 1_200_000n + 20_000_000_000_000n);
  assert.equal(gasBudget(84532, 100_000n, 10n), 1_200_000n + 20_000_000_000_000n);
});

await test("NEXT_PUBLIC_TURNKEY_SPONSOR_CHAINS: a list, all, or off; never Tempo, never a chain Turnkey can't sponsor", () => {
  assert.deepEqual([...sponsorChainsFrom(undefined)], []);
  assert.deepEqual([...sponsorChainsFrom("")], []);
  assert.deepEqual([...sponsorChainsFrom("off")], []);
  assert.deepEqual([...sponsorChainsFrom(" 4663, 8453 ,46630")].sort((a, b) => a - b), [4663, 8453, 46630]);
  assert.deepEqual([...sponsorChainsFrom("4663,4217,42431,999,abc,1e3")], [4663]);
  const all = sponsorChainsFrom("ALL");
  for (const id of [1, 4663, 8453, 46630, 84532, 11155111, 42161]) assert.ok(all.has(id), `all has ${id}`);
  assert.ok(!all.has(4217) && !all.has(42431), "all leaves Tempo out");
  for (const id of [1, 4663, 4217, 8453, 46630, 42431, 84532, 11155111]) assert.ok(TURNKEY_SPONSORABLE.has(id), `Turnkey sponsors ${id}`);
});

/* ------------------------------------------------------------ sponsored sends */

/**
 * Turnkey's API as a sponsored send meets it: the submit (stamped by the kit, sent
 * by the app), the activity poll, and the transaction status. Each scenario says
 * how the submit and the polls answer.
 */
type Answer = { status: number; body?: unknown; html?: string } | "lost";
function turnkey(opts: { submit: Answer; activity?: (n: number) => Answer; status?: Answer; noStamp?: boolean }) {
  const calls: string[] = [];
  let polls = 0;
  const reply = (a: Answer) => {
    if (a === "lost") throw new TypeError("Failed to fetch");
    return a;
  };
  const client: SponsorClient = {
    async stampEthSendTransaction(input) {
      calls.push(`stamp ${String(input.caip2)} sponsor=${String(input.sponsor)}`);
      if (opts.noStamp) return undefined;
      return { body: JSON.stringify({ parameters: input }), stamp: { stampHeaderName: "X-Stamp", stampHeaderValue: "stamp" }, url: "https://api.turnkey.selftest.invalid/public/v1/submit/eth_send_transaction" };
    },
    async getActivity() {
      calls.push("poll");
      const a = reply(opts.activity?.(polls++) ?? { status: 200, body: { activity: { status: "ACTIVITY_STATUS_COMPLETED", result: { ethSendTransactionResult: { sendTransactionStatusId: "st-1" } } } } });
      if (a.status !== 200) throw Object.assign(new Error(`Turnkey error: ${JSON.stringify(a.body)}`), { name: "TurnkeyRequestError" });
      return a.body as never;
    },
    async getSendTransactionStatus() {
      calls.push("status");
      const a = reply(opts.status ?? { status: 200, body: { txStatus: "BROADCASTED", eth: { txHash: `0x${"ab".repeat(32)}` } } });
      if (a.status !== 200) throw new Error(String(a.status));
      return a.body as never;
    },
  };
  const fetch = (async (url: string) => {
    calls.push(`submit ${url.split("/").pop()}`);
    const a = reply(opts.submit);
    return a.html !== undefined ? new Response(a.html, { status: a.status }) : Response.json(a.body ?? {}, { status: a.status });
  }) as unknown as typeof globalThis.fetch;
  let t = 0;
  const send = () =>
    sendSponsored(client, { organizationId: "sub-org", chainId: 4663, from: ME.address, to: VAULT, data: depositData(1n), coin: "ETH" }, {
      fetch,
      sleep: async (ms: number) => void (t += ms),
      now: () => t,
    });
  return { send, calls };
}
const pending = { status: 200, body: { activity: { id: "act-1", status: "ACTIVITY_STATUS_PENDING" } } };
const done = { status: 200, body: { activity: { id: "act-1", status: "ACTIVITY_STATUS_COMPLETED", result: { ethSendTransactionResult: { sendTransactionStatusId: "st-1" } } } } };

await test("a sponsored send: submit, wait for the activity, then hand back the hash", async () => {
  const a = turnkey({ submit: done });
  assert.equal(await a.send(), `0x${"ab".repeat(32)}`);
  assert.deepEqual(a.calls, ["stamp eip155:4663 sponsor=true", "submit eth_send_transaction", "status"]);
  const b = turnkey({ submit: pending, activity: (n) => (n < 2 ? pending : done) });
  assert.equal(await b.send(), `0x${"ab".repeat(32)}`);
  assert.deepEqual(b.calls.filter((c) => c === "poll").length, 3);
});

await test("a submit refused before any work is 'never sent'", async () => {
  for (const [status, code] of [[400, 3], [401, 16], [403, 7], [404, 5], [429, 8]] as const) {
    const e = await turnkey({ submit: { status, body: { code, message: "refused", details: [] } } }).send().catch((x: unknown) => x);
    assert.ok(e instanceof EmbeddedNotSentError, `${status}/${code}`);
    assert.ok(surelyNotSent(e), `${status}/${code} reads as never sent`);
  }
  // nothing could even be signed: no session
  const e = await turnkey({ submit: done, noStamp: true }).send().catch((x: unknown) => x);
  assert.ok(surelyNotSent(e));
});

await test("a 504 (or any 5xx) on the submit may have been taken: kept, never 'never sent'", async () => {
  for (const [status, code] of [[504, 4], [500, 13], [503, 14], [500, 2]] as const) {
    const e = await turnkey({ submit: { status, body: { code, message: "context deadline exceeded", details: [] } } }).send().catch((x: unknown) => x);
    assert.ok(e instanceof EmbeddedMaybeSentError, `${status}/${code}`);
    assert.ok(!surelyNotSent(e), `${status}/${code} keeps the note`);
    assert.equal(walletErrorText(e), SPONSOR_UNSURE_TEXT);
  }
  // a 4xx with a code that doesn't mean "refused before any work" is not proof either, nor
  // FailedPrecondition (9), which Turnkey's error table doesn't list
  for (const [status, code] of [[409, 6], [412, 9]] as const) {
    const odd = await turnkey({ submit: { status, body: { code, message: "odd" } } }).send().catch((x: unknown) => x);
    assert.ok(!surelyNotSent(odd), `${status}/${code}`);
  }
  const html = await turnkey({ submit: { status: 502, html: "<html>bad gateway</html>" } }).send().catch((x: unknown) => x);
  assert.ok(!surelyNotSent(html));
  const lost = await turnkey({ submit: "lost" }).send().catch((x: unknown) => x);
  assert.ok(!surelyNotSent(lost));
});

await test("a failed poll after the send was taken is never 'never sent', even a refusal code", async () => {
  // the activity exists; its poll is rate limited until the deadline
  const a = turnkey({ submit: pending, activity: () => ({ status: 429, body: { code: 8, message: "rate limit exceeded" } }) });
  const e = await a.send().catch((x: unknown) => x);
  assert.ok(e instanceof EmbeddedMaybeSentError);
  assert.ok(!surelyNotSent(e));
  assert.ok(a.calls.filter((c) => c === "poll").length > 1, "it kept asking until the deadline");
  // a refused poll that then clears goes on to the hash
  const b = turnkey({ submit: pending, activity: (n) => (n === 0 ? { status: 429, body: { code: 8 } } : done) });
  assert.equal(await b.send(), `0x${"ab".repeat(32)}`);
  // the activity itself failed or was rejected after it was made: maybe sent
  for (const status of ["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]) {
    const c = turnkey({ submit: { status: 200, body: { activity: { id: "act-1", status } } } });
    const x = await c.send().catch((y: unknown) => y);
    assert.ok(x instanceof EmbeddedMaybeSentError && !surelyNotSent(x), status);
  }
  // completed with no status id
  const d = await turnkey({ submit: { status: 200, body: { activity: { id: "act-1", status: "ACTIVITY_STATUS_COMPLETED", result: {} } } } }).send().catch((y: unknown) => y);
  assert.ok(!surelyNotSent(d));
});

await test("a 5xx whose text says 'request rejected' is still maybe sent, never 'declined'", async () => {
  const e = await turnkey({ submit: { status: 503, body: { code: 14, message: "upstream request rejected", details: [] } } }).send().catch((x: unknown) => x);
  assert.ok(e instanceof EmbeddedMaybeSentError);
  assert.equal(walletDeclined(e), false, "the walk stops at the maybe-sent verdict");
  assert.equal(surelyNotSent(e), false);
  // wrapped by viem, the way the app meets it
  const wrapped = Object.assign(new Error("Transaction failed"), { name: "TransactionExecutionError", cause: e });
  assert.equal(walletDeclined(wrapped), false);
  assert.equal(surelyNotSent(wrapped), false);
  assert.equal(walletErrorText(wrapped), SPONSOR_UNSURE_TEXT);
  // a person who declines is still read as declining
  assert.equal(walletDeclined(Object.assign(new Error("User rejected the request."), { code: 4001 })), true);
});

await test("turnkeyErrorCode decides when Turnkey gives one; anything unrecognised stays maybe sent", async () => {
  const detail = (c: string) => ({ "@type": "type.googleapis.com/errors.v1.TurnkeyErrorDetail", turnkeyErrorCode: c });
  // refusals Turnkey documents, with or without a gRPC code next to them
  for (const c of ["REQUEST_INVALID", "UNAUTHENTICATED", "FORBIDDEN", "ORGANIZATION_NOT_FOUND", "RATE_LIMIT_EXCEEDED", "SIGNING_QUOTA_EXCEEDED"]) {
    assert.equal(submitRefused(400, { message: "x", details: [detail(c)] }), true, c);
    assert.equal(submitRefused(400, { code: 3, details: [detail(c)] }), true, `${c} with a gRPC code`);
  }
  assert.equal(submitRefused(400, { turnkeyErrorCode: "REQUEST_INVALID" }), true, "at the top of the body");
  // a gRPC code that would mean refused, but a turnkeyErrorCode that doesn't: maybe sent
  assert.equal(submitRefused(400, { code: 3, details: [detail("INTERNAL")] }), false);
  assert.equal(submitRefused(429, { code: 8, details: [detail("SOME_NEW_CODE")] }), false, "an unknown code is never proof");
  assert.equal(submitRefused(400, { code: 3, details: [detail("REQUEST_INVALID"), detail("RPC_CALL_ERROR")] }), false, "every code must say refused");
  // the gRPC codes may go away: with a turnkeyErrorCode, a refusal is still known
  const e = await turnkey({ submit: { status: 403, body: { message: "not authorized", details: [detail("REQUEST_NOT_AUTHORIZED")] } } }).send().catch((x: unknown) => x);
  assert.ok(e instanceof EmbeddedNotSentError && surelyNotSent(e));
  const f = await turnkey({ submit: { status: 400, body: { message: "odd", details: [detail("RPC_CALL_ERROR")] } } }).send().catch((x: unknown) => x);
  assert.ok(f instanceof EmbeddedMaybeSentError && !surelyNotSent(f));
});

await test("only the first submit's answer can say 'refused': submitRefused", () => {
  assert.equal(submitRefused(400, { code: 3 }), true);
  assert.equal(submitRefused(429, { code: 8 }), true);
  assert.equal(submitRefused(504, { code: 4 }), false);
  assert.equal(submitRefused(500, { code: 3 }), false, "a 5xx never counts");
  assert.equal(submitRefused(400, { code: "3" }), false);
  assert.equal(submitRefused(412, { code: 9 }), false, "FailedPrecondition isn't in Turnkey's table");
  assert.equal(submitRefused(400, null), false);
  assert.equal(submitRefused(200, { code: 3 }), false);
});

await test("the transaction status: a hash as soon as there is one; a failure or a stall keeps the note", async () => {
  const seen: string[] = [];
  const statuses = [{ txStatus: "PENDING" }, { txStatus: "BROADCASTED", eth: { txHash: `0x${"aa".repeat(32)}` } }];
  const hash = await waitForSponsoredHash(
    async () => {
      const s = statuses.shift()!;
      seen.push(s.txStatus);
      return s;
    },
    { sleep: async () => {} },
  );
  assert.equal(hash, `0x${"aa".repeat(32)}`);
  assert.deepEqual(seen, ["PENDING", "BROADCASTED"]);
  const failed = await waitForSponsoredHash(async () => ({ txStatus: "FAILED", error: { message: "execution reverted" } }), { sleep: async () => {} }).catch((e: unknown) => e);
  assert.ok(failed instanceof EmbeddedMaybeSentError && walletErrorText(failed) === SPONSOR_FAILED_TEXT);
  assert.ok(!surelyNotSent(failed), "the app keeps what it saved ahead of the send");
  let t = 0;
  const slow = await waitForSponsoredHash(async () => ({ txStatus: "PENDING" }), { sleep: async () => void (t += 1000), now: () => t, timeoutMs: 5000 }).catch((e: unknown) => e);
  assert.ok(slow instanceof EmbeddedMaybeSentError && walletErrorText(slow) === SPONSOR_SLOW_TEXT);
  assert.ok(!surelyNotSent(slow));
});

await test("the no-gas words name the chain and its coin, with no em dash", () => {
  const text = noGasText("no-gas", "Base", "ETH");
  assert.match(text, /^No ETH in this wallet for the network fee on Base, so nothing was sent\./);
  assert.match(text, /claim link or the bridge/);
  assert.ok(!/—/.test(text + noGasText("no-funds", "Base", "ETH")));
  // the app's error lines show 180 characters: the longest chain name still fits whole
  for (const c of CHAINS) {
    assert.ok(noGasText("no-gas", c.name, c.nativeCurrency.symbol).length <= 180, `${c.name} fits`);
    assert.ok(noGasText("no-funds", c.name, c.nativeCurrency.symbol).length <= 180, `${c.name} fits`);
  }
});

console.log(`selftest-turnkey-connector: ${passed} passed`);
