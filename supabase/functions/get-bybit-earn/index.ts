// get-bybit-earn — lê os fundos que NÃO estão na Unified Trading Account:
//
//   1) Bybit Earn (staking / flexible savings) — /v5/earn/position
//   2) Funding account (moedas paradas, ainda não subscritas em Earn)
//      — /v5/asset/transfer/query-account-coins-balance?accountType=FUND
//
// Porquê: a app só lê a UNIFIED (get-bybit-wallet). Os altcoins de DCA que estão
// em Earn ficam invisíveis no portefólio. Esta função devolve-os normalizados
// para o frontend os fundir no walletData e valorizar aos preços públicos.
//
// IMPORTANTE — dependências que ESTA função não pode contornar:
//   • A Earn API exige uma API key com permissão "Earn".
//   • A Earn API é, historicamente, SÓ da conta MASTER (não subcontas).
// Por isso resolvemos as credenciais preferindo a MASTER (BYBIT_API_KEY), ao
// contrário do resto do bot que prefere a subconta. Se a key não tiver o scope
// ou for de subconta, o Bybit devolve retCode≠0 — devolvemos esse retCode/retMsg
// em cada bloco (campo _diag) para dar diagnóstico imediato no browser.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { bybitGet, type BybitKeys } from "../_shared/bybit.ts";

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Resolve credenciais preferindo a conta MASTER (Earn é master-only). CRÍTICO:
// nunca misturar contas — usar o CONJUNTO master inteiro (key+secret+priv) ou,
// se não houver master, o conjunto sub inteiro. O fallback campo-a-campo dava
// master.apiKey + sub.privateKeyPem (o bot assina RSA na subconta) → assinatura
// inválida (retCode 10004), porque a master é HMAC e não tem chave RSA própria.
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

interface Holding {
  coin: string;
  qty: number;         // quantidade detida (principal em Earn / saldo em Funding)
  source: 'earn' | 'funding';
  category?: string;   // FlexibleSaving | OnChain (só Earn)
  productId?: string;
  claimableYield?: number; // rendimento por reclamar, em unidades da moeda (Earn)
  totalPnl?: number;       // pnl acumulado reportado pela Bybit (Earn), se vier
}

// Uma categoria de Earn. Devolve as posições + diagnóstico do retCode.
async function earnCategory(category: string, k: BybitKeys) {
  try {
    const d = await bybitGet('/v5/earn/position', `category=${category}`, k);
    const list = (d?.result?.list ?? []) as Record<string, unknown>[];
    const holdings: Holding[] = list
      .map((x) => ({
        coin: String(x.coin ?? '').toUpperCase(),
        qty: parseFloat(String(x.amount ?? '0')) || 0,
        source: 'earn' as const,
        category,
        productId: x.productId != null ? String(x.productId) : undefined,
        claimableYield: parseFloat(String(x.claimableYield ?? '0')) || 0,
        totalPnl: parseFloat(String(x.totalPnl ?? '0')) || 0,
      }))
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

  // Agrega por moeda (uma moeda pode ter FlexibleSaving + OnChain + Funding em
  // simultâneo) — o frontend só quer a quantidade total detida por símbolo.
  const byCoin: Record<string, { coin: string; qty: number; claimableYield: number; sources: string[] }> = {};
  for (const h of holdings) {
    const a = (byCoin[h.coin] ??= { coin: h.coin, qty: 0, claimableYield: 0, sources: [] });
    a.qty += h.qty;
    a.claimableYield += h.claimableYield ?? 0;
    const tag = h.source === 'earn' ? (h.category ?? 'earn') : 'funding';
    if (!a.sources.includes(tag)) a.sources.push(tag);
  }

  return json({
    holdings,                                // detalhe por posição
    byCoin: Object.values(byCoin),           // agregado por moeda (para o portefólio)
    _diag: [flex.diag, onchain.diag, fund.diag], // retCode/retMsg por bloco
    ts: Date.now(),
  });
});
