import type { z } from "zod";
import { HttpError } from "./errors.js";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_request",
      result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      result.error.issues,
    );
  }
  return result.data;
}
