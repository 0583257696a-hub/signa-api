import type { Services } from '../../context';
import { hmacHex, timingSafeEqual } from '../../lib/crypto';

/** Storage abstraction over R2 (binary assets never go into D1). */
export interface AssetStore {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, opts: { contentType: string; sha256: string }): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream; contentType: string; size: number; etag: string } | null>;
  delete(key: string): Promise<void>;
  ping(): Promise<boolean>;
}

export class R2AssetStore implements AssetStore {
  constructor(private readonly bucket: R2Bucket) {}
  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, opts: { contentType: string; sha256: string }) {
    await this.bucket.put(key, body, { httpMetadata: { contentType: opts.contentType }, sha256: opts.sha256 });
  }
  async get(key: string) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream', size: obj.size, etag: obj.httpEtag };
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
  async ping() {
    try {
      await this.bucket.head('__readiness_probe__');
      return true;
    } catch {
      return false;
    }
  }
}

/** Allow-list for animation uploads (validated server-side by declared type AND magic bytes). */
export const ALLOWED_ASSET_TYPES: Record<string, { maxBytes: number; magic: (b: Uint8Array) => boolean }> = {
  'model/gltf-binary': { maxBytes: 25 * 1024 * 1024, magic: (b) => ascii(b, 0, 4) === 'glTF' },
  'application/json': { maxBytes: 5 * 1024 * 1024, magic: (b) => b[0] === 0x7b || b[0] === 0x5b }, // keyframe JSON
  'video/mp4': { maxBytes: 50 * 1024 * 1024, magic: (b) => ascii(b, 4, 8) === 'ftyp' },
  'video/webm': { maxBytes: 50 * 1024 * 1024, magic: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
};
const ascii = (b: Uint8Array, s: number, e: number) => String.fromCharCode(...b.slice(s, e));

/** Short-lived signed URL for private, approved assets: served by the Worker, no R2 credentials exposed. */
export async function signedAssetUrl(svc: Services, assetId: string, ttlMs = 15 * 60_000): Promise<string> {
  const exp = svc.now() + ttlMs;
  const sig = await hmacHex(svc.config.APP_SECRET, `asset|${assetId}|${exp}`);
  return `${svc.config.API_BASE_URL}/api/v1/assets/${assetId}/content?exp=${exp}&sig=${sig}`;
}

export async function verifyAssetSignature(svc: Services, assetId: string, exp: string | undefined, sig: string | undefined): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,15}$/.test(exp) || Number(exp) < svc.now()) return false;
  return timingSafeEqual(sig, await hmacHex(svc.config.APP_SECRET, `asset|${assetId}|${exp}`));
}

export const publicAssetUrl = (svc: Services, assetId: string) => `${svc.config.API_BASE_URL}/api/v1/assets/${assetId}/content`;
