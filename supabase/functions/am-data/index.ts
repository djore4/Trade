// am-data — dados de análise do Asset Manager (retorno real, fluxos, rendimento, funding).
// POST { action, ... } (browser com x-am-secret; crons com o mesmo header):
//   snapshot                 grava o valor total (Bybit + T212 + PPR) — cron a cada 4h; recusa gravar se uma fonte falhar
//   list { days? }           -> { snapshots, flows }
//   flows_sync { days? }     importa depósitos/levantamentos (Bybit) e depósitos/levantamentos (T212)
//   flow_add { eur, ts?, note? } | flow_del { id }   fluxos manuais (compras com cartão/P2P, transferências, etc.)
//   income                   -> dividendos T212 (cache 12h)
//   funding { symbols[] }    -> funding atual e intervalo por contrato
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { guard } from '../_shared/auth.ts';
import { bybitGet } from '../_shared/bybit.ts';
import { bybitMainKeys, bybitEquity, eurPerUsd, t212Account, pprValueEur, num, sleep } from '../_shared/am-sources.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-am-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const DAY = 86400000;
const STABLES = new Set(['USDT', 'USDC', 'USD', 'DAI', 'FDUSD', 'USDE', 'TUSD', 'PYUSD']);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const t212Base = () => (Deno.env.get('T212_ENV') ?? 'live').toLowerCase() === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
function t212Headers() {
  const k = Deno.env.get('T212_API_KEY') ?? '', s = Deno.env.get('T212_API_SECRET') ?? '';
  return { Authorization: s ? 'Basic ' + btoa(`${k}:${s}`) : k };
}
// pagina um endpoint de histórico da T212 (6 pedidos/min → pausa entre páginas)
async function t212Pages(path: string, maxPages: number): Promise<any[]> {
  const out: any[] = []; let next: string | null = `${t212Base()}${path}`;
  for (let i = 0; i < maxPages && next; i++) {
    if (i) await sleep(11000);
    const r = await fetch(next, { headers: t212Headers(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`T212 ${r.status}`);
    const d = await r.json();
    out.push(...(d.items ?? []));
    next = d.nextPagePath ? `https://${new URL(t212Base()).host}${d.nextPagePath}` : null;
  }
  return out;
}

// valor em USD de `amount` de `coin` no dia de `ts` (stables 1:1; resto: fecho diário spot da Bybit). null = sem preço.
async function usdValue(coin: string, amount: number, ts: number): Promise<number | null> {
  if (STABLES.has(coin)) return amount;
  try {
    const start = Math.floor(ts / DAY) * DAY;
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${coin}USDT&interval=D&start=${start}&limit=1`, { signal: AbortSignal.timeout(6000) });
    const c = Number((await r.json())?.result?.list?.[0]?.[4]);
    return c > 0 ? amount * c : null;
  } catch (_e) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  { const denied = await guard(req, cors); if (denied) return denied; }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');

    /* ── snapshot ── */
    if (action === 'snapshot') {
      const errs: string[] = [];
      const epu = await eurPerUsd();
      if (!epu) return json({ error: 'sem taxa EUR/USD — snapshot recusado' }, 502);
      let bybitUsd: number | null = null, t212Val: number | null = null, t212Ccy: string | null = null, t212Eur = 0;
      const keys = bybitMainKeys();
      if (keys) { try { bybitUsd = (await bybitEquity(keys)).equityUsd; } catch (e) { errs.push((e as Error).message); } }
      try {
        const t = await t212Account();
        if (t) {
          t212Val = t.value; t212Ccy = t.ccy;
          if (t.ccy === 'EUR') t212Eur = t.value; else if (t.ccy === 'USD') t212Eur = t.value * epu; else errs.push(`moeda T212 não suportada: ${t.ccy}`);
        }
      } catch (e) { errs.push((e as Error).message); }
      // Integridade: um snapshot com uma fonte em falta pareceria uma queda enorme. Não grava.
      if (errs.length) return json({ error: 'snapshot recusado (fonte em falta)', details: errs }, 502);
      const pprEur = await pprValueEur(supa);
      const totalEur = (bybitUsd ?? 0) * epu + t212Eur + pprEur;
      if (!(totalEur > 0)) return json({ error: 'valor total nulo — snapshot recusado' }, 502);
      const row = { total_eur: totalEur, total_usd: totalEur / epu, bybit_usd: bybitUsd, t212_val: t212Val, t212_ccy: t212Ccy, ppr_eur: pprEur, eurusd: 1 / epu };
      const { error } = await supa.from('am_snapshots').insert(row);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, ...row });
    }

    /* ── list ── */
    if (action === 'list') {
      const days = Math.min(1500, Math.max(1, Number(body?.days) || 400));
      const from = new Date(Date.now() - days * DAY).toISOString();
      const [s, f] = await Promise.all([
        supa.from('am_snapshots').select('ts,total_eur,total_usd,bybit_usd,t212_val,t212_ccy,ppr_eur,eurusd').gte('ts', from).order('ts').limit(6000),
        supa.from('am_flows').select('id,ts,source,eur,usd,coin,note,auto').gte('ts', from).order('ts').limit(3000),
      ]);
      if (s.error || f.error) return json({ error: (s.error || f.error)!.message }, 400);
      return json({ snapshots: s.data, flows: f.data });
    }

    /* ── flows_sync ── */
    if (action === 'flows_sync') {
      const days = Math.min(730, Math.max(1, Number(body?.days) || 45));
      const rows: any[] = [], unpriced: string[] = [], notes: string[] = [];
      const epuNow = await eurPerUsd();
      const keys = bybitMainKeys();
      if (keys) {
        const now = Date.now();
        for (let w = 0; w * 30 < days; w++) {
          const end = now - w * 30 * DAY, start = end - 30 * DAY;
          for (const kind of ['dep', 'wd'] as const) {
            let cursor = '';
            for (let page = 0; page < 10; page++) {
              const path = kind === 'dep' ? '/v5/asset/deposit/query-record' : '/v5/asset/withdraw/query-record';
              const q = `endTime=${end}&limit=50&startTime=${start}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
              const d = await bybitGet(path, q, keys);
              if (d?.retCode !== 0) { notes.push(`Bybit ${kind}: ${d?.retCode} ${d?.retMsg}`); break; }
              for (const x of d.result?.rows ?? []) {
                const coin = String(x.coin);
                if (kind === 'dep' && String(x.status) !== '3') continue;
                if (kind === 'wd' && String(x.status).toLowerCase() !== 'success') continue;
                const ts = num(kind === 'dep' ? x.successAt : x.createTime);
                if (!ts) continue;
                const amt = kind === 'dep' ? num(x.amount) : -(num(x.amount) + num(x.withdrawFee));
                const usd = await usdValue(coin, amt, ts);
                const id = `bybit:${kind}:${x.txID || x.withdrawId || ts}:${coin}`;
                if (usd == null) { unpriced.push(`${coin} ${isoDay(ts)}`); continue; }
                const e = await eurPerUsd(isoDay(ts)) ?? epuNow;
                if (!e) { unpriced.push(`${coin} ${isoDay(ts)} (sem câmbio)`); continue; }
                rows.push({ id, ts: new Date(ts).toISOString(), source: 'bybit', eur: usd * e, usd, coin, auto: true });
              }
              cursor = d.result?.nextPageCursor ?? '';
              if (!cursor) break;
            }
          }
        }
      }
      if (Deno.env.get('T212_API_KEY')) {
        try {
          const items = await t212Pages('/equity/history/transactions?limit=50', days > 60 ? 6 : 2);
          for (const x of items) {
            const t = String(x.type || '').toUpperCase();
            if (t !== 'DEPOSIT' && t !== 'WITHDRAW' && t !== 'WITHDRAWAL') continue;
            const ts = Date.parse(x.dateTime); if (!ts) continue;
            const a = num(x.amount), amt = t === 'DEPOSIT' ? Math.abs(a) : -Math.abs(a);
            const ccy = String(x.currency || 'EUR');
            const e = await eurPerUsd(isoDay(ts)) ?? epuNow;
            let eur: number, usd: number;
            if (ccy === 'EUR') { eur = amt; usd = e ? amt / e : amt; } else if (ccy === 'USD' && e) { usd = amt; eur = amt * e; } else { unpriced.push(`T212 ${ccy} ${isoDay(ts)}`); continue; }
            rows.push({ id: `t212:${x.reference || ts}`, ts: new Date(ts).toISOString(), source: 't212', eur, usd, coin: ccy, auto: true });
          }
        } catch (e) { notes.push((e as Error).message); }
      }
      let inserted = 0;
      if (rows.length) {
        const { data, error } = await supa.from('am_flows').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }).select('id');
        if (error) return json({ error: error.message }, 400);
        inserted = data?.length ?? 0;
      }
      return json({ found: rows.length, inserted, unpriced, notes });
    }

    /* ── fluxos manuais ── */
    if (action === 'flow_add') {
      const eur = Number(body?.eur);
      if (!Number.isFinite(eur) || eur === 0 || Math.abs(eur) > 1e8) return json({ error: 'eur inválido (positivo = depósito, negativo = levantamento)' }, 400);
      const ts = body?.ts ? Date.parse(body.ts) : Date.now();
      if (!Number.isFinite(ts)) return json({ error: 'data inválida' }, 400);
      const e = await eurPerUsd(isoDay(ts)) ?? await eurPerUsd();
      const row = { id: `manual:${crypto.randomUUID()}`, ts: new Date(ts).toISOString(), source: 'manual', eur, usd: e ? eur / e : eur, note: String(body?.note || '').slice(0, 200) || null, auto: false };
      const { error } = await supa.from('am_flows').insert(row);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, flow: row });
    }
    if (action === 'flow_del') {
      const id = String(body?.id || '');
      if (!id.startsWith('manual:')) return json({ error: 'só os fluxos manuais podem ser apagados' }, 400);
      const { error } = await supa.from('am_flows').delete().eq('id', id);
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }

    /* ── rendimento (dividendos T212) ── */
    if (action === 'income') {
      const { data: c } = await supa.from('pf_cache').select('v,at').eq('k', 't212:divs').maybeSingle();
      if (c && Date.now() - Date.parse(c.at) < 12 * 3600_000 && !body?.force) return json({ divs: c.v, cached: true });
      if (!Deno.env.get('T212_API_KEY')) return json({ divs: [], note: 'T212 não configurada' });
      try {
        const items = await t212Pages('/equity/history/dividends?limit=50', 4);
        const divs = items.map((x: any) => ({ ts: Date.parse(x.paidOn), amt: num(x.amountInEuro ?? x.amount), ticker: String(x.ticker || '?').split('_')[0] })).filter((d: any) => d.ts);
        await supa.from('pf_cache').upsert({ k: 't212:divs', v: divs, at: new Date().toISOString() });
        return json({ divs, cached: false });
      } catch (e) {
        if (c) return json({ divs: c.v, cached: true, stale: true, error: (e as Error).message });
        return json({ error: (e as Error).message }, 502);
      }
    }

    /* ── funding ── */
    if (action === 'funding') {
      const syms: string[] = (Array.isArray(body?.symbols) ? body.symbols : []).map(String).filter((s: string) => /^[A-Z0-9]{3,24}$/.test(s)).slice(0, 20);
      if (!syms.length) return json({ funding: {} });
      const out: Record<string, unknown> = {};
      await Promise.all(syms.map(async (s) => {
        try {
          const [t, i] = await Promise.all([
            fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json()),
            fetch(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${s}`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json()),
          ]);
          const tk = t?.result?.list?.[0], it = i?.result?.list?.[0];
          if (tk) out[s] = { rate: num(tk.fundingRate), intervalH: (num(it?.fundingInterval) || 480) / 60, nextTs: num(tk.nextFundingTime), mark: num(tk.markPrice) };
        } catch (_e) { /* contrato sem dados */ }
      }));
      return json({ funding: out });
    }

    return json({ error: 'action inválida' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
