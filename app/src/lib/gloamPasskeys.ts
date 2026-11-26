/**
 * The credential ids of the passkeys the signed-in Gloam wallet signs in with
 * (Turnkey's authenticators; public), published by the kit
 * (components/app/TurnkeyPasskeysSync) for parts of the app outside it. One of
 * them opens a Gloam wallet's private account on Starknet (its PRF output,
 * lib/solanaRings/gloamRoot passkeyRoot). Empty for someone who signs in with
 * an email alone, or while no Gloam wallet is signed in.
 */
const NONE: readonly string[] = Object.freeze([]);
let ids: readonly string[] = NONE;
const listeners = new Set<() => void>();

export function setGloamPasskeys(next: readonly string[]) {
  if (next.length === ids.length && next.every((p, i) => p === ids[i])) return;
  ids = next.length ? Object.freeze([...next]) : NONE;
  listeners.forEach((fn) => fn());
}

export function gloamPasskeys(): readonly string[] {
  return ids;
}

export function noGloamPasskeys(): readonly string[] {
  return NONE;
}

export function onGloamPasskeys(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
