/**
 * Minimal forward-only schema migrations for SQLite-backed Durable Objects.
 *
 * Each migration is plain SQL, applied once, in order, inside a transaction.
 * Never edit or reorder a migration that has shipped: append a new one.
 */

export interface Migration {
	/** Strictly increasing, starting at 1. */
	version: number;
	name: string;
	sql: string;
}

export function runMigrations(storage: DurableObjectStorage, migrations: readonly Migration[]): void {
	const sql = storage.sql;
	sql.exec(`CREATE TABLE IF NOT EXISTS _migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`);

	const row = sql.exec<{ v: number | null }>("SELECT MAX(version) AS v FROM _migrations").one();
	const current = row.v ?? 0;

	for (const m of migrations) {
		if (m.version <= current) continue;
		storage.transactionSync(() => {
			sql.exec(m.sql);
			sql.exec("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, Date.now());
		});
	}
}
