"use client";

import Link from "next/link";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Card } from "./ui";
import { ELYSIUM } from "@/lib/elysium";

export function QuickstartPanel({
  origin,
  hasKey,
  liveKeys = false,
  onKeys,
}: {
  origin: string;
  hasKey: boolean;
  /** Gloam runs on a mainnet: live keys exist, and the examples say which key goes where. */
  liveKeys?: boolean;
  onKeys: () => void;
}) {
  const base = origin || "https://gloam.trade";
  const env = liveKeys
    ? `# .env on your server, never in a browser bundle
# These examples use Robinhood Chain testnet (46630) and a test key.
# On mainnet, use a gloam_live_ key and the mainnet's chain id (${ELYSIUM ? `4663, 4217, 8453, 1 or ${ELYSIUM.chainId}` : "4663, 4217, 8453 or 1"}).
GLOAM_API_KEY=gloam_test_…`
    : `# .env on your server, never in a browser bundle
GLOAM_API_KEY=gloam_test_…`;
  const check = `curl ${base}/api/v1/me \\
  -H "Authorization: Bearer $GLOAM_API_KEY"`;
  const sdk = `import { GloamApiClient } from "@gloamtrade/sdk";

const gloam = new GloamApiClient({ apiKey: process.env.GLOAM_API_KEY!${base === "https://gloam.trade" ? "" : `, baseUrl: "${base}"`} });

// A private payment your user proved (buildPrivateSendIntent or buildGloamPayment).
const { hash, attribution } = await gloam.relay(sendIntent);

// A cash out (buildUnshieldIntent): the amount is public, so your fee is a share of it.
await gloam.relay(cashOutIntent);

// A deposit your app helped make, from the user's own wallet (within 24 hours).
await gloam.attributeDeposit({ chainId: 46630, txHash: depositHash });`;
  const relay = `curl ${base}/api/v1/relay \\
  -H "Authorization: Bearer $GLOAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "chainId": 46630, "action": "transfer",
        "proof": "0x…", "root": "0x…", "nullifier": "0x…",
        "commitments": ["0x…", "0x…"] }'`;
  const verify = `curl ${base}/api/v1/proofs/verify \\
  -H "Authorization: Bearer $GLOAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "proof": "gloamfunds1:…" }'`;

  return (
    <div className="space-y-4">
      {!hasKey && (
        <div className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13.5px] text-soft">You need a key first. It takes one click.</p>
          <button type="button" onClick={onKeys} className="btn btn-ink btn-sm shrink-0">
            Make a key
          </button>
        </div>
      )}
      <Card title="Keep the key on your server">
        <CodeBlock code={env} lang="bash" title=".env" />
        <p className="mt-4 text-[13.5px] leading-relaxed text-mute">Check it works. This answers with your app name and fee setting:</p>
        <CodeBlock code={check} lang="bash" title="Terminal" className="mt-3" />
      </Card>
      <Card title="Relay your users' payments with it">
        <p className="mb-3 text-[13.5px] leading-relaxed text-mute">
          Your users prove each payment in their own browser or agent, with the SDK. Your server relays it with your key, and the payment is counted to you.
        </p>
        <CodeBlock code={sdk} lang="ts" title="server.ts" meta="@gloamtrade/sdk" />
        <CodeBlock code={relay} lang="bash" title="Or over plain HTTP" className="mt-3" />
      </Card>
      <Card title="More you can do with the key">
        <CodeBlock code={verify} lang="bash" title="Check a proof of funds, payment or payroll" />
        <p className="mt-4 text-[13.5px] leading-relaxed text-mute">
          Vault status, the public leaf list, payment request links and public figures are in the{" "}
          <Link href="/docs/partners" className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
            API reference
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
