// Parsing + limpeza com arquivos reais (PDF feio, EPUB, TXT longo).
import { carregarApp, criarVerificador, arquivoDe } from './harness.mjs';

const dom = await carregarApp();
const w = dom.window;
const { falhas, verificar } = criarVerificador();

console.log('== ambiente ==');
verificar('pdfjsLib carregou', typeof w.pdfjsLib !== 'undefined');
verificar('fake worker presente (só no jsdom)', !!w.pdfjsWorker?.WorkerMessageHandler);

console.log('== TXT ==');
{
  const bruto = await w.importarTxt(arquivoDe(w, './dados/teste.txt', 'teste.txt', 'text/plain'));
  const { capitulos, contagens } = w.executarLimpeza(bruto, w.REGRAS_PADRAO);
  const lidos = capitulos.filter(c => c.incluir);
  verificar('3 capítulos detectados', capitulos.length === 3, `(veio ${capitulos.length})`);
  // capítulos curtos do miolo não são mais excluídos automaticamente
  verificar('capítulos com texto incluídos', lidos.length === 3,
    `(lidos=${lidos.length})`);
  const tudo = capitulos.map(c => c.texto).join('\n');
  verificar('números de página removidos', contagens.numeros >= 5, `(${contagens.numeros})`);
  verificar('hifenização unida', tudo.includes('caminhão subia') && tudo.includes('acompanhava o ritmo'));
  verificar('linhas duras remontadas', !/volante\.\nA noite/.test(tudo));
}

console.log('== EPUB ==');
{
  const bruto = await w.importarEpub(arquivoDe(w, './dados/teste.epub', 'teste.epub', 'application/epub+zip'));
  verificar('título do OPF', bruto.tituloSugerido === 'Noites na BR-116');
  verificar('autor do OPF', bruto.autor === 'A. Viajante');
  const { capitulos } = w.executarLimpeza(bruto, w.REGRAS_PADRAO);
  verificar('3 capítulos (nav excluído)', capitulos.length === 3, `(veio ${capitulos.length})`);
  verificar('título do capítulo 1', capitulos[0]?.titulo === 'A partida');
}

console.log('== PDF ==');
{
  const bruto = await w.importarPdf(arquivoDe(w, './dados/teste.pdf', 'teste.pdf', 'application/pdf'), () => {});
  verificar('6 páginas extraídas', bruto.paginas.length === 6, `(veio ${bruto.paginas.length})`);
  const { capitulos, contagens } = w.executarLimpeza(bruto, w.REGRAS_PADRAO);
  const tudo = capitulos.map(c => c.texto).join('\n');
  verificar('cabeçalho repetido removido', !tudo.includes('REVISTA BRASILEIRA'));
  verificar('números de página removidos', contagens.numeros >= 4, `(${contagens.numeros})`);
  verificar('notas de rodapé removidas', !tudo.includes('Nota de rodape'));
  verificar('hifenização unida', /caminhoneiro/.test(tudo) && /mostravam/.test(tudo));
  verificar('capítulos por fonte grande', capitulos.length >= 2, `(veio ${capitulos.length})`);
}

console.log('== frases ==');
{
  const fr = w.dividirFrases('O Dr. Silva chegou cedo. Trouxe café. A viagem começou às 6h e seguiu sem paradas até o anoitecer.');
  verificar('abreviação Dr. não quebra', fr[0].startsWith('O Dr. Silva chegou cedo'));
  verificar('3 frases', fr.length === 3, `(veio ${fr.length})`);
  const longa = w.dividirFrases('palavra '.repeat(80).trim() + '.');
  verificar('frase gigante fatiada', longa.every(f => f.length <= 262));
}

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nPARSERS OK');
process.exit(falhas.length ? 1 : 0);
