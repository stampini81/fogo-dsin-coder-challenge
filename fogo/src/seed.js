'use strict';
// Gera uma cidade sintética coerente: inventário, agentes e histórico (ocorrências e falhas).
// O histórico é produzido por um "modelo verdadeiro" oculto; o motor preditivo NÃO conhece
// esse modelo — ele precisa reaprender os padrões a partir dos dados, como faria na vida real.
const { BAIRROS, CITY } = require('./geo');
const { EQUIPMENT_TYPES, AGENT_TYPES, INCIDENT_TYPES } = require('./catalog');
const { rng, DAY, HOUR, isoDate, addDays, clamp, sigmoid, HOUR_PROFILE, WEEKDAY_FACTOR, NIGHT_BONUS } = require('./util');

const BRANDS = {
  radar: [['Perkons', 'PK-Radar 3'], ['Velsis', 'VS-Fixo 9'], ['Pumatronix', 'ITSCAM Vigia']],
  camera: [['Intelbras', 'VIP 5450 Z'], ['Hikvision', 'DS-2DE4425'], ['Axis', 'Q6075-E']],
  balanca: [['Toledo', 'Rodoviária 820'], ['Filizola', 'BTR-60']],
  veiculo_rotativo: [['Renault', 'Kangoo Z.E. (adaptado)'], ['BYD', 'Dolphin Mini (adaptado)']],
  cancela: [['PPA', 'Cancela Flash'], ['Garen', 'Bold 4']],
  veiculo_transporte: [['Toyota', 'Corolla Cross'], ['Honda', 'CG 160'], ['Mercedes-Benz', 'Sprinter Escolar']],
  totem_rotativo: [['Digicon', 'Parking Totem'], ['Zona Azul Tech', 'ZT-200']],
  patinete: [['Xiaomi', 'Electric Scooter 4 Pro'], ['Segway', 'Ninebot Max G2']],
  moto_agente: [['Honda', 'XRE 300'], ['Yamaha', 'Lander 250']],
  viatura: [['Chevrolet', 'Spin'], ['Toyota', 'Hilux'], ['Renault', 'Duster']],
  semaforo: [['Sinalvida', 'SV-Smart'], ['Dataprom', 'CTA-Adaptativo']],
};

// quantidade por tipo, para a cidade inteira
const TYPE_COUNTS = {
  radar: 34, camera: 62, balanca: 4, veiculo_rotativo: 6, cancela: 10, veiculo_transporte: 28,
  totem_rotativo: 24, patinete: 40, moto_agente: 14, viatura: 16, semaforo: 36,
};

const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Karen', 'Lucas',
  'Mariana', 'Nicolas', 'Olívia', 'Paulo', 'Rafaela', 'Sérgio', 'Tatiane', 'Vinícius', 'Larissa', 'Marcelo', 'Patrícia', 'Rodrigo'];
const LAST = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Ferreira', 'Almeida', 'Costa', 'Ribeiro', 'Martins',
  'Carvalho', 'Gomes', 'Rocha', 'Barbosa', 'Moreira', 'Teixeira', 'Mendes'];

function placa(r) {
  const L = () => String.fromCharCode(65 + r.int(0, 25));
  return `${L()}${L()}${L()}-${r.int(0, 9)}${L()}${r.int(0, 9)}${r.int(0, 9)}`;
}

function jitter(r, b, spread = 0.0075) {
  return [b.lat + (r() - 0.5) * 2 * spread, b.lng + (r() - 0.5) * 2 * spread];
}

function pickBairro(r) {
  const total = BAIRROS.reduce((s, b) => s + b.weight, 0);
  let x = r() * total;
  for (const b of BAIRROS) { x -= b.weight; if (x <= 0) return b; }
  return BAIRROS[0];
}

function caracteristicas(r, tipo) {
  switch (tipo) {
    case 'radar': {
      const subtipo = r.pick(['velocidade', 'velocidade', 'velocidade', 'semaforo', 'semaforo', 'conversao_proibida', 'retorno_proibido', 'faixa_exclusiva']);
      return { subtipo, ...(subtipo === 'velocidade' ? { velocidadeMaxima: r.pick([40, 50, 60, 60, 70, 80]) } : {}), faixas: r.int(1, 4), leituraPlaca: r.chance(0.6) };
    }
    case 'camera': return { resolucao: r.pick(['1080p', '1080p', '4MP', '4K', '720p']), visaoNoturna: r.chance(0.75), colorida: r.chance(0.85), ptz: r.chance(0.35), analiticoIA: r.chance(0.3) };
    case 'balanca': return { modalidade: r.pick(['dinamica', 'estatica']), capacidadeToneladas: r.pick([45, 60, 80]) };
    case 'veiculo_rotativo': return { placa: placa(r), autonomiaKm: r.int(180, 320), camerasEmbarcadas: r.int(2, 6) };
    case 'cancela': return { acionamento: r.pick(['tag', 'leitura_placa', 'ticket']), nobreak: r.chance(0.6) };
    case 'veiculo_transporte': {
      const categoria = r.pick(['taxi', 'taxi', 'mototaxi', 'escolar']);
      return { categoria, placa: placa(r), capacidadePassageiros: categoria === 'escolar' ? r.int(15, 30) : categoria === 'mototaxi' ? 1 : 4, alvara: `ALV-${r.int(1000, 9999)}` };
    }
    case 'totem_rotativo': return { aceitaPix: r.chance(0.8), aceitaCartao: true, vagasAtendidas: r.int(20, 120) };
    case 'patinete': return { modalidade: r.pick(['compartilhado', 'compartilhado', 'publico']), autonomiaKm: r.int(25, 60) };
    case 'moto_agente': return { placa: placa(r), cilindradas: r.pick([250, 300]) };
    case 'viatura': return { corporacao: r.pick(['Guarda Municipal', 'Polícia Militar']), placa: placa(r), prefixo: `VTR-${r.int(100, 999)}` };
    case 'semaforo': return { fases: r.int(2, 4), adaptativo: r.chance(0.4), botoeira: r.chance(0.5) };
    default: return {};
  }
}

const REFS = n => [`número ${n}`, `oposto ao número ${n}`, 'S/N', `esquina com a Rua ${['XV de Novembro', 'Floriano Peixoto', 'Bela Vista'][n % 3]}`, `em frente ao Mercado do Tio`, `próximo ao número ${n}`];

// Gera equipamentos + histórico semanal de falhas/manutenções (26 semanas).
function generateEquipments(r, now) {
  const list = [];
  let serial = 1000;
  const WEEKS = 26;
  for (const [tipo, count] of Object.entries(TYPE_COUNTS)) {
    const def = EQUIPMENT_TYPES[tipo];
    for (let i = 0; i < count; i++) {
      const b = pickBairro(r);
      const [lat, lng] = jitter(r, b);
      const [marca, modelo] = r.pick(BRANDS[tipo]);
      const rua = r.pick(b.ruas);
      const n = r.int(10, 3500);
      const rodovia = rua.startsWith('Rodovia');
      const ageYears = r() * 6;
      const instalacao = addDays(now, -Math.round(ageYears * 365) - WEEKS * 7);
      const fragility = r.normal() * 0.6; // característica oculta de cada unidade
      const periodicidadeDias = def.periodicidadeDias;

      // --- simulação semanal do histórico (modelo verdadeiro oculto) ---
      const historico = [];
      const downtime = []; // intervalos [inicio, fim] indisponível
      let lastMaint = addDays(now, -WEEKS * 7 - r.int(0, periodicidadeDias));
      historico.push({ data: lastMaint.toISOString(), tipo: 'manutencao', descricao: 'Manutenção preventiva' });
      let failuresRecent = [];
      for (let w = WEEKS; w >= 1; w--) {
        const weekStart = addDays(now, -w * 7);
        // o atraso de reparo cresce nas semanas recentes (backlog de manutenção) -> tendência de queda de disponibilidade
        const backlog = w < 8 ? (8 - w) * 0.5 : 0;
        const ratio = (weekStart - lastMaint) / DAY / periodicidadeDias;
        failuresRecent = failuresRecent.filter(d => (weekStart - d) / DAY <= 180);
        const age = ageYears + (WEEKS - w) / 52;
        const p = sigmoid(-4.3 + 2.1 * Math.max(0, ratio - 0.6) + 0.22 * age + 0.45 * failuresRecent.length + fragility);
        if (r.chance(p)) {
          const failDate = new Date(weekStart.getTime() + r.int(0, 6) * DAY + r.int(0, 23) * HOUR);
          historico.push({ data: failDate.toISOString(), tipo: 'falha', descricao: r.pick(['Sem comunicação', 'Falha de energia', 'Leitura inconsistente', 'Dano físico', 'Falha de hardware']) });
          failuresRecent.push(failDate);
          const repair = r.int(1, 4) + Math.round(backlog * r() * 3);
          const end = addDays(failDate, repair);
          downtime.push([failDate.toISOString(), end.toISOString()]);
          if (end < now) {
            historico.push({ data: end.toISOString(), tipo: 'manutencao', descricao: 'Manutenção corretiva' });
            lastMaint = end;
          }
        } else if (ratio >= 1 && r.chance(0.55)) {
          const d = new Date(weekStart.getTime() + r.int(0, 6) * DAY);
          historico.push({ data: d.toISOString(), tipo: 'manutencao', descricao: 'Manutenção preventiva' });
          downtime.push([d.toISOString(), addDays(d, 0.3).toISOString()]);
          lastMaint = d;
        }
      }

      // situação atual
      let situacao = 'operacional';
      const openDown = downtime.find(([s, e]) => new Date(e) > now);
      if (openDown) situacao = r.chance(0.5) ? 'mau_funcionamento' : 'em_manutencao';
      if (r.chance(0.025)) situacao = 'desativado';
      if (['patinete', 'camera'].includes(tipo) && r.chance(0.02)) situacao = 'furtado';
      if (r.chance(0.03)) situacao = 'nao_instalado';

      const proxima = addDays(lastMaint, periodicidadeDias);
      let manutencaoTipo = 'periodica';
      if (situacao === 'mau_funcionamento') manutencaoTipo = 'imediata';
      else if ((proxima - now) / DAY < 10) manutencaoTipo = 'agendada';

      const eq = {
        id: `EQ-${String(serial).padStart(5, '0')}`,
        tipo,
        numeroSerie: `${marca.slice(0, 3).toUpperCase()}-${new Date(instalacao).getFullYear()}-${serial++}`,
        marca, modelo,
        orgao: def.orgao,
        localizacao: {
          cep: `${b.cep}-${String(r.int(0, 999)).padStart(3, '0')}`,
          bairro: b.nome, cidade: CITY.nome, uf: CITY.uf,
          rua,
          referencia: rodovia ? `KM ${r.int(560, 575)}` : r.pick(REFS(n)),
          lat: +lat.toFixed(6), lng: +lng.toFixed(6),
        },
        regiao: b.regiao,
        situacao,
        manutencao: {
          tipo: manutencaoTipo,
          ultimaData: isoDate(lastMaint),
          proximaData: situacao === 'nao_instalado' || situacao === 'desativado' ? null : isoDate(manutencaoTipo === 'imediata' ? now : proxima),
          periodicidadeDias,
        },
        caracteristicas: caracteristicas(r, tipo),
        dataInstalacao: situacao === 'nao_instalado' ? null : isoDate(instalacao),
        historico: historico.sort((a, b2) => a.data.localeCompare(b2.data)),
        _downtime: downtime,
        criadoEm: instalacao.toISOString(),
      };
      list.push(eq);
    }
  }
  return list;
}

function generateAgents(r, equipments) {
  const agents = [];
  const motos = equipments.filter(e => e.tipo === 'moto_agente');
  const vtrGM = equipments.filter(e => e.tipo === 'viatura' && e.caracteristicas.corporacao === 'Guarda Municipal');
  const vtrPM = equipments.filter(e => e.tipo === 'viatura' && e.caracteristicas.corporacao === 'Polícia Militar');
  const plan = [['agente_transito', 26], ['guarda_municipal', 20], ['policial_militar', 18]];
  let mat = 3100;
  for (const [tipo, count] of plan) {
    for (let i = 0; i < count; i++) {
      const b = pickBairro(r);
      const [lat, lng] = jitter(r, b, 0.006);
      const turno = r.pick(['manha', 'manha', 'tarde', 'tarde', 'noite']);
      const pool = tipo === 'agente_transito' ? motos : tipo === 'guarda_municipal' ? vtrGM : vtrPM;
      const veic = pool.length ? pool[i % pool.length] : null;
      agents.push({
        id: `AG-${mat}`,
        nome: `${r.pick(FIRST)} ${r.pick(LAST)}`,
        matricula: String(mat++),
        tipo,
        orgao: AGENT_TYPES[tipo].orgao,
        turno,
        situacao: 'em_patrulha',
        regiao: b.regiao,
        bairroBase: b.nome,
        equipamentoId: veic ? veic.id : null,
        posicao: { lat: +lat.toFixed(6), lng: +lng.toFixed(6), atualizadoEm: new Date().toISOString() },
        criadoEm: new Date().toISOString(),
      });
    }
  }
  return agents;
}

// Histórico de ocorrências (120 dias) gerado por um processo de Poisson não-homogêneo.
function generateIncidents(r, now) {
  const DAYS = 120;
  const out = [];
  const start = new Date(now.getTime() - DAYS * DAY);
  start.setMinutes(0, 0, 0);
  const rainDays = new Set();
  for (let d = 0; d < DAYS; d++) if (r.chance(0.12)) rainDays.add(d);
  let seq = 1;
  for (let t = start.getTime(); t < now.getTime(); t += HOUR) {
    const dt = new Date(t);
    const h = dt.getHours(), wd = dt.getDay();
    const dayIdx = Math.floor((t - start.getTime()) / DAY);
    const progress = dayIdx / DAYS;
    for (const b of BAIRROS) {
      let trend = 1;
      if (b.nome === 'Ana Jacinta') trend = 0.6 + 1.4 * progress;  // bairro em crescimento acelerado
      if (b.nome === 'Centro') trend = 1.12 - 0.25 * progress;      // efeito de novas câmeras
      if (b.nome === 'Vila Industrial') trend = 0.9 + 0.35 * progress;
      const rain = rainDays.has(dayIdx) ? 1.35 : 1;
      const lambda = 0.034 * b.weight * HOUR_PROFILE[h] * WEEKDAY_FACTOR[wd] * NIGHT_BONUS(wd, h) * trend * rain;
      const k = r.poisson(lambda);
      for (let i = 0; i < k; i++) {
        const tipo = pickIncidentType(r, h, wd, rainDays.has(dayIdx));
        const sev = pickSeverity(r, tipo, h);
        const inicio = new Date(t + r.int(0, 59) * 60000);
        const dur = (tipo === 'congestionamento' ? r.int(20, 90) : tipo === 'acidente' ? r.int(30, 150) : r.int(10, 60));
        const [lat, lng] = jitter(r, b, 0.007);
        out.push({
          id: `OC-${String(seq++).padStart(6, '0')}`, tipo, severidade: sev, bairro: b.nome, regiao: b.regiao,
          lat: +lat.toFixed(6), lng: +lng.toFixed(6), inicio: inicio.toISOString(),
          fim: new Date(inicio.getTime() + dur * 60000).toISOString(), status: 'encerrada', chuva: rainDays.has(dayIdx),
        });
      }
    }
  }
  return out;
}

function pickIncidentType(r, h, wd, rain) {
  const peak = (h >= 7 && h <= 9) || (h >= 17 && h <= 19);
  const night = h >= 22 || h <= 4;
  const w = {
    acidente: 3 + (night ? 1.5 : 0) + (rain ? 2.5 : 0),
    congestionamento: peak ? 5 : 1,
    infracao_grave: 2 + (night && (wd === 5 || wd === 6) ? 2.5 : 0),
    semaforo_apagado: 0.8 + (rain ? 1.5 : 0),
    vandalismo: night ? 2.2 : 0.4,
    via_obstruida: 1.2,
  };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (const [k, v] of Object.entries(w)) { x -= v; if (x <= 0) return k; }
  return 'acidente';
}

function pickSeverity(r, tipo, h) {
  const night = h >= 22 || h <= 4;
  const base = { acidente: [0.25, 0.4, 0.25, 0.1], congestionamento: [0.45, 0.4, 0.13, 0.02], infracao_grave: [0.2, 0.5, 0.25, 0.05],
    semaforo_apagado: [0.3, 0.45, 0.2, 0.05], vandalismo: [0.4, 0.4, 0.15, 0.05], via_obstruida: [0.35, 0.4, 0.2, 0.05] }[tipo];
  let x = r() * (night ? 0.8 : 1);
  const levels = ['baixa', 'media', 'alta', 'critica'];
  if (night) x = 1 - x; // à noite a severidade tende a ser maior
  for (let i = 0; i < 4; i++) { x -= base[i]; if (x <= 0) return levels[i]; }
  return 'critica';
}

// Disponibilidade diária (60 dias) derivada dos intervalos de indisponibilidade do histórico.
function availabilitySeries(equipments, now) {
  const series = [];
  const installed = equipments.filter(e => e.situacao !== 'nao_instalado');
  for (let d = 59; d >= 0; d--) {
    const day = addDays(now, -d);
    day.setHours(12, 0, 0, 0);
    let down = 0;
    for (const e of installed) {
      if (d === 0) { if (e.situacao !== 'operacional') down++; }
      else if (['desativado', 'furtado'].includes(e.situacao)) down++;
      else if (e._downtime.some(([s, en]) => new Date(s) <= day && new Date(en) >= day)) down++;
    }
    series.push({ data: isoDate(day), total: installed.length, disponiveis: installed.length - down, disponibilidade: +(100 * (installed.length - down) / installed.length).toFixed(2) });
  }
  return series;
}

function buildSeed(seed = 2026, now = new Date()) {
  const r = rng(seed);
  const equipments = generateEquipments(r, now);
  const agents = generateAgents(r, equipments);
  const incidents = generateIncidents(r, now);
  const disponibilidade = availabilitySeries(equipments, now);
  for (const e of equipments) delete e._downtime;
  return {
    meta: { geradoEm: now.toISOString(), seed, versao: 1 },
    equipments, agents, incidents, disponibilidade,
    alerts: [], liveIncidents: [],
  };
}

module.exports = { buildSeed, TYPE_COUNTS };
