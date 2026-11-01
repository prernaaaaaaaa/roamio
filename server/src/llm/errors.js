export class LLMError extends Error {
  /**
   * @param {string} message
   * @param {{code?:string, retryable?:boolean, retryAfterMs?:number, cause?:unknown}} [opts]
   */
  constructor(message, { code = 'llm_error', retryable = false, retryAfterMs = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The model answered, but the answer never passed schema + domain validation (after repairs). */
export class StructuredOutputError extends LLMError {
  constructor(issues, { lastData = null, lastText = '' } = {}) {
    super(`Model output failed validation: ${issues.slice(0, 3).join('; ')}`, { code: 'invalid_output' });
    this.name = 'StructuredOutputError';
    this.issues = issues;
    /** Last schema-valid (but domain-invalid) object, when there is one. Used for sanitising. */
    this.lastData = lastData;
    this.lastText = lastText;
  }
}

export const isAbort = (err) => err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 'aborted';
