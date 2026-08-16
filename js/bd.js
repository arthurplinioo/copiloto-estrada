'use strict';
/* Armazenamento local: IndexedDB com degradação para memória.
   Lojas: livros, progresso, config, wavs (frases geradas), capAudio (capítulo pronto). */

const bd = {
  db: null,
  memoria: { livros: new Map(), progresso: new Map(), config: new Map(), wavs: new Map(), capAudio: new Map() },
  soMemoria: false,

  async abrir(){
    try{
      this.db = await new Promise((res, rej) => {
        const req = indexedDB.open('copiloto-estrada', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          for(const loja of ['livros', 'progresso', 'config', 'wavs', 'capAudio']){
            if(!d.objectStoreNames.contains(loja)){
              d.createObjectStore(loja, { keyPath: loja === 'livros' ? 'id' : loja === 'progresso' ? 'livroId' : 'chave' });
            }
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        req.onblocked = () => rej(new Error('bloqueado'));
      });
      // pedir persistência: evita o sistema limpar os livros por pressão de espaço
      try{ await navigator.storage?.persist?.(); }catch{}
    }catch{
      this.db = null; this.soMemoria = true;
    }
  },

  _chave(loja, obj){ return obj.id ?? obj.livroId ?? obj.chave; },
  _tx(loja, modo){ return this.db.transaction(loja, modo).objectStore(loja); },
  _req(r){ return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },

  async salvar(loja, obj){
    if(!this.db){ this.memoria[loja].set(this._chave(loja, obj), obj); return; }
    await this._req(this._tx(loja, 'readwrite').put(obj));
  },
  async obter(loja, chave){
    if(!this.db) return this.memoria[loja].get(chave) ?? null;
    return (await this._req(this._tx(loja, 'readonly').get(chave))) ?? null;
  },
  async todos(loja){
    if(!this.db) return [...this.memoria[loja].values()];
    return await this._req(this._tx(loja, 'readonly').getAll());
  },
  async chaves(loja){
    if(!this.db) return [...this.memoria[loja].keys()];
    return await this._req(this._tx(loja, 'readonly').getAllKeys());
  },
  async apagar(loja, chave){
    if(!this.db){ this.memoria[loja].delete(chave); return; }
    await this._req(this._tx(loja, 'readwrite').delete(chave));
  },
  /* apaga todas as chaves de uma loja que começam com o prefixo (ex.: áudios de um livro) */
  async apagarPrefixo(loja, prefixo){
    const todas = await this.chaves(loja);
    for(const c of todas) if(String(c).startsWith(prefixo)) await this.apagar(loja, c);
  }
};

window.bd = bd;
