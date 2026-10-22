/** An error whose message is safe to return to the caller (no URLs, paths or secrets). */
export class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}