// Google Cloud Storage V4 signed URLs for the private medical-records bucket.
// The browser never sees a raw object path; downloads are minted here, short-
// lived, only after the API's firm + HIPAA-release checks and an audit write.
//
// @google-cloud/storage is lazy-imported so the module loads (and tests run) in
// STORAGE_MODE=mock without the dependency present.
import { config } from "./config.ts";

type SignOpts = { inline?: boolean; contentType?: string | null };
let real: ((key: string, ttlSec: number, opts: SignOpts) => Promise<string>) | null = null;

export async function signDownloadUrl(key: string, ttlSec: number, opts: SignOpts = {}): Promise<string> {
  if (config.storageMode === "mock") {
    return `https://mock.storage.local/${encodeURIComponent(key)}?ttl=${ttlSec}${opts.inline ? "&inline=1" : ""}`;
  }
  if (!real) {
    const mod: any = await import("@google-cloud/storage");
    const Storage = (mod.default ?? mod).Storage ?? mod.Storage; // CJS-under-import() safety
    const bucket = new Storage().bucket(config.recordsBucket);
    real = async (k, ttl, o) => {
      const [url] = await bucket.file(k).getSignedUrl({
        version: "v4", action: "read", expires: Date.now() + ttl * 1000,
        // Preview: ask GCS to serve inline (and with a viewable content type
        // when the stored one is octet-stream) so the browser renders the
        // document in a tab instead of forcing a download.
        ...(o.inline ? {
          responseDisposition: "inline",
          ...(o.contentType ? { responseType: o.contentType } : {}),
        } : {}),
      });
      return url;
    };
  }
  return real(key, ttlSec, opts);
}
