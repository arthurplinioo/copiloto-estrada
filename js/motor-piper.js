'use strict';
/* Motor Piper: voz neural local. A síntese roda num Web Worker; cada frase vira
   um WAV salvo no banco (geração resumível); o capítulo pronto é concatenado em
   um único arquivo com mapa de tempos por frase — áudio de verdade, que segue
   tocando com a tela apagada e aparece na tela de bloqueio/CarPlay. */

/* ---------- utilidades WAV ---------- */
function lerWav(buf){
  const dv = new DataView(buf);
  if(dv.getUint32(0, false) !== 0x52494646) throw new Error('WAV inválido');
  let off = 12, fmt = null, dados = null;
  while(off + 8 <= buf.byteLength){
    const id = dv.getUint32(off, false);
    const tam = dv.getUint32(off + 4, true);
    if(id === 0x666d7420){ // "fmt "
      fmt = {
        canais: dv.getUint16(off + 10, true),
        taxa: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true)
      };
    } else if(id === 0x64617461){ // "data"
      dados = new Uint8Array(buf, off + 8, Math.min(tam, buf.byteLength - off - 8));
    }
    off += 8 + tam + (tam % 2);
  }
  if(!fmt || !dados) throw new Error('WAV sem fmt/data');
  return {fmt, dados};
}

function montarWav(fmt, blocos){
  const totalPcm = blocos.reduce((s, b) => s + b.length, 0);
  const buf = new ArrayBuffer(44 + totalPcm);
  const dv = new DataView(buf);
  const escreverStr = (o, s) => { for(let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  const blocoAlinh = fmt.canais * fmt.bits / 8;
  escreverStr(0, 'RIFF'); dv.setUint32(4, 36 + totalPcm, true); escreverStr(8, 'WAVE');
  escreverStr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, fmt.canais, true); dv.setUint32(24, fmt.taxa, true);
  dv.setUint32(28, fmt.taxa * blocoAlinh, true); dv.setUint16(32, blocoAlinh, true);
  dv.setUint16(34, fmt.bits, true);
  escreverStr(36, 'data'); dv.setUint32(40, totalPcm, true);
  const saida = new Uint8Array(buf);
  let o = 44;
  for(const b of blocos){ saida.set(b, o); o += b.length; }
  return buf;
}

/* Concatena WAVs de frases em um capítulo único + mapa de tempos.
   Pausa curta de silêncio entre frases dá respiro natural à leitura. */
function concatenarWavs(bufs, pausaMs = 280){
  const primeiro = lerWav(bufs[0]);
  const fmt = primeiro.fmt;
  const bytesPorSeg = fmt.taxa * fmt.canais * fmt.bits / 8;
  const silencio = new Uint8Array(Math.round(bytesPorSeg * pausaMs / 1000) & ~1);
  const blocos = [];
  const mapa = [];
  let bytes = 0;
  bufs.forEach((b, i) => {
    const {dados} = lerWav(b);
    mapa.push({inicio: bytes / bytesPorSeg, dur: dados.length / bytesPorSeg});
    blocos.push(dados);
    bytes += dados.length;
    if(i < bufs.length - 1){ blocos.push(silencio); bytes += silencio.length; }
  });
  return {wav: montarWav(fmt, blocos), mapa, duracao: bytes / bytesPorSeg};
}

/* ---------- comunicação com o worker ---------- */
const piper = {
  worker: null,
  disponivel: false,
  pronto: false,
  vozId: 'pt_BR-faber-medium',
  reqSeq: 0,
  pendentes: new Map(),
  aoProgressoDownload: null,

  iniciar(){
    if(typeof Worker === 'undefined') return false;
    try{
      this.worker = new Worker('js/piper-worker.bundle.js');
    }catch{ return false; }
    this.worker.onmessage = (e) => {
      const m = e.data;
      if(m.tipo === 'worker-pronto'){ this.pronto = true; return; }
      if(m.tipo === 'progresso-download'){ this.aoProgressoDownload?.(m); return; }
      const p = m.reqId != null ? this.pendentes.get(m.reqId) : null;
      if(!p) return;
      this.pendentes.delete(m.reqId);
      if(m.tipo === 'erro') p.rej(new Error(m.msg));
      else p.res(m);
    };
    this.worker.onerror = (e) => {
      // worker quebrou de vez: rejeitar tudo que esperava resposta
      for(const p of this.pendentes.values()) p.rej(new Error('Falha no motor de voz: ' + (e.message || 'erro')));
      this.pendentes.clear();
      this.disponivel = false;
    };
    this.disponivel = true;
    return true;
  },

  _chamar(msg, timeoutMs = 300000){
    if(!this.worker) return Promise.reject(new Error('Motor Piper indisponível.'));
    const reqId = ++this.reqSeq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        if(this.pendentes.delete(reqId)) rej(new Error('Tempo esgotado no motor de voz.'));
      }, timeoutMs);
      this.pendentes.set(reqId, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); }
      });
      this.worker.postMessage({...msg, reqId});
    });
  },

  async vozes(){ return (await this._chamar({tipo: 'vozes'}, 30000)).lista; },
  async armazenadas(){ return (await this._chamar({tipo: 'armazenadas'}, 30000)).ids; },
  async baixar(vozId){ await this._chamar({tipo: 'baixar', vozId}, 1200000); },
  async remover(vozId){ await this._chamar({tipo: 'remover', vozId}, 60000); },
  async gerar(texto){ return (await this._chamar({tipo: 'gerar', texto, vozId: this.vozId}, 300000)).buf; }
};

/* ---------- gerador de capítulos (fila resumível) ---------- */
const gerador = {
  fila: [],            // [{livro, capIdx}]
  ativo: false,
  atual: null,         // {livroId, capIdx}
  aoMudar: null,       // callback de estado p/ UI

  chaveCap(livroId, capIdx){ return `${livroId}:${capIdx}`; },

  async estadoCap(livroId, capIdx){
    const pronto = await bd.obter('capAudio', this.chaveCap(livroId, capIdx));
    if(pronto) return {estado: 'pronto', ...pronto};
    return {estado: 'texto'};
  },

  cancelarLivro(livroId){
    this.fila = this.fila.filter(f => f.livro.id !== livroId);
    if(this.atual && this.atual.livroId === livroId) this.atual.cancelado = true;
  },

  pedir(livro, capIdx){
    if(capIdx < 0 || capIdx >= livro.capitulos.length) return;
    if(!livro.capitulos[capIdx].incluir) return;
    const chave = this.chaveCap(livro.id, capIdx);
    if(this.fila.some(f => this.chaveCap(f.livro.id, f.capIdx) === chave)) return;
    if(this.atual && this.chaveCap(this.atual.livroId, this.atual.capIdx) === chave) return;
    this.fila.push({livro, capIdx});
    this._rodar();
  },

  async _rodar(){
    if(this.ativo) return;
    this.ativo = true;
    while(this.fila.length){
      const {livro, capIdx} = this.fila.shift();
      this.atual = {livroId: livro.id, capIdx, cancelado: false};
      try{
        const existente = await bd.obter('capAudio', this.chaveCap(livro.id, capIdx));
        if(existente){
          const frases = frasesDoCapitulo(livro.capitulos[capIdx]);
          if(existente.nFrases === frases.length) continue;
          await bd.apagar('capAudio', this.chaveCap(livro.id, capIdx));
        }
        await this._gerarCapitulo(livro, capIdx);
      }catch(err){
        if(!this.atual?.cancelado){
          this.aoMudar?.({livroId: livro.id, capIdx, estado: 'erro', erro: String(err?.message || err)});
        }
      }
    }
    this.atual = null;
    this.ativo = false;
  },

  async _gerarCapitulo(livro, capIdx){
    const frases = frasesDoCapitulo(livro.capitulos[capIdx]);
    const prefixo = `${livro.id}:${capIdx}:`;
    // retomar de onde parou: frases já geradas ficam no banco
    const feitas = new Set((await bd.chaves('wavs')).filter(c => String(c).startsWith(prefixo)));
    for(let i = 0; i < frases.length; i++){
      if(this.atual?.cancelado) return;
      const chave = `${prefixo}${i}`;
      if(feitas.has(chave)) continue;
      const buf = await piper.gerar(frases[i].falado);
      if(this.atual?.cancelado) return;
      await bd.salvar('wavs', {chave, buf});
      this.aoMudar?.({livroId: livro.id, capIdx, estado: 'gerando', feito: i + 1, total: frases.length});
    }
    // montar capítulo único
    const bufs = [];
    for(let i = 0; i < frases.length; i++){
      const reg = await bd.obter('wavs', `${prefixo}${i}`);
      if(!reg) throw new Error('Frase gerada sumiu do banco.');
      bufs.push(reg.buf);
    }
    const {wav, mapa, duracao} = concatenarWavs(bufs);
    await bd.salvar('capAudio', {chave: this.chaveCap(livro.id, capIdx), wav, mapa, duracao, vozId: piper.vozId, nFrases: frases.length});
    await bd.apagarPrefixo('wavs', prefixo);
    this.aoMudar?.({livroId: livro.id, capIdx, estado: 'pronto', duracao});
  },

  async apagarAudioLivro(livroId){
    await bd.apagarPrefixo('capAudio', `${livroId}:`);
    await bd.apagarPrefixo('wavs', `${livroId}:`);
  }
};

Object.assign(window, {piper, gerador, concatenarWavs, lerWav, montarWav});
