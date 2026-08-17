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
await ev(`(async () => {
  const fmt = {canais: 1, taxa: 22050, bits: 16};
  for(let i = 0; i < ${N_CAPITULOS}; i++){
    const frases = frasesDoCapitulo(estado.livro.capitulos[i]);
    const mapa = frases.map((_, k) => ({inicio: k * 0.5, dur: 0.5}));
    const pcm = new Uint8Array(Math.round(22050 * 2 * 0.5 * frases.length) & ~1);
    await bd.salvar('capAudio', {
      chave: gerador.chaveCap('sobrecarga', i),
      wav: montarWav(fmt, [pcm]), mapa,
      duracao: frases.length * 0.5, vozId: piper.vozId, nFrases: frases.length
    });
  }
})()`);

// ---------- ligar o modo neural e neutralizar o que o jsdom não faz ----------
await ev(`(() => {
  estado.motor = 'piper';
  piper.disponivel = true;
  estado.vozPiperPronta = true;
  // não gerar de verdade durante o teste
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
      await bd.apagar('capAudio', gerador.chaveCap('sobrecarga', i));
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

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nSOBRECARGA OK');
process.exit(falhas.length ? 1 : 0);
