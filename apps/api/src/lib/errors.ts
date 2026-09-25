/** An error whose message is safe to show to staff users. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) =>
  new AppError(404, "not_found", `${what} was not found. It may have been removed, or the link may be wrong.`);

export const forbidden = () =>
  new AppError(403, "forbidden", "You don't have permission to do that. Ask a manager if you need access.");

export const unauthenticated = () =>
  new AppError(401, "unauthenticated", "Your session has ended. Please sign in again.");

/** A 400 validation failure for one field, rendered like zod errors. */
export const fieldError = (path: string, message: string) =>
  new AppError(400, "validation_failed", "Some fields need attention.", [{ path, message }]);
