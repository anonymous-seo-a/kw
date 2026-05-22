/**
 * 密度信号: seed centroid から cosine ≥ density_gap の候補KWを「領域内」とする。
 * 出力: boundary_signals (signal_kind='density', entity_key='kw:<normalized>')
 *
 * 注意: 仕様§4の「embedding密度」は本来エンティティ集合を返すが、NLP creds 未配置で
 * l2_entities が空のため、候補KW自体を fallback entity として記録する。
 * NLP creds 配置後は、各候補の l2_entities を展開して entity 単位で記録すべき (TODO)。
 */
import { kwDb } from '../../lib/db.js';
import { cosine } from '../../lib/voyage.js';
import { loadRunVectors, centroid } from '../../lib/embeddings.js';
import { normalizeKeyword } from '../../lib/normalize.js';
import { thresholds } from '../thresholds.js';
import { logger } from '../../lib/logger.js';

export interface DensitySignalResult {
  threshold: number;
  candidatesTotal: number;
  inRegion: number;
  outOfRegion: number;
}

export async function buildDensitySignal(
  runId: string,
  seedKw: string,
): Promise<DensitySignalResult> {
  const th = thresholds().densityGap;
  const vectors = loadRunVectors(runId);
  if (vectors.length === 0) {
    return { threshold: th, candidatesTotal: 0, inRegion: 0, outOfRegion: 0 };
  }

  const seedVec =
    vectors.find((v) => v.keyword === seedKw)?.vector ?? centroid(vectors.map((v) => v.vector));

  const db = kwDb();
  const insert = db.prepare(
    `INSERT INTO boundary_signals (run_id, signal_kind, entity_key, entity_name, score, source_meta_json)
     VALUES (?, 'density', ?, ?, ?, ?)`,
  );

  let inRegion = 0;
  db.transaction(() => {
    // 重複防止のため既存densityを一旦削除
    db.prepare(`DELETE FROM boundary_signals WHERE run_id=? AND signal_kind='density'`).run(runId);
    for (const v of vectors) {
      const cos = cosine(seedVec, v.vector);
      if (cos < th) continue;
      const key = `kw:${normalizeKeyword(v.keyword)}`;
      insert.run(
        runId,
        key,
        v.keyword,
        cos,
        JSON.stringify({ candidateId: v.candidateId, cosineToSeed: cos }),
      );
      inRegion++;
    }
  })();

  logger.info(
    { runId, threshold: th, total: vectors.length, inRegion },
    '[B] density signal',
  );
  return {
    threshold: th,
    candidatesTotal: vectors.length,
    inRegion,
    outOfRegion: vectors.length - inRegion,
  };
}
