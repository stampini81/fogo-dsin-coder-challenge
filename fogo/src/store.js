'use strict';
// Persistência simples em arquivo JSON (sem dependências nativas, roda em qualquer máquina).
// Escrita atômica (arquivo temporário + rename) e com debounce para não travar o event loop.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this._timer = null;
  }

  load() {
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return true;
    }
    return false;
  }

  replaceAll(data) { this.data = data; this.flush(); }

  col(name) {
    if (!this.data[name]) this.data[name] = [];
    return this.data[name];
  }

  get(name, id) { return this.col(name).find(x => x.id === id) || null; }

  insert(name, obj) {
    const item = { id: obj.id || crypto.randomUUID(), ...obj, criadoEm: obj.criadoEm || new Date().toISOString() };
    this.col(name).push(item);
    this.save();
    return item;
  }

  update(name, id, patch) {
    const item = this.get(name, id);
    if (!item) return null;
    Object.assign(item, patch, { atualizadoEm: new Date().toISOString() });
    this.save();
    return item;
  }

  remove(name, id) {
    const arr = this.col(name);
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    this.save();
    return true;
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 1500);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    clearTimeout(this._timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
