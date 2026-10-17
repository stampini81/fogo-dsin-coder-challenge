'use strict';
const { EQUIPMENT_TYPES, EQUIPMENT_STATUS, MAINTENANCE_TYPES, AGENT_TYPES, AGENT_STATUS, ORGAOS } = require('./catalog');
const { BAIRROS, REGIONS } = require('./geo');

const isDate = s => s == null || s === '' || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s)));

function validateEquipment(body) {
  const errors = [];
  const out = {};
  const def = EQUIPMENT_TYPES[body.tipo];
  if (!def) errors.push({ campo: 'tipo', erro: 'Tipo de equipamento inválido' });
  for (const k of ['numeroSerie', 'marca', 'modelo']) {
    if (!body[k] || !String(body[k]).trim()) errors.push({ campo: k, erro: 'Obrigatório' });
    else out[k] = String(body[k]).trim().slice(0, 80);
  }
  out.tipo = body.tipo;
  out.orgao = ORGAOS.includes(body.orgao) ? body.orgao : (def ? def.orgao : ORGAOS[0]);

  const loc = body.localizacao || {};
  const L = {};
  if (!/^\d{5}-?\d{3}$/.test(loc.cep || '')) errors.push({ campo: 'localizacao.cep', erro: 'CEP deve ter o formato 00000-000' });
  else L.cep = loc.cep.replace(/^(\d{5})-?(\d{3})$/, '$1-$2');
  for (const k of ['bairro', 'cidade', 'uf', 'rua', 'referencia']) {
    if (!loc[k] || !String(loc[k]).trim()) errors.push({ campo: `localizacao.${k}`, erro: 'Obrigatório' });
    else L[k] = String(loc[k]).trim().slice(0, 120);
  }
  if (L.uf && !/^[A-Za-z]{2}$/.test(L.uf)) errors.push({ campo: 'localizacao.uf', erro: 'UF deve ter 2 letras' });
  else if (L.uf) L.uf = L.uf.toUpperCase();
  const lat = Number(loc.lat), lng = Number(loc.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push({ campo: 'localizacao.lat', erro: 'Latitude inválida' });
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.push({ campo: 'localizacao.lng', erro: 'Longitude inválida' });
  L.lat = lat; L.lng = lng;
  out.localizacao = L;

  const b = BAIRROS.find(x => x.nome === L.bairro);
  out.regiao = REGIONS.includes(body.regiao) ? body.regiao : (b ? b.regiao : 'Centro');

  if (!EQUIPMENT_STATUS[body.situacao]) errors.push({ campo: 'situacao', erro: 'Situação inválida' });
  out.situacao = body.situacao;

  const m = body.manutencao || {};
  if (!MAINTENANCE_TYPES[m.tipo]) errors.push({ campo: 'manutencao.tipo', erro: 'Tipo de manutenção inválido' });
  if (!isDate(m.proximaData)) errors.push({ campo: 'manutencao.proximaData', erro: 'Data inválida (AAAA-MM-DD)' });
  if (!isDate(m.ultimaData)) errors.push({ campo: 'manutencao.ultimaData', erro: 'Data inválida (AAAA-MM-DD)' });
  if (['agendada', 'periodica'].includes(m.tipo) && !m.proximaData) errors.push({ campo: 'manutencao.proximaData', erro: 'Informe a data da próxima manutenção' });
  out.manutencao = {
    tipo: m.tipo,
    proximaData: m.proximaData || null,
    ultimaData: m.ultimaData || null,
    periodicidadeDias: Number(m.periodicidadeDias) || (def ? def.periodicidadeDias : 90),
  };
  if (body.situacao === 'mau_funcionamento' && m.tipo === 'nenhuma') errors.push({ campo: 'manutencao.tipo', erro: 'Equipamento com mau funcionamento exige manutenção imediata' });

  const c = body.caracteristicas || {};
  const C = {};
  if (def) {
    for (const f of def.fields) {
      if (f.showIf && Object.entries(f.showIf).some(([k, v]) => c[k] !== v)) continue;
      let v = c[f.key];
      if (v === undefined || v === '' || v === null) {
        if (f.required) errors.push({ campo: `caracteristicas.${f.key}`, erro: 'Obrigatório' });
        if (f.type === 'boolean') C[f.key] = false;
        continue;
      }
      if (f.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max)) { errors.push({ campo: `caracteristicas.${f.key}`, erro: `Número entre ${f.min} e ${f.max}` }); continue; }
      } else if (f.type === 'boolean') v = v === true || v === 'true' || v === 'on';
      else if (f.type === 'select') { if (!f.options.includes(v)) { errors.push({ campo: `caracteristicas.${f.key}`, erro: 'Opção inválida' }); continue; } }
      else {
        v = String(v).trim().toUpperCase().slice(0, 60);
        if (f.pattern && !new RegExp(f.pattern).test(v)) { errors.push({ campo: `caracteristicas.${f.key}`, erro: 'Formato inválido' }); continue; }
      }
      C[f.key] = v;
    }
  }
  out.caracteristicas = C;
  out.dataInstalacao = isDate(body.dataInstalacao) ? (body.dataInstalacao || null) : null;
  return { errors, value: out };
}

function validateAgent(body) {
  const errors = [];
  const out = {};
  if (!body.nome || String(body.nome).trim().length < 3) errors.push({ campo: 'nome', erro: 'Nome obrigatório' });
  else out.nome = String(body.nome).trim().slice(0, 80);
  if (!/^\d{3,10}$/.test(String(body.matricula || ''))) errors.push({ campo: 'matricula', erro: 'Matrícula numérica (3 a 10 dígitos)' });
  else out.matricula = String(body.matricula);
  if (!AGENT_TYPES[body.tipo]) errors.push({ campo: 'tipo', erro: 'Tipo inválido' });
  out.tipo = body.tipo;
  out.orgao = ORGAOS.includes(body.orgao) ? body.orgao : (AGENT_TYPES[body.tipo] || {}).orgao;
  if (!AGENT_STATUS[body.situacao]) errors.push({ campo: 'situacao', erro: 'Situação inválida' });
  out.situacao = body.situacao;
  if (!['manha', 'tarde', 'noite'].includes(body.turno)) errors.push({ campo: 'turno', erro: 'Turno inválido' });
  out.turno = body.turno;
  const b = BAIRROS.find(x => x.nome === body.bairroBase);
  if (!b) errors.push({ campo: 'bairroBase', erro: 'Bairro inválido' });
  else { out.bairroBase = b.nome; out.regiao = b.regiao; }
  out.equipamentoId = body.equipamentoId || null;
  const p = body.posicao || {};
  const lat = Number(p.lat), lng = Number(p.lng);
  out.posicao = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, atualizadoEm: new Date().toISOString() } : (b ? { lat: b.lat, lng: b.lng, atualizadoEm: new Date().toISOString() } : null);
  return { errors, value: out };
}

module.exports = { validateEquipment, validateAgent };
