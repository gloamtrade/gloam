/**
 * Base64 of UTF-8 text, the way every Gloam x402 header and requirement is
 * encoded. Works in Node and the browser without a Buffer dependency. Internal:
 * not exported from the package.
 */
export function toB64(s: string): string {
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(s)));
  return Buffer.from(s, "utf-8").toString("base64");
}

export function fromB64(s: string): string {
  if (typeof atob === "function") return decodeURIComponent(escape(atob(s)));
  return Buffer.from(s, "base64").toString("utf-8");
}
