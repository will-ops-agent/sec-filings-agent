import { z } from 'zod';

import { createAgentApp } from '@lucid-agents/hono';

import { createAgent } from '@lucid-agents/core';
import { createAxLLMClient } from '@lucid-agents/core/axllm';
import { http } from '@lucid-agents/http';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { wallets, walletsFromEnv } from '@lucid-agents/wallet';
import {
  identity,
  identityFromEnv,
  createAgentIdentity,
  getTrustConfig,
  generateAgentMetadata,
} from '@lucid-agents/identity';

import {
  cikFromTicker,
  getSubmissions,
  recentFilingsToItems,
  buildPrimaryDocUrl,
  type FilingItem,
} from './sec';

const builder = createAgent({
  name: process.env.AGENT_NAME ?? 'sec-filings-agent',
  version: process.env.AGENT_VERSION ?? '0.1.0',
  description:
    process.env.AGENT_DESCRIPTION ??
    'Fetch SEC EDGAR filings and generate LLM summaries, paywalled via x402.',
})
  .use(http())
  .use(wallets({ config: walletsFromEnv() }))
  .use(
    identity({
      config: {
        ...identityFromEnv(),
        autoRegister: process.env.REGISTER_IDENTITY === 'true',
      },
    })
  );

// Payments are required for paid endpoints.
// We allow boot without payments for local scaffolding (endpoints will still run, but not paywalled).
if (process.env.PAYMENTS_RECEIVABLE_ADDRESS?.trim()) {
  builder.use(payments({ config: paymentsFromEnv() }));
} else {
  console.warn(
    '[sec-filings-agent] PAYMENTS_RECEIVABLE_ADDRESS not set; payments middleware disabled.'
  );
}

const agent = await builder.build();

const { app, addEntrypoint } = await createAgentApp(agent);

// ERC-8004 identity bootstrap (optional)
if (process.env.REGISTER_IDENTITY === 'true') {
  const identityResult = await createAgentIdentity({
    runtime: agent,
    domain: process.env.AGENT_DOMAIN,
    autoRegister: true,
    rpcUrl: process.env.RPC_URL,
    chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : undefined,
  });

  if (identityResult.didRegister) {
    const metadata = generateAgentMetadata(identityResult, {
      name: process.env.AGENT_NAME,
      description: process.env.AGENT_DESCRIPTION,
    });

    console.log('Registered agent on-chain:', identityResult.transactionHash);
    console.log(
      `Host metadata at: https://${identityResult.domain}/.well-known/agent-metadata.json`
    );
    console.log(JSON.stringify(metadata, null, 2));
  }

  const trustConfig = getTrustConfig(identityResult);
  if (trustConfig) {
    (agent as any).trust = trustConfig;
  }
}

const tickerToCikInput = z.object({
  ticker: z.string().min(1),
});

addEntrypoint({
  key: 'mappings.ticker-to-cik',
  description: 'Resolve a stock ticker (e.g., TSLA) to an SEC CIK.',
  input: tickerToCikInput,
  price: '0',
  handler: async ctx => {
    const input = ctx.input as z.infer<typeof tickerToCikInput>;
    const cik = await cikFromTicker(input.ticker);
    return {
      output: {
        ticker: input.ticker.toUpperCase(),
        cik,
      },
    };
  },
});

const filingLookupInput = z
  .object({
    ticker: z.string().min(1).optional(),
    cik: z.union([z.string().min(1), z.number()]).optional(),
    forms: z.array(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .refine(v => v.ticker || v.cik, { message: 'Provide either ticker or cik.' });

addEntrypoint({
  key: 'filings.recent',
  description:
    'Get recent SEC EDGAR filings for a ticker or CIK (includes primary document URL when available).',
  input: filingLookupInput,
  price: '0.01',
  handler: async ctx => {
    const input = ctx.input as z.infer<typeof filingLookupInput>;

    const cik =
      input.cik ?? (input.ticker ? await cikFromTicker(input.ticker) : undefined);
    if (!cik) throw new Error('Unable to resolve CIK');

    const submissions = await getSubmissions(cik);
    const recent = recentFilingsToItems(submissions.filings?.recent);

    const formsSet = input.forms?.length
      ? new Set(input.forms.map(f => f.toUpperCase()))
      : null;

    const filings = recent
      .filter(item => (formsSet ? formsSet.has(item.form.toUpperCase()) : true))
      .slice(0, input.limit)
      .map(item => ({
        ...item,
        primaryDocUrl:
          item.primaryDocument && item.accessionNumber
            ? buildPrimaryDocUrl({
                cik: submissions.cik,
                accessionNumber: item.accessionNumber,
                primaryDocument: item.primaryDocument,
              })
            : undefined,
      }));

    return {
      output: {
        cik: submissions.cik,
        name: submissions.name,
        tickers: submissions.tickers,
        filings,
      },
    };
  },
});

addEntrypoint({
  key: 'filings.latest',
  description:
    'Get the latest SEC EDGAR filing for a ticker or CIK (optionally filtered by form types).',
  input: filingLookupInput,
  price: '0.01',
  handler: async ctx => {
    const input = ctx.input as z.infer<typeof filingLookupInput>;

    const cik =
      input.cik ?? (input.ticker ? await cikFromTicker(input.ticker) : undefined);
    if (!cik) throw new Error('Unable to resolve CIK');

    const submissions = await getSubmissions(cik);
    const recent = recentFilingsToItems(submissions.filings?.recent);

    const formsSet = input.forms?.length
      ? new Set(input.forms.map(f => f.toUpperCase()))
      : null;

    const filtered = recent.filter(item =>
      formsSet ? formsSet.has(item.form.toUpperCase()) : true
    );

    const item = filtered[0];
    if (!item) {
      return {
        output: {
          cik: submissions.cik,
          name: submissions.name,
          tickers: submissions.tickers,
          filing: null,
        },
      };
    }

    const primaryDocUrl =
      item.primaryDocument && item.accessionNumber
        ? buildPrimaryDocUrl({
            cik: submissions.cik,
            accessionNumber: item.accessionNumber,
            primaryDocument: item.primaryDocument,
          })
        : undefined;

    return {
      output: {
        cik: submissions.cik,
        name: submissions.name,
        tickers: submissions.tickers,
        filing: { ...item, primaryDocUrl },
      },
    };
  },
});

const companyProfileInput = z
  .object({
    ticker: z.string().min(1).optional(),
    cik: z.union([z.string().min(1), z.number()]).optional(),
  })
  .refine(v => v.ticker || v.cik, { message: 'Provide either ticker or cik.' });

addEntrypoint({
  key: 'company.profile',
  description:
    'Company profile/metadata from SEC submissions (name, CIK, SIC, fiscal year end, state, addresses when available).',
  input: companyProfileInput,
  price: '0.01',
  handler: async ctx => {
    const input = ctx.input as z.infer<typeof companyProfileInput>;

    const cik =
      input.cik ?? (input.ticker ? await cikFromTicker(input.ticker) : undefined);
    if (!cik) throw new Error('Unable to resolve CIK');

    const s: any = await getSubmissions(cik);

    return {
      output: {
        ticker: input.ticker?.toUpperCase(),
        cik: s.cik,
        name: s.name,
        tickers: s.tickers,
        sicDescription: s.sicDescription,
        category: s.category,
        entityType: s.entityType,
        fiscalYearEnd: s.fiscalYearEnd,
        stateOfIncorporation: s.stateOfIncorporation,
        phone: s.phone,
        addresses: s.addresses,
        website: s.website,
        formerNames: s.formerNames,
      },
    };
  },
});

const insiderTradesInput = z
  .object({
    ticker: z.string().min(1).optional(),
    cik: z.union([z.string().min(1), z.number()]).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .refine(v => v.ticker || v.cik, { message: 'Provide either ticker or cik.' });

addEntrypoint({
  key: 'filings.insider-trades',
  description:
    'Recent insider filing links (Forms 3/4/5) from SEC submissions.',
  input: insiderTradesInput,
  price: '0.01',
  handler: async ctx => {
    const input = ctx.input as z.infer<typeof insiderTradesInput>;

    const cik =
      input.cik ?? (input.ticker ? await cikFromTicker(input.ticker) : undefined);
    if (!cik) throw new Error('Unable to resolve CIK');

    const submissions = await getSubmissions(cik);
    const recent = recentFilingsToItems(submissions.filings?.recent);

    const trades = recent
      .filter(f => ['3', '4', '5'].includes(f.form))
      .slice(0, input.limit)
      .map(f => ({
        ...f,
        primaryDocUrl:
          f.primaryDocument && f.accessionNumber
            ? buildPrimaryDocUrl({
                cik: submissions.cik,
                accessionNumber: f.accessionNumber,
                primaryDocument: f.primaryDocument,
              })
            : undefined,
      }));

    return {
      output: {
        ticker: input.ticker?.toUpperCase(),
        cik: submissions.cik,
        name: submissions.name,
        trades,
      },
    };
  },
});

const filingsStreamInput = z
  .object({
    ticker: z.string().min(1).optional(),
    cik: z.union([z.string().min(1), z.number()]).optional(),
    forms: z.array(z.string().min(1)).optional(),
    pollIntervalSec: z.number().int().min(5).max(300).default(30),
    maxEvents: z.number().int().min(1).max(200).default(50),
  })
  .refine(v => v.ticker || v.cik, { message: 'Provide either ticker or cik.' });

addEntrypoint({
  key: 'filings.stream',
  description:
    'Stream newly-seen recent filings (polls SEC submissions and emits when latest accession changes).',
  input: filingsStreamInput,
  streaming: true,
  price: '0.01',
  stream: async (ctx, emit) => {
    const input = ctx.input as z.infer<typeof filingsStreamInput>;
    const cik =
      input.cik ?? (input.ticker ? await cikFromTicker(input.ticker) : undefined);
    if (!cik) throw new Error('Unable to resolve CIK');

    const formsSet = input.forms?.length
      ? new Set(input.forms.map(f => f.toUpperCase()))
      : null;

    let lastAccession: string | null = null;
    let sent = 0;

    while (!ctx.signal.aborted && sent < input.maxEvents) {
      try {
        const submissions = await getSubmissions(cik, { cacheTtlMs: 5_000 });
        const recent = recentFilingsToItems(submissions.filings?.recent);
        const filtered = recent.filter(item =>
          formsSet ? formsSet.has(item.form.toUpperCase()) : true
        );

        const latest = filtered[0];
        if (latest?.accessionNumber && latest.accessionNumber !== lastAccession) {
          lastAccession = latest.accessionNumber;
          sent++;

          const primaryDocUrl =
            latest.primaryDocument && latest.accessionNumber
              ? buildPrimaryDocUrl({
                  cik: submissions.cik,
                  accessionNumber: latest.accessionNumber,
                  primaryDocument: latest.primaryDocument,
                })
              : undefined;

          await emit({
            kind: 'text',
            text: JSON.stringify(
              {
                cik: submissions.cik,
                name: submissions.name,
                tickers: submissions.tickers,
                filing: { ...latest, primaryDocUrl },
              },
              null,
              2
            ),
            mime: 'application/json',
          } as any);
        }
      } catch (e) {
        await emit({
          kind: 'error',
          code: 'stream_poll_error',
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        } as any);
      }

      // Poll interval
      await new Promise(resolve => setTimeout(resolve, input.pollIntervalSec * 1000));
    }

    return {
      status: ctx.signal.aborted ? 'cancelled' : 'succeeded',
      output: { eventsSent: sent },
    };
  },
});

const summarizeInput = z.object({
  ticker: z.string().min(1).optional(),
  cik: z.union([z.string().min(1), z.number()]).optional(),
  accessionNumber: z.string().min(5),
  primaryDocument: z.string().min(1).optional(),
  focus: z
    .string()
    .min(1)
    .default('Key changes, risks, guidance, and anything material for investors.'),
  maxChars: z.number().int().min(2000).max(200000).default(60000),
});

const summarizeHandler = async (ctx: any) => {
  const input = ctx.input as z.infer<typeof summarizeInput>;

  const cik =
    input.cik ?? (input.ticker ? await cikFromTicker(input.ticker) : undefined);
  if (!cik) throw new Error('Provide ticker or cik');

  const submissions = await getSubmissions(cik);
  const recent = recentFilingsToItems(submissions.filings?.recent);

  const filing: FilingItem | undefined = recent.find(
    f => f.accessionNumber === input.accessionNumber
  );

  const primaryDocument = input.primaryDocument ?? filing?.primaryDocument ?? undefined;

  if (!primaryDocument) {
    throw new Error(
      'primaryDocument not found. Provide primaryDocument or ensure accessionNumber is present in recent filings.'
    );
  }

  const docUrl = buildPrimaryDocUrl({
    cik: submissions.cik,
    accessionNumber: input.accessionNumber,
    primaryDocument,
  });

  const res = await fetch(docUrl, {
    headers: {
      'User-Agent':
        process.env.SEC_USER_AGENT ??
        'sec-filings-agent/0.1 (set SEC_USER_AGENT env var)',
      Accept: 'text/html,text/plain,*/*',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Failed to fetch filing document: ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`
    );
  }

  const raw = await res.text();
  const clipped = raw.slice(0, input.maxChars);

  const llm = createAxLLMClient({}).ax;
  if (!llm) {
    throw new Error(
      'LLM not configured. Set OPENAI_API_KEY (and optionally AX_PROVIDER/AX_MODEL).'
    );
  }

  const prompt = `You are a terse but high-signal analyst. Summarize the SEC filing below.\n\nFOCUS: ${input.focus}\n\nReturn:\n- Filing type + date (if inferable)\n- 8-15 bullet summary of material points\n- Risks/red flags\n- Any numbers/changes worth noting\n- 3 follow-up questions an investor should ask\n\nFILING (truncated):\n${clipped}`;

  const anyLlm: any = llm as any;
  const completion = anyLlm.chat
    ? await anyLlm.chat({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: prompt },
        ],
      })
    : await anyLlm.generate?.({ prompt });

  const text =
    completion?.content ??
    completion?.text ??
    completion?.choices?.[0]?.message?.content ??
    completion?.choices?.[0]?.text ??
    String(completion);

  return {
    output: {
      cik: submissions.cik,
      name: submissions.name,
      accessionNumber: input.accessionNumber,
      primaryDocument,
      docUrl,
      summary: text,
    },
  };
};

addEntrypoint({
  key: 'filings.summarize',
  description: 'Fetch a filing primary document and return an LLM summary (paid).',
  input: summarizeInput,
  price: '0.03',
  handler: summarizeHandler,
});

addEntrypoint({
  key: 'filings.summary',
  description: 'Alias of filings.summarize (paid).',
  input: summarizeInput,
  price: '0.03',
  handler: summarizeHandler,
});

export { app };
