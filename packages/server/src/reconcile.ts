import type Database from 'better-sqlite3';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { exists, type Operation, type Quarantine } from './quarantine.js';

export async function reconcile(db: Database.Database, quarantine: Quarantine) {
  let after = 0;
  for (;;) {
    const rows = db
      .prepare(
        `SELECT * FROM file_operations WHERE status != 'committed'
      AND status IN ('pending','fs_done') AND id>? ORDER BY id LIMIT 100`
      )
      .all(after) as Operation[];
    if (!rows.length) break;
    for (const op of rows) {
      const source = await exists(op.src_path);
      const target = op.dst_path ? await exists(op.dst_path) : false;
      // Never repeat an uncertain mutation. An unperformed intent is discarded; a completed
      // rename/unlink is finalized, including a replacement source after the fs_done checkpoint.
      if (op.kind === 'purge' ? !source : target && (!source || op.status === 'fs_done')) {
        try {
          quarantine.finish(op);
        } catch (error) {
          if (
            error instanceof Error &&
            ['file_unregistered', 'trash_not_found'].includes(error.message)
          )
            quarantine.fail(op, error);
          else throw error;
        }
      } else
        quarantine.fail(
          op,
          source ? (target ? 'destination_exists' : 'interrupted') : 'source_missing'
        );
      after = op.id;
      await yieldLoop();
    }
  }
}
