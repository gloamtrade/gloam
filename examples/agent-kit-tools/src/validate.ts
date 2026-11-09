/**
 * Check a tool input against its schema before a handler sees it. Kits do not
 * all validate, and a model can send anything, so the pack does it itself:
 * unknown fields, missing fields, wrong types and over-long strings are
 * refused with a plain reason. A number where the schema wants a string (an
 * amount sent as 25 rather than "25") is taken as its decimal text.
 */
import type { GloamToolDefinition } from "./definitions.js";

export class ToolInputError extends Error {
  readonly code = "bad_input";
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function validateInput(def: GloamToolDefinition, input: unknown): Record<string, unknown> {
  const raw = input ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolInputError(`${def.name} takes an object.`);
  const { properties, required } = def.inputSchema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = properties[k];
    if (!p) throw new ToolInputError(`${def.name} has no field "${k}". It takes: ${Object.keys(properties).join(", ") || "nothing"}.`);
    if (v === undefined || v === null) continue;
    if (p.type === "string") {
      let s: string;
      if (typeof v === "string") s = v;
      else if (typeof v === "number" && Number.isFinite(v)) s = String(v);
      else throw new ToolInputError(`${k} must be a string.`);
      s = s.trim();
      if (p.maxLength !== undefined && s.length > p.maxLength) throw new ToolInputError(`${k} is longer than ${p.maxLength} characters.`);
      if (p.enum && !p.enum.includes(s)) throw new ToolInputError(`${k} must be one of: ${p.enum.join(", ")}.`);
      if (s) out[k] = s;
    } else if (p.type === "number") {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolInputError(`${k} must be a number.`);
      if (p.minimum !== undefined && n < p.minimum) throw new ToolInputError(`${k} must be at least ${p.minimum}.`);
      if (p.maximum !== undefined && n > p.maximum) throw new ToolInputError(`${k} must be at most ${p.maximum}.`);
      out[k] = n;
    } else {
      if (typeof v === "boolean") out[k] = v;
      else if (v === "true" || v === "false") out[k] = v === "true";
      else throw new ToolInputError(`${k} must be true or false.`);
    }
  }
  for (const k of required) {
    if (out[k] === undefined) throw new ToolInputError(`${def.name} needs ${k}.`);
  }
  return out;
}
