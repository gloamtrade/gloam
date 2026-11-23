/**
 * The connected EVM wallet paying a Relay order on the chain the money is on:
 * an approve (for a token), then the deposit, moving the wallet to that chain
 * first. One path for both bridges in: to the wallet on a Gloam network
 * (components/app/BridgeIn) and to a private account on Solana
 * (components/app/SolanaBridgeIn).
 *
 * Nothing went out unless the deposit reached the wallet: a decline, a refused
 * switch or a failed approval says so plainly. A lost reply on the deposit
 * itself may come after the wallet sent it, so that counts as sent with no
 * hash, and the caller follows the order (Relay says whether it arrived).
 *
 * Checked by scripts/selftest-solana-bridge-in.mts against a fake wallet.
 */
import { erc20Abi, formatUnits, type Address, type Hex } from "viem";
import type { Config } from "wagmi";
import { getAccount, getTransactionReceipt, readContract, sendTransaction, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import type { GloamChainId } from "./networks";
import { failedBeforeSend, surelyNotSent, walletDeclined, walletErrorText } from "./walletErrors";

/** One transaction of a Relay order, as the quote routes hand it over (lib/bridge walletBridgeTxs). */
export type RelayTx = { to: string; data: string; value: string; chainId: number };

/**
 * A connected wallet that can move to another chain and pay there: a browser
 * wallet, a wallet app over WalletConnect, or a Gloam wallet (Turnkey), which
 * switches without a prompt and pays its own network fee. Tempo Wallet lives
 * on Tempo only.
 */
export function walletPaysAcrossChains(type: string | undefined): boolean {
  return type === "injected" || type === "walletConnect" || type === "turnkey";
}

/** What paying asks of the wallet and its chain. wagmiPayActions is the real one. */
export type PayActions = {
  chainId(): number | undefined;
  account(): Address | undefined;
  switchChain(chainId: number): Promise<unknown>;
  send(tx: { to: Address; data: Hex; value: bigint; chainId: number }): Promise<Hex>;
  receipt(hash: Hex, chainId: number): Promise<{ status: "success" | "reverted" }>;
  allowance(token: Address, owner: Address, spender: Address, chainId: number): Promise<bigint | null>;
  wait(ms: number): Promise<void>;
};

export function wagmiPayActions(config: Config): PayActions {
  return {
    chainId: () => getAccount(config).chainId,
    account: () => getAccount(config).address,
    switchChain: (chainId) => switchChain(config, { chainId: chainId as GloamChainId }),
    send: (tx) => sendTransaction(config, { ...tx, chainId: tx.chainId as GloamChainId }),
    // wagmi throws on a reverted receipt, with a reason decoded from raw bytes: read it plainly then
    receipt: (hash, chainId) =>
      waitForTransactionReceipt(config, { hash, chainId: chainId as GloamChainId }).catch(async (e) => {
        const plain = await getTransactionReceipt(config, { hash, chainId: chainId as GloamChainId }).catch(() => null);
        if (plain) return plain;
        throw e;
      }),
    allowance: (token, owner, spender, chainId) =>
      readContract(config, { address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender], chainId: chainId as GloamChainId }).catch(() => null),
    wait: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
}

export type PayResult =
  /** The deposit went to the wallet. No hash: its reply was lost, so follow the order to know. */
  | { sent: true; hash: Hex | null }
  | { sent: false; error: string };

const APPROVE = "0x095ea7b3";

/**
 * Signs `txs` in order on their chain. `onProgress` gets the line to show while
 * the wallet is open (null: nothing to add), `onSwitch` the chain the wallet is
 * about to move to.
 */
export async function payRelayTxs(
  txs: readonly RelayTx[],
  send: { amount: string; symbol: string; chain: string; decimals: number },
  act: PayActions,
  onProgress: (text: string | null) => void,
  onSwitch?: (chainId: number) => void
): Promise<PayResult> {
  if (!txs.length) return { sent: false, error: "The bridge couldn't make a route right now. Try again." };
  let approved = false;
  // Set once the last transaction (the deposit) is handed to the wallet.
  let paying = false;
  try {
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i]!;
      const last = i === txs.length - 1;
      onProgress(txs.length > 1 ? (last ? "Now confirm the bridge in your wallet…" : "Approve in your wallet first (1 of 2)…") : null);
      if (act.chainId() !== tx.chainId) {
        onSwitch?.(tx.chainId);
        await act.switchChain(tx.chainId);
      }
      paying = last;
      const sent = await act.send({ to: tx.to as Address, data: tx.data as Hex, value: BigInt(tx.value), chainId: tx.chainId });
      if (last) return { sent: true, hash: sent };
      const rec = await act.receipt(sent, tx.chainId);
      if (rec.status !== "success") throw new Error("The approval didn't go through.");
      // Some wallets (OKX among them) let the approval be edited down. A bridge
      // above what was approved fails in the wallet's own check, so stop here and
      // say so instead of handing over a deposit that cannot go through.
      if (tx.data.slice(0, 10).toLowerCase() === APPROVE) {
        const spender = `0x${tx.data.slice(34, 74)}` as Address;
        const needed = BigInt(`0x${tx.data.slice(74, 138)}`);
        const owner = act.account();
        const allowed = owner ? await act.allowance(tx.to as Address, owner, spender, tx.chainId) : null;
        if (allowed !== null && allowed < needed) {
          throw new Error(
            `Your wallet approved less than this payment needs (${formatUnits(allowed, send.decimals)} of ${send.amount} ${send.symbol}). Try again and approve the amount shown, without editing it.`
          );
        }
      }
      approved = true;
      // Some wallets check the deposit against a node that hasn't seen the approval yet
      // and call it a failed contract call: give the chain a few seconds first.
      onProgress("Approval done. Getting the bridge ready…");
      await act.wait(4000);
    }
  } catch (err) {
    // Before the deposit, or a clear no from the wallet: nothing went out.
    if (paying && !surelyNotSent(err)) return { sent: true, hash: null };
    return {
      sent: false,
      error: walletDeclined(err)
        ? approved
          ? "You cancelled the bridge. Nothing moved; the approval can be used next time."
          : "You cancelled it in your wallet. Nothing moved."
        : failedBeforeSend(err) && /chain/i.test(walletErrorText(err))
          ? `Switch your wallet to ${send.chain} to bridge from there.`
          : walletErrorText(err) || "It didn't send. Try again.",
    };
  }
  return { sent: false, error: "It didn't send. Try again." };
}
