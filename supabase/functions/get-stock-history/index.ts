import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Histórico de preço de acoes (para isolar ativos T212 no grafico do portefolio).
// Fonte: API publica de chart do Yahoo Finance (sem chave). Só leitura.
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    const range = url.searchParams.get('range') || '6mo';
    const interval = url.searchParams.get('interval') || '1d';

    if (!symbol) {
      return new Response(JSON.stringify({ error: 'symbol em falta' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      });
    }

    const y = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const r = await fetch(y, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeDesk/1.0)' } });
    if (!r.ok) {
      const t = await r.text();
      return new Response(JSON.stringify({ error: `Yahoo ${r.status}`, detail: t.slice(0, 200) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 502,
      });
    }
    const d = await r.json();
    const res = d?.chart?.result?.[0];
    const ts: number[] = res?.timestamp || [];
    const closes: (number | null)[] = res?.indicators?.quote?.[0]?.close || [];
    const points: { t: number; c: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c != null && isFinite(c)) points.push({ t: ts[i], c });
    }

    return new Response(JSON.stringify({ symbol, points }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    });
  }
});
