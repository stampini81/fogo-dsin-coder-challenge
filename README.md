# 🔥 F.O.G.O. — Ferramenta Onisciente de Gestão e Operações

Projeto para o **Desafio Bônus do DSIN Coder Challenge 2026 — Protocolo PROMETHEUS**.

**Autor:** Leandro da Silva Stampini

Sistema web com inventário de equipamentos e agentes, central de operações com mapa em tempo real e análise preditiva de ocorrências e manutenção. Os dados são sintéticos, gerados para demonstração.

## Executar na sua máquina

Requisito: **Node.js 18 ou superior**. Não é necessário executar `npm install`.

Para baixar e executar no PowerShell:

```powershell
git clone https://github.com/stampini81/fogo-dsin-coder-challenge.git
cd fogo-dsin-coder-challenge/fogo
node server.js
```

Se já estiver na pasta raiz do repositório, execute apenas:

```powershell
cd fogo
node server.js
```

Abra **http://localhost:3000** no navegador. Mantenha o terminal aberto e pressione **Ctrl + C** para encerrar.

Na primeira execução, o sistema gera a cidade e salva os dados em `fogo/data/fogo-db.json`. Esses dados locais não são enviados ao GitHub.

## Tecnologias

HTML5, CSS3, JavaScript, Node.js, API REST, Server-Sent Events (SSE), Leaflet, leaflet.heat, Chart.js, OpenStreetMap, ViaCEP, JSON, Git e GitHub.

O mapa usa a camada padrão do **OpenStreetMap**, sem chave de API. Mapas, fontes externas e consulta de CEP precisam de internet. As bibliotecas visuais estão incluídas em `fogo/public/vendor`.

## Testes

Na pasta `fogo`, execute:

```powershell
npm test
```

## Documentação completa

Consulte o [README da aplicação](fogo/README.md) para arquitetura, API, modelos preditivos e roteiro de demonstração.
