// Harness comum: carrega o index.html real no jsdom com os scripts do app.
// O pdf.worker é injetado como script clássico porque o jsdom não tem Worker
// (no navegador o pdf.js usa worker de verdade).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

export async function carregarApp(){
  const raiz = new URL('../', import.meta.url);
  let html = readFileSync(new URL('index.html', raiz), 'utf8');
  html = html.replace('<script src="vendor/pdf.min.js"></script>',
    '<script src="vendor/pdf.min.js"></script>\n<script src="vendor/pdf.worker.min.js"></script>');

  const vc = new VirtualConsole(); // silencia "Not implemented" de mídia do jsdom
  vc.on('jsdomError', () => {});

  const dom = new JSDOM(html, {
    url: pathToFileURL(fileURLToPath(new URL('index.html', raiz))).href,
    contentType: 'text/html',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window){
      window.DecompressionStream = DecompressionStream;
      window.ReadableStream = ReadableStream;
      window.WritableStream = WritableStream;
      window.TransformStream = TransformStream;
      window.structuredClone = structuredClone;
      window.confirm = () => true;
      window.Element.prototype.scrollIntoView = () => {};
      if(!window.crypto?.subtle) Object.defineProperty(window, 'crypto', { value: crypto });
    }
  });
  // esperar todos os scripts carregarem e o iniciar() rodar
  await new Promise(res => {
    if(dom.window.document.readyState === 'complete') res();
    else dom.window.addEventListener('load', res);
  });
  await new Promise(r => setTimeout(r, 400));
  if(typeof dom.window.executarLimpeza !== 'function'){
    throw new Error('Scripts do app não carregaram no jsdom.');
  }
  return dom;
}

export function criarVerificador(){
  const falhas = [];
  const verificar = (nome, cond, extra = '') => {
    if(cond) console.log(`  ok  ${nome}`);
    else { console.log(`FALHA ${nome} ${extra}`); falhas.push(nome); }
  };
  return { falhas, verificar };
}

export function arquivoDe(w, caminho, nome, tipo){
  const buf = readFileSync(new URL(caminho, import.meta.url));
  return new w.File([buf], nome, { type: tipo });
}
