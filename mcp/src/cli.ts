/**
 * Command line for the published binary (gloam-mcp / npx @gloamtrade/mcp):
 * help, version, and authorize-access-key. Serving MCP lives in index.ts.
 */
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import {
  buildAccessKeyPlan,
  checkAccessKey,
  formatPlan,
  formatStatus,
  keyAddressFromEnv,
  newAgentKey,
  parseExpiry,
  parseLimits,
  parsePeriod,
  type AccessKeyPlan,
} from "./accessKey.js";
import { appendEnvFile, defaultEnvFilePath, envFileHas } from "./envFile.js";
import { MCP_NETWORKS, networkByKey, tempoAccessNetwork, type McpNetwork } from "./networks.js";
import { packageVersion } from "./version.js";

export { packageVersion };

type Env = Record<string, string | undefined>;

export const HELP = `gloam-mcp {version}: Gloam's MCP server for AI agents. Private stablecoin payments on Tempo and
Robinhood Chain (x402 and MPP), with spending limits. Mainnet and testnet.

Usage
  gloam-mcp                         Start the MCP server on stdio. This is what MCP clients run.
  gloam-mcp authorize-access-key    Set up a Tempo access key for the agent, with an onchain
                                    spending limit and expiry. Run with --help for the options.
  gloam-mcp --version
  gloam-mcp --help

Settings
  Read from the environment, then from ~/.gloam/agent.env (GLOAM_ENV_FILE moves it). The
  environment wins. Only GLOAM_* lines are read from the file.

  GLOAM_NETWORK             The network tools use when the agent names none: tempo-mainnet or
                            robinhood-mainnet (mainnet), tempo or robinhood (testnet, the default).
                            base-mainnet, ethereum-mainnet and ethereum (Ethereum Sepolia) work
                            once a release has their pools; base (Base Sepolia) is live.
                            elysium-mainnet and elysium (Elysium mainnet and testnet, gas
                            in HYPE) are coming: each works once a release has its values.
                            A mainnet here also puts the Tempo access key on Tempo mainnet.
  GLOAM_AGENT_PRIVATE_KEY   The agent's key. Without it, tools read and plan but never execute.
  GLOAM_TEMPO_ACCOUNT       Owner's Tempo account. With it, the key is an access key on Tempo and the
                            protocol enforces the owner's limits on it.
  GLOAM_NOTE_KEY            Key for the encrypted note store (openssl rand -hex 32). Back it up.
  GLOAM_LIMIT_*             Off-chain limits this server checks before it signs (see the README).
                            GLOAM_LIMIT_NETWORK=tempo-mainnet makes them name mainnet assets.
  GLOAM_RPC_URL_<chainId>   Use another RPC for a network, e.g. GLOAM_RPC_URL_4217 for Tempo mainnet.

Docs: https://github.com/gloamtrade/gloam/tree/main/mcp#readme
`;

export const ACCESS_KEY_HELP = `gloam-mcp authorize-access-key: an access key for the agent on Tempo (mainnet or testnet).

The owner's account authorizes the agent's key in Tempo's AccountKeychain with an expiry, a spending
limit that resets each period, and call scopes (approve the Gloam pool, shield, private transfer).
The protocol enforces them on every transaction the key signs, so they hold even if the agent, this
server or its host is compromised. This command prints what the owner signs. It never sends anything.

Usage
  gloam-mcp authorize-access-key --network tempo-mainnet --owner <address> --generate [--limit 25] [--period 1d] [--expires 30d]
  gloam-mcp authorize-access-key --owner <address> --key <address> [options]
  gloam-mcp authorize-access-key --check --owner <address> --key <address>

Options
  --network <name>      tempo-mainnet (mainnet) or tempo (testnet). Default: Tempo mainnet when
                        GLOAM_NETWORK names a mainnet, else Tempo testnet. A key authorized on one
                        does nothing on the other.
  --owner <address>     The owner's Tempo account (default: GLOAM_TEMPO_ACCOUNT)
  --generate            Make a new agent key and save it to the settings file (mode 600), with
                        GLOAM_TEMPO_ACCOUNT, a note-store key and matching off-chain limits.
                        The key is never printed.
  --key <address>       Authorize an existing key by address (default: GLOAM_AGENT_PRIVATE_KEY's address)
  --limit <amount>      Spending limit in the network's default stablecoin (USDC.e on mainnet,
                        PathUSD on testnet), or SYMBOL=amount (repeat for more stablecoins). Default 10
  --period <duration>   How often the limit resets: 1h, 1d, 7d, or "once" for a total. Default 1d
  --expires <when>      Duration (30d) or date (2026-12-31). Default 30d
  --env-file <path>     Settings file for --generate (default: ~/.gloam/agent.env or GLOAM_ENV_FILE)
  --check               Read the key's state on chain instead (no signing): authorized, limits left,
                        scopes, and any pool allowance the cap would not count
  --json                Print JSON
`;

interface Flags {
  network?: string;
  owner?: string;
  key?: string;
  generate: boolean;
  limits: string[];
  period?: string;
  expires?: string;
  envFile?: string;
  check: boolean;
  json: boolean;
  help: boolean;
}

export function parseFlags(argv: string[]): Flags {
  const f: Flags = { generate: false, limits: [], check: false, json: false, help: false };
  const take = (i: number, name: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") continue;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (name: string) => {
      if (inline !== undefined) return inline;
      const v = take(i, name);
      i++;
      return v;
    };
    switch (arg) {
      case "--network":
        f.network = value(arg);
        break;
      case "--owner":
        f.owner = value(arg);
        break;
      case "--key":
        f.key = value(arg);
        break;
      case "--limit":
        f.limits.push(value(arg));
        break;
      case "--period":
        f.period = value(arg);
        break;
      case "--expires":
        f.expires = value(arg);
        break;
      case "--env-file":
        f.envFile = value(arg);
        break;
      case "--generate":
        f.generate = true;
        break;
      case "--check":
        f.check = true;
        break;
      case "--json":
        f.json = true;
        break;
      case "--help":
      case "-h":
        f.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argv[i]}. See --help.`);
    }
  }
  return f;
}

const asAddress = (v: string, what: string): Address => {
  if (!isAddress(v.trim(), { strict: false })) throw new Error(`${what} is not an address: ${v}`);
  return getAddress(v.trim());
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

const LIMIT_KEYS = ["GLOAM_LIMITS", "GLOAM_LIMITS_FILE", "GLOAM_LIMIT_ASSETS", "GLOAM_LIMIT_MAX_PER_PAYMENT", "GLOAM_LIMIT_MAX_PER_DAY", "GLOAM_LIMIT_RECIPIENTS"];

/** The Tempo network an access key is for: --network, else the one GLOAM_NETWORK implies. */
function accessNetworkFrom(flag: string | undefined, env: Env): McpNetwork {
  if (flag === undefined) return tempoAccessNetwork(env);
  const v = flag.trim();
  if (v === "tempo") return MCP_NETWORKS.tempo;
  if (v === "tempo-mainnet") return networkByKey("tempo-mainnet");
  throw new Error(`--network must be tempo-mainnet or tempo: access keys are a Tempo feature. Got "${flag}".`);
}

/** Off-chain limits that match the onchain ones, for a fresh setup. Null when they cannot be expressed as env vars. */
function offchainLimitsFor(plan: AccessKeyPlan, net: McpNetwork) {
  const amounts = new Set(plan.limits.map((l) => l.amount));
  if (amounts.size !== 1) return null;
  const [amount] = amounts;
  return [
    { key: "GLOAM_LIMIT_ASSETS", value: plan.limits.map((l) => l.symbol).join(","), comment: "Off-chain limits, checked by the server before it signs. The onchain cap is the hard one." },
    ...(net.testnet ? [] : [{ key: "GLOAM_LIMIT_NETWORK", value: net.key, comment: "The assets above are the mainnet ones." }]),
    { key: "GLOAM_LIMIT_MAX_PER_PAYMENT", value: amount },
    { key: "GLOAM_LIMIT_MAX_PER_DAY", value: amount },
    { key: "GLOAM_LIMIT_RECIPIENTS", value: "any", comment: "Narrow this to the receive tags the agent should pay." },
    { key: "GLOAM_LIMIT_EXPIRES", value: plan.expiry.iso },
    { key: "GLOAM_LIMIT_TOOLS", value: "pay,shield" },
  ];
}

/** `gloam-mcp authorize-access-key`. Returns the process exit code. */
export async function runAuthorizeAccessKey(
  argv: string[],
  env: Env = process.env,
  out: (s: string) => void = (s) => process.stdout.write(`${s}\n`),
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<number> {
  const f = parseFlags(argv);
  if (f.help) {
    out(ACCESS_KEY_HELP);
    return 0;
  }
  const net = accessNetworkFrom(f.network, env);
  const ownerRaw = f.owner ?? env.GLOAM_TEMPO_ACCOUNT?.trim();
  if (!ownerRaw) throw new Error("Give the owner's Tempo account with --owner <address> (or set GLOAM_TEMPO_ACCOUNT).");
  const owner = asAddress(ownerRaw, "--owner");

  if (f.generate && (f.key || f.check)) throw new Error("--generate makes a new key; it does not go with --key or --check.");
  const envKey = keyAddressFromEnv(env);

  if (f.check) {
    const keyId = f.key ? asAddress(f.key, "--key") : envKey;
    if (!keyId) throw new Error("Give the access key with --key <address> (or set GLOAM_AGENT_PRIVATE_KEY).");
    const status = await checkAccessKey({ owner, keyId, network: net, nowSec });
    out(f.json ? json(status) : formatStatus(status));
    return status.ok ? 0 : 2;
  }

  const limits = parseLimits(f.limits.length ? f.limits : ["10"], net);
  const period = parsePeriod(f.period ?? "1d");
  const expiry = parseExpiry(f.expires ?? "30d", nowSec);

  let keyId: Address;
  let generated: ReturnType<typeof newAgentKey> | null = null;
  if (f.generate) {
    if (envKey) {
      throw new Error(
        `An agent key is already configured (access key ${envKey}). Drop --generate to authorize that key, or pass --env-file with a new file for a second agent.`
      );
    }
    // appendEnvFile never replaces a setting, so a key line already in the file (even an empty one, or in a
    // file this run did not load) would keep the new key out, and the owner would authorize a key nobody holds.
    const target = f.envFile ?? defaultEnvFilePath(env);
    if (envFileHas(target, "GLOAM_AGENT_PRIVATE_KEY")) {
      throw new Error(
        `${target} already has a GLOAM_AGENT_PRIVATE_KEY line, so a new key would not be saved there. Remove that line, or pass --env-file with a new file, then run --generate again.`
      );
    }
    generated = newAgentKey();
    keyId = generated.address;
  } else if (f.key) {
    keyId = asAddress(f.key, "--key");
  } else if (envKey) {
    keyId = envKey;
  } else {
    throw new Error("No agent key. Use --generate to make one, --key <address>, or set GLOAM_AGENT_PRIVATE_KEY.");
  }
  if (isAddressEqual(keyId, owner)) throw new Error("The access key cannot be the owner account itself.");

  const plan = buildAccessKeyPlan({ network: net, owner, keyId, limits, period, expiry });
  const notes: string[] = [];

  if (generated) {
    const path = f.envFile ?? defaultEnvFilePath(env);
    const entries: { key: string; value: string; comment?: string }[] = [
      { key: "GLOAM_AGENT_PRIVATE_KEY", value: generated.privateKey, comment: "Agent access key. Holds no funds; acts for GLOAM_TEMPO_ACCOUNT within the owner's onchain limits." },
      { key: "GLOAM_TEMPO_ACCOUNT", value: owner },
      ...(net.testnet ? [] : [{ key: "GLOAM_NETWORK", value: net.key, comment: "Mainnet: tools default to Tempo mainnet, and the access key is checked there." }]),
    ];
    if (!env.GLOAM_NOTE_KEY?.trim()) {
      entries.push({ key: "GLOAM_NOTE_KEY", value: generated.noteKey, comment: "Encrypts the note store. Back it up with the store: without it the private balance cannot be opened." });
    }
    const offchain = LIMIT_KEYS.some((k) => env[k]?.trim()) ? null : offchainLimitsFor(plan, net);
    if (offchain) entries.push(...offchain);
    const { written, kept } = appendEnvFile(path, entries, `Added by gloam-mcp authorize-access-key, ${new Date(nowSec * 1000).toISOString()}`);
    notes.push(
      `Saved a new agent key to ${path} (mode 600): access key ${keyId}. It holds no funds and can do nothing until the owner authorizes it below.`
    );
    if (written.includes("GLOAM_NOTE_KEY")) notes.push("A note-store key was added too. Back up that file: it opens the agent's private balance.");
    if (offchain && written.includes("GLOAM_LIMIT_ASSETS")) notes.push("Off-chain limits matching the cap were added; narrow GLOAM_LIMIT_RECIPIENTS when you know who the agent pays.");
    else if (!offchain && !LIMIT_KEYS.some((k) => env[k]?.trim())) notes.push("Set off-chain limits too (GLOAM_LIMIT_* or GLOAM_LIMITS_FILE): without them the server refuses every spend.");
    if (kept.length) notes.push(`Left as they were in ${path}: ${kept.join(", ")}.`);
  } else if (!env.GLOAM_TEMPO_ACCOUNT?.trim()) {
    notes.push(`After the owner authorizes the key, set GLOAM_TEMPO_ACCOUNT=${owner} for the server (in ${defaultEnvFilePath(env)} or its MCP config) and restart it.`);
  }
  if (!generated && !net.testnet && env.GLOAM_NETWORK?.trim() !== net.key) {
    notes.push(`This key is for ${net.name}. Set GLOAM_NETWORK=${net.key} for the server so it checks the key there.`);
  }

  if (f.json) {
    out(json({ ...plan, notes }));
  } else {
    if (notes.length) out(`${notes.join("\n")}\n`);
    out(formatPlan(plan));
    if (generated) out("\nRestart the agent's MCP server once the owner has authorized the key.");
  }
  return 0;
}
