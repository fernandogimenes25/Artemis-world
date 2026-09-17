// /api/atualizar-resultado.js
//
// Roda sozinha todo dia (via Vercel Cron, configurado no vercel.json).
// 1. Busca o histórico de resultado (PnL) da conta Futures na Binance
// 2. Calcula o resultado acumulado e do dia
// 3. Salva um arquivo dados-cripto.json atualizado no repositório do GitHub
//    (isso dispara um novo deploy automático na Vercel)
//
// VARIÁVEIS DE AMBIENTE NECESSÁRIAS (configurar no painel da Vercel,
// Project Settings > Environment Variables — NUNCA no código):
//   BINANCE_API_KEY      - chave de API só-leitura da Binance
//   BINANCE_API_SECRET   - secret dessa mesma chave
//   GITHUB_TOKEN         - Personal Access Token do GitHub com permissão
//                          "repo" (só pra esse repositório, se possível)
//   GITHUB_OWNER         - ex: "fernandogimenes25"
//   GITHUB_REPO          - ex: "Artemis-world"
//
// BASE DE CAPITAL: ajuste BASE_USD abaixo pro valor real investido na
// cesta (hoje $100 por ativo x 5 ativos = $500, conforme o backtest).

const crypto = require('crypto');

const BASE_USD = 500;       // capital real alocado na cesta
const BASE_ARTE = 1000;     // referência em ARTE (1 ARTE ≈ R$1)
const SYMBOLS = ['UBUSDT', 'PIEVERSEUSDT', 'PUMPUSDT', 'PLUMEUSDT', 'CCUSDT'];

function assinar(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function buscarIncomeHistory(apiKey, apiSecret, symbol, startTime) {
  const timestamp = Date.now();
  const params = new URLSearchParams({
    symbol,
    incomeType: 'REALIZED_PNL',
    startTime: String(startTime),
    limit: '1000',
    timestamp: String(timestamp),
  });
  const signature = assinar(params.toString(), apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/income?${params.toString()}&signature=${signature}`;

  const resp = await fetch(url, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (!resp.ok) {
    const texto = await resp.text();
    throw new Error(`Binance API erro (${symbol}): ${resp.status} - ${texto}`);
  }
  return resp.json();
}

async function buscarShaAtual(owner, repo, caminho, token) {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${caminho}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
  );
  if (resp.status === 404) return null; // arquivo ainda não existe
  if (!resp.ok) throw new Error(`GitHub erro ao buscar sha: ${resp.status}`);
  const data = await resp.json();
  return data.sha;
}

async function salvarNoGithub(owner, repo, caminho, conteudoObj, token) {
  const sha = await buscarShaAtual(owner, repo, caminho, token);
  const conteudoBase64 = Buffer.from(JSON.stringify(conteudoObj, null, 2)).toString('base64');

  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${caminho}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({
        message: `Atualização automática do resultado cripto - ${new Date().toISOString()}`,
        content: conteudoBase64,
        sha: sha || undefined,
      }),
    }
  );
  if (!resp.ok) {
    const texto = await resp.text();
    throw new Error(`GitHub erro ao salvar: ${resp.status} - ${texto}`);
  }
  return resp.json();
}

module.exports = async function handler(req, res) {
  try {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    const githubToken = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;

    if (!apiKey || !apiSecret || !githubToken || !owner || !repo) {
      return res.status(500).json({ erro: 'Faltando variável de ambiente. Confira BINANCE_API_KEY, BINANCE_API_SECRET, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.' });
    }

    // diagnóstico: mostra de qual região da Vercel essa função rodou
    console.log('Rodando na região:', process.env.VERCEL_REGION);

    // início do ano corrente (pra acumulado 2026)
    const inicioAno = new Date(new Date().getFullYear(), 0, 1).getTime();
    // início do dia de hoje (fuso Brasil, UTC-3)
    const agora = new Date();
    const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime() - 3 * 60 * 60 * 1000;

    let pnlAcumuladoUsd = 0;
    let pnlHojeUsd = 0;
    const porMes = {}; // { "2026-01": pnl, "2026-02": pnl, ... }

    for (const symbol of SYMBOLS) {
      const registros = await buscarIncomeHistory(apiKey, apiSecret, symbol, inicioAno);
      registros.forEach((r) => {
        const valor = parseFloat(r.income);
        const ts = Number(r.time);
        pnlAcumuladoUsd += valor;
        if (ts >= inicioHoje) pnlHojeUsd += valor;

        const data = new Date(ts);
        const chaveMes = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
        porMes[chaveMes] = (porMes[chaveMes] || 0) + valor;
      });
    }

    const pctAcumulado = (pnlAcumuladoUsd / BASE_USD) * 100;
    const arteAtual = Math.round(BASE_ARTE * (1 + pctAcumulado / 100));

    const dados = {
      atualizado_em: new Date().toISOString(),
      base_usd: BASE_USD,
      base_arte: BASE_ARTE,
      pnl_acumulado_usd: parseFloat(pnlAcumuladoUsd.toFixed(2)),
      pnl_hoje_usd: parseFloat(pnlHojeUsd.toFixed(2)),
      pct_acumulado: parseFloat(pctAcumulado.toFixed(1)),
      arte_atual: arteAtual,
      por_mes: Object.fromEntries(
        Object.entries(porMes).map(([k, v]) => [k, parseFloat(v.toFixed(2))])
      ),
    };

    await salvarNoGithub(owner, repo, 'dados-cripto.json', dados, githubToken);

    return res.status(200).json({ ok: true, dados });
  } catch (erro) {
    console.error(erro);
    return res.status(500).json({ erro: erro.message, regiao_vercel: process.env.VERCEL_REGION || 'desconhecida' });
  }
};
