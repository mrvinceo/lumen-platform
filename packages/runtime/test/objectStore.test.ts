import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentPrefix, fsObjectStore, objectKey } from "../src/index.js";

describe("fs object store", () => {
  const store = fsObjectStore(mkdtempSync(join(tmpdir(), "lumen-os-")));

  it("round-trips and deletes by prefix", async () => {
    const key = objectKey("t1", "kb1", "d1", "Report Q3.pdf");
    await store.put(key, new Uint8Array([1, 2, 3]));
    expect([...(await store.get(key))]).toEqual([1, 2, 3]);
    await store.deletePrefix(documentPrefix("t1", "kb1", "d1"));
    await expect(store.get(key)).rejects.toThrow();
  });

  it("sanitises filenames and refuses path traversal", async () => {
    expect(objectKey("t", "k", "d", "../../etc/passwd")).toBe("tenants/t/kb/k/docs/d/_.._etc_passwd");
    await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow(/Invalid object key/);
  });
});
