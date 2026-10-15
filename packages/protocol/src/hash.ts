/**
 * Content identity for a document.
 *
 * Node-free on purpose: the hosted service computes this too, and
 * `crypto.subtle` is the one digest available in both runtimes. Both sides
 * must agree on what "the same text" means, and a second encoding is how
 * they would drift.
 */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
