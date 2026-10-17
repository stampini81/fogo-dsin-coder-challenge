'use strict';
process.env.TZ = 'America/Sao_Paulo';
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.FOGO_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fogo-')), 'db.json');

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeed } = require('../src/seed');
const { validateEquipment, validateAgent } = require('../src/validation');
const P = require('../src/predict');
const { dashboard } = require('../src/analytics');

const seed = buildSeed(7);

test('seed gera cidade coerente', () => {
  assert.ok(seed.equipments.length > 200);
  assert.ok(seed.agents.length > 50);
  assert.ok(seed.incidents.length > 800);
  assert.equal(seed.disponibilidade.length, 60);
  assert.equal(new Set(seed.equipments.map(e => e.numeroSerie)).size, seed.equipments.length, 'números de série únicos');
});

test('validação de equipamento rejeita dados inválidos e aceita válidos', () => {
  const bad = validateEquipment({ tipo: 'radar', localizacao: { cep: '123' } });
  assert.ok(bad.errors.some(e => e.campo === 'numeroSerie'));
  assert.ok(bad.errors.some(e => e.campo === 'localizacao.cep'));
  const ok = validateEquipment({
    tipo: 'radar', numeroSerie: 'ABC-1', marca: 'Perkons', modelo: 'X', situacao: 'operacional',
    localizacao: { cep: '19010000', bairro: 'Centro', cidade: 'Presidente Prudente', uf: 'sp', rua: 'Av. Brasil', referencia: 'KM 203', lat: -22.1, lng: -51.4 },
    manutencao: { tipo: 'periodica', proximaData: '2027-01-01' },
    caracteristicas: { subtipo: 'velocidade', velocidadeMaxima: '60', faixas: 2 },
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.localizacao.cep, '19010-000');
  assert.equal(ok.value.localizacao.uf, 'SP');
  assert.equal(ok.value.caracteristicas.velocidadeMaxima, 60);
  assert.equal(ok.value.regiao, 'Centro');
});

test('campo condicional só é exigido quando aplicável', () => {
  const r = validateEquipment({ tipo: 'radar', caracteristicas: { subtipo: 'semaforo', velocidadeMaxima: 9999 } });
  assert.ok(!r.errors.some(e => e.campo === 'caracteristicas.velocidadeMaxima'));
});

test('mau funcionamento exige manutenção', () => {
  const r = validateEquipment({ tipo: 'camera', situacao: 'mau_funcionamento', manutencao: { tipo: 'nenhuma' } });
  assert.ok(r.errors.some(e => e.campo === 'manutencao.tipo'));
});

test('validação de agente', () => {
  assert.ok(validateAgent({ nome: 'A' }).errors.length > 3);
  const ok = validateAgent({ nome: 'Ana Souza', matricula: '1234', tipo: 'guarda_municipal', situacao: 'em_patrulha', turno: 'noite', bairroBase: 'Vila Nova' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.regiao, 'Oeste');
});

test('modelo de risco supera o baseline fora da amostra', () => {
  const bt = P.backtest(seed.incidents);
  assert.ok(bt.devianceModelo < bt.devianceBaseline, JSON.stringify(bt));
});

test('previsão de 24 h tem um registro por hora e probabilidades válidas', () => {
  const m = P.fitIncidentModel(seed.incidents);
  const fc = P.forecast(m, seed);
  assert.equal(fc.length, 12);
  for (const b of fc) {
    assert.equal(b.horas.length, 24);
    for (const h of b.horas) assert.ok(h.probabilidade >= 0 && h.probabilidade < 1 && h.indice >= 0 && h.indice <= 100);
  }
});

test('modelo de falhas discrimina melhor que o acaso', () => {
  const fm = P.fitFailureModel(seed.equipments);
  assert.ok(fm.metricas.aucTeste > 0.65, `AUC ${fm.metricas.aucTeste}`);
  const risk = P.failureRisk(fm, seed.equipments);
  assert.ok(risk.every(r => r.prob7d >= 0 && r.prob7d <= 1 && r.prob30d >= r.prob7d));
});

test('regressão linear de disponibilidade recupera inclinação conhecida', () => {
  const series = Array.from({ length: 30 }, (_, i) => ({ data: `2026-01-${String(i + 1).padStart(2, '0')}`, disponibilidade: 95 - 0.2 * i }));
  const t = P.availabilityTrend(series);
  assert.ok(Math.abs(t.inclinacaoPorDia + 0.2) < 1e-6);
  assert.equal(t.projecao.length, 14);
  assert.ok(t.cruzaMeta);
});

test('dashboard calcula KPIs e respeita filtros', () => {
  const all = dashboard(seed, {});
  const radar = dashboard(seed, { tipo: 'radar' });
  assert.equal(all.kpis.totalEquipamentos, seed.equipments.length);
  assert.ok(radar.kpis.totalEquipamentos < all.kpis.totalEquipamentos);
  assert.equal(all.bairros.length, 12);
});

test('API: CRUD de equipamento ponta a ponta', async () => {
  const { server } = require('../server');
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await fetch(`${base}/api/equipments`, { method: 'POST', body: '{}' });
    assert.equal(bad.status, 422);
    const body = {
      tipo: 'camera', numeroSerie: 'TST-999', marca: 'Intelbras', modelo: 'VIP', situacao: 'nao_instalado', orgao: 'Guarda Municipal',
      localizacao: { cep: '19010-100', bairro: 'Centro', cidade: 'Presidente Prudente', uf: 'SP', rua: 'Rua X', referencia: 'S/N', lat: -22.12, lng: -51.39 },
      manutencao: { tipo: 'agendada', proximaData: '2027-02-01' }, caracteristicas: { resolucao: '4K', visaoNoturna: true },
    };
    const created = await fetch(`${base}/api/equipments`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const eq = await created.json();
    const dup = await fetch(`${base}/api/equipments`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(dup.status, 409);
    const put = await fetch(`${base}/api/equipments/${eq.id}`, { method: 'PUT', body: JSON.stringify({ ...body, situacao: 'operacional' }) });
    assert.equal((await put.json()).situacao, 'operacional');
    const pred = await (await fetch(`${base}/api/predictions`)).json();
    assert.ok(pred.recomendacoes.length > 0);
    const del = await fetch(`${base}/api/equipments/${eq.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
  } finally {
    server.close();
  }
});
