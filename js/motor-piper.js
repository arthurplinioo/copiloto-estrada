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
    if(typeof Worker === 'undefined'){ this.disponivel = false; return false; }
    try{
      this.worker = new Worker('js/piper-worker.bundle.js');
    }catch{
      // sem marcar indisponível aqui, o app seguia pedindo geração para um
      // worker que não existe e enchia a tela de erro
      this.disponivel = false;
      return false;
    }
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

  async vozes(){
    const r = await this._chamar({tipo: 'vozes'}, 30000);
    this.listaCompleta = !!r.completa;      // false = lista mínima (offline)
    this.incompativeis = r.incompativeis || [];
    return r.lista;
  },
  listaCompleta: false,
  incompativeis: [],
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

  /* Reciclagem do worker — SEMPRE ativa.
     O patch da sessão ONNX (src-worker/piper-worker.src.js) elimina o maior
     vazamento, mas o vits-web ainda instancia um módulo do phonemizador
     (espeak-ng, ~20 MB de WASM+dados) a cada frase e relê o modelo do OPFS,
     e nada disso é liberado explicitamente. Derrubar o worker de tempos em
     tempos é a única forma de devolver essa memória ao sistema.
     Quando o patch está confirmado o acúmulo é bem menor, então espaçamos
     mais as reciclagens; sem ele, apertamos. */
  FRASES_POR_WORKER: 40,
  FRASES_POR_WORKER_SEM_PATCH: 8,
  _geradasNesteWorker: 0,
  _patchConfirmado: false,

  _limiteReciclagem(){
    return this._patchConfirmado ? this.FRASES_POR_WORKER : this.FRASES_POR_WORKER_SEM_PATCH;
  },

  async gerar(texto, timeoutMs = 300000){
    if(this._geradasNesteWorker >= this._limiteReciclagem()){
      this.reiniciar(); // zera _geradasNesteWorker
    }
    const r = await this._chamar({tipo: 'gerar', texto, vozId: this.vozId}, timeoutMs);
    // Só confirma quando o worker avisa que a sessão veio mesmo do cache.
    // A primeira frase de cada worker cria a sessão, então nunca reaproveita.
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
  prontos: new Set(),  // chaveCap já concluída com a voz atual
  MAX_TENTATIVAS: 2,

  chaveCap(livroId, capIdx){ return `${livroId}:${capIdx}`; },

  /* ---------- áudio em BLOCOS ----------
     Antes, o capítulo inteiro virava um WAV só: num capítulo de 360 frases o
     leitor esperava a síntese das 360 antes de ouvir a primeira palavra —
     dezenas de minutos. Agora o capítulo é fatiado em blocos curtos; o bloco 1
     fica pronto em cerca de um minuto e a leitura já começa, enquanto o resto
     é gerado atrás. Também derruba o pico de memória e o tamanho de cada
     registro no banco. */
  TAM_BLOCO: 18,

  chaveBloco(livroId, capIdx, b){ return `${livroId}:${capIdx}:b${b}`; },

  /* Faixas [de, ate] de cada bloco de um capítulo com nFrases frases. */
  blocosDoCapitulo(nFrases){
    const faixas = [];
    for(let de = 0; de < nFrases; de += this.TAM_BLOCO){
      faixas.push({de, ate: Math.min(de + this.TAM_BLOCO, nFrases) - 1});
    }
    return faixas.length ? faixas : [{de: 0, ate: -1}];
  },

  blocoDaFrase(fraseIdx){ return Math.floor(Math.max(0, fraseIdx) / this.TAM_BLOCO); },

  /* Um capítulo está pronto quando TODOS os seus blocos servem. */
  async capituloPronto(livroId, capIdx, nFrases){
    const faixas = this.blocosDoCapitulo(nFrases);
    for(let b = 0; b < faixas.length; b++){
      const reg = await bd.obter('capAudio', this.chaveBloco(livroId, capIdx, b));
      if(!this.audioServe(reg, faixas[b].ate - faixas[b].de + 1)) return false;
    }
    return true;
  },

  /* Um áudio guardado só serve se foi gerado com a MESMA voz, a mesma divisão
     de frases e a mesma preferência de leitura de citações. Sem checar a
     última, desligar "não ler referências" deixava todos os outros livros
     lendo "(SILVA, 2020)" para sempre — o nº de frases não muda, então nada
     percebia a diferença. */
  _semCitacoesAgora(){ return window.PULAR_CITACOES !== false; },
  audioServe(reg, nFrases){
    if(!reg) return false;
    if(reg.nFrases !== nFrases) return false;
    if(reg.vozId !== piper.vozId) return false;
    // registros antigos não têm o campo: tratar como "gerado com o padrão"
    const gravado = reg.semCitacoes !== undefined ? reg.semCitacoes : true;
    return gravado === this._semCitacoesAgora();
  },

  async estadoCap(livroId, capIdx){
    const pronto = await bd.obter('capAudio', this.chaveCap(livroId, capIdx));
    if(pronto) return {estado: 'pronto', ...pronto};
    return {estado: 'texto'};
  },

  cancelarLivro(livroId){
    this.fila = this.fila.filter(f => f.livro.id !== livroId);
    if(this.atual && this.atual.livroId === livroId) this.atual.cancelado = true;
    // Um preparo completo em andamento DESTE livro também tem de parar. Sem
    // isto ele seguia gerando (e reportava "completo") depois de o usuário
    // trocar de voz, mexer nas citações ou apagar o livro da estante.
    if(this.preparandoTudo && this.livroPreparando === livroId) this.cancelarPreparo = true;
    this._esquecer(livroId);
  },

  /* Tira do cache de estado tudo que pertence a um livro (ou a um capítulo).
     'prontos' precisa acompanhar o que existe no banco, senão o gerador acha
     que um capítulo apagado continua pronto e nunca mais o refaz. */
  _esquecer(livroId, capIdx){
    const alvo = capIdx == null ? `${livroId}:` : this.chaveCap(livroId, capIdx);
    const bate = (k) => capIdx == null ? String(k).startsWith(alvo) : String(k) === alvo;
    for(const k of [...this.falhas.keys()]) if(bate(k)) this.falhas.delete(k);
    for(const k of [...this.prontos]) if(bate(k)) this.prontos.delete(k);
  },

  /* Um capítulo em WAV ocupa dezenas de MB. Guardamos só uma janela em volta
     de onde o leitor está; o resto é apagado para não estourar a cota do
     IndexedDB (era o que derrubava o app depois de alguns trechos). */
  async limparForaDaJanela(livroId, capIdxAtual, antes = 1, depois = 3, preservar = null, forcar = false){
    // Durante "preparar livro inteiro" a janela não vale: ela apagaria
    // exatamente os capítulos que acabamos de gerar para a viagem.
    if(this.preparandoTudo && !forcar) return;
    // Livro preparado por inteiro: preservar, salvo em emergência de espaço.
    if(this.livrosPreparados.has(livroId) && !forcar) return;
    try{
      const pref = `${livroId}:`;
      // 'preservar': capítulo em geração agora. Suas frases já sintetizadas não
      // podem cair na varredura, senão a retentativa recomeça do zero.
      const fora = (idx) => idx !== preservar &&
        (idx < capIdxAtual - antes || idx > capIdxAtual + depois);

      // Chaves são "livro:cap" (formato antigo) e "livro:cap:bN" (blocos): em
      // ambos o capítulo é o 1º segmento depois do prefixo. Ler a chave inteira
      // como número dava NaN nas de bloco, e elas nunca eram apagadas.
      for(const c of await bd.chaves('capAudio')){
        const s = String(c);
        if(!s.startsWith(pref)) continue;
        const idx = Number(s.slice(pref.length).split(':')[0]);
        if(Number.isNaN(idx) || !fora(idx)) continue;
        await bd.apagar('capAudio', c);
        this.prontos.delete(s);
      }
      // frases soltas de capítulos já montados também podem ficar para trás
      for(const c of await bd.chaves('wavs')){
        const s = String(c);
        if(!s.startsWith(pref)) continue;
        const idx = Number(s.slice(pref.length).split(':')[0]);
        if(Number.isNaN(idx) || !fora(idx)) continue;
        await bd.apagar('wavs', c);
      }
      // Podar 'prontos' pela faixa, não só pelo que foi apagado agora: assim o
      // cache nunca fica afirmando que existe áudio que já saiu do banco por
      // outro caminho — o gerador se recusaria a refazer o capítulo.
      for(const k of [...this.prontos]){
        const s = String(k);
        if(!s.startsWith(pref)) continue;
        const idx = Number(s.slice(pref.length).split(':')[0]);
        if(!Number.isNaN(idx) && fora(idx)) this.prontos.delete(s);
      }
    }catch{}
  },

  /* Só limpa os outros livros se o armazenamento estiver apertado. Apagar a
     cada troca de livro faria o leitor que alterna entre dois títulos perder
     horas de áudio já gerado toda vez. */
  async limparOutrosLivrosSePreciso(livroAtualId, limiar = 0.6){
    // Nunca varrer enquanto um preparo completo está rodando: apagaria
    // exatamente o livro que está sendo gerado para a viagem.
    if(this.preparandoTudo) return false;
    try{
      const est = await navigator.storage?.estimate?.();
      if(est?.usage && est?.quota && est.usage / est.quota < limiar) return false;
    }catch{ /* sem estimativa: seguir com a limpeza, é o lado seguro */ }
    await this.limparOutrosLivros(livroAtualId);
    return true;
  },

  /* Áudio de livros que não estão sendo lidos: dezenas ou centenas de MB que
     ficavam presos até o livro ser apagado da estante. */
  async limparOutrosLivros(livroAtualId){
    try{
      for(const loja of ['capAudio', 'wavs']){
        for(const c of await bd.chaves(loja)){
          const s = String(c);
          if(!s.startsWith(`${livroAtualId}:`)){
            await bd.apagar(loja, c);
            this.prontos.delete(s);
            const dono = s.split(':')[0];
            if(this.livrosPreparados.delete(dono)) this._salvarPreparados();
          }
        }
      }
    }catch{}
  },

  pedir(livro, capIdx){
    if(capIdx < 0 || capIdx >= livro.capitulos.length) return;
    if(!livro.capitulos[capIdx].incluir) return;
    const chave = this.chaveCap(livro.id, capIdx);
    // Já concluído nesta sessão: NÃO reenfileirar. Sem esta guarda, o aviso de
    // "pronto" fazia o app reagendar o mesmo capítulo, que ficava pronto de
    // novo, num laço infinito que relia dezenas de MB a cada volta.
    if(this.prontos.has(chave)) return;
    // capítulo que já falhou demais: não insistir para sempre
    if((this.falhas.get(chave) || 0) >= this.MAX_TENTATIVAS) return;
    if(this.fila.some(f => this.chaveCap(f.livro.id, f.capIdx) === chave)) return;
    if(this.atual && this.chaveCap(this.atual.livroId, this.atual.capIdx) === chave) return;
    this.fila.push({livro, capIdx});
    // sem o catch, uma falha aqui virava unhandledrejection e acionava a rede
    // de segurança do app no meio de uma troca de capítulo
    this._rodar().catch(err => console.error('[copiloto:gerador]', err));
  },

  // Capítulo em que o leitor está agora — a limpeza de emergência por falta de
  // espaço precisa preservar a vizinhança DELE, não a do capítulo em geração.
  capLendo: 0,
  frasLendo: 0,   // frase em que o leitor está, para gerar aquele bloco antes

  /* ---------- preparar o livro inteiro ----------
     No iOS a geração só roda com o app aberto na frente, então deixar o livro
     pronto antes de viajar não é conforto: é o que faz o app servir no carro.
     Enquanto 'preparandoTudo' está ligado, a limpeza por janela é suspensa —
     senão ela apagaria justamente o que acabamos de gerar. */
  preparandoTudo: false,
  aoPreparar: null,     // callback de progresso da preparação completa
  // Livros que o usuário mandou preparar por inteiro. A limpeza por janela não
  // encosta neles: senão o áudio da viagem seria apagado no primeiro capítulo
  // que ele ouvisse. Só a emergência real de espaço (forcar=true) os toca.
  livrosPreparados: new Set(),

  async carregarPreparados(){
    try{
      const c = await bd.obter('config', 'livrosPreparados');
      if(Array.isArray(c?.valor)) this.livrosPreparados = new Set(c.valor);
    }catch{}
  },
  async _salvarPreparados(){
    try{
      await bd.salvar('config', {chave: 'livrosPreparados', valor: [...this.livrosPreparados]});
    }catch{}
  },
  async marcarPreparado(livroId, sim = true){
    if(sim) this.livrosPreparados.add(livroId);
    else this.livrosPreparados.delete(livroId);
    await this._salvarPreparados();
  },

  /* Estimativa de espaço: o WAV é cru, 22050 Hz 16 bits mono ≈ 2,6 MB por
     minuto de fala. Serve para avisar antes de encher o aparelho. */
  estimarBytesLivro(livro){
    let palavras = 0;
    for(const c of livro.capitulos){
      if(c.incluir === false) continue;
      palavras += contarPalavras(c.texto || '');
    }
    const minutos = palavras / 165;          // ritmo de leitura em voz alta
    return Math.round(minutos * 2.6 * 1048576);
  },

  async espacoLivre(){
    try{
      const e = await navigator.storage?.estimate?.();
      if(e?.quota && e?.usage != null) return {livre: e.quota - e.usage, uso: e.usage, cota: e.quota};
    }catch{}
    return null;
  },

  /* Gera todos os capítulos incluídos, do atual em diante e depois os
     anteriores. Para sozinho se o espaço acabar, dizendo até onde foi. */
  async prepararLivroInteiro(livro, capInicial = 0){
    if(this.preparandoTudo) return {status: 'ja-rodando'};
    // Esperar a fila normal terminar e tomar o lugar dela: duas gerações em
    // paralelo embaralhariam this.atual e o cancelamento.
    for(let i = 0; this.ativo && i < 600; i++) await new Promise(r => setTimeout(r, 100));
    if(this.ativo) return {status: 'ocupado'};
    this.preparandoTudo = true;
    this.livroPreparando = livro.id;
    this.ativo = true;
    this.cancelarPreparo = false;
    this.fila = [];
    try{
      const inc = livro.capitulos
        .map((c, i) => (c.incluir === false ? -1 : i))
        .filter(i => i >= 0);
      const pos = Math.max(0, inc.indexOf(capInicial));
      const ordem = [...inc.slice(pos), ...inc.slice(0, pos)]; // do ponto atual em diante
      let feitos = 0, pulados = 0;

      for(const capIdx of ordem){
        if(this.cancelarPreparo) break;
        const chave = this.chaveCap(livro.id, capIdx);
        if(this.prontos.has(chave)){ feitos++; this.aoPreparar?.({feitos, total: ordem.length, capIdx, estado: 'pronto'}); continue; }

        // pronto = todos os blocos do capítulo servem
        if(await this.capituloPronto(livro.id, capIdx,
             frasesDoCapitulo(livro.capitulos[capIdx]).length)){
          this.prontos.add(chave);
          feitos++;
          this.aoPreparar?.({feitos, total: ordem.length, capIdx, estado: 'pronto'});
          continue;
        }

        // espaço apertado: parar com dignidade em vez de estourar
        const esp = await this.espacoLivre();
        if(esp && esp.livre < 80 * 1048576){
          this.aoPreparar?.({feitos, total: ordem.length, estado: 'sem-espaco'});
          return {status: 'sem-espaco', feitos, total: ordem.length};
        }

        this.aoPreparar?.({feitos, total: ordem.length, capIdx, estado: 'gerando'});
        // _gerarCapitulo lê this.atual para saber se foi cancelado
        this.atual = {livroId: livro.id, capIdx, cancelado: false};
        try{
          await this._gerarCapitulo(livro, capIdx);
          if(this.atual?.cancelado) break;
          this.prontos.add(chave);
          this.falhas.delete(chave);
          feitos++;
        }catch(err){
          // Cancelado no meio (troca de voz, livro apagado): a falha aqui é
          // consequência do cancelamento, não um capítulo ruim. Sair.
          if(this.cancelarPreparo || this.atual?.cancelado) break;
          const msg = String(err?.message || err);
          if(err?.incompativel){
            this.aoPreparar?.({feitos, total: ordem.length, estado: 'erro', erro: msg, incompativel: true});
            return {status: 'incompativel', feitos, total: ordem.length};
          }
          if(/quota|QuotaExceeded|espaço/i.test(msg)){
            this.aoPreparar?.({feitos, total: ordem.length, estado: 'sem-espaco'});
            return {status: 'sem-espaco', feitos, total: ordem.length};
          }
          pulados++;
        }
        this.aoPreparar?.({feitos, total: ordem.length, capIdx, estado: 'pronto'});
      }
      // 'completo' exige ter percorrido TODOS os capítulos sem cancelamento —
      // antes um cancelamento saía pelo break e ainda dizia "completo".
      const cancelado = this.cancelarPreparo || this.atual?.cancelado;
      const status = cancelado ? 'cancelado'
        : (feitos < ordem.length || pulados) ? 'parcial' : 'completo';
      this.aoPreparar?.({feitos, total: ordem.length, estado: status, pulados});
      return {status, feitos, total: ordem.length, pulados};
    }finally{
      this.preparandoTudo = false;
      this.livroPreparando = null;
      this.atual = null;
      this.ativo = false;
      // A fila normal encheu enquanto o lock estava tomado e ficou parada;
      // destravar agora para o capítulo atual não esperar um novo pedido.
      if(this.fila.length) this._rodar().catch(() => {});
    }
  },

  livroPreparando: null,

  cancelarPreparo: false,
  pararPreparo(){
    this.cancelarPreparo = true;
    if(this.atual) this.atual.cancelado = true;
  },

  async _rodar(){
    if(this.ativo) return;
    this.ativo = true;
    try{
      await this._laco();
    }finally{
      // sem isto, uma exceção escapando do laço travava a geração para sempre
      this.atual = null;
      this.ativo = false;
    }
  },

  async _laco(){
    while(this.fila.length){
      const {livro, capIdx} = this.fila.shift();
      const chave = this.chaveCap(livro.id, capIdx);
      this.atual = {livroId: livro.id, capIdx, cancelado: false};
      try{
        const frases = frasesDoCapitulo(livro.capitulos[capIdx]);
        // Pronto = todos os blocos servem (mesma voz, mesma divisão de frases,
        // mesma preferência de citações).
        if(await this.capituloPronto(livro.id, capIdx, frases.length)){
          // Já estava pronto de uma sessão anterior. Avisar mesmo assim: sem
          // este aviso o app nunca trocava da voz do sistema para a neural
          // num capítulo cujo áudio já existia no banco.
          this.falhas.delete(chave);
          this.prontos.add(chave); // impede reenfileiramento em laço
          this.aoMudar?.({livroId: livro.id, capIdx, estado: 'pronto', jaExistia: true});
          continue;
        }
        await this._gerarCapitulo(livro, capIdx);
        this.falhas.delete(chave);
        this.prontos.add(chave);
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
        // Sem espaço: liberar o que dá e tentar de novo uma vez. A janela é
        // centrada em ONDE O LEITOR ESTÁ — centrar no capítulo em geração
        // (que vai até 2 à frente) apagava o áudio do capítulo tocando agora.
        if(/quota|QuotaExceeded|espaço/i.test(msg) && n < this.MAX_TENTATIVAS){
          // forcar=true: emergência de espaço passa por cima da preservação
          await this.limparForaDaJanela(livro.id, this.capLendo, 0, 1, capIdx, true);
          await this.limparOutrosLivros(livro.id);
          // o livro deixou de estar inteiro em disco
          await this.marcarPreparado(livro.id, false);
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
    // Gerar BLOCO A BLOCO e publicar cada um assim que fica pronto: o leitor
    // começa a ouvir no primeiro, sem esperar o capítulo inteiro.
    const faixas = this.blocosDoCapitulo(frases.length);
    const feitas = new Set((await bd.chaves('wavs')).filter(c => String(c).startsWith(prefixo)));
    // ordem: começar pelo bloco onde o leitor está, para ele ouvir antes
    const inicio = (this.capLendo === capIdx) ? this.blocoDaFrase(this.frasLendo || 0) : 0;
    const ordem = [];
    for(let k = 0; k < faixas.length; k++) ordem.push((inicio + k) % faixas.length);

    let feitosNoCap = 0;
    for(const b of ordem){
      if(this.atual?.cancelado) return;
      if(piper.vozId !== vozAlvo) return;
      const {de, ate} = faixas[b];
      const chaveB = this.chaveBloco(livro.id, capIdx, b);
      const nDoBloco = ate - de + 1;

      if(this.audioServe(await bd.obter('capAudio', chaveB), nDoBloco)){
        feitosNoCap += nDoBloco;
        continue; // bloco já pronto de uma sessão anterior
      }

      for(let i = de; i <= ate; i++){
        if(this.atual?.cancelado) return;
        if(piper.vozId !== vozAlvo) return;
        const chave = `${prefixo}${i}`;
        if(!feitas.has(chave)){
          const buf = await piper.gerar(frases[i].falado);
          if(this.atual?.cancelado) return;
          await bd.salvar('wavs', {chave, buf});
        }
        feitosNoCap++;
        this.aoMudar?.({livroId: livro.id, capIdx, estado: 'gerando',
                        feito: feitosNoCap, total: frases.length,
                        bloco: b, nBlocos: faixas.length});
      }

      const {wav, mapa, duracao} = await concatenarWavsDoBanco(nDoBloco, async (k) => {
        const reg = await bd.obter('wavs', `${prefixo}${de + k}`);
        if(!reg) throw new Error('Frase gerada sumiu do banco.');
        return reg.buf;
      });
      await bd.salvar('capAudio', {
        chave: chaveB, wav, mapa, duracao,
        vozId: vozAlvo, nFrases: nDoBloco,
        semCitacoes: this._semCitacoesAgora(),
        de, ate, bloco: b, nBlocos: faixas.length, nFrasesCap: frases.length
      });
      for(let i = de; i <= ate; i++) await bd.apagar('wavs', `${prefixo}${i}`);
      // avisa o app: já dá para tocar este pedaço
      this.aoMudar?.({livroId: livro.id, capIdx, estado: 'bloco-pronto',
                      bloco: b, nBlocos: faixas.length, de, ate, duracao});
    }
    this.aoMudar?.({livroId: livro.id, capIdx, estado: 'pronto', nBlocos: faixas.length});
  },

  async apagarAudioLivro(livroId){
    this._esquecer(livroId);
    await this.marcarPreparado(livroId, false); // já não está inteiro em disco
    await bd.apagarPrefixo('capAudio', `${livroId}:`);
    await bd.apagarPrefixo('wavs', `${livroId}:`);
  }
};

Object.assign(window, {piper, gerador, concatenarWavs, concatenarWavsDoBanco, lerWav, montarWav});
