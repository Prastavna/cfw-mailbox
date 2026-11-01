/**
 * Errors that cross the Durable Object RPC boundary arrive as plain `Error`s,
 * so expected failures are returned as values instead of thrown.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; code: "conflict" | "not_found" | "invalid"; message: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: "conflict" | "not_found" | "invalid", message: string): Result<never> => ({ ok: false, code, message });
