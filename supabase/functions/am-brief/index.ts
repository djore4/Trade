// am-brief — briefing diário proativo (cron 07:30 UTC) + push.
// POST { action }:  run { force? }  gera, guarda em am_briefs e envia push  |  latest  ->  { brief }
// Só usa dados reais do servidor (snapshots, posições, diário, alertas, teses). Nunca inventa: se faltar um dado, diz que falta.
// Env: ANTHROPIC_API_KEY (obrigatória), BRIEF_MODEL (opcional, por defeito claude-sonnet-5-5).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { guard } from '../_shared/auth.ts';
import { bybitMainKeys, bybitPositions, pushAll, num } from '../_shared/am-sources.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-am-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const H = 3600_000, DAY = 24 * H;
const eur = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('pt-PT', { maximumFractionDigits: 0 })} €`;

const SYSTEM = [
  'És o analista pessoal do dono deste portefólio. Português europeu, direto, sem floreados nem elogios.',
  'Escreve um briefing da manhã com NO MÁXIMO 110 palavras, em 3 linhas curtas com estes prefixos exatos:',
  '• Mudou: o que se alterou desde ontem (valor sem contar depósitos/levantamentos, operações fechadas, alertas disparados).',
  '• Risco: o risco mais relevante AGORA (distância à liquidação, posições sem stop, alavancagem, tese perto de ser invalidada).',
  '• Desafio: uma pergunta incómoda que o ponto cego dos dados sugere (ex.: padrão de perdas, tese sem invalidação, concentração).',
  'Regras: usa só os dados fornecidos; se um dado faltar, di-lo numa frase em vez de adivinhar. Não dês ordens de compra/venda.',
].join('\n');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  { const denied = await guard(req, cors); if (denied) return denied; }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'run');

    if (action === 'latest') {
      const { data } = await supa.from('am_briefs').select('id,created_at,kind,body').order('created_at', { ascending: false }).limit(1).maybeSingle();
      return json({ brief: data ?? null });
    }
    if (action !== 'run') return json({ error: 'action inválida' }, 400);

    const { data: last } = await supa.from('am_briefs').select('id,created_at,body').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - Date.parse(last.created_at) < 10 * H && !body?.force) return json({ skipped: 'já existe um briefing recente', brief: last });

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada' }, 500);

    const now = Date.now();
    const [snaps, flows, trades, fired, theses] = await Promise.all([
      supa.from('am_snapshots').select('ts,total_eur').gte('ts', new Date(now - 8 * DAY).toISOString()).order('ts'),
      supa.from('am_flows').select('ts,eur').gte('ts', new Date(now - 8 * DAY).toISOString()),
      supa.from('am_trades').select('symbol,side,pnl,closed_at,tag').gte('closed_at', new Date(now - 7 * DAY).toISOString()),
      supa.from('am_alerts').select('label,triggered_at,trigger_value').gte('triggered_at', new Date(now - DAY).toISOString()),
      supa.from('am_theses').select('symbol,side,thesis,invalid_px,status').eq('status', 'open'),
    ]);

    const L: string[] = [`Data: ${new Date().toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' })}.`];
    const S = snaps.data ?? [], F = flows.data ?? [];
    if (S.length >= 2) {
      const cur = S[S.length - 1];
      const at = (ms: number) => [...S].reverse().find((s) => Date.parse(s.ts) <= now - ms) ?? S[0];
      for (const [lab, ms] of [['24h', DAY], ['7d', 7 * DAY]] as const) {
        const ref = at(ms), fl = F.filter((f) => Date.parse(f.ts) > Date.parse(ref.ts)).reduce((a, f) => a + num(f.eur), 0);
        const gain = num(cur.total_eur) - num(ref.total_eur) - fl;
        L.push(`Valor total ${eur(num(cur.total_eur))}. Variação ${lab} sem fluxos de capital: ${eur(gain)} (${(gain / Math.max(1, num(ref.total_eur)) * 100).toFixed(2)}%).`);
      }
    } else L.push('Snapshots insuficientes para calcular a variação (a série ainda é curta).');

    const keys = bybitMainKeys();
    let marks: Record<string, number> = {};
    if (keys) {
      try {
        const ps = await bybitPositions(keys);
        ps.forEach((p) => { marks[p.symbol] = p.mark; });
        if (ps.length) L.push('Posições Bybit: ' + ps.map((p) => {
          const d = p.liq > 0 && p.mark > 0 ? Math.abs(p.mark - p.liq) / p.mark * 100 : null;
          return `${p.symbol} ${p.long ? 'LONG' : 'SHORT'} ${p.lev}× (${d != null ? d.toFixed(1) + '% da liquidação' : 'liq. n/d'}, ${p.sl > 0 ? 'com stop' : 'SEM STOP'}, uPnL ${p.upl.toFixed(0)}$)`;
        }).join('; ') + '.');
        else L.push('Sem posições abertas na Bybit.');
      } catch (e) { L.push(`Posições Bybit indisponíveis (${(e as Error).message}).`); }
    }

    const T = trades.data ?? [], T1 = T.filter((t) => Date.parse(t.closed_at) > now - DAY);
    if (T.length) {
      const w = T.filter((t) => num(t.pnl) > 0).length;
      L.push(`Operações fechadas: 24h = ${T1.length} (${T1.reduce((a, t) => a + num(t.pnl), 0).toFixed(0)}$); 7d = ${T.length}, ${(w / T.length * 100).toFixed(0)}% ganhas, PnL ${T.reduce((a, t) => a + num(t.pnl), 0).toFixed(0)}$.`);
      const tags = T.filter((t) => t.tag).map((t) => t.tag); if (tags.length) L.push(`Etiquetas da semana: ${tags.join(', ')}.`);
    } else L.push('Sem operações fechadas nos últimos 7 dias (ou diário ainda sem dados).');

    if (fired.data?.length) L.push('Alertas disparados nas últimas 24h: ' + fired.data.map((a) => `${a.label} (${a.trigger_value})`).join('; ') + '.');
    for (const t of theses.data ?? []) {
      const m = marks[t.symbol];
      L.push(`Tese aberta ${t.symbol} ${t.side}: "${t.thesis}"; invalida em ${t.invalid_px}${m ? `, preço atual ${m} (${(Math.abs(m - t.invalid_px) / m * 100).toFixed(1)}% do nível)` : ''}.`);
    }

    const model = Deno.env.get('BRIEF_MODEL') ?? 'claude-sonnet-5-5';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 500, system: SYSTEM, messages: [{ role: 'user', content: L.join('\n') }] }),
    });
    const d = await r.json();
    if (!r.ok) return json({ error: `Anthropic ${r.status}: ${JSON.stringify(d).slice(0, 300)}` }, 502);
    const text = String(d?.content?.find((c: any) => c.type === 'text')?.text ?? '').trim();
    if (!text) return json({ error: 'resposta vazia' }, 502);

    const sent = body?.push === false ? 0 : await pushAll(supa, webpush, 'Briefing da manhã', text.replace(/\s+/g, ' ').slice(0, 180), './#ai');
    const { data: row, error } = await supa.from('am_briefs').insert({ body: text, pushed: sent }).select('id,created_at,body').single();
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, brief: row, pushed: sent });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
