/**
 * When the testnet opened (admin metrics, history only). /app has no gate.
 */

/** Public open: 2026-07-16 13:00 UTC */
const DEFAULT_OPENS_AT = "2026-07-16T13:00:00.000Z";

export function testnetOpensAtMs(): number {
  const raw =
    process.env.NEXT_PUBLIC_TESTNET_OPENS_AT?.trim() || DEFAULT_OPENS_AT;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.parse(DEFAULT_OPENS_AT);
}
