import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** Where uploaded originals live. Keys are always tenant-prefixed (see objectKey). */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface StorageEnv {
  STORAGE_DRIVER: "fs" | "s3";
  STORAGE_DIR?: string;
  S3_ENDPOINT?: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
}

/** Default dev location shared by api and worker (both run this source file from the same place). */
export const DEFAULT_STORAGE_DIR = fileURLToPath(new URL("../../../.data/uploads", import.meta.url));

export function objectKey(tenantId: string, kbId: string, documentId: string, filename: string): string {
  const safe =
    filename
      .normalize("NFKC")
      .replace(/[^\w.\- ]+/g, "_")
      .replace(/^\.+/, "")
      .slice(-120) || "file";
  return `tenants/${tenantId}/kb/${kbId}/docs/${documentId}/${safe}`;
}

export const kbPrefix = (tenantId: string, kbId: string) => `tenants/${tenantId}/kb/${kbId}/`;
export const documentPrefix = (tenantId: string, kbId: string, documentId: string) =>
  `${kbPrefix(tenantId, kbId)}docs/${documentId}/`;

export function createObjectStore(env: StorageEnv): ObjectStore {
  return env.STORAGE_DRIVER === "s3"
    ? s3ObjectStore(env)
    : fsObjectStore(env.STORAGE_DIR ?? DEFAULT_STORAGE_DIR);
}

/** Local filesystem: zero-setup development and small self-hosted installs (mount a volume). */
export function fsObjectStore(root: string): ObjectStore {
  const base = resolve(root);
  const pathFor = (key: string) => {
    const p = resolve(base, key);
    if (p !== base && !p.startsWith(base + sep)) throw new Error("Invalid object key");
    return p;
  };
  return {
    async put(key, body) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async get(key) {
      return new Uint8Array(await readFile(pathFor(key)));
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    async deletePrefix(prefix) {
      await rm(pathFor(prefix), { recursive: true, force: true });
    },
  };
}

/** S3-compatible storage: AWS S3, Cloudflare R2, GCS interoperability, SeaweedFS (docker-compose). */
export function s3ObjectStore(env: StorageEnv): ObjectStore {
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: Boolean(env.S3_ENDPOINT),
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
  const Bucket = env.S3_BUCKET;
  let ready: Promise<void> | undefined;
  const ensureBucket = () => {
    ready ??= client
      .send(new HeadBucketCommand({ Bucket }))
      .then(() => undefined)
      .catch(async () => {
        await client.send(new CreateBucketCommand({ Bucket }));
      });
    return ready;
  };
  return {
    async put(key, body, contentType) {
      await ensureBucket();
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!res.Body) throw new Error(`Object ${key} has no body`);
      return res.Body.transformToByteArray();
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async deletePrefix(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
}
