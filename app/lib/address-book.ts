import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ImportContactsResult, OtherContact, SavedContact, SavedContactInput } from "../../shared/api";
import { apiFetch, apiFileUrl, queryKeys } from "./api";

export const addressBookKeys = {
	all: (mailboxId: string) => [...queryKeys.mailbox(mailboxId), "address-book"] as const,
	saved: (mailboxId: string) => [...queryKeys.mailbox(mailboxId), "address-book", "saved"] as const,
	other: (mailboxId: string) => [...queryKeys.mailbox(mailboxId), "address-book", "other"] as const,
};

/** Every saved contact (at most a few thousand), filtered in the browser. */
export function useSavedContacts(mailboxId: string) {
	return useQuery({
		queryKey: addressBookKeys.saved(mailboxId),
		queryFn: () => apiFetch<SavedContact[]>(`/mailboxes/${mailboxId}/address-book`),
		staleTime: 60_000,
	});
}

export function useOtherContacts(mailboxId: string, enabled = true) {
	return useQuery({
		queryKey: addressBookKeys.other(mailboxId),
		queryFn: () => apiFetch<OtherContact[]>(`/mailboxes/${mailboxId}/address-book/other?limit=1000`),
		enabled,
	});
}

/** The saved contact an address belongs to, if any. */
export function useContactFor(mailboxId: string, address: string): SavedContact | null {
	const { data } = useSavedContacts(mailboxId);
	const a = address.toLowerCase();
	return data?.find((c) => c.emails.includes(a)) ?? null;
}

export function matchesContact(c: SavedContact, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return c.name.toLowerCase().includes(q) || c.company.toLowerCase().includes(q) || c.phone.includes(q) || c.emails.some((e) => e.includes(q));
}

export function useAddressBookActions(mailboxId: string) {
	const queryClient = useQueryClient();
	const refresh = () => {
		queryClient.invalidateQueries({ queryKey: addressBookKeys.all(mailboxId) });
		// Recipient suggestions use saved names.
		queryClient.invalidateQueries({ queryKey: [...queryKeys.mailbox(mailboxId), "contacts"] });
	};
	const base = `/mailboxes/${mailboxId}/address-book`;
	const save = useMutation({
		mutationFn: ({ id, input }: { id?: string; input: SavedContactInput }) =>
			apiFetch<SavedContact>(id ? `${base}/${id}` : base, { method: id ? "PUT" : "POST", body: JSON.stringify(input) }),
		onSuccess: refresh,
	});
	const remove = useMutation({
		mutationFn: (ids: string[]) => apiFetch<{ deleted: number }>(`${base}/delete`, { method: "POST", body: JSON.stringify({ contactIds: ids }) }),
		onSuccess: refresh,
	});
	const importFile = useMutation({
		mutationFn: async (file: File) => {
			if (file.size > 900 * 1024) throw new Error("That file is too big. Import at most about 900 KB at a time.");
			return apiFetch<ImportContactsResult>(`${base}/import`, { method: "POST", body: JSON.stringify({ vcf: await file.text() }) });
		},
		onSuccess: refresh,
	});
	return { save, remove, importFile, exportUrl: apiFileUrl(`${base}.vcf`) };
}
