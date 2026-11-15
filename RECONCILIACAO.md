# Reconciliação da conta de trading Bybit (UTA) — 10/12/2024 → 15/11/2026

Fonte: livro de transações da Bybit (`/v5/account/transaction-log`, `accountType=UNIFIED`), lido dia a dia (6 dias muito intensos, hora a hora).
112 585 registos TRADE em 706 dias. Valores em USDT+USDC.

## Teste de integridade
Soma de todas as variações (`change`) vs variação do saldo (`cashBalance`) no mesmo período: **diferença de 163 USDT em ~115 000 (0,14%)**,
atribuível a 6 horas que a Bybit recusou ler (limite de pedidos). O livro está, portanto, completo.

## Capital (fronteira da conta de trading)
| | USDT+USDC |
|---|---:|
| Transferências para a conta | 114 974 |
| Transferências para fora | −18 783 |
| Staking líquido (subscrições − resgates) | −955 |
| **Capital líquido** | **95 236** |
| + moedas não estáveis (ADA, BTC, DOT… ao preço do dia) | ≈ +12 300 |
| **Total importado para a Análise (Bybit)** | **107 539 $ ≈ 94 245 €** |

Os registos de depósito (`/v5/asset/deposit/query-record`) só mostravam ~41,8 mil €: o resto entrou por **cartão/P2P/Funding**, que só aparece
como TRANSFER_IN no livro. Por isso a primeira versão da Análise subestimava o capital em mais de metade.

## Resultado de trading (livro)
| | USDT+USDC |
|---|---:|
| PnL bruto dos trades (112 585 execuções) | −65 435 |
| Comissões (trades + liquidações) | −19 371 |
| **119 liquidações** | **−33 550** |
| Funding (SETTLEMENT) | +2 114 |
| **Resultado total de trading** | **−115 858** |
| Conversões entre moedas (compras − vendas) | +22 812 (neutro em USD) |

O `closed-pnl` da Bybit (usado no Diário) soma −89 mil $: corresponde ao PnL dos trades líquido de comissões (−84,4 mil) e **não mostra as
liquidações** (−33,6 mil). O Diário subestima, por isso, a perda real.

## Perímetro
Cada fonte tem a sua fronteira, e só se compara capital com valor da MESMA fonte (tabela "Capital vs valor, por fonte" na Análise):
Bybit (conta de trading), Trading 212 (depósitos/levantamentos), PPR (compras). Não inclui o funding/Earn fora da conta de trading.

`am-recon` (função de diagnóstico, só leitura, protegida) foi usada para esta leitura e pode ser apagada no painel quando já não for precisa.
