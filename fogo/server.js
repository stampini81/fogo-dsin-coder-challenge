'use strict';
// F.O.G.O. — Ferramenta Onisciente de Gestão e Operações
// Servidor HTTP sem dependências externas: `node server.js` e pronto.
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Store } = require('./src/store');
const { buildSeed } = require('./src/seed');
const { Simulator, TICK_MS, SPEED } = require('./src/simulator');
const { validateEquipment, validateAgent } = require('./src/validation');
const { dashboard, filterEquipments, filterAgents } = require('./src/analytics');
const P = require('./src/predict');
const C = require('./src/catalog');
const { BAIRROS, REGIONS, CITY, bairroByName } = require('./src/geo');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.FOGO_DATA || path.join(__dirname, 'data', 'fogo-db.json');
const PUBLIC = path.join(__dirname, 'public');

/* ------------------------------ estado ------------------------------ */
const store = new Store(DATA_FILE);
if (!store.load()) {
  console.log('[fogo] Gerando cidade inicial (inventário, agentes e 120 dias de histórico)...');
  store.replaceAll(buildSeed());
}
const sim = new Simulator(store);

const models = { incident: null, failure: null, incidentAt: 0, failureAt: 0, incidentN: 0 };
function incidentModel() {
  const n = store.data.incidents.length;
  if (!models.incident || Date.now() - models.incidentAt > 10 * 60000 || n - models.incidentN > 25) {
    models.incident = P.fitIncidentModel(store.data.incidents);
    models.incidentAt = Date.now(); models.incidentN = n;
    models.backtest = P.backtest(store.data.incidents);
  }
  return models.incident;
}
function failureModel() {
  if (!models.failure || Date.now() - models.failureAt > 30 * 60000) {
    models.failure = P.fitFailureModel(store.data.equipments);
    models.failureAt = Date.now();
  }
  return models.failure;
}

/* ------------------------------ SSE ------------------------------ */
const clients = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
sim.on('tick', p => broadcast('tick', p));
sim.on('alert', a => broadcast('alert', a));
sim.on('incident', i => broadcast('incident', i));
sim.on('anomaly', a => broadcast('anomaly', a));
setInterval(() => { if (clients.size) broadcast('kpi', dashboard(store.data, {}, P.forecast(incidentModel(), store.data)).kpis); }, 5000).unref();
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

/* ------------------------------ helpers ------------------------------ */
const clean = o => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : v)));
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(clean(body));
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const notFound = res => send(res, 404, { erro: 'Não encontrado' });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(Object.assign(new Error('Payload muito grande'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return pathname.startsWith('/api') ? notFound(res) : fs.readFile(path.join(PUBLIC, 'index.html'), (e2, b2) => e2 ? notFound(res) : (res.writeHead(200, { 'Content-Type': MIME['.html'] }), res.end(b2)));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function equipmentDetail(e) {
  const fm = failureModel();
  const risk = e.situacao === 'operacional' ? P.failureRisk(fm, [e], sim.anomalies)[0] : null;
  const t = sim.telemetry.get(e.id);
  const agentes = store.data.agents.filter(a => a.equipamentoId === e.id).map(a => ({ id: a.id, nome: a.nome, situacao: a.situacao }));
  return { ...e, telemetria: t || null, riscoFalha: risk, anomalias: sim.anomalies.filter(a => a.equipamentoId === e.id).slice(0, 10), agentesVinculados: agentes };
}

function toCSV(rows) {
  const cols = ['id', 'tipo', 'numeroSerie', 'marca', 'modelo', 'situacao', 'orgao', 'regiao', 'bairro', 'rua', 'referencia', 'cep', 'lat', 'lng', 'manutencaoTipo', 'proximaManutencao'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(';'), ...rows.map(e => [e.id, e.tipo, e.numeroSerie, e.marca, e.modelo, e.situacao, e.orgao, e.regiao, e.localizacao.bairro, e.localizacao.rua, e.localizacao.referencia, e.localizacao.cep, e.localizacao.lat, e.localizacao.lng, e.manutencao.tipo, e.manutencao.proximaData].map(esc).join(';'))].join('\n');
}

/* ------------------------------ rotas ------------------------------ */
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', () => ({ ok: true, uptime: process.uptime(), clientesTempoReal: clients.size, tickMs: TICK_MS, velocidadeSimulacao: SPEED }));

route('GET', '/api/meta', () => ({
  cidade: CITY, regioes: REGIONS, bairros: BAIRROS.map(({ nome, regiao, lat, lng, cep }) => ({ nome, regiao, lat, lng, cep })),
  tiposEquipamento: C.EQUIPMENT_TYPES, situacoes: C.EQUIPMENT_STATUS, manutencao: C.MAINTENANCE_TYPES, orgaos: C.ORGAOS,
  tiposAgente: C.AGENT_TYPES, situacoesAgente: C.AGENT_STATUS, tiposOcorrencia: C.INCIDENT_TYPES, severidades: Object.keys(C.SEVERITY),
}));

// ---- equipamentos
route('GET', '/api/equipments', ({ query }) => filterEquipments(store.data.equipments, query).map(e => ({ ...e, historico: undefined, telemetria: (sim.telemetry.get(e.id) || {}).metricas || null })));
route('GET', '/api/equipments.csv', ({ query, res }) => { send(res, 200, toCSV(filterEquipments(store.data.equipments, query)), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="equipamentos-fogo.csv"' }); });
route('GET', '/api/equipments/:id', ({ params }) => { const e = store.get('equipments', params.id); return e ? equipmentDetail(e) : null; });
route('POST', '/api/equipments', async ({ body }) => {
  const { errors, value } = validateEquipment(body);
  if (errors.length) return { status: 422, body: { erro: 'Dados inválidos', detalhes: errors } };
  if (store.data.equipments.some(e => e.numeroSerie === value.numeroSerie)) return { status: 409, body: { erro: 'Número de série já cadastrado', detalhes: [{ campo: 'numeroSerie', erro: 'Duplicado' }] } };
  const seq = Math.max(...store.data.equipments.map(e => Number(e.id.slice(3)) || 0), 999) + 1;
  const item = store.insert('equipments', { id: `EQ-${String(seq).padStart(5, '0')}`, ...value, historico: [{ data: new Date().toISOString(), tipo: 'cadastro', descricao: 'Equipamento cadastrado' }] });
  sim.emit('tick', { em: new Date().toISOString(), equipments: [], agents: [], reload: true });
  return { status: 201, body: item };
});
route('PUT', '/api/equipments/:id', ({ params, body }) => {
  const cur = store.get('equipments', params.id);
  if (!cur) return null;
  const { errors, value } = validateEquipment(body);
  if (errors.length) return { status: 422, body: { erro: 'Dados inválidos', detalhes: errors } };
  if (store.data.equipments.some(e => e.numeroSerie === value.numeroSerie && e.id !== cur.id)) return { status: 409, body: { erro: 'Número de série já cadastrado', detalhes: [{ campo: 'numeroSerie', erro: 'Duplicado' }] } };
  if (cur.situacao !== value.situacao) cur.historico.push({ data: new Date().toISOString(), tipo: value.situacao === 'mau_funcionamento' ? 'falha' : 'status', descricao: `Situação alterada: ${cur.situacao} → ${value.situacao}` });
  return store.update('equipments', cur.id, value);
});
route('DELETE', '/api/equipments/:id', ({ params }) => {
  if (!store.remove('equipments', params.id)) return null;
  for (const a of store.data.agents) if (a.equipamentoId === params.id) a.equipamentoId = null;
  return { status: 204, body: '' };
});

// ---- agentes
route('GET', '/api/agents', ({ query }) => filterAgents(store.data.agents, query));
route('GET', '/api/agents/:id', ({ params }) => store.get('agents', params.id));
route('POST', '/api/agents', ({ body }) => {
  const { errors, value } = validateAgent(body);
  if (errors.length) return { status: 422, body: { erro: 'Dados inválidos', detalhes: errors } };
  if (store.data.agents.some(a => a.matricula === value.matricula)) return { status: 409, body: { erro: 'Matrícula já cadastrada', detalhes: [{ campo: 'matricula', erro: 'Duplicada' }] } };
  return { status: 201, body: store.insert('agents', { id: `AG-${value.matricula}`, ...value, _manual: true }) };
});
route('PUT', '/api/agents/:id', ({ params, body }) => {
  const cur = store.get('agents', params.id);
  if (!cur) return null;
  const { errors, value } = validateAgent(body);
  if (errors.length) return { status: 422, body: { erro: 'Dados inválidos', detalhes: errors } };
  if (store.data.agents.some(a => a.matricula === value.matricula && a.id !== cur.id)) return { status: 409, body: { erro: 'Matrícula já cadastrada', detalhes: [{ campo: 'matricula', erro: 'Duplicada' }] } };
  return store.update('agents', cur.id, value);
});
route('DELETE', '/api/agents/:id', ({ params }) => store.remove('agents', params.id) ? { status: 204, body: '' } : null);

// ---- operação
route('GET', '/api/dashboard', ({ query }) => dashboard(store.data, query, P.forecast(incidentModel(), store.data)));
route('GET', '/api/incidents/live', () => store.data.liveIncidents);
route('GET', '/api/incidents/history', ({ query }) => {
  const days = Math.min(120, Number(query.dias) || 30);
  const from = Date.now() - days * 86400000;
  return store.data.incidents.filter(i => new Date(i.inicio) >= from).map(({ lat, lng, tipo, severidade, bairro, inicio }) => ({ lat, lng, tipo, severidade, bairro, inicio }));
});
route('POST', '/api/incidents', ({ body }) => {
  const b = bairroByName(body.bairro);
  if (!b || !C.INCIDENT_TYPES[body.tipo] || !C.SEVERITY[body.severidade]) return { status: 422, body: { erro: 'Informe bairro, tipo e severidade válidos' } };
  return { status: 201, body: sim.openIncident(b, new Date(), { tipo: body.tipo, severidade: body.severidade, origem: 'manual', lat: body.lat != null ? Number(body.lat) : undefined, lng: body.lng != null ? Number(body.lng) : undefined }) };
});
route('GET', '/api/alerts', ({ query }) => store.data.alerts.filter(a => query.todos ? true : !a.reconhecido).slice(0, 200));
route('POST', '/api/alerts/:id/ack', ({ params }) => {
  const a = store.data.alerts.find(x => x.id === params.id);
  if (!a) return null;
  a.reconhecido = true; a.reconhecidoEm = new Date().toISOString(); store.save();
  broadcast('alert-ack', { id: a.id });
  return a;
});
route('GET', '/api/anomalies', () => sim.anomalies.slice(0, 100));

// ---- cenários de demonstração
route('POST', '/api/simulate/:cenario', ({ params }) => {
  const now = new Date();
  const centro = bairroByName('Centro');
  switch (params.cenario) {
    case 'acidente-grave': {
      const b = BAIRROS[Math.floor(Math.random() * BAIRROS.length)];
      return sim.openIncident(b, now, { tipo: 'acidente', severidade: 'critica', origem: 'cenario' });
    }
    case 'apagao': {
      const sems = store.data.equipments.filter(e => e.localizacao.bairro === 'Centro' && ['semaforo', 'camera'].includes(e.tipo) && e.situacao === 'operacional').slice(0, 6);
      for (const e of sems) sim.setStatus(e, 'mau_funcionamento', now, 'Queda de energia na rede (apagão)');
      sim.openIncident(centro, now, { tipo: 'semaforo_apagado', severidade: 'alta', origem: 'cenario' });
      return { afetados: sems.map(e => e.id) };
    }
    case 'furto': {
      const e = store.data.equipments.find(x => ['camera', 'patinete'].includes(x.tipo) && x.situacao === 'operacional');
      if (e) sim.setStatus(e, 'furtado', now, 'Equipamento sem sinal e fora da posição — possível furto');
      return { afetado: e && e.id };
    }
    case 'sensor-travado': {
      const e = store.data.equipments.find(x => x.tipo === 'radar' && x.situacao === 'operacional' && sim.stats.has(`${x.id}|fluxoVeiculosMin`));
      if (!e) return { status: 409, body: { erro: 'Aguarde alguns segundos de telemetria para calibrar a detecção' } };
      const t = sim.telemetry.get(e.id); t.metricas.fluxoVeiculosMin = 0;
      sim.checkAnomaly(e, t.metricas, now, require('./src/util').HOUR_PROFILE[now.getHours()], true);
      return { afetado: e.id };
    }
    default: return null;
  }
});

// ---- previsões
route('GET', '/api/predictions', () => {
  const m = incidentModel();
  const fm = failureModel();
  const fc = P.forecast(m, store.data);
  const reinf = P.reinforcement(fc, store.data.agents);
  const risk = P.failureRisk(fm, store.data.equipments, sim.anomalies);
  // a série de disponibilidade recebe o valor de "agora"
  const installed = store.data.equipments.filter(e => e.situacao !== 'nao_instalado');
  const series = [...store.data.disponibilidade];
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayPoint = { data: todayStr, total: installed.length, disponiveis: installed.filter(e => e.situacao === 'operacional').length };
  todayPoint.disponibilidade = +(100 * todayPoint.disponiveis / todayPoint.total).toFixed(2);
  if (series.length && series[series.length - 1].data === todayStr) series[series.length - 1] = todayPoint; else series.push(todayPoint);
  const trend = P.availabilityTrend(series);
  return {
    geradoEm: new Date().toISOString(),
    risco: { bairros: fc, validacao: models.backtest, semanasDeHistorico: m.weeks, ocorrenciasNoHistorico: m.n },
    reforco: reinf,
    falhas: { metricas: fm.metricas, coeficientes: fm.coef, equipamentos: risk.slice(0, 40), distribuicao: ['critico', 'alto', 'moderado', 'baixo'].map(n => ({ nivel: n, qtd: risk.filter(r => r.nivel === n).length })) },
    disponibilidade: trend,
    anomalias: sim.anomalies.slice(0, 30),
    recomendacoes: P.recommendations({ fc, reinf, risk, trend }),
    explicacoes: P.EXPLICACOES,
  };
});
route('GET', '/api/predictions/heatmap', ({ query }) => P.heatmap(incidentModel(), query.bairro || null));

route('POST', '/api/admin/reset', () => {
  store.replaceAll(buildSeed());
  models.incident = null; models.failure = null;
  sim.telemetry.clear(); sim.stats.clear(); sim.anomalies.length = 0;
  broadcast('reset', {});
  return { ok: true };
});

/* ------------------------------ servidor ------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ em: new Date().toISOString() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  const r = routes.find(x => x.method === req.method && x.re.test(pathname));
  if (!r) return notFound(res);
  try {
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
    const out = await r.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body });
    if (res.writableEnded) return;
    if (out == null) return notFound(res);
    if (out && typeof out === 'object' && 'status' in out && 'body' in out) {
      if (out.status === 204) { res.writeHead(204); return res.end(); }
      return send(res, out.status, out.body);
    }
    send(res, 200, out);
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    incidentModel(); failureModel();
    sim.start();
    // algumas ocorrências iniciais para a central não começar vazia
    for (const nome of ['Centro', 'Ana Jacinta', 'Vila Industrial']) sim.openIncident(bairroByName(nome), new Date());
    console.log(`\n  🔥 F.O.G.O. no ar: http://localhost:${PORT}\n     Simulação: tick ${TICK_MS} ms, velocidade x${SPEED}. Dados em ${path.relative(process.cwd(), DATA_FILE)}\n`);
  });
  const shutdown = () => { sim.stop(); store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

module.exports = { server, store, sim };
