import { describe, expect, it } from "vitest";
import { toProviderError } from "../src/index.js";

describe("toProviderError", () => {
  it.each([
    [401, "auth"],
    [402, "quota"],
    [403, "permission"],
    [404, "not_found"],
    [429, "rate_limit"],
    [503, "provider"],
    [400, "bad_request"],
  ])("maps HTTP %i to %s", (status, code) => {
    expect(toProviderError({ status, message: "x" }).code).toBe(code);
  });

  it("treats 429 quota messages as quota", () => {
    expect(toProviderError({ status: 429, message: "You exceeded your current quota" }).code).toBe("quota");
  });

  it("redacts the API key and key-shaped tokens", () => {
    const key = "my-secret-key-123456";
    const e = toProviderError({ status: 401, message: `bad key ${key} and sk-abcdefghijklmnop` }, key);
    expect(e.message).not.toContain(key);
    expect(e.message).not.toContain("sk-abcdefghijklmnop");
  });
});
