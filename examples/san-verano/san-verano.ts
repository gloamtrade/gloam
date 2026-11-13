/**
 * San Verano pilot: a business agent pays a supplier privately, the supplier
 * secures the money, the agent proves the payment, and the city puts that
 * proof into its nightly root. The shop's burn stays a public transfer.
 *
 *   # dry run (the default): no keys, no network, nothing sent
 *   npx tsx examples/san-verano/san-verano.ts
 *
 *   # Robinhood Chain testnet: signs and sends with the agent's own wallet
 *   GLOAM_SV_LIVE=1 GLOAM_AGENT_KEY=0x... GLOAM_AGENT_NOTE_SECRET=0x... \
 *   GLOAM_AGENT_NOTE_AMOUNT=10000000 npx tsx examples/san-verano/san-verano.ts
 *
 * The dry run proves for real (the transfer and receipt circuits, dev keys,
 * from the repo's app/public/circuits), seals for real and builds the real
 * calls, then lands them in a local model of the vault instead of a chain. The
 * model keeps the vault's tree, roots and spent list; it does not check
 * transfer proofs, which only the vault does. Every hash it makes is local.
 *
 * Everything private is @gloamtrade/sdk: buildPrivatePaymentWithReceipt,
 * sweepReceivedNote, buildPaymentReceipt, paymentReceiptLeaf and
 * checkPaymentReceipt. viem only signs and reads.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  GLOAM_ARTIFACTS_URL,
  GLOAM_NETWORKS,
  IncrementalMerkleTreePoseidon,
  POOL_TRANSFER_ABI,
  RH_MAINNET_CHAIN_ID,
  RH_MAINNET_GRIFT,
  RH_MAINNET_USDG,
  agentSigningAllowlist,
  artifactProver,
  buildPaymentReceipt,
  buildPrivatePaymentWithReceipt,
  checkPaymentReceipt,
  circuitArtifactFiles,
  decodeNotePackage,
  fieldToHex,
  generateReceiveKey,
  getGloamNetwork,
  hexToField,
  makeBoundNotePoseidon,
  noteCommitmentPoseidon,
  notePackageToExport,
  openSealedTicket,
  paymentProofText,
  proveGroth16,
  relayIntent,
  relayMemo,
  relaySubmitter,
  sweepChainFromClient,
  sweepReceivedNote,
  syncTree,
  transferCallArgs,
  verifyGroth16,
  verifyPaymentReceiptLeaf,
  type AgentSigningEntry,
  type CeremonyKind,
  type GloamAsset,
  type GloamNetwork,
  type PaymentReceiptRecord,
  type PoseidonMerklePath,
  type PrivateSendIntent,
  type Prover,
  type ReceiptChainReader,
  type ReceiptCheckResult,
  type ReceiveKey,
  type SweepChain,
  type SweepSubmitter,
} from "@gloamtrade/sdk";

/** Where shop burns go. A plain ERC-20 transfer, public on purpose. */
export const BURN_ADDRESS: Address = "0x000000000000000000000000000000000000dEaD";

// ── the nightly root ─────────────────────────────────────────────────────────
// A stand-in for the city's own tree: sorted-pair keccak256, the scheme
// OpenZeppelin's MerkleProof.verify checks. Use your own tree; a receipt leaf
// is one more bytes32 value in it.

const hashPair = (a: Hex, b: Hex): Hex => keccak256(concat(BigInt(a) <= BigInt(b) ? [a, b] : [b, a]));

function layers(leaves: readonly Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("A root needs at least one leaf.");
  const out: Hex[][] = [leaves.map((l) => l.toLowerCase() as Hex)];
  while (out[out.length - 1]!.length > 1) {
    const level = out[out.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    out.push(next);
  }
  return out;
}

/** The root over the night's leaves, in the order given. */
export function nightlyRoot(leaves: readonly Hex[]): Hex {
  const all = layers(leaves);
  return all[all.length - 1]![0]!;
}

/** The sibling path for leaves[index]. */
export function nightlyProof(leaves: readonly Hex[], index: number): Hex[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error("No such leaf.");
  const proof: Hex[] = [];
  let i = index;
  for (const level of layers(leaves).slice(0, -1)) {
    const sibling = i ^ 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    i >>= 1;
  }
  return proof;
}

/** True when `leaf` with `proof` folds up to `root`. */
export function verifyNightlyProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  return proof.reduce<Hex>((h, p) => hashPair(h, p), leaf.toLowerCase() as Hex) === root.toLowerCase();
}

// ── the public burn ──────────────────────────────────────────────────────────

/** The shop's burn: token.transfer(0x…dEaD, amount), signed by the agent like any public transfer. */
export function burnCall(token: Address, amountWei: bigint): { to: Address; data: Hex; signature: string; selector: Hex } {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [BURN_ADDRESS, amountWei] });
  return { to: token, data, signature: "transfer(address,uint256)", selector: data.slice(0, 10) as Hex };
}

// ── the signing allowlist ────────────────────────────────────────────────────

/** What San Verano adds to its allowlist for Gloam on Robinhood Chain mainnet: USDG and GRIFT. */
export function sanVeranoAllowlist(): AgentSigningEntry[] {
  return agentSigningAllowlist({
    chainId: RH_MAINNET_CHAIN_ID,
    assets: [
      { symbol: "USDG", address: RH_MAINNET_USDG },
      { symbol: "GRIFT", address: RH_MAINNET_GRIFT },
    ],
  });
}

// ── circuit files ────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const REPO_CIRCUITS = resolve(here, "../../app/public/circuits");
const CACHE = process.env.GLOAM_CIRCUITS_CACHE?.trim() || join(homedir(), ".cache", "gloam", "circuits");

/** The receipt circuit's files, pinned like the Gloam app (app/src/lib/proofs/artifacts.ts). The .wasm is shared by both key sets. */
const RECEIPT_FILES: Record<CeremonyKind, { wasm: [string, string]; zkey: [string, string]; vkey: [string, string] }> = {
  dev: {
    wasm: ["receipt.wasm", "14733e0d4f598d6b392ce8e955eae5624ace80932aa9acdb9298d26c6d1a8fc1"],
    zkey: ["receipt_final.zkey", "600652865c27f9b1dafa4edfe65da7c4f8b7c9c6099bf0c85da0151d91830a9a"],
    vkey: ["receipt_vkey.json", "c3cb613d88398a55329dfd9f2e4c322ee6e5897689e970911f23890c78e2e63d"],
  },
  production: {
    wasm: ["receipt.wasm", "14733e0d4f598d6b392ce8e955eae5624ace80932aa9acdb9298d26c6d1a8fc1"],
    zkey: ["final/receipt_final.zkey", "b6b2352ecb393c7f0709177f89168d9d4fef53282fb24a98c1c08d9adb7cdd86"],
    vkey: ["final/receipt_vkey.json", "2ade74728fa4a5461a170384dae26f617af40a763175742ecd1576dcafeab299"],
  },
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A circuit file from `dir` or the cache, checked against its SHA-256; downloaded from gloam.trade only when `online`. */
async function circuitFile(dir: string, rel: string, expected: string, online: boolean): Promise<string> {
  for (const d of [dir, CACHE]) {
    const p = join(d, rel);
    if (existsSync(p) && sha256(readFileSync(p)) === expected) return p;
  }
  if (!online) {
    throw new Error(`${rel} is not in ${dir} (or it does not match its SHA-256). Run from a Gloam checkout, or set GLOAM_CIRCUITS_DIR.`);
  }
  const url = `${GLOAM_ARTIFACTS_URL}/${rel}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url} does not match its published SHA-256. Not using it.`);
  const p = join(CACHE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

interface Provers {
  transfer: Prover;
  receipt: (input: Record<string, string | string[]>) => ReturnType<typeof proveGroth16>;
  verifyReceipt: (signals: string[], proof: unknown) => Promise<boolean>;
}

async function provers(dir: string, ceremony: CeremonyKind, online: boolean): Promise<Provers> {
  const t = circuitArtifactFiles("transfer", ceremony);
  const transfer = artifactProver({
    wasm: await circuitFile(dir, t.wasm, t.sha256.wasm, online),
    zkey: await circuitFile(dir, t.zkey, t.sha256.zkey, online),
  });
  const r = RECEIPT_FILES[ceremony];
  const wasm = await circuitFile(dir, ...r.wasm, online);
  const zkey = await circuitFile(dir, ...r.zkey, online);
  const vkey = JSON.parse(readFileSync(await circuitFile(dir, ...r.vkey, online), "utf8")) as unknown;
  return {
    transfer,
    receipt: (input) => proveGroth16(input, wasm, zkey),
    verifyReceipt: (signals, proof) => verifyGroth16(vkey, signals, proof),
  };
}

// ── a local model of the vault, for the dry run ──────────────────────────────

const TRANSFERRED = [
  {
    type: "event",
    name: "Transferred",
    inputs: [
      { name: "nullifier", type: "bytes32", indexed: true },
      { name: "newCommitments", type: "bytes32[2]", indexed: false },
    ],
  },
] as const;

/**
 * The vault's tree, roots and spent list in memory. It refuses an unknown root,
 * a spent note and a duplicate commitment like the vault; it does not check
 * transfer proofs. Transaction hashes are local (keccak of the nullifier).
 */
class LocalVault {
  readonly tree = new IncrementalMerkleTreePoseidon();
  private readonly index = new Map<string, number>();
  private readonly roots = new Set<bigint>();
  private readonly spent = new Set<string>();
  private readonly txs = new Map<string, { logs: unknown[] }>();

  constructor(
    readonly chainId: number,
    readonly pool: Address
  ) {}

  async add(commitment: Hex): Promise<void> {
    if (this.index.has(commitment.toLowerCase())) throw new Error("DuplicateCommitment");
    this.index.set(commitment.toLowerCase(), await this.tree.insert(hexToField(commitment)));
    this.roots.add(this.tree.currentRoot);
  }

  async pathFor(commitment: Hex): Promise<PoseidonMerklePath | null> {
    const i = this.index.get(commitment.toLowerCase());
    return i === undefined ? null : this.tree.path(i);
  }

  /** Land a private send: spend its nullifier, insert both commitments, record its Transferred event. */
  async land(intent: PrivateSendIntent): Promise<Hex> {
    const [, root, nullifier, commitments] = transferCallArgs(intent);
    if (!this.roots.has(BigInt(root))) throw new Error("UnknownRoot");
    if (this.spent.has(nullifier.toLowerCase())) throw new Error("AlreadySpent");
    this.spent.add(nullifier.toLowerCase());
    await this.add(commitments[0]);
    await this.add(commitments[1]);
    const hash = keccak256(concat([stringToHex("san-verano dry run"), nullifier]));
    const log = {
      address: this.pool.toLowerCase(),
      topics: encodeEventTopics({ abi: TRANSFERRED, eventName: "Transferred", args: { nullifier } }),
      data: encodeAbiParameters([{ type: "bytes32[2]" }], [commitments]),
      blockNumber: 1n,
      blockHash: keccak256(hash),
      logIndex: 0,
      transactionHash: hash,
      transactionIndex: 0,
      removed: false,
    };
    this.txs.set(hash, { logs: [log] });
    return hash;
  }

  sweepChain(): SweepChain {
    return {
      chainId: async () => this.chainId,
      isSpent: async (n) => this.spent.has(n.toLowerCase()),
      isCommitmentSeen: async (c) => this.index.has(c.toLowerCase()),
      pathForCommitment: (c) => this.pathFor(c),
      waitForReceipt: async (h) => ({ status: this.txs.has(h) ? "success" : "reverted" }),
    };
  }

  submitter(): SweepSubmitter {
    return (intent) => this.land(intent);
  }

  /** The three reads checkPaymentReceipt makes, answered from memory. */
  reader(): ReceiptChainReader {
    const reader = {
      getChainId: async () => this.chainId,
      readContract: async ({ functionName, args }: { functionName: string; args: readonly [Hex] }) => {
        if (functionName !== "isKnownRoot") throw new Error(`The local vault has no ${functionName}.`);
        return this.roots.has(BigInt(args[0]));
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const tx = this.txs.get(hash);
        if (!tx) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`);
        return { status: "success", logs: tx.logs };
      },
    };
    return reader as unknown as ReceiptChainReader;
  }
}

// ── printing ─────────────────────────────────────────────────────────────────

const short = (s: string) => (s.length > 26 ? `${s.slice(0, 14)}…${s.slice(-8)}` : s);

function printChecks(r: ReceiptCheckResult) {
  for (const c of r.checks) console.log(`  ${c.state.padEnd(7)} ${c.id.padEnd(8)} ${c.detail}`);
  console.log(`  ok: ${r.ok}${r.expired ? " (expired)" : ""}`);
}

/** Older city records sharing the root: stand-ins for whatever the city commits each night. */
function otherRecords(): Hex[] {
  return ["wages:2026-10-30", "shop:4410:sale:8811", "passport:agent:77"].map((s) => keccak256(stringToHex(`city-record:${s}`)));
}

function cityCommits(record: PaymentReceiptRecord) {
  const leaves = [...otherRecords(), record.leaf];
  const root = nightlyRoot(leaves);
  const proof = nightlyProof(leaves, leaves.length - 1);
  return { leaves, root, proof, inRoot: verifyNightlyProof(root, record.leaf, proof) };
}

// ── dry run ──────────────────────────────────────────────────────────────────

export interface DryRunResult {
  supplierTag: string;
  calls: { to: Address; signature: string; selector: Hex }[];
  swept: boolean;
  record: PaymentReceiptRecord;
  leafRecomputes: boolean;
  root: Hex;
  inRoot: boolean;
  check: ReceiptCheckResult;
  burn: ReturnType<typeof burnCall>;
  allowlist: AgentSigningEntry[];
}

/**
 * The whole flow offline on Robinhood Chain testnet's addresses (dev keys):
 * nothing is signed, nothing leaves this process. `circuitsDir` holds the
 * circuit files (default: the repo's app/public/circuits).
 */
export async function dryRun(opts: { circuitsDir?: string; quiet?: boolean } = {}): Promise<DryRunResult> {
  const log = opts.quiet ? () => {} : console.log;
  const net = GLOAM_NETWORKS.robinhood;
  const usdg = net.assets.find((a) => a.symbol === "USDG")!;
  const show = (v: bigint) => `${formatUnits(v, usdg.decimals)} USDG`;
  const p = await provers(opts.circuitsDir ?? process.env.GLOAM_CIRCUITS_DIR?.trim() ?? REPO_CIRCUITS, net.ceremony, false);
  const vault = new LocalVault(net.chainId, net.pool);

  log("DRY RUN on a local model of the Robinhood Chain testnet vault. Nothing is signed or sent.\n");

  // 1. The supplier has a Gloam address (a receive tag). It keeps the private key server-side.
  const supplier = await generateReceiveKey();
  log(`1. Supplier's Gloam address: ${short(supplier.tag)}`);

  // 2. The business agent already holds private USDG: one note in the vault, among other people's.
  for (let i = 1; i <= 3; i++) await vault.add(fieldToHex(BigInt(7_000 + i)));
  const funding = await makeBoundNotePoseidon(parseUnits("100", usdg.decimals), usdg.address);
  await vault.add(funding.commitment);
  log(`2. Agent's private balance: ${show(parseUnits("100", usdg.decimals))} in one note`);

  // 3. Pay the supplier 25 USDG privately, and plan the receipt for the city's record.
  const price = parseUnits("25", usdg.decimals);
  const pay = await buildPrivatePaymentWithReceipt({
    payTo: supplier.tag,
    chainId: net.chainId,
    poolAddress: net.pool,
    asset: usdg.address,
    amountWei: price,
    from: { secretHex: funding.secret, amountWei: parseUnits("100", usdg.decimals), path: (await vault.pathFor(funding.commitment))! },
    prove: p.transfer,
    note: "sale 8812",
    receipt: { verifier: "san-verano:sale:8812" },
  });
  const transferData = encodeFunctionData({ abi: POOL_TRANSFER_ABI, functionName: "transfer", args: transferCallArgs(pay.intent) });
  const calls = [{ to: net.pool, signature: "transfer(bytes,bytes32,bytes32,bytes32[2])", selector: transferData.slice(0, 10) as Hex }];
  if (pay.memo) {
    const memoData = encodeFunctionData({ abi: pay.memo.abi, functionName: "postMemo", args: pay.memo.args });
    calls.push({ to: pay.memo.address, signature: "postMemo(bytes32,bytes)", selector: memoData.slice(0, 10) as Hex });
  }
  log(`3. Private payment of ${show(price)} built. The agent would sign:`);
  for (const c of calls) log(`     ${c.selector} ${c.signature} on ${c.to}`);
  log(`   Change kept by the agent: ${show(BigInt(pay.changeNote.amountWei))}`);

  // 4. The transfer lands (here: in the local vault). On chain it shows a nullifier and two commitments, no amount, no payee.
  const txHash = await vault.land(pay.intent);
  log(`4. Transfer landed (local hash ${short(txHash)})`);

  // 5. The supplier opens the sealed ticket and sweeps it into a note only it knows. Only then is the money final.
  const note = await notePackageToExport(decodeNotePackage(await openSealedTicket(pay.sealedTicket, supplier)));
  const sweep = await sweepReceivedNote({
    note,
    poolAddress: net.pool,
    chainId: net.chainId,
    prove: p.transfer,
    chain: vault.sweepChain(),
    submit: vault.submitter(),
  });
  log(`5. Supplier swept the payment: final=${sweep.final} (${show(BigInt(sweep.amountWei))})`);

  // 6. The agent proves the payment, bound to the city's record label, and makes the leaf.
  const record = await buildPaymentReceipt({
    plan: pay.receiptPlan,
    path: (await vault.pathFor(pay.paymentNote.commitment))!,
    txHash,
    prove: p.receipt,
  });
  const leafRecomputes = verifyPaymentReceiptLeaf(record.leaf, record);
  log(`6. Receipt proved for "${record.verifier}": at least ${show(BigInt(record.minAmount))}, amount ${record.amount ?? "hidden"}`);
  log(`   leaf ${record.leaf}`);

  // 7. The shop's burn stays public: a plain ERC-20 transfer to 0x…dEaD, which the passport reads as before.
  const burn = burnCall(usdg.address, parseUnits("1", usdg.decimals));
  log(`7. Public burn the agent would sign: ${burn.selector} ${burn.signature} on ${burn.to} to ${BURN_ADDRESS}`);

  // 8. The city puts the leaf in tonight's root, and anyone holding the record checks it.
  const city = cityCommits(record);
  log(`8. Nightly root ${city.root} (${city.leaves.length} leaves), leaf in root: ${city.inRoot}`);
  // The dry run models Robinhood Chain testnet, so it opts in to test value. A real city leaves allowTestnet off.
  const check = await checkPaymentReceipt(record, { verifySnark: p.verifyReceipt, client: vault.reader(), allowTestnet: true });
  log("   Record check (chain reads answered by the local vault):");
  if (!opts.quiet) printChecks(check);
  log(`   As a Gloam proof for gloam.trade/verify: ${short(paymentProofText(record))}`);

  const allowlist = sanVeranoAllowlist();
  log("\nSigning allowlist entries for Robinhood Chain mainnet:");
  for (const e of allowlist) log(`  ${e.selector} ${e.signature.padEnd(56)} ${e.to}  ${e.id}`);
  log(`  ${burn.selector} ${"transfer(address,uint256)".padEnd(56)} <token>  the burn, already on your list`);

  return { supplierTag: supplier.tag, calls, swept: sweep.final, record, leafRecomputes, root: city.root, inRoot: city.inRoot, check, burn, allowlist };
}

// ── live run (testnet by default) ────────────────────────────────────────────

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function pickNetwork(): GloamNetwork {
  const key = env("GLOAM_NETWORK") ?? "robinhood";
  if (key !== "robinhood" && key !== "robinhood-mainnet") throw new Error("GLOAM_NETWORK must be robinhood (testnet) or robinhood-mainnet.");
  const net = getGloamNetwork(key);
  if (!net) throw new Error(`This SDK version has no ${key} pool.`);
  return net;
}

function pickAsset(net: GloamNetwork): GloamAsset {
  const want = env("GLOAM_ASSET") ?? "USDG";
  const a = net.assets.find((x) => x.symbol.toLowerCase() === want.toLowerCase());
  if (!a) throw new Error(`${net.label} does not list ${want}.`);
  return a;
}

async function liveRun() {
  const net = pickNetwork();
  const asset = pickAsset(net);
  const show = (v: bigint) => `${formatUnits(v, asset.decimals)} ${asset.symbol}`;
  const pk = env("GLOAM_AGENT_KEY");
  const secret = env("GLOAM_AGENT_NOTE_SECRET") as Hex | undefined;
  const noteAmount = env("GLOAM_AGENT_NOTE_AMOUNT");
  if (!pk || !secret || !noteAmount) {
    throw new Error("Set GLOAM_AGENT_KEY, GLOAM_AGENT_NOTE_SECRET and GLOAM_AGENT_NOTE_AMOUNT (base units) for a live run.");
  }
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
  const rpc = env("GLOAM_RPC") ?? net.rpcUrl;
  const pub = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
  const viaRelay = env("GLOAM_RELAY") === "1";
  const p = await provers(env("GLOAM_CIRCUITS_DIR") ?? REPO_CIRCUITS, net.ceremony, true);
  console.log(`${net.label} ${net.testnet ? "testnet" : "mainnet"}, agent ${account.address}${viaRelay ? ", private sends through the Gloam relay" : ""}`);

  // The supplier: a key file (to sweep here), or just a tag (the supplier sweeps on its side).
  const keyFile = env("GLOAM_SUPPLIER_KEY_FILE");
  const supplierKey: ReceiveKey | null = keyFile ? (JSON.parse(readFileSync(keyFile, "utf8")) as ReceiveKey) : env("GLOAM_SUPPLIER_TAG") ? null : await generateReceiveKey();
  const payTo = supplierKey?.tag ?? env("GLOAM_SUPPLIER_TAG")!;
  if (supplierKey && !keyFile) console.log("No supplier given: made a throwaway supplier key for this run.");

  // The agent's private note and its path in the vault.
  const fundWei = BigInt(noteAmount);
  const commitment = fieldToHex(await noteCommitmentPoseidon(hexToField(secret), fundWei, asset.address));
  console.log("Syncing the vault tree");
  const before = await syncTree(pub, { pool: net.pool, fromBlock: net.deployBlock });
  const path = await before.pathForCommitment(commitment);
  if (!path) throw new Error(`No ${show(fundWei)} note with that secret is in the vault. Check the secret, amount and GLOAM_ASSET.`);

  const priceWei = parseUnits(env("GLOAM_PAY_AMOUNT") ?? "1", asset.decimals);
  const pay = await buildPrivatePaymentWithReceipt({
    payTo,
    chainId: net.chainId,
    poolAddress: net.pool,
    asset: asset.address,
    amountWei: priceWei,
    from: { secretHex: secret, amountWei: fundWei, path },
    prove: p.transfer,
    note: env("GLOAM_PAY_NOTE") ?? "san-verano pilot",
    receipt: { verifier: env("GLOAM_RECEIPT_FOR") ?? "san-verano:sale:pilot" },
  });
  console.log("Keep this CHANGE NOTE (the rest of the agent's balance):");
  console.log("  secret:", pay.changeNote.secret, " amount:", show(BigInt(pay.changeNote.amountWei)));

  // Private send, then the memo so the supplier finds it.
  const txHash = viaRelay
    ? await relayIntent(pay.intent)
    : await wallet.writeContract({ address: pay.intent.exec.poolAddress, abi: POOL_TRANSFER_ABI, functionName: "transfer", args: transferCallArgs(pay.intent) });
  const landed = await pub.waitForTransactionReceipt({ hash: txHash });
  if (landed.status !== "success") throw new Error("The private send reverted. The agent's note is unspent; retry.");
  console.log(`Paid ${show(priceWei)} privately: ${net.explorerUrl}/tx/${txHash}`);
  if (pay.memo) {
    const memoHash = viaRelay
      ? await relayMemo({ chainId: net.chainId, paymentCommitment: pay.memo.args[0], memo: pay.memo.args[1] })
      : await wallet.writeContract(pay.memo);
    await pub.waitForTransactionReceipt({ hash: memoHash });
    console.log(`Posted the sealed ticket for the supplier: ${net.explorerUrl}/tx/${memoHash}`);
  } else {
    console.log(`Hand the supplier this sealed ticket: ${pay.sealedTicket}`);
  }

  // The public burn, as the shop does today.
  const burnText = env("GLOAM_BURN_AMOUNT");
  if (burnText && Number(burnText) > 0) {
    const token = (env("GLOAM_BURN_TOKEN") as Address | undefined) ?? (net.testnet ? asset.address : RH_MAINNET_GRIFT);
    const decimals = await pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    const amount = parseUnits(burnText, decimals);
    const burn = burnCall(token, amount);
    const burnHash = await wallet.sendTransaction({ to: burn.to, data: burn.data });
    await pub.waitForTransactionReceipt({ hash: burnHash });
    console.log(`Public burn: ${net.explorerUrl}/tx/${burnHash}`);
  }

  // The supplier secures it (only possible here with its key).
  if (supplierKey) {
    const note = await notePackageToExport(decodeNotePackage(await openSealedTicket(pay.sealedTicket, supplierKey)));
    const ownWallet: SweepSubmitter = (intent) =>
      wallet.writeContract({ address: intent.exec.poolAddress, abi: POOL_TRANSFER_ABI, functionName: "transfer", args: transferCallArgs(intent) });
    const sweep = await sweepReceivedNote({
      note,
      poolAddress: net.pool,
      chainId: net.chainId,
      prove: p.transfer,
      chain: sweepChainFromClient(pub, { pool: net.pool, fromBlock: net.deployBlock }),
      submit: viaRelay ? relaySubmitter() : ownWallet,
      beforeSubmit: (fresh) => console.log(`Supplier's fresh note (keep it): secret ${fresh.secret}, ${show(BigInt(fresh.amountWei))}`),
    });
    console.log(`Supplier sweep: ${sweep.status}${sweep.reason ? ` (${sweep.reason})` : ""}`);
  }

  // The agent proves the payment; the city makes the leaf and checks it against the chain.
  const after = await syncTree(pub, { pool: net.pool, fromBlock: net.deployBlock });
  const paymentPath = await after.pathForCommitment(pay.paymentNote.commitment);
  if (!paymentPath) throw new Error("The payment is not in the synced tree yet. Retry the receipt in a moment.");
  const record = await buildPaymentReceipt({ plan: pay.receiptPlan, path: paymentPath, txHash, prove: p.receipt });
  console.log(`Receipt leaf: ${record.leaf}`);
  // Accept test value only when this run is itself on the testnet (GLOAM_NETWORK=robinhood).
  const check = await checkPaymentReceipt(record, { verifySnark: p.verifyReceipt, client: pub, allowTestnet: net.testnet });
  printChecks(check);
  const city = cityCommits(record);
  console.log(`Nightly root ${city.root}, leaf in root: ${city.inRoot}`);
  console.log(`\nThe record (store it with the leaf; it holds no secret):\n${JSON.stringify(record)}`);
  console.log(`\nCheck it at gloam.trade/verify:\n${paymentProofText(record)}`);
}

async function main() {
  if (env("GLOAM_SV_LIVE") === "1") return liveRun();
  const r = await dryRun();
  if (!r.swept || !r.leafRecomputes || !r.inRoot || !r.check.ok) throw new Error("The dry run did not check out.");
  // snarkjs keeps curve worker threads alive.
  (globalThis as { curve_bn128?: { terminate?: () => void } }).curve_bn128?.terminate?.();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
