/**
 * Google Natural Language API (entity extraction with salience + MID).
 * 認証は GOOGLE_APPLICATION_CREDENTIALS（サービスアカウントJSON）経由。
 */
import { LanguageServiceClient, protos } from '@google-cloud/language';
import { env } from './env.js';

type IEntity = protos.google.cloud.language.v1.IEntity;

let _client: LanguageServiceClient | undefined;

function client(): LanguageServiceClient {
  if (!_client) {
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
    }
    _client = new LanguageServiceClient();
  }
  return _client;
}

export interface NlpEntity {
  name: string;
  type: string;
  mid?: string;
  wikipediaUrl?: string;
  salience: number;
  meta: Record<string, string>;
}

export async function analyzeEntities(text: string, languageCode = 'ja'): Promise<NlpEntity[]> {
  const [resp] = await client().analyzeEntities({
    document: { content: text, type: 'PLAIN_TEXT', language: languageCode },
    encodingType: 'UTF8',
  });
  const out: NlpEntity[] = [];
  for (const e of (resp.entities ?? []) as IEntity[]) {
    out.push({
      name: e.name ?? '',
      type: String(e.type ?? 'UNKNOWN'),
      mid: e.metadata?.mid ?? undefined,
      wikipediaUrl: e.metadata?.wikipedia_url ?? undefined,
      salience: e.salience ?? 0,
      meta: Object.fromEntries(
        Object.entries(e.metadata ?? {}).filter(([k]) => k !== 'mid' && k !== 'wikipedia_url'),
      ),
    });
  }
  return out;
}
