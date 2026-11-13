/** In-memory stdout/stderr for in-process CLI tests. No side effects on import. */
export function createMemoryIo({ env = {}, cwd = process.cwd(), transportFactory } = {}) {
  const chunks = { stdout: [], stderr: [] };
  const io = {
    stdout: { write: (s) => { chunks.stdout.push(String(s)); return true; }, isTTY: false },
    stderr: { write: (s) => { chunks.stderr.push(String(s)); return true; }, isTTY: false },
    env,
    cwd,
  };
  if (transportFactory) io.transportFactory = transportFactory;
  return {
    io,
    get stdout() { return chunks.stdout.join(''); },
    get stderr() { return chunks.stderr.join(''); },
  };
}
