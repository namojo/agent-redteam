/** Fake OpenAI-compatible endpoint for tests (secure mode by default). No side effects on import. */
import { startMockServer, QUIRK_DEFAULTS } from '../../src/node/mock-server.mjs';

export const QUIRK_NAMES = Object.freeze(Object.keys(QUIRK_DEFAULTS));

export const startFakeOpenAI = (opts = {}) => startMockServer({ mode: 'secure', ...opts });
