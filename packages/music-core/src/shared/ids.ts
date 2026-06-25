/**
 * ID generation. Uses the Web/Node `crypto.randomUUID` available in both
 * Electron renderer and main (Node >= 18 / modern browsers).
 */

export function newId(): string {
  // globalThis.crypto is present in Node >= 18 and in the renderer.
  return globalThis.crypto.randomUUID();
}
