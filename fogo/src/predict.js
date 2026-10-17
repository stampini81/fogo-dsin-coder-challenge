'use strict';
// Motor preditivo do F.O.G.O.
// Tudo aqui é aprendido a partir dos dados históricos — nenhum parâmetro do gerador sintético é lido.
const { BAIRROS, REGIONS } = require('./geo');
const { EQUIPMENT_TYPES, SEVERITY } = require('./catalog');
const { DAY, HOUR, clamp, round, sigmoid, addDays, isoDate } = require('./util');

const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const SHRINK_K = 3;     // força do prior no Bayes empírico (em semanas equivalentes)
const AGENT_CAPACITY_4H = 1.2; // ocorrências que um agente consegue atender em 4 h sem abandonar a patrulha preventiva

/* ------------------------------------------------------------------ */
/* 1. Modelo de taxa de ocorrências (Poisson + Bayes empírico + tendência) */
/* ------------------------------------------------------------------ */
function fitIncidentModel(incidents, now = new Date(), opts = {}) {
  const from = opts.from || new Date(now.getTime() - 120 * DAY);
  const to = opts.to || now;
  const data = incidents.filter(i => { const t = new Date(i.inicio); return t >= from && t < to; });
  const weeks = Math.max(1, (to - from) / (7 * DAY));
  const idx = Object.fromEntries(BAIRROS.map((b, i) => [b.nome, i]));
  const counts = BAIRROS.map(() => Array.from({ length: 7 }, () => new Array(24).fill(0)));
  for (const i of data) {
    const t = new Date(i.inicio); const bi = idx[i.bairro];
    if (bi != null) counts[bi][t.getDay()][t.getHours()]++;
  }
  // Modelo hierárquico multiplicativo:
  //   λ(b, d, h) = padrãoCidade(d, h) × participaçãoBairro(b) × desvioHorárioBairro(b, h)
  // O padrão da cidade tem muitos dados (estável); o desvio de cada bairro é encolhido
  // em direção a 1 (Bayes empírico) quando há poucas ocorrências naquele bairro/hora.
  const N = data.length || 1;
  const city = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const b of counts) for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) city[d][h] += b[d][h];
  // suavização circular leve do padrão da cidade (hora anterior/seguinte)
  const citySm = city.map((row, d) => row.map((v, h) => (0.25 * row[(h + 23) % 24] + 0.5 * v + 0.25 * row[(h + 1) % 24]) / weeks));
  const totals = counts.map(b => b.reduce((s, row) => s + row.reduce((a, c) => a + c, 0), 0));
  const share = totals.map(t => (t + 2) / (N + 2 * BAIRROS.length));
  const cityH = new Array(24).fill(0);
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cityH[h] += city[d][h];
  const dev = counts.map((b, bi) => new Array(24).fill(0).map((_, h) => {
    let obs = 0; for (let d = 0; d < 7; d++) obs += b[d][h];
    const exp = cityH[h] * share[bi];
    const K = 8; // pseudo-ocorrências do prior
    return (obs + K) / (exp + K);
  }));
  const rate = counts.map((b, bi) => b.map((row, d) => row.map((_, h) => citySm[d][h] * share[bi] * dev[bi][h])));
  // tendência: últimos 28 dias vs. ritmo dos 56 anteriores, com prior Gama (encolhe ruído de amostras pequenas)
  const t28 = new Date(to.getTime() - 28 * DAY), t84 = new Date(to.getTime() - 84 * DAY);
  const trend = BAIRROS.map(b => {
    const recent = data.filter(i => i.bairro === b.nome && new Date(i.inicio) >= t28).length;
    const prev = data.filter(i => i.bairro === b.nome && new Date(i.inicio) >= t84 && new Date(i.inicio) < t28).length;
    const expected = prev / 2;
    const A = 20;
    const ratio = (recent + A) / (expected + A);
    const z = (recent - expected) / Math.sqrt(Math.max(1, 1.5 * expected)); // variância de recent - prev/2
    return { bairro: b.nome, recentes: recent, anteriores: prev, fator: round(clamp(ratio, 0.6, 1.8), 3), significativa: Math.abs(z) >= 2, z: round(z, 2) };
  });
  // distribuição de referência para converter taxa em percentil
  const all = [];
  rate.forEach((b, bi) => b.forEach(row => row.forEach(v => all.push(v * trend[bi].fator))));
  all.sort((a, b) => a - b);
  return { rate, trend, weeks: round(weeks, 1), ref: all, n: data.length };
}

function percentile(ref, v) {
  let lo = 0, hi = ref.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] <= v) lo = m + 1; else hi = m; }
  return Math.round((lo / ref.length) * 100);
}
const riskLevel = p => p >= 90 ? 'critico' : p >= 75 ? 'alto' : p >= 50 ? 'moderado' : 'baixo';

// fator ao vivo: câmeras/radares fora do ar e ocorrências abertas aumentam o risco das próximas horas
function liveFactors(state) {
  const out = {};
  for (const b of BAIRROS) {
    const eqs = state.equipments.filter(e => e.localizacao.bairro === b.nome && ['camera', 'radar', 'semaforo'].includes(e.tipo) && e.situacao !== 'nao_instalado');
    const down = eqs.filter(e => e.situacao !== 'operacional').length;
    const share = eqs.length ? down / eqs.length : 0;
    const open = (state.liveIncidents || []).filter(i => i.bairro === b.nome && i.status !== 'encerrada').length;
    out[b.nome] = { fator: round(1 + 0.35 * share + Math.min(0.5, 0.12 * open), 3), monitoramentoForaDoAr: round(share * 100, 1), ocorrenciasAbertas: open };
  }
  return out;
}

function forecast(model, state, now = new Date(), hours = 24) {
  const live = liveFactors(state);
  const start = new Date(now); start.setMinutes(0, 0, 0);
  const bairros = BAIRROS.map((b, bi) => {
    const horas = [];
    for (let k = 0; k < hours; k++) {
      const t = new Date(start.getTime() + k * HOUR);
      const decay = Math.max(0, 1 - k / 4); // efeito ao vivo vale para as próximas ~4h
      const lf = 1 + (live[b.nome].fator - 1) * decay;
      const lambda = model.rate[bi][t.getDay()][t.getHours()] * model.trend[bi].fator * lf;
      const pct = percentile(model.ref, lambda);
      horas.push({ hora: t.toISOString(), lambda: round(lambda, 4), probabilidade: round(1 - Math.exp(-lambda), 4), indice: pct, nivel: riskLevel(pct) });
    }
    const exp24 = horas.reduce((s, h) => s + h.lambda, 0);
    const pico = horas.reduce((a, h) => h.indice > a.indice ? h : a, horas[0]);
    const next4 = horas.slice(0, 4).reduce((s, h) => s + h.lambda, 0);
    return {
      bairro: b.nome, regiao: b.regiao, lat: b.lat, lng: b.lng,
      ocorrenciasEsperadas24h: round(exp24, 2),
      probAoMenosUmaProx4h: round(1 - Math.exp(-next4), 3),
      indiceAtual: horas[0].indice, nivelAtual: horas[0].nivel,
      pico: { hora: pico.hora, indice: pico.indice, nivel: pico.nivel },
      tendencia: model.trend[bi], aoVivo: live[b.nome], horas,
    };
  });
  return bairros.sort((a, b) => b.indiceAtual - a.indiceAtual || b.ocorrenciasEsperadas24h - a.ocorrenciasEsperadas24h);
}

// Validação fora da amostra: treina com os dados até 28 dias atrás e testa nos últimos 28 dias,
// comparando com um baseline ingênuo (média histórica do bairro, sem hora/dia).
function backtest(incidents, now = new Date()) {
  const cut = new Date(now.getTime() - 28 * DAY);
  const model = fitIncidentModel(incidents, cut, { from: new Date(cut.getTime() - 92 * DAY), to: cut });
  const test = incidents.filter(i => new Date(i.inicio) >= cut && new Date(i.inicio) < now);
  const idx = Object.fromEntries(BAIRROS.map((b, i) => [b.nome, i]));
  // blocos de 4 horas por bairro
  const blocks = new Map();
  for (const i of test) {
    const t = new Date(i.inicio); const key = `${idx[i.bairro]}|${Math.floor((t - cut) / (4 * HOUR))}`;
    blocks.set(key, (blocks.get(key) || 0) + 1);
  }
  const train = incidents.filter(i => { const t = new Date(i.inicio); return t < cut && t >= new Date(cut.getTime() - 92 * DAY); });
  const naive = BAIRROS.map(b => train.filter(i => i.bairro === b.nome).length / (92 * 6));
  let maeM = 0, maeN = 0, n = 0, devM = 0, devN = 0;
  const nBlocks = Math.floor(28 * 6);
  for (let bi = 0; bi < BAIRROS.length; bi++) {
    for (let k = 0; k < nBlocks; k++) {
      let pred = 0;
      for (let h = 0; h < 4; h++) {
        const t = new Date(cut.getTime() + (k * 4 + h) * HOUR);
        pred += model.rate[bi][t.getDay()][t.getHours()] * model.trend[bi].fator;
      }
      const y = blocks.get(`${bi}|${k}`) || 0;
      maeM += Math.abs(y - pred); maeN += Math.abs(y - naive[bi]);
      devM += poissonDev(y, pred); devN += poissonDev(y, naive[bi]);
      n++;
    }
  }
  return {
    periodoTeste: `${isoDate(cut)} a ${isoDate(now)}`,
    blocosAvaliados: n, ocorrenciasNoTeste: test.length,
    maeModelo: round(maeM / n, 4), maeBaseline: round(maeN / n, 4),
    devianceModelo: round(devM, 1), devianceBaseline: round(devN, 1),
    ganhoDeviance: round(100 * (1 - devM / devN), 1),
  };
}
const poissonDev = (y, mu) => { mu = Math.max(mu, 1e-6); return 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu)); };

function heatmap(model, bairro = null) {
  const sel = bairro ? [BAIRROS.findIndex(b => b.nome === bairro)] : BAIRROS.map((_, i) => i);
  const grid = WD.map((_, d) => new Array(24).fill(0).map((__, h) => round(sel.reduce((s, bi) => s + model.rate[bi][d][h] * model.trend[bi].fator, 0), 4)));
  return { dias: WD, grid };
}

/* ------------------------------------------------------------------ */
/* 2. Reforço de agentes por região e janela de 4 horas                 */
/* ------------------------------------------------------------------ */
const shiftCovers = (turno, h) => turno === 'manha' ? h >= 6 && h < 14 : turno === 'tarde' ? h >= 14 && h < 22 : h >= 22 || h < 6;

function reinforcement(fc, agents, now = new Date(), blocks = 3) {
  const start = new Date(now); start.setMinutes(0, 0, 0);
  const janelas = [];
  for (let k = 0; k < blocks; k++) {
    const t0 = new Date(start.getTime() + k * 4 * HOUR);
    const regioes = REGIONS.map(reg => {
      const esperado = fc.filter(b => b.regiao === reg).reduce((s, b) => s + b.horas.slice(k * 4, k * 4 + 4).reduce((a, h) => a + h.lambda, 0), 0);
      const midH = (t0.getHours() + 2) % 24;
      // janela atual: usa a situação real; janelas futuras: escala de turnos
      const disponiveis = agents.filter(a => a.regiao === reg && shiftCovers(a.turno, midH) && (k > 0 || a.situacao !== 'fora_de_servico')).length;
      const nB = BAIRROS.filter(b => b.regiao === reg).length;
      const noite = midH >= 22 || midH < 6;
      const presencaMinima = noite ? Math.ceil(nB / 2) : nB; // 1 agente por bairro de dia; 1 a cada 2 bairros de madrugada
      const necessarios = Math.max(presencaMinima, Math.ceil(esperado / AGENT_CAPACITY_4H));
      return { regiao: reg, ocorrenciasEsperadas: round(esperado, 2), presencaMinima, agentesNecessarios: necessarios, agentesDisponiveis: disponiveis, saldo: disponiveis - necessarios };
    });
    // recomendações: mover excedentes para déficits
    const sur = regioes.filter(r => r.saldo > 0).map(r => ({ ...r, sobra: r.saldo }));
    const recs = [];
    for (const d of regioes.filter(r => r.saldo < 0).sort((a, b) => a.saldo - b.saldo)) {
      let falta = -d.saldo;
      for (const s of sur.sort((a, b) => b.sobra - a.sobra)) {
        if (!falta) break;
        const mv = Math.min(falta, s.sobra);
        if (mv > 0) { recs.push({ de: s.regiao, para: d.regiao, agentes: mv }); s.sobra -= mv; falta -= mv; }
      }
      if (falta > 0) recs.push({ de: null, para: d.regiao, agentes: falta, observacao: 'Sem excedente em outras regiões: convocar reforço/hora extra' });
    }
    janelas.push({ inicio: t0.toISOString(), fim: new Date(t0.getTime() + 4 * HOUR).toISOString(), regioes, recomendacoes: recs });
  }
  return janelas;
}

/* ------------------------------------------------------------------ */
/* 3. Risco de falha de equipamentos — regressão logística treinada     */
/* ------------------------------------------------------------------ */
const FEATURES = ['razaoCicloManutencao', 'idadeAnos', 'falhas180d', 'movel'];

function featuresAt(eq, t) {
  const hist = eq.historico || [];
  const before = hist.filter(h => new Date(h.data) < t);
  const lastM = [...before].reverse().find(h => h.tipo === 'manutencao');
  const per = (eq.manutencao && eq.manutencao.periodicidadeDias) || (EQUIPMENT_TYPES[eq.tipo] || {}).periodicidadeDias || 90;
  const since = lastM ? (t - new Date(lastM.data)) / DAY : per;
  const inst = eq.dataInstalacao ? new Date(eq.dataInstalacao) : new Date(eq.criadoEm || t);
  const age = Math.max(0, (t - inst) / (365 * DAY));
  const fails = before.filter(h => h.tipo === 'falha' && (t - new Date(h.data)) / DAY <= 180).length;
  return [clamp(since / per, 0, 3), clamp(age, 0, 15), Math.min(fails, 6), EQUIPMENT_TYPES[eq.tipo] && EQUIPMENT_TYPES[eq.tipo].movel ? 1 : 0];
}

function buildSamples(equipments, now, weeksBack = 26, skipLast = 0) {
  const X = [], y = [], wk = [];
  for (const eq of equipments) {
    if (eq.situacao === 'nao_instalado') continue;
    const fails = (eq.historico || []).filter(h => h.tipo === 'falha').map(h => new Date(h.data));
    for (let w = weeksBack; w > skipLast; w--) {
      const t = new Date(now.getTime() - w * 7 * DAY);
      const tEnd = new Date(t.getTime() + 7 * DAY);
      // ignora semanas em que o equipamento já estava em falha no início
      const lastEvt = [...(eq.historico || [])].filter(h => new Date(h.data) < t).pop();
      if (lastEvt && lastEvt.tipo === 'falha') continue;
      X.push(featuresAt(eq, t));
      y.push(fails.some(f => f >= t && f < tEnd) ? 1 : 0);
      wk.push(w);
    }
  }
  return { X, y, wk };
}

function trainLogistic(X, y, { iters = 600, lr = 0.3, l2 = 0.001 } = {}) {
  const d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const x of X) x.forEach((v, j) => mean[j] += v / X.length);
  for (const x of X) x.forEach((v, j) => std[j] += (v - mean[j]) ** 2 / X.length);
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map(x => x.map((v, j) => (v - mean[j]) / std[j]));
  let w = new Array(d).fill(0), b = Math.log((y.reduce((a, c) => a + c, 0) + 1) / (y.length - y.reduce((a, c) => a + c, 0) + 1));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = sigmoid(b + Z[i].reduce((s, v, j) => s + v * w[j], 0));
      const e = p - y[i];
      gb += e; for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
    }
    b -= lr * gb / Z.length;
    w = w.map((wj, j) => wj - lr * (gw[j] / Z.length + l2 * wj));
  }
  return { w, b, mean, std, predict: x => sigmoid(b + x.reduce((s, v, j) => s + ((v - mean[j]) / std[j]) * w[j], 0)) };
}

function auc(scores, labels) {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0, nPos = 0;
  for (let i = 0; i < pairs.length; i++) { rank = i + 1; if (pairs[i][1]) { sumPos += rank; nPos++; } }
  const nNeg = pairs.length - nPos;
  return nPos && nNeg ? (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : null;
}

function fitFailureModel(equipments, now = new Date()) {
  // validação temporal: treina nas semanas 26..7, testa nas semanas 6..1
  const all = buildSamples(equipments, now, 26, 0);
  const trIdx = [], teIdx = [];
  all.wk.forEach((w, i) => (w > 6 ? trIdx : teIdx).push(i));
  const mTr = trainLogistic(trIdx.map(i => all.X[i]), trIdx.map(i => all.y[i]));
  const aucTeste = auc(teIdx.map(i => mTr.predict(all.X[i])), teIdx.map(i => all.y[i]));
  // baseline: só a razão do ciclo de manutenção
  const aucBaseline = auc(teIdx.map(i => all.X[i][0]), teIdx.map(i => all.y[i]));
  const model = trainLogistic(all.X, all.y);
  const coef = FEATURES.map((f, j) => ({ variavel: f, peso: round(model.w[j] / model.std[j], 4), pesoPadronizado: round(model.w[j], 3) }));
  return {
    model, coef,
    metricas: { amostras: all.X.length, taxaBaseSemanal: round(all.y.reduce((a, b) => a + b, 0) / all.y.length, 4), aucTeste: aucTeste && round(aucTeste, 3), aucBaseline: aucBaseline && round(aucBaseline, 3) },
  };
}

function failureRisk(fm, equipments, anomalies = [], now = new Date()) {
  const anomCount = {};
  for (const a of anomalies) if (now - new Date(a.em) < 6 * HOUR) anomCount[a.equipamentoId] = (anomCount[a.equipamentoId] || 0) + 1;
  return equipments
    .filter(e => e.situacao === 'operacional')
    .map(e => {
      const x = featuresAt(e, now);
      let p7 = fm.model.predict(x);
      const an = anomCount[e.id] || 0;
      if (an) { const odds = p7 / (1 - p7) * Math.exp(0.7 * Math.min(an, 3)); p7 = odds / (1 + odds); }
      const p30 = 1 - Math.pow(1 - p7, 30 / 7);
      const motivos = [];
      if (x[0] >= 1) motivos.push(`manutenção vencida (${Math.round(x[0] * 100)}% do ciclo)`);
      else if (x[0] >= 0.8) motivos.push(`ciclo de manutenção em ${Math.round(x[0] * 100)}%`);
      if (x[2] >= 2) motivos.push(`${x[2]} falhas nos últimos 180 dias`);
      if (x[1] >= 4) motivos.push(`${x[1].toFixed(1)} anos de uso`);
      if (an) motivos.push(`${an} anomalia(s) de telemetria nas últimas 6 h`);
      return {
        id: e.id, tipo: e.tipo, bairro: e.localizacao.bairro, regiao: e.regiao, marca: e.marca, modelo: e.modelo,
        prob7d: round(p7, 4), prob30d: round(p30, 4), proximaManutencao: e.manutencao.proximaData,
        nivel: p7 >= 0.35 ? 'critico' : p7 >= 0.2 ? 'alto' : p7 >= 0.1 ? 'moderado' : 'baixo',
        motivos,
      };
    })
    .sort((a, b) => b.prob7d - a.prob7d);
}

/* ------------------------------------------------------------------ */
/* 4. Tendência de disponibilidade (regressão linear)                   */
/* ------------------------------------------------------------------ */
function availabilityTrend(series, meta = 90, days = 30, horizon = 14) {
  const s = series.slice(-days);
  const n = s.length;
  const xs = s.map((_, i) => i), ys = s.map(p => p.disponibilidade);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  const resid = Math.sqrt(ys.reduce((a, y, i) => a + (y - (intercept + slope * i)) ** 2, 0) / Math.max(1, n - 2));
  const last = new Date(s[n - 1].data + 'T12:00:00');
  const projecao = [];
  for (let k = 1; k <= horizon; k++) {
    const v = intercept + slope * (n - 1 + k);
    projecao.push({ data: isoDate(addDays(last, k)), valor: round(v, 2), min: round(v - 1.96 * resid, 2), max: round(v + 1.96 * resid, 2) });
  }
  let cruzaMeta = null;
  if (slope < 0) {
    const cur = intercept + slope * (n - 1);
    if (cur <= meta) cruzaMeta = 'já abaixo da meta';
    else { const k = Math.ceil((cur - meta) / -slope); cruzaMeta = isoDate(addDays(last, k)); }
  }
  return { meta, inclinacaoPorDia: round(slope, 3), r2: round(r2, 3), mediaPeriodo: round(my, 2), projecao, cruzaMeta, historico: s };
}

/* ------------------------------------------------------------------ */
/* 5. Recomendações consolidadas                                        */
/* ------------------------------------------------------------------ */
function recommendations({ fc, reinf, risk, trend }) {
  const recs = [];
  for (const b of fc.filter(x => x.pico.indice >= 90).slice(0, 4)) {
    const h = new Date(b.pico.hora).getHours();
    recs.push({ prioridade: 'alta', categoria: 'Risco de ocorrências', texto: `${b.bairro}: pico de risco previsto às ${String(h).padStart(2, '0')}h (índice ${b.pico.indice}). Posicionar equipe preventivamente 30 min antes.` });
  }
  for (const b of fc.filter(x => x.tendencia.fator >= 1.15 && x.tendencia.significativa)) {
    recs.push({ prioridade: 'media', categoria: 'Tendência', texto: `${b.bairro}: ocorrências ${Math.round((b.tendencia.fator - 1) * 100)}% acima do ritmo dos 2 meses anteriores. Avaliar novas câmeras/radares na região.` });
  }
  for (const b of fc.filter(x => x.aoVivo.monitoramentoForaDoAr >= 25)) {
    recs.push({ prioridade: 'alta', categoria: 'Ponto cego', texto: `${b.bairro}: ${b.aoVivo.monitoramentoForaDoAr}% das câmeras/radares/semáforos fora do ar — risco ampliado nas próximas horas.` });
  }
  const j = reinf[0];
  if (j) for (const r of j.recomendacoes) {
    recs.push({ prioridade: r.de ? 'media' : 'alta', categoria: 'Efetivo', texto: r.de ? `Deslocar ${r.agentes} agente(s) da região ${r.de} para ${r.para} até ${new Date(j.fim).getHours()}h.` : `Região ${r.para}: faltam ${r.agentes} agente(s) até ${new Date(j.fim).getHours()}h — ${r.observacao}.` });
  }
  for (const e of risk.filter(x => x.nivel === 'critico').slice(0, 5)) {
    recs.push({ prioridade: 'alta', categoria: 'Manutenção preventiva', texto: `${e.id} (${EQUIPMENT_TYPES[e.tipo].label}, ${e.bairro}): ${Math.round(e.prob7d * 100)}% de chance de falha em 7 dias — ${e.motivos.join('; ') || 'perfil de risco elevado'}.` });
  }
  if (trend.cruzaMeta) recs.push({ prioridade: 'alta', categoria: 'Disponibilidade', texto: trend.cruzaMeta === 'já abaixo da meta' ? `Disponibilidade abaixo da meta de ${trend.meta}%. Reforçar equipes de manutenção corretiva.` : `Mantida a tendência (${trend.inclinacaoPorDia} p.p./dia), a disponibilidade cairá abaixo de ${trend.meta}% em ${trend.cruzaMeta}.` });
  const order = { alta: 0, media: 1, baixa: 2 };
  return recs.sort((a, b) => order[a.prioridade] - order[b.prioridade]);
}

const EXPLICACOES = {
  risco: {
    oQue: 'Probabilidade de ocorrências (acidentes, congestionamentos, infrações graves, vandalismo...) por bairro, hora a hora, nas próximas 24 horas.',
    dados: 'Histórico de 120 dias de ocorrências (bairro, dia da semana e hora), tendência das últimas 4 semanas, câmeras/radares/semáforos fora do ar e ocorrências abertas agora.',
    como: 'Modelo de Poisson hierárquico: padrão dia×hora da cidade × participação do bairro × desvio horário do bairro, com suavização Bayes empírico e fator de tendência com prior Gama. Validado fora da amostra (últimos 28 dias) contra um baseline ingênuo. O índice 0–100 é o percentil da taxa prevista frente a todas as taxas históricas.',
    ajuda: 'Mostra onde e quando posicionar equipes antes do pico, em vez de reagir depois.',
  },
  reforco: {
    oQue: 'Quantos agentes cada região precisa nas próximas 12 horas (janelas de 4 h) e de onde remanejar.',
    dados: 'Ocorrências esperadas pelo modelo de risco, turnos e situação dos agentes cadastrados.',
    como: `Necessários = maior valor entre a presença mínima (1 agente por bairro de dia, 1 a cada 2 bairros de madrugada) e ocorrências esperadas ÷ ${AGENT_CAPACITY_4H} (atendimentos que um agente absorve em 4 h sem abandonar a patrulha). Excedentes são realocados para regiões com déficit.`,
    ajuda: 'Equilibra o efetivo entre regiões e antecipa quando será preciso convocar reforço.',
  },
  falhas: {
    oQue: 'Chance de cada equipamento operacional falhar nos próximos 7 e 30 dias.',
    dados: 'Histórico de falhas e manutenções de cada equipamento (26 semanas), idade, quanto do ciclo de manutenção já foi consumido e anomalias recentes de telemetria.',
    como: 'Regressão logística treinada aqui mesmo (sem bibliotecas) com validação temporal: treina nas semanas mais antigas e mede AUC nas 6 semanas mais recentes. Anomalias ao vivo ajustam a chance para cima.',
    ajuda: 'Permite trocar manutenção corretiva (cara, com equipamento parado) por preventiva, priorizando a fila da equipe técnica.',
  },
  disponibilidade: {
    oQue: 'Projeção da disponibilidade do parque de equipamentos para os próximos 14 dias.',
    dados: 'Série diária de disponibilidade (equipamentos operacionais ÷ instalados).',
    como: 'Regressão linear dos últimos 30 dias com intervalo de 95% baseado no erro residual.',
    ajuda: 'Avisa com antecedência quando a meta de disponibilidade será violada.',
  },
  anomalias: {
    oQue: 'Leituras de telemetria fora do padrão esperado para cada dispositivo.',
    dados: 'Fluxo de veículos dos radares, FPS/latência das câmeras, bateria de patinetes, pesagens, heartbeat.',
    como: 'Média e variância móveis exponenciais (EWMA) por dispositivo e métrica; alerta quando o z-score passa de 3,5 após período de aquecimento.',
    ajuda: 'Detecta sensor travado, câmera degradada ou adulteração antes que o equipamento pare de vez.',
  },
};

module.exports = { fitIncidentModel, forecast, backtest, heatmap, reinforcement, fitFailureModel, failureRisk, availabilityTrend, recommendations, liveFactors, EXPLICACOES, shiftCovers, WD };
