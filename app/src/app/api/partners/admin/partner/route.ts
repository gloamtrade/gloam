import type { NextRequest } from "next/server";
import { isAdminAuthenticated } from "@/lib/adminAuth";
import { ApiError, jsonBody, portal } from "@/lib/partnersApi";
import { sameSiteJson } from "@/lib/partnersAuth";
import { getPartner, isTier, migrationNote, partnerView, readPartnerStats, PartnerError } from "@/lib/partners";
import { issueLinkCode, linkCodeView, listLinkCodes, revokeLinkCode } from "@/lib/partnerLinks";
import {
  addressChains,
  countAddresses,
  getPartnerAddresses,
  parseAddressList,
  setPartnerAddresses,
  verifyPartnerAddresses,
} from "@/lib/partnerAddresses";
import { PRIVATE_PAYMENTS_NOT_MATCHED, SWAPS_NOT_MATCHED } from "@/lib/partnerBackfill";
import { networkName } from "@/lib/networks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function admin() {
  if (!(await isAdminAuthenticated())) throw new ApiError(401, "unauthorized", "Admin session required.");
}

function chainsView() {
  return addressChains().map((n) => ({ chainId: n.chainId, key: n.key, name: networkName(n) }));
}

/** The list as the admin sees it: each address, whether it is proven, and the message it signs. */
function addressesView(list: Awaited<ReturnType<typeof getPartnerAddresses>>) {
  return Object.entries(list).flatMap(([chain, byAddr]) =>
    Object.entries(byAddr).map(([address, e]) => ({ chainId: Number(chain), address, verifiedAt: e.verifiedAt, message: e.message, addedAt: e.addedAt }))
  );
}

/** Admin only, GET ?id=&tier=: one partner's breakdown (30 days, one tier), link codes and receiving addresses. */
export async function GET(req: NextRequest) {
  return portal(async () => {
    await admin();
    const q = new URL(req.url).searchParams;
    const tier = isTier(q.get("tier")) ? (q.get("tier") as "mainnet" | "testnet") : "mainnet";
    const partner = await getPartner(q.get("id") ?? "");
    if (!partner) throw new ApiError(404, "not_found", "No partner with that id.");
    const now = Date.now();
    const [stats, codes, addresses, migration] = await Promise.all([
      readPartnerStats(partner.id, { recent: 50, days: 30, tier }),
      listLinkCodes(partner.id),
      getPartnerAddresses(partner.id),
      migrationNote(partner.id),
    ]);
    return {
      data: {
        partner: partnerView(partner),
        stats,
        codes: codes.map((c) => linkCodeView(c, now)),
        addresses: addressesView(addresses),
        addressCount: countAddresses(addresses),
        chains: chainsView(),
        migration,
        notMatched: { privatePayments: PRIVATE_PAYMENTS_NOT_MATCHED, swaps: SWAPS_NOT_MATCHED },
      },
    };
  });
}

/**
 * Admin only:
 *   { id, action: "issueCode", label?, expiresInDays? }
 *   { id, action: "revokeCode", code }
 *   { id, action: "setAddresses", text, chainId?, mode: "replace" | "add" }
 *     text: pasted lines or a CSV (`address` or `chain,address`); a line with no
 *     chain is for chainId. Only the partner's own addresses go in. New ones wait
 *     for a signature before they count.
 *   { id, action: "verifyAddresses", text, chainId? }
 *     lines of `chain,address,signature`: each address's signature of its message
 *     (EIP-191), checked on its chain. A proven address counts in the on-chain match.
 */
export async function POST(req: NextRequest) {
  return portal(async () => {
    if (!sameSiteJson(req)) throw new ApiError(403, "bad_origin", "Change partners from the Gloam site.");
    await admin();
    const body = await jsonBody(req, 600_000);
    const id = typeof body.id === "string" ? body.id : "";
    const partner = await getPartner(id);
    if (!partner) throw new ApiError(404, "not_found", "No partner with that id.");
    const chainOf = () => {
      const chainId = body.chainId == null || body.chainId === "" ? null : Number(body.chainId);
      if (chainId != null && !addressChains().some((n) => n.chainId === chainId)) throw new PartnerError("Pick a mainnet Gloam runs on.", 400, "bad_chain");
      return chainId;
    };
    switch (body.action) {
      case "issueCode": {
        const code = await issueLinkCode({ partnerId: partner.id, label: body.label, expiresInDays: body.expiresInDays, by: "admin" });
        return { data: { code: linkCodeView(code) }, status: 201 };
      }
      case "revokeCode": {
        const revoked = await revokeLinkCode({ code: String(body.code ?? ""), partnerId: partner.id });
        if (!revoked) throw new ApiError(404, "not_found", "This partner has no link code like that.");
        return { data: { code: linkCodeView(revoked) } };
      }
      case "setAddresses": {
        if (typeof body.text !== "string") throw new ApiError(400, "bad_request", "Send the addresses as text.");
        if (body.mode !== "replace" && body.mode !== "add") throw new ApiError(400, "bad_request", 'mode must be "replace" or "add".');
        const parsed = parseAddressList(body.text, chainOf());
        const list = await setPartnerAddresses(partner.id, parsed.entries, body.mode);
        return {
          data: {
            addresses: addressesView(list),
            addressCount: countAddresses(list),
            read: parsed.entries.length,
            rejected: parsed.rejected.slice(0, 50),
            rejectedCount: parsed.rejected.length,
          },
        };
      }
      case "verifyAddresses": {
        if (typeof body.text !== "string") throw new ApiError(400, "bad_request", "Send chain,address,signature lines as text.");
        const parsed = parseAddressList(body.text, chainOf());
        const { results, addresses } = await verifyPartnerAddresses(partner.id, parsed.entries);
        return {
          data: {
            results: results.slice(0, 200),
            proven: results.filter((r) => r.ok).length,
            refused: results.filter((r) => !r.ok).length,
            rejected: parsed.rejected.slice(0, 50),
            addresses: addressesView(addresses),
            addressCount: countAddresses(addresses),
          },
        };
      }
      default:
        throw new ApiError(400, "bad_request", 'action must be "issueCode", "revokeCode", "setAddresses" or "verifyAddresses".');
    }
  });
}
