export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason from the response body, e.g. "RECEIPT_402". */
    readonly code: string | null = null,
  ) {
    super(message);
  }
  /** 409: our expected_version was stale; refetch and retry. */
  get isConflict() {
    return this.status === 409;
  }
}
