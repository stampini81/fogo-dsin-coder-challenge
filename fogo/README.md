# 🔥 F.O.G.O. — Ferramenta Onisciente de Gestão e Operações

Solução para o **Desafio Bônus do DSIN Coder Challenge 2026 — Protocolo PROMETHEUS**.

**Autor e integrante:** Leandro da Silva Stampini
Um único sistema web cobre as três partes do desafio:

| Parte | Onde está | O que faz |
|---|---|---|
| 1. Inventário inteligente | aba **Inventário** | Cadastro, edição, exclusão, busca e exportação CSV de equipamentos IoT (11 tipos) e de agentes (trânsito, guarda municipal, PM) |
| 2. Central de Operações | aba **Central de Operações** | Mapa em tempo real, indicadores, filtros, alertas por criticidade, manutenção, saúde de bairros e regiões |
| 3. Cidade Preditiva | aba **Cidade Preditiva** | Risco de ocorrências por bairro e hora, reforço de efetivo, risco de falha de equipamentos, anomalias de telemetria e projeção de disponibilidade, sempre com recomendações |

---

## ▶️ Como rodar (1 comando)

Requisito: **Node.js 18 ou superior** (testado no 22). Não há `npm install`: o projeto **não tem dependências**.

```bash
node server.js
# abra http://localhost:3000
```

Na primeira execução o sistema gera a cidade: inventário, agentes e 120 dias de histórico. Os dados ficam salvos em `data/fogo-db.json`.

| Comando | Efeito |
|---|---|
| `npm start` | mesmo que `node server.js` |
| `npm test` | roda a suíte de testes (`node:test`): validação, modelos, API ponta a ponta |
| `npm run reset` | apaga os dados e gera a cidade de novo |
| `PORT=8080 node server.js` | muda a porta |
| `FOGO_SIM_SPEED=120 node server.js` | acelera os eventos simulados (padrão 60×) |

Leaflet, Chart.js e leaflet.heat vêm junto em `public/vendor`. Só os blocos do mapa (CARTO/OpenStreetMap), a fonte e a busca de CEP (ViaCEP) usam internet.

### Roteiro de demonstração (2 minutos)
1. **Central de Operações**: veja agentes e veículos se movendo e as ocorrências sendo despachadas ao agente livre mais próximo.
2. Menu **⚡ Simular evento → Apagão no Centro**: semáforos e câmeras caem, alertas críticos aparecem, o bairro fica vermelho no mapa e a disponibilidade cai.
3. Clique em qualquer ícone: abre a ficha com telemetria ao vivo, risco de falha previsto e histórico.
4. **Inventário → + Novo equipamento**: escolha "Radar", depois "velocidade", e o campo "velocidade máxima" aparece. Digite um CEP e o endereço é preenchido. Clique no mapa para definir o GPS.
5. **Cidade Preditiva**: arraste o controle de horário para ver o risco hora a hora. Abra "como funciona?" em cada bloco.

---

## 🧱 Arquitetura

```
server.js            HTTP + REST + Server-Sent Events (sem framework)
src/catalog.js       Catálogo único de tipos/situações/campos específicos (gera formulário e validação)
src/validation.js    Validação de equipamentos e agentes (422 com erros por campo, 409 para duplicidade)
src/store.js         Persistência em JSON com escrita atômica e debounce
src/seed.js          Gerador determinístico da cidade e do histórico
src/simulator.js     Telemetria IoT, falhas, ocorrências, despacho e movimentação de agentes (tempo real)
src/analytics.js     KPIs, filtros, saúde de bairros e regiões
src/predict.js       Motor preditivo (modelos estatísticos/ML implementados do zero)
public/              Front-end em JavaScript puro (Leaflet + Chart.js), sem etapa de build
test/                Testes automatizados
```

**Por que sem dependências?** Para o projeto "rodar de primeira" em qualquer máquina. Não há módulo nativo para compilar nem banco para instalar. Em produção, o `store.js` daria lugar a um PostgreSQL/PostGIS e o `simulator.js` à ingestão real dos dispositivos (MQTT/HTTP). O resto do sistema não muda, porque conversa com eles pelos mesmos eventos.

### API REST (resumo)
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/meta` | catálogo de tipos, situações, bairros, regiões e órgãos |
| GET/POST | `/api/equipments` | lista (filtros: `tipo, situacao, bairro, regiao, orgao, q, manutencao`) / cria |
| GET/PUT/DELETE | `/api/equipments/:id` | detalhe (com telemetria, risco de falha e anomalias) / edita / exclui |
| GET | `/api/equipments.csv` | exporta o inventário filtrado |
| GET/POST, GET/PUT/DELETE | `/api/agents`, `/api/agents/:id` | CRUD de agentes |
| GET | `/api/dashboard` | KPIs, distribuição, saúde de bairros e regiões, filas de manutenção (aceita os mesmos filtros) |
| GET | `/api/alerts` · POST `/api/alerts/:id/ack` | alertas não reconhecidos / reconhecer |
| GET | `/api/incidents/live` · POST `/api/incidents` | ocorrências em andamento / registrar ocorrência manual |
| GET | `/api/predictions` | todas as previsões, métricas de validação, recomendações e explicações |
| GET | `/api/predictions/heatmap?bairro=` | padrão semanal dia × hora |
| GET | `/api/stream` | eventos em tempo real (SSE): `tick`, `alert`, `incident`, `anomaly`, `kpi` |
| POST | `/api/simulate/:cenario` | `acidente-grave`, `apagao`, `furto`, `sensor-travado` |

---

## 1ª parte — Inventário

- **Tipos**: radar (velocidade, semáforo, conversão proibida, retorno proibido, faixa exclusiva), câmera, balança de caminhão, veículo autônomo do rotativo, cancela, veículo de transporte (táxi, mototáxi, escolar), totem do rotativo, patinete (público ou compartilhado), moto de agente, viatura GM/PM e semáforo inteligente.
- **Campos comuns**: número de série (único), marca, modelo, órgão responsável e data de instalação.
- **Localização**:
  - CEP com busca automática no ViaCEP;
  - rua, bairro, cidade/UF e região derivada do bairro;
  - referência livre ("número 181", "oposto ao número 181", "KM 203", "S/N", "em frente ao Mercado do Tio");
  - GPS escolhido clicando no mapa. Para equipamento móvel, é a localização da base.
- **Situação**: ainda não instalado, operacional, mau funcionamento, em manutenção, desativado ou furtado.
- **Manutenção**: necessidade (nenhuma, imediata, agendada ou periódica), última e próxima data e periodicidade. As regras de negócio são validadas: mau funcionamento exige manutenção, e manutenção agendada ou periódica exige data.
- **Características específicas** declaradas por tipo em `catalog.js`, com campos condicionais. Exemplo: a velocidade máxima só aparece para radar de velocidade. Para criar um tipo novo basta adicionar uma entrada no catálogo; formulário, validação e mapa se adaptam sozinhos.
- **Agentes**: nome, matrícula (única), tipo, órgão, turno, situação, bairro-base e veículo vinculado (moto ou viatura). A posição é atualizada em tempo real.

## 2ª parte — Central de Operações

- **Mapa** com ícone por tipo e cor por situação. Equipamentos com falha piscam. Agentes, viaturas, veículos e patinetes se movem.
- **Indicadores**:
  - total de equipamentos, operacionais, indisponíveis e % de disponibilidade;
  - agentes em atividade e em ocorrência;
  - ocorrências abertas;
  - manutenção imediata e prevista para 7 dias;
  - alertas críticos.
- **Filtros** por tipo, situação, região, bairro, órgão, busca livre e "só com manutenção imediata ou próxima". Os filtros valem para o mapa e para os indicadores.
- **Camadas**: equipamentos, agentes, ocorrências ao vivo, saúde dos bairros e mapa de calor dos últimos 30 dias.
- **Alertas** em quatro níveis (crítico, alto, médio, info). Disparam por:
  - falha de equipamento crítico ou furto;
  - ocorrência grave;
  - anomalia de telemetria;
  - manutenção vencida.

  Alertas repetidos são agrupados. É possível filtrar, localizar no mapa e reconhecer cada alerta.
- **Despacho automático**: cada ocorrência recebe o agente livre mais próximo. Ocorrência alta ou crítica recebe dois.
- **Saúde (0–100)** de cada bairro e região. Combina disponibilidade dos equipamentos, carga de ocorrências por severidade, alertas graves, efetivo de base e risco previsto. Responde de relance: *"se algo estiver acontecendo agora, PROMETHEUS percebe?"*.

## 3ª parte — Cidade Preditiva

Cada bloco diz **o que prevê**, **quais dados usa**, **como calcula** e **como ajuda a decidir** (botão "como funciona?"). Todos os modelos foram implementados do zero, sem bibliotecas.

| Previsão | Método | Validação |
|---|---|---|
| **Risco de ocorrências** por bairro e hora (24 h) | Poisson hierárquico: padrão dia × hora da cidade × participação do bairro × desvio horário do bairro, com Bayes empírico. Fator de tendência (4 semanas vs. 8 anteriores) com prior Gama e teste de significância. Ajuste ao vivo por câmeras, radares e semáforos fora do ar e ocorrências abertas. | Fora da amostra, nos últimos 28 dias: deviance e erro absoluto médio contra um baseline ingênuo (média do bairro) |
| **Reforço de efetivo** por região (3 janelas de 4 h) | Ocorrências esperadas ÷ capacidade do agente, com presença mínima por bairro. Os excedentes são realocados para as regiões em déficit. | — |
| **Risco de falha** de cada equipamento (7 e 30 dias) | Regressão logística por gradiente. Variáveis: % do ciclo de manutenção consumido, idade, falhas em 180 dias e se o equipamento é móvel. Anomalias recentes aumentam a chance. | Temporal: treina nas semanas 26–7 e mede a AUC nas 6 semanas mais recentes. Compara com a regra só por calendário de manutenção. |
| **Anomalias de telemetria** | Média e variância móveis exponenciais (EWMA) por dispositivo e métrica, já descontado o padrão da hora. Alerta quando o z-score passa de 3,5 após o aquecimento. | Cenário "sensor travado" |
| **Disponibilidade do parque** (14 dias) | Regressão linear com intervalo de 95% pelo erro residual. Avisa a data em que a meta de 90% será violada. | R² exibido |

O resultado de tudo isso é uma **lista de recomendações priorizada**: onde posicionar equipes antes do pico, de onde remanejar agentes, quais equipamentos levar à manutenção preventiva e em quais bairros a ocorrência vem subindo.

### Sobre os dados
Não havia dados reais disponíveis, então o sistema gera uma **Presidente Prudente sintética** com coordenadas aproximadas de 12 bairros e 5 regiões. Ela tem cerca de 270 equipamentos, 64 agentes e 120 dias de histórico de ocorrências e falhas. O gerador segue padrões plausíveis: horário de rush, sexta e sábado à noite, dias de chuva, bairro em crescimento acelerado e envelhecimento dos equipamentos.

O motor preditivo **não lê esses parâmetros**. Ele precisa redescobri-los a partir dos dados, como faria com dados reais, e é isso que a validação fora da amostra mede. Ocorrências encerradas ao vivo entram no histórico, então os modelos são re-treinados continuamente.

---

## 🤖 Uso de IA
Desenvolvido com auxílio do **Claude (Anthropic)**, conforme pede o regulamento.

## 🧪 Testes
```bash
npm test
```
Cobrem: geração da cidade, validação (campos obrigatórios, formatos, campos condicionais, regras de manutenção), qualidade dos modelos fora da amostra, regressão linear e o fluxo CRUD completo pela API (422, 409, 201, 204).
