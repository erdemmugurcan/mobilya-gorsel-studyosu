import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { refreshLogin } from '@/lib/magnific-mcp/client';
import { NO_NETWORK_MSG } from './no-network';

const savedDataDir = process.env.DATA_DIR;
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
});

describe('test network guard', () => {
  it('the global fetch throws for any URL', async () => {
    await expect(fetch('https://mcp.magnific.com/mcp')).rejects.toThrow(NO_NETWORK_MSG);
    await expect(fetch('https://api.magnific.com')).rejects.toThrow(NO_NETWORK_MSG);
  });

  it('a test may unstub globals (the next test checks the guard is back)', () => {
    vi.unstubAllGlobals();
  });

  it('the guard is re-installed after unstubAllGlobals in an earlier test', async () => {
    await expect(fetch('https://example.com')).rejects.toThrow(NO_NETWORK_MSG);
  });

  it('the real SDK auth() through the default baseFetch only ever hits the guard', async () => {
    process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-net-'));
    await expect(refreshLogin()).rejects.toThrow();
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});
