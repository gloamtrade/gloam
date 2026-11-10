/**
 * Every event name the app sends to /api/collect (lib/track). The intake
 * keeps these and refuses any other name, so the counters only ever hold
 * events the app really sends. A new event is added here; track() won't take
 * a name that isn't.
 */
export const TRACK_EVENTS = [
  "after_claim_cash_out",
  "after_claim_get_paid",
  "after_claim_send",
  "after_claim_swap",
  "agent_topups",
  "app_view",
  "bridge_address_created",
  "bridge_arrived",
  "bridge_private_landed",
  "bridge_private_review",
  "bridge_private_sent",
  "bridge_wallet_review",
  "bridge_wallet_sent",
  "claim_secure",
  "first_pay_nudge_dismiss",
  "first_pay_nudge_open",
  "pageview",
  "payment_request_created",
  "payment_request_opened",
  "payment_request_paid",
  "payroll_run_finished",
  "payroll_run_started",
  "payroll_total_proof_created",
  "private_note_added",
  "private_pay_share",
  "private_pay_success",
  "private_send_submit",
  "proof_create_failed",
  "proof_created",
  "proof_verified",
  "schedule_created",
  "schedule_run",
  "shield_success",
  "swap_review",
  "swap_submit",
  "swap_success",
  "testers_submit",
  "testnet_gate_view",
  "testnet_open",
  "transparency_tab",
  "transparency_view",
  "unshield_private",
  "unshield_scheduled",
  "unshield_success",
  "unshield_xchain",
  "verify_make_own",
  "verify_page_view",
  "wallet_connect",
  "wallet_connect_click",
] as const;

export type TrackEvent = (typeof TRACK_EVENTS)[number];

const KNOWN = new Set<string>(TRACK_EVENTS);

/** Whether a name is one the app sends. */
export function isTrackEvent(name: unknown): name is TrackEvent {
  return typeof name === "string" && KNOWN.has(name);
}
