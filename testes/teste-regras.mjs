// Regras de limpeza endurecidas + classificador de miolo + títulos falados + WAV.
import { carregarApp, criarVerificador } from './harness.mjs';

const dom = await carregarApp();
const w = dom.window;
const { falhas, verificar } = criarVerificador();

console.log('== números de página ==');
verificar('"xii" pega', w.ehNumeroPagina('xii'));
verificar('"IV." pega', w.ehNumeroPagina('IV.'));
verificar('"- 42 -" pega', w.ehNumeroPagina('- 42 -'));
verificar('"civil" NÃO pega', !w.ehNumeroPagina('civil'));
verificar('"mim." NÃO pega', !w.ehNumeroPagina('mim.'));

console.log('== hifenização ==');
verificar('"segunda-feira" preserva hífen', w.regraHifenizacao('era segunda-\nfeira cedo').resultado.includes('segunda-feira'));
verificar('"companheiro" junta', w.regraHifenizacao('o compa-\nnheiro fiel').resultado.includes('companheiro'));

console.log('== cabeçalho vs título ==');
{
  const pags = Array.from({length: 10}, (_, i) => ({num: i + 1, altura: 800, linhas: [
    {texto: `Capítulo ${i + 1}`, y: 780, tam: 18},
    {texto: `Miolo variado da página ${i + 1}, assunto ${i * 7}.`, y: 700, tam: 11},
    {texto: 'Editora Estrada Ltda.', y: 20, tam: 8},
  ]}));
  const r = w.regraCabecalhoRodape(pags);
  const sobrou = r.resultado.flatMap(p => p.linhas.map(l => l.texto)).join('\n');
  verificar('títulos sobrevivem', sobrou.includes('Capítulo 3'));
  verificar('rodapé de editora sai', !sobrou.includes('Editora Estrada'));
}

console.log('== classificador de miolo ==');
{
  const toc = {titulo: 'Trecho 1', texto: Array.from({length: 12}, (_, i) => `1.${i} Alguma seção do livro ....... ${10 + i * 7}`).join('\n\n')};
  verificar('sumário é pulado', !w.classificarCapitulo(toc).incluir, JSON.stringify(w.classificarCapitulo(toc)));
  const ficha = {titulo: 'Trecho 1', texto: 'Dados Internacionais de Catalogação na Publicação (CIP)\n\nISBN 978-85-0000-000-0\n\nTodos os direitos reservados.\n\n1ª edição, 2024.\n\nImpresso no Brasil.'};
  verificar('ficha catalográfica é pulada', !w.classificarCapitulo(ficha).incluir);
  const refs = {titulo: 'Referências', texto: 'qualquer coisa'};
  verificar('capítulo "Referências" é pulado', !w.classificarCapitulo(refs).incluir);
  const sumarioTit = {titulo: 'Sumário', texto: 'Capítulo 1 ... 9\n\nCapítulo 2 ... 25'};
  verificar('capítulo "Sumário" é pulado', !w.classificarCapitulo(sumarioTit).incluir);
  const prefacio = {titulo: 'Prefácio', texto: ('Este livro nasceu nas madrugadas de estrada, quando as ideias corriam soltas. ').repeat(12)};
  verificar('prefácio é LIDO', w.classificarCapitulo(prefacio).incluir);
  const cap = {titulo: 'Capítulo 1: A partida', texto: ('O caminhão saiu antes do sol nascer e pegou a serra com calma. ').repeat(20)};
  verificar('capítulo normal é LIDO', w.classificarCapitulo(cap).incluir);
}

console.log('== títulos falados (sem numeração) ==');
verificar('"1.1.1 Tal coisa" fala "Tal coisa"', w.tituloFalado('1.1.1 Tal coisa') === 'Tal coisa');
verificar('"2.3. Métodos" fala "Métodos"', w.tituloFalado('2.3. Métodos') === 'Métodos');
verificar('"III — A viagem" fala "A viagem"', w.tituloFalado('III — A viagem') === 'A viagem');
verificar('"Capítulo 1: A hipótese" mantém', w.tituloFalado('Capítulo 1: A hipótese') === 'Capítulo 1: A hipótese');
{
  // frases[0] é o nome do capítulo (ver "nome do capítulo é lido" abaixo);
  // o cabeçalho de seção do corpo vem logo depois, também sem numeração.
  const frases = w.frasesDoCapitulo({titulo: 'X', texto: '1.2 Resultados obtidos\n\nO estudo mostrou o esperado. Nada mudou.'});
  verificar('nome do capítulo abre a leitura', frases[0].titulo && frases[0].falado === 'X', JSON.stringify(frases[0]));
  verificar('parágrafo-título vira 1 frase com fala limpa', frases[1].titulo && frases[1].falado === 'Resultados obtidos', JSON.stringify(frases[1]));
  verificar('demais frases normais', frases.length === 4, `(veio ${frases.length})`);
}

console.log('== nome do capítulo é lido em voz alta ==');
{
  const caps = w.detectarCapitulosTexto(
    '1. A Partida\n\nO caminhao subia a serra. A noite caia devagar.\n\n' +
    '2. O Rio\n\nA agua estava fria naquele dia de julho.');
  const fr = w.frasesDoCapitulo(caps[0]);
  verificar('título entra como primeira frase', fr[0]?.titulo === true);
  verificar('fala o nome sem o número', fr[0]?.falado === 'A Partida', `("${fr[0]?.falado}")`);
  verificar('tela mostra o título completo', fr[0]?.texto === '1. A Partida', `("${fr[0]?.texto}")`);
  verificar('corpo do capítulo vem depois', fr[1]?.falado.startsWith('O caminhao'));

  // EPUB: título já dentro do texto não pode ser lido duas vezes
  const fr2 = w.frasesDoCapitulo({titulo: 'A partida', texto: 'A partida\n\nEle saiu cedo.'});
  verificar('não repete título já presente no texto',
    fr2.filter(f => /partida/i.test(f.falado)).length === 1);

  // títulos genéricos não acrescentam nada à escuta
  const fr3 = w.frasesDoCapitulo({titulo: 'Trecho 4', texto: 'Texto qualquer aqui.'});
  verificar('não fala "Trecho 4"', !fr3.some(f => /trecho/i.test(f.falado)));

  // numeração romana e de seção também saem só da fala
  verificar('"III — A viagem" fala só o nome',
    w.frasesDoCapitulo({titulo: 'III — A viagem', texto: 'Corpo.'})[0].falado === 'A viagem');
  verificar('"Capítulo 5: O fim" mantém a palavra Capítulo',
    w.frasesDoCapitulo({titulo: 'Capítulo 5: O fim', texto: 'Corpo.'})[0].falado === 'Capítulo 5: O fim');
}

console.log('== WAV (concatenação de capítulo) ==');
{
  const fmt = {canais: 1, taxa: 22050, bits: 16};
  const meio = (ms) => new Uint8Array(Math.round(22050 * 2 * ms / 1000) & ~1).fill(3);
  const a = w.montarWav(fmt, [meio(500)]);
  const b = w.montarWav(fmt, [meio(300)]);
  const {mapa, duracao} = w.concatenarWavs([a, b], 200);
  verificar('mapa tem 2 frases', mapa.length === 2);
  verificar('frase 2 começa após frase 1 + pausa', Math.abs(mapa[1].inicio - 0.7) < 0.02, `(${mapa[1].inicio})`);
  verificar('duração total ≈ 1,0 s', Math.abs(duracao - 1.0) < 0.03, `(${duracao})`);
  const relido = w.lerWav(w.concatenarWavs([a, b]).wav);
  verificar('WAV concatenado é válido', relido.fmt.taxa === 22050 && relido.dados.length > 0);

  // A versão de memória baixa (usada no celular) precisa dar o MESMO resultado
  const bufs = [a, b];
  const eco = await w.concatenarWavsDoBanco(2, async (i) => bufs[i], 200);
  verificar('versão econômica: mesmo mapa',
    eco.mapa.length === 2 && Math.abs(eco.mapa[1].inicio - mapa[1].inicio) < 1e-9,
    `(${eco.mapa[1]?.inicio} vs ${mapa[1].inicio})`);
  verificar('versão econômica: mesma duração', Math.abs(eco.duracao - duracao) < 1e-9,
    `(${eco.duracao} vs ${duracao})`);
  const wCheio = new Uint8Array(w.concatenarWavs([a, b], 200).wav);
  const wEco = new Uint8Array(eco.wav);
  verificar('versão econômica: bytes idênticos',
    wCheio.length === wEco.length && wCheio.every((v, i) => v === wEco[i]),
    `(${wCheio.length} vs ${wEco.length})`);
  const relidoEco = w.lerWav(eco.wav);
  verificar('versão econômica: WAV válido',
    relidoEco.fmt.taxa === 22050 && relidoEco.dados.length > 0);
}

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nREGRAS OK');
process.exit(falhas.length ? 1 : 0);
