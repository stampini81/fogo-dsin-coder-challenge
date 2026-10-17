'use strict';
// Simulador de telemetria IoT + operação de campo em tempo real.
// Em produção, este módulo seria substituído pela ingestão real (MQTT/HTTP) dos dispositivos;
// a interface com o resto do sistema (eventos emitidos) permaneceria a mesma.
const { EventEmitter } = require('events');
const { BAIRROS, bairroByName, distance, nearestBairro } = require('./geo');
const { EQUIPMENT_TYPES, INCIDENT_TYPES, SEVERITY } = require('./catalog');
const { rng, HOUR_PROFILE, WEEKDAY_FACTOR, NIGHT_BONUS, DAY, round, clamp } = require('./util');
const { shiftCovers } = require('./predict');

const TICK_MS = Number(process.env.FOGO_TICK_MS || 2000);
const SPEED = Number(process.env.FOGO_SIM_SPEED || 60); // multiplicador da taxa de eventos para a demonstração

class Simulator extends EventEmitter {
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.r = rng(opts.seed || Date.now() % 100000);
    this.telemetry = new Map();   // id -> { metricas, lastSeen }
    this.stats = new Map();       // id|metric -> { mean, var, n }
    this.anomalies = [];          // histórico recente de anomalias
    this.timer = null;
    this.tickCount = 0;
  }

  get data() { return this.store.data; }

  start() {
    if (this.timer) return;
    this.syncShifts();
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error('[sim]', e); } }, TICK_MS);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // agentes fora do turno ficam "fora de serviço"; quem entra no turno passa a patrulhar
  syncShifts(now = new Date()) {
    const h = now.getHours();
    for (const a of this.data.agents) {
      const on = shiftCovers(a.turno, h);
      if (!on && a.situacao !== 'fora_de_servico' && a.situacao !== 'em_ocorrencia') a.situacao = 'fora_de_servico';
      if (on && a.situacao === 'fora_de_servico' && !a._manual) a.situacao = 'em_patrulha';
    }
  }

  tick(now = new Date()) {
    this.tickCount++;
    const changed = { equipments: [], agents: [] };
    if (this.tickCount % 15 === 0) this.syncShifts(now);
    this.updateTelemetry(now, changed);
    this.statusTransitions(now, changed);
    this.generateIncidents(now);
    this.progressIncidents(now, changed);
    this.moveUnits(now, changed);
    if (this.tickCount % 30 === 1) this.maintenanceAlerts(now);
    this.emit('tick', {
      em: now.toISOString(),
      equipments: [...new Set(changed.equipments)].map(id => this.slimEq(this.store.get('equipments', id))).filter(Boolean),
      agents: [...new Set(changed.agents)].map(id => this.slimAgent(this.store.get('agents', id))).filter(Boolean),
    });
  }

  slimEq(e) { if (!e) return null; const t = this.telemetry.get(e.id); return { id: e.id, situacao: e.situacao, posicao: e.posicao || null, telemetria: t ? t.metricas : null }; }
  slimAgent(a) { return a && { id: a.id, situacao: a.situacao, posicao: a.posicao, ocorrenciaId: a.ocorrenciaId || null }; }

  /* ---------------- telemetria + detecção de anomalias (EWMA z-score) ---------------- */
  updateTelemetry(now, changed) {
    const h = now.getHours() + now.getMinutes() / 60;
    const prof = HOUR_PROFILE[Math.floor(h)];
    const r = this.r;
    // atualiza um subconjunto a cada tick para manter leve
    const eqs = this.data.equipments.filter(e => e.situacao === 'operacional');
    const batch = eqs.filter(() => r() < 0.35);
    for (const e of batch) {
      const prev = this.telemetry.get(e.id) || { metricas: {}, lastSeen: null };
      const m = { ...prev.metricas };
      const inject = r() < 0.0008; // injeção rara de defeito para demonstrar a detecção
      switch (e.tipo) {
        case 'radar': {
          const vmax = e.caracteristicas.velocidadeMaxima || 60;
          m.fluxoVeiculosMin = Math.max(0, round(prof * 9 * (e.caracteristicas.faixas || 2) * (1 + 0.12 * r.normal()), 1));
          m.velocidadeMedia = round(vmax * (0.82 + 0.06 * r.normal()) * (prof > 1.6 ? 0.75 : 1), 1);
          if (inject) m.fluxoVeiculosMin = r() < 0.5 ? 0 : m.fluxoVeiculosMin * 4;
          break;
        }
        case 'camera':
          m.fps = round(clamp(28 + 1.2 * r.normal(), 0, 30), 1);
          m.latenciaMs = Math.round(clamp(110 + 15 * r.normal(), 20, 5000));
          if (inject) { m.fps = round(4 + 3 * r(), 1); m.latenciaMs = 1800; }
          break;
        case 'balanca':
          m.pesagensHora = Math.round(Math.max(0, prof * 18 + 3 * r.normal()));
          m.excessoPeso = Math.round(Math.max(0, m.pesagensHora * 0.06 + r.normal()));
          if (inject) m.excessoPeso = m.pesagensHora;
          break;
        case 'patinete':
          m.bateria = round(clamp((m.bateria ?? 60 + 40 * r()) - 0.15 - (prof > 1 ? 0.2 : 0) + (m.bateria < 12 ? 40 : 0), 0, 100), 1);
          if (inject) m.bateria = 0;
          break;
        case 'totem_rotativo':
          m.transacoesHora = Math.round(Math.max(0, prof * 7 + 2 * r.normal()));
          m.papelPct = round(clamp((m.papelPct ?? 50 + 50 * r()) - 0.05, 0, 100), 1);
          break;
        case 'semaforo':
          m.cicloSeg = Math.round(90 + 8 * r.normal());
          m.tensaoV = round(127 + 2.5 * r.normal(), 1);
          if (inject) m.tensaoV = round(85 + 10 * r(), 1);
          break;
        case 'cancela':
          m.aberturasHora = Math.round(Math.max(0, prof * 25 + 4 * r.normal()));
          break;
        default:
          m.velocidadeKmh = Math.round(Math.max(0, 25 + 12 * r.normal()));
      }
      this.telemetry.set(e.id, { metricas: m, lastSeen: now.toISOString() });
      this.checkAnomaly(e, m, now, prof);
      changed.equipments.push(e.id);
    }
  }

  checkAnomaly(e, m, now, prof, force = false) {
    // métricas comparadas com a expectativa da hora (dessazonalização) antes do EWMA
    const watch = { radar: ['fluxoVeiculosMin'], camera: ['fps', 'latenciaMs'], balanca: ['excessoPeso'], semaforo: ['tensaoV'], patinete: ['bateria'] }[e.tipo];
    if (!watch) return;
    for (const k of watch) {
      let v = m[k];
      if (v == null) continue;
      if (k === 'fluxoVeiculosMin') v = v / Math.max(0.2, prof);
      if (k === 'excessoPeso') v = m.pesagensHora ? v / m.pesagensHora : 0;
      const key = `${e.id}|${k}`;
      const s = this.stats.get(key) || { mean: v, var: 0, n: 0 };
      const sd = Math.sqrt(s.var) || 1e-6;
      const z = (v - s.mean) / Math.max(sd, Math.abs(s.mean) * 0.1, 0.5);
      const special = k === 'bateria' && v <= 1;
      if (((s.n > 25 || force) && Math.abs(z) > 3.5) || special) {
        const a = {
          id: `AN-${Date.now()}-${Math.floor(this.r() * 1e4)}`, equipamentoId: e.id, tipo: e.tipo, metrica: k, valor: m[k],
          esperado: round(k === 'fluxoVeiculosMin' ? s.mean * prof : k === 'excessoPeso' ? s.mean * (m.pesagensHora || 0) : s.mean, 2),
          z: round(z, 2), bairro: e.localizacao.bairro, em: now.toISOString(),
        };
        this.anomalies.unshift(a);
        this.anomalies.length = Math.min(this.anomalies.length, 200);
        this.emit('anomaly', a);
        this.raise({
          nivel: 'medio', categoria: 'Anomalia de telemetria', equipamentoId: e.id, bairro: e.localizacao.bairro,
          titulo: `${EQUIPMENT_TYPES[e.tipo].label} ${e.id}: ${k} fora do padrão`,
          detalhe: `Valor ${a.valor} (esperado ≈ ${a.esperado}, z = ${a.z}). Possível sensor travado, degradação ou adulteração.`,
          dedupe: `anom|${e.id}|${k}`,
        });
        continue; // não contamina a média com o outlier
      }
      const alpha = 0.08;
      const diff = v - s.mean;
      s.mean += alpha * diff;
      s.var = (1 - alpha) * (s.var + alpha * diff * diff);
      s.n++;
      this.stats.set(key, s);
    }
  }

  /* ---------------- mudanças de situação dos equipamentos ---------------- */
  statusTransitions(now, changed) {
    const r = this.r;
    for (const e of this.data.equipments) {
      const per = e.manutencao.periodicidadeDias || 90;
      const since = e.manutencao.ultimaData ? (now - new Date(e.manutencao.ultimaData)) / DAY : per;
      if (e.situacao === 'operacional') {
        const recentAnom = this.anomalies.some(a => a.equipamentoId === e.id && now - new Date(a.em) < 30 * 60000);
        const p = 0.00002 * SPEED / 60 * (1 + Math.max(0, since / per - 0.7) * 3) * (recentAnom ? 25 : 1);
        if (r() < p) {
          const furto = ['patinete', 'camera', 'totem_rotativo'].includes(e.tipo) && r() < 0.08;
          this.setStatus(e, furto ? 'furtado' : 'mau_funcionamento', now, furto ? 'Equipamento sem sinal e fora da posição — possível furto' : r.pick(['Sem comunicação', 'Falha de energia', 'Leitura inconsistente', 'Falha de hardware']));
          changed.equipments.push(e.id);
        }
      } else if (e.situacao === 'mau_funcionamento' && r() < 0.004) {
        this.setStatus(e, 'em_manutencao', now, 'Equipe técnica despachada');
        changed.equipments.push(e.id);
      } else if (e.situacao === 'em_manutencao' && r() < 0.006) {
        this.setStatus(e, 'operacional', now, 'Manutenção concluída');
        changed.equipments.push(e.id);
      }
    }
  }

  setStatus(e, situacao, now, motivo) {
    const old = e.situacao;
    e.situacao = situacao;
    e.historico = e.historico || [];
    if (situacao === 'mau_funcionamento' || situacao === 'furtado') {
      e.historico.push({ data: now.toISOString(), tipo: 'falha', descricao: motivo });
      e.manutencao.tipo = 'imediata';
      e.manutencao.proximaData = now.toISOString().slice(0, 10);
    }
    if (situacao === 'operacional' && old === 'em_manutencao') {
      e.historico.push({ data: now.toISOString(), tipo: 'manutencao', descricao: 'Manutenção corretiva' });
      e.manutencao.ultimaData = now.toISOString().slice(0, 10);
      e.manutencao.tipo = 'periodica';
      const nx = new Date(now.getTime() + (e.manutencao.periodicidadeDias || 90) * DAY);
      e.manutencao.proximaData = nx.toISOString().slice(0, 10);
    }
    this.store.save();
    const critical = situacao === 'furtado' || (situacao === 'mau_funcionamento' && ['radar', 'camera', 'semaforo'].includes(e.tipo));
    if (situacao === 'mau_funcionamento' || situacao === 'furtado') {
      this.raise({
        nivel: critical ? (situacao === 'furtado' || e.tipo === 'semaforo' ? 'critico' : 'alto') : 'medio',
        categoria: situacao === 'furtado' ? 'Furto' : 'Falha de equipamento', equipamentoId: e.id, bairro: e.localizacao.bairro,
        titulo: `${EQUIPMENT_TYPES[e.tipo].label} ${e.id} — ${situacao === 'furtado' ? 'possível furto' : 'mau funcionamento'}`,
        detalhe: `${motivo}. ${e.localizacao.rua}, ${e.localizacao.referencia} — ${e.localizacao.bairro}.`,
        dedupe: `status|${e.id}`,
      });
    }
    this.emit('equipment', { id: e.id, de: old, para: situacao });
  }

  /* ---------------- ocorrências ao vivo ---------------- */
  generateIncidents(now) {
    const r = this.r;
    const h = now.getHours(), wd = now.getDay();
    const perTickHours = (TICK_MS / 3600000) * SPEED;
    for (const b of BAIRROS) {
      const lambda = 0.034 * b.weight * HOUR_PROFILE[h] * WEEKDAY_FACTOR[wd] * NIGHT_BONUS(wd, h) * perTickHours;
      if (r() < lambda) this.openIncident(b, now);
    }
  }

  openIncident(b, now, forced = {}) {
    const r = this.r;
    const tipos = Object.keys(INCIDENT_TYPES);
    const tipo = forced.tipo || r.pick(['acidente', 'acidente', 'congestionamento', 'congestionamento', 'infracao_grave', 'via_obstruida', 'semaforo_apagado', 'vandalismo']);
    const severidade = forced.severidade || r.pick(['baixa', 'media', 'media', 'alta', 'critica']);
    const lat = forced.lat ?? b.lat + (r() - 0.5) * 0.012, lng = forced.lng ?? b.lng + (r() - 0.5) * 0.012;
    const inc = {
      id: `OC-L${Date.now().toString(36).toUpperCase()}${Math.floor(r() * 100)}`,
      tipo: tipos.includes(tipo) ? tipo : 'acidente', severidade, bairro: b.nome, regiao: b.regiao,
      lat: round(lat, 6), lng: round(lng, 6), inicio: now.toISOString(), status: 'aberta', agentes: [],
      origem: forced.origem || 'sensor',
    };
    this.data.liveIncidents.push(inc);
    this.dispatch(inc, now);
    if (SEVERITY[severidade] >= 3) {
      this.raise({
        nivel: severidade === 'critica' ? 'critico' : 'alto', categoria: 'Ocorrência', ocorrenciaId: inc.id, bairro: b.nome,
        titulo: `${INCIDENT_TYPES[inc.tipo].label} (${severidade}) — ${b.nome}`,
        detalhe: inc.agentes.length ? `Agente(s) despachado(s): ${inc.agentes.join(', ')}` : 'Nenhum agente disponível nas proximidades!',
      });
    }
    this.emit('incident', inc);
    return inc;
  }

  // despacha o(s) agente(s) disponível(is) mais próximo(s)
  dispatch(inc, now) {
    const need = SEVERITY[inc.severidade] >= 3 ? 2 : 1;
    const avail = this.data.agents
      .filter(a => a.situacao === 'em_patrulha' && a.posicao)
      .map(a => ({ a, d: distance([a.posicao.lat, a.posicao.lng], [inc.lat, inc.lng]) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, need);
    for (const { a } of avail) {
      a.situacao = 'em_ocorrencia'; a.ocorrenciaId = inc.id; a.destino = { lat: inc.lat, lng: inc.lng };
      inc.agentes.push(a.id);
    }
    if (avail.length) { inc.status = 'em_atendimento'; inc.atendimentoEm = now.toISOString(); }
  }

  progressIncidents(now, changed) {
    const r = this.r;
    for (const inc of this.data.liveIncidents) {
      if (inc.status === 'aberta' && r() < 0.15) this.dispatch(inc, now);
      if (inc.status === 'em_atendimento') {
        const agents = inc.agentes.map(id => this.store.get('agents', id)).filter(Boolean);
        const arrived = agents.some(a => a.posicao && distance([a.posicao.lat, a.posicao.lng], [inc.lat, inc.lng]) < 60);
        if (arrived && r() < 0.03) {
          inc.status = 'encerrada'; inc.fim = now.toISOString();
          for (const a of agents) { a.situacao = 'em_patrulha'; a.ocorrenciaId = null; a.destino = null; changed.agents.push(a.id); }
          // ocorrência encerrada entra no histórico -> o modelo aprende continuamente
          this.data.incidents.push({ ...inc, agentes: undefined });
          this.emit('incident', inc);
        }
      }
    }
    // mantém só ocorrências abertas e as encerradas na última hora
    this.data.liveIncidents = this.data.liveIncidents.filter(i => i.status !== 'encerrada' || now - new Date(i.fim) < 3600000);
  }

  /* ---------------- movimentação de agentes e equipamentos móveis ---------------- */
  moveUnits(now, changed) {
    const r = this.r;
    const step = (p, target, meters) => {
      const d = distance([p.lat, p.lng], [target.lat, target.lng]);
      if (d < 1) return { lat: target.lat, lng: target.lng };
      const f = Math.min(1, meters / d);
      return { lat: round(p.lat + (target.lat - p.lat) * f, 6), lng: round(p.lng + (target.lng - p.lng) * f, 6) };
    };
    for (const a of this.data.agents) {
      if (!a.posicao || a.situacao === 'fora_de_servico' || a.situacao === 'em_pausa') continue;
      let target = a.destino;
      if (!target) {
        if (!a._wp || r() < 0.03) { const b = bairroByName(a.bairroBase) || BAIRROS[0]; a._wp = { lat: b.lat + (r() - 0.5) * 0.014, lng: b.lng + (r() - 0.5) * 0.014 }; }
        target = a._wp;
      }
      const np = step(a.posicao, target, a.destino ? 220 : 60);
      a.posicao = { ...np, atualizadoEm: now.toISOString() };
      changed.agents.push(a.id);
    }
    for (const e of this.data.equipments) {
      if (!EQUIPMENT_TYPES[e.tipo].movel || e.situacao !== 'operacional') continue;
      const linked = this.data.agents.find(a => a.equipamentoId === e.id && a.situacao !== 'fora_de_servico');
      if (linked) { e.posicao = { lat: linked.posicao.lat, lng: linked.posicao.lng }; changed.equipments.push(e.id); continue; }
      if (e.tipo === 'patinete' && r() > 0.25) continue;
      const base = e.posicao || { lat: e.localizacao.lat, lng: e.localizacao.lng };
      if (!e._wp || r() < 0.04) e._wp = { lat: e.localizacao.lat + (r() - 0.5) * 0.02, lng: e.localizacao.lng + (r() - 0.5) * 0.02 };
      e.posicao = step(base, e._wp, e.tipo === 'patinete' ? 25 : 90);
      changed.equipments.push(e.id);
    }
  }

  maintenanceAlerts(now) {
    const today = now.toISOString().slice(0, 10);
    for (const e of this.data.equipments) {
      const nx = e.manutencao.proximaData;
      if (!nx || e.situacao !== 'operacional') continue;
      const days = (new Date(nx) - new Date(today)) / DAY;
      if (days < 0) this.raise({ nivel: 'medio', categoria: 'Manutenção vencida', equipamentoId: e.id, bairro: e.localizacao.bairro, titulo: `${EQUIPMENT_TYPES[e.tipo].label} ${e.id}: manutenção vencida há ${-days} dia(s)`, detalhe: `Prevista para ${nx}.`, dedupe: `maint|${e.id}` });
    }
  }

  /* ---------------- alertas ---------------- */
  raise(a) {
    const alerts = this.data.alerts;
    if (a.dedupe && alerts.some(x => x.dedupe === a.dedupe && !x.reconhecido)) return null;
    const alert = { id: `AL-${Date.now().toString(36).toUpperCase()}${Math.floor(this.r() * 1000)}`, em: new Date().toISOString(), reconhecido: false, ...a };
    alerts.unshift(alert);
    if (alerts.length > 400) alerts.length = 400;
    this.store.save();
    this.emit('alert', alert);
    return alert;
  }
}

module.exports = { Simulator, TICK_MS, SPEED };
