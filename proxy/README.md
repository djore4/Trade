# Proxy read-only da Bybit (opcional)

Este pequeno **Cloudflare Worker** permite ao site ler o teu **portefólio e posições**
da Bybit **sem** pôr o segredo no browser. O worker guarda a chave **read-only** como
*secret* do servidor, assina os pedidos e devolve o JSON ao site.

> Só é preciso se quiseres o portefólio **ao vivo**. Sem isto, o site funciona na mesma
> em modo manual, e os **preços públicos** continuam a atualizar normalmente.

## Segurança (o que este worker garante)

- **Só leitura**: allow-list de endpoints (`position/list`, `wallet-balance`,
  `query-account-coins-balance`, `transaction-log`, `user/query-api`). Tudo o resto → 403.
- **Só GET** → estruturalmente **não** consegue colocar ordens nem mover fundos.
- Exige o header `X-Proxy-Token` (segredo partilhado) → não é um proxy aberto.
- **CORS** restrito à origem do teu site (`ALLOWED_ORIGIN`).
- A chave/segredo **nunca** aparecem nas respostas nem em logs.

## Passos (uma vez)

### 1. Cria uma chave Bybit **só de leitura**
Na Bybit: *API Management → Create New Key*. Marca **apenas leitura** (Read-only):
Positions, Wallet, e (opcional) Assets. **Não** dês permissões de trade/ordens/levantamentos.
Guarda a **API Key** e o **API Secret**.

### 2. Gera um token do proxy
Um valor aleatório qualquer (ex.: no terminal):
```bash
openssl rand -hex 24
```

### 3. Instala o Wrangler e faz login
```bash
npm install -g wrangler
wrangler login
```

### 4. Configura os segredos (a partir desta pasta `proxy/`)
```bash
wrangler secret put BYBIT_API_KEY       # cola a API Key read-only
wrangler secret put BYBIT_API_SECRET    # cola o API Secret
wrangler secret put PROXY_TOKEN         # cola o token do passo 2
```
Confirma em `wrangler.toml` que `ALLOWED_ORIGIN` é a origem do teu site
(por omissão `https://djore4.github.io`).

### 5. Publica
```bash
wrangler deploy
```
No fim, o Wrangler mostra o URL do worker, algo como
`https://bybit-readonly-proxy.<subdominio>.workers.dev`.

### 6. Liga no site
Abre o site → **Definições → Integrações** e cola:
- **URL do proxy** = o URL do worker
- **Token do proxy** = o token do passo 2

Depois usa **"Testar ligação"** (deve dizer *ligada · read-only*), o botão
**"Sincronizar da Bybit"** nos Inversos e o painel **"Saldos ao vivo"** no Tracker.

## Desenvolvimento local (opcional)
```bash
wrangler dev   # corre o worker localmente para testes
```

## Alternativa sem serverless
Se preferires não usar a Cloudflare, o mesmo esquema de assinatura pode correr num
pequeno servidor local — mas aí o portefólio só funciona com esse servidor ligado
(não a partir do telemóvel).
