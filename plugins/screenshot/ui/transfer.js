export function decodeChunk(value){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
export function encodeChunk(value){let text='';for(const b of value)text+=String.fromCharCode(b);return btoa(text);}
