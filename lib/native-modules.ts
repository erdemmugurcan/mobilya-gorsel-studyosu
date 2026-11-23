import { createRequire } from 'node:module';
import path from 'node:path';
import type SharpFactory from 'sharp';
import type { removeBackground } from '@imgly/background-removal-node';

// Loaded from the app's own node_modules at run time. A normal import makes Turbopack put
// hashed symlinks in .next/node_modules, and creating symlinks fails on standard Windows accounts.
const loadFromApp = createRequire(path.join(process.cwd(), 'package.json'));

export const sharp = loadFromApp('sharp') as typeof SharpFactory;

export const imglyRemoveBackground: typeof removeBackground = (...args) =>
  (loadFromApp('@imgly/background-removal-node') as { removeBackground: typeof removeBackground })
    .removeBackground(...args);
