// Plain JavaScript (not TypeScript) so the same import path works locally and
// on Vercel, where .ts files are compiled to .js but imports inside .js files
// are not rewritten.
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code machine-readable error code
   * @param {string} message readable explanation
   * @param {unknown} [details] optional extra information
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = code;
    /** @type {unknown} */
    this.details = details;
  }
}
