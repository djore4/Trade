// get-etf-holdings — principais posições de ETFs (para o look-through do portefólio).
// GET ?symbols=VWCE.DE,CSPX.L  (símbolos Yahoo, máx. 8)  ->  { etfs: { SYM: { holdings:[{symbol,name,pct}], coverage, at } | { error } } }
// Fonte: Yahoo quoteSummary (módulo topHoldings: só as ~10 maiores posições → "coverage" diz quanto do ETF cobrem).
// É um endpoint não-oficial e pode falhar: nesse caso devolve erro por símbolo (a app mostra "indisponível").
// Cache de 7 dias em pf_cache (service role).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { guard } from '../_shared/auth.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-am-secret',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const UA = 'Mozilla/5.0 (compatible; AssetManager/1.0)';
const TTL = 7 * 24 * 3600_000;

async function yahooCrumb(): Promise<{ cookie: string; crumb: string }> {
  const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(6000) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Yahoo sem cookie');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(6000) });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.length > 40) throw new Error('Yahoo sem crumb');
  return { cookie, crumb };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  { const denied = await guard(req, cors); if (denied) return denied; }
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const syms = (new URL(req.url).searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9.=^\-]{1,24}$/.test(s)).slice(0, 8);
    if (!syms.length) return json({ etfs: {} });
    const out: Record<string, unknown> = {};
    let auth: { cookie: string; crumb: string } | null = null;
    for (const s of syms) {
      const { data: c } = await supa.from('pf_cache').select('v,at').eq('k', `etf:${s}`).maybeSingle();
      if (c && Date.now() - Date.parse(c.at) < TTL && !c.v?.error) { out[s] = c.v; continue; }
      try {
        auth = auth ?? await yahooCrumb();
        const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=topHoldings&crumb=${encodeURIComponent(auth.crumb)}`,
          { headers: { 'User-Agent': UA, Cookie: auth.cookie }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`Yahoo ${r.status}`);
        const th = (await r.json())?.quoteSummary?.result?.[0]?.topHoldings;
        const hs = (th?.holdings ?? []).map((h: any) => ({ symbol: h.symbol || null, name: h.holdingName || h.symbol, pct: Number(h.holdingPercent?.raw ?? h.holdingPercent) * 100 }))
          .filter((h: any) => h.pct > 0);
        if (!hs.length) throw new Error('sem posições (não é ETF, ou o Yahoo não as publica)');
        const v = { holdings: hs, coverage: hs.reduce((a: number, h: any) => a + h.pct, 0), at: Date.now() };
        out[s] = v;
        await supa.from('pf_cache').upsert({ k: `etf:${s}`, v, at: new Date().toISOString() });
      } catch (e) { out[s] = { error: (e as Error).message }; }
    }
    return json({ etfs: out });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
