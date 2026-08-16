'use strict';
/* Divisão de texto em frases faláveis, com tratamento de abreviações,
   frases longas demais e títulos (numeração some da FALA, não da tela). */

const ABREV = /(?:^|[\s(])(?:Sr|Sra|Srta|Dr|Dra|Prof|Profa|Eng|Exmo|Exma|V|Ex|pp?|p[áa]g|cap|art|inc|n[oº]?|vol|ed|obs|séc|sec|St|Sta|av|r|tel|a\.C|d\.C|i\.e|e\.g)\.$/i;

// Lookbehind construído em tempo de execução: literal no fonte seria erro de
// SINTAXE em Safari < 16.4 e derrubaria o script inteiro.
let RE_QUEBRA_FRASE = null;
try{ RE_QUEBRA_FRASE = new RegExp('(?<=[.!?…])\\s+(?=[\\p{Lu}«"“])', 'u'); }catch{}

function dividirFrases(paragrafo){
  let frases = [];
  try{
    const seg = new Intl.Segmenter('pt-BR', {granularity: 'sentence'});
    frases = [...seg.segment(paragrafo)].map(s => s.segment.trim()).filter(Boolean);
  }catch{
    if(RE_QUEBRA_FRASE) frases = paragrafo.split(RE_QUEBRA_FRASE).map(s => s.trim()).filter(Boolean);
    else frases = paragrafo.replace(/([.!?…]+)\s+/g, '$1\u0001').split('\u0001').map(s => s.trim()).filter(Boolean);
  }
  const unidas = [];
  for(const f of frases){
    if(unidas.length && ABREV.test(unidas[unidas.length - 1])) unidas[unidas.length - 1] += ' ' + f;
    else unidas.push(f);
  }
  const finais = [];
  for(const f of unidas){
    if(f.length <= 260){ finais.push(f); continue; }
    let resto = f;
    while(resto.length > 260){
      let corte = -1;
      for(const sep of ['; ', ', ', ' — ', ' ']){
        const i = resto.lastIndexOf(sep, 240);
        if(i > 60){ corte = i + sep.length; break; }
      }
      if(corte < 0) corte = 240;
      finais.push(resto.slice(0, corte).trim());
      resto = resto.slice(corte);
    }
    if(resto.trim()) finais.push(resto.trim());
  }
  return finais;
}

/* Frases de um capítulo: [{texto, falado, par, titulo}] */
function frasesDoCapitulo(cap){
  const frases = [];
  cap.texto.split(/\n\n+/).forEach((par, iPar) => {
    const p = par.trim();
    if(!p) return;
    if(ehParagrafoTitulo(p)){
      frases.push({texto: p, falado: tituloFalado(p), par: iPar, titulo: true});
    } else {
      for(const f of dividirFrases(p)) frases.push({texto: f, falado: f, par: iPar, titulo: false});
    }
  });
  return frases.length ? frases : [{texto: cap.texto, falado: cap.texto, par: 0, titulo: false}];
}

Object.assign(window, {dividirFrases, frasesDoCapitulo});
