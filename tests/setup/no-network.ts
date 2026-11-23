import { beforeEach, vi } from 'vitest';

// No test may ever reach a real server (an earlier test once reached Magnific). The global
// fetch throws unless a test stubs its own; it is re-installed before every test because some
// files call vi.unstubAllGlobals() in afterEach. Code under test that needs HTTP takes an
// injected fetch (fetchImpl / fetchFn / putUpload).
export const NO_NETWORK_MSG = 'network disabled in tests';

const blockFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      throw new Error(`${NO_NETWORK_MSG}: ${String(url)}`);
    }),
  );

blockFetch();
beforeEach(blockFetch);
