// The mod runtime provides the Uint8Array base64 methods (TC39, shipped in
// V8/JSC); TypeScript 5.x libs do not declare them yet. Type check only: the
// loader reads hooks/, never this file.
interface Uint8ArrayConstructor {
  fromBase64(base64: string, options?: { alphabet?: 'base64' | 'base64url'; lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' }): Uint8Array<ArrayBuffer>
}

interface Uint8Array<TArrayBuffer extends ArrayBufferLike> {
  toBase64(options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }): string
}
