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

/* Normaliza para comparar título com o começo do texto (acento, caixa, pontuação) */
function _chaveTitulo(s){
  return String(s || '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/* Frases de um capítulo: [{texto, falado, par, titulo}]
   O título entra como primeira frase: a detecção de capítulos o retira do
   corpo do texto, então sem isto o nome do capítulo nunca era lido em voz
   alta — o ouvinte pulava de um trecho a outro sem saber onde estava.
   Na tela o título aparece inteiro ("3. A Partida"); na fala, só o nome. */
/* Preferência global: tirar referências e marcadores de nota da fala.
   Fica em window para o app poder ligar/desligar sem recarregar. */
function _pularCitacoes(){
  return window.PULAR_CITACOES !== false; // ligado por padrão
}
function _falaLimpa(texto){
  return _pularCitacoes() ? limparFalaCitacoes(texto) : texto;
}

function frasesDoCapitulo(cap){
  const frases = [];
  const tit = (cap.titulo || '').trim();
  if(tit){
    const primeiroPar = cap.texto.split(/\n\n+/).find(p => p.trim()) || '';
    const chaveTit = _chaveTitulo(tit);
    // não repetir quando o texto já começa com o próprio título (caso do EPUB)
    const jaNoTexto = chaveTit && _chaveTitulo(primeiroPar).startsWith(chaveTit);
    const falado = _falaLimpa(tituloFalado(tit));
    // títulos genéricos ("Trecho 4") não acrescentam nada à escuta
    const generico = /^trecho\s+\d+$/i.test(tit);
    if(!jaNoTexto && !generico && _chaveTitulo(falado)){
      frases.push({texto: tit, falado, par: -1, titulo: true});
    }
  }
  cap.texto.split(/\n\n+/).forEach((par, iPar) => {
    const p = par.trim();
    if(!p) return;
    if(ehParagrafoTitulo(p)){
      frases.push({texto: p, falado: _falaLimpa(tituloFalado(p)), par: iPar, titulo: true});
    } else {
      for(const f of dividirFrases(p)){
        // Se uma frase começa com numeração de seção (1.2, 1.2.3, etc.), tirar da fala
        const base = /^\s*\d+(?:\.\d+)+\.?\s/.test(f) ? tituloFalado(f) : f;
        frases.push({texto: f, falado: _falaLimpa(base), par: iPar, titulo: false});
      }
    }
  });
  return frases.length ? frases : [{texto: cap.texto, falado: cap.texto, par: 0, titulo: false}];
}

Object.assign(window, {dividirFrases, frasesDoCapitulo});
