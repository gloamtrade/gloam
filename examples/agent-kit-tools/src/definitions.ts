/**
 * The tools, as data: a name, a description written for a model, and a JSON
 * schema for the input. No framework types, so a kit maps them onto MCP, the
 * Anthropic or OpenAI tool formats, or its own registry in a few lines.
 *
 * Three kinds:
 *   read     reads, and signs or sends nothing (receive moves a payment sent to
 *            this agent into a note only it knows, and never pays anyone else)
 *   preview  checks the request and returns exactly what will be signed or
 *            sent, with a previewId and a digest. Nothing moves.
 *   execute  gloam_execute takes a previewId and does exactly that preview.
 */

export type JsonSchemaProperty = {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

export type JsonObjectSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
};

export type GloamToolKind = "read" | "preview" | "execute";

export interface GloamToolDefinition {
  name: string;
  title: string;
  kind: GloamToolKind;
  description: string;
  inputSchema: JsonObjectSchema;
}

const obj = (properties: Record<string, JsonSchemaProperty>, required: string[] = []): JsonObjectSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const amount = (what: string): JsonSchemaProperty => ({
  type: "string",
  description: `${what}, in the asset's own units as a plain number: "25" is 25 USDG, "12.5" is twelve and a half. A dot for decimals, no commas.`,
  maxLength: 40,
});
const asset: JsonSchemaProperty = {
  type: "string",
  description: "Asset symbol or token address the vault takes (USDG on Robinhood Chain mainnet). Leave it out for the network's first asset.",
  maxLength: 64,
};
const label: JsonSchemaProperty = {
  type: "string",
  description: "Your reference for this payment, such as an order id. Payments with different labels are different payments; one whose answer was lost is never paid twice.",
  maxLength: 80,
};
const note: JsonSchemaProperty = {
  type: "string",
  description: "A private line for the payee (an invoice number, an agent id), up to 80 characters. Only the payee's key reads it.",
  maxLength: 80,
};

const PREVIEW_TAIL = " Returns a preview: exactly what will be signed or sent, with a previewId and a digest. Nothing moves until gloam_execute is called with that previewId.";

export const GLOAM_TOOL_DEFINITIONS: readonly GloamToolDefinition[] = [
  {
    name: "gloam_balance",
    title: "Private balance",
    kind: "read",
    description:
      "The agent's private balance per asset, its Gloam address (a receive tag, gloamr1.…, to share so others can pay it privately), what its wallet holds publicly, and what the owner's spending limits leave for today. A payment spends one note, so largestPayment is the most one payment can be right now. Signs and sends nothing. Set refresh to read the chain and settle any send whose answer was lost.",
    inputSchema: obj({ refresh: { type: "boolean", description: "Read the chain first to settle sends whose answer was lost." } }),
  },
  {
    name: "gloam_receive",
    title: "Pick up payments",
    kind: "read",
    description:
      "Find private payments sent to this agent's Gloam address and secure each one: it is moved into a fresh note only this agent knows, since the payer knew the old one. A payment counts only once it is secured. It never pays anyone else.",
    inputSchema: obj({}),
  },
  {
    name: "gloam_preview_shield",
    title: "Preview: add to the private balance",
    kind: "preview",
    description:
      "Plan a deposit from the agent's wallet into its private balance (USDG on Robinhood Chain mainnet, or another asset the vault takes). The deposit is public: the wallet, the asset and the amount show on chain. Who can spend the note it makes does not. Deposits are free; the wallet pays gas. Mainnet has deposit limits." +
      PREVIEW_TAIL,
    inputSchema: obj({ amount: amount("How much to deposit"), asset }, ["amount"]),
  },
  {
    name: "gloam_preview_pay",
    title: "Preview: pay privately",
    kind: "preview",
    description:
      "Plan a private payment to a Gloam address (gloamr1.…) or a Gloam payment request link. The chain shows a shielded transfer, not the amount, the sender or the payee. Private payments are free. For someone with no Gloam address, use gloam_preview_claim_link." +
      PREVIEW_TAIL,
    inputSchema: obj(
      {
        to: { type: "string", description: "The payee's Gloam address (gloamr1.…) or a payment request link (https://gloam.trade/...).", maxLength: 2048 },
        amount: amount("How much to pay. Leave it out when the request link names the amount"),
        asset,
        note,
        label,
      },
      ["to"]
    ),
  },
  {
    name: "gloam_preview_claim_link",
    title: "Preview: pay by claim link",
    kind: "preview",
    description:
      "Plan a payment by claim link, for someone with no Gloam address: the money moves privately into a note the link opens. The link is a bearer secret, so it never comes back to the model: it goes to the owner's own code (onClaimLink), or sealed to a Gloam address given as sealTo. An unclaimed link can be taken back." +
      PREVIEW_TAIL,
    inputSchema: obj(
      {
        amount: amount("How much the link holds"),
        asset,
        note,
        sealTo: { type: "string", description: "Optional: a Gloam address (gloamr1.…) to seal the link to, so only that key opens it.", maxLength: 512 },
        label,
      },
      ["amount"]
    ),
  },
  {
    name: "gloam_preview_cash_out",
    title: "Preview: cash out",
    kind: "preview",
    description:
      "Plan a cash out from the private balance to a public 0x address. The cash out is the public exit: the asset, the amount and the recipient show, not which private payment funded it. The vault keeps a fee (0.5% on mainnet), read live and shown in the preview. If no single note matches the amount, a private split to itself goes first (free)." +
      PREVIEW_TAIL,
    inputSchema: obj({ amount: amount("How much to cash out, before the fee"), to: { type: "string", description: "The 0x address that receives the money.", maxLength: 42 }, asset }, ["amount", "to"]),
  },
  {
    name: "gloam_preview_prove_funds",
    title: "Preview: prove funds",
    kind: "preview",
    description:
      "Plan a proof that the agent holds at least an amount privately (a gloamfunds1: proof), made for one named reader with an expiry. The proof does not show the balance. It does carry the nullifiers of the notes behind it (up to four), so the reader can check they are unspent. Nothing is signed or sent on chain." +
      PREVIEW_TAIL,
    inputSchema: obj(
      {
        atLeast: amount("The amount to prove the agent holds at least"),
        for: { type: "string", description: "Who the proof is for, exactly as they will see it (a name, a domain). The proof is bound to it.", maxLength: 80 },
        asset,
        expiresInHours: { type: "number", description: "How long the proof stays valid, in hours. Default 168 (a week), at most 2160.", minimum: 1, maximum: 2160 },
      },
      ["atLeast", "for"]
    ),
  },
  {
    name: "gloam_preview_pay_x402",
    title: "Preview: pay an x402 resource privately",
    kind: "preview",
    description:
      "Request a URL. If it answers 402 with a Gloam private price (x402 scheme gloam-private), plan paying it privately: a shielded transfer sealed to the seller's Gloam address, presented as X-PAYMENT on the retry. If it offers scheme gloam-cashout (a gateway that pays out to a public address, on Robinhood Chain), plan a cash out of the quoted amount from the private balance to that address: the payee and the amount are public, the agent's wallet and balance are not. gloam-cashout needs maxAmount. With both offered, gloam-private is used unless prefer says gloam-cashout. A resource that offers only standard x402 (exact) is reported, not paid: pay it with a standard x402 client. A resource that does not answer 402 is returned as is." +
      PREVIEW_TAIL,
    inputSchema: obj(
      {
        url: { type: "string", description: "The https URL of the resource.", maxLength: 2048 },
        method: { type: "string", description: "HTTP method. Default GET.", enum: ["GET", "POST"] },
        body: { type: "string", description: "Request body, for POST.", maxLength: 65_536 },
        contentType: { type: "string", description: "Content-Type of the body. Default application/json.", maxLength: 100 },
        maxAmount: amount("Refuse if the price is above this. Required for gloam-cashout, where it caps the amount cashed out (the price plus the vault's fee)"),
        prefer: { type: "string", description: "Which Gloam scheme to pay when the resource offers both. Default gloam-private.", enum: ["gloam-private", "gloam-cashout"] },
        label,
      },
      ["url"]
    ),
  },
  {
    name: "gloam_execute",
    title: "Execute a preview",
    kind: "execute",
    description:
      "Do exactly what a preview showed, once it is approved. Pass its previewId, and its digest to be sure the approved preview is the one that runs. A preview runs at most once: calling again returns the same result (for an x402 payment that was not served yet, it presents the same payment again). A preview that expired, or whose fee changed, is refused: make a new one.",
    inputSchema: obj(
      {
        previewId: { type: "string", description: "The previewId a gloam_preview_* tool returned.", maxLength: 64 },
        digest: { type: "string", description: "The preview's digest, as approved. Refused if it does not match.", maxLength: 80 },
      },
      ["previewId"]
    ),
  },
  {
    name: "gloam_verify_proof",
    title: "Verify a proof",
    kind: "read",
    description:
      "Check a gloamfunds1: (proof of funds) or gloampay1: (proof of payment) proof against the chain, with the same checks as gloam.trade/verify. ok is true only when every check passes.",
    inputSchema: obj({ proof: { type: "string", description: "The proof text.", maxLength: 65_536 } }, ["proof"]),
  },
];

export type GloamToolName =
  | "gloam_balance"
  | "gloam_receive"
  | "gloam_preview_shield"
  | "gloam_preview_pay"
  | "gloam_preview_claim_link"
  | "gloam_preview_cash_out"
  | "gloam_preview_prove_funds"
  | "gloam_preview_pay_x402"
  | "gloam_execute"
  | "gloam_verify_proof";
