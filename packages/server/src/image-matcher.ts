import type Database from 'better-sqlite3';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { bandProbes, hamming, hashBands } from './hashing.js';

type Image = { id: number; hash: Buffer; size: number; sha256: string | null };
type Node = { parent: number; near: boolean };

export async function matchImages(
  db: Database.Database,
  run: number,
  refresh: (id: number) => void
) {
  const setting = (key: string, fallback: number, max: number) => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
      { value: string } | undefined;
    const value = Number(row?.value ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const cap = setting('phash_bucket_cap', 2000, Number.MAX_SAFE_INTEGER);
  const threshold = setting('image_phash_threshold', 6, 64);
  let slice = performance.now();
  const pause = async () => {
    await yieldLoop();
    slice = performance.now();
  };
  const counts = new Uint32Array(4 * 65536);
  const skipped: { band_idx: number; frame_idx: number; band_val: number; size: number }[] = [];
  const buckets = db.prepare(`SELECT b.band_idx,b.band_val,count(*) AS size FROM phash_bands b
    JOIN files f ON f.id=b.file_id WHERE b.band_idx=? AND b.frame_idx=0 AND b.band_val>?
    AND f.status='done' AND f.kind='image'
    GROUP BY b.band_val ORDER BY b.band_val LIMIT 256`);
  for (let band = 0; band < 4; band++) {
    let value = -1;
    for (;;) {
      const batch = buckets.all(band, value) as {
        band_idx: number;
        band_val: number;
        size: number;
      }[];
      if (!batch.length) break;
      for (const row of batch) {
        counts[band * 65536 + row.band_val] = row.size;
        if (row.size > cap) skipped.push({ ...row, frame_idx: 0 });
        value = row.band_val;
      }
      await pause();
    }
  }
  db.prepare('UPDATE match_runs SET skipped_buckets=? WHERE id=?').run(
    JSON.stringify(skipped),
    run
  );
  const usable = (band: number, value: number) => {
    const count = counts[band * 65536 + value]!;
    return count > 0 && count <= cap;
  };
  const nodes = new Map<number, Node>();
  const find = (id: number): number => {
    let root = id;
    while (nodes.has(root) && nodes.get(root)!.parent !== root) root = nodes.get(root)!.parent;
    while (nodes.has(id) && id !== root) {
      const node = nodes.get(id)!;
      id = node.parent;
      node.parent = root;
    }
    return root;
  };
  const union = (a: number, b: number, near = false) => {
    a = find(a);
    b = find(b);
    if (a > b) [a, b] = [b, a];
    const marked = near || !!nodes.get(a)?.near || !!nodes.get(b)?.near;
    nodes.set(b, { parent: a, near: marked });
    nodes.set(a, { parent: a, near: marked });
  };
  // Seed only image members: a byte-identical video must not enter an image component.
  const exact = db.prepare(`SELECT m.group_id,m.file_id FROM dup_groups g
    JOIN dup_group_members m ON m.group_id=g.id JOIN files f ON f.id=m.file_id
    JOIN phashes p ON p.file_id=f.id AND p.frame_idx=0
    WHERE g.match_run=? AND g.kind='exact' AND f.kind='image' AND f.status='done'
    AND (m.group_id,m.file_id)>(?,?) ORDER BY m.group_id,m.file_id LIMIT 1000`);
  let group = 0,
    member = 0,
    reference = 0;
  for (;;) {
    const batch = exact.all(run, group, member) as { group_id: number; file_id: number }[];
    if (!batch.length) break;
    for (const row of batch) {
      if (row.group_id !== group) reference = row.file_id;
      else union(reference, row.file_id);
      group = row.group_id;
      member = row.file_id;
    }
    await pause();
  }
  const images = db.prepare(`SELECT f.id,p.hash,f.size,f.sha256 FROM phashes p
    JOIN files f ON f.id=p.file_id WHERE f.id>? AND p.frame_idx=0
    AND f.kind='image' AND f.status='done' ORDER BY f.id LIMIT 64`);
  const candidates = db.prepare(`SELECT f.id,p.hash,f.size,f.sha256 FROM phash_bands b
    JOIN files f ON f.id=b.file_id JOIN phashes p ON p.file_id=b.file_id AND p.frame_idx=0
    WHERE b.band_idx=? AND b.frame_idx=0 AND b.band_val=? AND b.file_id>?
    AND f.status='done' AND f.kind='image' ORDER BY b.file_id LIMIT 256`);
  let after = 0,
    candidateCount = 0;
  for (;;) {
    const batch = images.all(after) as Image[];
    if (!batch.length) break;
    for (const source of batch) {
      const bands = hashBands(source.hash);
      for (let band = 0; band < 4; band++) {
        if (!usable(band, bands[band]!)) continue;
        for (const probe of bandProbes(bands[band]!)) {
          if (!usable(band, probe)) continue;
          let cursor = source.id;
          for (;;) {
            const targets = candidates.all(band, probe, cursor) as Image[];
            for (const target of targets) {
              cursor = target.id;
              if (
                source.sha256 !== null &&
                source.size === target.size &&
                source.sha256 === target.sha256
              )
                continue;
              // Count each pair only at its first eligible band, without storing a pair set.
              const other = hashBands(target.hash);
              if (
                bands.some((v, i) => {
                  const xor = v ^ other[i]!;
                  return (
                    i < band && usable(i, v) && usable(i, other[i]!) && (xor & (xor - 1)) === 0
                  );
                })
              )
                continue;
              candidateCount++;
              if (
                find(source.id) !== find(target.id) &&
                hamming(source.hash, target.hash) <= threshold
              )
                union(source.id, target.id, true);
            }
            if (performance.now() - slice >= 15) await pause();
            if (targets.length < 256) break;
          }
        }
      }
      after = source.id;
      if (performance.now() - slice >= 15) await pause();
    }
  }
  db.prepare('UPDATE match_runs SET candidate_pairs=? WHERE id=?').run(candidateCount, run);
  // Disk-backed staging orders components without collecting the full catalog or pair set.
  db.exec(
    'CREATE TEMP TABLE image_components(root INTEGER,file_id INTEGER,PRIMARY KEY(root,file_id))'
  );
  try {
    const insert = db.prepare('INSERT INTO image_components VALUES (?,?)');
    let budget = 0;
    for (const id of nodes.keys()) {
      const root = find(id);
      if (nodes.get(root)?.near) insert.run(root, id);
      if (++budget % 1000 === 0) await pause();
    }
    const roots = db.prepare(`SELECT c.root,min(c.file_id) AS reference FROM image_components c
      JOIN files f ON f.id=c.file_id WHERE c.root>? AND f.status='done'
      GROUP BY c.root HAVING count(*)>1 ORDER BY c.root LIMIT 100`);
    const reference = db.prepare(`SELECT min(c.file_id) AS id FROM image_components c
      JOIN files f ON f.id=c.file_id WHERE c.root=? AND f.status='done'`);
    const rows = db.prepare(`SELECT c.file_id FROM image_components c JOIN files f ON f.id=c.file_id
      WHERE c.root=? AND c.file_id>? AND f.status='done' ORDER BY c.file_id LIMIT 1000`);
    const create =
      db.prepare(`INSERT INTO dup_groups(kind,member_count,total_bytes,reclaimable_bytes,match_run)
      VALUES ('image',0,0,0,?)`);
    const add = db.prepare(`INSERT INTO dup_group_members(group_id,file_id,similarity)
      SELECT ?,p.file_id,phash_distance(p.hash,r.hash) FROM phashes p,phashes r
      JOIN files f ON f.id=p.file_id WHERE p.file_id=? AND r.file_id=?
      AND p.frame_idx=0 AND r.frame_idx=0 AND f.status='done'`);
    let root = 0;
    for (;;) {
      const batch = roots.all(root) as { root: number; reference: number }[];
      if (!batch.length) break;
      for (const component of batch) {
        const id = Number(create.run(run).lastInsertRowid);
        let cursor = 0;
        for (;;) {
          const members = rows.all(component.root, cursor) as { file_id: number }[];
          if (!members.length) break;
          db.transaction(() => {
            const ref = reference.get(component.root) as { id: number };
            for (const row of members) {
              add.run(id, row.file_id, ref.id);
              cursor = row.file_id;
            }
          })();
          await pause();
        }
        db.transaction(() => refresh(id))();
        root = component.root;
      }
      await pause();
    }
  } finally {
    db.exec('DROP TABLE image_components');
  }
  return { candidate_pairs: candidateCount, skipped_buckets: skipped };
}
