import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  Bars, Row, Config, Stats,
  defaultConfig, computeIndicators, generateSignal, regimeOf, backtest, round, TF_MAP,
} from "./engine.ts";

/*
 * validate-signal — camada de I/O (Deno edge function)
 * ====================================================
 * Port fiel (Deno/TS) do harness de VALIDAÇÃO Python (harness.py + evaluate.py).
 * A matemática vive em engine.ts (pura, testável); aqui só há datafeed Bybit v5
 * + o handler HTTP.
 *
 * PROPÓSITO: medir se um conjunto de indicadores tem edge real, LÍQUIDO DE
 * CUSTOS, out-of-sample. Não é um gerador de convicção — é um detetor de treta.
 * Recusar-se a dar sinal (regime chop / confiança abaixo do mínimo) é
 * comportamento correto, não uma falha a "otimizar".
 *
 * Regras duras preservadas do original:
 *   - Sinal na vela FECHADA N; execução no OPEN de N+1 (zero look-ahead/repaint).
 *   - Osciladores correlacionados = UM voto por família (não contam 5x).
 *   - Regime por ADX: 20–25 = zona morta = no-trade. Não alargar.
 *   - Triple-barrier líquida de fees (taker*2) + slippage (*2) + funding.
 *   - Split in-sample / out-of-sample; só o OOS conta.
 *
 * CORREÇÃO vs evaluate.py (ponto 2): o funding estava pró-rateado assumindo
 * velas de 1h (bars/8h). Aqui é parametrizado pelos MINUTOS REAIS da vela do
 * timeframe da corrida — ver evaluateTrade() em engine.ts (barMinutes).
 *
 * Corre no runtime da Supabase (que alcança api.bybit.com) e reutiliza os
 * mesmos endpoints Bybit v5 kline que o index.html já usa. NÃO integra nada no
 * dashboard — devolve só o relatório JSON (Fase 1).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BYBIT = 'https://api.bybit.com';

// --------------------------------------------------------------------------- //
//  Datafeed Bybit v5 kline (mesmos endpoints do index.html; com paginação)    //
// --------------------------------------------------------------------------- //

async function fetchBybit(symbol: string, tf: string, maxBars: number): Promise<Bars> {
  const entry = TF_MAP[tf];
  if (!entry) throw new Error(`timeframe não suportado: ${tf}`);
  const [interval] = entry;
  const rows: number[][] = [];
  let end: number | null = null;
  // Bybit v5: máx. 1000 velas/pedido, devolve do mais recente → mais antigo.
  while (rows.length < maxBars) {
    let url = `${BYBIT}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000`;
    if (end !== null) url += `&end=${end}`;
    const r = await fetch(url);
    const d = await r.json();
    const list: string[][] = d?.result?.list || [];
    if (list.length === 0) break;
    for (const k of list) rows.push([+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
    const oldest = +list[list.length - 1][0];
    end = oldest - 1;
    if (list.length < 1000) break; // não há mais história
  }
  // ordena cronologicamente e deduplica por timestamp
  rows.sort((a, z) => a[0] - z[0]);
  const seen = new Set<number>();
  const b: Bars = { ts: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const k of rows) {
    if (seen.has(k[0])) continue;
    seen.add(k[0]);
    b.ts.push(k[0]); b.open.push(k[1]); b.high.push(k[2]); b.low.push(k[3]); b.close.push(k[4]); b.volume.push(k[5]);
  }
  return b;
}

// --------------------------------------------------------------------------- //
//  HTTP handler                                                               //
// --------------------------------------------------------------------------- //

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const q = url.searchParams;
    const symbol = (q.get("symbol") || "BTCUSDT").toUpperCase();
    const tf = q.get("tf") || "60";
    const mode = q.get("mode") || "backtest";
    const maxBars = Math.min(20000, Math.max(300, parseInt(q.get("maxBars") || "5000", 10)));
    const oosFrac = Math.min(0.9, Math.max(0.1, parseFloat(q.get("oosFrac") || "0.35")));

    const tfEntry = TF_MAP[tf];
    if (!tfEntry) {
      return json({ error: `timeframe não suportado: ${tf}`, suportados: Object.keys(TF_MAP) }, 400);
    }
    const barMinutes = tfEntry[1];
    const cfg: Config = defaultConfig();

    const bars = await fetchBybit(symbol, tf, maxBars);
    if (bars.close.length < 250) {
      return json({ error: "Amostra insuficiente da Bybit.", got_bars: bars.close.length }, 502);
    }

    if (mode === "live") {
      // Sinal da ÚLTIMA vela FECHADA (descarta a vela em formação = último índice).
      const ind = computeIndicators(bars);
      const idx = bars.close.length - 2; // penúltima = última fechada
      const row: Row = {};
      for (const k of Object.keys(ind)) row[k] = ind[k][idx];
      const sig = generateSignal(row, cfg);
      return json({
        symbol, tf, bar_minutes: barMinutes,
        last_closed_ts: new Date(bars.ts[idx]).toISOString(),
        close: bars.close[idx], adx: round(row.adx, 1),
        regime: sig ? sig.regime : regimeOf(row, cfg),
        signal: sig, // null = sem sinal, comportamento correto (não forçar trade)
      });
    }

    const { res, trades } = backtest(bars, cfg, barMinutes, oosFrac);
    const oos: Stats | undefined = res.oos;
    const summary = res.n > 0 && oos && oos.n > 0
      ? {
          symbol, tf, bar_minutes: barMinutes,
          n_oos: oos.n,
          win_pct_oos: oos.win_rate,
          expectancy_R_oos: oos.expectancy_R,
          pf_oos: oos.profit_factor,
          suficiente: oos.n >= 200,
        }
      : null;

    return json({
      symbol, tf, bar_minutes: barMinutes,
      bars_fetched: bars.close.length,
      from: new Date(bars.ts[0]).toISOString(),
      to: new Date(bars.ts[bars.ts.length - 1]).toISOString(),
      signals_generated: trades.length,
      report: res,
      summary_row: summary,
      leitura: "Só o OOS conta. IS a brilhar + OOS a colapsar = overfit. Expectancy OOS <= 0 depois de custos = SEM edge.",
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
