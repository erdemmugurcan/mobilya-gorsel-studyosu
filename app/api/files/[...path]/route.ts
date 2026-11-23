import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '@/lib/storage/paths';

// Only image files inside these data/ subfolders are ever served. Everything
// else under data/ (magnific-auth.json holds OAuth tokens, history.json,
// spaces.json, design mockups…) must never be reachable from the browser.
const ALLOWED_DIRS = new Set(['uploads', 'cutouts', 'outputs']);

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const notFound = () => new Response('Not found', { status: 404 });

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await ctx.params;
  const root = path.resolve(dataDir());
  let decoded: string[];
  try {
    decoded = segments.map((s) => decodeURIComponent(s));
  } catch {
    return notFound();
  }
  const resolved = path.resolve(root, ...decoded);
  if (!resolved.startsWith(root + path.sep)) return notFound();
  // Check the folder and extension on the RESOLVED path, so `uploads/../x.json`
  // is judged by where it actually lands.
  const parts = path.relative(root, resolved).split(path.sep);
  if (parts.length < 2 || !ALLOWED_DIRS.has(parts[0])) return notFound();
  const type = TYPES[path.extname(resolved).toLowerCase()];
  if (!type) return notFound();
  try {
    const bytes = await fs.readFile(resolved);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': type,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return notFound();
  }
}
