import "server-only";
import { GoogleAuthError, GoogleNotFoundError, GoogleTransientError } from "./google/types";

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string; details?: string[]; code?: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/**
 * Turns database errors into messages people can act on.
 * Business-rule messages (CRM01–CRM09) are written for staff and shown as they are.
 * Anything else is logged on the server and replaced with a generic message.
 */
export function toResult(e: unknown): Result<never> {
  const err = e as { code?: string; message?: string; detail?: string };
  switch (err.code) {
    case "CRM01": {
      let details: string[] | undefined;
      try {
        const parsed = err.detail ? JSON.parse(err.detail) : undefined;
        if (Array.isArray(parsed)) details = parsed.map(String);
      } catch {
        /* detail was plain text */
      }
      return { ok: false, error: err.message ?? "That change is not allowed.", details, code: "rule" };
    }
    case "CRM03":
    case "42501":
      return { ok: false, error: err.code === "CRM03" ? err.message! : "You do not have permission to do this.", code: "forbidden" };
    case "CRM04":
      return { ok: false, error: err.message ?? "This record does not exist or is not assigned to you.", code: "not_found" };
    case "CRM09":
      return { ok: false, error: "Someone else saved this record while you were editing.", code: "conflict" };
    case "23505":
      return { ok: false, error: "That already exists.", code: "duplicate" };
    default:
      console.error("[crm] unexpected error", e);
      return { ok: false, error: "Something went wrong on the server. Please try again.", code: "server" };
  }
}

/** Runs an action and converts any thrown error into a Result. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message, code: "unauthenticated" };
    if (e instanceof ValidationError) return { ok: false, error: e.message, details: e.details, code: "invalid" };
    if (e instanceof GoogleAuthError) return { ok: false, error: e.message, code: "google_reconnect" };
    if (e instanceof GoogleNotFoundError) return { ok: false, error: e.message, code: "google_not_found" };
    if (e instanceof GoogleTransientError) return { ok: false, error: e.message, code: "google_retry" };
    return toResult(e);
  }
}

export class AuthError extends Error {}
export class ValidationError extends Error {
  constructor(message: string, public details?: string[]) {
    super(message);
  }
}

/** Thrown by server code for manager-only actions (same message style as the database). */
export function forbidden(message = "Only managers can do this."): never {
  throw Object.assign(new Error(message), { code: "CRM03" });
}
