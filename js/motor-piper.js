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
/* Versão de baixo consumo: em vez de segurar todas as frases na memória e
   depois alocar o capítulo inteiro (pico = 2× o áudio), lê cada frase duas
   vezes do banco e monta direto no buffer final (pico = 1× + uma frase).
   Num celular isso é a diferença entre tocar e o navegador matar a aba. */
async function concatenarWavsDoBanco(n, carregar, pausaMs = 280){
  const primeiro = await carregar(0);
  const fmt = lerWav(primeiro).fmt;
  const bytesPorSeg = fmt.taxa * fmt.canais * fmt.bits / 8;
  const silBytes = Math.round(bytesPorSeg * pausaMs / 1000) & ~1;

  // 1ª passada: medir e montar o mapa de tempos, sem reter os dados
  const tamanhos = new Array(n);
  const mapa = [];
  let total = 0;
  for(let i = 0; i < n; i++){
    const buf = i === 0 ? primeiro : await carregar(i);
    const len = lerWav(buf).dados.length;
    tamanhos[i] = len;
    mapa.push({inicio: total / bytesPorSeg, dur: len / bytesPorSeg});
    total += len;
    if(i < n - 1) total += silBytes;
  }

  // 2ª passada: preencher o buffer final uma frase por vez
  const saidaBuf = new ArrayBuffer(44 + total);
  escreverCabecalhoWav(saidaBuf, fmt, total);
  const saida = new Uint8Array(saidaBuf);
  let off = 44;
  for(let i = 0; i < n; i++){
    const {dados} = lerWav(await carregar(i));
    saida.set(dados, off);
    off += tamanhos[i];
    if(i < n - 1) off += silBytes; // silêncio já é zero
  }
  return {wav: saidaBuf, mapa, duracao: total / bytesPorSeg};
}

function escreverCabecalhoWav(buf, fmt, totalPcm){
  const dv = new DataView(buf);
  const escreverStr = (o, s) => { for(let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  const blocoAlinh = fmt.canais * fmt.bits / 8;
  escreverStr(0, 'RIFF'); dv.setUint32(4, 36 + totalPcm, true); escreverStr(8, 'WAVE');
  escreverStr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, fmt.canais, true); dv.setUint32(24, fmt.taxa, true);
  dv.setUint32(28, fmt.taxa * blocoAlinh, true); dv.setUint16(32, blocoAlinh, true);
  dv.setUint16(34, fmt.bits, true);
  escreverStr(36, 'data'); dv.setUint32(40, totalPcm, true);
}

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
      if(m.tipo === 'erro'){
        const e = new Error(m.msg);
        e.incompativel = !!m.incompativel; // voz que este motor não sintetiza
        p.rej(e);
      }
      else p.res(m);
    };
    this.worker.onerror = (e) => {
      // O worker morreu (falta de memória do WASM, modelo corrompido…).
      // Rejeitar o que estava pendente e levantar um worker novo: sem isto o
      // motor neural ficava desligado até o app ser reaberto.
      for(const p of this.pendentes.values()) p.rej(new Error('Falha no motor de voz: ' + (e.message || 'erro')));
      this.pendentes.clear();
      this.pronto = false;
      this.aoQuebrar?.(e.message || 'erro');
      this.reiniciar();
    };
    this.disponivel = true;
    return true;
  },

  aoQuebrar: null,

  /* Derruba o worker e levanta outro. Trocar de voz sem isto deixava o modelo
     ONNX anterior na memória; carregar o segundo estourava a memória do
     celular e o navegador matava a aba. */
  reiniciar(){
    try{ this.worker?.terminate(); }catch{}
    this.worker = null;
    this.pronto = false;
    this._geradasNesteWorker = 0;
    for(const p of this.pendentes.values()) p.rej(new Error('Motor de voz reiniciado.'));
    this.pendentes.clear();
    return this.iniciar();
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

  async remover(vozId){
    // O modelo carregado segura o arquivo no OPFS: derrubar o worker antes,
    // senão a remoção "funciona" mas o arquivo continua lá.
    this.reiniciar();
    const r = await this._chamar({tipo: 'remover', vozId}, 60000);
    if(r.restou){
      // Não saiu nem assim: apagar a pasta inteira de modelos.
      this.reiniciar();
      await this._chamar({tipo: 'limpar-tudo'}, 60000);
    }
    this.reiniciar(); // devolver a memória do modelo ao sistema
  },

  async limparTudo(){
    this.reiniciar();
    await this._chamar({tipo: 'limpar-tudo'}, 60000);
    this.reiniciar();
  },

  // O worker reaproveita uma única InferenceSession por voz (ver o patch em
  // src-worker/piper-worker.src.js), então o vazamento do vits-web não existe
  // mais. Estes dois campos são só uma rede de segurança: se por algum motivo
  // o patch não pegar, o worker ainda é reciclado antes de a memória apertar.
  FRASES_POR_WORKER: 40,
  _geradasNesteWorker: 0,
  _patchConfirmado: false,

  async gerar(texto){
    // Com o patch ativo não há acúmulo: reciclar só faria a leitura engasgar.
    if(!this._patchConfirmado && this._geradasNesteWorker >= this.FRASES_POR_WORKER){
      this.reiniciar();
      this._geradasNesteWorker = 0;
    }
    const r = await this._chamar({tipo: 'gerar', texto, vozId: this.vozId}, 300000);
    if(r.sessaoReaproveitada) this._patchConfirmado = true;
    this._geradasNesteWorker++;
    return r.buf;
  }
};

/* ---------- gerador de capítulos (fila resumível) ---------- */
const gerador = {
  fila: [],            // [{livro, capIdx}]
  ativo: false,
  atual: null,         // {livroId, capIdx}
  aoMudar: null,       // callback de estado p/ UI
  falhas: new Map(),   // chaveCap -> nº de tentativas que falharam
  MAX_TENTATIVAS: 2,

  chaveCap(livroId, capIdx){ return `${livroId}:${capIdx}`; },

  async estadoCap(livroId, capIdx){
    const pronto = await bd.obter('capAudio', this.chaveCap(livroId, capIdx));
    if(pronto) return {estado: 'pronto', ...pronto};
    return {estado: 'texto'};
  },

  cancelarLivro(livroId){
    this.fila = this.fila.filter(f => f.livro.id !== livroId);
    if(this.atual && this.atual.livroId === livroId) this.atual.cancelado = true;
    for(const k of [...this.falhas.keys()]){
      if(String(k).startsWith(`${livroId}:`)) this.falhas.delete(k);
    }
  },

  /* Um capítulo em WAV ocupa dezenas de MB. Guardamos só uma janela em volta
     de onde o leitor está; o resto é apagado para não estourar a cota do
     IndexedDB (era o que derrubava o app depois de alguns trechos). */
  async limparForaDaJanela(livroId, capIdxAtual, antes = 1, depois = 3){
    try{
      const chaves = await bd.chaves('capAudio');
      const pref = `${livroId}:`;
      for(const c of chaves){
        const s = String(c);
        if(!s.startsWith(pref)) continue;
        const idx = Number(s.slice(pref.length));
        if(Number.isNaN(idx)) continue;
        if(idx < capIdxAtual - antes || idx > capIdxAtual + depois){
          await bd.apagar('capAudio', c);
        }
      }
      // frases soltas de capítulos já montados também podem ficar para trás
      const kw = await bd.chaves('wavs');
      for(const c of kw){
        const s = String(c);
        if(!s.startsWith(pref)) continue;
        const idx = Number(s.slice(pref.length).split(':')[0]);
        if(Number.isNaN(idx)) continue;
        if(idx < capIdxAtual - antes || idx > capIdxAtual + depois){
          await bd.apagar('wavs', c);
        }
      }
    }catch{}
  },

  pedir(livro, capIdx){
    if(capIdx < 0 || capIdx >= livro.capitulos.length) return;
    if(!livro.capitulos[capIdx].incluir) return;
    const chave = this.chaveCap(livro.id, capIdx);
    // capítulo que já falhou demais: não insistir para sempre
    if((this.falhas.get(chave) || 0) >= this.MAX_TENTATIVAS) return;
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
      const chave = this.chaveCap(livro.id, capIdx);
      this.atual = {livroId: livro.id, capIdx, cancelado: false};
      try{
        const existente = await bd.obter('capAudio', chave);
        if(existente){
          const frases = frasesDoCapitulo(livro.capitulos[capIdx]);
          // áudio de outra voz ou com nº de frases diferente: refazer
          if(existente.nFrases === frases.length && existente.vozId === piper.vozId) continue;
          await bd.apagar('capAudio', chave);
        }
        await this._gerarCapitulo(livro, capIdx);
        this.falhas.delete(chave);
      }catch(err){
        if(this.atual?.cancelado) continue;
        const msg = String(err?.message || err);
        // Voz incompatível: não adianta repetir em nenhum capítulo deste livro
        if(err?.incompativel){
          this.falhas.set(chave, this.MAX_TENTATIVAS);
          this.fila = this.fila.filter(f => f.livro.id !== livro.id);
          this.aoMudar?.({livroId: livro.id, capIdx, estado: 'erro', erro: msg,
                          definitivo: true, incompativel: true});
          continue;
        }
        const n = (this.falhas.get(chave) || 0) + 1;
        this.falhas.set(chave, n);
        // Sem espaço: liberar capítulos fora da janela e tentar de novo uma vez
        if(/quota|QuotaExceeded|espaço/i.test(msg) && n < this.MAX_TENTATIVAS){
          await this.limparForaDaJanela(livro.id, capIdx, 0, 1);
          this.fila.unshift({livro, capIdx});
          continue;
        }
        this.aoMudar?.({
          livroId: livro.id, capIdx, estado: 'erro', erro: msg,
          definitivo: n >= this.MAX_TENTATIVAS
        });
      }
    }
    this.atual = null;
    this.ativo = false;
  },

  async _gerarCapitulo(livro, capIdx){
    const frases = frasesDoCapitulo(livro.capitulos[capIdx]);
    const prefixo = `${livro.id}:${capIdx}:`;
    // A voz precisa estar mesmo no aparelho antes de sintetizar. Sem esta
    // verificação, o vits-web tenta baixar no meio da geração e a primeira
    // frase estoura o tempo limite (era o caso da voz Edresson).
    const vozAlvo = piper.vozId;
    let temVoz = false;
    try{ temVoz = (await piper.armazenadas()).includes(vozAlvo); }catch{}
    if(!temVoz){
      this.aoMudar?.({livroId: livro.id, capIdx, estado: 'baixando-voz', vozId: vozAlvo});
      await piper.baixar(vozAlvo);
      if(this.atual?.cancelado) return;
    }
    // retomar de onde parou: frases já geradas ficam no banco
    const feitas = new Set((await bd.chaves('wavs')).filter(c => String(c).startsWith(prefixo)));
    for(let i = 0; i < frases.length; i++){
      if(this.atual?.cancelado) return;
      // usuário trocou de voz no meio: abortar esta geração
      if(piper.vozId !== vozAlvo) return;
      const chave = `${prefixo}${i}`;
      if(feitas.has(chave)) continue;
      const buf = await piper.gerar(frases[i].falado);
      if(this.atual?.cancelado) return;
      await bd.salvar('wavs', {chave, buf});
      this.aoMudar?.({livroId: livro.id, capIdx, estado: 'gerando', feito: i + 1, total: frases.length});
    }
    // montar capítulo único lendo do banco uma frase por vez (memória baixa)
    const {wav, mapa, duracao} = await concatenarWavsDoBanco(frases.length, async (i) => {
      const reg = await bd.obter('wavs', `${prefixo}${i}`);
      if(!reg) throw new Error('Frase gerada sumiu do banco.');
      return reg.buf;
    });
    await bd.salvar('capAudio', {chave: this.chaveCap(livro.id, capIdx), wav, mapa, duracao, vozId: vozAlvo, nFrases: frases.length});
    await bd.apagarPrefixo('wavs', prefixo);
    this.aoMudar?.({livroId: livro.id, capIdx, estado: 'pronto', duracao});
  },

  async apagarAudioLivro(livroId){
    await bd.apagarPrefixo('capAudio', `${livroId}:`);
    await bd.apagarPrefixo('wavs', `${livroId}:`);
  }
};

Object.assign(window, {piper, gerador, concatenarWavs, concatenarWavsDoBanco, lerWav, montarWav});
