// trade-advisor — assistente estratégico (tab "IA"). Traz para o repo a função que
// só existia em produção. Mudanças vs. a versão deployada: guarda AM_SECRET
// (antes qualquer pessoa gastava créditos Anthropic com a publishable key) e
// limites de tamanho/nº de mensagens. A persona e o modelo mantêm-se.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from '../_shared/auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-am-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_MESSAGES = 30, MAX_MSG_CHARS = 20_000, MAX_CTX_CHARS = 60_000;

const SYSTEM_PERSONA = [
  'És o analista estratégico pessoal do dono deste portefólio de investimento.',
  'Escreves em português europeu, com rigor e sem floreados.',
  '',
  'A tua missão em cada resposta:',
  '1. LER e INTERPRETAR o estado do mercado e as notícias recentes que te são dadas.',
  '2. RESUMIR o que importa (sinal, não ruído) e TIRAR CONCLUSÕES acionáveis para ESTE portefólio concreto — não conselhos genéricos.',
  '3. DEBATER ideias: quando o utilizador propõe algo, dá a tua opinião honesta, concorda ou discorda com fundamento, e apresenta o outro lado.',
  '4. IDENTIFICAR PONTOS CEGOS: riscos, correlações, concentração, distância de liquidação, funding acumulado, dependência de uma narrativa, ou dados em falta que ele possa estar a desconsiderar.',
  '5. Pensar em MAXIMIZAR O GANHO ajustado ao risco do capital disponível em cada momento — inclui gestão de posição, hedges, rotação, e quando NÃO agir.',
  '',
  'Regras de conduta:',
  '- Sê direto e substantivo, mas conciso. Prioriza 2-4 ideias fortes em vez de listas exaustivas.',
  '- Usa **negrito** para os pontos críticos e listas curtas quando ajudarem à leitura.',
  '- Fundamenta com os números que tens (preço, 24h, funding, dominância, F&G, PnL, liquidação, exposição).',
  '- Reconhece incerteza: distingue o que sabes do que é hipótese. Nunca finjas certezas nem inventes dados que não te foram dados.',
  '- Não és consultor financeiro licenciado; dás análise estratégica para decisão informada, não ordens de compra/venda garantidas.',
  '- Faz perguntas de volta quando faltar contexto para uma boa decisão.',
  '',
  'Sobre o RASTREADOR DE TRADES (quando presente no snapshot):',
  '- Cada setup traz um score (0-100) e uma linha de "níveis": preço atual, EMA9/21 (1h), rompimento de 48 velas (máx/mín) e amplitude 24h.',
  '- Quando fizer sentido, propõe um plano acionável a partir desses níveis: **zona de entrada · stop/invalidação · alvo · risco face à liquidação** — usa o rompimento como gatilho/invalidação e a amplitude 24h para dimensionar o stop.',
  '- Dá prioridade a setups em confluência com as posições abertas e assinala os que estão contra elas.',
  '- Nunca apresentes uma entrada como "segura" ou garantida; é sempre uma hipótese com risco, e o utilizador decide.',
].join('\n');

// Consome o stream SSE da Anthropic e devolve apenas o texto final acumulado.
async function streamAnthropicText(body: Record<string, unknown>, apiKey: string): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok || !res.body) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errTxt.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
      } catch (_) { /* ignora linhas parciais */ }
    }
  }
  return text.trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  { const denied = await guard(req, corsHeaders); if (denied) return denied; }

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status });

  try {
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
    if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY não configurada como secret no Supabase.' }, 500);

    const body = await req.json();
    const { messages, context, positions, userMessage } = body ?? {};

    // Compat: telemetria macro (BULLISH/BEARISH) usada por versões antigas.
    if (userMessage === 'TELEMETRY') {
      let fgValue = '50';
      try {
        const fgData = await (await fetch('https://api.alternative.me/fng/?limit=1')).json();
        if (fgData?.data?.[0]?.value) fgValue = fgData.data[0].value;
      } catch (_) {}
      const macroRes = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: `Fear & Greed Index: ${fgValue}/100. Crypto macro trend agora: responde apenas BULLISH ou BEARISH.` }],
        }),
      });
      const macroData = await macroRes.json();
      return json({ insight: macroData?.content?.[0]?.text?.trim() ?? 'NEUTRAL', fg: fgValue });
    }

    // Conversa estratégica. Aceita `messages` ou, por compat, `positions`+`userMessage`.
    let convo: { role: string; content: string }[] = [];
    if (Array.isArray(messages) && messages.length) {
      convo = messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
    } else if (typeof userMessage === 'string') {
      const posCtx = positions?.length ? `Posições abertas:\n${JSON.stringify(positions, null, 2)}\n\n` : '';
      convo = [{ role: 'user', content: (posCtx + userMessage).slice(0, MAX_MSG_CHARS) }];
    }
    if (!convo.length || convo[convo.length - 1].role !== 'user') {
      return json({ error: 'Pedido inválido: faltam mensagens do utilizador.' }, 400);
    }

    const ctxStr = (typeof context === 'string' && context.trim())
      ? context.trim().slice(0, MAX_CTX_CHARS)
      : 'Sem snapshot de mercado/portefólio fornecido nesta chamada.';
    const system = `${SYSTEM_PERSONA}\n\n## Estado atual (dados ao vivo do portefólio e do mercado)\n${ctxStr}\n\nUsa estes dados como verdade de base. Se algo relevante faltar, di-lo.`;

    const insight = await streamAnthropicText({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system,
      messages: convo,
    }, anthropicKey);

    return json({ insight: insight || 'Não consegui gerar uma resposta agora. Tenta novamente.' });
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
});
