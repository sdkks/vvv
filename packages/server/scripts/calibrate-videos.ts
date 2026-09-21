// Run: pnpm --filter @vvv/server exec tsx scripts/calibrate-videos.ts [corpus] [report.json] [synthetic-count]
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as tick } from 'node:timers/promises';
import Fastify from 'fastify';
import { openDatabase } from '../src/db.js';
import { hamming, processFile, storeHashes } from '../src/hashing.js';
import { Matcher, activeMatchRun } from '../src/matcher.js';
import { videoHash } from '../src/video.js';

const corpus = resolve(process.argv[2] ?? '../../tests/fixtures/data/video');
const root = await mkdtemp(join(tmpdir(), 'vvv-video-calibration-'));
const output = resolve(process.argv[3] ?? join(root, 'report.json'));
const syntheticCount = Number(process.argv[4] ?? 200000);
const { db } = openDatabase(root);
const matcher = new Matcher(db, Fastify({ logger: false }).log);
const files: {
  file: string;
  id: number;
  bytes: number;
  sha_ms: number;
  sampling_ms: number;
  duration_ms?: number;
  error?: string;
}[] = [];
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
let peakRss = process.memoryUsage().rss;
const timer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 25);
const start = performance.now();
const metadata = () => {
  const row = db
    .prepare('SELECT candidate_pairs,skipped_buckets FROM match_runs WHERE id=?')
    .get(activeMatchRun(db)) as { candidate_pairs: number; skipped_buckets: string };
  return {
    candidate_pairs: row.candidate_pairs,
    skipped_buckets: JSON.parse(row.skipped_buckets) as unknown[],
  };
};
const match = async () => {
  const start = performance.now(),
    run = matcher.start();
  await matcher.close();
  if (activeMatchRun(db) !== run) throw new Error('Matching failed');
  return { elapsed_ms: performance.now() - start, ...metadata() };
};
try {
  db.prepare('INSERT INTO scan_dirs(path) VALUES (?)').run(corpus);
  for (const name of (await readdir(corpus)).sort()) {
    if (!/\.(mp4|mkv|avi|mov|webm|m4v|mpg|mpeg|ts|m2ts|wmv|flv)$/i.test(name)) continue;
    const path = join(corpus, name),
      info = await stat(path, { bigint: true });
    const id = Number(
      db
        .prepare(
          "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status) VALUES (1,?,'video',?,?,'pending')"
        )
        .run(name, info.size, info.mtimeNs).lastInsertRowid
    );
    const shaStart = performance.now();
    const sha = await processFile(path);
    const sha_ms = performance.now() - shaStart;
    db.prepare("UPDATE files SET sha256=?,status='hashed' WHERE id=?").run(sha, id);
    const sampleStart = performance.now();
    const entry: (typeof files)[number] = {
      file: name,
      id,
      bytes: Number(info.size),
      sha_ms,
      sampling_ms: 0,
    };
    try {
      // Benchmark-only override: permit a single full-timeline decode up to fifteen minutes.
      const result = await videoHash(path, 9, { timeout: 900000 });
      db.transaction(() => {
        storeHashes(db, id, result.hashes);
        db.prepare("UPDATE files SET width=?,height=?,duration_ms=?,status='done' WHERE id=?").run(
          result.width,
          result.height,
          result.duration_ms,
          id
        );
      })();
      entry.duration_ms = result.duration_ms;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      db.prepare("UPDATE files SET status='error',error=? WHERE id=?").run(entry.error, id);
    }
    entry.sampling_ms = performance.now() - sampleStart;
    files.push(entry);
    console.log(JSON.stringify(entry));
    await writeFile(
      output,
      JSON.stringify({ status: 'sampling', files, work_directory: root }, null, 2)
    );
  }
  const matching = await match();
  const groups = db
    .prepare(
      `SELECT g.id,g.kind,f.rel_path,m.similarity FROM dup_groups g
    JOIN dup_group_members m ON m.group_id=g.id JOIN files f ON f.id=m.file_id ORDER BY g.id,f.id`
    )
    .all();
  const getHashes = db.prepare('SELECT hash FROM phashes WHERE file_id=? ORDER BY frame_idx');
  const getGroups = db.prepare('SELECT group_id FROM dup_group_members WHERE file_id=?');
  const together = (a: number, b: number) => {
    const ids = new Set((getGroups.all(a) as { group_id: number }[]).map((row) => row.group_id));
    return (getGroups.all(b) as { group_id: number }[]).some((row) => ids.has(row.group_id));
  };
  // The supplied generator trims the first source to 60s; its full original is NOT a positive label.
  const label = (file: string) =>
    file.includes('square') || file.includes('middle10s') || file.includes('first10s')
      ? null
      : file === 'original-video1.mp4'
        ? 'source1-full'
        : file.startsWith('original-video1-')
          ? 'source1-60s'
          : file.startsWith('original-video2')
            ? 'source2'
            : file;
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  const pairs = [];
  for (let i = 0; i < files.length; i++)
    for (const b of files.slice(i + 1)) {
      const a = files[i]!;
      if (a.error || b.error) continue;
      const ah = getHashes.all(a.id) as { hash: Buffer }[],
        bh = getHashes.all(b.id) as { hash: Buffer }[];
      const mean = ah.reduce((sum, row, frame) => sum + hamming(row.hash, bh[frame]!.hash), 0) / 9;
      const detected = together(a.id, b.id),
        al = label(a.file),
        bl = label(b.file),
        expected = al !== null && al === bl;
      if (al !== null && bl !== null) {
        if (detected && expected) tp++;
        else if (detected) fp++;
        else if (expected) fn++;
        else tn++;
      }
      pairs.push({
        a: a.file,
        b: b.file,
        mean,
        detected,
        expected: al === null || bl === null ? 'stress/unlabeled' : expected,
      });
    }
  const corpusReport = {
    files,
    groups,
    pairs,
    matching,
    tp,
    fp,
    fn,
    tn,
    precision: tp / (tp + fp) || 0,
    recall: tp / (tp + fn) || 0,
  };
  const base = {
    threshold: 10,
    frames: 9,
    corpus: corpusReport,
    work_directory: root,
    limitation:
      'Small, two-source local corpus only; full original versus trimmed variants and cropped/partial clips are not positive obligations. Threshold remains unverified for broad real libraries. RSS measures Node, not decoder child processes.',
    sampling_timeout_ms: 900000,
    production_default_timeout_ms: 120000,
  };
  await writeFile(output, JSON.stringify({ ...base, status: 'corpus_complete' }, null, 2));
  console.log(JSON.stringify({ corpus_matching: matching, tp, fp, fn, tn, groups }));
  let synthetic: unknown = null;
  if (syntheticCount > 0) {
    // Separate DB preserves sampled media checkpoints for inspection/reuse without another decode.
    const syntheticRoot = await mkdtemp(join(tmpdir(), 'vvv-video-synthetic-'));
    const { db: stress } = openDatabase(syntheticRoot);
    const stressMatcher = new Matcher(stress, Fastify({ logger: false }).log);
    try {
      stress.exec("INSERT INTO scan_dirs(path) VALUES ('/synthetic')");
      const put = stress.prepare(
        "INSERT INTO files(scan_dir_id,rel_path,kind,size,mtime_ns,status,sha256) VALUES (1,?,'video',10,0,'done',?)"
      );
      let seed = 123456789;
      const quarter = Math.floor(syntheticCount / 4),
        buildStart = performance.now();
      for (let start = 0; start < syntheticCount; start += 500) {
        stress.transaction(() => {
          for (let i = start; i < Math.min(start + 500, syntheticCount); i++) {
            const id = Number(
              put.run(`video-${i}`, i >= quarter * 2 && i < quarter * 3 ? 'exact-set' : `sha-${i}`)
                .lastInsertRowid
            );
            const hashes = Array.from({ length: 9 }, () => {
              const hash = Buffer.alloc(8);
              for (let j = 0; j < 8; j++) {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                hash[j] = seed & 255;
              }
              if (i < quarter) hash.fill(0);
              else if (i < quarter * 2) hash.writeBigUInt64BE(0xffff0000ffff0000n);
              else if (i < quarter * 3) hash.writeBigUInt64BE(0x123456789abcdef0n);
              return hash;
            });
            storeHashes(stress, id, hashes);
          }
        })();
        await tick();
      }
      const build_ms = performance.now() - buildStart,
        matchStart = performance.now();
      console.log(JSON.stringify({ synthetic: syntheticCount, build_ms, status: 'matching' }));
      lag.reset();
      const run = stressMatcher.start();
      await stressMatcher.close();
      if (activeMatchRun(stress) !== run) throw new Error('Synthetic match failed');
      synthetic = {
        files: syntheticCount,
        per_class: quarter,
        classes: ['blank', 'title', 'exact copies', 'independent random frames'],
        build_ms,
        elapsed_ms: performance.now() - matchStart,
        metadata: stress.prepare('SELECT candidate_pairs,skipped_buckets FROM match_runs').get(),
        work_directory: syntheticRoot,
        event_loop_lag_ms: { max: lag.max / 1e6, p99: lag.percentile(99) / 1e6 },
      };
    } finally {
      await stressMatcher.close();
      stress.close();
    }
  }
  const report = {
    ...base,
    status: 'complete',
    synthetic,
    elapsed_ms: performance.now() - start,
    node_peak_rss_bytes: peakRss,
    event_loop_lag_ms: { max: lag.max / 1e6, p99: lag.percentile(99) / 1e6 },
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: 'complete',
      output,
      elapsed_ms: report.elapsed_ms,
      synthetic,
      node_peak_rss_bytes: peakRss,
    })
  );
} finally {
  clearInterval(timer);
  lag.disable();
  await matcher.close();
  db.close();
}
