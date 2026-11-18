export function decodeChunk(text) {
  const raw = atob(text);
  return Uint8Array.from(raw, byte => byte.charCodeAt(0));
}
