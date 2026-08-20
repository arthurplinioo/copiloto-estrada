// Teste de sobrecarga: leitura ininterrupta de muitos trechos seguidos.
// Simula o ciclo real do navegador (pause -> ended) capítulo após capítulo e
// cobra que a leitura NUNCA pare sozinha, que o progresso não se perca e que
// nada vaze entre as transições.
import { carregarApp, criarVerificador } from './harness.mjs';

const dom = await carregarApp();
const w = dom.window;
const d = w.document;
const { falhas, verificar } = criarVerificador();
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const ev = (expr) => w.eval(expr);

const N_CAPITULOS = 24;

// jsdom não implementa object URLs; contamos quantas foram criadas/soltas para
// flagrar vazamento de blobs ao longo da maratona.
ev(`(() => {
  window.__urlsVivas = 0; window.__urlsCriadas = 0;
  URL.createObjectURL = () => { window.__urlsCriadas++; window.__urlsVivas++;
    return 'blob:falso/' + window.__urlsCriadas; };
  URL.revokeObjectURL = () => { window.__urlsVivas--; };
})()`);

// ---------- montar um livro grande direto no banco ----------
const capitulos = [];
for(let i = 1; i <= N_CAPITULOS; i++){
  const frases = [];
  for(let f = 1; f <= 6; f++){
    frases.push(`Esta e a frase ${f} do capitulo ${i}, com texto suficiente para valer.`);
  }
  capitulos.push({titulo: `${i}. Capitulo ${i}`, texto: frases.join(' '), incluir: true});
}
w.eval(`window.__caps = ${JSON.stringify(capitulos)}`);
await ev(`(async () => {
  const livro = {id: 'sobrecarga', titulo: 'Livro de Sobrecarga', autor: '', tipo: 'txt',
                 capa: null, capitulos: window.__caps, palavras: 5000, criadoEm: Date.now()};
  await bd.salvar('livros', livro);
  estado.livros = await bd.todos('livros');
  await abrirLivro('sobrecarga');
})()`);
await espera(300);

verificar('livro grande abriu no player',
  !d.getElementById('tela-player').classList.contains('oculto'));
verificar(`seletor com ${N_CAPITULOS} capítulos`,
  d.getElementById('sel-capitulo').options.length === N_CAPITULOS,
  `(veio ${d.getElementById('sel-capitulo').options.length})`);

// ---------- gerar áudio falso para todos os capítulos ----------
// WAV real (montarWav) para o caminho de áudio ser o mesmo do app.
// O áudio é guardado em BLOCOS (o capítulo inteiro num WAV só fazia o leitor
// esperar a síntese de centenas de frases antes da primeira palavra). Este
// ajudante grava um capítulo já fatiado, como o gerador de verdade faria.
// vários testes trocam _gerarCapitulo por stubs; guardar o original para os
// testes que precisam da geração de verdade
ev(`window.__gerarCapReal = gerador._gerarCapitulo.bind(gerador);
    window.__apagarAudioReal = gerador.apagarAudioLivro.bind(gerador);`);

await ev(`window.__gravarCap = async (livroId, capIdx, comAudioReal) => {
  const cap = estado.livros.find(l => l.id === livroId).capitulos[capIdx];
  const frases = frasesDoCapitulo(cap);
  const faixas = gerador.blocosDoCapitulo(frases.length);
  const fmt = {canais: 1, taxa: 22050, bits: 16};
  for(let b = 0; b < faixas.length; b++){
    const {de, ate} = faixas[b];
    const n = ate - de + 1;
    const mapa = Array.from({length: n}, (_, k) => ({inicio: k * 0.5, dur: 0.5}));
    const wav = comAudioReal
      ? montarWav(fmt, [new Uint8Array(Math.round(22050 * 2 * 0.5 * n) & ~1)])
      : new ArrayBuffer(64);
    await bd.salvar('capAudio', {
      chave: gerador.chaveBloco(livroId, capIdx, b),
      wav, mapa, duracao: n * 0.5,
      vozId: piper.vozId, nFrases: n, semCitacoes: gerador._semCitacoesAgora(),
      de, ate, bloco: b, nBlocos: faixas.length, nFrasesCap: frases.length
    });
  }
};
window.__apagarCap = async (livroId, capIdx) => {
  for(const c of await bd.chaves('capAudio')){
    if(String(c).startsWith(livroId + ':' + capIdx + ':')) await bd.apagar('capAudio', c);
  }
};`);

await ev(`(async () => {
  for(let i = 0; i < ${N_CAPITULOS}; i++) await window.__gravarCap('sobrecarga', i, true);
})()`);

// ---------- ligar o modo neural e neutralizar o que o jsdom não faz ----------
await ev(`(() => {
  estado.motor = 'piper';
  piper.disponivel = true;
  estado.vozPiperPronta = true;
  // não gerar de verdade durante o teste (o pedir real volta no fim, para o
  // teste de laço do pipeline)
  window.__pedirReal = gerador.pedir.bind(gerador);
  gerador.pedir = () => {};
  // o teste pré-fabricou áudio de TODOS os capítulos; a limpeza por janela
  // (que no app real só apaga o que a geração já deixou para trás) varreria
  // esse material. Ela tem verificação própria mais abaixo.
  window.__limparReal = gerador.limparForaDaJanela.bind(gerador);
  gerador.limparForaDaJanela = async () => {};
  // jsdom não implementa play(); resolver como um navegador de verdade
  audioEl.play = () => { window.__plays = (window.__plays || 0) + 1; return Promise.resolve(); };
  audioEl.pause = () => {};
  window.__erros = [];
  window.addEventListener('error', (e) => window.__erros.push(String(e.message || e.error)));
})()`);

// ---------- a maratona ----------
console.log(`== lendo ${N_CAPITULOS} trechos seguidos, sem tocar em nada ==`);
await ev('estado.capIdx = 0; prepararCapitulo(); estado.fraseIdx = 0; tocar()');
await espera(200);

verificar('começou tocando', ev('estado.tocando') === true);
verificar('entrou em modo áudio', ev('estado.modoAudio') === true);

const visitados = [ev('estado.capIdx')];
let parouSozinho = -1;

for(let passo = 0; passo < N_CAPITULOS - 1; passo++){
  // sequência exata do navegador ao fim da mídia: pause e depois ended
  ev(`Object.defineProperty(audioEl, 'ended', {value: true, configurable: true});
      audioEl.dispatchEvent(new Event('pause'));
      audioEl.dispatchEvent(new Event('ended'));`);
  await espera(60);
  ev(`Object.defineProperty(audioEl, 'ended', {value: false, configurable: true});`);
  if(!ev('estado.tocando') && parouSozinho < 0) parouSozinho = passo;
  visitados.push(ev('estado.capIdx'));
}

verificar('a leitura nunca parou sozinha', parouSozinho < 0,
  `(parou na transição ${parouSozinho + 1})`);
verificar(`percorreu os ${N_CAPITULOS} capítulos em ordem`,
  visitados.length === N_CAPITULOS && visitados.every((v, i) => v === i),
  `(visitados: ${visitados.slice(0, 8).join(',')}… último=${visitados[visitados.length - 1]})`);
verificar('continua em modo áudio no fim', ev('estado.modoAudio') === true);
verificar('houve um play por capítulo', ev('window.__plays') >= N_CAPITULOS,
  `(plays=${ev('window.__plays')})`);
verificar('nenhum erro solto durante a maratona',
  ev('window.__erros.length') === 0, `(${ev('JSON.stringify(window.__erros.slice(0,3))')})`);

// ---------- fim do livro ----------
ev(`Object.defineProperty(audioEl, 'ended', {value: true, configurable: true});
    audioEl.dispatchEvent(new Event('pause'));
    audioEl.dispatchEvent(new Event('ended'));`);
await espera(80);
verificar('para de verdade no fim do livro', ev('estado.tocando') === false);
verificar('avisa que o livro acabou',
  d.getElementById('estrada-frase').textContent.includes('Fim do livro'));

// ---------- progresso e vazamentos ----------
console.log('== integridade após a maratona ==');
{
  const p = await ev(`bd.obter('progresso', 'sobrecarga')`);
  verificar('progresso foi salvo', !!p, `(${JSON.stringify(p)})`);
  // um <audio> só, reaproveitado — não pode ter virado um por capítulo
  verificar('usa um único elemento de áudio',
    d.querySelectorAll('audio').length <= 1,
    `(${d.querySelectorAll('audio').length} elementos)`);
  // cada capítulo cria uma object URL; a anterior tem de ser revogada
  const vivas = ev('window.__urlsVivas'), criadas = ev('window.__urlsCriadas');
  verificar('object URLs de áudio não vazam', vivas <= 2,
    `(${vivas} vivas de ${criadas} criadas)`);
  // devolver a limpeza real (foi neutralizada durante a maratona)
  await ev(`gerador.limparForaDaJanela = window.__limparReal;
            gerador.limparForaDaJanela('sobrecarga', estado.capIdx)`);
  const restantes = await ev(`(async () => (await bd.chaves('capAudio'))
      .filter(c => String(c).startsWith('sobrecarga:')).length)()`);
  verificar('limpeza por janela contém o armazenamento', restantes <= 6,
    `(sobraram ${restantes} capítulos em disco)`);
  // a janela precisa preservar o que a geração antecipa (atual + 2 à frente)
  const janelaCobreGeracao = await ev(`(async () => {
    await bd.salvar('capAudio', {chave: gerador.chaveCap('janela', 5), wav: new ArrayBuffer(64),
                                 mapa: [], duracao: 1, vozId: 'x', nFrases: 1});
    await bd.salvar('capAudio', {chave: gerador.chaveCap('janela', 7), wav: new ArrayBuffer(64),
                                 mapa: [], duracao: 1, vozId: 'x', nFrases: 1});
    await gerador.limparForaDaJanela('janela', 5);
    const k = await bd.chaves('capAudio');
    return k.includes('janela:5') && k.includes('janela:7');
  })()`);
  verificar('limpeza preserva os capítulos que a geração antecipa', janelaCobreGeracao);
}

// ---------- cenário realista: geração atrasada, voz do sistema assume ----------
console.log('== leitura contínua quando o áudio neural ainda não ficou pronto ==');
{
  // motor de voz falso que termina a frase logo, como o speechSynthesis real
  await ev(`(async () => {
    falaSistema.suportada = true;
    falaSistema.falar = (texto, aoFim) => { setTimeout(() => aoFim && aoFim(), 1); };
    falaSistema.parar = () => {};
    // metade dos capítulos SEM áudio pronto: o app tem de cair na voz do sistema
    for(let i = 0; i < ${N_CAPITULOS}; i += 2){
      await window.__apagarCap('sobrecarga', i);
    }
    estado.capIdx = 0; prepararCapitulo(); estado.fraseIdx = 0;
    window.__erros = [];
    await tocar();
  })()`);
  await espera(400);

  // A voz do sistema encadeia as frases sozinha; só damos o empurrão no fim
  // da mídia quando o capítulo está em modo áudio. Observamos sem interferir.
  let parou = -1, maiorCap = ev('estado.capIdx'), tentativas = 0;
  while(maiorCap < N_CAPITULOS - 1 && tentativas++ < 400){
    if(ev('estado.tocando') && ev('estado.modoAudio')){
      ev(`Object.defineProperty(audioEl, 'ended', {value: true, configurable: true});
          audioEl.dispatchEvent(new Event('pause'));
          audioEl.dispatchEvent(new Event('ended'));
          Object.defineProperty(audioEl, 'ended', {value: false, configurable: true});`);
    }
    await espera(20);
    if(!ev('estado.tocando') && parou < 0 && ev('estado.capIdx') < N_CAPITULOS - 1){
      parou = ev('estado.capIdx');
    }
    maiorCap = Math.max(maiorCap, ev('estado.capIdx'));
  }
  verificar('não pausa ao alternar entre voz neural e voz do sistema', parou < 0,
    `(parou no capítulo ${parou})`);
  verificar('percorreu o livro todo mesmo com áudio faltando',
    maiorCap === N_CAPITULOS - 1, `(chegou ao capítulo ${maiorCap})`);
  verificar('nenhum erro solto no modo misto', ev('window.__erros.length') === 0,
    `(${ev('JSON.stringify(window.__erros.slice(0,3))')})`);
}

// ---------- troca de voz no meio da leitura ----------
console.log('== troca de voz durante a leitura não derruba ==');
{
  await ev(`(async () => {
    estado.capIdx = 0; prepararCapitulo(); estado.fraseIdx = 0;
    piper.reiniciar = () => true;          // sem Worker real no jsdom
    piper.armazenadas = async () => ['pt_BR-faber-medium'];
    piper.vozes = async () => [{id:'pt_BR-faber-medium', nome:'Faber'},
                               {id:'pt_PT-tugão-medium', nome:'Tugão'}];
    gerador.apagarAudioLivro = async () => {};
    await tocar();
  })()`);
  await espera(120);
  let quebrou = false;
  try{
    const sel = d.getElementById('sel-voz-piper');
    sel.value = 'pt_PT-tugão-medium';
    sel.dispatchEvent(new w.Event('change'));
    await espera(250);
  }catch{ quebrou = true; }
  verificar('trocar de voz não lança exceção', !quebrou);
  verificar('player continua aberto após trocar de voz',
    !d.getElementById('tela-player').classList.contains('oculto'));
  verificar('nenhum erro solto na troca de voz', ev('window.__erros.length') === 0,
    `(${ev('JSON.stringify(window.__erros.slice(0,3))')})`);
}

// ---------- falhas do armazenamento não podem emudecer a leitura ----------
console.log('== banco falhando no meio da leitura ==');
{
  await ev(`(async () => {
    estado.capIdx = 0; prepararCapitulo(); estado.fraseIdx = 0;
    window.__erros = [];
    window.__obterReal = bd.obter.bind(bd);
    await tocar();
  })()`);
  await espera(150);
  // IndexedDB recusando (cota/pressão de espaço no iOS) na troca de capítulo
  ev(`bd.obter = async (loja, chave) => {
        if(loja === 'capAudio') throw new Error('UnknownError: quota');
        return window.__obterReal(loja, chave);
      }`);
  ev(`Object.defineProperty(audioEl, 'ended', {value: true, configurable: true});
      audioEl.dispatchEvent(new Event('pause'));
      audioEl.dispatchEvent(new Event('ended'));
      Object.defineProperty(audioEl, 'ended', {value: false, configurable: true});`);
  await espera(200);
  verificar('erro do banco não derruba a leitura', ev('estado.tocando') === true,
    `(tocando=${ev('estado.tocando')})`);
  verificar('caiu para a voz do sistema', ev('estado.modoAudio') === false);
  verificar('nenhum erro solto escapou', ev('window.__erros.length') === 0,
    `(${ev('JSON.stringify(window.__erros.slice(0,2))')})`);
  ev('bd.obter = window.__obterReal');
}

// ---------- correções apontadas na revisão sênior ----------
console.log('== proteções de armazenamento e memória ==');
{
  // limpeza de emergência centra em onde o leitor ESTÁ, não no capítulo gerado
  const preservou = await ev(`(async () => {
    for(const i of [3, 4, 5, 9]){
      await bd.salvar('capAudio', {chave: gerador.chaveCap('emerg', i), wav: new ArrayBuffer(32),
                                   mapa: [], duracao: 1, vozId: 'x', nFrases: 1});
    }
    gerador.capLendo = 4;
    await gerador.limparForaDaJanela('emerg', gerador.capLendo, 0, 1);
    const k = await bd.chaves('capAudio');
    return {atual: k.includes('emerg:4'), proximo: k.includes('emerg:5'), longe: k.includes('emerg:9')};
  })()`);
  verificar('emergência preserva o capítulo em leitura', preservou.atual);
  verificar('emergência preserva o próximo', preservou.proximo);
  verificar('emergência descarta o que está longe', !preservou.longe);

  // áudio de outros livros é liberado
  const limpou = await ev(`(async () => {
    // estado próprio, sem depender do que sobrou das etapas anteriores
    await bd.salvar('capAudio', {chave: 'outroLivro:0', wav: new ArrayBuffer(32),
                                 mapa: [], duracao: 1, vozId: 'x', nFrases: 1});
    await bd.salvar('capAudio', {chave: 'sobrecarga:0', wav: new ArrayBuffer(32),
                                 mapa: [], duracao: 1, vozId: 'x', nFrases: 1});
    await bd.salvar('wavs', {chave: 'outroLivro:0:0', buf: new ArrayBuffer(16)});
    await gerador.limparOutrosLivros('sobrecarga');
    const k = await bd.chaves('capAudio');
    const kw = await bd.chaves('wavs');
    return {saiu: !k.includes('outroLivro:0'),
            ficou: k.includes('sobrecarga:0'),
            frasesSoltasSairam: !kw.includes('outroLivro:0:0')};
  })()`);
  verificar('áudio de outro livro é liberado', limpou.saiu);
  verificar('áudio do livro aberto é preservado', limpou.ficou);
  verificar('frases soltas de outro livro também saem', limpou.frasesSoltasSairam);

  // o gerador não pode travar para sempre se algo lançar no laço
  const destravou = await ev(`(async () => {
    const aoMudarOrig = gerador.aoMudar;
    gerador.aoMudar = () => { throw new Error('explodiu na UI'); };
    gerador.falhas.clear();
    try{ await gerador._rodar(); }catch{}
    gerador.aoMudar = aoMudarOrig;
    return gerador.ativo === false;
  })()`);
  verificar('gerador não trava após exceção no laço', destravou);

  // reciclagem do worker nunca é desligada (phonemizador ainda vaza por frase)
  verificar('reciclagem do worker continua ativa mesmo com o patch',
    ev('piper._limiteReciclagem()') > 0 && ev('piper.FRASES_POR_WORKER_SEM_PATCH') < ev('piper.FRASES_POR_WORKER'));
  verificar('patch só é confirmado por reaproveitamento real',
    ev('piper._patchConfirmado') === false);
}

// ---------- regressões da revisão sênior ----------
console.log('== pipeline de geração não entra em laço ==');
{
  // Cenário: capítulos já prontos de uma sessão anterior. O aviso de "pronto"
  // reagendava a geração, que reencontrava os mesmos capítulos prontos, que
  // avisavam de novo… laço infinito relendo dezenas de MB por volta.
  const r = await ev(`(async () => {
    gerador.pedir = window.__pedirReal;                    // gerador de verdade
    gerador.limparForaDaJanela = window.__limparReal;
    // sem este estado, agendarGeracao() sai na porta e o teste passaria à toa
    estado.motor = 'piper'; piper.disponivel = true;
    piper.vozId = 'pt_BR-faber-medium'; estado.vozPiperPronta = true;
    gerador.prontos.clear(); gerador.falhas.clear(); gerador.fila = [];
    let eventos = 0;
    const aoMudarOrig = gerador.aoMudar;
    gerador.aoMudar = (ev) => { eventos++; if(eventos < 400) aoMudarOrig(ev); };
    for(let i = 0; i < 6; i++){
      await window.__gravarCap('sobrecarga', i, false);
    }
    estado.capIdx = 0; gerador.capLendo = 0;
    agendarGeracao();
    await new Promise(r => setTimeout(r, 600));
    gerador.aoMudar = aoMudarOrig;
    return {eventos, fila: gerador.fila.length, ativo: gerador.ativo};
  })()`);
  verificar('não dispara enxurrada de eventos "pronto"', r.eventos < 30,
    `(${r.eventos} eventos)`);
  verificar('fila de geração esvazia', r.fila === 0, `(${r.fila} na fila)`);
  verificar('gerador não fica preso ativo', r.ativo === false);

  // capítulo já pronto não pode voltar para a fila
  const naoReenfileira = await ev(`(() => {
    gerador.fila = [];
    gerador.prontos.add(gerador.chaveCap('sobrecarga', 2));
    gerador.pedir(estado.livro, 2);
    return gerador.fila.length === 0;
  })()`);
  verificar('capítulo pronto não volta para a fila', naoReenfileira);

  // mas se o áudio for apagado, ele precisa poder ser refeito
  const refaz = await ev(`(async () => {
    gerador.fila = []; gerador.falhas.clear();
    await gerador.limparForaDaJanela('sobrecarga', 99, 0, 0); // apaga tudo
    const restantes = (await bd.chaves('capAudio')).filter(c=>String(c).startsWith('sobrecarga:'));
    const esqueceu = !gerador.prontos.has(gerador.chaveCap('sobrecarga', 2));
    gerador.pedir(estado.livro, 2);
    const naFila = gerador.fila.some(f => f.capIdx === 2);
    const emCurso = gerador.atual?.capIdx === 2;
    gerador.fila = [];
    return {esqueceu, aceitou: naFila || emCurso, restantes, prontos: [...gerador.prontos]};
  })()`);
  verificar('apagar o áudio limpa o registro de "pronto"', refaz.esqueceu,
    `(capAudio=${JSON.stringify(refaz.restantes)} prontos=${JSON.stringify(refaz.prontos)})`);
  verificar('áudio apagado volta a ser gerável', refaz.aceitou);
}

console.log('== nunca duas vozes ao mesmo tempo ==');
{
  // Encerrar o que ficou rodando dos blocos anteriores: a voz do sistema falsa
  // encadeia frases sozinha e contaminaria a medição deste teste.
  ev('pausar(); falaSistema.parar(); estado.tocando = false; estado.modoAudio = false;');
  await espera(80);

  const r = await ev(`(async () => {
    gerador.pedir = () => {};
    // o bloco de troca de voz deixou o motor num estado que não gera áudio
    estado.motor = 'piper'; piper.disponivel = true;
    piper.vozId = 'pt_BR-faber-medium'; estado.vozPiperPronta = true;
    window.__falouDurante = 0;
    falaSistema.suportada = true;
    falaSistema.falar = (t, aoFim) => { window.__falouDurante++; setTimeout(() => aoFim && aoFim(), 5); };
    falaSistema.parar = () => {};
    falaSistema.estaFalando = () => false;   // pior caso: parece sempre mudo
    estado.capIdx = 0; prepararCapitulo(); estado.fraseIdx = 0;
    estado.tocando = true; estado.modoAudio = false;
    // banco lento, como no celular: a rede de segurança tem tempo de agir
    const obterReal = bd.obter.bind(bd);
    bd.obter = async (loja, chave) => {
      if(loja === 'capAudio') await new Promise(r => setTimeout(r, 120));
      return obterReal(loja, chave);
    };
    // bloco único: o capítulo do teste cabe num bloco só
    await bd.salvar('capAudio', {chave: gerador.chaveBloco('sobrecarga', 0, 0),
      wav: montarWav({canais:1,taxa:22050,bits:16}, [new Uint8Array(4410)]),
      mapa: estado.frases.map((_, k) => ({inicio: k*0.1, dur: 0.1})),
      duracao: estado.frases.length*0.1, vozId: piper.vozId,
      nFrases: estado.frases.length, semCitacoes: gerador._semCitacoesAgora(),
      de: 0, ate: estado.frases.length - 1, bloco: 0, nBlocos: 1,
      nFrasesCap: estado.frases.length});
    window.__falouDurante = 0;
    const p = _iniciarCapitulo();
    // durante o await, disparar exatamente o evento que acionava o socorro
    window.dispatchEvent(new window.Event('unhandledrejection'));
    await new Promise(r => setTimeout(r, 40));
    const falouNoMeio = window.__falouDurante;
    await p;
    bd.obter = obterReal;
    return {falouNoMeio, modoAudio: estado.modoAudio, tocando: estado.tocando};
  })()`);
  verificar('rede de segurança não fala por cima da transição', r.falouNoMeio === 0,
    `(voz do sistema chamada ${r.falouNoMeio}x durante o await)`);
  verificar('terminou em modo áudio', r.modoAudio === true);
  verificar('leitura segue ativa', r.tocando === true);
}

console.log('== fim de mídia detectado mesmo sem a flag ended ==');
{
  const r = await ev(`(() => {
    estado.tocando = true; estado.modoAudio = true;
    Object.defineProperty(audioEl, 'ended', {value: false, configurable: true});
    Object.defineProperty(audioEl, 'duration', {value: 10, configurable: true});
    Object.defineProperty(audioEl, 'currentTime', {value: 9.9, configurable: true, writable: true});
    audioEl.dispatchEvent(new Event('pause'));   // pause no fim, sem ended
    const sobreviveu = estado.tocando;
    // e uma pausa de verdade no meio ainda tem de pausar
    Object.defineProperty(audioEl, 'currentTime', {value: 2, configurable: true, writable: true});
    audioEl.dispatchEvent(new Event('pause'));
    return {sobreviveu, pausouNoMeio: estado.tocando === false};
  })()`);
  verificar('pause no fim da mídia não pausa (mesmo sem ended)', r.sobreviveu);
  verificar('pause no meio ainda pausa de verdade', r.pausouNoMeio);
}

// ---------- salto por tempo (voltar 15s / avançar 30s) ----------
console.log('== salto por tempo ==');
{
  ev('pausar(); falaSistema.parar(); estado.tocando=false; estado.modoAudio=false;');
  await espera(60);
  const r = await ev(`(async () => {
    gerador.pedir = () => {};
    estado.motor='piper'; piper.disponivel=true;
    piper.vozId='pt_BR-faber-medium'; estado.vozPiperPronta=true;
    estado.capIdx = 3; prepararCapitulo(); estado.fraseIdx = 0;
    const n = estado.frases.length;
    await bd.salvar('capAudio', {chave: gerador.chaveBloco('sobrecarga', 3, 0),
      wav: montarWav({canais:1,taxa:22050,bits:16},[new Uint8Array(4410)]),
      mapa: estado.frases.map((_, k) => ({inicio: k*10, dur: 10})),
      duracao: n*10, vozId: piper.vozId, nFrases: n,
      semCitacoes: gerador._semCitacoesAgora(),
      de: 0, ate: n - 1, bloco: 0, nBlocos: 1, nFrasesCap: n});
    estado.tocando = true;
    await _iniciarCapitulo();
    // linha do tempo controlada pelo teste. readyState: o jsdom não carrega
    // mídia de verdade, e o app (com razão) só mexe no tempo com metadados
    // prontos — sem isto, saltar reiniciaria o capítulo e gravaria progresso.
    let t = 40;
    Object.defineProperty(audioEl, 'currentTime', {configurable:true, get:()=>t, set:(v)=>{t=v;}});
    Object.defineProperty(audioEl, 'duration', {configurable:true, get:()=>n*10});
    Object.defineProperty(audioEl, 'readyState', {configurable:true, get:()=>1});
    const depoisVoltar = (saltarSegundos(-15), t);
    const depoisAvancar = (saltarSegundos(30), t);
    return {modoAudio: estado.modoAudio, depoisVoltar, depoisAvancar, capIdx: estado.capIdx};
  })()`);
  verificar('entrou em modo áudio para o teste', r.modoAudio === true);
  verificar('voltar 15s recua 15 segundos', r.depoisVoltar === 25, `(t=${r.depoisVoltar})`);
  verificar('avançar 30s adianta 30 segundos', r.depoisAvancar === 55, `(t=${r.depoisAvancar})`);
  verificar('salto não trocou de capítulo', r.capIdx === 3);

  // no fim da mídia, avançar deve mudar de capítulo em vez de estourar
  const passouCap = await ev(`(() => {
    const antes = estado.capIdx;
    audioEl.currentTime = audioEl.duration - 2;
    saltarSegundos(30);
    return estado.capIdx !== antes;
  })()`);
  verificar('avançar no fim do capítulo passa para o próximo', passouCap);

  // antes do início, voltar deve recuar de capítulo
  const voltouCap = await ev(`(() => {
    const antes = estado.capIdx;
    audioEl.currentTime = 1;
    saltarSegundos(-15);
    return estado.capIdx !== antes;
  })()`);
  verificar('voltar no início do capítulo volta ao anterior', voltouCap);

  // Voz do sistema: sem linha do tempo, o salto anda por frases estimadas pelo
  // número de palavras. Partindo do meio do capítulo, não deve trocar de trecho.
  const sistema = await ev(`(() => {
    estado.modoAudio = false; estado.tocando = false;
    estado.capIdx = 5; prepararCapitulo();
    const ultima = estado.frases.length - 1;
    estado.fraseIdx = ultima;
    const capAntes = estado.capIdx;
    saltarSegundos(-15);
    const recuou = estado.fraseIdx < ultima && estado.capIdx === capAntes;
    const posRecuo = estado.fraseIdx;
    saltarSegundos(15);
    const avancou = estado.fraseIdx > posRecuo || estado.capIdx !== capAntes;
    return {recuou, avancou, ultima, posRecuo, cap: estado.capIdx, capAntes};
  })()`);
  verificar('voz do sistema: voltar 15s recua frases sem trocar de capítulo',
    sistema.recuou, `(de ${sistema.ultima} para ${sistema.posRecuo}, cap ${sistema.capAntes}→${sistema.cap})`);
  verificar('voz do sistema: avançar 15s adianta a leitura', sistema.avancou);

  // Perto do começo do capítulo, voltar 15s cruza para o trecho anterior —
  // é o comportamento certo: 15 segundos atrás realmente estavam lá.
  const cruzou = await ev(`(() => {
    estado.modoAudio = false; estado.tocando = false;
    estado.capIdx = 5; prepararCapitulo(); estado.fraseIdx = 0;
    const antes = estado.capIdx;
    saltarSegundos(-15);
    return estado.capIdx < antes;
  })()`);
  verificar('voltar 15s no começo do capítulo cruza para o anterior', cruzou);
}

// ---------- preparar livro inteiro ----------
console.log('== preparar livro inteiro ==');
{
  const r = await ev(`(async () => {
    // gerar rápido e sem worker
    gerador._gerarCapitulo = async (livro, capIdx) => {
      await bd.salvar('capAudio', {chave: gerador.chaveCap(livro.id, capIdx),
        wav: new ArrayBuffer(64), mapa: [{inicio:0,dur:1}], duracao: 1,
        vozId: piper.vozId, nFrases: frasesDoCapitulo(livro.capitulos[capIdx]).length});
    };
    gerador.prontos.clear(); gerador.falhas.clear();
    await bd.apagarPrefixo('capAudio', 'sobrecarga:');
    const eventos = [];
    gerador.aoPreparar = (e) => eventos.push(e.estado);
    const res = await gerador.prepararLivroInteiro(estado.livro, 0);
    gerador.aoPreparar = null;
    const chaves = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('sobrecarga:'));
    return {res, gerados: chaves.length, avisou: eventos.includes('gerando'),
            terminou: eventos[eventos.length-1]};
  })()`);
  verificar('preparou todos os capítulos', r.res.status === 'completo',
    `(status=${r.res.status})`);
  verificar(`gerou os ${N_CAPITULOS} capítulos`, r.gerados === N_CAPITULOS,
    `(${r.gerados} em disco)`);
  verificar('informou o progresso durante o preparo', r.avisou);
  verificar('avisou a conclusão', r.terminou === 'completo', `(${r.terminou})`);

  // a limpeza por janela NÃO pode apagar o livro preparado
  const sobreviveu = await ev(`(async () => {
    await gerador.marcarPreparado('sobrecarga', true);
    await gerador.limparForaDaJanela('sobrecarga', 0);   // uso normal
    const depois = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('sobrecarga:')).length;
    return depois;
  })()`);
  verificar('limpeza normal preserva o livro preparado', sobreviveu === N_CAPITULOS,
    `(sobraram ${sobreviveu})`);

  // mas a emergência de espaço ainda pode limpar
  const emergencia = await ev(`(async () => {
    await gerador.limparForaDaJanela('sobrecarga', 0, 0, 1, null, true); // forcar
    const depois = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('sobrecarga:')).length;
    return depois;
  })()`);
  verificar('emergência de espaço ainda consegue limpar', emergencia < N_CAPITULOS,
    `(sobraram ${emergencia})`);

  // marca sobrevive ao recarregar (fica no banco)
  const persistiu = await ev(`(async () => {
    await gerador.marcarPreparado('sobrecarga', true);
    gerador.livrosPreparados = new Set();
    await gerador.carregarPreparados();
    return gerador.livrosPreparados.has('sobrecarga');
  })()`);
  verificar('marca de "livro preparado" persiste entre sessões', persistiu);

  // estimativa de espaço é plausível
  const est = ev(`gerador.estimarBytesLivro(estado.livro)`);
  verificar('estimativa de tamanho é plausível', est > 1048576 && est < 5e9,
    `(${Math.round(est/1048576)} MB)`);
}

// ---------- achados da 3ª revisão sênior ----------
console.log('== preparo parcial não pode desligar a proteção de espaço ==');
{
  // Marcar um livro como "preparado" desliga a poda por janela. Se um preparo
  // que parou por falta de espaço marcasse o livro, o freio de armazenamento
  // sumiria justamente num aparelho já sem espaço — o bug histórico voltaria.
  const r = await ev(`(async () => {
    let n = 0;
    gerador._gerarCapitulo = async (livro, capIdx) => {
      if(++n > 3) { const e = new Error('QuotaExceededError'); throw e; }
      await bd.salvar('capAudio', {chave: gerador.chaveCap(livro.id, capIdx),
        wav: new ArrayBuffer(64), mapa:[{inicio:0,dur:1}], duracao:1,
        vozId: piper.vozId, nFrases: frasesDoCapitulo(livro.capitulos[capIdx]).length,
        semCitacoes: gerador._semCitacoesAgora()});
    };
    gerador.prontos.clear(); gerador.falhas.clear();
    gerador.livrosPreparados.delete('sobrecarga');
    await bd.apagarPrefixo('capAudio', 'sobrecarga:');
    const res = await gerador.prepararLivroInteiro(estado.livro, 0);
    // o app só marca quando o status é 'completo'
    await gerador.marcarPreparado(estado.livro.id, res.status === 'completo');
    return {status: res.status, feitos: res.feitos,
            marcado: gerador.livrosPreparados.has('sobrecarga')};
  })()`);
  verificar('preparo interrompido não reporta "completo"', r.status !== 'completo',
    `(status=${r.status}, feitos=${r.feitos})`);
  verificar('preparo parcial NÃO marca o livro como preparado', r.marcado === false);

  // com o livro desmarcado, a poda por janela volta a funcionar
  const podou = await ev(`(async () => {
    const antes = (await bd.chaves('capAudio')).filter(c=>String(c).startsWith('sobrecarga:')).length;
    await gerador.limparForaDaJanela('sobrecarga', 0);
    const depois = (await bd.chaves('capAudio')).filter(c=>String(c).startsWith('sobrecarga:')).length;
    return {antes, depois};
  })()`);
  verificar('poda por janela volta a agir no livro não preparado',
    podou.depois <= podou.antes, `(${podou.antes} → ${podou.depois})`);
}

console.log('== cancelar no meio do preparo ==');
{
  const r = await ev(`(async () => {
    gerador._gerarCapitulo = async () => { await new Promise(r => setTimeout(r, 60)); };
    gerador.prontos.clear(); gerador.falhas.clear();
    gerador.livrosPreparados.delete('sobrecarga');
    const p = gerador.prepararLivroInteiro(estado.livro, 0);
    await new Promise(r => setTimeout(r, 100));
    // trocar de voz / apagar livro chamam cancelarLivro por baixo
    gerador.cancelarLivro('sobrecarga');
    const res = await p;
    return {status: res.status, feitos: res.feitos, ativo: gerador.ativo,
            preparando: gerador.preparandoTudo};
  })()`);
  verificar('cancelarLivro interrompe o preparo', r.status === 'cancelado',
    `(status=${r.status}, feitos=${r.feitos})`);
  verificar('preparo cancelado não diz "completo"', r.status !== 'completo');
  verificar('lock do gerador é devolvido', r.ativo === false && r.preparando === false);
}

console.log('== preferência de citações invalida o áudio de TODOS os livros ==');
{
  const r = await ev(`(() => {
    const reg = {nFrases: 10, vozId: piper.vozId, semCitacoes: true};
    window.PULAR_CITACOES = true;
    const serveIgual = gerador.audioServe(reg, 10);
    window.PULAR_CITACOES = false;      // usuário desligou a opção
    const serveDiferente = gerador.audioServe(reg, 10);
    window.PULAR_CITACOES = true;
    // registro antigo, sem o campo, conta como padrão (com limpeza)
    const antigo = gerador.audioServe({nFrases:10, vozId:piper.vozId}, 10);
    return {serveIgual, serveDiferente, antigo};
  })()`);
  verificar('áudio gerado com a mesma preferência serve', r.serveIgual === true);
  verificar('áudio de outra preferência é descartado', r.serveDiferente === false);
  verificar('registro antigo sem o campo continua válido', r.antigo === true);
}

// ---------- leitura contínua num livro grande ----------
console.log('== rolagem contínua não joga o livro todo no DOM ==');
{
  const r = await ev(`(async () => {
    estado.capIdx = 10; prepararCapitulo(); desenharCapitulo();
    const area = document.getElementById('texto-leitura');
    Object.defineProperty(area, 'scrollHeight', {configurable:true, get:()=>1000});
    Object.defineProperty(area, 'clientHeight', {configurable:true, get:()=>400});
    const inicial = area.querySelectorAll('.cap-secao').length;
    // rolar para o fim várias vezes: tem de estender de um em um
    const passos = [];
    for(let k = 0; k < 4; k++){
      area.scrollTop = 600;
      _estenderLeitura();
      passos.push(area.querySelectorAll('.cap-secao').length);
    }
    // rolar para o topo estende para trás
    area.scrollTop = 0;
    _estenderLeitura();
    const aposTopo = area.querySelectorAll('.cap-secao').length;
    return {inicial, passos, aposTopo,
            total: ${N_CAPITULOS},
            frases: area.querySelectorAll('.frase').length};
  })()`);
  verificar('começa com poucos capítulos, não com o livro todo',
    r.inicial < r.total, `(${r.inicial} de ${r.total})`);
  verificar('cada rolagem acrescenta um capítulo',
    r.passos.every((v, i) => v === r.inicial + i + 1), `(${r.passos.join(',')})`);
  verificar('rolar para o topo estende para trás', r.aposTopo > r.passos[r.passos.length-1],
    `(${r.passos[r.passos.length-1]} → ${r.aposTopo})`);
  verificar('DOM continua enxuto', r.frases < 400, `(${r.frases} frases na tela)`);
}

// ---------- capítulo longo: ouvir sem esperar a síntese inteira ----------
console.log('== capítulo grande começa a tocar no primeiro bloco ==');
{
  const r = await ev(`(async () => {
    if(window.__obterReal) bd.obter = window.__obterReal;  // limpar stubs anteriores
    gerador._gerarCapitulo = window.__gerarCapReal;        // geração de verdade
    gerador.fila = []; gerador.ativo = false; gerador.preparandoTudo = false;
    // capítulo com 200 frases, como um capítulo real de livro
    const frases = [];
    for(let i = 1; i <= 200; i++) frases.push('Esta e a frase numero ' + i + ' do capitulo longo.');
    const livro = {id:'longo', titulo:'Longo', autor:'', tipo:'txt', capa:null,
      capitulos:[{titulo:'1. Capitulo longo', texto: frases.join(' '), incluir:true}],
      palavras: 2000, criadoEm: Date.now()};
    await bd.salvar('livros', livro);
    estado.livros = await bd.todos('livros');
    await abrirLivro('longo');
    const nFrases = estado.frases.length;
    const faixas = gerador.blocosDoCapitulo(nFrases);

    // contar quantas frases foram sintetizadas ATÉ o primeiro bloco ficar pronto
    let sintetizadas = 0, atePrimeiroBloco = null;
    gerador.aoMudar = (ev) => {
      if(ev.estado === 'gerando') sintetizadas = ev.feito;
      if(ev.estado === 'bloco-pronto' && atePrimeiroBloco === null) atePrimeiroBloco = sintetizadas;
    };
    piper.gerar = async () => montarWav({canais:1,taxa:22050,bits:16},[new Uint8Array(200)]);
    piper.armazenadas = async () => [piper.vozId];
    gerador.prontos.clear(); gerador.falhas.clear();
    gerador.capLendo = 0; gerador.frasLendo = 0;
    gerador.atual = {livroId:'longo', capIdx:0, cancelado:false};
    let erroGer = null;
    try{ await gerador._gerarCapitulo(livro, 0); }catch(e){ erroGer = String(e && e.message || e); }
    gerador.aoMudar = null;

    const chaves = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('longo:0:'));
    return {nFrases, nBlocos: faixas.length, atePrimeiroBloco, blocosNoBanco: chaves.length,
            tamBloco: gerador.TAM_BLOCO, erroGer, amostra: (await bd.chaves('capAudio')).map(String).slice(0,3)};
  })()`);
  verificar('capítulo longo é fatiado em vários blocos', r.nBlocos > 5,
    `(${r.nFrases} frases em ${r.nBlocos} blocos)`);
  verificar('primeiro áudio sai após poucas frases, não após o capítulo todo',
    r.atePrimeiroBloco <= r.tamBloco,
    `(${r.atePrimeiroBloco} frases para o 1º bloco, de ${r.nFrases})`);
  verificar('a espera cai pelo menos 5×', r.atePrimeiroBloco * 5 <= r.nFrases,
    `(${r.atePrimeiroBloco} vs ${r.nFrases})`);
  verificar('todos os blocos foram gravados', r.blocosNoBanco === r.nBlocos,
    `(${r.blocosNoBanco} de ${r.nBlocos}; erro=${r.erroGer}; chaves=${JSON.stringify(r.amostra)})`);
}

console.log('== tocar um bloco do meio e emendar o seguinte ==');
{
  const r = await ev(`(async () => {
    estado.capIdx = 0; prepararCapitulo();
    // posicionar numa frase do 3º bloco
    const alvo = gerador.TAM_BLOCO * 2 + 3;
    estado.fraseIdx = alvo;
    estado.tocando = true;
    const ok = await tentarModoAudio();
    const b = estado.blocoAtual;
    const cobre = b && alvo >= b.de && alvo <= b.ate;
    // emendar o próximo bloco (fim da mídia)
    const capAntes = estado.capIdx;
    await emendarProximoBloco();
    const b2 = estado.blocoAtual;
    return {ok, bloco: b?.bloco, cobre, blocoDepois: b2?.bloco,
            capMudou: estado.capIdx !== capAntes, fraseDepois: estado.fraseIdx,
            tamBloco: gerador.TAM_BLOCO};
  })()`);
  verificar('carrega o bloco que contém a frase pedida', r.ok && r.cobre,
    `(bloco ${r.bloco})`);
  verificar('fim do bloco emenda o próximo, sem trocar de capítulo',
    r.blocoDepois === r.bloco + 1 && !r.capMudou,
    `(bloco ${r.bloco} → ${r.blocoDepois}, capMudou=${r.capMudou})`);
  verificar('cursor continua na sequência', r.fraseDepois === r.tamBloco * 3,
    `(frase ${r.fraseDepois})`);
}

// ---------- o livro preparado sobrevive a fechar o app ----------
console.log('== livro preparado continua lá depois de fechar o app ==');
{
  const r = await ev(`(async () => {
    gerador._gerarCapitulo = window.__gerarCapReal;
    gerador.fila = []; gerador.ativo = false; gerador.preparandoTudo = false;
    if(window.__obterReal) bd.obter = window.__obterReal;
    piper.armazenadas = async () => [piper.vozId];
    piper.gerar = async () => montarWav({canais:1,taxa:22050,bits:16},[new Uint8Array(200)]);

    const caps = [];
    for(let c = 1; c <= 4; c++){
      const fr = [];
      for(let i = 1; i <= 25; i++) fr.push('Frase ' + i + ' do capitulo ' + c + '.');
      caps.push({titulo: c + '. Cap ' + c, texto: fr.join(' '), incluir: true});
    }
    await bd.salvar('livros', {id:'guardado', titulo:'Guardado', autor:'', tipo:'txt',
      capa:null, capitulos:caps, palavras:400, criadoEm:Date.now()});
    estado.livros = await bd.todos('livros');
    await abrirLivro('guardado');
    gerador.prontos.clear(); gerador.falhas.clear();

    const res = await gerador.prepararLivroInteiro(estado.livro, 0);
    await gerador.marcarPreparado('guardado', res.status === 'completo');
    const blocos = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('guardado:')).length;

    // "fechou o app": o estado em memória some, só o banco permanece
    gerador.livrosPreparados = new Set();
    gerador.prontos.clear();
    await gerador.carregarPreparados();
    const marcaSobreviveu = gerador.livrosPreparados.has('guardado');

    // ouvir de novo NÃO pode fazer a poda comer o livro preparado
    estado.capIdx = 0;
    await gerador.limparForaDaJanela('guardado', 0);
    const aposPoda = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('guardado:')).length;
    return {status: res.status, blocos, marcaSobreviveu, aposPoda};
  })()`);
  verificar('preparo terminou completo', r.status === 'completo', `(${r.status})`);
  verificar('áudio ficou gravado no banco', r.blocos > 0, `(${r.blocos} blocos)`);
  verificar('marca de "pronto offline" sobrevive ao fechar o app', r.marcaSobreviveu);
  verificar('a poda por janela não come o livro preparado', r.aposPoda === r.blocos,
    `(${r.blocos} → ${r.aposPoda})`);
}

console.log('== liberar espaço mantém livro e progresso ==');
{
  const r = await ev(`(async () => {
    gerador.apagarAudioLivro = window.__apagarAudioReal;  // testes antes trocaram por no-op
    estado.capIdx = 2; prepararCapitulo(); estado.fraseIdx = 5;
    salvarProgressoAgora();
    await new Promise(r => setTimeout(r, 40));
    const progAntes = await bd.obter('progresso', 'guardado');
    const antes = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('guardado:')).length;
    const tam = await gerador.tamanhoAudioLivro(estado.livro);

    const co = window.confirm; window.confirm = () => true;
    await liberarAudioDoLivro();
    window.confirm = co;
    await new Promise(r => setTimeout(r, 80));

    const depois = (await bd.chaves('capAudio')).filter(c => String(c).startsWith('guardado:')).length;
    const progDepois = await bd.obter('progresso', 'guardado');
    return {antes, depois, infoTela: document.getElementById('preparo-info').textContent,
            livroId: estado.livro && estado.livro.id,
            preparando: gerador.preparandoTudo, tamMB: Math.round(tam.bytes / 1048576),
            livroFicou: !!(await bd.obter('livros', 'guardado')),
            progIgual: progAntes && progDepois &&
                       progAntes.capIdx === progDepois.capIdx &&
                       progAntes.fraseIdx === progDepois.fraseIdx,
            desmarcado: !gerador.livrosPreparados.has('guardado')};
  })()`);
  verificar('mostra um tamanho plausível antes de liberar', r.tamMB > 0, `(${r.tamMB} MB)`);
  verificar('liberar apaga todo o áudio do livro', r.antes > 0 && r.depois === 0,
    `(${r.antes} → ${r.depois}; tela="${r.infoTela}")`);
  verificar('o livro continua na estante', r.livroFicou);
  verificar('o ponto da leitura é preservado', r.progIgual);
  verificar('livro deixa de contar como "pronto offline"', r.desmarcado);
}

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nSOBRECARGA OK');
process.exit(falhas.length ? 1 : 0);
