// Secrets aren't in wrangler.jsonc, so `wrangler types` only sees them when a .dev.vars defines
// them. Declaring them here keeps the Env type the same everywhere; at runtime an unset secret
// is undefined, which the code treats like an empty string.
interface CfwMailboxSecrets {
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
	ADMIN_EMAILS: string;
	DEV_USER_EMAIL: string;
	/** Encrypts users' AI provider keys at rest. Any long random string. */
	ENCRYPTION_KEY: string;
}
interface Env extends CfwMailboxSecrets {}
declare namespace Cloudflare {
	interface Env extends CfwMailboxSecrets {}
}
