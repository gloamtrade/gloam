/**
 * Every address behind Gloam, by network: the contract list on /verify, its
 * CSV download and the Networks docs read it.
 *
 * The contracts come from the app's own network data: vaults, deploy blocks
 * and memo boards from lib/networks (filled in from MAINNET_POOLS and the
 * testnet pools in lib/mainnet), routers from lib/vaultSwap. So Base and
 * Ethereum mainnet show up here the moment their pools are filled in, and
 * nothing is copied by hand. The accounts below are the only addresses kept
 * here, once, for every page that names them.
 *
 * What only the chain knows (the proof checkers a vault points at, its owner
 * and settings as they stand) is read from the vault itself (readVault) and
 * turned into rows and checks by chainRows and vaultChecks, so the page and
 * the CSV show the same thing.
 */
import { getAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { getNetwork, isNetworkKey, networkName, type GloamNetwork, type NetworkKey } from "./networks";
import { swapRoutersOn } from "./vaultSwap";
import { ELYSIUM_FLAG } from "./elysium";

/**
 * Owner of every mainnet vault, and of Base Sepolia's and Ethereum Sepolia's.
 * One wallet at launch; a multisig is planned. It has no function that moves
 * anyone's balance.
 */
export const GLOAM_OWNER: Address = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8";

/**
 * VaultOwnerGuard (contracts/src/VaultOwnerGuard.sol): the contract each mainnet
 * vault's ownership moves to. It forwards deposit limit and fee changes and the
 * sweep of stray native coin, and nothing else, so a vault it holds can never
 * get a new proof checker or a new owner. null until its address is final; set it before the first handover
 * (DEPLOY.md, owner guard), so a vault it holds reads as listed while the others
 * are still on GLOAM_OWNER.
 */
export const GLOAM_OWNER_GUARD: Address | null = null;

/**
 * The treasury: the vaults' fee recipient (cash-out fees go here since 24
 * October 2026 on Robinhood Chain and Tempo, and from the deploy on the
 * others), and where both swap routers send what a swap does not use.
 */
export const GLOAM_TREASURY: Address = "0xB3900ac9350903218e4c7597bAb0f008F01B30B8";

/**
 * The relay's accounts, the one /api/relay names first. Run by the Gloam team:
 * they send already-proven transactions and pay the gas. Add any extra relay
 * key (GLOAM_RELAYER_PRIVATE_KEYS) here by its address.
 */
export const GLOAM_RELAYERS: readonly Address[] = ["0xb1E994586E62994648a0b866BF33F2EDd942512e"];

/** Created the mainnet-pool contracts and handed ownership to GLOAM_OWNER. */
export const GLOAM_DEPLOYER: Address = "0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411";

/** The Poseidon hash library every mainnet-pool vault uses. */
export const MAINNET_POSEIDON_T3: Address = "0x1a32C2c2A77225EC2dD3BF7be1018819b1039Cb4";

/** CHANGE_DELAY in the vault: a rule change waits this long in public. */
export const CHANGE_DELAY_SECONDS = 3n * 24n * 60n * 60n;

/**
 * A statement signed by the owner key naming these addresses, checked in the
 * browser on /verify. null until the owner signs one: paste the exact message
 * and its personal_sign signature here (selftest-contract-directory checks the
 * signature recovers to GLOAM_OWNER, so a wrong paste fails the tests).
 */
export const OWNERSHIP_STATEMENT: { message: string; signature: `0x${string}`; signedOn: string } | null = null;

export type DirectoryRole =
  | "vault"
  | "payment_messages"
  | "swap_router"
  | "owner"
  | "fee_recipient"
  | "relayer"
  | "deployer"
  | "proof_checker"
  | "deposit_proof_checker"
  | "cash_out_proof_checker"
  | "send_proof_checker"
  | "poseidon";

export type DirectoryRow = {
  role: DirectoryRole;
  name: string;
  /** The contract's name in contracts/src, or null for an account. */
  contract: string | null;
  what: string;
  address: Address;
  deployBlock: bigint | null;
  /** "app": the app's own network data. "chain": read from the vault just now. */
  source: "app" | "chain";
};

export type DirectoryEntry = {
  key: NetworkKey;
  network: GloamNetwork;
  /** "Robinhood Chain", "Base Sepolia testnet": what the page and the CSV call it. */
  name: string;
  kind: "mainnet" | "testnet";
  /** False while the network's pool is not filled in: shown as next, with no rows. */
  live: boolean;
  rows: DirectoryRow[];
};

/** Mainnets first, in the order Gloam names them, then the testnets. */
const MAINNET_ORDER: readonly NetworkKey[] = [
  "robinhood-mainnet",
  "tempo-mainnet",
  "base-mainnet",
  "ethereum-mainnet",
  // Only while its flag is on (lib/elysium): with the flag off it is not named at all.
  ...(ELYSIUM_FLAG ? (["elysium-mainnet"] as const) : []),
];
const TESTNET_ORDER: readonly NetworkKey[] = ["robinhood", "tempo", "base", "ethereum"];

/** What a network is called here: "Base" on mainnet, "Base Sepolia testnet", "Tempo Moderato testnet". */
export function directoryName(n: GloamNetwork): string {
  if (!n.testnet) return n.label;
  if (n.family === "base") return "Base Sepolia testnet";
  if (n.family === "tempo") return "Tempo Moderato testnet";
  return networkName(n);
}

function routerContract(chainId: number, version: 1 | 2 | 3): string {
  if (version === 3) return chainId === 4217 ? "GloamVaultSwapTempo2" : "GloamVaultSwapV4c";
  if (version === 2) return "GloamVaultSwapV4b";
  return chainId === 4217 ? "GloamVaultSwapTempo" : "GloamVaultSwapV4";
}

/** The rows the app's own data gives a network with a pool. */
function appRows(n: GloamNetwork): DirectoryRow[] {
  if (!n.pool) return [];
  const rows: DirectoryRow[] = [
    {
      role: "vault",
      name: "Vault",
      contract: n.paymentsPool ? "ShieldPoolPayments" : "ShieldPoolPoseidon",
      what: "Holds every private balance. Releases money only for a valid proof.",
      address: getAddress(n.pool),
      deployBlock: n.deployBlock,
      source: "app",
    },
  ];
  if (n.payMemo) {
    rows.push({
      role: "payment_messages",
      name: "Payment messages",
      contract: "GloamPayMemo",
      what: "Encrypted notes that let a recipient find a payment with their Gloam address. No owner, holds nothing.",
      address: getAddress(n.payMemo.address),
      deployBlock: n.payMemo.deployBlock,
      source: "app",
    });
  }
  // Swap routers: on Robinhood Chain and Tempo mainnet only (lib/vaultSwap).
  for (const [i, r] of swapRoutersOn(n.chainId).entries()) {
    rows.push({
      role: "swap_router",
      name: i === 0 ? "Swap router" : "Earlier swap router",
      contract: routerContract(n.chainId, r.version),
      what:
        i > 0
          ? "Kept for refunds of swaps made through it. New swaps use the router above."
          : r.venue === "v4" && r.version >= 2
            ? "Swaps one note through a public DEX and back into the vault. No upgrade; its owner can only add a pool, with 3 days of public notice, or take one off."
            : "Swaps one note through a public DEX and back into the vault. No owner, no admin, no upgrade.",
      address: getAddress(r.address),
      deployBlock: null,
      source: "app",
    });
  }
  if (n.paymentsPool && n.family === "elysium") {
    // Elysium's vault was born guarded: its owner is a VaultOwnerGuard made by the
    // deploy itself (its address is in the live read above and in
    // contracts/deployments/elysium-mainnet.json), never the owner wallet.
    rows.push({
      role: "fee_recipient",
      name: "Treasury",
      contract: null,
      what: "Receives the cash-out fee.",
      address: GLOAM_TREASURY,
      deployBlock: null,
      source: "app",
    });
  } else if (n.paymentsPool) {
    rows.push({
      role: "owner",
      name: "Owner",
      contract: null,
      what: "Queues rule changes, which wait 3 days in public. Can lower a limit or the fee at once. Has no function to withdraw a balance.",
      address: GLOAM_OWNER,
      deployBlock: null,
      source: "app",
    });
    if (GLOAM_OWNER_GUARD) {
      rows.push({
        role: "owner",
        name: "Owner guard",
        contract: "VaultOwnerGuard",
        what: "Holds a vault once it accepts it. Forwards deposit limit and fee changes and the sweep of coin sent by mistake, nothing else, so that vault's proof checkers and ownership can never change.",
        address: GLOAM_OWNER_GUARD,
        deployBlock: null,
        source: "app",
      });
    }
    rows.push({
      role: "fee_recipient",
      name: "Treasury",
      contract: null,
      what: swapRoutersOn(n.chainId).length
        ? "Receives the cash-out fee and what a swap's price buffer does not use."
        : "Receives the cash-out fee.",
      address: GLOAM_TREASURY,
      deployBlock: null,
      source: "app",
    });
  }
  for (const [i, relayer] of GLOAM_RELAYERS.entries()) {
    rows.push({
      role: "relayer",
      name: GLOAM_RELAYERS.length > 1 ? `Relayer ${i + 1}` : "Relayer",
      contract: null,
      what: "Run by the Gloam team. Sends already-proven transactions and pays the gas. Cannot move or redirect money.",
      address: relayer,
      deployBlock: null,
      source: "app",
    });
  }
  if (n.paymentsPool) {
    rows.push({
      role: "deployer",
      name: "Deployer",
      contract: null,
      what: "Created these contracts and handed the vault to the owner.",
      address: GLOAM_DEPLOYER,
      deployBlock: null,
      source: "app",
    });
  }
  return rows;
}

/** One network's entry, live with its rows once its pool is filled in, else next. */
export function directoryEntry(key: NetworkKey): DirectoryEntry {
  const network = getNetwork(key);
  const live = isNetworkKey(key) && network.pool !== null && network.deployBlock !== null;
  return {
    key,
    network,
    name: directoryName(network),
    kind: network.testnet ? "testnet" : "mainnet",
    live,
    rows: live ? appRows(network) : [],
  };
}

/** Every network Gloam knows, mainnets first: live ones with their rows, the rest as next. */
export function contractDirectory(): DirectoryEntry[] {
  return [...MAINNET_ORDER, ...TESTNET_ORDER].map(directoryEntry);
}

/* ---------------------------------------------------------------- the chain */

/** What /verify reads from a vault. null where the vault has no such call (the older testnet pools). */
export type VaultRead = {
  owner: Address;
  pendingOwner: Address;
  setupMode: boolean;
  changeDelay: bigint;
  verifier: Address;
  shieldVerifier: Address;
  poseidon: Address;
  feeRecipient: Address | null;
  withdrawFeeBps: number | null;
  /** The send and cash-out proof checker's two parts (DualProofVerifier), when it has them. */
  cashOutVerifier: Address | null;
  sendVerifier: Address | null;
};

const VAULT_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function setupMode() view returns (bool)",
  "function CHANGE_DELAY() view returns (uint256)",
  "function verifier() view returns (address)",
  "function shieldVerifier() view returns (address)",
  "function poseidon2() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function withdrawFeeBps() view returns (uint16)",
]);
const DUAL_ABI = parseAbi([
  "function unshieldVerifier() view returns (address)",
  "function transferVerifier() view returns (address)",
]);

/**
 * Reads a vault's owner, settings and proof checkers. Throws when the core
 * reads fail (the network did not answer); the fee and the checker's parts
 * are null where the contract has no such call.
 */
export async function readVault(n: GloamNetwork, client: PublicClient): Promise<VaultRead> {
  if (!n.pool) throw new Error(`${n.key} has no vault`);
  const address = n.pool;
  const read = <T>(functionName: (typeof VAULT_ABI)[number]["name"]) =>
    client.readContract({ address, abi: VAULT_ABI, functionName }) as Promise<T>;
  const [owner, pendingOwner, setupMode, changeDelay, verifier, shieldVerifier, poseidon] = await Promise.all([
    read<Address>("owner"),
    read<Address>("pendingOwner"),
    read<boolean>("setupMode"),
    read<bigint>("CHANGE_DELAY"),
    read<Address>("verifier"),
    read<Address>("shieldVerifier"),
    read<Address>("poseidon2"),
  ]);
  const optional = <T>(p: Promise<T>) => p.catch(() => null);
  const [feeRecipient, withdrawFeeBps, cashOutVerifier, sendVerifier] = await Promise.all([
    n.paymentsPool ? optional(read<Address>("feeRecipient")) : Promise.resolve(null),
    n.paymentsPool ? optional(read<number>("withdrawFeeBps")) : Promise.resolve(null),
    optional(client.readContract({ address: verifier, abi: DUAL_ABI, functionName: "unshieldVerifier" })),
    optional(client.readContract({ address: verifier, abi: DUAL_ABI, functionName: "transferVerifier" })),
  ]);
  return {
    owner,
    pendingOwner,
    setupMode,
    changeDelay,
    verifier,
    shieldVerifier,
    poseidon,
    feeRecipient,
    withdrawFeeBps: withdrawFeeBps === null ? null : Number(withdrawFeeBps),
    cashOutVerifier,
    sendVerifier,
  };
}

const isSet = (a: Address | null): a is Address => a !== null && !isAddressEqual(a, zeroAddress);

/** The rows only the chain gives: the proof checkers and the hash library, and the owner where the app names none. */
export function chainRows(n: GloamNetwork, r: VaultRead): DirectoryRow[] {
  const row = (role: DirectoryRole, name: string, contract: string | null, what: string, address: Address): DirectoryRow => ({
    role,
    name,
    contract,
    what,
    address: getAddress(address),
    deployBlock: null,
    source: "chain",
  });
  const final = n.ceremony === "production";
  const rows: DirectoryRow[] = [];
  if (!n.paymentsPool) {
    rows.push(row("owner", "Owner", null, "This testnet vault's owner, read from the vault.", r.owner));
  }
  if (isSet(r.shieldVerifier)) {
    rows.push(
      row(
        "deposit_proof_checker",
        "Deposit proof checker",
        final ? "ShieldIVerifierFinal" : "ShieldIVerifier",
        "Checks that a deposit's note holds exactly the amount sent.",
        r.shieldVerifier
      )
    );
  }
  if (isSet(r.verifier)) {
    rows.push(
      row("proof_checker", "Send and cash-out proof checker", "DualProofVerifier", "Passes each private send or cash-out proof to the checker below.", r.verifier)
    );
  }
  if (isSet(r.cashOutVerifier)) {
    rows.push(
      row(
        "cash_out_proof_checker",
        "Cash-out proof checker",
        final ? "UnshieldIVerifierFinal" : "UnshieldIVerifier",
        "Checks a cash out: the amount and the address it pays are fixed in the proof.",
        r.cashOutVerifier
      )
    );
  }
  if (isSet(r.sendVerifier)) {
    rows.push(
      row(
        "send_proof_checker",
        "Private send proof checker",
        final ? "TransferIVerifierFinal" : "TransferIVerifier",
        "Checks a private send without seeing its amount or who it is for.",
        r.sendVerifier
      )
    );
  }
  rows.push(row("poseidon", "Hash library", "PoseidonT3", "The Poseidon hash the vault builds its tree with.", r.poseidon));
  return rows;
}

export type VaultCheck = { label: string; ok: boolean; detail: string };

/** Whether a mainnet vault's owner is the listed wallet or the owner guard. */
export function ownerCheck(owner: Address, guard: Address | null = GLOAM_OWNER_GUARD): VaultCheck {
  const held = guard !== null && isAddressEqual(owner, guard);
  const listed = held || isAddressEqual(owner, GLOAM_OWNER);
  return {
    label: "Owner as listed",
    ok: listed,
    detail: held
      ? "The owner guard holds this vault: its proof checkers and owner can never change."
      : listed
        ? "The vault names the owner above."
        : `The vault names ${getAddress(owner)}.`,
  };
}

/** What the read shows, as plain checks against what the app says. */
export function vaultChecks(n: GloamNetwork, r: VaultRead): VaultCheck[] {
  const checks: VaultCheck[] = [
    {
      label: "Setup is over",
      ok: !r.setupMode,
      detail: r.setupMode ? "Setup is still open: the owner can change rules at once." : "Rule changes now go through the timelock.",
    },
    {
      label: "Rule changes wait 3 days",
      ok: r.changeDelay === CHANGE_DELAY_SECONDS,
      detail: `The vault's delay is ${formatDelay(r.changeDelay)}.`,
    },
  ];
  if (n.paymentsPool) {
    checks.push(ownerCheck(r.owner));
  }
  checks.push({
    label: "No handover pending",
    ok: !isSet(r.pendingOwner),
    detail: isSet(r.pendingOwner) ? `${getAddress(r.pendingOwner)} can accept ownership.` : "Nobody has been offered ownership.",
  });
  if (n.paymentsPool) {
    const toTreasury = r.feeRecipient !== null && isAddressEqual(r.feeRecipient, GLOAM_TREASURY);
    checks.push({
      label: "Fees go to the treasury",
      ok: toTreasury,
      detail:
        r.feeRecipient === null
          ? "The fee recipient could not be read."
          : toTreasury
            ? `Cash-out fee ${formatBps(r.withdrawFeeBps)}.`
            : `Fees go to ${getAddress(r.feeRecipient)}.`,
    });
    checks.push({
      label: "Hash library as listed",
      ok: isAddressEqual(r.poseidon, MAINNET_POSEIDON_T3),
      detail: isAddressEqual(r.poseidon, MAINNET_POSEIDON_T3) ? "PoseidonT3, the same on every mainnet vault." : `The vault uses ${getAddress(r.poseidon)}.`,
    });
  }
  return checks;
}

function formatDelay(seconds: bigint): string {
  if (seconds % 86_400n === 0n) {
    const days = seconds / 86_400n;
    return `${days} day${days === 1n ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

function formatBps(bps: number | null): string {
  if (bps === null) return "unknown";
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/* ---------------------------------------------------------------- the CSV */

export const CSV_HEADER = ["network", "chain_id", "kind", "role", "name", "contract", "address", "deploy_block", "explorer_url", "source"] as const;

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Every address as CSV: one line per row, the app's rows and then what was
 * read from each vault (`read` by network key; a network missing from it was
 * not read, so only its app rows are in).
 */
export function directoryCsv(entries: DirectoryEntry[], read: Partial<Record<NetworkKey, VaultRead>> = {}): string {
  const lines = [CSV_HEADER.join(",")];
  for (const e of entries) {
    if (!e.live) continue;
    const got = read[e.key];
    const rows = [...e.rows, ...(got ? chainRows(e.network, got) : [])];
    for (const r of rows) {
      lines.push(
        [
          e.name,
          String(e.network.chainId),
          e.kind,
          r.role,
          r.name,
          r.contract ?? "",
          r.address,
          r.deployBlock === null ? "" : r.deployBlock.toString(),
          e.network.explorerAddress(r.address),
          r.source,
        ]
          .map(cell)
          .join(",")
      );
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The download's file name, dated in UTC: gloam-contracts-2026-10-26.csv. */
export function csvFileName(now: Date = new Date()): string {
  return `gloam-contracts-${now.toISOString().slice(0, 10)}.csv`;
}

/** A block on the network's explorer, for a deploy block. */
export function explorerBlock(n: GloamNetwork, block: bigint): string | null {
  const base = n.chain.blockExplorers?.default.url;
  return base ? `${base.replace(/\/$/, "")}/block/${block.toString()}` : null;
}
