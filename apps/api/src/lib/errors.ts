/** Errors routes throw; the app's error handler turns them into `{ error: { code, message, details? } }`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in to continue.");
export const forbidden = (msg = "Your role does not allow this action.") =>
  new HttpError(403, "forbidden", msg);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found.`);
