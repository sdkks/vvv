// Builds a deterministic synthetic image corpus for duplicate-detection tests.
// No copyrighted material: every image is generated locally with sharp.
// Usage: node tests/fixtures/generate-images.mjs <output-dir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// sharp lives in the server workspace's dependencies; resolve it from there so
// the script runs from any working directory.
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const sharp = require('sharp');

const outDir = process.argv[2] ?? 'data/images';
await mkdir(outDir, { recursive: true });

// Deterministic pseudo-random generator so the corpus is reproducible.
let seed = 42;
const next = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

async function base(name, width, height, hue) {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="hsl(${hue},60%,85%)"/>
    ${Array.from({ length: 8 }, (_, i) => {
      const x = Math.floor(next() * width);
      const y = Math.floor(next() * height);
      const r = 8 + Math.floor(next() * Math.min(width, height) / 5);
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${(hue + i * 30) % 360},70%,45%)" opacity="0.8"/>`;
    }).join('')}
    <text x="12" y="28" font-size="22" font-family="sans-serif" fill="hsl(${hue},80%,20%)">${name}</text>
  </svg>`;
  return Buffer.from(svg);
}

const write = async (name, buffer) => {
  await sharp(buffer).toFile(join(outDir, name));
  console.log('created:', name);
};

// Group A: one scene plus resized/re-encoded/quality variants (should group as near-duplicates)
const a = await base('scene-a', 800, 600, 210);
await write('scene-a.png', a);
await write('scene-a-640.jpg', await sharp(a).resize(640).jpeg({ quality: 82 }).toBuffer());
await write('scene-a-320.webp', await sharp(a).resize(320).webp({ quality: 70 }).toBuffer());
await write('scene-a-q40.jpg', await sharp(a).resize(800).jpeg({ quality: 40 }).toBuffer());

// Group B: different scene, with its own variants
const b = await base('scene-b', 1024, 768, 40);
await write('scene-b.png', b);
await write('scene-b-480.jpg', await sharp(b).resize(480).jpeg({ quality: 85 }).toBuffer());

// Uniques: distinct scenes with no duplicates
for (const [name, w, h, hue] of [
  ['unique-1', 640, 480, 120],
  ['unique-2', 500, 500, 300],
  ['unique-3', 720, 405, 10],
]) {
  await write(`${name}.jpg`, await sharp(await base(name, w, h, hue)).jpeg({ quality: 88 }).toBuffer());
}

// Exact duplicates (byte-identical copies)
const exact = await base('exact-source', 600, 400, 160);
const exactJpeg = await sharp(exact).jpeg({ quality: 90 }).toBuffer();await write('exact-copy-1.jpg', exactJpeg);
await write('exact-copy-2.jpg', exactJpeg);

console.log('image corpus complete');
