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
