'use strict';
// Catálogo de tipos: cada tipo de equipamento declara suas "outras características"
// (campos específicos). O front-end monta o formulário a partir deste esquema e o
// back-end valida com ele — uma única fonte de verdade.

const EQUIPMENT_STATUS = {
  nao_instalado: { label: 'Ainda não instalado', disponivel: false, cor: '#8a94a6' },
  operacional: { label: 'Operacional', disponivel: true, cor: '#22a06b' },
  mau_funcionamento: { label: 'Mau funcionamento', disponivel: false, cor: '#e5484d' },
  em_manutencao: { label: 'Em manutenção', disponivel: false, cor: '#f5a524' },
  desativado: { label: 'Desativado', disponivel: false, cor: '#5b6472' },
  furtado: { label: 'Furtado', disponivel: false, cor: '#a43ad6' },
};

const MAINTENANCE_TYPES = {
  nenhuma: 'Sem necessidade',
  imediata: 'Imediata',
  agendada: 'Agendada',
  periodica: 'Periódica',
};

const ORGAOS = ['SEMOB', 'Guarda Municipal', 'Polícia Militar', 'Concessionária de Trânsito', 'Operadora de Mobilidade'];

const sel = (key, label, options, extra = {}) => ({ key, label, type: 'select', options, ...extra });
const num = (key, label, extra = {}) => ({ key, label, type: 'number', ...extra });
const bool = (key, label, extra = {}) => ({ key, label, type: 'boolean', ...extra });
const txt = (key, label, extra = {}) => ({ key, label, type: 'text', ...extra });

// movel = equipamento que se desloca (a localização cadastrada é a da base)
const EQUIPMENT_TYPES = {
  radar: {
    label: 'Radar de fiscalização', curto: 'Radar', icon: '📡', grupo: 'Fiscalização', movel: false, orgao: 'SEMOB', periodicidadeDias: 180,
    fields: [
      sel('subtipo', 'Tipo de fiscalização', ['velocidade', 'semaforo', 'conversao_proibida', 'retorno_proibido', 'faixa_exclusiva'], { required: true }),
      num('velocidadeMaxima', 'Velocidade máxima (km/h)', { min: 20, max: 120, showIf: { subtipo: 'velocidade' } }),
      num('faixas', 'Faixas monitoradas', { min: 1, max: 8 }),
      bool('leituraPlaca', 'Leitura de placas (OCR)'),
    ],
  },
  camera: {
    label: 'Câmera de videomonitoramento', curto: 'Câmera', icon: '📹', grupo: 'Monitoramento', movel: false, orgao: 'Guarda Municipal', periodicidadeDias: 120,
    fields: [
      sel('resolucao', 'Resolução', ['720p', '1080p', '4MP', '4K'], { required: true }),
      bool('visaoNoturna', 'Visão noturna'),
      bool('colorida', 'Colorida (desmarque para P&B)'),
      bool('ptz', 'Movimentação PTZ'),
      bool('analiticoIA', 'Analítico embarcado (IA)'),
    ],
  },
  balanca: {
    label: 'Balança de caminhão', curto: 'Balança', icon: '⚖️', grupo: 'Fiscalização', movel: false, orgao: 'SEMOB', periodicidadeDias: 90,
    fields: [
      sel('modalidade', 'Modalidade', ['dinamica', 'estatica'], { required: true }),
      num('capacidadeToneladas', 'Capacidade (t)', { min: 1, max: 120 }),
    ],
  },
  veiculo_rotativo: {
    label: 'Veículo autônomo de fiscalização (rotativo)', curto: 'Fiscal. rotativo', icon: '🚙', grupo: 'Fiscalização', movel: true, orgao: 'SEMOB', periodicidadeDias: 60,
    fields: [
      txt('placa', 'Placa', { pattern: '^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$' }),
      num('autonomiaKm', 'Autonomia (km)', { min: 10, max: 1000 }),
      num('camerasEmbarcadas', 'Câmeras embarcadas', { min: 1, max: 12 }),
    ],
  },
  cancela: {
    label: 'Cancela automatizada', curto: 'Cancela', icon: '🚧', grupo: 'Controle de acesso', movel: false, orgao: 'Concessionária de Trânsito', periodicidadeDias: 90,
    fields: [
      sel('acionamento', 'Acionamento', ['tag', 'leitura_placa', 'ticket', 'manual_remoto']),
      bool('nobreak', 'Possui nobreak'),
    ],
  },
  veiculo_transporte: {
    label: 'Veículo de transporte', curto: 'Transporte', icon: '🚕', grupo: 'Transporte', movel: true, orgao: 'Operadora de Mobilidade', periodicidadeDias: 90,
    fields: [
      sel('categoria', 'Categoria', ['taxi', 'mototaxi', 'escolar'], { required: true }),
      txt('placa', 'Placa', { pattern: '^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$' }),
      num('capacidadePassageiros', 'Capacidade (passageiros)', { min: 1, max: 60 }),
      txt('alvara', 'Nº do alvará'),
    ],
  },
  totem_rotativo: {
    label: 'Totem de autoatendimento (rotativo)', curto: 'Totem', icon: '🅿️', grupo: 'Estacionamento', movel: false, orgao: 'SEMOB', periodicidadeDias: 120,
    fields: [
      bool('aceitaPix', 'Aceita Pix'),
      bool('aceitaCartao', 'Aceita cartão'),
      num('vagasAtendidas', 'Vagas atendidas', { min: 1, max: 500 }),
    ],
  },
  patinete: {
    label: 'Patinete elétrico', curto: 'Patinete', icon: '🛴', grupo: 'Micromobilidade', movel: true, orgao: 'Operadora de Mobilidade', periodicidadeDias: 45,
    fields: [
      sel('modalidade', 'Modalidade', ['publico', 'compartilhado'], { required: true }),
      num('autonomiaKm', 'Autonomia (km)', { min: 5, max: 100 }),
    ],
  },
  moto_agente: {
    label: 'Moto de agente de trânsito', curto: 'Moto agente', icon: '🏍️', grupo: 'Frota operacional', movel: true, orgao: 'SEMOB', periodicidadeDias: 60,
    fields: [
      txt('placa', 'Placa', { pattern: '^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$' }),
      num('cilindradas', 'Cilindradas', { min: 50, max: 1300 }),
    ],
  },
  viatura: {
    label: 'Viatura (GM / PM)', curto: 'Viatura', icon: '🚓', grupo: 'Frota operacional', movel: true, orgao: 'Guarda Municipal', periodicidadeDias: 60,
    fields: [
      sel('corporacao', 'Corporação', ['Guarda Municipal', 'Polícia Militar'], { required: true }),
      txt('placa', 'Placa', { pattern: '^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$' }),
      txt('prefixo', 'Prefixo'),
    ],
  },
  semaforo: {
    label: 'Semáforo inteligente', curto: 'Semáforo', icon: '🚦', grupo: 'Sinalização', movel: false, orgao: 'SEMOB', periodicidadeDias: 120,
    fields: [
      num('fases', 'Número de fases', { min: 2, max: 8 }),
      bool('adaptativo', 'Tempo adaptativo ao fluxo'),
      bool('botoeira', 'Botoeira para pedestres'),
    ],
  },
};

const AGENT_TYPES = {
  agente_transito: { label: 'Agente de trânsito', icon: '👮', orgao: 'SEMOB' },
  guarda_municipal: { label: 'Guarda municipal', icon: '🛡️', orgao: 'Guarda Municipal' },
  policial_militar: { label: 'Policial militar', icon: '🚔', orgao: 'Polícia Militar' },
};

const AGENT_STATUS = {
  em_patrulha: { label: 'Em patrulha', ativo: true, cor: '#22a06b' },
  em_ocorrencia: { label: 'Em ocorrência', ativo: true, cor: '#e5484d' },
  em_pausa: { label: 'Em pausa', ativo: true, cor: '#f5a524' },
  fora_de_servico: { label: 'Fora de serviço', ativo: false, cor: '#8a94a6' },
};

const INCIDENT_TYPES = {
  acidente: { label: 'Acidente de trânsito', icon: '💥' },
  congestionamento: { label: 'Congestionamento', icon: '🚗' },
  infracao_grave: { label: 'Infração grave', icon: '⚠️' },
  semaforo_apagado: { label: 'Semáforo apagado', icon: '🚦' },
  vandalismo: { label: 'Vandalismo / furto', icon: '🔨' },
  via_obstruida: { label: 'Via obstruída', icon: '⛔' },
};

const SEVERITY = { baixa: 1, media: 2, alta: 3, critica: 4 };

const ALERT_LEVELS = { critico: 4, alto: 3, medio: 2, info: 1 };

module.exports = {
  EQUIPMENT_STATUS, MAINTENANCE_TYPES, ORGAOS, EQUIPMENT_TYPES, AGENT_TYPES, AGENT_STATUS,
  INCIDENT_TYPES, SEVERITY, ALERT_LEVELS,
};
