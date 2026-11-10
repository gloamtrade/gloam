/**
 * The SDK's payment request links (packages/sdk/src/requests) against the app's
 * own reader and builder (lib/paymentRequest): for every network and token the
 * SDK knows, the app reads an SDK-built link back field for field with no
 * problems, and builds the very same string from the same request. Also checks
 * that a note the SDK puts in a payment package is the note the app reads.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-sdk-request-link.mts
 */
import assert from "node:assert/strict";
import {
  buildPaymentRequestLink as sdkBuild,
  encodeNotePackage as sdkEncode,
  generateReceiveKey,
  gloamNetworks,
  REQUEST_NOTE_MAX as SDK_NOTE_MAX,
} from "../../packages/sdk/src/index";
import {
  REQUEST_NOTE_MAX,
  buildPaymentRequestLink as appBuild,
  findRequestAsset,
  readPaymentRequest,
  requestParamsFrom,
} from "../src/lib/paymentRequest";
import { decodeNotePackage as appDecode, encodeNotePackage as appEncode } from "../src/lib/notePackage";
import { isNetworkKey, type NetworkKey } from "../src/lib/networks";

let n = 0;
const { tag } = await generateReceiveKey();
assert.equal(SDK_NOTE_MAX, REQUEST_NOTE_MAX, "the same note cap");

const amounts = ["25", "12.5", "0.000001", undefined];
const notes = ["agent-42", "Invoice 042 · October", "a".repeat(80), undefined];
// Only the networks this build runs on: Elysium joins once NEXT_PUBLIC_ELYSIUM_ENABLED is on (lib/elysium.ts).
for (const net of gloamNetworks().filter((x) => isNetworkKey(x.key))) {
  for (const asset of net.assets) {
    for (let i = 0; i < amounts.length; i++) {
      const amount = asset.decimals < 6 && amounts[i]?.includes(".") ? "7" : amounts[i];
      const note = notes[i];
      const name = i === 1 ? "Raeto" : undefined;
      const link = sdkBuild({ payTo: tag, network: net, asset: asset.address, amount, note, name });
      const url = new URL(link);
      const got = readPaymentRequest(requestParamsFrom(url.search, url.hash), "robinhood-mainnet");
      const where = `${net.key} ${asset.symbol} #${i}`;
      assert.ok(got, `${where}: the app sees a request`);
      assert.deepEqual(got.problems, [], `${where}: the app finds nothing wrong`);
      assert.equal(got.to, tag, `${where}: payTo`);
      assert.equal(got.network, net.key, `${where}: network`);
      assert.equal(got.asset?.address.toLowerCase(), asset.address.toLowerCase(), `${where}: token`);
      assert.equal(got.amount, amount ?? null, `${where}: amount`);
      assert.equal(got.note, note ?? null, `${where}: note`);
      assert.equal(got.name, name ?? null, `${where}: name`);
      const appAsset = findRequestAsset(net.key as NetworkKey, asset.address)!;
      const appLink = appBuild({ to: tag, network: net.key as NetworkKey, asset: appAsset, amount: amount ?? "", note, name });
      assert.equal(link, appLink, `${where}: the SDK builds the app's exact link`);
      n += 10;
    }
  }
}

// A payment package with a note: the app reads the SDK's bytes, and the SDK writes the app's.
const pack = {
  pool: "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as const,
  asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const,
  amountWei: "25000000",
  secret: `0x${"12".repeat(31)}` as `0x${string}`,
  commitment: `0x${"34".repeat(32)}` as `0x${string}`,
};
const fromSdk = sdkEncode({ ...pack, note: "agent-42" });
assert.equal((await appDecode(fromSdk)).note, "agent-42", "the app reads the note the SDK packed");
assert.equal(
  fromSdk,
  appEncode({ v: 1, type: "gloam-private-note", scheme: "poseidon", ...pack, note: "agent-42" }),
  "same bytes as the app, note included"
);
assert.equal(
  sdkEncode(pack),
  appEncode({ v: 1, type: "gloam-private-note", scheme: "poseidon", ...pack }),
  "same bytes as the app without a note"
);
n += 3;

console.log(`sdk request link: ${n} checks passed`);
