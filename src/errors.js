/** An error whose message is safe to return to the caller (no URLs, paths or secrets). */
export class JobError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    // Optional list of { code, path, message } — every problem found, not just the first.
    if (details) this.details = details;
  }
}
