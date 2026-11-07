// am-alerts-check — avalia os alertas ativos (cron de 1 em 1 minuto, via pg_net) e envia Web Push.
//  - price: Bybit (tickers lineares, 1 pedido) ou Yahoo (por símbolo) vs nivel acima/abaixo
//  - liq:   distancia % do mark a liquidacao (posicoes Bybit, pedido assinado com BYBIT_API_KEY/SECRET)
// Disparo unico por defeito; com repeat=true re-arma quando a condicao deixa de se verificar.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const fmtNum = (v: number) => v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(5);

async function hmacSign(message: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function bybitPositions(): Promise<Map<string, number>> {
  const apiKey = Deno.env.get('BYBIT_API_KEY') ?? '', secret = Deno.env.get('BYBIT_API_SECRET') ?? '';
  const dist = new Map<string, number>();
  if (!apiKey || !secret) return dist;
  for (const coin of ['USDT', 'USDC']) {
    const qs = `category=linear&settleCoin=${coin}`, ts = Date.now().toString(), rw = '5000';
    const sign = await hmacSign(`${ts}${apiKey}${rw}${qs}`, secret);
    const r = await fetch(`https://api.bybit.com/v5/position/list?${qs}`, {
      headers: { 'X-BAPI-API-KEY': apiKey, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw }, signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    if (d?.retCode !== 0) continue;
    for (const p of d.result?.list ?? []) {
      const mark = Number(p.markPrice), liq = Number(p.liqPrice);
      if (Number(p.size) > 0 && mark > 0 && liq > 0) dist.set(String(p.symbol), Math.abs(mark - liq) / mark * 100);
    }
  }
  return dist;
}
async function bybitTickers(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', { signal: AbortSignal.timeout(8000) });
  const d = await r.json();
  for (const t of d?.result?.list ?? []) m.set(String(t.symbol), Number(t.lastPrice));
  return m;
}
async function yahooPrice(sym: string): Promise<number | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeDesk/1.0)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const p = (await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === 'number' && p > 0 ? p : null;
  } catch (_e) { return null; }
}

Deno.serve(async () => {
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: alerts, error } = await supa.from('am_alerts').select('*').eq('active', true);
    if (error) return json({ error: error.message }, 500);
    if (!alerts?.length) return json({ checked: 0, triggered: 0 });

    // preços necessários (um pedido por fonte)
    const needBybit = alerts.some((a) => a.kind === 'price' && a.source === 'bybit');
    const needLiq = alerts.some((a) => a.kind === 'liq');
    const ySyms = [...new Set(alerts.filter((a) => a.kind === 'price' && a.source === 'yahoo').map((a) => a.symbol as string))];
    const [tick, dist, yprices] = await Promise.all([
      needBybit ? bybitTickers().catch(() => new Map<string, number>()) : Promise.resolve(new Map<string, number>()),
      needLiq ? bybitPositions().catch(() => new Map<string, number>()) : Promise.resolve(new Map<string, number>()),
      Promise.all(ySyms.map(async (s) => [s, await yahooPrice(s)] as const)),
    ]);
    const yp = new Map(yprices);

    const fired: { a: any; value: number }[] = [];
    for (const a of alerts) {
      const value = a.kind === 'liq' ? dist.get(a.symbol) : a.source === 'bybit' ? tick.get(a.symbol) : yp.get(a.symbol);
      if (value == null || !isFinite(value)) continue;
      const cond = a.kind === 'liq' ? value <= Number(a.level) : a.op === 'above' ? value >= Number(a.level) : value <= Number(a.level);
      if (cond && a.armed) fired.push({ a, value });
      else if (!cond && !a.armed && a.repeat) await supa.from('am_alerts').update({ armed: true }).eq('id', a.id);
    }

    let sent = 0;
    if (fired.length) {
      const now = new Date().toISOString();
      for (const { a, value } of fired) {
        await supa.from('am_alerts').update({ triggered_at: now, trigger_value: value, armed: false, active: !!a.repeat }).eq('id', a.id);
      }
      const { data: cfg } = await supa.from('cs_config').select('vapid_public, vapid_private, vapid_subject').eq('id', 1).maybeSingle();
      const { data: subs } = await supa.from('am_push_subs').select('*');
      if (cfg?.vapid_public && cfg?.vapid_private && subs?.length) {
        webpush.setVapidDetails(cfg.vapid_subject || 'mailto:alerts@assetmanager.local', cfg.vapid_public, cfg.vapid_private);
        const dead: string[] = [];
        for (const { a, value } of fired) {
          const body = a.kind === 'liq'
            ? `${a.label}: a ${value.toFixed(1)}% da liquidação (limite ${Number(a.level)}%)`
            : `${a.label} ${a.op === 'above' ? 'subiu para' : 'desceu para'} ${fmtNum(value)} (alerta ${a.op === 'above' ? '≥' : '≤'} ${fmtNum(Number(a.level))})`;
          const payload = JSON.stringify({ title: a.kind === 'liq' ? '⚠ Risco de liquidação' : `Alerta · ${a.label}`, body, data: { url: './#trade' } });
          await Promise.all(subs.map(async (s) => {
            try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); sent++; }
            catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) dead.push(s.endpoint); }
          }));
        }
        if (dead.length) await supa.from('am_push_subs').delete().in('endpoint', [...new Set(dead)]);
      }
    }
    return json({ checked: alerts.length, triggered: fired.length, sent });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
