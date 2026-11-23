import { createMcpProvider } from './magnific-mcp';
import type { ImageProvider } from './types';

export type { ImageProvider } from './types';

/** Magnific Cinematic over MCP: the only provider. */
export function getProvider(): ImageProvider {
  return createMcpProvider();
}
