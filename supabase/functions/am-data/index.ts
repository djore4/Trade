// am-data — dados de análise do Asset Manager (retorno real, fluxos, rendimento, funding).
// POST { action, ... } (browser com x-am-secret; crons com o mesmo header):
//   snapshot                 grava o valor total (Bybit + T212 + PPR) — cron a cada 4h; recusa gravar se uma fonte falhar
//   list { days? }           -> { snapshots, flows }
//   flows_sync { days? }     capital que entra/sai do perímetro: Bybit (livro de transações da conta de trading: transferências + staking), T212 (depósitos/levantamentos) e compras de PPR
//   flow_add { eur, ts?, note? } | flow_del { id }   fluxos manuais (compras com cartão/P2P, transferências, etc.)
//   t212_capital { force? }  -> { items:[{ref,ts,eur}], complete, at } depósitos (+) e levantamentos (−) T212 de SEMPRE (sem corte da análise); sincroniza por etapas e guarda em pf_cache
//   income                   -> dividendos T212 (cache 12h)
//   funding { symbols[] }    -> funding atual e intervalo por contrato
//   settings_get | settings_set { start }   data de início da análise (nada anterior é importado/mostrado; set apaga o anterior)
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { guard } from '../_shared/auth.ts';
import { bybitGet } from '../_shared/bybit.ts';
import { bybitMainKeys, bybitEquity, eurPerUsd, t212Account, pprValueEur, getAnalysisStart, num, sleep } from '../_shared/am-sources.ts';

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
      const start = await getAnalysisStart(supa);
      const from = new Date(Math.max(Date.now() - days * DAY, start)).toISOString();
      const [s, f] = await Promise.all([
        supa.from('am_snapshots').select('ts,total_eur,total_usd,bybit_usd,t212_val,t212_ccy,ppr_eur,eurusd').gte('ts', from).order('ts').limit(6000),
        supa.from('am_flows').select('id,ts,source,eur,usd,coin,note,auto').gte('ts', from).order('ts').limit(3000),
      ]);
      if (s.error || f.error) return json({ error: (s.error || f.error)!.message }, 400);
      return json({ snapshots: s.data, flows: f.data, start: start ? new Date(start).toISOString() : null });
    }

    /* ── flows_sync ── */
    if (action === 'flows_sync') {
      const days = Math.min(730, Math.max(1, Number(body?.days) || 45));
      const rows: any[] = [], unpriced: string[] = [], notes: string[] = [];
      const epuNow = await eurPerUsd();
      const cutoff = await getAnalysisStart(supa);
      const keys = bybitMainKeys();
      if (keys) {
        // O perímetro é a conta de trading (UTA), a mesma que o snapshot valoriza. O capital que a atravessa vem do LIVRO DE TRANSAÇÕES:
        // transferências para/da conta (cobre cartão, P2P e depósitos que passam pelo Funding — os registos de depósito não os mostram)
        // e subscrições/resgates de staking. `change` já vem com sinal (+ entra, − sai).
        const LEDGER = ['TRANSFER_IN', 'TRANSFER_OUT', 'FLEXIBLE_STAKING_SUBSCRIPTION', 'FLEXIBLE_STAKING_REDEMPTION'];
        const now = Date.now(), wins: { s: number; e: number }[] = [];
        for (let w = 0; w * 7 < days; w++) { const e = now - w * 7 * DAY; if (e <= cutoff) break; wins.push({ s: Math.max(e - 7 * DAY, cutoff), e }); }
        const doWin = async (w: { s: number; e: number }) => {
          for (const type of LEDGER) {
            let cursor = '';
            for (let page = 0; page < 20; page++) {
              const q = `accountType=UNIFIED&endTime=${w.e}&limit=50&startTime=${w.s}&type=${type}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
              let d: any = null;
              for (let t = 0; t < 4; t++) { d = await bybitGet('/v5/account/transaction-log', q, keys); if (d?.retCode !== 10006) break; await sleep(1200 * (t + 1)); }
              if (d?.retCode !== 0) { notes.push(`Bybit ${type} ${isoDay(w.s)}: ${d?.retCode} ${d?.retMsg}`); break; }
              for (const x of d.result?.list ?? []) {
                const ts = num(x.transactionTime), coin = String(x.currency), amt = num(x.change);
                if (!ts || ts < cutoff || !amt) continue;
                const usd = await usdValue(coin, amt, ts);
                if (usd == null) { unpriced.push(`${coin} ${isoDay(ts)}`); continue; }
                const e = await eurPerUsd(isoDay(ts)) ?? epuNow;
                if (!e) { unpriced.push(`${coin} ${isoDay(ts)} (sem câmbio)`); continue; }
                rows.push({ id: `bybit:ledger:${x.id || `${ts}:${coin}:${type}`}`, ts: new Date(ts).toISOString(), source: 'bybit', eur: usd * e, usd, coin, note: type.startsWith('FLEXIBLE') ? 'staking' : null, auto: true });
              }
              cursor = d.result?.nextPageCursor ?? '';
              if (!cursor) break;
            }
          }
        };
        for (let i = 0; i < wins.length; i += 3) await Promise.all(wins.slice(i, i + 3).map(doWin));
      }
      // PPR (manual): cada compra é capital que entra no perímetro (o valor do PPR está no snapshot)
      try {
        const { data: pp } = await supa.from('am_ppr').select('data').eq('id', 1).maybeSingle();
        for (const f of pp?.data?.funds ?? []) for (const b of f.buys ?? []) {
          const ts = Date.parse(String(b.d)); const amt = num(b.amt);
          if (!ts || ts < cutoff || !amt) continue;
          const e = await eurPerUsd(isoDay(ts)) ?? epuNow;
          rows.push({ id: `ppr:${f.id}:${b.id}`, ts: new Date(ts).toISOString(), source: 'ppr', eur: amt, usd: e ? amt / e : amt, coin: 'EUR', note: String(f.name || 'PPR').slice(0, 60), auto: true });
        }
      } catch (e) { notes.push(`PPR: ${(e as Error).message}`); }
      if (Deno.env.get('T212_API_KEY')) {
        try {
          const items = await t212Pages('/equity/history/transactions?limit=50', days > 60 ? 6 : 2);
          for (const x of items) {
            const t = String(x.type || '').toUpperCase();
            if (t !== 'DEPOSIT' && t !== 'WITHDRAW' && t !== 'WITHDRAWAL') continue;
            const ts = Date.parse(x.dateTime); if (!ts || ts < cutoff) continue;
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

    /* ── capital líquido T212 (depósitos − levantamentos, histórico completo) ── */
    if (action === 't212_capital') {
      if (!Deno.env.get('T212_API_KEY')) return json({ items: [], complete: true, note: 'T212 não configurada' });
      const K = 't212:capital';
      const { data: c } = await supa.from('pf_cache').select('v,at').eq('k', K).maybeSingle();
      const cur = c?.v && Array.isArray(c.v.items) ? c.v : { items: [], next: null, complete: false };
      const age = c ? Date.now() - Date.parse(c.at) : Infinity;
      if (cur.complete && age < 6 * 3600_000 && !body?.force) return json({ items: cur.items, complete: true, at: c!.at, cached: true });
      // completo mas velho: só as páginas mais recentes (dedupe por referência); incompleto: continua de onde ficou
      const resume = !cur.complete && cur.next;
      let nextUrl: string | null = resume ? `https://${new URL(t212Base()).host}${cur.next}` : `${t212Base()}/equity/history/transactions?limit=50`;
      const maxPages = resume || !cur.items.length ? 6 : 2;
      const byRef = new Map<string, any>(cur.items.map((x: any) => [x.ref, x]));
      let hitEnd = false, error: string | null = null, nextPath: string | null = resume ? cur.next : null;
      for (let i = 0; i < maxPages && nextUrl; i++) {
        if (i) await sleep(11000);
        const r = await fetch(nextUrl, { headers: t212Headers(), signal: AbortSignal.timeout(15000) });
        if (!r.ok) { error = `T212 ${r.status}`; break; }
        const d = await r.json();
        for (const x of d.items ?? []) {
          const t = String(x.type || '').toUpperCase();
          if (t !== 'DEPOSIT' && t !== 'WITHDRAW' && t !== 'WITHDRAWAL') continue;
          const ts = Date.parse(x.dateTime); if (!ts) continue;
          const a = num(x.amount), amt = t === 'DEPOSIT' ? Math.abs(a) : -Math.abs(a);
          const ccy = String(x.currency || 'EUR');
          const e = ccy === 'EUR' ? 1 : (await eurPerUsd(isoDay(ts)) ?? await eurPerUsd());
          let eur: number | null = null;
          if (ccy === 'EUR') eur = amt; else if (ccy === 'USD' && e) eur = amt * e;
          if (eur == null) continue;
          byRef.set(String(x.reference || ts), { ref: String(x.reference || ts), ts: new Date(ts).toISOString(), eur });
        }
        nextPath = d.nextPagePath ?? null;
        nextUrl = nextPath ? `https://${new URL(t212Base()).host}${nextPath}` : null;
        if (!nextPath) hitEnd = true;
      }
      const complete = resume || !cur.items.length ? hitEnd : (cur.complete || hitEnd);
      const items = [...byRef.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const v = { items, next: complete ? null : (resume || !cur.items.length ? nextPath : cur.next), complete };
      await supa.from('pf_cache').upsert({ k: K, v, at: new Date().toISOString() });
      return json({ items, complete, at: new Date().toISOString(), ...(error ? { error } : {}) });
    }

    /* ── rendimento (dividendos T212) ── */
    if (action === 'income') {
      const { data: c } = await supa.from('pf_cache').select('v,at').eq('k', 't212:divs').maybeSingle();
      const cutI = await getAnalysisStart(supa);
      const since = (a: any[]) => (a || []).filter((d: any) => d.ts >= cutI);
      if (c && Date.now() - Date.parse(c.at) < 12 * 3600_000 && !body?.force) return json({ divs: since(c.v), cached: true });
      if (!Deno.env.get('T212_API_KEY')) return json({ divs: [], note: 'T212 não configurada' });
      try {
        const items = await t212Pages('/equity/history/dividends?limit=50', 4);
        const divs = items.map((x: any) => ({ ts: Date.parse(x.paidOn), amt: num(x.amountInEuro ?? x.amount), ticker: String(x.ticker || '?').split('_')[0] })).filter((d: any) => d.ts);
        await supa.from('pf_cache').upsert({ k: 't212:divs', v: divs, at: new Date().toISOString() });
        return json({ divs: since(divs), cached: false });
      } catch (e) {
        if (c) return json({ divs: since(c.v), cached: true, stale: true, error: (e as Error).message });
        return json({ error: (e as Error).message }, 502);
      }
    }

    /* ── início da análise ── */
    if (action === 'settings_get') {
      const st = await getAnalysisStart(supa);
      return json({ start: st ? new Date(st).toISOString() : null });
    }
    if (action === 'settings_set') {
      const t = body?.start ? Date.parse(String(body.start)) : NaN;
      if (!Number.isFinite(t) || t > Date.now() || t < Date.parse('2015-01-01')) return json({ error: 'data inválida (não pode ser futura)' }, 400);
      const iso = new Date(t).toISOString();
      const { error: e1 } = await supa.from('am_settings').upsert({ key: 'analysis_start', value: iso, updated_at: new Date().toISOString() });
      if (e1) return json({ error: e1.message }, 400);
      // apaga o que é anterior (continua a existir na Bybit/T212; volta com "Importar" se a data recuar)
      const [f, tr, sn] = await Promise.all([
        supa.from('am_flows').delete().lt('ts', iso).select('id'),
        supa.from('am_trades').delete().lt('closed_at', iso).select('id'),
        supa.from('am_snapshots').delete().lt('ts', iso).select('ts'),
      ]);
      return json({ ok: true, start: iso, apagados: { fluxos: f.data?.length ?? 0, operacoes: tr.data?.length ?? 0, snapshots: sn.data?.length ?? 0 } });
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
