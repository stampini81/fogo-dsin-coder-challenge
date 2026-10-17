'use strict';

// PRNG determinístico (mulberry32) — o seed gera sempre a mesma cidade.
function rng(seed = 42) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (min, max) => Math.floor(next() * (max - min + 1)) + min;
  next.pick = arr => arr[Math.floor(next() * arr.length)];
  next.chance = p => next() < p;
  next.normal = () => { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.poisson = lambda => { // Knuth (lambda pequeno)
    const L = Math.exp(-lambda); let k = 0, p = 1;
    do { k++; p *= next(); } while (p > L);
    return k - 1;
  };
  return next;
}

const DAY = 86400000;
const HOUR = 3600000;
const isoDate = d => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / DAY;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
const sigmoid = z => 1 / (1 + Math.exp(-z));

// Perfil de demanda por hora (0..23) e dia da semana (0=domingo) — usado pelo gerador sintético.
const HOUR_PROFILE = [0.35, 0.25, 0.2, 0.18, 0.22, 0.45, 0.95, 1.65, 1.85, 1.25, 1.0, 1.1,
  1.35, 1.25, 1.0, 1.1, 1.45, 1.95, 2.05, 1.55, 1.15, 0.95, 0.75, 0.5];
const WEEKDAY_FACTOR = [0.8, 1.0, 0.98, 1.0, 1.05, 1.3, 1.12];
const NIGHT_BONUS = (wd, h) => ((wd === 5 || wd === 6) && (h >= 21 || h <= 2)) || (wd === 6 && h <= 2) || (wd === 0 && h <= 2) ? 1.7 : 1;

module.exports = { rng, DAY, HOUR, isoDate, addDays, daysBetween, clamp, round, sigmoid, HOUR_PROFILE, WEEKDAY_FACTOR, NIGHT_BONUS };
