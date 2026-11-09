#!/usr/bin/env node
/**
 * create-gloam-app: scaffold a private payments app on Robinhood Chain, powered
 * by @gloamtrade/sdk. Copies the starter template, fills in the project name,
 * and prints the next steps. Zero dependencies (Node built-ins only).
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(here, "../template");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  indigo: "\x1b[38;5;61m",
};

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(`
  ${c.bold}create-gloam-app${c.reset}: scaffold a private payments app on Robinhood Chain

  ${c.dim}Usage:${c.reset}
    npm create gloam-app@latest <project-name>
    npx create-gloam-app <project-name>
`);
  process.exit(0);
}

const name = (args[0] || "gloam-app").trim();
if (!/^[a-z0-9._-]+$/i.test(name)) {
  console.error(`${c.red}Invalid project name:${c.reset} "${name}"`);
  console.error(`Use letters, digits, dashes, dots, or underscores.`);
  process.exit(1);
}

const target = resolve(process.cwd(), name);
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${c.red}Directory "${name}" already exists and is not empty.${c.reset}`);
  process.exit(1);
}

console.log(`\n  ${c.indigo}◆${c.reset} Creating ${c.bold}${name}${c.reset} with the Gloam privacy stack…\n`);

cpSync(templateDir, target, { recursive: true });

// npm strips a literal .gitignore from published packages, so the template
// ships it as "gitignore"; restore the dot on scaffold.
const shippedGitignore = join(target, "gitignore");
if (existsSync(shippedGitignore)) {
  renameSync(shippedGitignore, join(target, ".gitignore"));
}

// Fill the chosen name into the project's package.json.
const pkgPath = join(target, "package.json");
if (existsSync(pkgPath)) {
  const pkg = readFileSync(pkgPath, "utf8").split("{{PROJECT_NAME}}").join(name);
  writeFileSync(pkgPath, pkg);
}

console.log(`  ${c.green}✓${c.reset} Scaffolded.\n`);
console.log(`  ${c.bold}Next steps${c.reset}`);
console.log(`    ${c.cyan}cd ${name}${c.reset}`);
console.log(`    ${c.cyan}npm install${c.reset}`);
console.log(`    ${c.cyan}npm run dev${c.reset}   ${c.dim}# fetches the shield circuit, then starts on :3000${c.reset}\n`);
console.log(`  Open http://localhost:3000, connect a wallet, and shield your first private USDG.`);
console.log(`  It runs on Robinhood Chain mainnet (4663, deposit limits) once your SDK`);
console.log(`  has the mainnet pool, and on testnet (46630) until then.\n`);
console.log(`  Practice on testnet: ${c.cyan}NEXT_PUBLIC_GLOAM_NETWORK=robinhood npm run dev${c.reset}`);
console.log(`  Test ETH:            ${c.indigo}https://faucet.testnet.chain.robinhood.com/${c.reset}`);
console.log(`  Test USDG:           ${c.indigo}https://faucet.paxos.com/${c.reset}`);
console.log(`  Docs:                ${c.indigo}https://gloam.trade/docs/sdk${c.reset}\n`);
