/*
 * am-sources.ts — leitura das fontes do Asset Manager do lado do servidor
 * (conta PRINCIPAL da Bybit, Trading 212, PPR, câmbio) + envio de Web Push.
 * Usado pelos jobs de cron (snapshots, diário, briefing). Só leitura.
 */
import { bybitGet, type BybitKeys } from './bybit.ts';

export const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Data (ms) a partir da qual a Análise conta (am_settings.analysis_start). Nada anterior é importado nem mostrado. 0 = sem corte.
export async function getAnalysisStart(supa: any): Promise<number> {
  const { data } = await supa.from('am_settings').select('value').eq('key', 'analysis_start').maybeSingle();
  const t = data?.value ? Date.parse(String(data.value)) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Conta PRINCIPAL (a que a app mostra) — não a AI subaccount do bot.
export function bybitMainKeys(): BybitKeys | null {
  const apiKey = Deno.env.get('BYBIT_API_KEY') ?? '';
  const apiSecret = Deno.env.get('BYBIT_API_SECRET') ?? '';
  const privateKeyPem = Deno.env.get('BYBIT_API_PRIVATE_KEY') ?? '';
  if (!apiKey || (!apiSecret && !privateKeyPem)) return null;
  return { apiKey, apiSecret, privateKeyPem, base: Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com' };
}

export async function bybitEquity(k: BybitKeys): Promise<{ equityUsd: number; walletUsd: number }> {
  const d = await bybitGet('/v5/account/wallet-balance', 'accountType=UNIFIED', k);
  if (d?.retCode !== 0) throw new Error(`Bybit wallet ${d?.retCode}: ${d?.retMsg}`);
  const a = d.result?.list?.[0];
  if (!a) throw new Error('Bybit wallet sem dados');
  return { equityUsd: num(a.totalEquity), walletUsd: num(a.totalWalletBalance) };
}

export interface Pos { symbol: string; long: boolean; size: number; avg: number; mark: number; liq: number; notional: number; lev: number; upl: number; sl: number; }
export async function bybitPositions(k: BybitKeys): Promise<Pos[]> {
  const out: Pos[] = [];
  for (const coin of ['USDT', 'USDC']) {
    const d = await bybitGet('/v5/position/list', `category=linear&settleCoin=${coin}`, k);
    if (d?.retCode !== 0) throw new Error(`Bybit posições ${d?.retCode}: ${d?.retMsg}`);
    for (const p of d.result?.list ?? []) {
      if (num(p.size) <= 0) continue;
      out.push({ symbol: String(p.symbol), long: p.side === 'Buy', size: num(p.size), avg: num(p.avgPrice), mark: num(p.markPrice), liq: num(p.liqPrice),
        notional: num(p.positionValue), lev: num(p.leverage), upl: num(p.unrealisedPnl), sl: num(p.stopLoss) });
    }
  }
  return out;
}

// EUR por 1 USD numa data (YYYY-MM-DD) ou hoje. Fonte: BCE via frankfurter. Cache em memória.
const fxCache = new Map<string, number>();
export async function eurPerUsd(date?: string): Promise<number | null> {
  const key = date || 'latest';
  if (fxCache.has(key)) return fxCache.get(key)!;
  try {
    const r = await fetch(`https://api.frankfurter.app/${date || 'latest'}?from=USD&to=EUR`, { signal: AbortSignal.timeout(6000) });
    const v = Number((await r.json())?.rates?.EUR);
    if (v > 0) { fxCache.set(key, v); return v; }
  } catch (_e) { /* sem câmbio */ }
  return null;
}

// Trading 212: reutiliza a função get-t212-portfolio (cache e limites já tratados lá).
export async function t212Account(): Promise<{ value: number; ccy: string; free: number; invested: number; positions: any[]; stale: boolean } | null> {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!Deno.env.get('T212_API_KEY')) return null;
  const r = await fetch(`${url}/functions/v1/get-t212-portfolio`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(`T212: ${d.error || r.status}`);
  const a = d.account || {};
  return { value: num(a.value), ccy: String(a.currency || 'EUR'), free: num(a.free), invested: num(a.invested), positions: d.positions || [], stale: !!d.stale };
}

// PPR manuais (tabela am_ppr) → valor em EUR (mesma regra de pprCalc no browser).
export async function pprValueEur(supa: any): Promise<number> {
  const { data } = await supa.from('am_ppr').select('data').eq('id', 1).maybeSingle();
  let total = 0;
  for (const f of data?.data?.funds ?? []) {
    const units = (f.buys ?? []).reduce((a: number, b: any) => a + num(b.units), 0);
    const inv = (f.buys ?? []).reduce((a: number, b: any) => a + num(b.amt), 0);
    total += f.price && num(f.price.v) > 0 ? units * num(f.price.v) : inv;
  }
  return total;
}

// Web Push para todos os dispositivos subscritos (mesmas chaves VAPID do am-alerts-check).
export async function pushAll(supa: any, webpush: any, title: string, body: string, url = './#portfolio'): Promise<number> {
  const { data: cfg } = await supa.from('cs_config').select('vapid_public, vapid_private, vapid_subject').eq('id', 1).maybeSingle();
  const { data: subs } = await supa.from('am_push_subs').select('*');
  if (!cfg?.vapid_public || !cfg?.vapid_private || !subs?.length) return 0;
  webpush.setVapidDetails(cfg.vapid_subject || 'mailto:alerts@assetmanager.local', cfg.vapid_public, cfg.vapid_private);
  const payload = JSON.stringify({ title, body, data: { url } });
  let sent = 0; const dead: string[] = [];
  await Promise.all(subs.map(async (s: any) => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); sent++; }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) dead.push(s.endpoint); }
  }));
  if (dead.length) await supa.from('am_push_subs').delete().in('endpoint', dead);
  return sent;
}
