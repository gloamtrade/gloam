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
import { ELYSIUM_FLAG, ELYSIUM_TESTNET_FLAG } from "./elysium";
import { BNB_FLAG } from "./bnb";
import { SHOW_TESTNETS } from "./showTestnets";
import { GLOAM_NAMES_ADDRESS } from "./gloamNames";
import { GLOAM_NAMES_DEPLOY_BLOCK } from "./nameStats";
import { NAMES_REGISTRAR_ADDRESS } from "./nameClaim";

/**
 * The owner wallet. It owned the four first mainnet vaults at launch (and still
 * owns Base Sepolia's and Ethereum Sepolia's); on 12 November 2026 those vaults
 * moved to the owner guard below, run by the Gloam Owner Safe, of which this
 * wallet is one of three signers. It still controls Elysium's guard, since Safe
 * does not run on Elysium yet, and it signs the ownership statement. It has no
 * function that moves anyone's balance.
 */
export const GLOAM_OWNER: Address = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8";

/**
 * The Gloam Owner Safe: 2 of 3 signers (Safe 1.5.0), the same address on
 * Robinhood Chain, Tempo, Base, Ethereum and BNB Chain. It controls the owner
 * guard on each of those (acceptController on 12 November 2026, and at deploy on
 * BNB Chain) and owns the GloamNames registry. Every action it takes needs two
 * of the three signatures.
 */
export const GLOAM_OWNER_SAFE: Address = "0x8E74b2b85b40f36771f92392b42BBaeacDC75507";

/**
 * VaultOwnerGuard (contracts/src/VaultOwnerGuard.sol): the owner of the vault on
 * Tempo, Ethereum, Base and Robinhood Chain since 12 November 2026, with the
 * Gloam Owner Safe as its controller. It forwards deposit limit and fee changes
 * and the sweep of stray native coin, and nothing else, so a vault it holds can
 * never get a new proof checker or a new owner. The same address on all four
 * (CREATE2, salt gloam.vault-owner-guard.v1). BNB Chain and Elysium have their
 * own guards (BORN_GUARDED).
 */
export const GLOAM_OWNER_GUARD: Address | null = "0x183e915113cbeF42Bc15a342EC48307e184ECEAB";

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

/**
 * Vaults born guarded, from a deployer of their own, so their addresses differ
 * from the four first mainnets': the deployer, the PoseidonT3 it made and the
 * VaultOwnerGuard that owns the vault from its deploy, with that guard's
 * controller (contracts/deployments/bnb-mainnet.json and elysium-mainnet.json,
 * both from deployer 0xec99...6b60, which is why the two share addresses).
 * selftest-bnb-everywhere fails if BNB Chain's and its file disagree.
 *
 * `controllerIsSafe`: BNB Chain's guard is run by the Gloam Owner Safe. Elysium's
 * is still run by the owner wallet, since Safe does not run on Elysium yet.
 */
export const BORN_GUARDED: Partial<
  Record<GloamNetwork["family"], { deployer: Address; poseidon: Address; guard: Address; controller: Address; controllerIsSafe: boolean }>
> = {
  bnb: {
    deployer: "0xec9993765e249e8e9DC677B7BCB61F78b31c6b60",
    poseidon: "0x62c435CE6886fa91e3b0e91500c6dC9219723457",
    guard: "0x633B24cf4C48CF68cB815BC87C110c47E218B4af",
    // The Gloam Owner Safe (2 of 3), replayed on BNB Chain at its address on the other chains.
    controller: GLOAM_OWNER_SAFE,
    controllerIsSafe: true,
  },
  elysium: {
    deployer: "0xec9993765e249e8e9DC677B7BCB61F78b31c6b60",
    poseidon: "0x62c435CE6886fa91e3b0e91500c6dC9219723457",
    guard: "0x268D7CAd645282D1e77461b5B2dd997bd54eFAf5",
    controller: GLOAM_OWNER,
    controllerIsSafe: false,
  },
};

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
  | "names_registry"
  | "names_registrar"
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
  // BNB Chain, only while its flag is on (lib/bnb, off by default): listed as next until its pool is in.
  ...(BNB_FLAG ? (["bnb-mainnet"] as const) : []),
];
const TESTNET_ORDER: readonly NetworkKey[] = [
  "robinhood",
  "tempo",
  "base",
  "ethereum",
  // Elysium testnet, only while its own switch is on: listed as next until its pool is in.
  ...(ELYSIUM_TESTNET_FLAG ? (["elysium"] as const) : []),
];

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
  // Gloam names: on Robinhood Chain mainnet only (lib/gloamNames, lib/nameClaim).
  if (n.chainId === 4663 && GLOAM_NAMES_ADDRESS) {
    rows.push({
      role: "names_registry",
      name: "Names registry",
      contract: "GloamNames",
      what: "Maps an @name to a Gloam address. Holds no balances. Paid in $GLOAM, which goes to the treasury. Owned by the Gloam Owner Safe.",
      address: getAddress(GLOAM_NAMES_ADDRESS),
      deployBlock: GLOAM_NAMES_DEPLOY_BLOCK,
      source: "app",
    });
    if (NAMES_REGISTRAR_ADDRESS) {
      rows.push({
        role: "names_registrar",
        name: "Private names registrar",
        contract: "GloamNamesRegistrar",
        what: "Pays for a name from a private $GLOAM balance in one transaction. No owner, no admin, no upgrade.",
        address: getAddress(NAMES_REGISTRAR_ADDRESS),
        deployBlock: 119_888_677n,
        source: "app",
      });
    }
  }
  const own = BORN_GUARDED[n.family];
  if (n.paymentsPool && own) {
    // Born guarded from its own deployer: the guard owns the vault, the Safe runs the guard.
    rows.push(
      {
        role: "owner",
        name: "Owner guard",
        contract: "VaultOwnerGuard",
        what: "Has owned this vault since its deploy. Forwards deposit limit and fee changes and the sweep of coin sent by mistake, nothing else, so its proof checkers and ownership can never change.",
        address: own.guard,
        deployBlock: null,
        source: "app",
      },
      {
        role: "owner",
        name: "Guard controller",
        contract: null,
        what: own.controllerIsSafe
          ? "The Gloam Owner Safe, 2 of 3. Runs the guard: rule changes wait 3 days in public. Can lower a limit or the fee at once. Has no function to withdraw a balance."
          : "The owner wallet, until Safe runs on this network. Runs the guard: rule changes wait 3 days in public. Can lower a limit or the fee at once. Has no function to withdraw a balance.",
        address: own.controller,
        deployBlock: null,
        source: "app",
      },
      {
        role: "fee_recipient",
        name: "Treasury",
        contract: null,
        what: "Receives the cash-out fee.",
        address: GLOAM_TREASURY,
        deployBlock: null,
        source: "app",
      }
    );
  } else if (n.paymentsPool) {
    // The four first mainnets: the guard has owned the vault since 12 November 2026, run by the Safe.
    if (GLOAM_OWNER_GUARD) {
      rows.push(
        {
          role: "owner",
          name: "Owner guard",
          contract: "VaultOwnerGuard",
          what: "Has owned this vault since 12 November 2026. Forwards deposit limit and fee changes and the sweep of coin sent by mistake, nothing else, so its proof checkers and ownership can never change.",
          address: GLOAM_OWNER_GUARD,
          deployBlock: null,
          source: "app",
        },
        {
          role: "owner",
          name: "Guard controller",
          contract: null,
          what: "The Gloam Owner Safe, 2 of 3. Runs the guard: rule changes wait 3 days in public. Can lower a limit or the fee at once. Has no function to withdraw a balance.",
          address: GLOAM_OWNER_SAFE,
          deployBlock: null,
          source: "app",
        }
      );
    } else {
      rows.push({
        role: "owner",
        name: "Owner",
        contract: null,
        what: "Queues rule changes, which wait 3 days in public. Can lower a limit or the fee at once. Has no function to withdraw a balance.",
        address: GLOAM_OWNER,
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
      what: own ? "Created these contracts and handed the vault to its guard in the same run." : "Created these contracts and handed the vault to the owner.",
      address: own?.deployer ?? GLOAM_DEPLOYER,
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

/**
 * Every network Gloam knows, mainnets first: live ones with their rows, the rest
 * as next. The testnets only while people see them (lib/showTestnets); pass
 * `testnets` to choose.
 */
export function contractDirectory(testnets: boolean = SHOW_TESTNETS): DirectoryEntry[] {
  return [...MAINNET_ORDER, ...(testnets ? TESTNET_ORDER : [])].map(directoryEntry);
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
  const own = BORN_GUARDED[n.family];
  if (n.paymentsPool) {
    checks.push(ownerCheck(r.owner, own?.guard ?? GLOAM_OWNER_GUARD));
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
    const poseidon = own?.poseidon ?? MAINNET_POSEIDON_T3;
    checks.push({
      label: "Hash library as listed",
      ok: isAddressEqual(r.poseidon, poseidon),
      detail: isAddressEqual(r.poseidon, poseidon)
        ? own
          ? "PoseidonT3, the same code as on every mainnet vault, made by this vault's own deployer."
          : "PoseidonT3, the same on every mainnet vault."
        : `The vault uses ${getAddress(r.poseidon)}.`,
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
