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
  /** @param {'TIMEOUT'|'NETWORK'|'TLS'} code */
  constructor(code, message) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}
