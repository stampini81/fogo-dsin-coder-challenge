'use strict';
// Geografia (aproximada) de Presidente Prudente/SP, sede da DSIN.
// Coordenadas e CEPs são aproximados e servem apenas para a simulação.

const CITY = { nome: 'Presidente Prudente', uf: 'SP', centro: [-22.1225, -51.3925] };

const REGIONS = ['Centro', 'Norte', 'Sul', 'Leste', 'Oeste'];

// weight = propensão relativa a ocorrências (usado só na geração do histórico sintético)
const BAIRROS = [
  { nome: 'Centro', regiao: 'Centro', lat: -22.1225, lng: -51.3885, cep: '19010', weight: 1.8,
    ruas: ['Av. Coronel José Soares Marcondes', 'Rua Tenente Nicolau Maffei', 'Rua Barão do Rio Branco', 'Av. Washington Luiz'] },
  { nome: 'Vila Marcondes', regiao: 'Norte', lat: -22.1130, lng: -51.3815, cep: '19030', weight: 1.1,
    ruas: ['Av. Brasil', 'Rua Quintino Bocaiúva', 'Rua Joaquim Nabuco'] },
  { nome: 'Parque Furquim', regiao: 'Norte', lat: -22.1080, lng: -51.3975, cep: '19030', weight: 0.9,
    ruas: ['Rua Rui Barbosa', 'Av. Manoel Goulart', 'Rua Djalma Dutra'] },
  { nome: 'Jardim Itapura', regiao: 'Norte', lat: -22.0995, lng: -51.3830, cep: '19034', weight: 0.8,
    ruas: ['Rua Dom Pedro II', 'Av. Juscelino Kubitschek'] },
  { nome: 'Vila Nova', regiao: 'Oeste', lat: -22.1165, lng: -51.4030, cep: '19020', weight: 1.0,
    ruas: ['Av. Manoel Goulart', 'Rua Siqueira Campos', 'Rua Ribeiro de Barros'] },
  { nome: 'Jardim Aviação', regiao: 'Oeste', lat: -22.1290, lng: -51.4160, cep: '19020', weight: 0.8,
    ruas: ['Av. Joaquim Constantino', 'Rua Alcides Ferrari'] },
  { nome: 'Ana Jacinta', regiao: 'Oeste', lat: -22.1530, lng: -51.4330, cep: '19064', weight: 1.3,
    ruas: ['Av. Ana Jacinta', 'Rua José Bongiovani', 'Av. Salim Farah Maluf'] },
  { nome: 'Jardim Paulista', regiao: 'Sul', lat: -22.1305, lng: -51.3960, cep: '19023', weight: 1.0,
    ruas: ['Av. Washington Luiz', 'Rua Francisco Machado de Campos'] },
  { nome: 'Jardim Bongiovani', regiao: 'Sul', lat: -22.1385, lng: -51.4085, cep: '19050', weight: 1.0,
    ruas: ['Av. 14 de Setembro', 'Rua José Bongiovani', 'Av. Coronel José Soares Marcondes'] },
  { nome: 'Cidade Universitária', regiao: 'Sul', lat: -22.1460, lng: -51.4045, cep: '19050', weight: 0.9,
    ruas: ['Av. Roberto Simonsen', 'Rua José Bongiovani'] },
  { nome: 'Vila Industrial', regiao: 'Leste', lat: -22.1105, lng: -51.3690, cep: '19033', weight: 1.2,
    ruas: ['Rodovia Raposo Tavares', 'Av. Brasil', 'Rua Tenente Nicolau Maffei'] },
  { nome: 'Parque São Judas Tadeu', regiao: 'Leste', lat: -22.1300, lng: -51.3660, cep: '19026', weight: 1.1,
    ruas: ['Av. Celestino Figueiredo', 'Rua Ângelo Rotta'] },
];

function bairroByName(nome) { return BAIRROS.find(b => b.nome === nome); }

// distância em metros (haversine)
function distance(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestBairro(lat, lng) {
  let best = null, bd = Infinity;
  for (const b of BAIRROS) { const d = distance([lat, lng], [b.lat, b.lng]); if (d < bd) { bd = d; best = b; } }
  return best;
}

module.exports = { CITY, REGIONS, BAIRROS, bairroByName, distance, nearestBairro };
