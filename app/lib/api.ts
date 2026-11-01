import { useQuery } from "@tanstack/react-query";
import type { ApiError, Me } from "../../shared/api";

export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api${path}`, {
		...init,
		headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as ApiError | null;
		throw new ApiRequestError(res.status, body?.error ?? res.statusText);
	}
	return (res.status === 204 ? null : await res.json()) as T;
}

export const queryKeys = {
	me: ["me"] as const,
};

export function useMe() {
	return useQuery({ queryKey: queryKeys.me, queryFn: () => apiFetch<Me>("/me") });
}
