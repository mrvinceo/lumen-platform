import { describe, expect, it } from "vitest";
import { parseServerEnv } from "../src/env.js";

describe("parseServerEnv", () => {
  it("treats blank values from .env files as unset", () => {
    const env = parseServerEnv({
      DATABASE_URL: "postgres://x",
      MASTER_KEY: "k",
      DATABASE_ADMIN_URL: "",
      S3_ENDPOINT: " ",
    });
    expect(env.DATABASE_ADMIN_URL).toBeUndefined();
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("names missing required settings", () => {
    expect(() => parseServerEnv({ DATABASE_URL: "", MASTER_KEY: "" })).toThrow(
      /DATABASE_URL[\s\S]*MASTER_KEY/,
    );
  });
});
