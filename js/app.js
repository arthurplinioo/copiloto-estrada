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
  blocoAtual: null,   // {bloco, de, ate, nBlocos} do pedaço de áudio carregado
  urlsCapas: new Map()
};

// Elemento de áudio ÚNICO da sessão (recriar quebra a permissão no iOS)
const audioEl = new Audio();
audioEl.preload = 'auto';

/* =====================================================================
   Wake lock (necessário só para o motor do sistema e Modo Estrada)
   ===================================================================== */
async function pedirWakeLock(){
  // Já temos um sentinel vivo? Não pedir outro. Esta função é chamada a cada
  // frase da voz do sistema: soltar e repedir criava uma janela sem trava e,
  // se o aparelho negasse o novo pedido, a tela apagava no Modo Estrada.
  if(estado.wakeLock && !estado.wakeLock.released) return;
  estado.wakeLock = null;
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

/* =====================================================================
   Leitura contínua
   O livro rola de ponta a ponta como num leitor comum, em vez de trocar a
   tela a cada capítulo. Renderizamos os capítulos por demanda (o atual e os
   vizinhos, estendendo conforme a rolagem): jogar um livro inteiro no DOM de
   uma vez são dezenas de milhares de elementos e trava o celular.
   O ÁUDIO continua sendo por capítulo — estado.frases é sempre o capítulo
   corrente. A rolagem é só a apresentação; a máquina de tocar não muda.
   ===================================================================== */
const CAPS_VIZINHOS = 1;      // quantos capítulos desenhar antes/depois

/* Enquanto o usuário rola para ler adiante, a frase que está tocando não pode
   arrastar a tela de volta a cada troca — seria impossível ler. O botão
   "voltar à leitura" religa o acompanhamento. */
let _rolagemDoUsuario = false;
let _pararRolagem = null;

function _marcarRolagemManual(){
  _rolagemDoUsuario = true;
  $('btn-voltar-leitura')?.classList.remove('oculto');
  clearTimeout(_pararRolagem);
  // se o leitor parar de rolar e a frase atual estiver visível, voltar a seguir
  _pararRolagem = setTimeout(() => {
    const s = $('texto-leitura').querySelector('.frase.atual');
    if(s && _estaVisivel(s)) _seguirLeitura();
  }, 2500);
}

function _estaVisivel(el){
  const cx = $('texto-leitura').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > cx.top && r.top < cx.bottom;
}

function _seguirLeitura(){
  _rolagemDoUsuario = false;
  clearTimeout(_pararRolagem);
  $('btn-voltar-leitura')?.classList.add('oculto');
  const s = $('texto-leitura').querySelector('.frase.atual');
  s?.scrollIntoView({block: 'center', behavior: 'smooth'});
}

function _secaoCapitulo(capIdx){
  const cap = estado.livro.capitulos[capIdx];
  const sec = document.createElement('section');
  sec.className = 'cap-secao';
  sec.dataset.cap = capIdx;

  const h = document.createElement('h2');
  h.className = 'cap-cabeca';
  h.textContent = cap.titulo || `Trecho ${capIdx + 1}`;
  sec.appendChild(h);

  const frases = capIdx === estado.capIdx ? estado.frases : frasesDoCapitulo(cap);
  let parAtual = NaN, pEl = null;
  frases.forEach((f, i) => {
    if(f.par !== parAtual || !pEl){
      parAtual = f.par;
      pEl = document.createElement(f.titulo ? 'h3' : 'p');
      if(f.titulo) pEl.classList.add('titulo-secao');
      sec.appendChild(pEl);
    }
    const span = document.createElement('span');
    span.className = 'frase';
    span.dataset.i = i;
    span.dataset.cap = capIdx;
    span.textContent = f.texto + ' ';
    pEl.appendChild(span);
  });
  return sec;
}

function desenharCapitulo(){
  const alvo = $('texto-leitura');
  alvo.innerHTML = '';
  const inc = indicesIncluidos(estado.livro);
  const pos = inc.indexOf(estado.capIdx);
  const de = Math.max(0, pos - CAPS_VIZINHOS);
  const ate = Math.min(inc.length - 1, pos + CAPS_VIZINHOS);
  for(let k = de; k <= ate; k++) alvo.appendChild(_secaoCapitulo(inc[k]));
  alvo.dataset.de = de;
  alvo.dataset.ate = ate;
  marcarFrase();
}

/* Estende a rolagem quando o leitor chega perto das pontas. */
function _estenderLeitura(){
  const alvo = $('texto-leitura');
  if(!estado.livro || !alvo.dataset.ate) return;
  const inc = indicesIncluidos(estado.livro);
  let de = Number(alvo.dataset.de), ate = Number(alvo.dataset.ate);
  const margem = 600;
  if(alvo.scrollHeight - alvo.scrollTop - alvo.clientHeight < margem && ate < inc.length - 1){
    ate++;
    alvo.appendChild(_secaoCapitulo(inc[ate]));
    alvo.dataset.ate = ate;
  }
  if(alvo.scrollTop < margem && de > 0){
    de--;
    const altaAntes = alvo.scrollHeight;
    alvo.insertBefore(_secaoCapitulo(inc[de]), alvo.firstChild);
    // manter o texto parado sob o dedo depois de inserir acima
    alvo.scrollTop += alvo.scrollHeight - altaAntes;
    alvo.dataset.de = de;
  }
}

/* ---------- pular de trecho em trecho ----------
   "trecho"  = parágrafo (a unidade de leitura na tela)
   "título"  = cabeçalho de seção dentro do capítulo
   "capítulo"= o capítulo inteiro (já existia)
   Todos movem o CURSOR DE LEITURA, não só a rolagem: quem estiver ouvindo
   continua de onde pulou. */
function irParaParagrafo(dir){
  if(!estado.frases.length) return;
  const parAtualIdx = estado.frases[estado.fraseIdx]?.par;
  let i = estado.fraseIdx;
  // andar até a primeira frase de um parágrafo diferente
  while(i >= 0 && i < estado.frases.length && estado.frases[i].par === parAtualIdx) i += dir;
  if(i < 0){
    const ant = proximoCapIncluido(-1);
    if(ant >= 0) trocarCapitulo(ant, -1);
    return;
  }
  if(i >= estado.frases.length){ avancarCapituloAuto(); return; }
  if(dir < 0){
    // recuar até o COMEÇO desse parágrafo
    const alvoPar = estado.frases[i].par;
    while(i > 0 && estado.frases[i - 1].par === alvoPar) i--;
  }
  _seguirLeitura();
  irParaFrase(i);
}

function irParaTitulo(dir){
  if(!estado.frases.length) return;
  let i = estado.fraseIdx + dir;
  while(i >= 0 && i < estado.frases.length){
    if(estado.frases[i].titulo){ _seguirLeitura(); irParaFrase(i); return; }
    i += dir;
  }
  // não há mais títulos neste capítulo: cair para o capítulo vizinho
  const vizinho = proximoCapIncluido(dir);
  if(vizinho >= 0){ _seguirLeitura(); trocarCapitulo(vizinho, dir < 0 ? -1 : 0); }
}

/* Clique numa frase: se for de outro capítulo, troca de capítulo antes. */
function _cliqueNoTexto(e){
  const span = e.target.closest?.('.frase');
  if(!span) return;
  const cap = Number(span.dataset.cap);
  const i = Number(span.dataset.i);
  if(Number.isNaN(cap) || Number.isNaN(i)) return;
  if(cap !== estado.capIdx){ trocarCapitulo(cap, 0); }
  irParaFrase(i);
}

function marcarFrase(){
  if(!estado.livro) return;
  const alvo = $('texto-leitura');
  alvo.querySelectorAll('.frase.atual').forEach(e => e.classList.remove('atual'));
  alvo.querySelectorAll('.cap-secao.lendo').forEach(e => e.classList.remove('lendo'));
  // Com o livro inteiro rolando, há frases com o mesmo índice em vários
  // capítulos: mirar sempre a do capítulo em leitura.
  const span = alvo.querySelector(
    `.cap-secao[data-cap="${estado.capIdx}"] .frase[data-i="${estado.fraseIdx}"]`);
  if(span){
    span.classList.add('atual');
    span.closest('.cap-secao')?.classList.add('lendo');
    if(!_rolagemDoUsuario) span.scrollIntoView({block: 'center', behavior: 'auto'});
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
  // manter a central do carro em sincronia com o botão do app
  atualizarPosicaoMediaSession();
}

/* ---------- via Piper (arquivo de áudio) ---------- */
/* Carrega no <audio> o BLOCO que contém a frase pedida.
   O capítulo é fatiado em blocos curtos justamente para a leitura poder
   começar no primeiro, sem esperar a síntese do capítulo inteiro. */
async function carregarBloco(bloco, fraseAlvo){
  if(!estado.livro) return false;
  const chaveB = gerador.chaveBloco(estado.livro.id, estado.capIdx, bloco);
  let reg = null;
  try{
    reg = await bd.obter('capAudio', chaveB);
  }catch(err){
    // Banco recusando (cota, pressão de espaço no iOS): não pode emudecer a
    // leitura. Devolver "não tem áudio" faz a voz do sistema assumir.
    console.error('[copiloto:bloco]', err);
    return false;
  }
  if(!reg) return false;
  const nEsperado = Math.min(gerador.TAM_BLOCO, estado.frases.length - reg.de);
  if(!gerador.audioServe(reg, nEsperado) || !Array.isArray(reg.mapa) || !reg.mapa.length){
    // outra voz, outra divisão de frases ou outra preferência: descartar
    await bd.apagar('capAudio', chaveB);
    agendarGeracao();
    return false;
  }
  if(estado.urlAudioAtual) URL.revokeObjectURL(estado.urlAudioAtual);
  estado.urlAudioAtual = URL.createObjectURL(new Blob([reg.wav], {type: 'audio/wav'}));
  estado.mapaAtual = reg.mapa;
  estado.blocoAtual = {bloco, de: reg.de, ate: reg.ate, nBlocos: reg.nBlocos};
  audioEl.src = estado.urlAudioAtual;
  audioEl.playbackRate = falaSistema.taxa;
  const local = Math.max(0, Math.min((fraseAlvo ?? estado.fraseIdx) - reg.de, reg.mapa.length - 1));
  try{ audioEl.currentTime = reg.mapa[local]?.inicio || 0; }catch{}
  estado.modoAudio = true;
  return true;
}

async function tentarModoAudio(){
  if(estado.motor !== 'piper' || !piper.disponivel || !estado.vozPiperPronta || !estado.livro) return false;
  return carregarBloco(gerador.blocoDaFrase(estado.fraseIdx), estado.fraseIdx);
}

audioEl.addEventListener('timeupdate', () => {
  if(!estado.modoAudio || !estado.mapaAtual) return;
  const t = audioEl.currentTime;
  let local = estado.mapaAtual.findIndex(m => t < m.inicio + m.dur);
  if(local < 0) local = estado.mapaAtual.length - 1;
  // o mapa é do BLOCO; o cursor de leitura é do capítulo
  const idx = (estado.blocoAtual?.de || 0) + local;
  if(idx !== estado.fraseIdx){
    estado.fraseIdx = idx;
    marcarFrase();
    salvarProgressoAgora();
    atualizarPosicaoMediaSession(); // barra de progresso da central do carro
  }
});
// metadados prontos: só então dá para informar a duração ao carro
audioEl.addEventListener('loadedmetadata', atualizarPosicaoMediaSession);
audioEl.addEventListener('ended', () => {
  // Sem o guard de 'tocando', um 'ended' já enfileirado quando o timer de
  // dormir (ou uma pausa manual) cai avançava o capítulo e salvava o progresso
  // adiante — o usuário acordava com o livro fora do lugar.
  if(!estado.modoAudio || !estado.tocando) return;
  emendarProximoBloco().catch(err => console.error('[copiloto:ended]', err));
});

/* Fim de um bloco: emendar o próximo do mesmo capítulo. Só quando acabam os
   blocos é que se troca de capítulo. Se o bloco seguinte ainda não foi gerado,
   a voz do sistema assume dali — a leitura não para para esperar. */
async function emendarProximoBloco(){
  const b = estado.blocoAtual;
  const proximo = (b?.bloco ?? 0) + 1;
  const temMais = b && proximo < (b.nBlocos ?? 1) && (b.ate + 1) < estado.frases.length;
  if(!temMais){ avancarCapituloAuto(); return; }

  estado.fraseIdx = b.ate + 1;
  _pausaProg = true; audioEl.pause(); _pausaProg = false;
  let carregou = false;
  try{
    carregou = await carregarBloco(proximo, estado.fraseIdx);
  }catch(err){
    console.error('[copiloto:emenda]', err);
  }
  if(carregou){
    if(!estado.tocando) return;
    marcarFrase();
    audioEl.play().catch(() => {
      estado.modoAudio = false;
      if(estado.tocando) tocarFraseSistema();
    });
    agendarGeracao(); // manter a fila adiantada
  } else {
    // bloco ainda não gerado: seguir na voz do sistema e trocar quando ficar pronto
    estado.modoAudio = false;
    agendarGeracao();
    if(estado.tocando) tocarFraseSistema();
  }
}
audioEl.addEventListener('error', () => {
  if(!estado.modoAudio || !estado.tocando) return;
  estado.modoAudio = false;
  tocarFraseSistema();
});
// Detecta pausa externa (ligação telefônica, controle do sistema).
// _pausaProg impede que pausas programáticas (trocarCapitulo, prime iOS) disparem.
let _pausaProg = false;
/* A mídia está acabando? Alguns navegadores disparam 'pause' antes de marcar
   .ended, e confiar só na flag reintroduz a pausa a cada capítulo. */
function _fimDaMidia(){
  if(audioEl.ended) return true;
  const d = audioEl.duration;
  return Number.isFinite(d) && d > 0 && d - audioEl.currentTime < 0.5;
}

audioEl.addEventListener('pause', () => {
  // IMPORTANTE: pela especificação HTML, o navegador dispara 'pause' ANTES de
  // 'ended' quando a mídia chega ao fim. Sem esta guarda, o fim de cada capítulo
  // zerava estado.tocando e o avanço automático abortava — o usuário precisava
  // apertar play a cada trecho.
  if(_fimDaMidia()) return;
  if(_pausaProg || !estado.modoAudio || !estado.tocando) return;
  estado.tocando = false;
  estado.pausadoEm = Date.now();
  atualizarIconePlay();
  salvarProgressoAgora();
});

/* ---------- via sistema (speechSynthesis) ---------- */
// Falhas seguidas da voz do sistema: pular a frase problemática em vez de
// encerrar a leitura. Só desiste quando o motor falha várias vezes em sequência.
let _falhasSistema = 0;
const MAX_FALHAS_SISTEMA = 5;

function tocarFraseSistema(){
  const f = estado.frases[estado.fraseIdx];
  if(!f){ pausar(); return; }
  estado.tocando = true;
  atualizarIconePlay();
  marcarFrase();
  pedirWakeLock();
  falaSistema.falar(f.falado, async () => {
    _falhasSistema = 0; // a frase saiu: o motor está são
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
  }, (erro) => {
    // 'synthesis-failed', 'audio-busy', 'network'… são comuns no Android e
    // antes paravam o livro de vez. A voz do sistema é o último recurso da
    // escada: ela precisa insistir, não desistir.
    if(!estado.tocando) return;
    // Sem motor nenhum no aparelho não há o que insistir — pular frases só
    // varreria o capítulo em silêncio.
    if(!falaSistema.suportada || erro?.message === 'sem-suporte'){
      _falhasSistema = 0;
      pausar();
      return;
    }
    _falhasSistema++;
    if(_falhasSistema >= MAX_FALHAS_SISTEMA){
      _falhasSistema = 0;
      pausar();
      const el = $('estado-audio');
      if(el) el.textContent = 'A voz do sistema parou de responder. Toque em play para retomar.';
      return;
    }
    // pular a frase problemática e seguir
    if(estado.fraseIdx + 1 < estado.frases.length){
      estado.fraseIdx++;
      setTimeout(() => { if(estado.tocando) tocarFraseSistema(); }, 150);
    } else {
      avancarCapituloAuto();
    }
  });
}

/* ---------- controle unificado ---------- */

// O <audio> precisa de um play() em contexto de gesto do usuário no iOS para
// que reproduções futuras (Piper em segundo plano) funcionem com tela apagada.
// Fazemos isso UMA VEZ no primeiro tocar() e nunca mais.
let _audioPrimado = false;

/* Lógica interna: inicia a leitura do capítulo atual.
   Chamada por tocar() e por avancarCapituloAuto() — não faz prime iOS. */
// Verdadeiro enquanto uma troca de motor está em andamento. A rede de segurança
// não pode "socorrer" nessa janela: ela via tocando=true com ninguém falando
// (porque o await do banco ainda não voltou) e ligava a voz do sistema por cima
// do áudio que estava prestes a tocar — as duas vozes ao mesmo tempo.
let _transicionando = false;

async function _iniciarCapitulo(){
  if(!estado.tocando) return;
  _transicionando = true;
  try{
    let temAudio = false;
    try{
      temAudio = await tentarModoAudio();
    }catch(err){
      // IndexedDB recusando, memória curta, registro antigo sem mapa… nada disso
      // pode emudecer a leitura: a voz do sistema assume e o livro continua.
      console.error('[copiloto:audio]', err);
      estado.modoAudio = false;
      temAudio = false;
    }
    if(!estado.tocando) return;
    if(temAudio){
      // garantir que a voz do sistema não ficou falando durante o await
      falaSistema.parar();
      marcarFrase();
      audioEl.play().catch(() => {
        estado.modoAudio = false;
        if(estado.tocando) tocarFraseSistema();
      });
    } else {
      estado.modoAudio = false;
      tocarFraseSistema();
    }
  }finally{
    _transicionando = false;
  }
}

async function tocar(){
  if(!estado.frases.length) return;
  gerador.suspenso = false;  // o usuário quer ouvir: gerar de novo é o esperado
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
    const b = estado.blocoAtual;
    // A frase pedida está em outro bloco? Carregar o bloco certo. Sem isto o
    // índice global caía fora do mapa (que é do bloco) e o áudio ia para o
    // lugar errado — ou para o começo.
    if(b && (estado.fraseIdx < b.de || estado.fraseIdx > b.ate)){
      const alvo = estado.fraseIdx;
      const tocava = estado.tocando;
      carregarBloco(gerador.blocoDaFrase(alvo), alvo).then(ok => {
        if(!ok){
          // bloco ainda não gerado: seguir pela voz do sistema
          estado.modoAudio = false;
          agendarGeracao();
          if(tocava) tocarFraseSistema(); else marcarFrase();
          return;
        }
        marcarFrase();
        if(tocava) audioEl.play().catch(() => {});
      }).catch(() => {});
      salvarProgressoAgora();
      return;
    }
    const m = estado.mapaAtual[estado.fraseIdx - (b?.de || 0)];
    try{ audioEl.currentTime = m ? m.inicio : 0; }catch{}
    marcarFrase();
  } else if(estado.tocando){
    tocarFraseSistema();
  } else {
    marcarFrase();
  }
  salvarProgressoAgora();
}

/* ---------- salto por tempo (o gesto que todo mundo já conhece) ----------
   No volante, "perdi o fio, volta 15 segundos" é mais previsível do que
   "volta uma frase" — frase pode ter 2 s ou 20 s. No modo áudio saltamos na
   linha do tempo do WAV; na voz do sistema não há linha do tempo, então
   estimamos pelo número de palavras faladas por minuto. */
const PALAVRAS_POR_MIN = 165;

function _duracaoEstimadaFrase(i){
  const f = estado.frases[i];
  if(!f) return 0;
  const palavras = Math.max(1, contarPalavras(f.falado || f.texto || ''));
  return (palavras / (PALAVRAS_POR_MIN * (falaSistema.taxa || 1))) * 60;
}

function saltarSegundos(seg){
  if(!estado.livro || !estado.frases.length) return;
  // Metadados ainda não carregados: currentTime é 0 e duration é NaN. Mexer
  // agora jogaria o leitor para o começo do capítulo E gravaria isso como
  // progresso. Cair no caminho por frases, que não depende da linha do tempo.
  const midiaPronta = estado.modoAudio && audioEl.readyState >= 1 &&
                      Number.isFinite(audioEl.duration) && audioEl.duration > 0;
  if(midiaPronta && estado.mapaAtual?.length){
    const dur = audioEl.duration;
    const alvo = audioEl.currentTime + seg;
    const b = estado.blocoAtual;
    // A linha do tempo é a do BLOCO. Sair dela pelas pontas significa ir para
    // o bloco vizinho — e só no fim do último bloco é que se troca de capítulo.
    if(alvo < 0){
      if(b && b.de > 0){ irParaFrase(Math.max(0, b.de - 1)); return; }
      const ant = proximoCapIncluido(-1);
      if(ant >= 0){ trocarCapitulo(ant, -1); return; }
      try{ audioEl.currentTime = 0; }catch{}
    } else if(alvo >= dur){
      if(b && b.ate + 1 < estado.frases.length){ irParaFrase(b.ate + 1); return; }
      avancarCapituloAuto();
      return;
    } else {
      try{ audioEl.currentTime = alvo; }catch{}
    }
    // sincronizar o cursor de frase com a nova posição
    const t = audioEl.currentTime;
    let local = estado.mapaAtual.findIndex(m => t < m.inicio + m.dur);
    if(local < 0) local = estado.mapaAtual.length - 1;
    estado.fraseIdx = (b?.de || 0) + local;
    marcarFrase();
    salvarProgressoAgora();
    return;
  }
  // voz do sistema: andar frases até somar o tempo pedido
  let restante = Math.abs(seg);
  let i = estado.fraseIdx;
  const passo = seg < 0 ? -1 : 1;
  while(restante > 0){
    const prox = i + passo;
    if(prox < 0){
      const ant = proximoCapIncluido(-1);
      if(ant >= 0){ trocarCapitulo(ant, -1); return; }
      i = 0; break;
    }
    if(prox > estado.frases.length - 1){ avancarCapituloAuto(); return; }
    i = prox;
    restante -= _duracaoEstimadaFrase(i);
  }
  irParaFrase(i);
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
  estado.blocoAtual = null;   // o áudio carregado era do capítulo anterior
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
  estado.blocoAtual = null;
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
  gerador.capLendo = estado.capIdx;    // referência da limpeza de emergência
  gerador.frasLendo = estado.fraseIdx; // gera primeiro o bloco onde ele está
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
  // Áudio natural disponível para onde o leitor está? Trocar já.
  // 'bloco-pronto' é o que faz a espera cair de dezenas de minutos para ~1min:
  // basta o bloco QUE CONTÉM a frase atual ficar pronto para a voz neural
  // entrar, sem esperar o capítulo inteiro.
  const chegouOndeEstou = ev.estado === 'bloco-pronto' &&
    estado.fraseIdx >= ev.de && estado.fraseIdx <= ev.ate;
  if((ev.estado === 'pronto' || chegouOndeEstou) && ev.capIdx === estado.capIdx
     && estado.tocando && !estado.modoAudio && !_trocandoVoz){
    _trocarParaPiperAgora();
  }
  // Pipeline contínuo: ao concluir um capítulo, engatar o próximo. Só quando
  // houve geração de verdade — reagendar em cima de "já existia" fazia o
  // gerador reenfileirar os mesmos capítulos em laço infinito.
  if(ev.estado === 'pronto' && !ev.jaExistia) agendarGeracao();
};

async function _trocarParaPiperAgora(){
  if(_trocandoVoz || _transicionando || !estado.tocando) return;
  _transicionando = true;
  try{
    // Carregar o áudio ANTES de calar a voz do sistema: se isto falhar, a
    // leitura não pode ficar em silêncio (antes o parar() vinha primeiro e um
    // erro aqui deixava o app mudo com o botão marcando "tocando").
    let pronto = false;
    try{
      pronto = await tentarModoAudio();
    }catch(err){
      console.error('[copiloto:troca-piper]', err);
      estado.modoAudio = false;
      return; // a voz do sistema segue lendo, intacta
    }
    if(!estado.tocando || !pronto) return;
    falaSistema.parar();
    marcarFrase();
    audioEl.play().catch(() => {
      estado.modoAudio = false;
      if(estado.tocando) tocarFraseSistema();
    });
  }finally{
    _transicionando = false;
  }
}

async function atualizarEstadoAudioUI(ev){
  const el = $('estado-audio');
  if(!el) return;
  if(estado.motor !== 'piper' || !piper.disponivel){ el.textContent = ''; return; }
  if(!estado.vozPiperPronta){
    // Aviso honesto: a voz do sistema é a que NÃO sai no som do carro nem
    // sobrevive à tela bloqueada no iPhone. Quem estava ouvindo só pelo
    // celular provavelmente estava nela sem saber.
    el.textContent = 'Voz do sistema (só toca com a tela ligada e não sai no som do carro). Baixe a voz neural no painel ⚙️.';
    return;
  }
  if(estado.tocando && !estado.modoAudio){
    el.textContent = 'Preparando a voz natural… por ora é a voz do sistema, que não sai no som do carro.';
    return;
  }
  // A voz (modelo) já está baixada e funciona offline.
  // O que pode demorar é a GERAÇÃO do áudio (texto → fala) para este capítulo.
  if(ev && ev.capIdx === estado.capIdx){
    if(ev.estado === 'gerando'){
      // Mostrar o progresso DO BLOCO, não do capítulo: "frase 4 de 18" diz que
      // falta pouco para começar a ouvir; "frase 4 de 360" parecia eterno —
      // e era, porque antes o áudio só tocava com o capítulo todo pronto.
      const dentro = ev.nBlocos > 1
        ? ((ev.feito - 1) % gerador.TAM_BLOCO) + 1
        : ev.feito;
      const doBloco = ev.nBlocos > 1 ? Math.min(gerador.TAM_BLOCO, ev.total) : ev.total;
      el.textContent = ev.nBlocos > 1
        ? `Preparando o próximo pedaço: ${dentro} de ${doBloco}… (a leitura começa assim que ficar pronto)`
        : `Convertendo texto em fala: frase ${dentro} de ${doBloco}…`;
    } else if(ev.estado === 'bloco-pronto'){
      el.textContent = ev.nBlocos > 1
        ? `Voz natural pronta até aqui (pedaço ${ev.bloco + 1} de ${ev.nBlocos}) — o resto continua sendo preparado.`
        : 'Áudio natural pronto ✓';
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
  // Só libera o áudio dos outros livros quando o armazenamento aperta — quem
  // alterna entre dois títulos não perde o que já foi gerado à toa.
  gerador.limparOutrosLivrosSePreciso(livro.id).catch(() => {});
  agendarGeracao();
  _atualizarBotaoPreparo();
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
    // ⏮/⏭ saltam TEMPO, não capítulo. Parece contraintuitivo, mas no carro é o
    // certo: muitos volantes e centrais só expõem prev/next, e pular para um
    // capítulo ainda não gerado cairia na voz do sistema — que no iPhone com a
    // tela bloqueada não toca. O controle emudeceria em movimento. Trocar de
    // capítulo continua disponível no app e no Modo Estrada.
    navigator.mediaSession.setActionHandler('previoustrack', () => saltarSegundos(-15));
    navigator.mediaSession.setActionHandler('nexttrack', () => saltarSegundos(30));
    navigator.mediaSession.setActionHandler('seekbackward', (d) => saltarSegundos(-(d?.seekOffset || 15)));
    navigator.mediaSession.setActionHandler('seekforward', (d) => saltarSegundos(d?.seekOffset || 30));
    // Arrastar a barra na tela do carro
    try{
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        if(d?.seekTime == null) return;
        saltarSegundos(d.seekTime - (estado.modoAudio ? audioEl.currentTime : 0));
      });
    }catch{}
    atualizarPosicaoMediaSession();
  }catch{}
}

/* Alimenta a barra de progresso e o estado play/pause da central do carro.
   Sem isto o CarPlay mostra o título, mas a barra fica parada em zero. */
function atualizarPosicaoMediaSession(){
  if(!('mediaSession' in navigator)) return;
  try{
    navigator.mediaSession.playbackState = estado.tocando ? 'playing' : 'paused';
    if(estado.modoAudio && Number.isFinite(audioEl.duration) && audioEl.duration > 0){
      navigator.mediaSession.setPositionState({
        duration: audioEl.duration,
        playbackRate: audioEl.playbackRate || 1,
        position: Math.min(audioEl.currentTime, audioEl.duration)
      });
    }
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
    try{
      lista = await piper.vozes();
      // Só guardar em cache a lista completa (da rede). A lista mínima do modo
      // offline não pode congelar a sessão inteira.
      if(piper.listaCompleta) _listaVozesCache = lista;
    }catch{ lista = []; }
  }
  // A voz salva sumiu da lista? Só trocar quando temos certeza — ou seja, com a
  // lista completa, ou quando a voz é sabidamente incompatível. Sem isso, abrir
  // o app sem internet trocava a voz do usuário e descartava todo o áudio pronto.
  const voziIncompativel = piper.incompativeis.includes(piper.vozId);
  const podeTrocar = piper.listaCompleta || voziIncompativel;
  if(lista.length && podeTrocar && !lista.some(v => v.id === piper.vozId)){
    piper.vozId = lista[0].id;
    bd.salvar('config', {chave: 'vozPiper', valor: piper.vozId});
  }
  // A voz atual pode não estar na lista mínima do modo offline; mostrá-la assim
  // mesmo para o seletor não "pular" para outra voz na frente do usuário.
  if(lista.length && !lista.some(v => v.id === piper.vozId)){
    lista = [{id: piper.vozId, nome: piper.vozId}, ...lista];
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
  _atualizarBotaoPreparo();
  const btnApagar = $('btn-apagar-voz');
  if(btnApagar){
    btnApagar.classList.toggle('oculto', !estado.vozPiperPronta);
    btnApagar.disabled = false;
  }
  atualizarEstadoAudioUI();
  mostrarUsoArmazenamento();
}

/* =====================================================================
   Preparar o livro inteiro antes da viagem
   No iOS a geração só anda com o app aberto na frente. Deixar tudo pronto
   em casa, no wi-fi, é o que faz o app servir de verdade no carro.
   ===================================================================== */
const _mb = (n) => `${Math.round(n / 1048576)} MB`;

/* ---------- manter a preparação viva em segundo plano ----------
   O iOS congela a página assim que o app sai da frente — inclusive o Web
   Worker que sintetiza a voz. A ÚNICA exceção é uma página com áudio tocando:
   o sistema mantém a sessão de mídia viva. Então, enquanto o livro está sendo
   preparado, tocamos um silêncio em laço. É o que permite trocar de app (ou
   apagar a tela) sem a geração parar.
   Só existe durante o preparo; não vale para navegação comum. */
let _audioVivo = null;

function _iniciarSessaoViva(){
  if(_audioVivo) return;
  try{
    const sil = montarWav({canais: 1, taxa: 22050, bits: 16}, [new Uint8Array(44100)]); // 1 s
    _audioVivo = new Audio(URL.createObjectURL(new Blob([sil], {type: 'audio/wav'})));
    _audioVivo.loop = true;
    _audioVivo.volume = 0.0001; // inaudível, mas conta como mídia tocando
    _audioVivo.play().catch(() => {});
  }catch{ _audioVivo = null; }
}

function _pararSessaoViva(){
  if(!_audioVivo) return;
  try{
    _audioVivo.pause();
    if(_audioVivo.src.startsWith('blob:')) URL.revokeObjectURL(_audioVivo.src);
  }catch{}
  _audioVivo = null;
}

function _atualizarBotaoPreparo(){
  const bloco = $('preparo-viagem');
  if(!bloco) return;
  const btn = $('btn-preparar-livro');
  const info = $('preparo-info');
  // O bloco aparece sempre que há um livro aberto. Escondê-lo enquanto a voz
  // não estava baixada tornava a opção invisível JUSTAMENTE para quem estava
  // procurando por ela — quem ainda não configurou a voz é quem mais precisa
  // do aviso de que dá para deixar o livro pronto para ouvir offline.
  if(!estado.livro || !piper.disponivel){ bloco.classList.add('oculto'); return; }
  bloco.classList.remove('oculto');
  if(gerador.preparandoTudo) return; // o preparo em curso controla o texto

  const faltaVoz = estado.motor !== 'piper' || !estado.vozPiperPronta;
  if(faltaVoz){
    btn.textContent = 'Deixar livro disponível offline';
    btn.disabled = false;
    btn.dataset.precisaVoz = '1';
    info.textContent = 'Precisa da voz neural — toque para configurar.';
    return;
  }
  delete btn.dataset.precisaVoz;
  const preparado = gerador.livrosPreparados.has(estado.livro.id);
  btn.textContent = preparado
    ? 'Livro pronto offline ✓ (preparar de novo)'
    : 'Deixar livro inteiro disponível offline';
  btn.disabled = false;
  if(!info.textContent || info.textContent.startsWith('Precisa da voz')){
    info.textContent = preparado
      ? 'Todos os capítulos já estão no aparelho.'
      : 'Gera o áudio de todos os capítulos para ouvir sem internet.';
  }
  _mostrarEspacoDoLivro();
}

/* Mostra quanto o áudio DESTE livro ocupa e oferece liberar. O áudio é o que
   mais pesa; sem isto o usuário só podia recuperar espaço apagando o livro
   inteiro, perdendo também o texto e o progresso. */
async function _mostrarEspacoDoLivro(){
  const btnLib = $('btn-liberar-audio');
  if(!btnLib || !estado.livro) return;
  const livroId = estado.livro.id;
  try{
    const {bytes} = await gerador.tamanhoAudioLivro(estado.livro);
    if(estado.livro?.id !== livroId) return;   // trocou de livro no meio
    const vale = bytes > 2 * 1048576;          // menos que isso não compensa oferecer
    btnLib.classList.toggle('oculto', !vale || gerador.preparandoTudo);
    if(vale){
      btnLib.textContent = `Liberar ${_mb(bytes)}`;
      btnLib.disabled = false;
    }
  }catch{}
}

/* Apaga o áudio gerado deste livro, mantendo o livro e o ponto da leitura. */
async function liberarAudioDoLivro(){
  if(!estado.livro || gerador.preparandoTudo) return;
  const livro = estado.livro;
  const {bytes} = await gerador.tamanhoAudioLivro(livro);
  const ok = confirm(
    `Apagar o áudio já gerado de "${livro.titulo}" e liberar ${_mb(bytes)}?\n\n` +
    'O livro e o ponto onde você parou continuam. Só o áudio sai — ' +
    'ele pode ser gerado de novo quando você quiser.');
  if(!ok) return;

  const btnLib = $('btn-liberar-audio');
  btnLib.disabled = true;
  const estavaTocando = estado.tocando;
  if(estavaTocando) pausar();
  // soltar o áudio carregado antes de apagar o registro de onde ele veio
  estado.modoAudio = false;
  estado.blocoAtual = null;
  if(estado.urlAudioAtual){
    try{ URL.revokeObjectURL(estado.urlAudioAtual); }catch{}
    estado.urlAudioAtual = null;
  }
  try{ audioEl.removeAttribute('src'); audioEl.load(); }catch{}

  gerador.suspenso = true;   // não deixar o gerador reocupar o espaço agora
  gerador.cancelarLivro(livro.id);
  // Não engolir a falha: dizer "liberado" sem ter liberado seria mentir para
  // quem está justamente tentando recuperar espaço.
  try{
    await gerador.apagarAudioLivro(livro.id);
  }catch(err){
    console.error('[copiloto:liberar]', err);
    $('preparo-info').textContent = 'Não consegui apagar o áudio: ' + (err?.message || err);
    btnLib.disabled = false;
    return;
  }
  $('preparo-info').textContent = `${_mb(bytes)} liberados. O texto e o seu lugar na leitura continuam aqui.`;
  _atualizarBotaoPreparo();
  mostrarUsoArmazenamento();
  // NÃO retomar sozinho: chamar tocar() aqui dispararia a geração de novo e
  // reocuparia o espaço que o usuário acabou de liberar. Ele decide quando.
  if(estavaTocando){
    $('preparo-info').textContent += ' Toque em play para continuar (o áudio será gerado de novo).';
  }
}

async function prepararLivroInteiro(){
  if(!estado.livro || gerador.preparandoTudo) return;
  // Sem voz neural configurada, o botão vira um atalho para o painel de voz
  // em vez de não fazer nada.
  if($('btn-preparar-livro')?.dataset.precisaVoz){
    $('painel-voz').classList.remove('oculto');
    $('sel-motor').value = 'piper';
    $('sel-motor').dispatchEvent(new Event('change'));
    $('painel-voz').scrollIntoView({behavior: 'smooth', block: 'center'});
    $('preparo-info').textContent = 'Baixe a voz neural acima e volte aqui.';
    return;
  }
  // Guardar a referência do livro: o preparo pode levar horas e o usuário pode
  // abrir outro livro no meio. Ler estado.livro no fim marcaria o livro errado.
  const livroPreparo = estado.livro;
  gerador.suspenso = false;
  const btn = $('btn-preparar-livro');
  const btnParar = $('btn-parar-preparo');
  const info = $('preparo-info');
  const barra = $('barra-preparo');

  // Aviso honesto de espaço ANTES de começar: áudio cru pesa muito.
  const estimado = gerador.estimarBytesLivro(livroPreparo);
  const esp = await gerador.espacoLivre();
  let aviso = `Vou gerar o áudio de todo o livro (~${_mb(estimado)}).`;
  if(esp) aviso += ` Seu aparelho tem ${_mb(esp.livre)} livres.`;
  if(esp && estimado > esp.livre * 0.9){
    aviso += '\n\nProvavelmente NÃO cabe tudo. Vou preparar o máximo que couber, começando pelo capítulo atual.';
  }
  aviso += '\n\nPode demorar. Você já pode ouvir enquanto prepara, e dá para usar '
        +  'outros apps: a preparação segue em segundo plano.\n\nDeixe o aparelho na tomada.\n\nComeçar?';
  if(!confirm(aviso)) return;

  btn.disabled = true;
  btn.textContent = 'Preparando…';
  btnParar.classList.remove('oculto');
  barra.classList.remove('oculto');
  pedirWakeLock();      // manter a tela ligada enquanto o app estiver na frente
  _iniciarSessaoViva(); // e manter a geração viva se o usuário trocar de app

  let rotuloCap = '';
  gerador.aoPreparar = (ev) => {
    const pct = ev.total ? Math.round((ev.feitos / ev.total) * 100) : 0;
    $('preparo-barra').style.width = pct + '%';
    if(ev.estado === 'gerando'){
      rotuloCap = `Capítulo ${ev.feitos + 1} de ${ev.total}`;
      info.textContent = rotuloCap + '…';
    } else if(ev.estado === 'pronto'){
      info.textContent = `${ev.feitos} de ${ev.total} prontos`;
    } else if(ev.estado === 'sem-espaco'){
      info.textContent = `Espaço acabou em ${ev.feitos} de ${ev.total} capítulos.`;
    }
  };
  // enquanto gera, mostrar o andamento frase a frase também
  const aoMudarOrig = gerador.aoMudar;
  gerador.aoMudar = (ev) => {
    aoMudarOrig?.(ev);
    // Guardar o rótulo do capítulo numa variável em vez de recortar o texto já
    // na tela: se a mensagem corrente fosse outra, a colagem saía sem sentido.
    if(gerador.preparandoTudo && ev.estado === 'gerando' && rotuloCap){
      info.textContent = `${rotuloCap} — frase ${ev.feito} de ${ev.total}`;
    }
  };

  let r;
  try{
    r = await gerador.prepararLivroInteiro(livroPreparo, estado.capIdx);
  }catch(err){
    r = {status: 'erro', erro: String(err?.message || err), feitos: 0, total: 0};
  }finally{
    gerador.aoMudar = aoMudarOrig;
    gerador.aoPreparar = null;
    _pararSessaoViva();
    btnParar.classList.add('oculto');
    if(!estado.tocando && !estradaAberta()) soltarWakeLock();
  }

  // SÓ marcar quando o livro ficou inteiro em disco. Marcar um preparo parcial
  // desligaria a poda por janela — o único freio de armazenamento no uso
  // normal — justamente num aparelho que já estava sem espaço.
  await gerador.marcarPreparado(livroPreparo.id, r.status === 'completo');

  const msgs = {
    completo: `Livro pronto ✓ ${r.feitos} capítulos com voz natural, prontos para a estrada.`,
    parcial: `${r.feitos} de ${r.total} capítulos prontos. Alguns falharam — tente de novo depois.`,
    'sem-espaco': `Espaço do aparelho acabou: ${r.feitos} de ${r.total} prontos. Apague algum livro e continue.`,
    cancelado: `Parado por você: ${r.feitos} de ${r.total} capítulos já ficaram prontos.`,
    incompativel: 'Esta voz não funciona com o motor do app. Escolha outra e tente de novo.',
    ocupado: 'O motor está ocupado gerando áudio. Tente daqui a pouco.',
    'ja-rodando': 'Já está preparando.',
    erro: `Falhou: ${r.erro || ''}`
  };
  // Se o usuário abriu outro livro no meio, não escrever o resultado na tela
  // dele — seria "Livro pronto ✓" num livro que não tem áudio nenhum.
  if(estado.livro?.id !== livroPreparo.id) return;

  info.textContent = msgs[r.status] || `${r.feitos} de ${r.total} prontos.`;
  $('preparo-barra').style.width = (r.total ? Math.round((r.feitos / r.total) * 100) : 0) + '%';
  _atualizarBotaoPreparo();
  mostrarUsoArmazenamento();
  // com o áudio na mão, trocar já para a voz natural se estiver lendo
  if(estado.tocando && !estado.modoAudio) _trocarParaPiperAgora();
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

    // Baixar o modelo não basta: a síntese também puxa o runtime ONNX e o
    // phonemizador dos CDNs, e isso só acontecia na primeira geração de áudio.
    // Quem baixasse a voz em casa e saísse sem sinal ficava sem voz neural.
    // Gerar uma frase curta agora aquece esses caches E prova que a voz funciona.
    prog.textContent = 'Preparando o motor de voz (última etapa)…';
    try{
      // timeout curto: com CDN lento não vale prender o usuário por minutos
      // logo depois de ele já ter esperado o download do modelo.
      await piper.gerar('Teste de voz.', 45000);
      estado.vozPiperPronta = true;
      prog.textContent = 'Voz pronta ✓ Agora funciona offline, sem internet.';
    }catch(err){
      if(err?.incompativel){
        _vozesBaixadas.delete(piper.vozId);
        estado.vozPiperPronta = false;
        prog.textContent = 'Esta voz não funciona com o motor do app. Escolha outra na lista.';
        btn.disabled = false;
        atualizarEstadoAudioUI();
        return;
      }
      // Falhou o aquecimento (sem rede, CDN fora): a voz está baixada e o app
      // tenta de novo na primeira geração — só não dá para prometer offline.
      estado.vozPiperPronta = true;
      prog.textContent = 'Voz baixada ✓ (o motor termina de se preparar na primeira leitura com internet)';
    }
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
    // soltar o WAV do capítulo (dezenas de MB) em vez de deixá-lo residente
    // enquanto o usuário navega pela estante
    if(estado.urlAudioAtual){
      try{ URL.revokeObjectURL(estado.urlAudioAtual); }catch{}
      estado.urlAudioAtual = null;
    }
    estado.modoAudio = false;
    try{ audioEl.removeAttribute('src'); audioEl.load(); }catch{}
    desenharBiblioteca();
    desenharContinuar();
    mostrarTela('biblioteca');
  });
  $('btn-play').addEventListener('click', alternarPlay);
  $('btn-frase-ant').addEventListener('click', voltarFrase);
  $('btn-frase-prox').addEventListener('click', avancarFrase);
  $('btn-voltar-15').addEventListener('click', () => saltarSegundos(-15));
  $('btn-avancar-30').addEventListener('click', () => saltarSegundos(30));

  // leitura contínua: rolagem, clique em qualquer frase do livro e navegação
  const areaTexto = $('texto-leitura');
  areaTexto.addEventListener('click', _cliqueNoTexto);
  areaTexto.addEventListener('scroll', () => { _marcarRolagemManual(); _estenderLeitura(); },
                              {passive: true});
  $('btn-voltar-leitura')?.addEventListener('click', _seguirLeitura);
  $('nav-par-ant')?.addEventListener('click', () => irParaParagrafo(-1));
  $('nav-par-prox')?.addEventListener('click', () => irParaParagrafo(1));
  $('nav-tit-ant')?.addEventListener('click', () => irParaTitulo(-1));
  $('nav-tit-prox')?.addEventListener('click', () => irParaTitulo(1));
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
  $('btn-preparar-livro')?.addEventListener('click', prepararLivroInteiro);
  $('btn-liberar-audio')?.addEventListener('click', liberarAudioDoLivro);
  $('btn-parar-preparo')?.addEventListener('click', () => {
    gerador.pararPreparo();
    $('preparo-info').textContent = 'Parando…';
  });
  $('sel-voz-sistema').addEventListener('change', (e) => {
    falaSistema.vozAtual = falaSistema.vozes[Number(e.target.value)] || null;
    falaSistema.vozDesejadaURI = falaSistema.vozAtual?.voiceURI || '';
    bd.salvar('config', {chave: 'vozURI', valor: falaSistema.vozDesejadaURI});
    if(estado.tocando && !estado.modoAudio) tocarFraseSistema();
  });
  $('btn-config-voz').addEventListener('click', () => $('painel-voz').classList.toggle('oculto'));
  $('chk-pular-citacoes')?.addEventListener('change', async (e) => {
    window.PULAR_CITACOES = e.target.checked;
    await bd.salvar('config', {chave: 'pularCitacoes', valor: e.target.checked});
    if(!estado.livro) return;
    // O texto falado mudou, então o áudio gerado com a preferência antiga não
    // serve mais. Não é preciso apagar nada aqui: cada registro guarda com que
    // preferência foi gerado (gerador.audioServe), então o áudio dos OUTROS
    // livros também é refeito quando eles forem abertos. Antes, só o livro
    // aberto era invalidado e os demais liam "(SILVA, 2020)" para sempre.
    const estavaTocando = estado.tocando;
    if(estavaTocando) pausar();
    gerador.cancelarLivro(estado.livro.id);
    try{ await gerador.apagarAudioLivro(estado.livro.id); }catch{}
    prepararCapitulo();
    agendarGeracao();
    _atualizarBotaoPreparo();
    if(estavaTocando) tocar();
  });

  $('btn-modo-estrada').addEventListener('click', abrirEstrada);
  $('btn-sair-estrada').addEventListener('click', fecharEstrada);
  $('estrada-play').addEventListener('click', alternarPlay);
  $('estrada-voltar-15').addEventListener('click', () => saltarSegundos(-15));
  $('estrada-avancar-30').addEventListener('click', () => saltarSegundos(30));
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
    // Se o app se diz "tocando" mas nada está soando, religar pela voz do
    // sistema. Não exigir modoAudio aqui: os caminhos que emudecem a leitura
    // justamente deixam modoAudio falso, e a rede nunca resgatava ninguém.
    const mudo = estado.modoAudio ? audioEl.paused : !falaSistema.estaFalando();
    // _transicionando: durante a troca de motor o silêncio é esperado (o banco
    // ainda está respondendo). Socorrer aqui punha duas vozes para tocar juntas.
    if(estado.tela === 'player' && estado.tocando && mudo && !_transicionando && !_trocandoVoz){
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

  await gerador.carregarPreparados(); // livros já prontos para viagem
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

  const cfgCit = await bd.obter('config', 'pularCitacoes');
  window.PULAR_CITACOES = cfgCit?.valor !== false; // ligado por padrão
  const chkCit = $('chk-pular-citacoes');
  if(chkCit) chkCit.checked = window.PULAR_CITACOES;

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
