// Removes each protection in the v3 router, one at a time, and checks that a test
// fails. Works on a copy of contracts/, so a crash can't leave a mutant in the tree.
// Reads only, no RPC. From contracts/, after `forge build`:
//   node test/mutation/router-mutants.mjs <scratch dir> [name filter]
//
// A mutant that survives means a protection no test holds in place. The tests that
// pin bytecode are left out: any source edit moves those, so they would "catch"
// every mutant and prove nothing. A clean run of the copy comes first for the same
// reason. Exits 1 if any mutant survives that isn't listed in REDUNDANT.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const [scratch, only] = process.argv.slice(2);
if (!scratch) throw new Error("usage: router-mutants.mjs <scratch dir> [name filter]");
const dir = resolve(scratch, "mutants");
const BASE = "src/GloamVaultSwap2.sol";
const V4C = "src/GloamVaultSwapV4c.sol";
const ESCROW = "src/SwapEscrow2.sol";

/** [name, file, the code, what replaces it] */
const MUTANTS = [
  // the exit: who can take the money
  ["exit: no signature check", BASE, "if (signer == address(0) || signer != k.exitKey) revert BadExit();", ""],
  ["exit: a bad signature counts as key 0", BASE, "if (signer == address(0) || signer != k.exitKey) revert BadExit();", "if (signer != k.exitKey) revert BadExit();"],
  ["exit: a note still in the vault", BASE, "if (!vault.isSpent(k.nullifier) || _holding(assetIn, escrow) == 0) revert BadExit();", "if (_holding(assetIn, escrow) == 0) revert BadExit();"],
  ["exit: an empty escrow", BASE, "if (!vault.isSpent(k.nullifier) || _holding(assetIn, escrow) == 0) revert BadExit();", "if (!vault.isSpent(k.nullifier)) revert BadExit();"],
  ["exit: to the zero address", BASE, "if (to == address(0) || to == address(this) || to == address(vault)) revert BadExit();", "if (to == address(this) || to == address(vault)) revert BadExit();"],
  ["exit: to the router", BASE, "if (to == address(0) || to == address(this) || to == address(vault)) revert BadExit();", "if (to == address(0) || to == address(vault)) revert BadExit();"],
  ["exit: to the vault", BASE, "if (to == address(0) || to == address(this) || to == address(vault)) revert BadExit();", "if (to == address(0) || to == address(this)) revert BadExit();"],
  ["exit: no reentrancy latch", BASE, "function exit(address assetIn, EscrowKey calldata k, address to, bytes calldata signature)\n        external\n        nonReentrant\n", "function exit(address assetIn, EscrowKey calldata k, address to, bytes calldata signature)\n        external\n"],
  ["exit: a failed ETH payment passes", BASE, "if (!ok) revert TokenCallFailed();\n        } else {\n            _transfer(token, to, amount);", "ok;\n        } else {\n            _transfer(token, to, amount);"],
  // what a signature means
  ["digest: no chain id", BASE, "keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), escrow, to))", "keccak256(abi.encode(EXIT_DOMAIN, address(this), escrow, to))"],
  ["digest: no router", BASE, "keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), escrow, to))", "keccak256(abi.encode(EXIT_DOMAIN, block.chainid, escrow, to))"],
  ["digest: no escrow", BASE, "keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), escrow, to))", "keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), to))"],
  ["digest: no address", BASE, "keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), escrow, to))", "keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), escrow))"],
  // the escrow key
  ["key: swap drops the exit key", BASE, "k.exitKey = exitKey;", ""],
  ["key: swap drops the deadline", BASE, "k.deadline = deadline;", ""],
  ["key: swap drops the route", BASE, "k.routeHash = routeHash;", ""],
  ["key: swap drops the refund note", BASE, "k.refundCommitment = r.commitment;", ""],
  ["key: swap drops the new note", BASE, "k.outCommitment = d.commitment;", ""],
  // the deadline: on the swap branch alone
  ["deadline: not checked", BASE, "if (!refunding && block.timestamp > deadline) revert SwapExpired();", ""],
  ["deadline: a second early", BASE, "if (!refunding && block.timestamp > deadline) revert SwapExpired();", "if (!refunding && block.timestamp >= deadline) revert SwapExpired();"],
  ["deadline: holds back a refund", BASE, "if (!refunding && block.timestamp > deadline) revert SwapExpired();", "if (block.timestamp > deadline) revert SwapExpired();"],
  ["deadline: holds back an exit", BASE, "amount = _open(salt, assetIn);\n        _pay(assetIn, to, amount);", "if (block.timestamp > k.deadline) revert BadExit();\n        amount = _open(salt, assetIn);\n        _pay(assetIn, to, amount);"],
  // the latch and the escrow opening
  ["latch: a call back while an escrow opens", BASE, "if (_entered != IDLE) revert Reentrancy();", "if (_entered == RUNNING) revert Reentrancy();"],
  ["open: never marked as opening", BASE, "_entered = OPENING;\n", ""],
  ["open: stays opening", BASE, "_entered = RUNNING;\n        if (e == address(0)) revert EscrowUsed();", "if (e == address(0)) revert EscrowUsed();"],
  ["open: a used escrow passes", BASE, "if (e == address(0)) revert EscrowUsed();", ""],
  ["open: counts the router's whole balance", BASE, "arrived = _balance(token) - before;", "arrived = _balance(token); before;"],
  ["base receive: open to anyone", BASE, "if (!_opening()) revert NativeRefused();", ""],
  // refunds
  ["refund: a short escrow passes", BASE, "} else if (_holding(s.asset, escrow) < r.amount) {", "} else if (false) {"],
  ["refund: less arrived than the note", BASE, "if (available < r.amount) revert BadRefund();", ""],
  // ETH moving through the base
  ["deposit: no value on a native note", BASE, "vault.shieldBound{value: d.amount}(NATIVE, d.amount, d.commitment, d.proof);", "vault.shieldBound(NATIVE, d.amount, d.commitment, d.proof);"],
  ["sweep: ETH a hook pushed stays", BASE, "_trySweep(NATIVE);\n", ""],
  ["sweep: native leftovers stay", BASE, "(ok, ) = treasury.call{value: amount}(\"\");", "ok = true;"],
  ["balance: native reads as zero", BASE, "return token == NATIVE ? who.balance : IERC20Swap(token).balanceOf(who);", "return token == NATIVE ? 0 : IERC20Swap(token).balanceOf(who);"],
  // what a pool can do
  ["swap: short output passes", BASE, "if (got < d.amount) revert ShortOutput(got, d.amount);", ""],
  ["swap: over input passes both checks", V4C, "if (want > u.maxIn) revert OverInput(want, u.maxIn);", "", { also: [BASE, "if (amountIn > available) revert OverInput(amountIn, available);", ""] }],
  ["callback: outside a swap", V4C, "if (msg.sender != address(poolManager) || !_inSwap()) revert NotPoolManager();", "if (msg.sender != address(poolManager)) revert NotPoolManager();"],
  ["callback: from anyone", V4C, "if (msg.sender != address(poolManager) || !_inSwap()) revert NotPoolManager();", "if (!_inSwap()) revert NotPoolManager();"],
  ["callback: a middle currency that doesn't net", V4C, "if (i < u.hops.length && uint256(uint128(outD)) != want) revert MiddleNotSettled();", ""],
  ["callback: a short hop passes", V4C, "if (outD < 0 || uint256(uint128(outD)) < want) revert ShortOutput(outD < 0 ? 0 : uint256(uint128(outD)), want);", ""],
  // receive
  ["receive: shut while an escrow opens", V4C, "if (_opening()) return;\n", ""],
  ["receive: from anyone during a swap", V4C, "if (!_inSwap() || (msg.sender != weth && msg.sender != address(poolManager))) revert NativeRefused();", "if (!_inSwap()) revert NativeRefused();"],
  ["receive: from WETH outside a swap", V4C, "if (!_inSwap() || (msg.sender != weth && msg.sender != address(poolManager))) revert NativeRefused();", "if (msg.sender != weth && msg.sender != address(poolManager)) revert NativeRefused();"],
  // routes
  ["route: a pool off the allowlist", V4C, "if (!allowedPool(id)) revert PoolNotAllowed(id);", ""],
  ["route: any token pays in the other form", V4C, "if (_isEth(assetIn) && !_holds(hops[0], assetIn) && _holds(hops[0], _otherEth(assetIn))) cur = _otherEth(assetIn);", "if (!_holds(hops[0], assetIn) && _holds(hops[0], _otherEth(assetIn))) cur = _otherEth(assetIn);"],
  ["route: ends at anything ETH-like", V4C, "if (cur != assetOut && !(_isEth(assetOut) && cur == _otherEth(assetOut))) revert BadRoute();", "if (cur != assetOut && !(cur == _otherEth(assetOut))) revert BadRoute();"],
  ["route: a converted input inside the route", V4C, "if (path[0] != assetIn && path[i] == assetIn) revert BadRoute();\n", ""],
  ["route: a converted output inside the route", V4C, "if (path[n] != assetOut && path[i] == assetOut) revert BadRoute();\n", ""],
  ["route: a currency twice", V4C, "if (path[i] == path[j]) revert BadRoute();", ""],
  ["route: four hops", V4C, "if (n == 0 || n > MAX_HOPS) revert BadRoute();", "if (n == 0) revert BadRoute();"],
  // conversions
  ["pay: no wrap for an ETH note on a WETH pool", V4C, "if (u.assetIn == NATIVE) IWETH(weth).deposit{value: want}();", ""],
  ["pay: no unwrap for a WETH note on an ETH pool", V4C, "if (u.assetIn != NATIVE) IWETH(weth).withdraw(want);", ""],
  ["take: output left unconverted", V4C, "if (u.takeOut != u.assetOut) {\n            if (u.takeOut == NATIVE) IWETH(weth).deposit{value: finalOut}();\n            else IWETH(weth).withdraw(finalOut);\n        }", ""],
  // governance
  ["owner: anyone queues a pool", V4C, "function queuePool(PoolKey calldata key) external onlyOwner returns", "function queuePool(PoolKey calldata key) external returns"],
  ["owner: a queued pool is live at once", V4C, "return _list(key, block.timestamp + POOL_DELAY);", "return _list(key, block.timestamp);"],
  // the escrow
  ["escrow: keeps native ETH", ESCROW, "(bool ok, ) = msg.sender.call{value: amount}(\"\");\n                require(ok, \"escrow transfer\");", ""],
  ["escrow: a failed ETH send passes", ESCROW, "require(ok, \"escrow transfer\");\n            }\n        } else {", "ok;\n            }\n        } else {"],
];

/** Removing these leaves a second check doing the same job, so a survivor here is no gap. Each says why. */
const REDUNDANT = {
  "callback: a short hop passes":
    "the last hop is held by swap()'s ShortOutput on what actually arrived, a middle hop by MiddleNotSettled, and a negative output fails take()",
};

const forge = process.env.FORGE ?? `${homedir()}/.foundry/bin/forge`;
const env = { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" };
const SKIP = "predicted_addresses|escrow_creation_code";

function fresh() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const p of ["src", "script", "test", "lib", "foundry.toml", "foundry.lock"]) cpSync(p, join(dir, p), { recursive: true });
}
function test() {
  const r = spawnSync(forge, ["test", "--match-path", "test/VaultSwapV4c.t.sol", "--no-match-test", SKIP], { cwd: dir, env, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = `${r.stdout}\n${r.stderr}`;
  // a failure's message can hold brackets of its own, so match to the end of the line
  const failed = [...out.matchAll(/^\[FAIL.*\] (\w+)\(/gm)].map((m) => m[1]);
  const uniq = [...new Set(failed)];
  if (uniq.length) return { state: "failed", failed: uniq, out };
  // Only a named failing test counts as caught: a mutant that doesn't build proves nothing.
  return { state: r.status === 0 ? "passed" : "no-build", out };
}

fresh();
const base = test();
if (base.state !== "passed") {
  console.error(base.out.slice(-1500));
  throw new Error("the unmutated copy must pass first");
}
console.log("baseline: passes");

const results = [];
for (const [name, file, from, to, opt] of MUTANTS) {
  if (only && !name.includes(only)) continue;
  const edits = [[file, from, to], ...(opt?.also ? [opt.also] : [])];
  const saved = new Map();
  let missing = false;
  for (const [f, a, b] of edits) {
    const path = join(dir, f);
    const src = saved.get(path) ?? readFileSync(path, "utf8");
    if (!saved.has(path)) saved.set(path, src);
    if (!src.includes(a)) missing = true;
    writeFileSync(path, readFileSync(path, "utf8").replace(a, b));
  }
  const r = missing ? { state: "stale" } : test();
  for (const [path, src] of saved) writeFileSync(path, src);
  results.push({ name, ...r });
  const what = r.state === "failed" ? `caught by ${r.failed.length}: ${r.failed.slice(0, 2).join(", ")}` : r.state === "passed" ? "SURVIVED" : r.state.toUpperCase();
  console.log(`${r.state === "failed" ? "ok  " : "BAD "} ${name}: ${what}`);
}
const bad = results.filter((r) => r.state !== "failed" && !REDUNDANT[r.name]);
const redundant = results.filter((r) => r.state !== "failed" && REDUNDANT[r.name]);
for (const r of redundant) console.log(`redundant: ${r.name}: ${REDUNDANT[r.name]}`);
console.log(`\n${results.length} mutants: ${results.filter((r) => r.state === "failed").length} caught, ${redundant.length} redundant, ${bad.length} not caught`);
process.exit(bad.length ? 1 : 0);
