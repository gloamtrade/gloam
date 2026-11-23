/**
 * An agent on Solana with Gloam: open the private account its wallet owns,
 * register it once, read the private balance, and (only with --pay) pay
 * another Gloam private account privately.
 *
 * What Solana hides: the asset and the amount of a private payment. The two
 * private accounts are visible, adding money shows the wallet it came from,
 * a cash out shows its destination, asset and amount, and proofs are made by
 * Helius's prover.
 *
 *   npm i @gloamtrade/sdk @heliuslabs/spr@0.9.0-alpha @solana/kit
 *   GLOAM_AGENT_SOLANA_KEY="$(cat ~/.config/solana/agent.json)" node solana-agent.mjs
 *   GLOAM_AGENT_SOLANA_KEY=... node solana-agent.mjs --pay <gloam private address> 0.5
 *
 * Without --pay it moves no money. The first run registers the account, a
 * transaction Gloam's relay pays for (the record's rent), so it costs the
 * agent nothing. The key is read from the environment and
 * never printed.
 */
import {
  closeSolanaAccount,
  isSolanaAccountRegistered,
  openSolanaAccount,
  paySolanaPrivately,
  registerSolanaAccount,
  solanaAsset,
  solanaBalances,
  solanaErrorMessage,
  solanaKeypairWallet,
  SOLANA_PRIVACY_NOTE,
} from "@gloamtrade/sdk/solana";

const secret = process.env.GLOAM_AGENT_SOLANA_KEY;
if (!secret) {
  console.error("Set GLOAM_AGENT_SOLANA_KEY to the agent's Solana keypair (a keypair file's JSON array, or base58).");
  process.exit(1);
}

const wallet = await solanaKeypairWallet(secret);
const account = await openSolanaAccount({ wallet });
console.log(`Main wallet:     ${account.mainAddress}`);
console.log(`Private account: ${account.address} (the same one the Gloam app opens for this wallet)`);
console.log(SOLANA_PRIVACY_NOTE);

try {
  if (!(await isSolanaAccountRegistered(account))) {
    const r = await registerSolanaAccount(account);
    console.log(`Registered, so others can pay it: ${r.signature}`);
  }

  const balances = await solanaBalances(account);
  for (const id of Object.keys(balances)) {
    const a = solanaAsset(id);
    console.log(`  ${a.symbol}: ${Number(balances[id]) / 10 ** a.decimals}`);
  }

  const i = process.argv.indexOf("--pay");
  if (i > 0) {
    const [to, amount] = process.argv.slice(i + 1);
    const usdc = solanaAsset("USDC");
    const raw = BigInt(Math.round(Number(amount) * 10 ** usdc.decimals));
    const sent = await paySolanaPrivately(account, { to, asset: usdc, amount: raw });
    if (sent.state === "landed") console.log(`Paid ${amount} USDC privately: ${sent.explorer}`);
    else console.log(`Sent, not settled yet. Check solanaTxStatus({ signature: "${sent.signature}", blockhash: "${sent.blockhash}" }) before paying again.`);
  }
} catch (e) {
  console.error(solanaErrorMessage(e));
  process.exitCode = 1;
} finally {
  closeSolanaAccount(account);
}
process.exit();
