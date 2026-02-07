import { z } from 'zod';

export const TickerToCikResponseSchema = z.record(
  z.string(),
  z.object({
    cik_str: z.number(),
    ticker: z.string(),
    title: z.string().optional(),
  })
);

export type FilingItem = {
  accessionNumber: string;
  filingDate: string;
  reportDate?: string | null;
  acceptanceDateTime?: string | null;
  act?: string | null;
  form: string;
  fileNumber?: string | null;
  filmNumber?: string | null;
  items?: string | null;
  size?: number | null;
  isXBRL?: number | null;
  isInlineXBRL?: number | null;
  primaryDocument?: string | null;
  primaryDocDescription?: string | null;
};

function requireSecUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua || ua.trim().length < 10) {
    throw new Error(
      'Missing SEC_USER_AGENT env var (required by SEC). Example: "sec-filings-agent/0.1 (youremail@domain.com)"'
    );
  }
  return ua;
}

function padCik(cik: number | string): string {
  const n = typeof cik === 'string' ? cik.replace(/^0+/, '') : String(cik);
  return n.padStart(10, '0');
}

export function normalizeCik(cik: number | string): string {
  return String(typeof cik === 'number' ? cik : parseInt(cik, 10));
}

export function accessionNoDashes(accession: string): string {
  return accession.replace(/-/g, '');
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: { retries?: number; baseDelayMs?: number }
): Promise<Response> {
  const retries = opts?.retries ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 350;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;

      // SEC can be strict/rate-limited. Retry on transient conditions.
      const retryable =
        res.status === 429 ||
        res.status === 408 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504;

      if (!retryable || attempt === retries) return res;

      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 0;
      const backoffMs = Math.round(baseDelayMs * Math.pow(2, attempt));
      const jitterMs = Math.round(Math.random() * 150);
      await sleep(Math.max(retryAfterMs, backoffMs + jitterMs));
      continue;
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const backoffMs = Math.round(baseDelayMs * Math.pow(2, attempt));
      const jitterMs = Math.round(Math.random() * 150);
      await sleep(backoffMs + jitterMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T>(
  url: string,
  schema?: z.ZodSchema<T>
): Promise<T> {
  const ua = requireSecUserAgent();

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        'User-Agent': ua,
        Accept: 'application/json,text/plain,*/*',
      },
    },
    { retries: 4, baseDelayMs: 350 }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `SEC fetch failed ${res.status} ${res.statusText} for ${url}${text ? `: ${text.slice(0, 200)}` : ''}`
    );
  }

  const data = (await res.json()) as unknown;
  if (schema) return schema.parse(data);
  return data as T;
}

let tickerMapPromise: Promise<Map<string, number>> | null = null;

export async function getTickerMap(): Promise<Map<string, number>> {
  if (!tickerMapPromise) {
    tickerMapPromise = (async () => {
      const url = 'https://www.sec.gov/files/company_tickers.json';
      const obj = await fetchJson(url, TickerToCikResponseSchema);
      const map = new Map<string, number>();
      for (const row of Object.values(obj)) {
        map.set(row.ticker.toUpperCase(), row.cik_str);
      }
      return map;
    })();
  }
  return tickerMapPromise;
}

export async function cikFromTicker(ticker: string): Promise<number> {
  const map = await getTickerMap();
  const cik = map.get(ticker.toUpperCase());
  if (!cik) throw new Error(`Unknown ticker: ${ticker}`);
  return cik;
}

export type SubmissionsRecent = {
  accessionNumber: string[];
  filingDate: string[];
  reportDate?: (string | null)[];
  acceptanceDateTime?: (string | null)[];
  act?: (string | null)[];
  form: string[];
  fileNumber?: (string | null)[];
  filmNumber?: (string | null)[];
  items?: (string | null)[];
  size?: (number | null)[];
  isXBRL?: (number | null)[];
  isInlineXBRL?: (number | null)[];
  primaryDocument?: (string | null)[];
  primaryDocDescription?: (string | null)[];
};

export type SubmissionsResponse = {
  cik: string;
  name?: string;
  tickers?: string[];
  sicDescription?: string;
  filings?: {
    recent?: SubmissionsRecent;
  };
};

const submissionsCache = new Map<
  string,
  { at: number; value: SubmissionsResponse }
>();

export async function getSubmissions(
  cik: number | string,
  opts?: { cacheTtlMs?: number }
): Promise<SubmissionsResponse> {
  const cacheTtlMs = opts?.cacheTtlMs ?? 30_000;
  const normalized = normalizeCik(cik);

  const cached = submissionsCache.get(normalized);
  const now = Date.now();
  if (cached && now - cached.at < cacheTtlMs) return cached.value;

  const url = `https://data.sec.gov/submissions/CIK${padCik(normalized)}.json`;
  const value = await fetchJson<SubmissionsResponse>(url);
  submissionsCache.set(normalized, { at: now, value });
  return value;
}

export function recentFilingsToItems(recent?: SubmissionsRecent): FilingItem[] {
  if (!recent) return [];
  const n = recent.accessionNumber.length;
  const items: FilingItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      accessionNumber: recent.accessionNumber[i]!,
      filingDate: recent.filingDate[i]!,
      reportDate: recent.reportDate?.[i] ?? null,
      acceptanceDateTime: recent.acceptanceDateTime?.[i] ?? null,
      act: recent.act?.[i] ?? null,
      form: recent.form[i]!,
      fileNumber: recent.fileNumber?.[i] ?? null,
      filmNumber: recent.filmNumber?.[i] ?? null,
      items: recent.items?.[i] ?? null,
      size: recent.size?.[i] ?? null,
      isXBRL: recent.isXBRL?.[i] ?? null,
      isInlineXBRL: recent.isInlineXBRL?.[i] ?? null,
      primaryDocument: recent.primaryDocument?.[i] ?? null,
      primaryDocDescription: recent.primaryDocDescription?.[i] ?? null,
    });
  }
  return items;
}

export function buildPrimaryDocUrl(params: {
  cik: number | string;
  accessionNumber: string;
  primaryDocument: string;
}): string {
  const cikNum = normalizeCik(params.cik);
  const acc = accessionNoDashes(params.accessionNumber);
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${params.primaryDocument}`;
}
