// Google Cloud Storage V4 signed URLs for the private medical-records bucket.
// The browser never sees a raw object path; downloads are minted here, short-
// lived, only after the API's firm + HIPAA-release checks and an audit write.
//
// @google-cloud/storage is lazy-imported so the module loads (and tests run) in
// STORAGE_MODE=mock without the dependency present.
import { config } from "./config.ts";

let real: ((key: string, ttlSec: number) => Promise<string>) | null = null;

export async function signDownloadUrl(key: string, ttlSec: number): Promise<string> {
  if (config.storageMode === "mock") {
    return `https://mock.storage.local/${encodeURIComponent(key)}?ttl=${ttlSec}`;
  }
  if (!real) {
    const mod: any = await import("@google-cloud/storage");
    const Storage = (mod.default ?? mod).Storage ?? mod.Storage; // CJS-under-import() safety
    const bucket = new Storage().bucket(config.recordsBucket);
    real = async (k, ttl) => {
      const [url] = await bucket.file(k).getSignedUrl({
        version: "v4", action: "read", expires: Date.now() + ttl * 1000,
      });
      return url;
    };
  }
  return real(key, ttlSec);
}
