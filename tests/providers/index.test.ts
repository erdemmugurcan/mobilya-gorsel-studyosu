import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/providers/magnific-mcp', () => ({ createMcpProvider: () => ({ kind: 'mcp', generate: vi.fn() }) }));

import { getProvider } from '@/lib/providers';

describe('getProvider', () => {
  it('always returns the Magnific MCP (Cinematic) provider', () => {
    expect((getProvider() as unknown as { kind: string }).kind).toBe('mcp');
  });
});
