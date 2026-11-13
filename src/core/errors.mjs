/** Error types shared by core and node. */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{path: string, message: string}[]} errors
   * @param {string} code  'CONFIG' | 'NOT_AUTHORIZED' | 'USAGE' | 'SCHEMA_MISMATCH'
   */
  constructor(message, errors = [], code = 'CONFIG') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.errors = errors;
  }
}

export class TransportError extends Error {
  /** @param {'TIMEOUT'|'NETWORK'|'TLS'|'ABORTED'} code */
  constructor(code, message) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

/**
 * Cancellation error (name 'AbortError', code 'ABORTED'), like DOMException AbortError.
 * runSuite attaches the partial report as `err.report` (flagged `aborted: true`, gate forced FAIL).
 */
export function abortError(message = '점검이 중단되었습니다', extra = {}) {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return Object.assign(err, extra);
}
