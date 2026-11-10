/**
 * Self-test: a server log keeps an error's name and summary, never its request
 * (lib/logSafe). A viem error's message holds the RPC URL with its key and the
 * calldata, and a log line sits beside the request's IP.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-log-safe.mts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { logSafe } from "../src/lib/logSafe";

const NULLIFIER = `0x${"ab".repeat(32)}` as `0x${string}`;
const server = createServer((_req, res) => {
  res.statusCode = 500;
  res.end("no");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };
const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}/v3/SECRETKEY`, { retryCount: 0 }) });
const abi = [{ type: "function", name: "spent", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ type: "bool" }] }] as const;
const failed = await client
  .readContract({ address: "0x39e28cde55cab798874746ac52cb4b5cc99a0194", abi, functionName: "spent", args: [NULLIFIER] })
  .then(() => assert.fail("the read should fail"), (e: Error) => e);
server.close();

// the raw error holds both, which is why it is never logged
assert.ok(failed.message.includes("SECRETKEY") && failed.message.includes("ab".repeat(32)));
const line = logSafe(failed);
assert.ok(!line.includes("SECRETKEY"), "no RPC key");
assert.ok(!line.includes("ab".repeat(32)), "no calldata");
assert.ok(line.includes("HTTP request failed"), "still says what went wrong");
assert.equal(logSafe(new Error("to 0x1234")), "Error", "a plain error keeps its name only");
assert.equal(logSafe("text"), "unknown");

// no server route logs a raw error, or its raw message (logSafe(e) instead)
const root = fileURLToPath(new URL("../src/app/api", import.meta.url));
const raw = /console\.(?:log|info|warn|error)\([^)]*,\s*(?:e|err|error)\s*\)/;
const rawMessage = /console\.(?:log|info|warn|error)\([^;]*\b(?:e|err|error)\.message\b/;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const files = [...walk(root), fileURLToPath(new URL("../src/lib/partnersApi.ts", import.meta.url))];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  assert.ok(!raw.test(text), `${f} logs a raw error`);
  assert.ok(!rawMessage.test(text), `${f} logs a raw error message`);
}

console.log(`log safe: ${files.length} files checked, all passed`);
