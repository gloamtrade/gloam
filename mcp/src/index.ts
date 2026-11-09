#!/usr/bin/env node
/**
 * Gloam MCP server, over stdio. Also the `gloam-mcp` command line.
 *
 * Private payment tools for AI agents across Gloam's networks: private
 * stablecoin payments on Tempo, Robinhood Chain, Base and Ethereum, on
 * mainnet and testnet. The tools live in src/server.ts; this file
 * loads settings and connects them to stdio.
 *
 * Money-moving tools pass the owner's spending limits first (src/policy.ts,
 * src/spendGuard.ts). With a Tempo access key (GLOAM_TEMPO_ACCOUNT), the
 * protocol enforces the owner's onchain limits as well (src/accessKey.ts). Note
 * secrets stay inside this server in an encrypted store (src/noteStore.ts); the
 * agent works with note handles.
 *
 * Settings are loaded before anything else is imported, since some modules read
 * the environment when they load.
 */

import { loadEnvFile } from "./envFile.js";

// stderr only: stdout is the MCP transport.
const log = (s: string) => console.error(s);

async function serve() {
  const settings = loadEnvFile(process.env);
  for (const w of settings.warnings) log(`Gloam MCP: ${w}`);

  const { signerSetup } = await import("./signer.js");
  let setup: ReturnType<typeof signerSetup>;
  try {
    setup = signerSetup(process.env);
  } catch (e) {
    // Fail closed: a malformed key or account must not start a server that signs some other way.
    log(`Gloam MCP: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const [{ StdioServerTransport }, { createGloamServer }, networks] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./server.js"),
    import("./networks.js"),
  ]);
  let defaultNet: ReturnType<typeof networks.networkByKey>;
  try {
    // Fail closed: a GLOAM_NETWORK this build does not have must not quietly become another network.
    defaultNet = networks.networkByKey(networks.defaultNetworkKey(process.env));
  } catch (e) {
    log(`Gloam MCP: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const server = createGloamServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The client is gone when stdin ends. Closing tells a paid call still running that its answer will not arrive.
  process.stdin.once("end", () => void transport.close());

  log("Gloam MCP server running on stdio.");
  log(`Networks: ${networks.NETWORK_KEYS.join(", ")}. Default: ${defaultNet.key}, ${networks.describeNetwork(defaultNet)}.`);
  if (settings.loaded.length) log(`Settings: ${settings.loaded.length} from ${settings.path}.`);
  if (setup.mode === "none") log("Signer: none. Tools read and plan; nothing is signed.");
  if (setup.mode === "key") log(`Signer: key ${setup.keyAddress}, signing as itself (off-chain limits only).`);
  if (setup.mode === "access-key") {
    log(`Signer: Tempo access key ${setup.keyAddress} for account ${setup.owner}. On Tempo the protocol enforces the owner's limits; on Robinhood Chain the key signs as itself.`);
  }
  if (process.env.GLOAM_EXPOSE_NOTE_SECRETS?.trim() === "1") {
    log("WARNING: GLOAM_EXPOSE_NOTE_SECRETS=1. Note secrets are passed to and from the agent. This is unsafe.");
  }

  // Report the access key's onchain state. Read-only, in the background, never blocks the server.
  if (setup.mode === "access-key") {
    const { checkAccessKey } = await import("./accessKey.js");
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 15_000).unref());
    const tempoNet = networks.tempoAccessNetwork(process.env);
    Promise.race([checkAccessKey({ owner: setup.owner, keyId: setup.keyAddress, network: tempoNet }), timeout])
      .then((s) => {
        if (s.ok) {
          const left = s.limits.map((l) => `${l.remaining} ${l.symbol}`).join(", ");
          log(
            `Access key on ${tempoNet.name}: authorized until ${s.expiry}, scoped to the Gloam pool; ${left ? `${left} left of its limit` : "nothing left of its limit"}.`
          );
        } else {
          for (const w of s.warnings) log(`Access key: ${w}`);
        }
      })
      .catch((e) => log(`Access key: could not read its onchain state (${e instanceof Error ? e.message : String(e)}).`));
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    const { packageVersion } = await import("./version.js");
    console.log(packageVersion());
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    const { HELP, packageVersion } = await import("./cli.js");
    console.log(HELP.replace("{version}", packageVersion()));
    return;
  }
  if (cmd === "authorize-access-key" || cmd === "access-key") {
    loadEnvFile(process.env);
    const { runAuthorizeAccessKey } = await import("./cli.js");
    process.exitCode = await runAuthorizeAccessKey(rest, process.env);
    return;
  }
  if (cmd !== undefined && cmd !== "serve") {
    log(`Unknown command: ${cmd}. Run gloam-mcp --help.`);
    process.exit(64);
  }
  await serve();
}

main().catch((err) => {
  console.error(`Gloam MCP: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
