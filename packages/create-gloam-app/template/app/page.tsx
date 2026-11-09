"use client";

/**
 * Starter app: shield a private USDG balance IN THE BROWSER with
 * @gloamtrade/sdk. Connect an injected wallet, prove the shield client-side
 * (snarkjs fetches the circuit over HTTP), approve the pool for USDG, and
 * deposit via shieldBound(). Notes are kept in localStorage keyed by
 * commitment; the note secret is the only spend authority and never leaves the
 * browser. The private balance is read back straight from the pool with
 * commitmentSeen(): no backend, no indexer.
 *
 * Network: NEXT_PUBLIC_GLOAM_NETWORK = "robinhood-mainnet" (mainnet) or
 * "robinhood" (testnet). Unset, it is Robinhood Chain mainnet when
 * this SDK version has its pool, and Robinhood Chain testnet otherwise.
 */
import { useCallback, useEffect, useState } from "react";
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  erc20Abi,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import {
  buildShieldBoundIntent,
  artifactProver,
  assertDepositAllowed,
  circuitArtifactUrls,
  getGloamNetwork,
  networkName,
  RH_MAINNET_USDG,
  RH_USDG,
  type GloamNetwork,
} from "@gloamtrade/sdk";

// ── network ──────────────────────────────────────────────────────────────────

const REQUESTED = process.env.NEXT_PUBLIC_GLOAM_NETWORK?.trim() || "";

function pickNetwork(): { net: GloamNetwork | null; problem: string } {
  if (REQUESTED === "robinhood-mainnet") {
    const net = getGloamNetwork("robinhood-mainnet");
    return net
      ? { net, problem: "" }
      : {
          net: null,
          problem:
            "This version of @gloamtrade/sdk has no Robinhood Chain mainnet pool yet. Update the SDK once the pool is published, or set NEXT_PUBLIC_GLOAM_NETWORK=robinhood to practice on testnet.",
        };
  }
  if (REQUESTED === "robinhood") return { net: getGloamNetwork("robinhood"), problem: "" };
  if (REQUESTED) {
    return { net: null, problem: `NEXT_PUBLIC_GLOAM_NETWORK must be "robinhood-mainnet" or "robinhood", not "${REQUESTED}".` };
  }
  return { net: getGloamNetwork("robinhood-mainnet") ?? getGloamNetwork("robinhood"), problem: "" };
}

const { net: NET, problem: NETWORK_PROBLEM } = pickNetwork();
const MAINNET = NET !== null && !NET.testnet;
/** USDG on the chosen network (6 decimals). */
const USDG: Address = MAINNET ? RH_MAINNET_USDG : RH_USDG;
const USDG_DECIMALS = 6;
const NETWORK_LABEL = NET
  ? MAINNET
    ? `${NET.label} mainnet`
    : networkName(NET.chainId)
  : REQUESTED === "robinhood-mainnet"
    ? "Robinhood Chain mainnet"
    : "Robinhood Chain";

// Circuit files: a local copy in ./public/circuits (npm run artifacts fetches the
// dev keys to the root and the final keys to final/), or another root with the
// same layout whose host serves CORS (Gloam's copy: https://www.gloam.trade/circuits).
// circuitArtifactUrls picks final/ on mainnet and the dev keys on testnet.
const ARTIFACTS = process.env.NEXT_PUBLIC_GLOAM_ARTIFACTS?.trim() || "/circuits";

const poolAbi = [
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
  {
    type: "function",
    name: "commitmentSeen",
    stateMutability: "view",
    inputs: [{ name: "c", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

// ── notes ────────────────────────────────────────────────────────────────────

type StoredNote = {
  commitment: Hex;
  secret: Hex;
  /** Human amount, e.g. "1.5". */
  amount: string;
  symbol: string;
  /** Unset until the wallet hands back the deposit's hash. */
  hash?: Hex;
  live?: boolean;
};

// The testnet keeps the original key (older notes there were test ETH); mainnet gets its own.
const STORE_KEY = MAINNET ? `gloam:web-shield:notes:${NET?.chainId}` : "gloam:web-shield:notes";

function loadNotes(): StoredNote[] {
  if (typeof window === "undefined" || !NET) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as (StoredNote & { amountEth?: string })[];
    return raw.map((n) => ({ ...n, amount: n.amount ?? n.amountEth ?? "0", symbol: n.symbol ?? "ETH" }));
  } catch {
    return [];
  }
}
function saveNotes(notes: StoredNote[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(notes));
}

/** The person turned the wallet prompt down. Anything else (a lost reply, a timeout) may come after the wallet sent it. */
function walletDeclined(e: unknown): boolean {
  let x = e as { code?: number; cause?: unknown } | undefined;
  for (let i = 0; x && typeof x === "object" && i < 8; i++, x = x.cause as typeof x) {
    if (x.code === 4001) return true;
  }
  return false;
}

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

function getEthereum(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

const pub = NET ? createPublicClient({ chain: NET.chain, transport: http(NET.rpcUrl) }) : null;

export default function Page() {
  const [account, setAccount] = useState<Address | null>(null);
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(NETWORK_PROBLEM);
  const [err, setErr] = useState(Boolean(NETWORK_PROBLEM));
  const [notes, setNotes] = useState<StoredNote[]>([]);

  const say = (s: string, isErr = false) => {
    setStatus(s);
    setErr(isErr);
  };

  const refreshLive = useCallback(async (list: StoredNote[]) => {
    if (!NET || !pub) return;
    const checked = await Promise.all(
      list.map(async (n) => {
        try {
          const live = await pub.readContract({
            address: NET.pool,
            abi: poolAbi,
            functionName: "commitmentSeen",
            args: [n.commitment],
          });
          return { ...n, live };
        } catch {
          return { ...n, live: undefined };
        }
      })
    );
    setNotes(checked);
  }, []);

  useEffect(() => {
    const initial = loadNotes();
    setNotes(initial);
    if (initial.length) void refreshLive(initial);
  }, [refreshLive]);

  async function connect() {
    const eth = getEthereum();
    if (!NET) return say(NETWORK_PROBLEM, true);
    if (!eth) return say("No injected wallet found. Install one and reload.", true);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      // Make sure the wallet is on the chosen network, adding it if the wallet does not know it.
      const chainIdHex = `0x${NET.chainId.toString(16)}`;
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
      } catch {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chainIdHex,
              chainName: NET.chain.name,
              nativeCurrency: NET.chain.nativeCurrency,
              rpcUrls: [NET.rpcUrl],
              blockExplorerUrls: [NET.explorerUrl],
            },
          ],
        });
      }
      setAccount(accounts[0]);
      say(`Connected ${accounts[0]} on ${NETWORK_LABEL}.`);
    } catch (e) {
      say(e instanceof Error ? e.message : "Connection failed", true);
    }
  }

  async function shield() {
    const eth = getEthereum();
    if (!eth || !account || !NET || !pub) return;
    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount.trim(), USDG_DECIMALS);
      if (amountWei <= 0n) throw new Error("Amount must be positive.");
    } catch {
      return say("Enter a valid amount.", true);
    }

    setBusy(true);
    try {
      // The pool's own rules (listed asset, deposit limit per deposit), checked before anything else.
      assertDepositAllowed(NET.chainId, USDG, amountWei);
      const gas = await pub.getBalance({ address: account });
      if (gas === 0n) {
        throw new Error(`You need a little ETH on ${NETWORK_LABEL} for gas.${NET.testnet ? " Get it from the Robinhood faucet." : ""}`);
      }
      const held = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [account] });
      if (held < amountWei) {
        throw new Error(
          `You hold ${formatUnits(held, USDG_DECIMALS)} USDG on ${NETWORK_LABEL}.${NET.testnet ? " Get test USDG from the Paxos faucet." : ""}`
        );
      }

      say("Proving in your browser (the first run fetches the circuit)");
      const intent = await buildShieldBoundIntent({
        chainId: NET.chainId,
        poolAddress: NET.pool,
        asset: USDG,
        amountWei,
        prover: artifactProver(circuitArtifactUrls("shield", NET.chainId, ARTIFACTS)),
      });

      const wallet = createWalletClient({ account, chain: NET.chain, transport: custom(eth) });

      // Let the pool pull the USDG, and wait for that approval before depositing.
      const allowance = await pub.readContract({
        address: USDG,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, NET.pool],
      });
      if (allowance < amountWei) {
        say("Approve the pool to pull your USDG in your wallet");
        const approveHash = await wallet.writeContract({
          address: USDG,
          abi: erc20Abi,
          functionName: "approve",
          args: [NET.pool, amountWei],
          account,
        });
        say("Waiting for the approval to confirm");
        const approved = await pub.waitForTransactionReceipt({ hash: approveHash });
        if (approved.status !== "success") throw new Error("The approval reverted.");
      }

      // Keep the note BEFORE anything is sent: a tab closed or a reply lost after the
      // wallet sends must not lose the secret, which is the only way to spend the deposit.
      const note: StoredNote = {
        commitment: intent.note.commitment,
        secret: intent.note.secret,
        amount: formatUnits(amountWei, USDG_DECIMALS),
        symbol: "USDG",
      };
      const next = [note, ...loadNotes()];
      saveNotes(next);
      setNotes(next);

      say("Confirm the deposit in your wallet");
      let hash: Hex;
      try {
        hash = await wallet.writeContract({
          address: intent.exec.poolAddress,
          abi: poolAbi,
          functionName: "shieldBound",
          args: intent.exec.args as readonly [Address, bigint, Hex, Hex],
          value: intent.exec.valueWei,
          account,
        });
      } catch (e) {
        // Only a clear no drops the note. Otherwise it stays, and shows as live if the deposit lands.
        if (walletDeclined(e)) {
          const kept = loadNotes().filter((n) => n.commitment !== note.commitment);
          saveNotes(kept);
          setNotes(kept);
        }
        throw e;
      }
      saveNotes(loadNotes().map((n) => (n.commitment === note.commitment ? { ...n, hash } : n)));

      say("Submitted. Waiting for confirmation");
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted.");
      say("Shielded. Your private balance is confirmed on chain.");
      void refreshLive(next);
    } catch (e) {
      say(e instanceof Error ? e.message : "Shield failed", true);
    } finally {
      setBusy(false);
    }
  }

  const total = notes
    .filter((n) => n.live !== false && n.symbol === "USDG")
    .reduce((sum, n) => sum + parseUnits(n.amount, USDG_DECIMALS), 0n);

  return (
    <main className="wrap">
      <p className="eyebrow">create-gloam-app · {NETWORK_LABEL}</p>
      <h1>Shield a private balance</h1>
      <p className="lede">
        Deposit USDG into a shielded note on {NETWORK_LABEL}
        {"."} The proof is generated in your
        browser; the note secret never leaves it.
      </p>

      <div className="card">
        {!account ? (
          <button onClick={connect} disabled={!NET}>
            Connect wallet
          </button>
        ) : (
          <>
            <label htmlFor="amt">Amount (USDG)</label>
            <div className="row">
              <input
                id="amt"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                disabled={busy}
              />
              <button onClick={shield} disabled={busy}>
                {busy ? "Working" : "Shield privately"}
              </button>
            </div>
          </>
        )}
        <p className={`status${err ? " err" : ""}`}>{status}</p>
      </div>

      <div className="card">
        <label>Your private balance</label>
        <p className="total">{formatUnits(total, USDG_DECIMALS)} USDG</p>
        {notes.length === 0 ? (
          <p className="status">No shielded notes yet.</p>
        ) : (
          notes.map((n) => (
            <div className="note" key={n.commitment}>
              <span className="mono">{n.commitment.slice(0, 10)}…{n.commitment.slice(-6)}</span>
              <span className="mono">
                {n.amount} {n.symbol}
              </span>
              <span className={`pill${n.live ? " live" : ""}`}>
                {n.live === undefined ? "…" : n.live ? "live" : "pending"}
              </span>
            </div>
          ))
        )}
      </div>

      {MAINNET ? (
        <p className="foot">
          Robinhood Chain mainnet, with deposit limits of 50,000 USDG per deposit
          and 2,500,000 USDG across the pool. Direct deposits and private payments are free; cashing out costs 0.5%.
          Proofs use the final keys from the trusted setup. Practice first on testnet with{" "}
          <span className="mono">NEXT_PUBLIC_GLOAM_NETWORK=robinhood</span>. Docs at{" "}
          <a href="https://gloam.trade/docs/sdk" target="_blank" rel="noreferrer">
            gloam.trade/docs/sdk
          </a>
          .
        </p>
      ) : NET ? (
        <p className="foot">
          Robinhood Chain testnet, on dev keys. Get test ETH for gas from the{" "}
          <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noreferrer">
            Robinhood faucet
          </a>{" "}
          and test USDG from the{" "}
          <a href="https://faucet.paxos.com/" target="_blank" rel="noreferrer">
            Paxos faucet
          </a>
          . Docs at{" "}
          <a href="https://gloam.trade/docs/sdk" target="_blank" rel="noreferrer">
            gloam.trade/docs/sdk
          </a>
          .
        </p>
      ) : null}
    </main>
  );
}
