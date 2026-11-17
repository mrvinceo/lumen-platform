import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("api health", () => {
  it("reports liveness without touching the database", async () => {
    const app = await buildApp({ db: {} as never, logLevel: "silent" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports 503 when the database is unreachable", async () => {
    const db = { execute: async () => Promise.reject(new Error("down")) } as never;
    const app = await buildApp({ db, logLevel: "silent" });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
  });
});
