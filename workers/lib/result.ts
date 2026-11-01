/**
 * Errors that cross the Durable Object RPC boundary arrive as plain `Error`s,
 * so expected failures are returned as values instead of thrown.
 */
export type FailureCode =
	| "conflict"
	| "not_found"
	| "invalid"
	| "too_large"
	/** Email Service refused the message; retrying won't help. */
	| "rejected"
	/** Sending failed for now; it will be retried. */
	| "unavailable";

export type Result<T> = { ok: true; value: T } | { ok: false; code: FailureCode; message: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: FailureCode, message: string): Result<never> => ({ ok: false, code, message });
