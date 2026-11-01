/** An error that the API turns into a JSON response with this status. */
export class HttpError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}
