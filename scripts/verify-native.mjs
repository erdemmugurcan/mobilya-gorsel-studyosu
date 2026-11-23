// Ships inside every version. Proves that the native image packages really work here, using a
// small generated picture. Run by the launcher with the version folder as the working directory.
import { createRequire } from 'node:module';
import path from 'node:path';

const SIZE = 64;

try {
  const load = createRequire(path.join(process.cwd(), 'package.json'));
  const sharp = load('sharp');
  const { removeBackground } = load('@imgly/background-removal-node');

  const square = await sharp({
    create: { width: SIZE / 2, height: SIZE / 2, channels: 3, background: '#7a4a21' },
  }).png().toBuffer();
  const input = await sharp({
    create: { width: SIZE, height: SIZE, channels: 3, background: '#e8e8e8' },
  }).composite([{ input: square, left: SIZE / 4, top: SIZE / 4 }]).png().toBuffer();

  const blob = await removeBackground(new Blob([new Uint8Array(input)], { type: 'image/png' }), {
    output: { format: 'image/png' },
  });
  const output = Buffer.from(await blob.arrayBuffer());
  const { info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== SIZE || info.height !== SIZE || info.channels !== 4) {
    throw new Error(`unexpected result ${info.width}x${info.height}/${info.channels}`);
  }
  process.exit(0); // The ML runtime keeps worker threads alive.
} catch (err) {
  console.error(`verify-native: ${err?.message ?? err}`);
  process.exit(1);
}
