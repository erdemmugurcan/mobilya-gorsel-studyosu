// Is the app already running, and is its port free?
import net from 'node:net';

export const DEFAULT_PORT = 3000;

// MGS_PORT exists for testing only: Magnific login returns to port 3000.
export function resolvePort(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return DEFAULT_PORT;
  const port = Number(value);
  return port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

export const isThisAppStatus = (status, body) =>
  status === 200 && body !== null && typeof body === 'object' && typeof body.connected === 'boolean';

export async function probeApp(port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/magnific/status`, {
      signal: AbortSignal.timeout(2500),
    });
    return isThisAppStatus(res.status, await res.json());
  } catch {
    return false;
  }
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
