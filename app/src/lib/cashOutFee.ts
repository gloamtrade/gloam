/**
 * The cash-out fee as copy states it when the chain cannot be read.
 *
 * It must match withdrawFeeBps() on every live mainnet vault. Read on chain
 * 9 November 2026: 50 bps on Robinhood Chain, Tempo, Base, Ethereum and
 * Elysium (raised from 25 on 3 November after the three-day public notice).
 * /token reads the live value per chain and only falls back to this.
 */
export const CASH_OUT_FEE_BPS = 50;

/** The vault's hard cap on the cash-out fee (MAX_WITHDRAW_FEE_BPS): 1%. */
export const MAX_CASH_OUT_FEE_BPS = 100;

/** 50 -> "0.5%", 25 -> "0.25%", 100 -> "1%". */
export function bpsPercent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
