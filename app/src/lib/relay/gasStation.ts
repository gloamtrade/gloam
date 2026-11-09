/**
 * What the relay will do for a gas station, and when. The rules only: sending
 * lives in lib/relay/server (relayGasStation), through the same lanes as every
 * other relay transaction.
 *
 * Off unless GLOAM_RELAY_GAS_STATION=on. When on, the relay pays for two calls
 * and nothing else: make(wallet) on Borro's factory, and pump(minOut, maxIn) on
 * that wallet's own station. A request names a wallet and a step. The target,
 * the calldata and the value are never taken from it: the station comes from
 * predictStation, so nobody can point the relay at another contract.
 *
 * What one person can cost the relay:
 *  - the station must already hold STATION_MIN_USDG, checked here because pump
 *    on an empty station succeeds and a dry run can't tell
 *  - a wallet with code is refused, and any send estimated over
 *    STATION_MAX_ESTIMATE: pump hands the wallet all its gas, so a contract would
 *    run on ours. That cap also catches one that gains its code after the read
 *  - one request per wallet and step at a time (a lock in lib/relay/server), so
 *    copies sent together can't each pass the checks and burn gas on a no-op
 *  - STATION_WALLET_DAILY sends per wallet, STATION_IP_HOURLY per sender, and
 *    gasStationDailySends for everyone together
 *  - no send above STATION_MAX_GAS_PRICE_WEI, about five times the usual price
 *
 * make and pump take about 280,000 gas together, around $0.013 at 0.02 gwei and
 * $2,250 ETH (Robinhood Chain charges no L1 data fee on top today). The default
 * daily budget is under $1, and about $2 with every send at the gas limit.
 *
 * That budget caps the loss, not the abuse. The USDG a station needs comes back
 * to whoever sent it as ETH, less the swap's fee, so filling the day's budget
 * costs a stranger far less than the 0.25 USDG per wallet looks like: well under
 * $1. Doing so pauses only this feature until the next day.
 *
 * The counts are kept apart: the wallet's count has no IP in its key, and the
 * sender's has no wallet. Both names are keyed hashes (GLOAM_RATE_LIMIT_KEY,
 * lib/mcpRemote/rateLimit) and each key's expiry has a random part, so the two
 * keys one request writes can't be paired by their names or by when they
 * expire. Only the moment they are written is the same.
 */
import { STATION_MAX_PUMP_USDG, STATION_MIN_USDG, type StationState } from "@/lib/gasStation";

export type GasStationStep = "make" | "pump";

export const STATION_WALLET_DAILY = 4;
export const STATION_IP_HOURLY = 12;
/** 0.1 gwei. */
export const STATION_MAX_GAS_PRICE_WEI = 100_000_000n;
/** The largest estimate the relay pays for: an ordinary pump estimates about 254,000 gas. */
export const STATION_MAX_ESTIMATE = 400_000n;
/** Sends a day across everyone, unless GLOAM_RELAY_GAS_STATION_DAILY says otherwise. */
export const STATION_DAILY_DEFAULT = 40;
const STATION_DAILY_MOST = 1_000;

export const STATION_OFF_MESSAGE = "Gas for a fresh wallet is off right now. Nothing was sent.";
export const STATION_NETWORK_MESSAGE = "Gas stations are on Robinhood Chain mainnet only.";
export const STATION_BAD_STEP_MESSAGE = "Unknown step.";
export const STATION_BUSY_MESSAGE = "The relay has done all it can for gas stations today. Your USDG stays at the station. Try again tomorrow.";
export const STATION_WALLET_LIMIT_MESSAGE = "This wallet has reached today's limit. Your USDG stays at the station. Try again tomorrow.";
export const STATION_IP_LIMIT_MESSAGE = "Too many requests from this device. Wait a while and try again.";
export const STATION_GAS_HIGH_MESSAGE = "Gas is unusually high on Robinhood Chain right now. Your USDG stays at the station. Try again shortly.";
export const STATION_IN_FLIGHT_MESSAGE = "This step is already being sent. Wait a few minutes, then check the wallet.";
export const STATION_ESTIMATE_MESSAGE = "This wallet would cost the relay too much gas. Your USDG stays at the station.";
export const STATION_WALLET_CODE_MESSAGE = "This wallet is a contract or points to one, so the relay can't pay for its gas.";
export const STATION_NO_FILL_MESSAGE = "The pool would pay nothing for this right now. Your USDG stays at the station. Try again shortly.";

/** Only the exact word turns this on: anything else, or nothing, leaves it off. */
export function gasStationOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.GLOAM_RELAY_GAS_STATION?.trim() === "on";
}

/** The day's budget for everyone together: GLOAM_RELAY_GAS_STATION_DAILY, or the default when it is not a sensible number. */
export function gasStationDailySends(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GLOAM_RELAY_GAS_STATION_DAILY?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return STATION_DAILY_DEFAULT;
  const n = Number(raw);
  return n >= 1 ? Math.min(n, STATION_DAILY_MOST) : STATION_DAILY_DEFAULT;
}

export type StationRefusal = { code: string; message: string; status: number };

/** Why the relay won't spend gas on this step for this wallet, or null when it will. */
export function stationRefusal(step: GasStationStep, s: Pick<StationState, "made" | "stationUsdg" | "walletHasCode">): StationRefusal | null {
  // pump hands the wallet all its gas: its code would run on the relay's.
  if (s.walletHasCode) return { code: "wallet_code", message: STATION_WALLET_CODE_MESSAGE, status: 409 };
  // Before the two below: an empty station is what make and pump would silently waste gas on.
  if (s.stationUsdg < STATION_MIN_USDG) {
    return { code: "no_usdg", message: "The station doesn't hold enough USDG yet. Try again once the cash out lands.", status: 409 };
  }
  if (step === "make" && s.made) return { code: "already_made", message: "This station is already made.", status: 409 };
  if (step === "pump" && !s.made) return { code: "not_made", message: "This station isn't made yet.", status: 409 };
  return null;
}

/** The most this pump swaps: what the station holds, up to the cap. */
export function pumpMaxIn(stationUsdg: bigint): bigint {
  return stationUsdg < STATION_MAX_PUMP_USDG ? stationUsdg : STATION_MAX_PUMP_USDG;
}

/** A tenth of a percent under the pool's own fill, as Borro's own tools set it. The station still enforces its floor. */
export function pumpMinOut(fill: bigint): bigint {
  return (fill * 999n) / 1000n;
}
