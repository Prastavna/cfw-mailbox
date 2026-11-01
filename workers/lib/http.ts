/** An error that the API turns into a JSON response with this status. */
export class HttpError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 426 | 429 | 500 | 502 | 503,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}
