/**
 * Google Search Console — Search Analytics query API.
 * service account 認証（GOOGLE_APPLICATION_CREDENTIALS）。
 *
 * 注意: GSC は「過去にサイトで実際に表示／クリックされたクエリ」を返す。
 *      greenfield モード (= 新規サイト) では空配列。existing/参考サイトがある場合に有効。
 *      seed単位で「seedを含むクエリ」をフィルタして取得する。
 */
import { google } from 'googleapis';
import { env } from './env.js';

let _client: ReturnType<typeof google.searchconsole> | undefined;

async function client() {
  if (!_client) {
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
    }
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    _client = google.searchconsole({ version: 'v1', auth: (await auth.getClient()) as any });
  }
  return _client;
}

export interface GscQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscPullOptions {
  /** Property URL. Defaults to env.GSC_PROPERTY_URL. */
  siteUrl?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  /** Substring filter — only rows whose query contains this. */
  queryContains?: string;
  rowLimit?: number;
}

export async function pullGscQueries(opts: GscPullOptions): Promise<GscQueryRow[]> {
  const siteUrl = opts.siteUrl ?? env.GSC_PROPERTY_URL;
  if (!siteUrl) throw new Error('GSC siteUrl missing (GSC_PROPERTY_URL)');
  const sc = await client();
  const reqBody: any = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    dimensions: ['query'],
    rowLimit: opts.rowLimit ?? 5000,
  };
  if (opts.queryContains) {
    reqBody.dimensionFilterGroups = [
      {
        filters: [{ dimension: 'query', operator: 'contains', expression: opts.queryContains }],
      },
    ];
  }
  const resp = await sc.searchanalytics.query({ siteUrl, requestBody: reqBody });
  const rows = resp.data.rows ?? [];
  return rows.map((r: any) => ({
    query: r.keys?.[0] ?? '',
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}
