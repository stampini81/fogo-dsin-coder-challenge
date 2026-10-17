'use strict';
const { BAIRROS, REGIONS } = require('./geo');
const { EQUIPMENT_STATUS, AGENT_STATUS, SEVERITY, ALERT_LEVELS } = require('./catalog');
const { DAY, round } = require('./util');

const list = v => (v == null || v === '' ? null : String(v).split(',').filter(Boolean));

function filterEquipments(eqs, q = {}) {
  const tipos = list(q.tipo), sits = list(q.situacao), bairros = list(q.bairro), regs = list(q.regiao), orgs = list(q.orgao);
  const text = (q.q || '').toLowerCase().trim();
  const today = new Date().toISOString().slice(0, 10);
  return eqs.filter(e =>
    (!tipos || tipos.includes(e.tipo)) &&
    (!sits || sits.includes(e.situacao)) &&
    (!bairros || bairros.includes(e.localizacao.bairro)) &&
    (!regs || regs.includes(e.regiao)) &&
    (!orgs || orgs.includes(e.orgao)) &&
    (!q.manutencao || (q.manutencao === 'imediata' ? needsImmediate(e) : q.manutencao === 'proxima' ? maintenanceSoon(e, today) : true)) &&
    (!text || [e.id, e.numeroSerie, e.marca, e.modelo, e.localizacao.rua, e.localizacao.bairro, e.caracteristicas.placa].filter(Boolean).join(' ').toLowerCase().includes(text)));
}

function filterAgents(agents, q = {}) {
  const regs = list(q.regiao), bairros = list(q.bairro), orgs = list(q.orgao), tipos = list(q.agenteTipo), sits = list(q.agenteSituacao);
  const text = (q.q || '').toLowerCase().trim();
  return agents.filter(a =>
    (!regs || regs.includes(a.regiao)) && (!bairros || bairros.includes(a.bairroBase)) && (!orgs || orgs.includes(a.orgao)) &&
    (!tipos || tipos.includes(a.tipo)) && (!sits || sits.includes(a.situacao)) &&
    (!text || [a.nome, a.matricula, a.id].join(' ').toLowerCase().includes(text)));
}

const needsImmediate = e => e.situacao === 'mau_funcionamento' || e.manutencao.tipo === 'imediata';
const maintenanceSoon = (e, today, days = 7) => {
  if (!e.manutencao.proximaData || ['nao_instalado', 'desativado', 'furtado'].includes(e.situacao) || needsImmediate(e)) return false;
  const d = (new Date(e.manutencao.proximaData) - new Date(today)) / DAY;
  return d <= days;
};

function dashboard(data, q = {}, forecast = null) {
  const eqs = filterEquipments(data.equipments, q);
  const agents = filterAgents(data.agents, q);
  const installed = eqs.filter(e => e.situacao !== 'nao_instalado');
  const op = installed.filter(e => e.situacao === 'operacional').length;
  const today = new Date().toISOString().slice(0, 10);
  const live = (data.liveIncidents || []).filter(i => i.status !== 'encerrada' && (!list(q.bairro) || list(q.bairro).includes(i.bairro)) && (!list(q.regiao) || list(q.regiao).includes(i.regiao)));
  const openAlerts = data.alerts.filter(a => !a.reconhecido);
  const porSituacao = Object.fromEntries(Object.keys(EQUIPMENT_STATUS).map(k => [k, eqs.filter(e => e.situacao === k).length]));
  const porTipo = {};
  for (const e of eqs) {
    porTipo[e.tipo] = porTipo[e.tipo] || { total: 0, operacionais: 0 };
    porTipo[e.tipo].total++; if (e.situacao === 'operacional') porTipo[e.tipo].operacionais++;
  }
  const porAgente = Object.fromEntries(Object.keys(AGENT_STATUS).map(k => [k, agents.filter(a => a.situacao === k).length]));

  const fcBy = forecast ? Object.fromEntries(forecast.map(f => [f.bairro, f])) : {};
  const bairros = BAIRROS.map(b => {
    const be = data.equipments.filter(e => e.localizacao.bairro === b.nome && e.situacao !== 'nao_instalado');
    const bop = be.filter(e => e.situacao === 'operacional').length;
    const disp = be.length ? bop / be.length : 1;
    const inc = (data.liveIncidents || []).filter(i => i.bairro === b.nome && i.status !== 'encerrada');
    const sevLoad = inc.reduce((s, i) => s + SEVERITY[i.severidade], 0);
    const crit = openAlerts.filter(a => a.bairro === b.nome && ALERT_LEVELS[a.nivel] >= 3).length;
    const agentsHere = data.agents.filter(a => a.bairroBase === b.nome && AGENT_STATUS[a.situacao].ativo).length;
    const risk = fcBy[b.nome] ? fcBy[b.nome].indiceAtual : null;
    // pontuação de saúde operacional (0-100)
    let score = 100;
    score -= (1 - disp) * 120;               // equipamentos fora do ar
    score -= sevLoad * 4;                    // carga de ocorrências abertas
    score -= crit * 8;                       // alertas graves não reconhecidos
    if (agentsHere === 0) score -= 10;       // sem efetivo de base ativo
    if (risk != null && risk >= 90) score -= 8;
    score = Math.max(0, Math.round(score));
    return {
      bairro: b.nome, regiao: b.regiao, lat: b.lat, lng: b.lng,
      equipamentos: be.length, disponibilidade: round(disp * 100, 1), ocorrenciasAbertas: inc.length,
      alertasGraves: crit, agentesAtivos: agentsHere, indiceRisco: risk, saude: score,
      status: score >= 75 ? 'normal' : score >= 50 ? 'atencao' : 'critico',
    };
  });
  const regioes = REGIONS.map(reg => {
    const bs = bairros.filter(b => b.regiao === reg);
    const s = Math.round(bs.reduce((a, b) => a + b.saude, 0) / bs.length);
    return { regiao: reg, saude: s, status: bs.some(b => b.status === 'critico') ? 'critico' : s >= 75 ? 'normal' : 'atencao', bairros: bs.map(b => b.bairro), ocorrenciasAbertas: bs.reduce((a, b) => a + b.ocorrenciasAbertas, 0) };
  });

  return {
    em: new Date().toISOString(),
    kpis: {
      totalEquipamentos: eqs.length,
      instalados: installed.length,
      operacionais: op,
      indisponiveis: installed.length - op,
      disponibilidade: installed.length ? round(100 * op / installed.length, 1) : 0,
      naoInstalados: eqs.length - installed.length,
      manutencaoImediata: eqs.filter(needsImmediate).length,
      manutencaoProxima7d: eqs.filter(e => maintenanceSoon(e, today)).length,
      agentesTotal: agents.length,
      agentesEmAtividade: agents.filter(a => AGENT_STATUS[a.situacao].ativo).length,
      agentesEmOcorrencia: agents.filter(a => a.situacao === 'em_ocorrencia').length,
      ocorrenciasAbertas: live.length,
      alertasAbertos: openAlerts.length,
      alertasCriticos: openAlerts.filter(a => a.nivel === 'critico').length,
    },
    porSituacao, porTipo, porAgente, bairros, regioes,
    manutencao: {
      imediata: eqs.filter(needsImmediate).map(e => ({ id: e.id, tipo: e.tipo, bairro: e.localizacao.bairro, situacao: e.situacao })).slice(0, 50),
      proxima: eqs.filter(e => maintenanceSoon(e, today)).map(e => ({ id: e.id, tipo: e.tipo, bairro: e.localizacao.bairro, data: e.manutencao.proximaData })).sort((a, b) => a.data.localeCompare(b.data)).slice(0, 50),
    },
  };
}

module.exports = { dashboard, filterEquipments, filterAgents, needsImmediate, maintenanceSoon };
