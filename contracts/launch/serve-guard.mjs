// Serves the owner guard signing page on http://127.0.0.1:4731/guard so a wallet
// extension can inject into it. Run `forge build` first, then, from contracts/:
//   node launch/serve-guard.mjs
//
// /guard           guard.html
// /guard/expected  the one address the guard can be at and its runtime code, both
//                  worked out from this checkout's own compile. The page signs
//                  for that address alone and takes no address from a person or a
//                  link: runtime code alone proves little, since init code can
//                  preset storage and then return the real runtime.
//
// Its own port, so it runs next to the router deploy page (serve-router.mjs, 4732).
// Uses `cast` for keccak256 (node:crypto only has NIST sha3).
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

// The same constants as script/DeployVaultOwnerGuard.s.sol.
const VAULT = "39e28cde55cab798874746ac52cb4b5cc99a0194";
const CONTROLLER = "76b7e410a227c888abd2bdc24ee32e094b0fd4d8";
const FACTORY = "4e59b44847b379578588920ca78fbf26c0b4956c";
const SALT_TEXT = "gloam.vault-owner-guard.v1";

const page = new URL("./guard.html", import.meta.url);
const artifact = new URL("../out/VaultOwnerGuard.sol/VaultOwnerGuard.json", import.meta.url);
const word = (hex) => hex.padStart(64, "0");
const keccak = (input) =>
  execFileSync(process.env.CAST ?? `${homedir()}/.foundry/bin/cast`, ["keccak", input], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Where the factory puts the guard: the same sum as the script's predicted(). */
function create2Address(bytecode) {
  const init = bytecode.object.replace(/^0x/, "") + word(VAULT) + word(CONTROLLER);
  const salt = keccak(SALT_TEXT).slice(2);
  const initHash = keccak("0x" + init).slice(2);
  return "0x" + keccak("0xff" + FACTORY + salt + initHash).slice(-40);
}

/** The compiled runtime code with the vault address written into its immutable. */
function expectedRuntime(deployedBytecode) {
  let code = deployedBytecode.object.replace(/^0x/, "");
  for (const refs of Object.values(deployedBytecode.immutableReferences)) {
    for (const { start, length } of refs) {
      if (length !== 32) throw new Error("unexpected immutable size");
      code = code.slice(0, start * 2) + word(VAULT) + code.slice((start + length) * 2);
    }
  }
  return "0x" + code;
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/$/, "") || "/";
  try {
    if (path === "/guard") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(await readFile(page));
    }
    if (path === "/guard/expected") {
      const { bytecode, deployedBytecode } = JSON.parse(await readFile(artifact, "utf8"));
      const body = JSON.stringify({ address: create2Address(bytecode), runtime: expectedRuntime(deployedBytecode) });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(body);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found. Try /guard");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Run `forge build` in contracts/ first, with cast installed. " + (e?.message ?? e));
  }
}).listen(Number(process.env.PORT) || 4731, "127.0.0.1", () => console.log("owner guard page up: http://127.0.0.1:4731/guard"));
