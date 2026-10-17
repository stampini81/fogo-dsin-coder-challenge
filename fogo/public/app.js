/* F.O.G.O. — front-end (JavaScript puro, sem build) */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDate = s => s ? s.split('-').reverse().join('/') : '—';
const pct = v => `${Math.round(v * 100)}%`;
const LEVEL_COLOR = { critico: '#ff2d55', alto: '#e5484d', medio: '#f5a524', moderado: '#f5a524', info: '#3b82f6', baixo: '#22a06b' };
const SEV_COLOR = { baixa: '#3b82f6', media: '#f5a524', alta: '#e5484d', critica: '#ff2d55' };
const HEALTH_COLOR = { normal: '#22a06b', atencao: '#f5a524', critico: '#ff2d55' };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.erro || res.statusText), { status: res.status, data });
  return data;
}

function toast(msg, color = '#3b82f6') {
  const el = document.createElement('div');
  el.className = 'toast'; el.style.setProperty('--c', color); el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5500);
}

const S = {
  meta: null,
  eq: new Map(), ag: new Map(), live: [], alerts: [],
  filters: { q: '', regiao: [], bairro: [], situacao: [], orgao: [], tipo: [], manut: false },
  layers: { equipamentos: true, agentes: true, ocorrencias: true, saude: true, calor: false },
  alertFilter: 'all', dash: null, pred: null, view: 'central',
};

/* ======================================================================= */
/* Inicialização                                                            */
/* ======================================================================= */
async function init() {
  S.meta = await api('/api/meta');
  setupNav(); setupFilters(); setupInventory(); setupSimMenu();
  const [eqs, ags, live, alerts] = await Promise.all([api('/api/equipments'), api('/api/agents'), api('/api/incidents/live'), api('/api/alerts')]);
  eqs.forEach(e => S.eq.set(e.id, e)); ags.forEach(a => S.ag.set(a.id, a));
  S.live = live; S.alerts = alerts;
  initMap(); renderLegend(); renderMarkers(); renderIncidents(); renderAlerts();
  await refreshDashboard();
  connectSSE();
  setInterval(refreshDashboard, 6000);
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR'); }, 1000);
  renderAbout();
  if (S.view !== 'central') showView(S.view);
}

function setupNav() {
  $$('.tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  const h = location.hash.slice(1);
  if (['central', 'inventario', 'preditiva', 'sobre'].includes(h)) showView(h);
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v !== S.view && ['central', 'inventario', 'preditiva', 'sobre'].includes(v)) showView(v); });
}
function showView(v) {
  S.view = v;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(x => x.classList.toggle('active', x.id === `view-${v}`));
  history.replaceState(null, '', `#${v}`);
  if (v === 'central' && S.map) setTimeout(() => S.map.invalidateSize(), 50);
  if (v === 'inventario') { renderEqTable(); renderAgTable(); }
  if (v === 'preditiva') loadPredictions();
}

function setupSimMenu() {
  const menu = $('#sim-menu');
  $('#btn-sim').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
  $$('#sim-menu button').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/simulate/${b.dataset.sim}`, { method: 'POST' }); toast(`Cenário disparado: <b>${esc(b.textContent)}</b>`, '#ff7a1a'); }
    catch (e) { toast(esc(e.message), '#e5484d'); }
  }));
}

/* ======================================================================= */
/* Tempo real (SSE)                                                         */
/* ======================================================================= */
function connectSSE() {
  const es = new EventSource('/api/stream');
  const live = $('#live');
  es.addEventListener('hello', () => { live.classList.add('on'); live.lastChild.textContent = 'tempo real'; });
  es.onerror = () => { live.classList.remove('on'); live.lastChild.textContent = 'reconectando…'; };
  es.addEventListener('tick', ev => {
    const p = JSON.parse(ev.data);
    if (p.reload) { reloadEntities(); return; }
    for (const u of p.equipments) {
      const e = S.eq.get(u.id); if (!e) continue;
      const changed = e.situacao !== u.situacao;
      e.situacao = u.situacao; if (u.posicao) e.posicao = u.posicao; if (u.telemetria) e.telemetria = u.telemetria;
      updateEqMarker(e, changed);
    }
    for (const u of p.agents) {
      const a = S.ag.get(u.id); if (!a) continue;
      const changed = a.situacao !== u.situacao;
      Object.assign(a, u); updateAgMarker(a, changed);
    }
    if (S.drawerId && S.drawerKind === 'eq') { const e = S.eq.get(S.drawerId); if (e && e.telemetria) renderTelemetry(e); }
  });
  es.addEventListener('alert', ev => {
    const a = JSON.parse(ev.data);
    S.alerts.unshift(a); renderAlerts(a.id);
    if (['critico', 'alto'].includes(a.nivel)) toast(`<b>${esc(a.titulo)}</b><br><span class="muted">${esc(a.detalhe || '')}</span>`, LEVEL_COLOR[a.nivel]);
  });
  es.addEventListener('alert-ack', ev => { const { id } = JSON.parse(ev.data); const a = S.alerts.find(x => x.id === id); if (a) { a.reconhecido = true; renderAlerts(); } });
  es.addEventListener('incident', ev => {
    const inc = JSON.parse(ev.data);
    const i = S.live.findIndex(x => x.id === inc.id);
    if (i >= 0) S.live[i] = inc; else S.live.push(inc);
    S.live = S.live.filter(x => x.status !== 'encerrada' || Date.now() - new Date(x.fim) < 3600000);
    renderIncidents(); renderLiveTable();
  });
  es.addEventListener('kpi', () => {});
  es.addEventListener('reset', () => location.reload());
}

async function reloadEntities() {
  const [eqs, ags] = await Promise.all([api('/api/equipments'), api('/api/agents')]);
  S.eq.clear(); S.ag.clear();
  eqs.forEach(e => S.eq.set(e.id, e)); ags.forEach(a => S.ag.set(a.id, a));
  renderMarkers();
  if (S.view === 'inventario') { renderEqTable(); renderAgTable(); }
}

/* ======================================================================= */
/* Filtros                                                                  */
/* ======================================================================= */
function setupFilters() {
  const m = S.meta;
  const fill = (sel, items) => { $(sel).innerHTML = items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); };
  fill('#f-regiao', m.regioes.map(r => [r, r]));
  fill('#f-bairro', m.bairros.map(b => [b.nome, `${b.nome} (${b.regiao})`]));
  fill('#f-situacao', Object.entries(m.situacoes).map(([k, v]) => [k, v.label]));
  fill('#f-orgao', m.orgaos.map(o => [o, o]));
  $('#f-tipo').innerHTML = Object.entries(m.tiposEquipamento).map(([k, v]) => `<span class="chip" data-tipo="${k}" title="${esc(v.label)}">${v.icon} ${esc(v.curto)}</span>`).join('');
  const multi = (id, key) => $(id).addEventListener('change', e => { S.filters[key] = [...e.target.selectedOptions].map(o => o.value); onFilter(); });
  multi('#f-regiao', 'regiao'); multi('#f-bairro', 'bairro'); multi('#f-situacao', 'situacao'); multi('#f-orgao', 'orgao');
  let t; $('#f-q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.filters.q = e.target.value; onFilter(); }, 250); });
  $$('#f-tipo .chip').forEach(c => c.addEventListener('click', () => {
    c.classList.toggle('on'); S.filters.tipo = $$('#f-tipo .chip.on').map(x => x.dataset.tipo); onFilter();
  }));
  $('#f-manut').addEventListener('change', e => { S.filters.manut = e.target.checked; onFilter(); });
  $$('[data-layer]').forEach(c => c.addEventListener('change', () => { S.layers[c.dataset.layer] = c.checked; applyLayers(); }));
  $('#f-clear').addEventListener('click', () => {
    S.filters = { q: '', regiao: [], bairro: [], situacao: [], orgao: [], tipo: [], manut: false };
    $('#f-q').value = ''; $('#f-manut').checked = false;
    $$('#filters select').forEach(s => [...s.options].forEach(o => o.selected = false));
    $$('#f-tipo .chip').forEach(c => c.classList.remove('on'));
    onFilter();
  });
  $$('.alert-filter .pill').forEach(p => p.addEventListener('click', () => {
    $$('.alert-filter .pill').forEach(x => x.classList.remove('active')); p.classList.add('active');
    S.alertFilter = p.dataset.al; renderAlerts();
  }));
}

function filterQuery() {
  const f = S.filters, q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  for (const k of ['regiao', 'bairro', 'situacao', 'orgao', 'tipo']) if (f[k].length) q.set(k, f[k].join(','));
  return q.toString();
}
function onFilter() { renderMarkers(); refreshDashboard(); }

const todayStr = () => new Date().toISOString().slice(0, 10);
function needsImmediate(e) { return e.situacao === 'mau_funcionamento' || e.manutencao.tipo === 'imediata'; }
function maintSoon(e) {
  if (!e.manutencao.proximaData || ['nao_instalado', 'desativado', 'furtado'].includes(e.situacao) || needsImmediate(e)) return false;
  return (new Date(e.manutencao.proximaData) - new Date(todayStr())) / 864e5 <= 7;
}
function eqVisible(e) {
  const f = S.filters;
  if (f.tipo.length && !f.tipo.includes(e.tipo)) return false;
  if (f.situacao.length && !f.situacao.includes(e.situacao)) return false;
  if (f.regiao.length && !f.regiao.includes(e.regiao)) return false;
  if (f.bairro.length && !f.bairro.includes(e.localizacao.bairro)) return false;
  if (f.orgao.length && !f.orgao.includes(e.orgao)) return false;
  if (f.manut && !(needsImmediate(e) || maintSoon(e))) return false;
  if (f.q) { const t = [e.id, e.numeroSerie, e.marca, e.modelo, e.localizacao.rua, e.localizacao.bairro, e.caracteristicas.placa].join(' ').toLowerCase(); if (!t.includes(f.q.toLowerCase())) return false; }
  return true;
}
function agVisible(a) {
  const f = S.filters;
  if (f.tipo.length || f.situacao.length || f.manut) return false; // filtros de equipamento escondem agentes
  if (f.regiao.length && !f.regiao.includes(a.regiao)) return false;
  if (f.bairro.length && !f.bairro.includes(a.bairroBase)) return false;
  if (f.orgao.length && !f.orgao.includes(a.orgao)) return false;
  if (f.q && ![a.nome, a.matricula, a.id].join(' ').toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

/* ======================================================================= */
/* Mapa                                                                     */
/* ======================================================================= */
const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function initMap() {
  S.map = L.map('map', { zoomControl: true, preferCanvas: false }).setView([-22.1255, -51.4], 13);
  L.tileLayer(TILE, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(S.map);
  S.lg = {
    saude: L.layerGroup().addTo(S.map),
    equipamentos: L.layerGroup().addTo(S.map),
    agentes: L.layerGroup().addTo(S.map),
    ocorrencias: L.layerGroup().addTo(S.map),
    calor: L.layerGroup(),
  };
  S.eqMk = new Map(); S.agMk = new Map(); S.incMk = new Map();
}

function applyLayers() {
  for (const [k, lg] of Object.entries(S.lg)) {
    if (S.layers[k] && !S.map.hasLayer(lg)) lg.addTo(S.map);
    if (!S.layers[k] && S.map.hasLayer(lg)) S.map.removeLayer(lg);
  }
  if (S.layers.calor && !S.heatLoaded) loadHeat();
}

async function loadHeat() {
  S.heatLoaded = true;
  const hist = await api('/api/incidents/history?dias=30');
  const w = { baixa: 0.4, media: 0.6, alta: 0.85, critica: 1 };
  L.heatLayer(hist.map(i => [i.lat, i.lng, w[i.severidade]]), { radius: 22, blur: 18, maxZoom: 15, gradient: { 0.3: '#3b82f6', 0.55: '#f5a524', 0.8: '#ff7a1a', 1: '#ff2d55' } }).addTo(S.lg.calor);
}

function eqIcon(e) {
  const t = S.meta.tiposEquipamento[e.tipo], st = S.meta.situacoes[e.situacao];
  const down = ['mau_funcionamento', 'furtado'].includes(e.situacao);
  return L.divIcon({ className: '', html: `<div class="mk ${down ? 'down' : ''}" style="--c:${st.cor}">${t.icon}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}
function agIcon(a) {
  const t = S.meta.tiposAgente[a.tipo], st = S.meta.situacoesAgente[a.situacao];
  return L.divIcon({ className: '', html: `<div class="mk agent" style="--c:${st.cor}">${t.icon}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}
const eqPos = e => e.posicao ? [e.posicao.lat, e.posicao.lng] : [e.localizacao.lat, e.localizacao.lng];

function renderMarkers() {
  if (!S.map) return;
  for (const e of S.eq.values()) {
    const vis = eqVisible(e);
    let mk = S.eqMk.get(e.id);
    if (vis && !mk) {
      mk = L.marker(eqPos(e), { icon: eqIcon(e), title: e.id }).on('click', () => openEquipment(e.id));
      mk.bindTooltip(() => eqTooltip(S.eq.get(e.id)), { direction: 'top', offset: [0, -12] });
      S.eqMk.set(e.id, mk); mk.addTo(S.lg.equipamentos);
    } else if (!vis && mk) { S.lg.equipamentos.removeLayer(mk); S.eqMk.delete(e.id); }
  }
  for (const [id, mk] of S.eqMk) if (!S.eq.has(id)) { S.lg.equipamentos.removeLayer(mk); S.eqMk.delete(id); }
  for (const a of S.ag.values()) {
    const vis = agVisible(a) && a.posicao && a.situacao !== 'fora_de_servico';
    let mk = S.agMk.get(a.id);
    if (vis && !mk) {
      mk = L.marker([a.posicao.lat, a.posicao.lng], { icon: agIcon(a), zIndexOffset: 500 }).on('click', () => openAgent(a.id));
      mk.bindTooltip(() => agTooltip(S.ag.get(a.id)), { direction: 'top', offset: [0, -12] });
      S.agMk.set(a.id, mk); mk.addTo(S.lg.agentes);
    } else if (!vis && mk) { S.lg.agentes.removeLayer(mk); S.agMk.delete(a.id); }
  }
}
function updateEqMarker(e, statusChanged) {
  const vis = eqVisible(e), mk = S.eqMk.get(e.id);
  if (!vis || !mk) { if (vis !== !!mk) renderMarkers(); return; }
  if (e.posicao) mk.setLatLng(eqPos(e));
  if (statusChanged) mk.setIcon(eqIcon(e));
}
function updateAgMarker(a, statusChanged) {
  const vis = agVisible(a) && a.situacao !== 'fora_de_servico', mk = S.agMk.get(a.id);
  if (vis !== !!mk) { renderMarkers(); return; }
  if (!mk) return;
  mk.setLatLng([a.posicao.lat, a.posicao.lng]);
  if (statusChanged) mk.setIcon(agIcon(a));
}
function eqTooltip(e) {
  const t = S.meta.tiposEquipamento[e.tipo], st = S.meta.situacoes[e.situacao];
  return `<b>${t.icon} ${esc(t.label)}</b><br>${esc(e.id)} · ${esc(e.marca)} ${esc(e.modelo)}<br><span class="status" style="--c:${st.cor}">${st.label}</span><br><span class="muted">${esc(e.localizacao.rua)}, ${esc(e.localizacao.referencia)} — ${esc(e.localizacao.bairro)}</span>`;
}
function agTooltip(a) {
  const t = S.meta.tiposAgente[a.tipo], st = S.meta.situacoesAgente[a.situacao];
  return `<b>${t.icon} ${esc(a.nome)}</b><br>${esc(t.label)} · mat. ${esc(a.matricula)}<br><span class="status" style="--c:${st.cor}">${st.label}</span>${a.ocorrenciaId ? `<br>Atendendo ${esc(a.ocorrenciaId)}` : ''}`;
}

function renderIncidents() {
  if (!S.map) return;
  const open = S.live.filter(i => i.status !== 'encerrada' && (!S.filters.bairro.length || S.filters.bairro.includes(i.bairro)) && (!S.filters.regiao.length || S.filters.regiao.includes(i.regiao)));
  const ids = new Set(open.map(i => i.id));
  for (const [id, mk] of S.incMk) if (!ids.has(id)) { S.lg.ocorrencias.removeLayer(mk); S.incMk.delete(id); }
  for (const i of open) {
    if (S.incMk.has(i.id)) continue;
    const t = S.meta.tiposOcorrencia[i.tipo];
    const mk = L.marker([i.lat, i.lng], { icon: L.divIcon({ className: '', html: `<div class="mk inc" style="--c:${SEV_COLOR[i.severidade]}">${t.icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 });
    mk.bindPopup(() => `<b>${t.icon} ${esc(t.label)}</b><br>${esc(i.id)} · severidade <b style="color:${SEV_COLOR[i.severidade]}">${i.severidade}</b><br>${esc(i.bairro)} · desde ${fmtTime(i.inicio)}<br>${(S.live.find(x => x.id === i.id) || i).agentes.length ? 'Agentes: ' + esc((S.live.find(x => x.id === i.id) || i).agentes.join(', ')) : '<span style="color:#ff8a8d">Aguardando agente</span>'}`);
    S.incMk.set(i.id, mk); mk.addTo(S.lg.ocorrencias);
  }
  renderLiveTable();
}

function renderHealthLayer() {
  if (!S.dash || !S.map) return;
  S.lg.saude.clearLayers();
  for (const b of S.dash.bairros) {
    L.circle([b.lat, b.lng], { radius: 650, color: HEALTH_COLOR[b.status], weight: 1.5, fillOpacity: b.status === 'normal' ? 0.06 : 0.16, dashArray: b.status === 'normal' ? '4 6' : null, interactive: true })
      .bindTooltip(`<b>${esc(b.bairro)}</b> — saúde ${b.saude}/100<br>Disponibilidade ${b.disponibilidade}% · ${b.ocorrenciasAbertas} ocorrência(s) · ${b.agentesAtivos} agente(s)${b.indiceRisco != null ? `<br>Risco previsto agora: ${b.indiceRisco}/100` : ''}`, { sticky: true })
      .addTo(S.lg.saude);
  }
}

function renderLegend() {
  const st = Object.values(S.meta.situacoes).map(s => `<span><i style="background:${s.cor}"></i>${s.label}</span>`).join('');
  $('#legend').innerHTML = `${st}<span>▢ agente</span><span>◯ bairro (saúde)</span>`;
}

/* ======================================================================= */
/* Dashboard                                                                */
/* ======================================================================= */
async function refreshDashboard() {
  try { S.dash = await api('/api/dashboard?' + filterQuery()); } catch { return; }
  renderKPIs(); renderRegions(); renderHealthLayer(); renderCharts(); renderMaint();
}

function renderKPIs() {
  const k = S.dash.kpis;
  const cards = [
    ['Equipamentos', k.totalEquipamentos, `${k.instalados} instalados · ${k.naoInstalados} a instalar`, '#3b82f6'],
    ['Operacionais', k.operacionais, 'em funcionamento agora', '#22a06b'],
    ['Indisponíveis', k.indisponiveis, 'falha, manutenção, desativados, furtados', '#e5484d'],
    ['Disponibilidade', `${k.disponibilidade}%`, 'operacionais ÷ instalados', k.disponibilidade >= 90 ? '#22a06b' : k.disponibilidade >= 80 ? '#f5a524' : '#e5484d'],
    ['Agentes em atividade', k.agentesEmAtividade, `${k.agentesEmOcorrencia} em ocorrência · ${k.agentesTotal} cadastrados`, '#a43ad6'],
    ['Ocorrências abertas', k.ocorrenciasAbertas, 'em andamento na cidade', '#ff7a1a'],
    ['Manutenção imediata', k.manutencaoImediata, `${k.manutencaoProxima7d} previstas em 7 dias`, '#f5a524'],
    ['Alertas críticos', k.alertasCriticos, `${k.alertasAbertos} alertas não reconhecidos`, '#ff2d55'],
  ];
  const el = $('#kpis');
  const prev = $$('.kpi .v', el).map(x => x.textContent);
  el.innerHTML = cards.map(([l, v, s, c]) => `<div class="kpi" style="--c:${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
  $$('.kpi', el).forEach((k2, i) => { if (prev[i] != null && prev[i] !== $('.v', k2).textContent) k2.classList.add('flash'); });
}

function renderRegions() {
  $('#regions').innerHTML = S.dash.regioes.map(r => {
    const bs = S.dash.bairros.filter(b => b.regiao === r.regiao);
    return `<div class="region" style="--c:${HEALTH_COLOR[r.status]}"><div class="h"><b>${esc(r.regiao)}</b><span class="score">${r.saude}</span></div>
      <div class="muted">${r.ocorrenciasAbertas} ocorrência(s) aberta(s)</div>
      <ul>${bs.map(b => `<li data-bairro="${esc(b.bairro)}"><span><span class="dot" style="--c:${HEALTH_COLOR[b.status]}"></span>${esc(b.bairro)}</span><span>${b.saude} · ${b.disponibilidade}%</span></li>`).join('')}</ul></div>`;
  }).join('');
  $$('#regions li').forEach(li => li.addEventListener('click', () => { const b = S.meta.bairros.find(x => x.nome === li.dataset.bairro); S.map.flyTo([b.lat, b.lng], 15); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
}

function renderCharts() {
  if (!window.Chart) return;
  Chart.defaults.color = '#8fa0bd'; Chart.defaults.borderColor = '#23314d';
  const ps = S.dash.porSituacao, sit = S.meta.situacoes;
  const keys = Object.keys(sit);
  const dStatus = { labels: keys.map(k => sit[k].label), datasets: [{ data: keys.map(k => ps[k]), backgroundColor: keys.map(k => sit[k].cor), borderWidth: 0 }] };
  if (!S.chStatus) S.chStatus = new Chart($('#ch-status'), { type: 'doughnut', data: dStatus, options: { maintainAspectRatio: false, plugins: { legend: { position: 'right' } }, cutout: '62%', animation: { duration: 300 } } });
  else { S.chStatus.data = dStatus; S.chStatus.update('none'); }
  const pt = S.dash.porTipo, types = Object.keys(pt).sort((a, b) => pt[b].total - pt[a].total);
  const dTypes = { labels: types.map(t => `${S.meta.tiposEquipamento[t].icon} ${S.meta.tiposEquipamento[t].curto}`), datasets: [{ label: 'Disponibilidade (%)', data: types.map(t => Math.round(100 * pt[t].operacionais / pt[t].total)), backgroundColor: types.map(t => { const v = pt[t].operacionais / pt[t].total; return v >= 0.9 ? '#22a06b' : v >= 0.8 ? '#f5a524' : '#e5484d'; }), borderRadius: 4 }] };
  if (!S.chTypes) S.chTypes = new Chart($('#ch-types'), { type: 'bar', data: dTypes, options: { maintainAspectRatio: false, indexAxis: 'y', scales: { x: { min: 0, max: 100 } }, plugins: { legend: { display: false } }, animation: { duration: 300 } } });
  else { S.chTypes.data = dTypes; S.chTypes.update('none'); }
}

function renderMaint() {
  const T = S.meta.tiposEquipamento;
  const li = (e, extra) => `<li data-eq="${e.id}"><span>${T[e.tipo].icon} ${e.id} <span class="muted">· ${esc(e.bairro)}</span></span><span class="muted">${extra}</span></li>`;
  $('#m-imediata').innerHTML = S.dash.manutencao.imediata.map(e => li(e, S.meta.situacoes[e.situacao].label)).join('') || '<li class="muted">Nenhum equipamento</li>';
  $('#m-proxima').innerHTML = S.dash.manutencao.proxima.map(e => { const d = Math.round((new Date(e.data) - new Date(todayStr())) / 864e5); return li(e, d < 0 ? `<span style="color:#e5484d">vencida há ${-d} d</span>` : d === 0 ? 'hoje' : fmtDate(e.data)); }).join('') || '<li class="muted">Nenhum equipamento</li>';
  $$('.mini-list li[data-eq]').forEach(x => x.addEventListener('click', () => focusEquipment(x.dataset.eq)));
}

function renderLiveTable() {
  const T = S.meta.tiposOcorrencia;
  const rows = [...S.live].sort((a, b) => b.inicio.localeCompare(a.inicio));
  $('#t-live tbody').innerHTML = rows.map(i => `<tr class="click" data-inc="${i.id}"><td>${esc(i.id)}</td><td>${T[i.tipo].icon} ${esc(T[i.tipo].label)}</td><td><span class="status" style="--c:${SEV_COLOR[i.severidade]}">${i.severidade}</span></td><td>${esc(i.bairro)}</td><td>${fmtTime(i.inicio)}</td><td>${{ aberta: '🔴 aguardando', em_atendimento: '🟠 em atendimento', encerrada: '🟢 encerrada' }[i.status]}</td><td>${esc((i.agentes || []).join(', ')) || '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nenhuma ocorrência na última hora.</td></tr>';
  $$('#t-live tr[data-inc]').forEach(tr => tr.addEventListener('click', () => { const i = S.live.find(x => x.id === tr.dataset.inc); if (i) { S.map.flyTo([i.lat, i.lng], 16); window.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(() => S.incMk.get(i.id)?.openPopup(), 900); } }));
}

/* ======================================================================= */
/* Alertas                                                                  */
/* ======================================================================= */
function renderAlerts(newId) {
  const open = S.alerts.filter(a => !a.reconhecido);
  $('#alert-count').textContent = open.length;
  const list = open.filter(a => S.alertFilter === 'all' || a.nivel === S.alertFilter).slice(0, 80);
  $('#alerts').innerHTML = list.map(a => `<li class="alert ${a.id === newId ? 'new' : ''}" style="--c:${LEVEL_COLOR[a.nivel]}" data-id="${a.id}">
    <div class="t">${esc(a.titulo)}</div><div class="d">${esc(a.detalhe || '')}</div>
    <div class="m"><span><span class="lvl" style="--c:${LEVEL_COLOR[a.nivel]}">${a.nivel}</span> ${esc(a.categoria)} · ${fmtTime(a.em)}</span>
    <span><button class="btn sm ghost" data-go>ver</button> <button class="btn sm" data-ack>ok</button></span></div></li>`).join('') || '<li class="muted">Nenhum alerta pendente. 🎉</li>';
  $$('#alerts .alert').forEach(li => {
    const a = S.alerts.find(x => x.id === li.dataset.id);
    $('[data-ack]', li).addEventListener('click', async () => { await api(`/api/alerts/${a.id}/ack`, { method: 'POST' }); a.reconhecido = true; renderAlerts(); });
    $('[data-go]', li).addEventListener('click', () => {
      if (a.equipamentoId) return focusEquipment(a.equipamentoId);
      const inc = a.ocorrenciaId && S.live.find(x => x.id === a.ocorrenciaId);
      if (inc) return S.map.flyTo([inc.lat, inc.lng], 16);
      const b = S.meta.bairros.find(x => x.nome === a.bairro); if (b) S.map.flyTo([b.lat, b.lng], 15);
    });
  });
}

function focusEquipment(id) {
  const e = S.eq.get(id); if (!e) return;
  if (S.view !== 'central') showView('central');
  setTimeout(() => S.map.flyTo(eqPos(e), 17), 60);
  openEquipment(id);
}

/* ======================================================================= */
/* Drawer de detalhes                                                       */
/* ======================================================================= */
function openDrawer(html) { $('#drawer-body').innerHTML = html; $('#drawer').classList.add('open'); }
$('#drawer-close').addEventListener('click', () => { $('#drawer').classList.remove('open'); S.drawerId = null; });

const TELE_LABEL = { fluxoVeiculosMin: 'veículos/min', velocidadeMedia: 'velocidade média (km/h)', fps: 'FPS', latenciaMs: 'latência (ms)', pesagensHora: 'pesagens/h', excessoPeso: 'com excesso de peso', bateria: 'bateria (%)', transacoesHora: 'transações/h', papelPct: 'papel (%)', cicloSeg: 'ciclo (s)', tensaoV: 'tensão (V)', aberturasHora: 'aberturas/h', velocidadeKmh: 'velocidade (km/h)' };
function renderTelemetry(e) {
  const el = $('#tele'); if (!el) return;
  el.innerHTML = e.telemetria ? Object.entries(e.telemetria).map(([k, v]) => `<div><b>${esc(v)}</b><span>${TELE_LABEL[k] || k}</span></div>`).join('') : '<p class="muted">Sem telemetria (equipamento fora de operação ou aguardando primeira leitura).</p>';
}

async function openEquipment(id) {
  S.drawerId = id; S.drawerKind = 'eq';
  const e = await api(`/api/equipments/${id}`);
  const T = S.meta.tiposEquipamento[e.tipo], st = S.meta.situacoes[e.situacao], L2 = e.localizacao;
  const fields = T.fields.filter(f => e.caracteristicas[f.key] !== undefined).map(f => {
    let v = e.caracteristicas[f.key]; if (f.type === 'boolean') v = v ? 'Sim' : 'Não';
    return `<dt>${esc(f.label)}</dt><dd>${esc(String(v).replace(/_/g, ' '))}</dd>`;
  }).join('');
  const r = e.riscoFalha;
  openDrawer(`
    <h2>${T.icon} ${esc(T.label)}</h2>
    <div class="muted">${esc(e.id)} · ${esc(e.marca)} ${esc(e.modelo)}</div>
    <p><span class="status" style="--c:${st.cor}">${st.label}</span></p>
    <div class="section-title">Identificação e local</div>
    <dl class="kv">
      <dt>Nº de série</dt><dd>${esc(e.numeroSerie)}</dd>
      <dt>Órgão</dt><dd>${esc(e.orgao)}</dd>
      <dt>Endereço</dt><dd>${esc(L2.rua)}, ${esc(L2.referencia)}<br>${esc(L2.bairro)} — ${esc(L2.cidade)}/${esc(L2.uf)} · CEP ${esc(L2.cep)}</dd>
      <dt>Região</dt><dd>${esc(e.regiao)}</dd>
      <dt>GPS ${T.movel ? '(base)' : ''}</dt><dd>${L2.lat}, ${L2.lng}</dd>
      <dt>Instalação</dt><dd>${fmtDate(e.dataInstalacao)}</dd>
    </dl>
    <div class="section-title">Manutenção</div>
    <dl class="kv">
      <dt>Necessidade</dt><dd>${esc(S.meta.manutencao[e.manutencao.tipo])}</dd>
      <dt>Última</dt><dd>${fmtDate(e.manutencao.ultimaData)}</dd>
      <dt>Próxima</dt><dd>${fmtDate(e.manutencao.proximaData)}</dd>
      <dt>Periodicidade</dt><dd>${e.manutencao.periodicidadeDias} dias</dd>
    </dl>
    ${r ? `<div class="model-card lvl-${r.nivel}" style="border-left:4px solid var(--c)"><b>Risco de falha previsto</b><div class="big">${pct(r.prob7d)} <span class="muted">em 7 dias</span></div><div class="muted">${pct(r.prob30d)} em 30 dias · ${r.motivos.map(esc).join(' · ') || 'sem fatores de risco relevantes'}</div></div>` : ''}
    <div class="section-title">Outras características</div><dl class="kv">${fields || '<dd class="muted">—</dd>'}</dl>
    <div class="section-title">Telemetria ao vivo</div><div class="tele" id="tele"></div>
    ${e.anomalias.length ? `<div class="section-title">Anomalias recentes</div><ul class="timeline">${e.anomalias.map(a => `<li style="--c:#f5a524">${fmtDateTime(a.em)} — ${esc(TELE_LABEL[a.metrica] || a.metrica)}: ${a.valor} (esperado ≈ ${a.esperado})</li>`).join('')}</ul>` : ''}
    <div class="section-title">Histórico</div>
    <ul class="timeline">${[...e.historico].reverse().slice(0, 40).map(h => `<li style="--c:${h.tipo === 'falha' ? '#e5484d' : h.tipo === 'manutencao' ? '#22a06b' : '#3b82f6'}">${fmtDateTime(h.data)} — <b>${({ falha: 'Falha', manutencao: 'Manutenção', status: 'Situação', cadastro: 'Cadastro' })[h.tipo] || esc(h.tipo)}</b>: ${esc(h.descricao)}</li>`).join('')}</ul>
    <div class="form-actions" style="margin-top:14px"><button class="btn danger" id="d-del">Excluir</button><button class="btn primary" id="d-edit">Editar</button></div>`);
  renderTelemetry({ telemetria: e.telemetria && e.telemetria.metricas });
  $('#d-edit').addEventListener('click', () => equipmentForm(e));
  $('#d-del').addEventListener('click', async () => {
    if (!confirmInline('#d-del')) return;
    await api(`/api/equipments/${e.id}`, { method: 'DELETE' }); S.eq.delete(e.id); renderMarkers(); renderEqTable();
    $('#drawer').classList.remove('open'); toast(`Equipamento ${esc(e.id)} excluído.`);
  });
}

// confirmação sem diálogo nativo: primeiro clique arma, segundo confirma
function confirmInline(sel) {
  const b = $(sel);
  if (b.dataset.armed) return true;
  b.dataset.armed = '1'; b.textContent = 'Clique de novo para confirmar';
  setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Excluir'; } }, 3500);
  return false;
}

function openAgent(id) {
  S.drawerId = id; S.drawerKind = 'ag';
  const a = S.ag.get(id); if (!a) return;
  const T = S.meta.tiposAgente[a.tipo], st = S.meta.situacoesAgente[a.situacao];
  const v = a.equipamentoId && S.eq.get(a.equipamentoId);
  const inc = a.ocorrenciaId && S.live.find(i => i.id === a.ocorrenciaId);
  openDrawer(`<h2>${T.icon} ${esc(a.nome)}</h2><div class="muted">${esc(T.label)} · matrícula ${esc(a.matricula)}</div>
    <p><span class="status" style="--c:${st.cor}">${st.label}</span></p>
    <dl class="kv"><dt>Órgão</dt><dd>${esc(a.orgao)}</dd><dt>Turno</dt><dd>${{ manha: 'Manhã (06–14h)', tarde: 'Tarde (14–22h)', noite: 'Noite (22–06h)' }[a.turno]}</dd>
    <dt>Base</dt><dd>${esc(a.bairroBase)} (${esc(a.regiao)})</dd><dt>Veículo</dt><dd>${v ? `${S.meta.tiposEquipamento[v.tipo].icon} ${esc(v.id)} ${esc(v.caracteristicas.placa || '')}` : '—'}</dd>
    <dt>Posição</dt><dd>${a.posicao ? `${a.posicao.lat}, ${a.posicao.lng}` : '—'}</dd>
    <dt>Ocorrência</dt><dd>${inc ? `${esc(S.meta.tiposOcorrencia[inc.tipo].label)} — ${esc(inc.bairro)} (${inc.severidade})` : '—'}</dd></dl>
    <div class="form-actions"><button class="btn danger" id="d-del">Excluir</button><button class="btn primary" id="d-edit">Editar</button></div>`);
  $('#d-edit').addEventListener('click', () => agentForm(a));
  $('#d-del').addEventListener('click', async () => {
    if (!confirmInline('#d-del')) return;
    await api(`/api/agents/${a.id}`, { method: 'DELETE' }); S.ag.delete(a.id); renderMarkers(); renderAgTable();
    $('#drawer').classList.remove('open'); toast(`Agente ${esc(a.nome)} excluído.`);
  });
}

/* ======================================================================= */
/* Inventário                                                               */
/* ======================================================================= */
const INV = { page: 0, per: 20 };
function setupInventory() {
  const m = S.meta;
  $('#eq-tipo').innerHTML += Object.entries(m.tiposEquipamento).map(([k, v]) => `<option value="${k}">${v.icon} ${esc(v.label)}</option>`).join('');
  $('#eq-sit').innerHTML += Object.entries(m.situacoes).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#eq-bairro').innerHTML += m.bairros.map(b => `<option>${esc(b.nome)}</option>`).join('');
  $('#ag-tipo').innerHTML += Object.entries(m.tiposAgente).map(([k, v]) => `<option value="${k}">${v.icon} ${esc(v.label)}</option>`).join('');
  $('#ag-sit').innerHTML += Object.entries(m.situacoesAgente).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  ['#eq-q', '#eq-tipo', '#eq-sit', '#eq-bairro'].forEach(s => $(s).addEventListener('input', () => { INV.page = 0; renderEqTable(); }));
  ['#ag-q', '#ag-tipo', '#ag-sit'].forEach(s => $(s).addEventListener('input', renderAgTable));
  $$('[data-inv]').forEach(b => b.addEventListener('click', () => {
    $$('[data-inv]').forEach(x => x.classList.toggle('active', x === b));
    $('#inv-equipamentos').classList.toggle('hidden', b.dataset.inv !== 'equipamentos');
    $('#inv-agentes').classList.toggle('hidden', b.dataset.inv !== 'agentes');
  }));
  $('#eq-new').addEventListener('click', () => equipmentForm(null));
  $('#ag-new').addEventListener('click', () => agentForm(null));
}

function eqFiltered() {
  const q = $('#eq-q').value.toLowerCase(), t = $('#eq-tipo').value, s = $('#eq-sit').value, b = $('#eq-bairro').value;
  return [...S.eq.values()].filter(e => (!t || e.tipo === t) && (!s || e.situacao === s) && (!b || e.localizacao.bairro === b) &&
    (!q || [e.id, e.numeroSerie, e.marca, e.modelo, e.localizacao.rua, e.localizacao.bairro, e.caracteristicas.placa].join(' ').toLowerCase().includes(q)));
}
function renderEqTable() {
  const list = eqFiltered().sort((a, b) => a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(list.length / INV.per)); INV.page = Math.min(INV.page, pages - 1);
  const rows = list.slice(INV.page * INV.per, (INV.page + 1) * INV.per);
  const T = S.meta.tiposEquipamento, ST = S.meta.situacoes;
  $('#t-eq tbody').innerHTML = rows.map(e => `<tr class="click" data-id="${e.id}"><td>${e.id}</td><td>${T[e.tipo].icon} ${esc(T[e.tipo].label)}</td><td>${esc(e.marca)}<br><span class="muted">${esc(e.modelo)}</span></td><td>${esc(e.numeroSerie)}</td>
    <td>${esc(e.localizacao.rua)}, ${esc(e.localizacao.referencia)}<br><span class="muted">${esc(e.localizacao.bairro)} · ${esc(e.localizacao.cep)}</span></td>
    <td><span class="status" style="--c:${ST[e.situacao].cor}">${ST[e.situacao].label}</span></td>
    <td>${fmtDate(e.manutencao.proximaData)}<br><span class="muted">${esc(S.meta.manutencao[e.manutencao.tipo])}</span></td><td><button class="btn sm" data-edit>Editar</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Nenhum equipamento encontrado.</td></tr>';
  $$('#t-eq tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('click', ev => { if (ev.target.closest('[data-edit]')) return; openEquipment(tr.dataset.id); });
    $('[data-edit]', tr).addEventListener('click', async () => equipmentForm(await api(`/api/equipments/${tr.dataset.id}`)));
  });
  $('#eq-pager').innerHTML = `<span class="muted">${list.length} equipamento(s) · página ${INV.page + 1} de ${pages}</span><button class="btn sm" ${INV.page === 0 ? 'disabled' : ''} data-p="-1">‹</button><button class="btn sm" ${INV.page >= pages - 1 ? 'disabled' : ''} data-p="1">›</button>`;
  $$('#eq-pager [data-p]').forEach(b => b.addEventListener('click', () => { INV.page += Number(b.dataset.p); renderEqTable(); }));
  const qs = new URLSearchParams({ ...( $('#eq-tipo').value && { tipo: $('#eq-tipo').value }), ...( $('#eq-sit').value && { situacao: $('#eq-sit').value }), ...( $('#eq-bairro').value && { bairro: $('#eq-bairro').value }), ...( $('#eq-q').value && { q: $('#eq-q').value }) });
  $('#eq-csv').href = '/api/equipments.csv?' + qs;
}
function renderAgTable() {
  const q = $('#ag-q').value.toLowerCase(), t = $('#ag-tipo').value, s = $('#ag-sit').value;
  const list = [...S.ag.values()].filter(a => (!t || a.tipo === t) && (!s || a.situacao === s) && (!q || [a.nome, a.matricula].join(' ').toLowerCase().includes(q))).sort((a, b) => a.nome.localeCompare(b.nome));
  const T = S.meta.tiposAgente, ST = S.meta.situacoesAgente;
  $('#t-ag tbody').innerHTML = list.map(a => `<tr class="click" data-id="${a.id}"><td>${esc(a.matricula)}</td><td>${esc(a.nome)}</td><td>${T[a.tipo].icon} ${esc(T[a.tipo].label)}</td><td>${esc(a.orgao)}</td><td>${esc(a.turno)}</td><td>${esc(a.bairroBase)}</td>
    <td><span class="status" style="--c:${ST[a.situacao].cor}">${ST[a.situacao].label}</span></td><td>${esc(a.equipamentoId || '—')}</td><td><button class="btn sm" data-edit>Editar</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">Nenhum agente.</td></tr>';
  $$('#t-ag tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('click', ev => { if (ev.target.closest('[data-edit]')) return; openAgent(tr.dataset.id); });
    $('[data-edit]', tr).addEventListener('click', () => agentForm(S.ag.get(tr.dataset.id)));
  });
}

/* ---------- formulários ---------- */
function openModal(title, html) {
  $('#modal-title').textContent = title; $('#modal-form').innerHTML = html; $('#modal').classList.add('open');
}
function closeModal() { $('#modal').classList.remove('open'); if (S.pickMap) { S.pickMap.remove(); S.pickMap = null; } }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;
const field = (name, label, input) => `<label>${label}${input}<span class="err" data-err="${name}"></span></label>`;

function equipmentForm(e) {
  const m = S.meta;
  const isNew = !e;
  e = e || { tipo: 'camera', situacao: 'nao_instalado', orgao: m.tiposEquipamento.camera.orgao, localizacao: { cidade: 'Presidente Prudente', uf: 'SP', bairro: 'Centro', lat: -22.1225, lng: -51.3885 }, manutencao: { tipo: 'agendada', periodicidadeDias: 120 }, caracteristicas: {} };
  const L2 = e.localizacao;
  openModal(isNew ? 'Novo equipamento' : `Editar ${e.id}`, `
    <fieldset><legend>Identificação</legend><div class="form-grid">
      ${field('tipo', 'Tipo de equipamento', `<select name="tipo">${Object.entries(m.tiposEquipamento).map(([k, v]) => opt(k, `${v.icon} ${v.label}`, k === e.tipo)).join('')}</select>`)}
      ${field('numeroSerie', 'Número de série', `<input name="numeroSerie" value="${esc(e.numeroSerie || '')}" required>`)}
      ${field('marca', 'Marca', `<input name="marca" value="${esc(e.marca || '')}" required>`)}
      ${field('modelo', 'Modelo', `<input name="modelo" value="${esc(e.modelo || '')}" required>`)}
      ${field('orgao', 'Órgão responsável', `<select name="orgao">${m.orgaos.map(o => opt(o, o, o === e.orgao)).join('')}</select>`)}
      ${field('dataInstalacao', 'Data de instalação', `<input type="date" name="dataInstalacao" value="${esc(e.dataInstalacao || '')}">`)}
    </div></fieldset>
    <fieldset><legend>Localização ${'<span class="muted" id="loc-hint"></span>'}</legend><div class="form-grid">
      ${field('localizacao.cep', 'CEP <span class="muted">(busca automática)</span>', `<input name="localizacao.cep" value="${esc(L2.cep || '')}" placeholder="19010-000">`)}
      ${field('localizacao.rua', 'Rua / avenida / rodovia', `<input name="localizacao.rua" value="${esc(L2.rua || '')}">`)}
      ${field('localizacao.referencia', 'Referência', `<input name="localizacao.referencia" value="${esc(L2.referencia || '')}" placeholder='"número 181", "KM 203", "S/N"…' list="refs"><datalist id="refs"><option>S/N</option><option>número </option><option>oposto ao número </option><option>KM </option><option>em frente ao </option></datalist>`)}
      ${field('localizacao.bairro', 'Bairro', `<select name="localizacao.bairro">${m.bairros.map(b => opt(b.nome, `${b.nome} (${b.regiao})`, b.nome === L2.bairro)).join('')}</select>`)}
      ${field('localizacao.cidade', 'Cidade', `<input name="localizacao.cidade" value="${esc(L2.cidade || '')}">`)}
      ${field('localizacao.uf', 'UF', `<input name="localizacao.uf" value="${esc(L2.uf || '')}" maxlength="2">`)}
      ${field('localizacao.lat', 'Latitude', `<input name="localizacao.lat" type="number" step="0.000001" value="${L2.lat ?? ''}">`)}
      ${field('localizacao.lng', 'Longitude', `<input name="localizacao.lng" type="number" step="0.000001" value="${L2.lng ?? ''}">`)}
    </div><div class="muted small">Clique no mapa para definir as coordenadas GPS${m.tiposEquipamento[e.tipo].movel ? ' da base' : ''}.</div><div id="pick-map"></div></fieldset>
    <fieldset><legend>Situação e manutenção</legend><div class="form-grid">
      ${field('situacao', 'Situação atual', `<select name="situacao">${Object.entries(m.situacoes).map(([k, v]) => opt(k, v.label, k === e.situacao)).join('')}</select>`)}
      ${field('manutencao.tipo', 'Necessidade de manutenção', `<select name="manutencao.tipo">${Object.entries(m.manutencao).map(([k, v]) => opt(k, v, k === e.manutencao.tipo)).join('')}</select>`)}
      ${field('manutencao.ultimaData', 'Última manutenção', `<input type="date" name="manutencao.ultimaData" value="${esc(e.manutencao.ultimaData || '')}">`)}
      ${field('manutencao.proximaData', 'Próxima manutenção', `<input type="date" name="manutencao.proximaData" value="${esc(e.manutencao.proximaData || '')}">`)}
      ${field('manutencao.periodicidadeDias', 'Periodicidade (dias)', `<input type="number" name="manutencao.periodicidadeDias" value="${esc(e.manutencao.periodicidadeDias || '')}">`)}
    </div></fieldset>
    <fieldset><legend>Outras características</legend><div class="form-grid" id="carac"></div></fieldset>
    <div class="form-actions"><button type="button" class="btn ghost" id="f-cancel">Cancelar</button><button class="btn primary" type="submit">${isNew ? 'Cadastrar' : 'Salvar alterações'}</button></div>`);

  const form = $('#modal-form');
  const renderCarac = () => {
    const tipo = form.tipo.value, def = m.tiposEquipamento[tipo];
    const cur = {}; $$('#carac [name]').forEach(i => cur[i.name.slice(16)] = i.type === 'checkbox' ? i.checked : i.value);
    const vals = { ...(tipo === e.tipo ? e.caracteristicas : {}), ...cur };
    $('#carac').innerHTML = def.fields.map(f => {
      const n = `caracteristicas.${f.key}`, v = vals[f.key];
      const show = !f.showIf || Object.entries(f.showIf).every(([k, x]) => (vals[k] ?? def.fields.find(z => z.key === k)?.options?.[0]) === x);
      const wrap = inner => `<div data-show="${f.key}" ${show ? '' : 'class="hidden"'}>${inner}</div>`;
      if (f.type === 'boolean') return wrap(`<label class="inline"><input type="checkbox" name="${n}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`);
      if (f.type === 'select') return wrap(field(n, f.label + (f.required ? ' *' : ''), `<select name="${n}">${f.options.map(o => opt(o, o.replace(/_/g, ' '), o === v)).join('')}</select>`));
      return wrap(field(n, f.label, `<input name="${n}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(v ?? '')}" ${f.min != null ? `min="${f.min}" max="${f.max}"` : ''}>`));
    }).join('');
    $$('#carac select').forEach(s => s.addEventListener('change', renderCarac));
  };
  renderCarac();
  form.tipo.addEventListener('change', () => {
    const def = m.tiposEquipamento[form.tipo.value];
    form.orgao.value = def.orgao; form['manutencao.periodicidadeDias'].value = def.periodicidadeDias; renderCarac();
  });
  // mapa para escolher coordenadas
  setTimeout(() => {
    const start = [Number(form['localizacao.lat'].value) || -22.1225, Number(form['localizacao.lng'].value) || -51.3925];
    S.pickMap = L.map('pick-map').setView(start, 14);
    L.tileLayer(TILE, { attribution: TILE_ATTR }).addTo(S.pickMap);
    const mk = L.marker(start, { draggable: true }).addTo(S.pickMap);
    const set = ll => { form['localizacao.lat'].value = ll.lat.toFixed(6); form['localizacao.lng'].value = ll.lng.toFixed(6); mk.setLatLng(ll); };
    S.pickMap.on('click', ev => set(ev.latlng)); mk.on('dragend', () => set(mk.getLatLng()));
    S.pickMk = mk;
  }, 60);
  // busca de CEP (ViaCEP)
  form['localizacao.cep'].addEventListener('blur', async () => {
    const cep = form['localizacao.cep'].value.replace(/\D/g, '');
    if (cep.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then(x => x.json());
      if (r.erro) { $('#loc-hint').textContent = ' · CEP não encontrado'; return; }
      if (r.logradouro) form['localizacao.rua'].value = r.logradouro;
      form['localizacao.cidade'].value = r.localidade; form['localizacao.uf'].value = r.uf;
      const b = m.bairros.find(x => x.nome.toLowerCase() === (r.bairro || '').toLowerCase());
      if (b) { form['localizacao.bairro'].value = b.nome; S.pickMap?.setView([b.lat, b.lng], 15); }
      $('#loc-hint').textContent = ` · endereço preenchido pelo CEP (${r.bairro || 'bairro não informado'})`;
    } catch { $('#loc-hint').textContent = ' · não foi possível consultar o CEP agora'; }
  });
  form['localizacao.bairro'].addEventListener('change', () => { const b = m.bairros.find(x => x.nome === form['localizacao.bairro'].value); if (b && S.pickMap) { S.pickMap.setView([b.lat, b.lng], 15); } });
  $('#f-cancel').addEventListener('click', closeModal);
  form.onsubmit = async ev => {
    ev.preventDefault();
    const body = formToObject(form);
    try {
      const saved = await api(isNew ? '/api/equipments' : `/api/equipments/${e.id}`, { method: isNew ? 'POST' : 'PUT', body });
      S.eq.set(saved.id, { ...S.eq.get(saved.id), ...saved });
      if (S.eqMk.has(saved.id)) { S.lg.equipamentos.removeLayer(S.eqMk.get(saved.id)); S.eqMk.delete(saved.id); }
      renderMarkers(); renderEqTable(); refreshDashboard(); closeModal();
      toast(`${isNew ? 'Cadastrado' : 'Atualizado'}: <b>${esc(saved.id)}</b>`, '#22a06b');
      if (!isNew && S.drawerId === saved.id) openEquipment(saved.id);
    } catch (err) { showErrors(form, err); }
  };
}

function agentForm(a) {
  const m = S.meta, isNew = !a;
  a = a || { tipo: 'agente_transito', situacao: 'em_patrulha', turno: 'manha', bairroBase: 'Centro', orgao: 'SEMOB' };
  const vehicles = [...S.eq.values()].filter(e => ['moto_agente', 'viatura'].includes(e.tipo));
  openModal(isNew ? 'Novo agente' : `Editar ${a.nome}`, `<fieldset><legend>Dados do agente</legend><div class="form-grid">
    ${field('nome', 'Nome completo', `<input name="nome" value="${esc(a.nome || '')}">`)}
    ${field('matricula', 'Matrícula', `<input name="matricula" value="${esc(a.matricula || '')}" inputmode="numeric">`)}
    ${field('tipo', 'Tipo', `<select name="tipo">${Object.entries(m.tiposAgente).map(([k, v]) => opt(k, `${v.icon} ${v.label}`, k === a.tipo)).join('')}</select>`)}
    ${field('orgao', 'Órgão', `<select name="orgao">${m.orgaos.map(o => opt(o, o, o === a.orgao)).join('')}</select>`)}
    ${field('turno', 'Turno', `<select name="turno">${[['manha', 'Manhã (06–14h)'], ['tarde', 'Tarde (14–22h)'], ['noite', 'Noite (22–06h)']].map(([k, l]) => opt(k, l, k === a.turno)).join('')}</select>`)}
    ${field('situacao', 'Situação', `<select name="situacao">${Object.entries(m.situacoesAgente).map(([k, v]) => opt(k, v.label, k === a.situacao)).join('')}</select>`)}
    ${field('bairroBase', 'Bairro-base', `<select name="bairroBase">${m.bairros.map(b => opt(b.nome, `${b.nome} (${b.regiao})`, b.nome === a.bairroBase)).join('')}</select>`)}
    ${field('equipamentoId', 'Veículo vinculado', `<select name="equipamentoId"><option value="">—</option>${vehicles.map(v => opt(v.id, `${m.tiposEquipamento[v.tipo].icon} ${v.id} ${v.caracteristicas.placa || ''}`, v.id === a.equipamentoId)).join('')}</select>`)}
    </div></fieldset><div class="form-actions"><button type="button" class="btn ghost" id="f-cancel">Cancelar</button><button class="btn primary" type="submit">${isNew ? 'Cadastrar' : 'Salvar'}</button></div>`);
  const form = $('#modal-form');
  form.tipo.addEventListener('change', () => { form.orgao.value = m.tiposAgente[form.tipo.value].orgao; });
  $('#f-cancel').addEventListener('click', closeModal);
  form.onsubmit = async ev => {
    ev.preventDefault();
    const body = formToObject(form);
    if (!isNew) body.posicao = a.posicao;
    try {
      const saved = await api(isNew ? '/api/agents' : `/api/agents/${a.id}`, { method: isNew ? 'POST' : 'PUT', body });
      S.ag.set(saved.id, saved);
      if (S.agMk.has(saved.id)) { S.lg.agentes.removeLayer(S.agMk.get(saved.id)); S.agMk.delete(saved.id); }
      renderMarkers(); renderAgTable(); closeModal(); toast(`Agente <b>${esc(saved.nome)}</b> salvo.`, '#22a06b');
    } catch (err) { showErrors(form, err); }
  };
}

function formToObject(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    const parts = el.name.split('.');
    let o = out; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts.at(-1)] = v;
  }
  return out;
}
function showErrors(form, err) {
  $$('[data-err]', form).forEach(x => x.textContent = ''); $$('.invalid', form).forEach(x => x.classList.remove('invalid'));
  const det = err.data && err.data.detalhes;
  if (!det) { toast(esc(err.message), '#e5484d'); return; }
  for (const d of det) {
    const span = $(`[data-err="${d.campo}"]`, form); if (span) span.textContent = d.erro;
    const inp = form.elements[d.campo]; if (inp && inp.classList) inp.classList.add('invalid');
  }
  toast(`Verifique ${det.length} campo(s) destacado(s).`, '#e5484d');
  const first = $('.invalid', form); if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ======================================================================= */
/* Cidade Preditiva                                                         */
/* ======================================================================= */
async function loadPredictions() {
  try { S.pred = await api('/api/predictions'); } catch (e) { toast('Falha ao carregar previsões', '#e5484d'); return; }
  renderPredictions();
  clearTimeout(S.predTimer);
  S.predTimer = setTimeout(() => { if (S.view === 'preditiva') loadPredictions(); }, 60000);
}

function renderPredictions() {
  const p = S.pred;
  $('#pred-time').textContent = `atualizado às ${fmtTime(p.geradoEm)}`;
  const v = p.risco.validacao, fm = p.falhas.metricas;
  $('#pred-metrics').innerHTML = `
    <div><b>${p.risco.ocorrenciasNoHistorico}</b><span>ocorrências no histórico (${p.risco.semanasDeHistorico} semanas)</span></div>
    <div><b>${v ? (v.ganhoDeviance > 0 ? '+' : '') + v.ganhoDeviance + '%' : '—'}</b><span>ganho do modelo de risco vs. baseline (fora da amostra)</span></div>
    <div><b>${fm.aucTeste ?? '—'}</b><span>AUC do modelo de falhas (6 semanas de teste)</span></div>
    <div><b>${p.disponibilidade.inclinacaoPorDia > 0 ? '+' : ''}${p.disponibilidade.inclinacaoPorDia} p.p./dia</b><span>tendência da disponibilidade</span></div>`;
  const PC = { alta: '#e5484d', media: '#f5a524', baixa: '#3b82f6' };
  $('#recs').innerHTML = p.recomendacoes.map(r => `<li style="--c:${PC[r.prioridade]}"><small>${esc(r.categoria)} · prioridade ${r.prioridade}</small>${esc(r.texto)}</li>`).join('') || '<li class="muted">Nenhuma ação recomendada no momento.</li>';
  for (const [k, ex] of Object.entries(p.explicacoes)) {
    const el = $(`#ex-${k}`); if (el) el.innerHTML = `<div><b>O que é previsto</b>${esc(ex.oQue)}</div><div><b>Dados considerados</b>${esc(ex.dados)}</div><div><b>Como</b>${esc(ex.como)}</div><div><b>Como ajuda a decidir</b>${esc(ex.ajuda)}</div>`;
  }
  renderRiskTable(); renderRiskMap(); renderReinforcement(); renderFailures(); renderAvailability(); renderAnomalies(); loadHeatmap();
  $('#risk-validation').innerHTML = v ? `Validação fora da amostra (${esc(v.periodoTeste)}, ${v.blocosAvaliados} blocos de 4 h × bairro, ${v.ocorrenciasNoTeste} ocorrências): erro absoluto médio ${v.maeModelo} vs. ${v.maeBaseline} do baseline; deviance de Poisson ${v.devianceModelo} vs. ${v.devianceBaseline} (${v.ganhoDeviance > 0 ? 'melhor' : 'pior'} em ${Math.abs(v.ganhoDeviance)}%).` : '';
}

const riskColor = i => i >= 90 ? '#ff2d55' : i >= 75 ? '#e5484d' : i >= 50 ? '#f5a524' : '#22a06b';
function renderRiskTable() {
  $('#t-risk tbody').innerHTML = S.pred.risco.bairros.map(b => {
    const tr = b.tendencia;
    const arrow = tr.fator >= 1.1 ? `<span style="color:#e5484d">▲ ${Math.round((tr.fator - 1) * 100)}%</span>` : tr.fator <= 0.9 ? `<span style="color:#22a06b">▼ ${Math.round((1 - tr.fator) * 100)}%</span>` : '<span class="muted">estável</span>';
    return `<tr><td>${esc(b.bairro)}<br><span class="muted">${esc(b.regiao)}</span></td>
      <td><div class="bar" style="--c:${riskColor(b.indiceAtual)}"><i style="width:${b.indiceAtual}%"></i></div><span class="muted">${b.indiceAtual} · ${b.nivelAtual}</span></td>
      <td>${b.ocorrenciasEsperadas24h}</td><td>${pct(b.probAoMenosUmaProx4h)}</td>
      <td>${String(new Date(b.pico.hora).getHours()).padStart(2, '0')}h <span class="muted">(${b.pico.indice})</span></td><td>${arrow}${tr.significativa ? ' <span class="muted" title="variação estatisticamente significativa">*</span>' : ''}</td></tr>`;
  }).join('');
}

function renderRiskMap() {
  if (!S.riskMap) {
    S.riskMap = L.map('risk-map', { scrollWheelZoom: false }).setView([-22.127, -51.4], 13);
    L.tileLayer(TILE, { attribution: TILE_ATTR }).addTo(S.riskMap);
    S.riskLayer = L.layerGroup().addTo(S.riskMap);
    $('#risk-hour').addEventListener('input', drawRisk);
  }
  setTimeout(() => S.riskMap.invalidateSize(), 50);
  drawRisk();
}
function drawRisk() {
  const k = Number($('#risk-hour').value);
  const first = S.pred.risco.bairros[0].horas[k];
  const h = new Date(first.hora);
  $('#risk-hour-label').textContent = k === 0 ? `agora (${String(h.getHours()).padStart(2, '0')}h)` : `${String(h.getHours()).padStart(2, '0')}h ${h.getDate() !== new Date().getDate() ? '(amanhã)' : ''}`;
  S.riskLayer.clearLayers();
  for (const b of S.pred.risco.bairros) {
    const x = b.horas[k];
    L.circle([b.lat, b.lng], { radius: 220 + x.indice * 3.6, color: riskColor(x.indice), fillColor: riskColor(x.indice), fillOpacity: 0.35, weight: 1 })
      .bindTooltip(`<b>${esc(b.bairro)}</b><br>Índice ${x.indice}/100 (${x.nivel})<br>Prob. de ocorrência nesta hora: ${pct(x.probabilidade)}<br>Esperadas em 24 h: ${b.ocorrenciasEsperadas24h}`, { sticky: true })
      .addTo(S.riskLayer);
  }
}

async function loadHeatmap() {
  const sel = $('#hm-bairro');
  if (!sel.dataset.init) {
    sel.innerHTML += S.meta.bairros.map(b => `<option>${esc(b.nome)}</option>`).join('');
    sel.addEventListener('change', loadHeatmap); sel.dataset.init = '1';
  }
  const hm = await api('/api/predictions/heatmap' + (sel.value ? `?bairro=${encodeURIComponent(sel.value)}` : ''));
  const max = Math.max(...hm.grid.flat());
  let html = '<div></div>' + Array.from({ length: 24 }, (_, h) => `<div class="lbl">${h}</div>`).join('');
  hm.grid.forEach((row, d) => {
    html += `<div class="lbl">${hm.dias[d]}</div>` + row.map((v, h) => {
      const t = v / max;
      const c = `rgba(${Math.round(59 + t * 196)}, ${Math.round(130 - t * 85)}, ${Math.round(246 - t * 161)}, ${0.15 + t * 0.85})`;
      return `<div class="c" style="background:${c}" title="${hm.dias[d]} ${h}h: ${v.toFixed(3)} ocorrências/h"></div>`;
    }).join('');
  });
  $('#heatmap').innerHTML = html;
}

function renderReinforcement() {
  $('#reinf').innerHTML = S.pred.reforco.map(j => `<div class="window"><h4>${fmtTime(j.inicio)} – ${fmtTime(j.fim)}</h4>
    <table><tr><th>Região</th><th>Esperadas</th><th>Necessários</th><th>Disponíveis</th><th>Saldo</th></tr>
    ${j.regioes.map(r => `<tr><td>${esc(r.regiao)}</td><td>${r.ocorrenciasEsperadas}</td><td>${r.agentesNecessarios}</td><td>${r.agentesDisponiveis}</td><td style="color:${r.saldo < 0 ? '#e5484d' : '#22a06b'};font-weight:600">${r.saldo > 0 ? '+' : ''}${r.saldo}</td></tr>`).join('')}</table>
    ${j.recomendacoes.map(r => `<div class="rec">➜ ${r.de ? `Mover ${r.agentes} de ${esc(r.de)} para ${esc(r.para)}` : `${esc(r.para)}: convocar ${r.agentes} reforço(s)`}</div>`).join('') || '<div class="rec" style="color:#22a06b">✓ Efetivo suficiente em todas as regiões</div>'}</div>`).join('');
}

function renderFailures() {
  const T = S.meta.tiposEquipamento, f = S.pred.falhas;
  $('#t-fail tbody').innerHTML = f.equipamentos.map(e => `<tr class="click" data-eq="${e.id}"><td>${T[e.tipo].icon} ${e.id}<br><span class="muted">${esc(T[e.tipo].label)}</span></td><td>${esc(e.bairro)}</td>
    <td><span class="status lvl-${e.nivel}">${pct(e.prob7d)}</span></td><td>${pct(e.prob30d)}</td><td class="muted">${e.motivos.map(esc).join('; ') || '—'}</td></tr>`).join('');
  $$('#t-fail tr[data-eq]').forEach(tr => tr.addEventListener('click', () => openEquipment(tr.dataset.eq)));
  const m = f.metricas;
  const NAMES = { razaoCicloManutencao: '% do ciclo de manutenção consumido', idadeAnos: 'idade (anos)', falhas180d: 'falhas nos últimos 180 dias', movel: 'equipamento móvel' };
  $('#fail-model').innerHTML = `<b>Regressão logística</b> treinada com ${m.amostras.toLocaleString('pt-BR')} semanas-equipamento (taxa base de falha: ${pct(m.taxaBaseSemanal)} por semana).<br>
    <span class="big">AUC ${m.aucTeste}</span> <span class="muted">nas 6 semanas mais recentes (não vistas no treino) · regra só por calendário de manutenção: AUC ${m.aucBaseline}</span>
    <div class="section-title">Peso de cada fator (padronizado)</div>
    ${f.coeficientes.map(c => `<div style="display:flex;gap:8px;align-items:center;font-size:12px;margin:3px 0"><span style="width:200px">${NAMES[c.variavel] || c.variavel}</span><div class="bar" style="flex:1;--c:${c.pesoPadronizado >= 0 ? '#e5484d' : '#22a06b'}"><i style="width:${Math.min(100, Math.abs(c.pesoPadronizado) * 100)}%"></i></div><span>${c.pesoPadronizado > 0 ? '+' : ''}${c.pesoPadronizado}</span></div>`).join('')}`;
  const d = { labels: f.distribuicao.map(x => x.nivel), datasets: [{ data: f.distribuicao.map(x => x.qtd), backgroundColor: ['#ff2d55', '#e5484d', '#f5a524', '#22a06b'], borderRadius: 4 }] };
  if (!S.chFail) S.chFail = new Chart($('#ch-fail'), { type: 'bar', data: d, options: { maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: 'Equipamentos operacionais por nível de risco (7 dias)' } } } });
  else { S.chFail.data = d; S.chFail.update(); }
}

function renderAvailability() {
  const t = S.pred.disponibilidade;
  const labels = [...t.historico.map(x => x.data), ...t.projecao.map(x => x.data)].map(fmtDate).map(s => s.slice(0, 5));
  const n = t.historico.length;
  const hist = [...t.historico.map(x => x.disponibilidade), ...Array(t.projecao.length).fill(null)];
  const proj = [...Array(n - 1).fill(null), t.historico[n - 1].disponibilidade, ...t.projecao.map(x => x.valor)];
  const lo = [...Array(n).fill(null), ...t.projecao.map(x => x.min)];
  const hi = [...Array(n).fill(null), ...t.projecao.map(x => x.max)];
  const meta = labels.map(() => t.meta);
  const data = { labels, datasets: [
    { label: 'Disponibilidade real (%)', data: hist, borderColor: '#3b82f6', backgroundColor: '#3b82f6', tension: 0.25, pointRadius: 2 },
    { label: 'Projeção', data: proj, borderColor: '#ff7a1a', borderDash: [6, 4], pointRadius: 0 },
    { label: 'IC 95% (sup.)', data: hi, borderColor: 'transparent', backgroundColor: 'rgba(255,122,26,.15)', fill: '+1', pointRadius: 0 },
    { label: 'IC 95% (inf.)', data: lo, borderColor: 'transparent', pointRadius: 0 },
    { label: `Meta (${t.meta}%)`, data: meta, borderColor: '#22a06b', borderDash: [2, 3], pointRadius: 0 },
  ] };
  const opts = { maintainAspectRatio: false, plugins: { legend: { labels: { filter: i => !i.text.startsWith('IC') } } }, scales: { y: { suggestedMin: 75, suggestedMax: 100 } }, animation: { duration: 300 } };
  if (!S.chAvail) S.chAvail = new Chart($('#ch-avail'), { type: 'line', data, options: opts }); else { S.chAvail.data = data; S.chAvail.update(); }
  $('#avail-card').innerHTML = `<b>Regressão linear (últimos 30 dias)</b><div class="big" style="color:${t.inclinacaoPorDia < 0 ? '#e5484d' : '#22a06b'}">${t.inclinacaoPorDia > 0 ? '+' : ''}${t.inclinacaoPorDia} p.p./dia</div>
    <div class="muted">Média do período: ${t.mediaPeriodo}% · R² = ${t.r2}</div>
    <p>${t.cruzaMeta ? (t.cruzaMeta === 'já abaixo da meta' ? `⚠️ A disponibilidade <b>já está abaixo</b> da meta de ${t.meta}%.` : `⚠️ Mantido o ritmo atual, a meta de ${t.meta}% será violada em <b>${fmtDate(t.cruzaMeta)}</b>.`) : '✓ Tendência estável ou de alta.'}</p>
    <p class="muted">Em ${fmtDate(t.projecao.at(-1).data)}: ${t.projecao.at(-1).valor}% (entre ${t.projecao.at(-1).min}% e ${t.projecao.at(-1).max}%).</p>`;
}

function renderAnomalies() {
  const T = S.meta.tiposEquipamento;
  $('#t-anom tbody').innerHTML = S.pred.anomalias.map(a => `<tr class="click" data-eq="${a.equipamentoId}"><td>${fmtDateTime(a.em)}</td><td>${T[a.tipo].icon} ${a.equipamentoId}</td><td>${esc(a.bairro)}</td><td>${esc(TELE_LABEL[a.metrica] || a.metrica)}</td><td>${a.valor}</td><td>${a.esperado}</td><td>${a.z}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nenhuma anomalia detectada ainda — o detector precisa de alguns minutos de telemetria para calibrar. Use “Simular evento → Sensor de radar travado”.</td></tr>';
  $$('#t-anom tr[data-eq]').forEach(tr => tr.addEventListener('click', () => openEquipment(tr.dataset.eq)));
}

$$('[data-explain]').forEach(b => b.addEventListener('click', () => $(`#ex-${b.dataset.explain}`).classList.toggle('hidden')));

/* ======================================================================= */
/* Sobre                                                                    */
/* ======================================================================= */
function renderAbout() {
  $('#about').innerHTML = `
  <h2>🔥 F.O.G.O. — Ferramenta Onisciente de Gestão e Operações</h2>
  <p>Solução para o Desafio Bônus do DSIN Coder Challenge 2026. Cobre as três partes do desafio em um único sistema web que roda com <code>node server.js</code>, sem banco de dados externo e sem dependências de npm.</p>
  <h3>1ª parte — Inventário inteligente</h3>
  <ul>
    <li>Cadastro de <b>11 tipos de equipamento</b> (radares, câmeras, balanças, veículos autônomos do rotativo, cancelas, táxis/mototáxis/escolares, totens, patinetes, motos de agentes, viaturas GM/PM e semáforos inteligentes) e de <b>agentes</b> (trânsito, guarda municipal, PM).</li>
    <li>Número de série, marca, modelo, localização completa (CEP com busca automática no ViaCEP, rua, referência livre — "KM 203", "oposto ao número 181", "S/N"… — bairro, cidade/UF e GPS escolhido no mapa), situação, necessidade de manutenção e datas.</li>
    <li><b>Características específicas por tipo</b> definidas em um catálogo único (<code>src/catalog.js</code>): o formulário é gerado a partir dele e o servidor valida com ele. Campos condicionais (ex.: velocidade máxima só aparece em radar de velocidade).</li>
  </ul>
  <h3>2ª parte — Central de Operações</h3>
  <ul>
    <li>Mapa em tempo real (Server-Sent Events) com ícones por tipo e cor por situação; agentes e veículos se movem; ocorrências são despachadas automaticamente ao agente livre mais próximo.</li>
    <li>Indicadores, filtros (tipo, situação, região, bairro, órgão, busca, manutenção), destaque de manutenção imediata/próxima, alertas classificados por criticidade com reconhecimento, detalhes de qualquer item pelo mapa.</li>
    <li>"Saúde" de cada bairro e região (0–100) combinando disponibilidade, ocorrências abertas, alertas graves, efetivo e risco previsto — responde de relance onde a cidade precisa de atenção.</li>
    <li>Menu <b>⚡ Simular evento</b> para demonstrar a reação do sistema (acidente grave, apagão, furto, sensor travado).</li>
  </ul>
  <h3>3ª parte — Cidade preditiva</h3>
  <ul>
    <li><b>Risco de ocorrências</b> por bairro e hora (Poisson hierárquico com Bayes empírico + tendência), validado fora da amostra contra um baseline.</li>
    <li><b>Reforço de efetivo</b> por região nas próximas 12 h, com recomendação de remanejamento.</li>
    <li><b>Risco de falha</b> de cada equipamento (regressão logística implementada do zero, validação temporal com AUC).</li>
    <li><b>Detecção de anomalias</b> de telemetria (EWMA + z-score) e <b>projeção de disponibilidade</b> com intervalo de confiança.</li>
    <li>Cada previsão explica o que prevê, os dados usados, o método e como apoia a decisão (botões "como funciona?").</li>
  </ul>
  <h3>Sobre os dados</h3>
  <p>Na ausência de dados reais, o sistema gera uma Presidente Prudente sintética (coordenadas aproximadas) com 120 dias de histórico. O gerador usa padrões plausíveis (picos de rush, sexta à noite, chuva, bairros em crescimento); o motor preditivo <b>não lê esses parâmetros</b> — precisa redescobri-los a partir dos dados, como faria com dados reais. O simulador IoT pode ser trocado por ingestão real (MQTT/HTTP) sem alterar o restante.</p>
  <h3>Uso de IA</h3>
  <p>Autor: <b>Leandro da Silva Stampini</b>. Desenvolvido com auxílio do Claude (Anthropic).</p>`;
}

init().catch(e => { console.error(e); toast('Erro ao iniciar: ' + esc(e.message), '#e5484d'); });
