/**
 * コンプライアンス・フロア注入 (仕様§6):
 *   vertical=medical のとき、db/seeds/compliance_medical.json から必須要素を
 *   compliance_floor_items に展開し、inventory_entities にも 'compliance' 信号で追加する。
 *
 * 法令引用は seed JSON の `verification_needed` を尊重。true なら出力に
 * "TODO:要確認" マーカが付く（条文・公的URLが未確定の場合）。本seedは全て false で確認済。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { kwDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { normalizeKeyword } from '../lib/normalize.js';

interface SeedItem {
  id: string;
  title: string;
  issuer?: string;
  law_or_doc_name?: string;
  article?: string;
  url?: string;
  related_urls?: string[];
  last_revised?: string;
  verification_needed?: boolean;
  notes?: string;
}

interface SeedFile {
  scope: string;
  vertical: string;
  items: SeedItem[];
}

export interface ComplianceFloorResult {
  applied: boolean;
  vertical: string | null;
  inserted: number;
  pendingVerification: number;
  skipReason?: string;
}

const SEED_PATH = resolve('db/seeds/compliance_medical.json');

export async function applyComplianceFloor(runId: string): Promise<ComplianceFloorResult> {
  const db = kwDb();
  const runRow = db
    .prepare(`SELECT vertical FROM runs WHERE run_id=?`)
    .get(runId) as { vertical: string | null } | undefined;
  if (!runRow) throw new Error(`run not found: ${runId}`);
  const vertical = runRow.vertical;

  if (vertical !== 'medical') {
    const reason = `vertical=${vertical} (not medical) → no compliance floor`;
    audit({
      actor: 'system',
      eventType: 'compliance.skip',
      entityType: 'run',
      entityId: runId,
      note: reason,
    });
    return { applied: false, vertical, inserted: 0, pendingVerification: 0, skipReason: reason };
  }

  let seed: SeedFile;
  try {
    seed = JSON.parse(readFileSync(SEED_PATH, 'utf-8')) as SeedFile;
  } catch (e) {
    throw new Error(`compliance seed not loadable at ${SEED_PATH}: ${(e as Error).message}`);
  }

  const insertCompl = db.prepare(
    `INSERT INTO compliance_floor_items
       (run_id, item_id, title, issuer, law_or_doc_name, article, source_url,
        related_urls_json, last_revised, severity, verification_needed, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'required', ?, ?)
     ON CONFLICT(run_id, item_id) DO UPDATE SET
       title=excluded.title, issuer=excluded.issuer,
       law_or_doc_name=excluded.law_or_doc_name, article=excluded.article,
       source_url=excluded.source_url, related_urls_json=excluded.related_urls_json,
       last_revised=excluded.last_revised, severity='required',
       verification_needed=excluded.verification_needed, notes=excluded.notes`,
  );

  const insertInv = db.prepare(
    `INSERT INTO inventory_entities (run_id, entity_key, entity_name, signals_json, score)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, entity_key) DO UPDATE SET
       signals_json=excluded.signals_json`,
  );

  let inserted = 0;
  let pending = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM compliance_floor_items WHERE run_id=?`).run(runId);
    for (const it of seed.items) {
      insertCompl.run(
        runId,
        it.id,
        it.title,
        it.issuer ?? null,
        it.law_or_doc_name ?? null,
        it.article ?? null,
        it.url ?? null,
        it.related_urls ? JSON.stringify(it.related_urls) : null,
        it.last_revised ?? null,
        it.verification_needed ? 1 : 0,
        it.notes ?? null,
      );
      if (it.verification_needed) pending++;
      inserted++;

      // インベントリにも 'compliance' 信号で投入 (推し被覆対象)
      const key = `compliance:${it.id}`;
      const existing = db
        .prepare(`SELECT signals_json FROM inventory_entities WHERE run_id=? AND entity_key=?`)
        .get(runId, key) as { signals_json: string } | undefined;
      const sigs = existing ? new Set(JSON.parse(existing.signals_json) as string[]) : new Set<string>();
      sigs.add('compliance');
      insertInv.run(
        runId,
        key,
        it.title,
        JSON.stringify([...sigs].sort()),
        1, // compliance floor は最高優先 = score=1
      );
    }
  })();

  audit({
    actor: 'system',
    eventType: 'compliance.apply',
    entityType: 'run',
    entityId: runId,
    after: { inserted, pendingVerification: pending, vertical: 'medical' },
  });

  logger.info({ runId, inserted, pending }, '[compliance] floor applied');
  return { applied: true, vertical, inserted, pendingVerification: pending };
}
