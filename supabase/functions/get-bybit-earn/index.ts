// get-bybit-earn — lê os fundos que NÃO estão na Unified Trading Account:
//
//   1) Bybit Earn (staking / flexible savings) — /v5/earn/position
//   2) Funding account (moedas paradas, ainda não subscritas em Earn)
//      — /v5/asset/transfer/query-account-coins-balance?accountType=FUND
//
// Além do principal, junta a APR (de /v5/earn/product, casada por productId) e o
// income acumulado (totalPnl da posição) + o yield por reclamar (claimableYield).
//
// Porquê: a app só lê a UNIFIED (get-bybit-wallet). Os altcoins de DCA que estão
// em Earn ficam invisíveis no portefólio. Esta função devolve-os normalizados
// para o frontend os fundir no walletData e valorizar aos preços públicos.
//
// IMPORTANTE — dependências que ESTA função não pode contornar:
//   • A Earn API exige uma API key com permissão "Earn".
//   • A Earn API é, historicamente, SÓ da conta MASTER (não subcontas).
// Resolvemos as credenciais com o CONJUNTO master inteiro (nunca misturar com o
// sub — isso dava assinatura inválida, retCode 10004). _diag traz o retCode/retMsg
// de cada bloco para diagnóstico imediato.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { bybitGet, type BybitKeys } from "../_shared/bybit.ts";

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Conjunto master consistente (key+secret+priv), ou sub inteiro se não houver master.
function masterKeys(): BybitKeys {
  const base = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';
  const mKey = Deno.env.get('BYBIT_API_KEY');
  if (mKey) return {
    apiKey: mKey,
    apiSecret: Deno.env.get('BYBIT_API_SECRET') ?? '',
    privateKeyPem: Deno.env.get('BYBIT_API_PRIVATE_KEY') ?? '',
    base,
  };
  return {
    apiKey: Deno.env.get('BYBIT_SUB_API_KEY') ?? '',
    apiSecret: Deno.env.get('BYBIT_SUB_API_SECRET') ?? '',
    privateKeyPem: Deno.env.get('BYBIT_SUB_API_PRIVATE_KEY') ?? '',
    base,
  };
}

// APR pode vir como ratio ("0.0345") ou percentagem ("3.45%"/"3.45"). Normaliza
// para percentagem: <=1 assume-se ratio (×100); senão já é percentagem.
function normApr(raw: unknown): number {
  const v = parseFloat(String(raw ?? '0').replace('%', '')) || 0;
  return v > 0 && v <= 1 ? v * 100 : v;
}

interface Holding {
  coin: string;
  qty: number;             // principal em Earn / saldo em Funding
  source: 'earn' | 'funding';
  category?: string;       // FlexibleSaving | OnChain (só Earn)
  productId?: string;
  apr?: number;            // % anual estimada (só Earn)
  claimableYield?: number; // rendimento por reclamar, em unidades da moeda
  totalPnl?: number;       // income acumulado reportado pela Bybit
}

// APR por productId, a partir do catálogo de produtos da categoria.
async function productApr(category: string, k: BybitKeys): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  try {
    const d = await bybitGet('/v5/earn/product', `category=${category}`, k);
    for (const x of (d?.result?.list ?? []) as Record<string, unknown>[]) {
      if (x.productId != null) map[String(x.productId)] = normApr(x.estimateApr ?? x.apr);
    }
  } catch (_e) { /* sem catálogo -> APR fica 0 */ }
  return map;
}

// Uma categoria de Earn. Devolve as posições (com APR casada) + diagnóstico.
async function earnCategory(category: string, k: BybitKeys) {
  try {
    const [aprMap, d] = await Promise.all([
      productApr(category, k),
      bybitGet('/v5/earn/position', `category=${category}`, k),
    ]);
    const list = (d?.result?.list ?? []) as Record<string, unknown>[];
    const holdings: Holding[] = list
      .map((x) => {
        const productId = x.productId != null ? String(x.productId) : undefined;
        return {
          coin: String(x.coin ?? '').toUpperCase(),
          qty: parseFloat(String(x.amount ?? '0')) || 0,
          source: 'earn' as const,
          category,
          productId,
          apr: productId ? (aprMap[productId] ?? 0) : 0,
          claimableYield: parseFloat(String(x.claimableYield ?? '0')) || 0,
          totalPnl: parseFloat(String(x.totalPnl ?? '0')) || 0,
        };
      })
      .filter((h) => h.coin && h.qty > 0);
    return { holdings, diag: { category, retCode: d?.retCode, retMsg: d?.retMsg, raw: list.length } };
  } catch (e) {
    return { holdings: [] as Holding[], diag: { category, error: String((e as Error)?.message || e) } };
  }
}

// Saldo da Funding account (moedas ainda não colocadas em Earn).
async function fundingBalance(k: BybitKeys) {
  try {
    const d = await bybitGet('/v5/asset/transfer/query-account-coins-balance', 'accountType=FUND', k);
    const list = (d?.result?.balance ?? []) as Record<string, unknown>[];
    const holdings: Holding[] = list
      .map((x) => ({
        coin: String(x.coin ?? '').toUpperCase(),
        qty: parseFloat(String(x.walletBalance ?? '0')) || 0,
        source: 'funding' as const,
      }))
      .filter((h) => h.coin && h.qty > 0);
    return { holdings, diag: { accountType: 'FUND', retCode: d?.retCode, retMsg: d?.retMsg, raw: list.length } };
  } catch (e) {
    return { holdings: [] as Holding[], diag: { accountType: 'FUND', error: String((e as Error)?.message || e) } };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const k = masterKeys();
  if (!k.apiKey || (!k.apiSecret && !k.privateKeyPem)) {
    return json({ error: 'Credenciais Bybit (master) não configuradas.' }, 500);
  }

  const [flex, onchain, fund] = await Promise.all([
    earnCategory('FlexibleSaving', k),
    earnCategory('OnChain', k),
    fundingBalance(k),
  ]);

  const holdings = [...flex.holdings, ...onchain.holdings, ...fund.holdings];

  // Agrega por moeda. APR = média ponderada pela qty; income/yield = soma.
  const agg: Record<string, { coin: string; qty: number; aprQty: number; claimableYield: number; income: number; sources: string[] }> = {};
  for (const h of holdings) {
    const a = (agg[h.coin] ??= { coin: h.coin, qty: 0, aprQty: 0, claimableYield: 0, income: 0, sources: [] });
    a.qty += h.qty;
    a.aprQty += (h.apr ?? 0) * h.qty;
    a.claimableYield += h.claimableYield ?? 0;
    a.income += h.totalPnl ?? 0;
    const tag = h.source === 'earn' ? (h.category ?? 'earn') : 'funding';
    if (!a.sources.includes(tag)) a.sources.push(tag);
  }
  const byCoin = Object.values(agg).map((a) => ({
    coin: a.coin,
    qty: a.qty,
    apr: a.qty > 0 ? a.aprQty / a.qty : 0,  // % anual ponderada
    claimableYield: a.claimableYield,
    income: a.income,                        // income acumulado (totalPnl)
    sources: a.sources,
  }));

  return json({
    holdings,                                      // detalhe por posição
    byCoin,                                        // agregado por moeda (portefólio)
    _diag: [flex.diag, onchain.diag, fund.diag],
    ts: Date.now(),
  });
});
