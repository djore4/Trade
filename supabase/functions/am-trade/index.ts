// am-trade — o TRADE ATUAL (posição aberta na Bybit): deteta quando começou e reconstrói o resultado desde aí.
// POST { action }:
//   current   -> { open, symbol, side, start, size, avg, mark, liq, lev, sl, realized, fees, funding, upl, net, capital, curve[], fills, notes[] }
//   adopt     -> grava o início do trade atual como início da Análise e apaga tudo o que é anterior (fluxos, operações, snapshots)
// Início = o último instante em que a posição esteve a zero: percorre as execuções do fim para o princípio, subtraindo cada
// execução ao tamanho atual, até o tamanho chegar a 0. (O `createdTime` da posição NÃO serve: a Bybit mantém o registo mesmo quando fica a zero.)
// Resultado = realizado (replay das execuções) − comissões + funding (livro, SETTLEMENT) + não realizado (posição atual).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { guard } from '../_shared/auth.ts';
import { bybitGet } from '../_shared/bybit.ts';
import { bybitMainKeys, bybitPositions, num } from '../_shared/am-sources.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-am-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const DAY = 86400000, MAX_BACK_DAYS = 63;

async function pages(path: string, base: string, keys: any, notes: string[], maxPages = 80): Promise<any[]> {
  const out: any[] = []; let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    let d: any = null;
    for (let t = 0; t < 4; t++) { d = await bybitGet(path, `${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, keys); if (d?.retCode !== 10006) break; await new Promise((r) => setTimeout(r, 1200 * (t + 1))); }
    if (d?.retCode !== 0) { notes.push(`${path}: ${d?.retCode} ${d?.retMsg}`); break; }
    out.push(...(d.result?.list ?? []));
    cursor = d.result?.nextPageCursor ?? '';
    if (!cursor) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  { const denied = await guard(req, cors); if (denied) return denied; }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const keys = bybitMainKeys();
    if (!keys) return json({ error: 'credenciais Bybit não configuradas' }, 500);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'current');
    const notes: string[] = [];
    const positions = await bybitPositions(keys);
    if (!positions.length) return json({ open: false });
    const p = [...positions].sort((a, b) => b.notional - a.notional)[0];
    const signed = p.long ? p.size : -p.size, now = Date.now();

    // 1) início: percorre as execuções do fim para o princípio até o tamanho chegar a 0
    const execs: any[] = [];                       // do mais recente para o mais antigo
    let need = signed, startMs: number | null = null, startExecMs = 0, firstExec: any = null, qOpen = 0;
    const tol = Math.max(0.001, Math.abs(signed) * 1e-9);
    outer: for (let w = 0; w * 7 < MAX_BACK_DAYS; w++) {
      const end = now - w * 7 * DAY, start = end - 7 * DAY;
      const list = (await pages('/v5/execution/list', `category=linear&endTime=${end}&limit=100&startTime=${start}&symbol=${p.symbol}`, keys, notes))
        .filter((e) => ['Trade', 'BustTrade', 'AdlTrade'].includes(String(e.execType))).sort((a, b) => num(b.execTime) - num(a.execTime));
      for (const e of list) {
        const q = num(e.execQty), s = e.side === 'Buy' ? 1 : -1;
        execs.push(e);
        need -= s * q;                              // tamanho ANTES desta execução
        const crossed = need * signed < 0;      // esta execução fechou primeiro uma posição de sinal contrário e só depois abriu a atual
        if (Math.abs(need) <= tol || crossed) {
          startExecMs = num(e.execTime); startMs = startExecMs;
          if (crossed) { firstExec = e; qOpen = q - Math.abs(need); startMs = startExecMs + 5; }   // +5 ms: o fecho da posição antiga fica de fora
          break outer;
        }
      }
    }
    if (startMs == null) return json({ open: true, symbol: p.symbol, start: null, notes: [...notes, `início não encontrado nos últimos ${MAX_BACK_DAYS} dias`] });

    // 2) replay do início até agora
    const asc = execs.filter((e) => num(e.execTime) >= startExecMs).sort((a, b) => num(a.execTime) - num(b.execTime));
    let size = 0, avg = 0, realized = 0, fees = 0;
    const states: { t: number; size: number; avg: number; realized: number; fees: number }[] = [];
    for (const e of asc) {
      const qFull = num(e.execQty), q = e === firstExec ? qOpen : qFull, pr = num(e.execPrice), s = e.side === 'Buy' ? 1 : -1;
      if (size === 0 || Math.sign(size) === s) { avg = (avg * Math.abs(size) + pr * q) / (Math.abs(size) + q); size += s * q; }
      else {
        const c = Math.min(q, Math.abs(size));
        realized += (pr - avg) * c * Math.sign(size);
        size += s * q;
        if (Math.abs(size) <= tol) { size = 0; avg = 0; } else if (Math.sign(size) === s) avg = pr;   // inverteu: nova posição ao preço da execução
      }
      fees += num(e.execFee) * (qFull > 0 ? q / qFull : 1);
      states.push({ t: num(e.execTime), size, avg, realized, fees });
    }
    if (Math.abs(size - signed) > Math.max(0.05, Math.abs(signed) * 1e-4)) notes.push(`replay termina em ${size.toFixed(2)} e a posição é ${signed.toFixed(2)}`);
    if (p.avg > 0 && avg > 0 && Math.abs(avg - p.avg) / p.avg > 0.01) notes.push(`preço médio do replay ${avg.toFixed(5)} vs Bybit ${p.avg.toFixed(5)}`);

    // 3) funding e capital desde o início (livro da conta de trading)
    const settle: { t: number; v: number }[] = []; let capital = 0;
    for (let s0 = startMs; s0 < now; s0 += 7 * DAY) {
      const e0 = Math.min(s0 + 7 * DAY - 1, now);
      const base = `accountType=UNIFIED&endTime=${e0}&limit=50&startTime=${s0}`;
      for (const x of await pages('/v5/account/transaction-log', `${base}&type=SETTLEMENT`, keys, notes)) if (String(x.symbol) === p.symbol) settle.push({ t: num(x.transactionTime), v: num(x.change) });
      for (const ty of ['TRANSFER_IN', 'TRANSFER_OUT']) for (const x of await pages('/v5/account/transaction-log', `${base}&type=${ty}`, keys, notes)) if (['USDT', 'USDC'].includes(String(x.currency))) capital += num(x.change);
    }
    const funding = settle.reduce((a, x) => a + x.v, 0);

    // 4) curva horária do resultado do trade (realizado − comissões + funding + não realizado ao preço de fecho da hora)
    const curve: { t: number; pnl: number; px: number }[] = [];
    try {
      const k = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${p.symbol}&interval=60&start=${Math.floor(startMs / 3600000) * 3600000}&limit=1000`, { signal: AbortSignal.timeout(8000) });
      const bars = ((await k.json())?.result?.list ?? []).map((r: string[]) => ({ t: num(r[0]), c: num(r[4]) })).sort((a: any, b: any) => a.t - b.t);
      let si = -1, fi = 0, fcum = 0;
      for (const b of bars) {
        const tEnd = b.t + 3600000;
        while (si + 1 < states.length && states[si + 1].t < tEnd) si++;
        while (fi < settle.length && settle[fi].t < tEnd) fcum += settle[fi++].v;
        const st = si >= 0 ? states[si] : { size: 0, avg: 0, realized: 0, fees: 0 };
        curve.push({ t: Math.max(b.t, startMs), px: b.c, pnl: st.realized - st.fees + fcum + (st.size !== 0 ? (b.c - st.avg) * st.size : 0) });
      }
    } catch (e) { notes.push(`curva: ${(e as Error).message}`); }

    const net = realized - fees + funding + p.upl;
    const result = { open: true, symbol: p.symbol, side: p.long ? 'long' : 'short', start: new Date(startMs).toISOString(), size: p.size, avg: p.avg, mark: p.mark, liq: p.liq,
      lev: p.lev, sl: p.sl, notional: p.notional, upl: p.upl, realized, fees, funding, net, capital, fills: asc.length, curve, notes };

    if (action === 'adopt') {
      const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const iso = new Date(startMs).toISOString();
      const { error: e1 } = await supa.from('am_settings').upsert({ key: 'analysis_start', value: iso, updated_at: new Date().toISOString() });
      if (e1) return json({ error: e1.message }, 400);
      const [f, tr, sn] = await Promise.all([
        supa.from('am_flows').delete().lt('ts', iso).select('id'),
        supa.from('am_trades').delete().lt('closed_at', iso).select('id'),
        supa.from('am_snapshots').delete().lt('ts', iso).select('ts'),
      ]);
      return json({ ok: true, start: iso, apagados: { fluxos: f.data?.length ?? 0, operacoes: tr.data?.length ?? 0, snapshots: sn.data?.length ?? 0 }, ...result, curve: undefined });
    }
    return json(result);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
