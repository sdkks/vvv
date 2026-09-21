// Run: pnpm --filter @vvv/server exec tsx scripts/calibrate-images.ts [corpus] [report.json] [synthetic-count]
import { cp, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as tick } from 'node:timers/promises';
import sharp from 'sharp';
import Fastify from 'fastify';
import { openDatabase } from '../src/db.js';
import { Scanner } from '../src/scanner.js';
import { Matcher, activeMatchRun } from '../src/matcher.js';
import { hamming, hashBands } from '../src/hashing.js';

const corpus = resolve(process.argv[2] ?? '../../tests/fixtures/data/images');
const root = await mkdtemp(join(tmpdir(), 'vvv-calibration-'));
const output = resolve(process.argv[3] ?? join(root, 'report.json'));
const syntheticCount = Number(process.argv[4] ?? 200000);
const media = join(root, 'media');
await mkdir(media);
const labels = new Map<string, { label: string; stress: boolean }>();
for (const name of await readdir(corpus)) {
  if (!/\.(png|jpe?g|webp|tiff|gif|avif)$/i.test(name)) continue;
  await cp(join(corpus, name), join(media, name));
  labels.set(name, { label: name.match(/^(scene-[ab]|exact-copy)/)?.[0] ?? name, stress: false });
}
if (!labels.size)
  throw new Error(
    'No image fixtures; run node tests/fixtures/generate-images.mjs tests/fixtures/data/images'
  );
for (const name of [...labels.keys()].filter((name) => name.endsWith('.png'))) {
  const label = labels.get(name)!.label;
  for (const width of [128, 256, 640])
    for (const quality of [35, 70, 90]) {
      const variant = `${basename(name, '.png')}-${width}-q${quality}.jpg`;
      await sharp(join(media, name)).resize(width).jpeg({ quality }).toFile(join(media, variant));
      labels.set(variant, { label, stress: false });
    }
  const { width, height } = await sharp(join(media, name)).metadata();
  for (const stress of ['crop', 'flip']) {
    const variant = `${name}-${stress}.png`;
    const image = sharp(join(media, name));
    await (
      stress === 'flip'
        ? image.flop()
        : image.extract({ left: 10, top: 10, width: width! - 20, height: height! - 20 })
    )
      .png()
      .toFile(join(media, variant));
    labels.set(variant, { label, stress: true });
  }
}
let seed = 42;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
for (let i = 0; i < 140; i++) {
  const label = `generated-${i}`,
    name = `${label}.jpg`;
  const grid = Array.from({ length: 63 }, () => 30 + random() * 170);
  const rampX = random() * 80 - 40,
    rampY = random() * 80 - 40;
  const tint = Array.from({ length: 3 }, () => random() * 30 - 15);
  const pixels = Buffer.alloc(256 * 192 * 3);
  for (let y = 0; y < 192; y++)
    for (let x = 0; x < 256; x++) {
      const gx = Math.floor(x / 32),
        gy = Math.floor(y / 32),
        dx = (x % 32) / 32,
        dy = (y % 32) / 32;
      const top = grid[gy * 9 + gx]! * (1 - dx) + grid[gy * 9 + gx + 1]! * dx;
      const bottom = grid[(gy + 1) * 9 + gx]! * (1 - dx) + grid[(gy + 1) * 9 + gx + 1]! * dx;
      const luma = Math.max(
        1,
        top * (1 - dy) + bottom * dy + rampX * (x / 256 - 0.5) + rampY * (y / 192 - 0.5)
      );
      // A centered sum of uniforms approximates shot noise: variance grows with luminance.
      let noise = -3;
      for (let n = 0; n < 6; n++) noise += random();
      noise *= Math.sqrt(2 * luma) * 0.6;
      for (let c = 0; c < 3; c++)
        pixels[(y * 256 + x) * 3 + c] = Math.round(
          Math.max(0, Math.min(255, luma + noise + tint[c]!))
        );
    }
  await sharp(pixels, { raw: { width: 256, height: 192, channels: 3 } })
    .jpeg({ quality: 95 })
    .toFile(join(media, name));
  labels.set(name, { label, stress: false });
  if (i >= 60) continue;
  const stress = i % 5 === 0,
    variant = `${label}-${i === 0 ? 'flip' : stress ? 'crop' : 'resize'}.jpg`;
  let image = sharp(join(media, name));
  if (i === 0) image = image.flop();
  else if (stress) image = image.extract({ left: 4, top: 4, width: 248, height: 184 });
  await image
    .resize([128, 256, 384][i % 3]!)
    .jpeg({ quality: [35, 60, 85][i % 3]! })
    .toFile(join(media, variant));
  labels.set(variant, { label, stress });
}
const { db } = openDatabase(root);
const log = Fastify({ logger: false }).log;
const matcher = new Matcher(db, log);
const scanner = new Scanner(db, log);
const measure = async (work: () => Promise<void>) => {
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const initial = process.memoryUsage();
  const peak = { ...initial };
  const timer = setInterval(() => {
    const now = process.memoryUsage();
    for (const key of ['rss', 'heapUsed', 'external'] as const)
      peak[key] = Math.max(peak[key], now[key]);
  }, 10);
  const start = performance.now();
  try {
    await work();
    await tick();
    return {
      elapsed_ms: performance.now() - start,
      initial_memory_bytes: initial,
      peak_memory_bytes: peak,
      event_loop_lag_ms: { max: lag.max / 1e6, p99: lag.percentile(99) / 1e6 },
    };
  } finally {
    clearInterval(timer);
    lag.disable();
  }
};
const match = async () => {
  const id = matcher.start();
  await matcher.close();
  if (activeMatchRun(db) !== id) throw new Error('Match did not activate');
};
const metadata = () => {
  const row = db
    .prepare('SELECT candidate_pairs,skipped_buckets FROM match_runs WHERE id=?')
    .get(activeMatchRun(db)) as { candidate_pairs: number; skipped_buckets: string };
  return {
    candidate_pairs: row.candidate_pairs,
    skipped_buckets: JSON.parse(row.skipped_buckets) as unknown[],
  };
};
try {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(media);
  const measured = await measure(async () => {
    scanner.start();
    while (scanner.current()?.status === 'running') await tick();
    if (scanner.current()?.status !== 'done' || scanner.current()?.errors)
      throw new Error('Corpus scan failed');
    await match();
  });
  const rows = db.prepare('SELECT id,rel_path FROM files ORDER BY id').all() as {
    id: number;
    rel_path: string;
  }[];
  const memberships = db.prepare('SELECT group_id FROM dup_group_members WHERE file_id=?');
  const memberGroups = new Map(
    rows.map((r) => [
      r.id,
      new Set((memberships.all(r.id) as { group_id: number }[]).map((m) => m.group_id)),
    ])
  );
  const together = (a: number, b: number) =>
    [...memberGroups.get(a)!].some((id) => memberGroups.get(b)!.has(id));
  let tp = 0,
    fp = 0,
    fn = 0;
  for (let i = 0; i < rows.length; i++)
    for (const b of rows.slice(i + 1)) {
      const a = rows[i]!,
        al = labels.get(a.rel_path)!,
        bl = labels.get(b.rel_path)!;
      if (al.stress || bl.stress) continue;
      const detected = together(a.id, b.id),
        expected = al.label === bl.label;
      if (detected && expected) tp++;
      else if (detected) fp++;
      else if (expected) fn++;
    }
  const variants = rows.map((r) => {
    const { label, stress } = labels.get(r.rel_path)!;
    const reference = rows.find(
      (v) => labels.get(v.rel_path)!.label === label && !labels.get(v.rel_path)!.stress
    )!;
    return {
      file: r.rel_path,
      label,
      stress,
      reference: reference.rel_path,
      expected: reference.id !== r.id,
      detected: reference.id !== r.id && together(r.id, reference.id),
    };
  });
  const corpusReport = {
    nature:
      'Fixture inputs plus deterministic synthetic luminance ramps, textured gradients and signal-dependent noise; not a representative real-photo corpus.',
    generated: {
      seed: 42,
      originals: 140,
      variants: 60,
      jpeg_qualities: [35, 60, 85],
      crops: 11,
      flips: 1,
    },
    metric_scope:
      'Non-stress pairs only; crop/flip outcomes are listed in variants, excluded from precision/recall.',
    files: rows.length,
    precision: tp / (tp + fp) || 0,
    recall: tp / (tp + fn) || 0,
    tp,
    fp,
    fn,
    variants,
    ...metadata(),
    ...measured,
  };
  console.table(variants);
  const a = Buffer.from('123456789abcdef0', 'hex'),
    b = Buffer.from('f0debc9a78563412', 'hex');
  let checksum = 0;
  const microStart = performance.now();
  for (let i = 0; i < 100000; i++) checksum += hamming(a, b);
  const byte_ms = performance.now() - microStart;
  const bigStart = performance.now();
  for (let i = 0; i < 100000; i++) {
    let n = a.readBigUInt64BE() ^ b.readBigUInt64BE();
    while (n) {
      n &= n - 1n;
      checksum++;
    }
  }
  const hamming_benchmark = {
    iterations: 100000,
    byte_ms,
    bigint_ms: performance.now() - bigStart,
    checksum,
  };
  let synthetic: unknown = null;
  if (syntheticCount > 0) {
    db.exec(
      'DELETE FROM dup_group_members; DELETE FROM dup_groups; DELETE FROM match_runs; DELETE FROM files'
    );
    const put = db.prepare(
      "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256) VALUES (1,?,'image',10,0,'done',?)"
    );
    const phash = db.prepare('INSERT INTO phashes VALUES (?,0,?)');
    const band = db.prepare('INSERT INTO phash_bands VALUES (?,0,?,?)');
    let seed = 123456789;
    const adversarial = Math.min(10000, Math.floor(syntheticCount / 20));
    for (let start = 0; start < syntheticCount; start += 1000) {
      db.transaction(() => {
        for (let i = start; i < Math.min(start + 1000, syntheticCount); i++) {
          const hash = Buffer.alloc(8);
          for (let j = 0; j < 8; j++) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            hash[j] = seed & 255;
          }
          if (i < adversarial) hash.fill(0);
          else if (i < adversarial * 2) hash.writeBigUInt64BE(0xffff0000ffff0000n);
          else if (i < adversarial * 3) hash.writeBigUInt64BE(0x123456789abcdef0n);
          const id = Number(
            put.run(
              `synthetic-${i}`,
              i >= adversarial * 2 && i < adversarial * 3 ? 'exact-set' : `sha-${i}`
            ).lastInsertRowid
          );
          phash.run(id, hash);
          hashBands(hash).forEach((value, index) => band.run(index, value, id));
        }
      })();
      await tick();
    }
    const measured = await measure(match);
    synthetic = {
      files: syntheticCount,
      adversarial_per_class: adversarial,
      ...metadata(),
      ...measured,
    };
  }
  const report = {
    threshold: 6,
    calibration_status: 'OPEN',
    threshold_validity:
      'UNVERIFIED for real libraries: generated fixtures cannot validate a real-photo threshold.',
    corpus: corpusReport,
    synthetic,
    hamming_benchmark,
    work_directory: root,
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ ...report, corpus: { ...corpusReport, variants: undefined } }, null, 2)
  );
  console.log(`Full report: ${output}`);
} finally {
  await scanner.close();
  await matcher.close();
  db.close();
}
