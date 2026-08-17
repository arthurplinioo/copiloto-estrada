'use strict';
/* Copiloto de Estrada — aplicação principal.
   Duas vias de leitura:
   1) Piper (neural, natural): capítulo vira um arquivo de áudio único →
      toca com tela apagada, tela de bloqueio e CarPlay.
   2) Sistema (speechSynthesis): imediata, sem download, mas exige tela ligada
      no iOS. Usada como fallback e enquanto o Piper gera.
   Progresso é sagrado: salvo a cada frase, nos dois modos. */

const $ = (id) => document.getElementById(id);

function fmtMin(min){ if(!isFinite(min) || min <= 0) return ''; if(min < 60) return `${Math.round(min)} min`; const h = Math.floor(min / 60); return `${h} h ${Math.round(min % 60)} min`; }
async function gerarId(nome, tamanho){
  try{
    const dados = new TextEncoder().encode(`${nome}|${tamanho}`);
    const hash = await crypto.subtle.digest('SHA-256', dados);
    return [...new Uint8Array(hash)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
  }catch{ return `${nome}-${tamanho}`.replace(/[^\w-]+/g, '_').slice(0, 60); }
}

/* =====================================================================
   Estado global
   ===================================================================== */
const estado = {
  tela: 'biblioteca',
  livros: [],
  progresso: new Map(),
  // preparo
  bruto: null,
  arquivoInfo: null,
  regras: {...REGRAS_PADRAO},
  limpo: null,
  // player
  livro: null,
  capIdx: 0,
  fraseIdx: 0,
  frases: [],
  tocando: false,
  modoAudio: false,       // true = tocando capítulo Piper pelo <audio>
  pausadoEm: 0,
  timerDormir: null,
  wakeLock: null,
  motor: 'piper',         // preferência: 'piper' | 'sistema'
  vozPiperPronta: false,
  urlAudioAtual: null,
  mapaAtual: null,
  urlsCapas: new Map()
};

// Elemento de áudio ÚNICO da sessão (recriar quebra a permissão no iOS)
const audioEl = new Audio();
audioEl.preload = 'auto';

/* =====================================================================
   Wake lock (necessário só para o motor do sistema e Modo Estrada)
   ===================================================================== */
async function pedirWakeLock(){
  try{ if('wakeLock' in navigator) estado.wakeLock = await navigator.wakeLock.request('screen'); }catch{}
}
function soltarWakeLock(){
  try{ estado.wakeLock?.release(); }catch{}
  estado.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && ((estado.tocando && !estado.modoAudio) || estradaAberta())) pedirWakeLock();
  if(document.visibilityState === 'hidden') salvarProgressoAgora();
});

/* =====================================================================
   Progresso
   ===================================================================== */
let salvandoProgresso = false, salvarPendente = false;
async function salvarProgressoAgora(){
  if(!estado.livro) return;
  if(salvandoProgresso){ salvarPendente = true; return; }
  salvandoProgresso = true;
  try{
    const reg = {
      livroId: estado.livro.id,
      capIdx: estado.capIdx,
      fraseIdx: estado.fraseIdx,
      totalFrasesCap: estado.frases.length,
      atualizadoEm: Date.now()
    };
    estado.progresso.set(estado.livro.id, reg);
    await bd.salvar('progresso', reg);
    await bd.salvar('config', {chave: 'ultimoLivro', valor: estado.livro.id});
  }catch{}
  salvandoProgresso = false;
  if(salvarPendente){ salvarPendente = false; salvarProgressoAgora(); }
}

/* =====================================================================
   Navegação de telas
   ===================================================================== */
function mostrarTela(nome){
  estado.tela = nome;
  for(const t of ['biblioteca', 'preparo', 'player']) $(`tela-${t}`).classList.toggle('oculto', nome !== t);
}

/* =====================================================================
   Capas
   ===================================================================== */
function urlCapa(livro){
  if(!livro.capa) return null;
  if(!estado.urlsCapas.has(livro.id)) estado.urlsCapas.set(livro.id, URL.createObjectURL(livro.capa));
  return estado.urlsCapas.get(livro.id);
}
function corCapa(livro){
  let h = 0;
  for(const c of livro.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 38% 34%)`;
}
function elCapa(livro, classe){
  const div = document.createElement('div');
  div.className = classe;
  const url = urlCapa(livro);
  if(url){
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    div.appendChild(img);
  } else {
    div.style.background = `linear-gradient(160deg, ${corCapa(livro)}, #1c1a16)`;
    const t = document.createElement('span');
    t.textContent = livro.titulo;
    div.appendChild(t);
  }
  return div;
}

/* =====================================================================
   Biblioteca
   ===================================================================== */
function indicesIncluidos(livro){
  return livro.capitulos.map((c, i) => c.incluir !== false ? i : -1).filter(i => i >= 0);
}
function pctLivro(livro){
  const p = estado.progresso.get(livro.id);
  if(!p) return 0;
  const inc = indicesIncluidos(livro);
  if(!inc.length) return 0;
  const pos = Math.max(0, inc.indexOf(p.capIdx));
  const fracao = p.totalFrasesCap ? Math.min(1, p.fraseIdx / p.totalFrasesCap) : 0;
  return Math.min(100, Math.round(((pos + fracao) / inc.length) * 100));
}

function desenharBiblioteca(){
  const ul = $('lista-livros');
  ul.innerHTML = '';
  const ordenados = [...estado.livros].sort((a, b) => {
    const pa = estado.progresso.get(a.id)?.atualizadoEm || a.criadoEm || 0;
    const pb = estado.progresso.get(b.id)?.atualizadoEm || b.criadoEm || 0;
    return pb - pa;
  });
  for(const livro of ordenados){
    const li = document.createElement('li');
    li.className = 'cartao-livro';
    const pct = pctLivro(livro);
    li.appendChild(elCapa(livro, 'capa'));
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `
      <div class="titulo"></div>
      <div class="autor"></div>
      <div class="meta"><span class="selo">${livro.tipo}</span><span>${indicesIncluidos(livro).length} cap.</span><span>${fmtMin(livro.palavras / 170)}</span></div>
      <div class="barra-prog"><i style="width:${pct}%"></i></div>
      <div class="acoes-livro">
        <button class="btn btn-primario btn-ouvir">Ouvir${pct > 0 && pct < 100 ? ` · ${pct}%` : ''}</button>
        <button class="btn btn-quieto btn-apagar" aria-label="Apagar livro">Apagar</button>
      </div>`;
    info.querySelector('.titulo').textContent = livro.titulo;
    info.querySelector('.autor').textContent = livro.autor || '';
    info.querySelector('.btn-ouvir').addEventListener('click', () => abrirLivro(livro.id));
    info.querySelector('.btn-apagar').addEventListener('click', async () => {
      if(!confirm(`Apagar "${livro.titulo}" e o áudio gerado?`)) return;
      gerador.cancelarLivro(livro.id);
      await bd.apagar('livros', livro.id);
      await bd.apagar('progresso', livro.id);
      await gerador.apagarAudioLivro(livro.id);
      estado.livros = estado.livros.filter(l => l.id !== livro.id);
      estado.progresso.delete(livro.id);
      desenharBiblioteca();
      desenharContinuar();
    });
    li.appendChild(info);
    ul.appendChild(li);
  }
  $('biblioteca-vazia').classList.toggle('oculto', estado.livros.length > 0);
}

async function desenharContinuar(){
  const alvo = $('continuar-card');
  alvo.innerHTML = '';
  const cfg = await bd.obter('config', 'ultimoLivro');
  if(!cfg?.valor) return;
  const livro = estado.livros.find(l => l.id === cfg.valor);
  if(!livro) return;
  const p = estado.progresso.get(livro.id);
  if(!p) return;
  const div = document.createElement('div');
  div.className = 'painel continuar';
  div.appendChild(elCapa(livro, 'capa capa-mini'));
  const info = document.createElement('div');
  info.className = 'cont-info';
  info.innerHTML = `<span class="rotulo">Continuar de onde parou</span><b></b>
    <div class="meta-cont">Capítulo ${p.capIdx + 1} · ${pctLivro(livro)}%</div>`;
  info.querySelector('b').textContent = livro.titulo;
  const btn = document.createElement('button');
  btn.className = 'btn btn-primario';
  btn.textContent = 'Continuar';
  btn.addEventListener('click', () => abrirLivro(livro.id));
  div.appendChild(info);
  div.appendChild(btn);
  alvo.appendChild(div);
}

/* =====================================================================
   Preparo (limpeza + amostra + seleção de capítulos)
   ===================================================================== */
function nomesRegras(tipo){
  const todas = [
    {id: 'miolo', nome: 'Ler só o miolo do livro', desc: 'Pula sumário, ficha catalográfica, créditos, referências bibliográficas e afins.', tipos: ['pdf', 'txt', 'epub']},
    {id: 'cabecalhos', nome: 'Remover cabeçalhos e rodapés repetidos', desc: 'Linhas que se repetem no topo ou no pé de muitas páginas.', tipos: ['pdf']},
    {id: 'numeros', nome: 'Remover números de página', desc: 'Linhas que são só um número, "Página 12", "12 de 300".', tipos: ['pdf', 'txt']},
    {id: 'notas', nome: 'Remover notas de rodapé', desc: 'Blocos de fonte menor no pé da página.', tipos: ['pdf']},
    {id: 'hifen', nome: 'Juntar palavras hifenizadas', desc: '"compa-nheiro" quebrado no fim da linha vira "companheiro".', tipos: ['pdf', 'txt', 'epub']},
    {id: 'paragrafos', nome: 'Remontar parágrafos', desc: 'Quebras visuais de linha viram texto corrido natural.', tipos: ['pdf', 'txt']}
  ];
  return todas.filter(r => r.tipos.includes(tipo));
}

function reprocessar(){
  if(!estado.bruto) return;
  estado.limpo = executarLimpeza(estado.bruto, estado.regras);
  desenharPreparo();
}

function desenharPreparo(){
  const {capitulos, contagens} = estado.limpo;
  const incluidos = capitulos.filter(c => c.incluir !== false);
  const palavras = incluidos.reduce((s, c) => s + contarPalavras(c.texto), 0);
  $('grade-stats').innerHTML = `
    <div class="stat"><b>${incluidos.length}</b><span>capítulos lidos</span></div>
    <div class="stat"><b>${capitulos.length - incluidos.length}</b><span>pulados</span></div>
    <div class="stat"><b>${palavras.toLocaleString('pt-BR')}</b><span>palavras</span></div>
    <div class="stat"><b>${fmtMin(palavras / 170)}</b><span>de áudio (≈)</span></div>`;

  const lista = $('lista-regras');
  lista.innerHTML = '';
  for(const r of nomesRegras(estado.bruto.tipo)){
    const div = document.createElement('div');
    div.className = 'regra';
    const qtd = contagens[r.id] || 0;
    div.innerHTML = `
      <input type="checkbox" id="regra-${r.id}" ${estado.regras[r.id] ? 'checked' : ''}>
      <label for="regra-${r.id}"><div>${r.nome}</div><div class="desc">${r.desc}</div></label>
      <span class="qtd">${estado.regras[r.id] ? qtd.toLocaleString('pt-BR') : '—'}</span>`;
    div.querySelector('input').addEventListener('change', (e) => {
      estado.regras[r.id] = e.target.checked;
      reprocessar();
    });
    lista.appendChild(div);
  }

  // seleção de capítulos
  const lc = $('lista-capitulos');
  lc.innerHTML = '';
  capitulos.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'cap-item' + (c.incluir === false ? ' pulado' : '');
    div.innerHTML = `
      <input type="checkbox" id="cap-${i}" ${c.incluir !== false ? 'checked' : ''}>
      <label for="cap-${i}"><span class="cap-titulo"></span>
        <span class="cap-meta">${contarPalavras(c.texto).toLocaleString('pt-BR')} palavras${c.motivo ? ` · ${c.motivo}` : ''}</span></label>`;
    div.querySelector('.cap-titulo').textContent = `${i + 1}. ${c.titulo}`;
    div.querySelector('input').addEventListener('change', (e) => {
      c.incluir = e.target.checked;
      div.classList.toggle('pulado', !c.incluir);
      desenharPreparo();
    });
    lc.appendChild(div);
  });

  const inicio = incluidos.slice(0, 3).map(c => `【${c.titulo}】\n\n${c.texto.slice(0, 700)}`).join('\n\n· · ·\n\n');
  $('amostra-texto').textContent = inicio.slice(0, 2400) + (palavras > 400 ? '\n\n(…)' : '');
}

async function iniciarPreparo(arquivo){
  mostrarTela('preparo');
  $('preparo-conteudo').classList.add('oculto');
  $('preparo-erro').innerHTML = '';
  $('parse-andamento').classList.remove('oculto');
  const aoProgresso = (feito, total, etapa) => {
    $('parse-etapa').textContent = etapa || 'Lendo arquivo…';
    const pct = total ? Math.round((feito / total) * 100) : 0;
    $('parse-barra').value = pct;
    $('parse-pct').textContent = pct + '%';
  };
  try{
    const ext = arquivo.name.toLowerCase().split('.').pop();
    let bruto;
    if(ext === 'pdf') bruto = await importarPdf(arquivo, aoProgresso);
    else if(ext === 'epub') bruto = await importarEpub(arquivo, aoProgresso);
    else if(ext === 'txt') bruto = await importarTxt(arquivo);
    else throw new Error('Formato não suportado. Envie PDF, EPUB ou TXT.');
    estado.bruto = bruto;
    estado.arquivoInfo = {nome: arquivo.name, tamanho: arquivo.size};
    estado.regras = {...REGRAS_PADRAO};
    estado.limpo = executarLimpeza(bruto, estado.regras);
    $('campo-titulo').value = bruto.tituloSugerido;
    $('parse-andamento').classList.add('oculto');
    $('preparo-conteudo').classList.remove('oculto');
    desenharPreparo();
  }catch(err){
    $('parse-andamento').classList.add('oculto');
    $('preparo-erro').innerHTML = `<div class="aviso aviso-erro"></div>`;
    $('preparo-erro').firstElementChild.textContent =
      'Não consegui preparar este arquivo. ' + (err?.message || err);
  }
}

async function salvarLivro(){
  const {capitulos} = estado.limpo;
  const incluidos = capitulos.filter(c => c.incluir !== false);
  if(!incluidos.length){
    $('preparo-erro').innerHTML = `<div class="aviso aviso-erro">Marque ao menos um capítulo para incluir na leitura.</div>`;
    return;
  }
  const palavras = incluidos.reduce((s, c) => s + contarPalavras(c.texto), 0);
  const id = await gerarId(estado.arquivoInfo.nome, estado.arquivoInfo.tamanho);
  const livro = {
    id,
    titulo: $('campo-titulo').value.trim() || estado.bruto.tituloSugerido,
    autor: estado.bruto.autor || '',
    tipo: estado.bruto.tipo,
    capa: estado.bruto.capa || null,
    capitulos,
    palavras,
    criadoEm: Date.now()
  };
  try{
    await bd.salvar('livros', livro);
  }catch(err){
    $('aviso-armazenamento').innerHTML = `<div class="aviso aviso-erro">Não consegui gravar o livro no aparelho (armazenamento cheio ou bloqueado). Ele ficará disponível só nesta sessão.</div>`;
  }
  const existente = estado.livros.findIndex(l => l.id === id);
  if(existente >= 0) estado.livros[existente] = livro; else estado.livros.push(livro);
  if(estado.urlsCapas.has(id)){ URL.revokeObjectURL(estado.urlsCapas.get(id)); estado.urlsCapas.delete(id); }
  await gerador.apagarAudioLivro(id); // reimportação invalida áudio antigo
  estado.bruto = null; estado.limpo = null;
  abrirLivro(id);
}

/* =====================================================================
   Player — comum aos dois motores
   ===================================================================== */
function capAtualIncluido(){
  const inc = indicesIncluidos(estado.livro);
  if(!inc.length) return 0;
  return inc.includes(estado.capIdx) ? estado.capIdx : inc[0];
}
function proximoCapIncluido(dir){
  const inc = indicesIncluidos(estado.livro);
  const pos = inc.indexOf(estado.capIdx);
  const novo = inc[pos + dir];
  return novo === undefined ? -1 : novo;
}

function prepararCapitulo(){
  estado.frases = frasesDoCapitulo(estado.livro.capitulos[estado.capIdx]);
  if(estado.fraseIdx >= estado.frases.length) estado.fraseIdx = 0;
  desenharCapitulo();
  atualizarMediaSession();
  atualizarEstadoAudioUI();
}

function desenharCapitulo(){
  const alvo = $('texto-leitura');
  alvo.innerHTML = '';
  // NaN como sentinela: qualquer índice de parágrafo difere dele. Usar -1 aqui
  // colidia com o parágrafo do título do capítulo e deixava pEl nulo.
  let parAtual = NaN, pEl = null;
  estado.frases.forEach((f, i) => {
    if(f.par !== parAtual || !pEl){
      parAtual = f.par;
      pEl = document.createElement(f.titulo ? 'h3' : 'p');
      alvo.appendChild(pEl);
    }
    const span = document.createElement('span');
    span.className = 'frase';
    span.dataset.i = i;
    span.textContent = f.texto + ' ';
    span.addEventListener('click', () => irParaFrase(i));
    pEl.appendChild(span);
  });
  marcarFrase();
}

function marcarFrase(){
  if(!estado.livro) return;
  const alvo = $('texto-leitura');
  alvo.querySelectorAll('.frase.atual').forEach(e => e.classList.remove('atual'));
  const span = alvo.querySelector(`.frase[data-i="${estado.fraseIdx}"]`);
  if(span){
    span.classList.add('atual');
    span.scrollIntoView({block: 'center', behavior: 'auto'});
  }
  $('estrada-frase').textContent = estado.frases[estado.fraseIdx]?.texto || '';
  const pct = estado.frases.length ? Math.round((estado.fraseIdx / estado.frases.length) * 100) : 0;
  $('estrada-barra').style.width = pct + '%';
  const inc = indicesIncluidos(estado.livro);
  $('estrada-cap-info').textContent = `Cap. ${inc.indexOf(estado.capIdx) + 1}/${inc.length} · ${pct}%`;
  const restantes = estado.frases.slice(estado.fraseIdx);
  const palavrasRest = restantes.reduce((s, f) => s + contarPalavras(f.texto), 0);
  $('tempo-restante').textContent = palavrasRest ? `${fmtMin(palavrasRest / (170 * taxaAtual()))} restantes no capítulo` : '';
}

function taxaAtual(){ return estado.modoAudio ? audioEl.playbackRate : falaSistema.taxa; }

function atualizarIconePlay(){
  const icone = estado.tocando ? '❚❚' : '▶';
  $('btn-play').textContent = icone;
  $('estrada-play').textContent = icone;
}

/* ---------- via Piper (arquivo de áudio) ---------- */
async function tentarModoAudio(){
  if(estado.motor !== 'piper' || !piper.disponivel || !estado.vozPiperPronta || !estado.livro) return false;
  const chaveAudio = gerador.chaveCap(estado.livro.id, estado.capIdx);
  const reg = await bd.obter('capAudio', chaveAudio);
  if(!reg) return false;
  if(reg.nFrases !== estado.frases.length){
    await bd.apagar('capAudio', chaveAudio);
    agendarGeracao();
    return false;
  }
  if(estado.urlAudioAtual) URL.revokeObjectURL(estado.urlAudioAtual);
  estado.urlAudioAtual = URL.createObjectURL(new Blob([reg.wav], {type: 'audio/wav'}));
  estado.mapaAtual = reg.mapa;
  audioEl.src = estado.urlAudioAtual;
  audioEl.playbackRate = falaSistema.taxa;
  const alvo = estado.mapaAtual[Math.min(estado.fraseIdx, estado.mapaAtual.length - 1)];
  try{ audioEl.currentTime = alvo ? alvo.inicio : 0; }catch{}
  estado.modoAudio = true;
  return true;
}

audioEl.addEventListener('timeupdate', () => {
  if(!estado.modoAudio || !estado.mapaAtual) return;
  const t = audioEl.currentTime;
  let idx = estado.mapaAtual.findIndex(m => t < m.inicio + m.dur);
  if(idx < 0) idx = estado.mapaAtual.length - 1;
  if(idx !== estado.fraseIdx){
    estado.fraseIdx = idx;
    marcarFrase();
    salvarProgressoAgora();
  }
});
audioEl.addEventListener('ended', () => {
  if(!estado.modoAudio) return;
  avancarCapituloAuto();
});
audioEl.addEventListener('error', () => {
  if(!estado.modoAudio || !estado.tocando) return;
  estado.modoAudio = false;
  tocarFraseSistema();
});
// Detecta pausa externa (ligação telefônica, controle do sistema).
// _pausaProg impede que pausas programáticas (trocarCapitulo, prime iOS) disparem.
let _pausaProg = false;
audioEl.addEventListener('pause', () => {
  // IMPORTANTE: pela especificação HTML, o navegador dispara 'pause' ANTES de
  // 'ended' quando a mídia chega ao fim. Sem esta guarda, o fim de cada capítulo
  // zerava estado.tocando e o avanço automático abortava — o usuário precisava
  // apertar play a cada trecho.
  if(audioEl.ended) return;
  if(_pausaProg || !estado.modoAudio || !estado.tocando) return;
  estado.tocando = false;
  estado.pausadoEm = Date.now();
  atualizarIconePlay();
  salvarProgressoAgora();
});

/* ---------- via sistema (speechSynthesis) ---------- */
function tocarFraseSistema(){
  const f = estado.frases[estado.fraseIdx];
  if(!f){ pausar(); return; }
  estado.tocando = true;
  atualizarIconePlay();
  marcarFrase();
  pedirWakeLock();
  falaSistema.falar(f.falado, async () => {
    salvarProgressoAgora();
    if(!estado.tocando) return;
    if(estado.fraseIdx + 1 < estado.frases.length){
      estado.fraseIdx++;
      // Não trocar de motor no meio do capítulo — a troca acontece na
      // fronteira entre capítulos (em tocar()), evitando oscilação de voz.
      if(estado.tocando) tocarFraseSistema(); else marcarFrase();
    } else {
      avancarCapituloAuto();
    }
  }, () => pausar());
}

/* ---------- controle unificado ---------- */

// O <audio> precisa de um play() em contexto de gesto do usuário no iOS para
// que reproduções futuras (Piper em segundo plano) funcionem com tela apagada.
// Fazemos isso UMA VEZ no primeiro tocar() e nunca mais.
let _audioPrimado = false;

/* Lógica interna: inicia a leitura do capítulo atual.
   Chamada por tocar() e por avancarCapituloAuto() — não faz prime iOS. */
async function _iniciarCapitulo(){
  if(!estado.tocando) return;
  if(await tentarModoAudio()){
    if(!estado.tocando) return;
    marcarFrase();
    audioEl.play().catch(() => {
      estado.modoAudio = false;
      if(estado.tocando) tocarFraseSistema();
    });
  } else {
    if(!estado.tocando) return;
    estado.modoAudio = false;
    tocarFraseSistema();
  }
}

async function tocar(){
  if(!estado.frases.length) return;
  if(estado.pausadoEm && Date.now() - estado.pausadoEm > 30000 && estado.fraseIdx > 0){
    estado.fraseIdx--; // retomar o fio depois de pausa longa
  }
  estado.pausadoEm = 0;
  estado.tocando = true;
  atualizarIconePlay();
  agendarGeracao();

  // iOS: prime do <audio> apenas no primeiro play (precisa de gesto)
  if(!_audioPrimado){
    try{
      // 0,1 s de silêncio — curto demais para ouvir, longo bastante para valer no iOS
      const sil = montarWav({canais: 1, taxa: 22050, bits: 16}, [new Uint8Array(4410)]);
      audioEl.src = URL.createObjectURL(new Blob([sil], {type: 'audio/wav'}));
      _pausaProg = true;
      await audioEl.play(); audioEl.pause();
      _pausaProg = false;
      _audioPrimado = true;
    }catch{ _pausaProg = false; }
    if(!estado.tocando) return;
  }

  await _iniciarCapitulo();
}

function pausar(){
  estado.tocando = false;
  estado.pausadoEm = Date.now();
  if(estado.modoAudio){ _pausaProg = true; audioEl.pause(); _pausaProg = false; }
  falaSistema.parar();
  if(!estradaAberta()) soltarWakeLock();
  atualizarIconePlay();
  salvarProgressoAgora();
}

function alternarPlay(){ if(estado.tocando) pausar(); else tocar(); }

function irParaFrase(i){
  estado.fraseIdx = Math.max(0, Math.min(i, estado.frases.length - 1));
  if(estado.modoAudio && estado.mapaAtual){
    const m = estado.mapaAtual[estado.fraseIdx];
    try{ audioEl.currentTime = m ? m.inicio : 0; }catch{}
    marcarFrase();
  } else if(estado.tocando){
    tocarFraseSistema();
  } else {
    marcarFrase();
  }
  salvarProgressoAgora();
}

function avancarFrase(){
  if(estado.fraseIdx >= estado.frases.length - 1) avancarCapituloAuto();
  else irParaFrase(estado.fraseIdx + 1);
}
function voltarFrase(){
  if(estado.fraseIdx > 0){ irParaFrase(estado.fraseIdx - 1); return; }
  const ant = proximoCapIncluido(-1);
  if(ant >= 0) trocarCapitulo(ant, -1);
}

/* Avanço automático: caminho direto, sem passar por tocar() (evita prime iOS
   redundante e a janela de race que causava a pausa entre capítulos). */
function avancarCapituloAuto(){
  const prox = proximoCapIncluido(1);
  if(prox < 0){
    pausar();
    $('estrada-frase').textContent = 'Fim do livro. Boa estrada!';
    return;
  }
  // parar motor atual sem tocar em estado.tocando
  _pausaProg = true;
  estado.modoAudio = false;
  audioEl.pause();
  _pausaProg = false;
  falaSistema.parar();
  // preparar novo capítulo
  estado.capIdx = prox;
  $('sel-capitulo').value = prox;
  prepararCapitulo();
  estado.fraseIdx = 0;
  marcarFrase();
  agendarGeracao();
  salvarProgressoAgora();
  // continuar leitura diretamente
  _iniciarCapitulo();
}

/* Troca manual de capítulo (seletor, botões cap ant/prox). */
function trocarCapitulo(novoIdx, posFrase){
  const estavaTocando = estado.tocando;
  _pausaProg = true;
  estado.modoAudio = false;
  audioEl.pause();
  _pausaProg = false;
  falaSistema.parar();
  estado.capIdx = novoIdx;
  $('sel-capitulo').value = novoIdx;
  prepararCapitulo();
  estado.fraseIdx = posFrase < 0 ? Math.max(0, estado.frases.length - 1) : 0;
  marcarFrase();
  agendarGeracao();
  if(estavaTocando) tocar();
  salvarProgressoAgora();
}

function mudarCapitulo(dir){
  const novo = proximoCapIncluido(dir);
  if(novo >= 0) trocarCapitulo(novo, 0);
}

/* ---------- geração Piper em segundo plano ---------- */
function agendarGeracao(){
  if(estado.motor !== 'piper' || !piper.disponivel || !estado.vozPiperPronta || !estado.livro) return;
  // Gerar capítulo atual + próximos 2 em segundo plano — quando o leitor
  // chegar lá, o áudio já vai estar pronto. Mais que isso estoura a cota
  // do navegador (cada capítulo em WAV pesa dezenas de MB).
  const inc = indicesIncluidos(estado.livro);
  const pos = inc.indexOf(estado.capIdx);
  if(pos < 0) return;
  for(let d = 0; d <= 2 && pos + d < inc.length; d++){
    gerador.pedir(estado.livro, inc[pos + d]);
  }
  // liberar espaço dos capítulos que já ficaram para trás
  gerador.limparForaDaJanela(estado.livro.id, estado.capIdx).catch(() => {});
}

// Guard: impede _trocarParaPiperAgora de disparar durante troca de voz
let _trocandoVoz = false;

// Erro definitivo por capítulo: mantém a mensagem na tela em vez de deixar
// "Preparando…" mascarar a falha (era o caso da voz Edresson).
const _errosCap = new Map();

gerador.aoMudar = (ev) => {
  if(!estado.livro || ev.livroId !== estado.livro.id) return;
  const chave = gerador.chaveCap(ev.livroId, ev.capIdx);
  if(ev.estado === 'erro' && ev.definitivo) _errosCap.set(chave, ev.erro || 'falha desconhecida');
  else if(ev.estado === 'pronto' || ev.estado === 'gerando') _errosCap.delete(chave);
  atualizarEstadoAudioUI(ev);
  // Áudio natural ficou pronto para o capítulo atual enquanto a voz do sistema
  // estava lendo? Trocar imediatamente para o áudio Piper na frase atual.
  if(ev.estado === 'pronto' && ev.capIdx === estado.capIdx
     && estado.tocando && !estado.modoAudio && !_trocandoVoz){
    _trocarParaPiperAgora();
  }
  // Quando um capítulo fica pronto, agendar o próximo (pipeline contínuo)
  if(ev.estado === 'pronto') agendarGeracao();
};

async function _trocarParaPiperAgora(){
  if(_trocandoVoz || !estado.tocando) return;
  // Parar voz do sistema sem mudar estado.tocando
  falaSistema.parar();
  // Tentar carregar o áudio Piper na posição da frase atual
  if(await tentarModoAudio()){
    if(!estado.tocando) return;
    marcarFrase();
    audioEl.play().catch(() => {
      estado.modoAudio = false;
      if(estado.tocando) tocarFraseSistema();
    });
  } else {
    // Falhou (raro) — voltar à voz do sistema
    if(estado.tocando) tocarFraseSistema();
  }
}

async function atualizarEstadoAudioUI(ev){
  const el = $('estado-audio');
  if(!el) return;
  if(estado.motor !== 'piper' || !piper.disponivel){ el.textContent = ''; return; }
  if(!estado.vozPiperPronta){
    el.textContent = 'Voz neural ainda não baixada — usando a voz do sistema.';
    return;
  }
  // A voz (modelo) já está baixada e funciona offline.
  // O que pode demorar é a GERAÇÃO do áudio (texto → fala) para este capítulo.
  if(ev && ev.capIdx === estado.capIdx){
    if(ev.estado === 'gerando'){
      el.textContent = `Convertendo texto em fala: frase ${ev.feito} de ${ev.total}… (a voz já está salva no aparelho)`;
    } else if(ev.estado === 'baixando-voz'){
      el.textContent = 'Baixando o modelo desta voz… (uma vez só)';
    } else if(ev.estado === 'pronto'){
      el.textContent = 'Áudio natural pronto ✓';
    } else if(ev.estado === 'erro'){
      if(ev.incompativel){
        el.textContent = 'Esta voz não funciona com o motor neural do app. Escolha outra voz no painel ⚙️ — a leitura segue com a voz do sistema.';
      } else {
        el.textContent = ev.definitivo
          ? `Esta voz falhou neste trecho — seguindo com a voz do sistema. (${ev.erro || ''})`
          : 'Tentando de novo gerar o áudio…';
      }
    }
    return;
  }
  if(!estado.livro) return;
  // erro definitivo tem prioridade: não mascarar com "Preparando…"
  const chave = gerador.chaveCap(estado.livro.id, estado.capIdx);
  const erro = _errosCap.get(chave);
  if(erro){
    el.textContent = `Esta voz falhou neste trecho — seguindo com a voz do sistema. (${erro})`;
    return;
  }
  const reg = await bd.obter('capAudio', chave);
  el.textContent = reg
    ? 'Áudio natural pronto ✓'
    : 'Preparando áudio deste capítulo… (a voz já está salva no aparelho)';
}

/* =====================================================================
   Abrir livro
   ===================================================================== */
async function abrirLivro(id){
  const livro = estado.livros.find(l => l.id === id);
  if(!livro) return;
  falaSistema.parar();
  _pausaProg = true; audioEl.pause(); _pausaProg = false;
  estado.modoAudio = false;
  estado.tocando = false;
  armarTimerDormir(0);
  $('sel-dormir').value = '0';
  estado.livro = livro;
  const p = estado.progresso.get(id);
  estado.capIdx = Math.min(p?.capIdx ?? 0, livro.capitulos.length - 1);
  estado.fraseIdx = p?.fraseIdx || 0;
  estado.capIdx = capAtualIncluido();
  $('player-titulo').textContent = livro.titulo;
  const capaMini = $('player-capa');
  capaMini.innerHTML = '';
  capaMini.appendChild(elCapa(livro, 'capa capa-mini'));
  const sel = $('sel-capitulo');
  sel.innerHTML = '';
  for(const i of indicesIncluidos(livro)){
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${i + 1}. ${livro.capitulos[i].titulo}`;
    sel.appendChild(o);
  }
  sel.value = estado.capIdx;
  prepararCapitulo();
  atualizarIconePlay();
  mostrarTela('player');
  agendarGeracao();
  await bd.salvar('config', {chave: 'ultimoLivro', valor: id});
}

/* =====================================================================
   Media Session — com áudio real, funciona na tela de bloqueio e CarPlay
   ===================================================================== */
function atualizarMediaSession(){
  if(!('mediaSession' in navigator) || !estado.livro) return;
  try{
    const url = urlCapa(estado.livro);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: estado.livro.capitulos[estado.capIdx]?.titulo || '',
      artist: estado.livro.autor || 'Copiloto de Estrada',
      album: estado.livro.titulo,
      artwork: url ? [{src: url, sizes: '480x640'}] : []
    });
    navigator.mediaSession.setActionHandler('play', tocar);
    navigator.mediaSession.setActionHandler('pause', pausar);
    navigator.mediaSession.setActionHandler('previoustrack', voltarFrase);
    navigator.mediaSession.setActionHandler('nexttrack', avancarFrase);
    navigator.mediaSession.setActionHandler('seekbackward', voltarFrase);
    navigator.mediaSession.setActionHandler('seekforward', avancarFrase);
  }catch{}
}

/* =====================================================================
   Timer de dormir, Modo Estrada
   ===================================================================== */
function armarTimerDormir(min){
  clearTimeout(estado.timerDormir);
  estado.timerDormir = null;
  if(min > 0){
    estado.timerDormir = setTimeout(() => {
      pausar();
      $('sel-dormir').value = '0';
    }, min * 60000);
  }
}

const VELOCIDADES = [0.8, 1.0, 1.2, 1.4, 1.7, 2.0];
function rotVel(v){ return v.toFixed(1).replace('.', ',') + '×'; }
function estradaAberta(){ return !$('modo-estrada').classList.contains('oculto'); }
function abrirEstrada(){
  $('modo-estrada').classList.remove('oculto');
  document.documentElement.style.overflow = 'hidden';
  pedirWakeLock();
  marcarFrase();
}
function fecharEstrada(){
  $('modo-estrada').classList.add('oculto');
  document.documentElement.style.overflow = '';
  if(!estado.tocando || estado.modoAudio) soltarWakeLock();
}

/* =====================================================================
   Configuração de voz
   ===================================================================== */
let debounceTaxa = null;
function aplicarTaxa(v){
  falaSistema.taxa = v;
  audioEl.playbackRate = v;
  $('faixa-velocidade').value = v;
  $('vel-valor').textContent = rotVel(v);
  $('estrada-vel').firstChild.textContent = rotVel(v);
  bd.salvar('config', {chave: 'taxa', valor: v});
  marcarFrase();
  clearTimeout(debounceTaxa);
  if(estado.tocando && !estado.modoAudio){
    debounceTaxa = setTimeout(() => { if(estado.tocando && !estado.modoAudio) tocarFraseSistema(); }, 350);
  }
}

function preencherVozesSistema(){
  const sel = $('sel-voz-sistema');
  sel.innerHTML = '';
  if(!falaSistema.vozes.length){
    const o = document.createElement('option');
    o.textContent = 'Voz padrão do aparelho';
    sel.appendChild(o);
    return;
  }
  falaSistema.vozes.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${v.name} (${v.lang})`;
    if(v === falaSistema.vozAtual) o.selected = true;
    sel.appendChild(o);
  });
}

// Cache local de vozes baixadas nesta sessão — evita consultas ao OPFS/worker
// que podem travar quando o worker está gerando áudio.
const _vozesBaixadas = new Set();
let _listaVozesCache = null; // cache da lista de vozes do worker

async function preencherVozesPiper(){
  const sel = $('sel-voz-piper');
  sel.innerHTML = '';
  if(!piper.disponivel){ $('painel-piper').classList.add('oculto'); return; }
  // Usar cache da lista se disponível; o worker pode estar ocupado gerando áudio
  let lista = _listaVozesCache;
  if(!lista){
    try{ lista = await piper.vozes(); _listaVozesCache = lista; }catch{ lista = []; }
  }
  // Voz salva que saiu da lista (ex.: incompatível com o motor): voltar ao padrão,
  // senão o usuário fica preso numa voz que nunca vai gerar áudio.
  if(lista.length && !lista.some(v => v.id === piper.vozId)){
    piper.vozId = lista[0].id;
    bd.salvar('config', {chave: 'vozPiper', valor: piper.vozId});
  }
  // Só consultar armazenadas se o cache local não cobre a voz atual
  if(!_vozesBaixadas.has(piper.vozId)){
    try{
      const armazenadas = await piper.armazenadas();
      for(const id of armazenadas) _vozesBaixadas.add(id);
    }catch{}
  }
  for(const v of lista){
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = `${v.nome}${_vozesBaixadas.has(v.id) ? ' ✓ baixada' : ''}`;
    if(v.id === piper.vozId) o.selected = true;
    sel.appendChild(o);
  }
  estado.vozPiperPronta = _vozesBaixadas.has(piper.vozId);
  const btn = $('btn-baixar-voz');
  btn.classList.toggle('oculto', estado.vozPiperPronta);
  btn.disabled = false;
  $('voz-piper-ok').classList.toggle('oculto', !estado.vozPiperPronta);
  const btnApagar = $('btn-apagar-voz');
  if(btnApagar){
    btnApagar.classList.toggle('oculto', !estado.vozPiperPronta);
    btnApagar.disabled = false;
  }
  atualizarEstadoAudioUI();
  mostrarUsoArmazenamento();
}

/* Quanto o app está ocupando no aparelho — vozes + áudio gerado + livros. */
async function mostrarUsoArmazenamento(){
  const el = $('uso-armazenamento');
  if(!el) return;
  try{
    const est = await navigator.storage?.estimate?.();
    if(!est?.usage){ el.textContent = ''; return; }
    const mb = (n) => `${Math.round(n / 1048576)} MB`;
    el.textContent = est.quota
      ? `Espaço usado pelo app: ${mb(est.usage)} de ${mb(est.quota)} disponíveis.`
      : `Espaço usado pelo app: ${mb(est.usage)}.`;
  }catch{ el.textContent = ''; }
}

/* Apaga o modelo da voz do aparelho (libera dezenas de MB) e o áudio que
   dependia dela. Útil quando um download saiu corrompido. */
async function apagarVozPiper(){
  const btn = $('btn-apagar-voz');
  const prog = $('prog-download-voz');
  if(!confirm('Apagar esta voz do aparelho? O áudio já gerado com ela também sai. Você pode baixar de novo depois.')) return;
  btn.disabled = true;
  prog.classList.remove('oculto');
  prog.textContent = 'Apagando voz…';
  const estavaTocando = estado.tocando;
  if(estavaTocando) pausar();
  try{
    if(estado.livro){
      gerador.cancelarLivro(estado.livro.id);
      try{ await gerador.apagarAudioLivro(estado.livro.id); }catch{}
    }
    const vozApagada = piper.vozId;
    await piper.remover(vozApagada); // já reinicia o worker por dentro
    _vozesBaixadas.delete(vozApagada);
    estado.vozPiperPronta = false;
    // Conferir no OPFS em vez de confiar no cache — antes a UI dizia "apagada"
    // e no recarregar a voz reaparecia.
    let saiu = true;
    try{ saiu = !(await piper.armazenadas()).includes(vozApagada); }catch{}
    _vozesBaixadas.clear();
    prog.textContent = saiu
      ? 'Voz apagada do aparelho. Baixe de novo quando quiser.'
      : 'A voz não saiu do armazenamento — tente fechar e reabrir o app.';
    await preencherVozesPiper();
  }catch(err){
    prog.textContent = 'Não consegui apagar: ' + (err?.message || err);
    btn.disabled = false;
  }
  if(estavaTocando) tocar();
}

async function baixarVozPiper(){
  const btn = $('btn-baixar-voz');
  btn.disabled = true;
  const prog = $('prog-download-voz');
  prog.classList.remove('oculto');
  piper.aoProgressoDownload = (m) => {
    if(m.total) prog.textContent = `Baixando modelo de voz: ${Math.round(m.carregado * 100 / m.total)}% (${Math.round(m.total / 1048576)} MB — só uma vez, depois funciona offline)`;
  };
  try{
    await piper.baixar(piper.vozId);
    _vozesBaixadas.add(piper.vozId);
    estado.vozPiperPronta = true;
    prog.textContent = 'Voz baixada ✓ Agora funciona 100% offline.';
    btn.classList.add('oculto');
    $('voz-piper-ok').classList.remove('oculto');
    const opt = $('sel-voz-piper').querySelector(`option[value="${piper.vozId}"]`);
    if(opt && !opt.textContent.includes('✓')) opt.textContent += ' ✓ baixada';
    atualizarEstadoAudioUI();
    mostrarUsoArmazenamento();
    const btnApagar = $('btn-apagar-voz');
    if(btnApagar) btnApagar.classList.remove('oculto');
    agendarGeracao();
  }catch(err){
    prog.textContent = 'Falha no download: ' + (err?.message || err) + ' — verifique a conexão e tente de novo.';
    btn.disabled = false;
  }
}

/* =====================================================================
   Ligações da interface
   ===================================================================== */
function ligarEventos(){
  $('btn-escolher').addEventListener('click', () => $('entrada-arquivo').click());
  $('entrada-arquivo').addEventListener('change', (e) => {
    const arq = e.target.files[0];
    e.target.value = '';
    if(arq) iniciarPreparo(arq);
  });
  const zona = $('zona-envio');
  zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('arrastando'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('arrastando'));
  zona.addEventListener('drop', (e) => {
    e.preventDefault();
    zona.classList.remove('arrastando');
    const arq = e.dataTransfer.files[0];
    if(arq) iniciarPreparo(arq);
  });

  $('btn-salvar-livro').addEventListener('click', salvarLivro);
  $('btn-cancelar-preparo').addEventListener('click', () => {
    estado.bruto = null; estado.limpo = null;
    mostrarTela('biblioteca');
  });

  $('btn-voltar-biblioteca').addEventListener('click', () => {
    pausar();
    desenharBiblioteca();
    desenharContinuar();
    mostrarTela('biblioteca');
  });
  $('btn-play').addEventListener('click', alternarPlay);
  $('btn-frase-ant').addEventListener('click', voltarFrase);
  $('btn-frase-prox').addEventListener('click', avancarFrase);
  $('btn-cap-ant').addEventListener('click', () => mudarCapitulo(-1));
  $('btn-cap-prox').addEventListener('click', () => mudarCapitulo(1));
  $('sel-capitulo').addEventListener('change', (e) => trocarCapitulo(Number(e.target.value), 0));
  $('faixa-velocidade').addEventListener('input', (e) => aplicarTaxa(Number(e.target.value)));
  $('sel-dormir').addEventListener('change', (e) => armarTimerDormir(Number(e.target.value)));

  $('sel-motor').addEventListener('change', async (e) => {
    const estavaTocando = estado.tocando;
    if(estavaTocando) pausar();
    estado.motor = e.target.value;
    bd.salvar('config', {chave: 'motor', valor: estado.motor});
    $('painel-piper').classList.toggle('oculto', estado.motor !== 'piper' || !piper.disponivel);
    $('painel-sistema').classList.toggle('oculto', estado.motor !== 'sistema');
    atualizarEstadoAudioUI();
    agendarGeracao();
    if(estavaTocando) tocar();
  });
  $('sel-voz-piper').addEventListener('change', async (e) => {
    _trocandoVoz = true;
    const estavaTocando = estado.tocando;
    try{
      if(estavaTocando) pausar();
      const vozAnterior = piper.vozId;
      piper.vozId = e.target.value;
      bd.salvar('config', {chave: 'vozPiper', valor: piper.vozId});
      estado.vozPiperPronta = _vozesBaixadas.has(piper.vozId);
      // Limpar áudio da voz anterior (await garante que não conflita com geração nova)
      if(estado.livro){
        gerador.cancelarLivro(estado.livro.id);
        try{ await gerador.apagarAudioLivro(estado.livro.id); }catch{}
      }
      // Levantar um worker novo: o modelo ONNX da voz anterior fica na memória
      // do worker, e carregar o segundo em cima estourava a memória do celular
      // (a aba morria). Reiniciar devolve a memória ao sistema.
      if(vozAnterior !== piper.vozId) piper.reiniciar();
      await preencherVozesPiper();
      agendarGeracao();
      if(estavaTocando) tocar();
    }catch(err){
      console.error('Erro ao trocar voz:', err);
      // Garantir que o player não fique travado
      if(estavaTocando && !estado.tocando) tocar();
    }finally{
      _trocandoVoz = false;
    }
  });
  $('btn-baixar-voz').addEventListener('click', baixarVozPiper);
  $('btn-apagar-voz')?.addEventListener('click', apagarVozPiper);
  $('sel-voz-sistema').addEventListener('change', (e) => {
    falaSistema.vozAtual = falaSistema.vozes[Number(e.target.value)] || null;
    falaSistema.vozDesejadaURI = falaSistema.vozAtual?.voiceURI || '';
    bd.salvar('config', {chave: 'vozURI', valor: falaSistema.vozDesejadaURI});
    if(estado.tocando && !estado.modoAudio) tocarFraseSistema();
  });
  $('btn-config-voz').addEventListener('click', () => $('painel-voz').classList.toggle('oculto'));

  $('btn-modo-estrada').addEventListener('click', abrirEstrada);
  $('btn-sair-estrada').addEventListener('click', fecharEstrada);
  $('estrada-play').addEventListener('click', alternarPlay);
  $('estrada-ant').addEventListener('click', voltarFrase);
  $('estrada-prox').addEventListener('click', avancarFrase);
  $('estrada-cap-ant').addEventListener('click', () => mudarCapitulo(-1));
  $('estrada-cap-prox').addEventListener('click', () => mudarCapitulo(1));
  $('estrada-vel').addEventListener('click', () => {
    const i = VELOCIDADES.findIndex(v => Math.abs(v - falaSistema.taxa) < 0.05);
    aplicarTaxa(VELOCIDADES[(i + 1) % VELOCIDADES.length]);
  });

  document.addEventListener('keydown', (e) => {
    if(estado.tela !== 'player' || e.target.closest('button,input,select,textarea')) return;
    if(e.code === 'Space'){ e.preventDefault(); alternarPlay(); }
    if(e.code === 'ArrowLeft') voltarFrase();
    if(e.code === 'ArrowRight') avancarFrase();
  });

  window.addEventListener('pagehide', salvarProgressoAgora);
}

/* =====================================================================
   Inicialização
   ===================================================================== */
/* Rede de segurança: nenhum erro solto pode derrubar a leitura. Se algo
   falhar no motor neural, a voz do sistema assume e o livro continua aberto. */
function ligarRedeDeSeguranca(){
  const socorro = (origem, err) => {
    console.error(`[copiloto:${origem}]`, err);
    const el = $('estado-audio');
    if(el && estado.tela === 'player'){
      el.textContent = 'Um erro foi contornado — a leitura segue com a voz do sistema.';
    }
    // se estava tocando pelo Piper e o áudio morreu, cair para a voz do sistema
    if(estado.tocando && estado.modoAudio && audioEl.paused){
      estado.modoAudio = false;
      try{ tocarFraseSistema(); }catch{}
    }
  };
  window.addEventListener('error', (e) => { socorro('erro', e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => {
    e.preventDefault(); // impede que a promessa solta derrube a página
    socorro('promessa', e.reason);
  });
}

async function iniciar(){
  ligarRedeDeSeguranca();
  await bd.abrir();
  if(bd.soMemoria){
    $('aviso-armazenamento').innerHTML =
      `<div class="aviso">Este navegador não permitiu armazenamento local — os livros valem só para esta sessão.</div>`;
  }

  piper.iniciar();
  // Se o motor neural quebrar (memória, modelo corrompido), avisar e seguir
  // lendo com a voz do sistema em vez de emudecer.
  piper.aoQuebrar = (msg) => {
    console.error('[copiloto:worker]', msg);
    const el = $('estado-audio');
    if(el) el.textContent = 'O motor neural reiniciou — seguindo com a voz do sistema por ora.';
    if(estado.tocando && estado.modoAudio && audioEl.paused){
      estado.modoAudio = false;
      try{ tocarFraseSistema(); }catch{}
    }
  };

  estado.livros = await bd.todos('livros');
  for(const p of await bd.todos('progresso')) estado.progresso.set(p.livroId, p);

  const cfgMotor = await bd.obter('config', 'motor');
  estado.motor = cfgMotor?.valor || (piper.disponivel ? 'piper' : 'sistema');
  if(!piper.disponivel) estado.motor = 'sistema';
  $('sel-motor').value = estado.motor;
  $('painel-piper').classList.toggle('oculto', estado.motor !== 'piper' || !piper.disponivel);
  $('painel-sistema').classList.toggle('oculto', estado.motor !== 'sistema');
  if(!piper.disponivel) $('opcao-piper').disabled = true;

  const cfgVozPiper = await bd.obter('config', 'vozPiper');
  if(cfgVozPiper?.valor) piper.vozId = cfgVozPiper.valor;

  const cfgTaxa = await bd.obter('config', 'taxa');
  if(cfgTaxa?.valor){ falaSistema.taxa = cfgTaxa.valor; audioEl.playbackRate = cfgTaxa.valor; }
  $('faixa-velocidade').value = falaSistema.taxa;
  $('vel-valor').textContent = rotVel(falaSistema.taxa);
  $('estrada-vel').firstChild.textContent = rotVel(falaSistema.taxa);

  const cfgVoz = await bd.obter('config', 'vozURI');
  if(cfgVoz?.valor) falaSistema.vozDesejadaURI = cfgVoz.valor;
  falaSistema.carregarVozes(preencherVozesSistema);
  preencherVozesPiper();

  const ehIos = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if(ehIos && !piper.disponivel) $('aviso-ios').classList.remove('oculto');

  if(!falaSistema.suportada && !piper.disponivel){
    $('aviso-armazenamento').innerHTML +=
      `<div class="aviso aviso-erro">Este navegador não tem nenhum motor de voz disponível.</div>`;
  }

  ligarEventos();
  desenharBiblioteca();
  desenharContinuar();

  if('serviceWorker' in navigator){
    try{ navigator.serviceWorker.register('sw.js'); }catch{}
  }
}

iniciar();
