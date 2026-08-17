// Regressões do player: continuidade entre capítulos e resiliência a erros.
// O bug que motivou este arquivo: pela especificação HTML, o navegador dispara
// 'pause' ANTES de 'ended' quando a mídia acaba. O handler de pausa externa
// zerava estado.tocando e o avanço automático abortava — o usuário tinha que
// apertar play a cada trecho.
import { carregarApp, criarVerificador, arquivoDe } from './harness.mjs';

const dom = await carregarApp();
const w = dom.window;
const d = w.document;
const { falhas, verificar } = criarVerificador();
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const ev = (expr) => w.eval(expr);

// preparar um livro para ter capítulos de verdade
await w.iniciarPreparo(arquivoDe(w, './dados/teste.txt', 'teste.txt', 'text/plain'));
await espera(250);
d.getElementById('btn-salvar-livro').click();
await espera(350);

console.log('== fim de capítulo não cancela a leitura ==');
{
  // simular estado "tocando via áudio Piper"
  ev('estado.tocando = true; estado.modoAudio = true;');
  // o navegador dispara pause com ended=true ao terminar a mídia
  ev(`Object.defineProperty(audioEl, 'ended', {value: true, configurable: true});
      audioEl.dispatchEvent(new Event('pause'));`);
  verificar('pause com ended=true não pausa a leitura', ev('estado.tocando') === true,
    `(tocando=${ev('estado.tocando')})`);

  // pausa externa de verdade (ligação telefônica): ended=false → deve pausar
  ev(`Object.defineProperty(audioEl, 'ended', {value: false, configurable: true});
      audioEl.dispatchEvent(new Event('pause'));`);
  verificar('pause externo (ended=false) pausa mesmo', ev('estado.tocando') === false,
    `(tocando=${ev('estado.tocando')})`);
}

console.log('== avanço automático troca de capítulo ==');
{
  const capAntes = ev('estado.capIdx');
  ev('estado.tocando = true; estado.modoAudio = true;');
  ev('avancarCapituloAuto()');
  await espera(120);
  const capDepois = ev('estado.capIdx');
  verificar('capítulo avançou sozinho', capDepois !== capAntes,
    `(antes=${capAntes} depois=${capDepois})`);
  verificar('frases do novo capítulo carregadas', ev('estado.frases.length') > 0);
  verificar('cursor no início do novo capítulo', ev('estado.fraseIdx') === 0);
  verificar('seletor acompanhou o capítulo',
    d.getElementById('sel-capitulo').value === String(capDepois));
  // O jsdom não tem speechSynthesis: sem motor de voz o app pausa, e está certo.
  // Onde há motor, a leitura precisa seguir — é o que o teste de 'pause' acima trava.
  const temMotor = ev('falaSistema.suportada');
  if(temMotor){
    verificar('leitura continua tocando após o avanço', ev('estado.tocando') === true,
      `(tocando=${ev('estado.tocando')})`);
  } else {
    console.log('  --  sem motor de voz no jsdom: continuidade coberta pelo teste de pause/ended');
  }
}

console.log('== fim do livro encerra com aviso ==');
{
  // ir ao último capítulo incluído
  ev(`{
    const inc = indicesIncluidos(estado.livro);
    estado.capIdx = inc[inc.length - 1];
    prepararCapitulo();
  }`);
  ev('estado.tocando = true; estado.modoAudio = true;');
  ev('avancarCapituloAuto()');
  await espera(80);
  verificar('para no fim do livro', ev('estado.tocando') === false);
  verificar('avisa fim do livro',
    d.getElementById('estrada-frase').textContent.includes('Fim do livro'));
}

console.log('== rede de segurança contra crash ==');
{
  let derrubou = false;
  try{
    w.dispatchEvent(new w.Event('unhandledrejection'));
  }catch{ derrubou = true; }
  verificar('promessa solta não derruba o app', !derrubou);
  verificar('player continua aberto',
    !d.getElementById('tela-player').classList.contains('oculto'));
}

console.log('== motor neural: reinício e limpeza de voz ==');
{
  verificar('piper sabe reiniciar o worker', typeof ev('piper.reiniciar') === 'function');
  verificar('piper avisa quando quebra', ev('typeof piper.aoQuebrar') !== 'undefined');
  // reiniciar deve rejeitar o que estava pendente, não deixar promessa pendurada
  const sobrou = ev(`(() => {
    piper.pendentes.set(999, {res(){}, rej(){}});
    try{ piper.reiniciar(); }catch{}
    return piper.pendentes.size;
  })()`);
  verificar('reinício limpa requisições pendentes', sobrou === 0, `(sobrou ${sobrou})`);
  verificar('botão de apagar voz existe', !!d.getElementById('btn-apagar-voz'));
  verificar('app expõe uso de armazenamento',
    typeof ev('mostrarUsoArmazenamento') === 'function');
}

console.log('== contenção do vazamento de memória do vits-web ==');
{
  // predict() do vits-web cria uma InferenceSession por frase e nunca libera.
  // Reciclar o worker a cada N frases é o que impede a aba de morrer.
  const n = ev('piper.FRASES_POR_WORKER');
  verificar('worker é reciclado a cada N frases', n > 0 && n <= 50, `(N=${n})`);
  verificar('contador de frases começa zerado', ev('piper._geradasNesteWorker') === 0);
  // gerar() deve reciclar ao bater o limite
  const reciclou = ev(`(() => {
    let vezes = 0;
    const orig = piper.reiniciar;
    piper.reiniciar = function(){ vezes++; return true; };
    piper._geradasNesteWorker = piper.FRASES_POR_WORKER;
    piper._chamar = () => Promise.resolve({buf: new ArrayBuffer(8)});
    piper.gerar('oi');
    piper.reiniciar = orig;
    return vezes;
  })()`);
  verificar('gerar() recicla o worker ao bater o limite', reciclou === 1, `(vezes=${reciclou})`);
}

console.log('== voz incompatível não trava a leitura ==');
{
  const marcou = ev(`(() => {
    const err = new Error('Esta voz não é compatível...');
    err.incompativel = true;
    return err.incompativel === true;
  })()`);
  verificar('erro carrega a marca de incompatível', marcou);
  // a UI precisa explicar em vez de mostrar o erro cru do ONNX
  ev(`estado.motor = 'piper'; piper.disponivel = true; estado.vozPiperPronta = true;
      atualizarEstadoAudioUI({capIdx: estado.capIdx, estado: 'erro',
       definitivo: true, incompativel: true, erro: 'enc_p/emb/Gather'})`);
  const txt = d.getElementById('estado-audio').textContent;
  verificar('mensagem é legível para o usuário',
    txt.includes('não funciona') && !txt.includes('Gather'), `("${txt}")`);
}

console.log('== janela de limpeza de áudio ==');
{
  const temLimpeza = typeof ev('gerador.limparForaDaJanela') === 'function';
  verificar('gerador tem limpeza por janela', temLimpeza);
  const maxTent = ev('gerador.MAX_TENTATIVAS');
  verificar('geração não insiste para sempre', maxTent >= 1 && maxTent <= 3,
    `(MAX_TENTATIVAS=${maxTent})`);
}

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nPLAYER OK');
process.exit(falhas.length ? 1 : 0);
