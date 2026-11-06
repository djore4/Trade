import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Proxy de RSS/Atom -> JSON (resolve CORS e rate-limits de serviços terceiros).
// Fontes permitidas: cripto + ações/mercados (Yahoo Finance por ticker, CNBC, MarketWatch).
const ALLOW = [
  'cointelegraph.com', 'coindesk.com', 'bitcoinmagazine.com', 'feedburner.com',
  'finance.yahoo.com', 'feeds.finance.yahoo.com', 'cnbc.com', 'marketwatch.com',
];

function pick(block: string, tag: string): string {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? m[1] : '';
}
function clean(s: string): string {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .trim();
}
// Extrai a miniatura da própria notícia: media:content/thumbnail, enclosure ou 1º <img>.
function pickImage(block: string): string {
  let m = block.match(/<media:(?:content|thumbnail)[^>]*\burl=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<enclosure[^>]*\burl=["']([^"']+)["'][^>]*type=["']image/i)
    || block.match(/<enclosure[^>]*type=["']image[^>]*\burl=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<itunes:image[^>]*\bhref=["']([^"']+)["']/i);
  if (m) return m[1];
  // <img> em CDATA/description/content:encoded (cru ou codificado)
  const dec = block.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'");
  m = dec.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  if (m) return m[1];
  return '';
}
function parseFeed(xml: string) {
  const out: { title: string; link: string; pubDate: string; image: string }[] = [];
  let blocks = xml.match(/<item[\s\S]*?<\/item>/gi);
  const atom = !blocks;
  if (!blocks) blocks = xml.match(/<entry[\s\S]*?<\/entry>/gi);
  for (const b of (blocks || [])) {
    const title = clean(pick(b, 'title'));
    let link = clean(pick(b, 'link'));
    if (atom || !link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const pubDate = clean(pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date'));
    const image = pickImage(b);
    if (title) out.push({ title, link, pubDate, image });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const feed = new URL(req.url).searchParams.get('feed') || '';
    if (!feed) {
      return new Response(JSON.stringify({ error: 'feed em falta' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }
    let host = '';
    try { host = new URL(feed).hostname; } catch (_) { host = ''; }
    const ok = ALLOW.some(h => host === h || host.endsWith('.' + h));
    if (!ok) {
      return new Response(JSON.stringify({ error: 'fonte nao permitida' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 });
    }
    const r = await fetch(feed, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeDesk/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `feed ${r.status}` }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 502 });
    }
    const xml = await r.text();
    const items = parseFeed(xml);
    return new Response(JSON.stringify({ items }), { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' }, status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
