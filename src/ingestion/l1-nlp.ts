/**
 * [L1] Google NLP でエンティティ抽出 → Knowledge Graph MID + 派生クエリ.
 *
 * 入力: seed + 既存候補KWの文字列セット
 * 出力:
 *   - l1_entities にエンティティを保存（MID/wiki/salience込み）
 *   - エンティティ名から派生クエリ（"seed + entity"）を l1_candidates に投入
 *
 * 注意: KG API を直接叩かない実装（NLP API の metadata.mid + wikipedia_url で代替）。
 *        KG API への拡張は Phase 2 以降（Daikiユニット予算判断後）。
 */
import { analyzeEntities, type NlpEntity } from '../lib/google-nlp.js';
import { kwDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { logSourceEvent, upsertCandidates, type IncomingCandidate } from './candidates.js';

export interface NlpL1Options {
  seedKw: string;
  /** Additional queries to harvest entities from (fanout / serp results 等). */
  additionalQueries?: string[];
  /** seed と組み合わせて派生クエリを作るときに使うエンティティの salience 下限。 */
  minSalience?: number;
  /** 上位何件のエンティティを派生クエリ化するか。 */
  topK?: number;
}

function persistEntities(runId: string, sourceQuery: string, entities: NlpEntity[]) {
  const ins = kwDb().prepare(
    `INSERT INTO l1_entities (run_id, source_query, name, type, mid, wikipedia_url, salience, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = kwDb().transaction(() => {
    for (const e of entities) {
      ins.run(
        runId,
        sourceQuery,
        e.name,
        e.type,
        e.mid ?? null,
        e.wikipediaUrl ?? null,
        e.salience,
        JSON.stringify(e.meta),
      );
    }
  });
  tx();
}

export async function ingestNlpL1(
  runId: string,
  opts: NlpL1Options,
): Promise<{ entitiesTotal: number; derivedCandidates: number }> {
  const seed = opts.seedKw;
  const queries = [seed, ...(opts.additionalQueries ?? [])];
  const seen = new Set<string>();
  const uniqueQueries = queries.filter((q) => {
    const k = q.trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const minSalience = opts.minSalience ?? 0; // しきい値はconfig駆動の余地あり：Phase 3で精査
  const topK = opts.topK ?? 20;

  let entitiesTotal = 0;
  const derivedSet = new Set<string>();
  const derivedSources: IncomingCandidate[] = [];

  for (const q of uniqueQueries) {
    let ents: NlpEntity[] = [];
    try {
      ents = await analyzeEntities(q);
    } catch (e) {
      logger.error({ q, err: (e as Error).message }, '[L1] NLP analyzeEntities failed');
      continue;
    }
    logSourceEvent(runId, 'google_nlp', q, ents);
    persistEntities(runId, q, ents);
    entitiesTotal += ents.length;

    const ranked = ents
      .filter((e) => e.salience >= minSalience)
      .sort((a, b) => b.salience - a.salience)
      .slice(0, topK);

    for (const e of ranked) {
      // 派生クエリ: seed + entity_name（重複なし、seedと同一は除外）
      const candidate = `${seed} ${e.name}`.trim();
      const candidateAlt = e.name.trim();
      for (const c of [candidate, candidateAlt]) {
        if (c && c.toLowerCase() !== seed.toLowerCase() && !derivedSet.has(c)) {
          derivedSet.add(c);
          derivedSources.push({
            keyword: c,
            source: {
              provider: 'google_nlp',
              meta: {
                source_query: q,
                entity_name: e.name,
                entity_type: e.type,
                mid: e.mid,
                salience: e.salience,
                composition: c === candidate ? 'seed_plus_entity' : 'entity_only',
              },
            },
          });
        }
      }
    }
    logger.info(
      { q, entities: ents.length, derived: ranked.length },
      '[L1] NLP entities harvested',
    );
  }

  const { inserted, mergedSources } = upsertCandidates(runId, derivedSources);
  logger.info(
    { entitiesTotal, derivedCandidates: derivedSources.length, inserted, mergedSources },
    '[L1] NLP derived candidates persisted',
  );
  return { entitiesTotal, derivedCandidates: derivedSources.length };
}
