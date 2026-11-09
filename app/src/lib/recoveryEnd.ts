/**
 * What the browser (lib/recovery) and the server (lib/recoveryStore and its
 * route) share about recovery keys, so there is one end date.
 */

/**
 * When saves under the version 1 wallet key stop. Nothing is deleted then, and
 * updating the key works the same after this as before it. The server holds
 * this date on its own clock. A browser checks it too, only to save itself a
 * call, so a browser with a wrong clock changes nothing.
 */
export const VERSION1_SAVES_UNTIL = Date.parse("2026-12-01T00:00:00Z");

/**
 * Sent as `v` on every save under a key newer than version 1: the version 2
 * wallet key or a passkey. The server takes a save without it for version 1.
 */
export const NEWER_KEY = 2;
