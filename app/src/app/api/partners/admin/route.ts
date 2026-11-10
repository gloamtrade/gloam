import type { NextRequest } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { activeKeyCounts } from "@/lib/apiKeys";
import { ApiError, jsonBody, portal } from "@/lib/partnersApi";
import { sameSiteJson } from "@/lib/partnersAuth";
import { isTier, listPartners, migrationNotes, partnerView, readAllPartnerTotals, setApprovedName, setRelayApproved } from "@/lib/partners";
import { kvBackend } from "@/lib/partnersKv";
import { linkCodeState, listLinkCodesFor } from "@/lib/partnerLinks";
import { countAddresses, getPartnerAddressesFor } from "@/lib/partnerAddresses";
import { removePartner } from "@/lib/partnerRemove";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin only, GET ?tier=mainnet|testnet: every partner, their keys, link codes and
 * receiving addresses, and what they brought in on that tier by source, plus the
 * program's totals. Mainnet and testnet are never added together. The store is
 * read in batches, a fixed number of round trips however many partners there are.
 */
export async function GET(req: NextRequest) {
  return portal(async () => {
    if (!(await isAdminAuthenticated())) throw new ApiError(401, "unauthorized", "Admin session required.");
    const raw = new URL(req.url).searchParams.get("tier") ?? "mainnet";
    const tier = isTier(raw) ? raw : "mainnet";
    const backend = kvBackend();
    if (backend === "none") {
      return { data: { backend, tier, partners: [], totals: null } };
    }
    const partners = await listPartners();
    const ids = partners.map((p) => p.id);
    const now = Date.now();
    const [totals, keys, codes, addrs] = await Promise.all([
      readAllPartnerTotals(ids, tier),
      activeKeyCounts(ids),
      listLinkCodesFor(ids, now),
      getPartnerAddressesFor(ids),
    ]);
    // after the totals, which may have just migrated a partner and written its note
    const notes = await migrationNotes(ids);
    return {
      data: {
        backend,
        tier,
        partners: partners.map((p, i) => ({
          ...partnerView(p),
          activeKeys: keys[p.id] ?? 0,
          liveCodes: codes[i]!.filter((c) => linkCodeState(c, now) === "live").length,
          addresses: countAddresses(addrs[i]!),
          totals: totals.byPartner[p.id] ?? null,
          migration: notes[i],
        })),
        totals: totals.program,
      },
    };
  });
}

/**
 * Admin only:
 *   { id, relayApproved: boolean }  an approved account's payment messages use the
 *                                   relay's larger message budget (lib/relay/server, relayMemo)
 *   { id, approveName: boolean }    the account's current name shows in links as
 *                                   "From <name> · Gloam partner"; a later rename needs this again
 *   { id, remove: true }            removes the account for good (lib/partnerRemove): its keys and
 *                                   link codes stop working at once, its addresses and approvals go,
 *                                   and it leaves the list and the totals
 */
export async function POST(req: NextRequest) {
  return portal(async () => {
    if (!sameSiteJson(req)) throw new ApiError(403, "bad_origin", "Change partners from the Gloam site.");
    if (!(await isAdminAuthenticated())) throw new ApiError(401, "unauthorized", "Admin session required.");
    const body = await jsonBody(req);
    if (typeof body.id !== "string") throw new ApiError(400, "bad_request", "Send { id, relayApproved }, { id, approveName } or { id, remove: true }.");
    if (typeof body.relayApproved === "boolean") {
      const partner = await setRelayApproved(body.id, body.relayApproved);
      if (!partner) throw new ApiError(404, "not_found", "No partner with that id.");
      return { data: { partner: partnerView(partner) } };
    }
    if (typeof body.approveName === "boolean") {
      const partner = await setApprovedName(body.id, body.approveName);
      if (!partner) throw new ApiError(404, "not_found", "No partner with that id.");
      return { data: { partner: partnerView(partner) } };
    }
    if (body.remove === true) {
      const removed = await removePartner(body.id);
      if (!removed) throw new ApiError(404, "not_found", "No partner with that id.");
      return { data: { removed } };
    }
    throw new ApiError(400, "bad_request", "Send { id, relayApproved: true | false }, { id, approveName: true | false } or { id, remove: true }.");
  });
}
