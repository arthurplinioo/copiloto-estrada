'use strict';
/* Regras de limpeza de texto — funções puras. Cada regra devolve
   {resultado, removidos}. A limpeza é a parte mais valiosa do app:
   texto sujo indo para a voz é o defeito mais caro do projeto. */

function contarPalavras(t){ const m = t.match(/\p{L}[\p{L}\p{M}'’-]*/gu); return m ? m.length : 0; }

/* ---------- títulos ---------- */
const RE_TITULO = /^(cap[íi]tulo|parte|livro|se[çc][ãa]o|pr[óo]logo|ep[íi]logo|pref[áa]cio|introdu[çc][ãa]o|apresenta[çc][ãa]o|conclus[ãa]o|apêndice|anexo)\b/i;

/* Numeração no início de um título: "1.1.2 Métodos" → "Métodos";
   "III — A viagem" → "A viagem". Usada só na FALA; a tela mantém o original. */
function tituloFalado(titulo){
  const t = titulo
    .replace(/^\s*\d+(?:\.\d+)*\.?\s*[.):—–-]*\s*/, '')
    .replace(/^\s*[IVXLCDM]{1,7}\s*[.):—–-]+\s*/, '')
    .trim();
  return t || titulo;
}

/* =====================================================================
   Ruído acadêmico na FALA
   Referências, marcadores de nota e chamadas de figura atrapalham a escuta
   ("...cresceu no período abre parênteses SILVA vírgula 2020 vírgula página
   45 fecha parênteses..."). Some da voz; a tela continua mostrando tudo.
   ===================================================================== */

// Uma citação tem FORMA: sobrenome(s) seguidos de ano — "(SILVA, 2020)",
// "(Silva & Souza, 2020, p. 45)", "(cf. SILVA, 2020; SOUZA, 2019)".
// Casar a FORMA, e não "tem um ano aí dentro", é o que evita engolir prosa
// legítima: "(que fora construída em 1890 pelo avô)" tem ano e nome próprio,
// mas não é citação — e precisa continuar sendo lida.
// Como decidimos: em vez de uma regex grande (que sofria backtracking
// catastrófico — travava em parênteses longos), pegamos parênteses curtos com
// uma regex simples e conferimos o CONTEÚDO por token. É linear e mais fácil
// de acertar: uma citação só tem nomes próprios, anos, ligações ("e", "&",
// "de") e referências de página. Qualquer palavra comum ("que", "foi",
// "assinado") denuncia que aquilo é prosa e não pode sumir da leitura.
const RE_PAREN_CURTO = /\s*\(([^()]{0,200})\)/g;

// Palavras minúsculas que PODEM aparecer numa citação sem descaracterizá-la.
const _TOKENS_CITACAO = new Set([
  'cf','conf','ver','veja','vide','see','apud','in','e','and','et','al',
  'de','da','do','dos','das','del','della','di','van','von','le','la',
  'p','pp','pag','pags','pagina','paginas','cap','caps','capitulo','sec','secao',
  'n','no','nr','vol','ed','eds','org','orgs','coord','trad','ibid','op','cit','loc','sd'
]);
const _semAcento = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/* O conteúdo de um parêntese é uma citação bibliográfica? */
function ehConteudoCitacao(dentro){
  const bruto = String(dentro || '').trim();
  if(!bruto || bruto.length > 200) return false;
  // precisa de ano: sem ano não é referência
  if(!/\b(?:1[0-9]|20)\d{2}[a-z]?\b/.test(bruto)) return false;
  const pedacos = bruto.split(/[\s.,;:&/]+/).filter(Boolean);
  if(!pedacos.length) return false;
  let temNome = false;
  for(const t of pedacos){
    if(/^\d{1,4}[a-z]?(?:[-–—]\d{1,4})?$/i.test(t)) continue; // ano, página, "45-47"
    if(/^[ivxlcdm]+$/i.test(t) && t.length <= 5) continue;    // volume romano
    if(/^\p{Lu}/u.test(t)){ temNome = true; continue; }       // sobrenome/sigla
    if(_TOKENS_CITACAO.has(_semAcento(t))) continue;          // ligação conhecida
    return false;                                             // palavra comum: é prosa
  }
  return temNome; // "(1920)" sozinho é data, não citação
}
// [12] · [1,2] · [12-15] · [1; 4] — chamadas numéricas de referência
const RE_CITACAO_COLCH = /\s*\[\s*\d{1,4}(?:\s*[–—,;-]\s*\d{1,4})*\s*\]/g;
// (Fig. 3) · (Tabela 2) · (Quadro 1.4) — só entre parênteses; "Figura 3" solta fica
const RE_CHAMADA_FIG = /\s*\((?:v\.?\s*)?(?:fig(?:ura)?|tab(?:ela)?|quadro|gr[áa]fico|graf|anexo|ap[êe]ndice)\.?\s*\d+[.\d]*\s*\)/gi;
// Marcador de nota colado na palavra: "resultado¹²".
// A varredura é guiada pelos EXPOENTES, não pelas letras: escrever
// /(\p{L}{3,})[¹²]+/ fazia o motor tentar cada posição do texto com um
// quantificador guloso, e num capítulo longo isso levava segundos (O(n²)).
// Aqui olhamos só os poucos expoentes e conferimos a vizinhança em O(1).
// Subscritos ficam de fora de propósito: "H₂O" precisa continuar "H dois O";
// e exigir palavra de 3+ letras preserva "m²", "x²", "km²".
const RE_SO_EXPOENTES = /[¹²³⁰⁴-⁹]+/gu;
function tirarMarcadoresNota(t){
  return t.replace(RE_SO_EXPOENTES, (m, pos, str) => {
    const antes = str.slice(Math.max(0, pos - 3), pos);
    const depois = str[pos + m.length] || '';
    const palavraAntes = /\p{L}\p{L}\p{L}$/u.test(antes);
    const fimDeToken = depois === '' || /[\s.,;:!?)\]]/.test(depois);
    return (palavraAntes && fimDeToken) ? '' : m;
  });
}
// ibid., op. cit., et al. — abreviações que a voz lê letra a letra
const RE_ABREV_REF = /\s*\b(?:ibid|op\.?\s*cit|loc\.?\s*cit|apud|et\s+al)\.?(?=[\s,;.)]|$)/gi;

function limparFalaCitacoes(texto){
  let t = String(texto || '')
    .replace(RE_PAREN_CURTO, (todo, dentro) => ehConteudoCitacao(dentro) ? '' : todo)
    .replace(RE_CITACAO_COLCH, '')
    .replace(RE_CHAMADA_FIG, '');
  t = tirarMarcadoresNota(t).replace(RE_ABREV_REF, '');
  // costurar o que sobrou solto: " ." → "." ; ",," → "," ; "( )" → ""
  t = t.replace(/\s+([.,;:!?…])/g, '$1')
       .replace(/\(\s*\)|\[\s*\]/g, '')
       // ",," e ",." viram um só. Reticências ("...") ficam intactas: achatá-las
       // em ponto simples mudaria a prosódia da frase.
       .replace(/([,;:])\s*(?:[.,;:]\s*)+/g, '$1 ')
       .replace(/([.!?])\s*[,;:]+/g, '$1')
       .replace(/\s{2,}/g, ' ')
       .replace(/\s+$/, '')
       .trim();
  // Se sobrou só pontuação (a frase era só a citação), devolver o original —
  // melhor ler algo estranho do que pular a frase inteira em silêncio.
  return /\p{L}|\d/u.test(t) ? t : String(texto || '').trim();
}

/* Um parágrafo que é um título de seção: curto, sem pontuação final,
   numerado ("1.2 Alguma coisa") ou casando RE_TITULO ou todo em maiúsculas. */
function ehParagrafoTitulo(p){
  if(p.length > 90 || /[.!?…]$/.test(p)) return false;
  if(/^\d+(\.\d+)*\.?\s+\S/.test(p)) return true;
  if(RE_TITULO.test(p)) return true;
  return p === p.toUpperCase() && /\p{Lu}/u.test(p) && contarPalavras(p) <= 8;
}

/* ---------- números de página ---------- */
const RE_ROMANO = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
function ehNumeroPagina(texto){
  const t = texto.trim();
  if(/^p[áa]g(?:ina)?\.?\s*\d+/i.test(t)) return true;
  if(/^\d+\s*(?:de|\/)\s*\d+$/.test(t)) return true;
  const nu = t.replace(/^[\s.•·|–—-]+|[\s.•·|–—-]+$/g, '');
  if(!nu) return false;
  if(/^\d{1,4}$/.test(nu)) return true;
  return nu.length <= 7 && RE_ROMANO.test(nu) && /[ivxlcdm]/i.test(nu);
}
const RE_NUM_PAG = { test: ehNumeroPagina };

/* ---------- cabeçalhos e rodapés repetidos (PDF) ---------- */
function regraCabecalhoRodape(paginas){
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const freq = new Map();
  for(const pag of paginas){
    const zona = [...pag.linhas.slice(0, 2), ...pag.linhas.slice(-2)];
    const vistos = new Set();
    for(const l of zona){
      const n = norm(l.texto);
      if(n.length < 3 || vistos.has(n)) continue;
      vistos.add(n);
      freq.set(n, (freq.get(n) || 0) + 1);
    }
  }
  const limite = Math.max(3, Math.ceil(paginas.length * 0.3));
  let removidos = 0;
  const resultado = paginas.map(pag => {
    const linhas = pag.linhas.filter((l, i) => {
      const naZona = i < 2 || i >= pag.linhas.length - 2;
      // "Capítulo 3" e "Capítulo 27" normalizam igual — título nunca é cabeçalho
      if(naZona && !RE_TITULO.test(l.texto) && (freq.get(norm(l.texto)) || 0) >= limite){ removidos++; return false; }
      return true;
    });
    return {...pag, linhas};
  });
  return {resultado, removidos};
}

function regraNumeroPagina(paginas){
  let removidos = 0;
  const resultado = paginas.map(pag => {
    const linhas = pag.linhas.filter((l, i) => {
      const naZona = i < 2 || i >= pag.linhas.length - 2;
      if(naZona && ehNumeroPagina(l.texto)){ removidos++; return false; }
      return true;
    });
    return {...pag, linhas};
  });
  return {resultado, removidos};
}

/* ---------- notas de rodapé (fonte menor no pé da página) ---------- */
function regraNotasRodape(paginas, tamCorpo){
  let removidos = 0;
  const resultado = paginas.map(pag => {
    const linhas = [...pag.linhas];
    let n = 0;
    for(let i = linhas.length - 1; i >= 0 && n < 14; i--){
      const l = linhas[i];
      const noPe = pag.altura ? l.y < pag.altura * 0.36 : i >= linhas.length - 6;
      if(noPe && l.tam > 0 && l.tam <= tamCorpo * 0.82){ linhas.pop(); removidos++; n++; }
      else break;
    }
    return {...pag, linhas};
  });
  return {resultado, removidos};
}

/* ---------- hifenização de quebra de linha ---------- */
const PREFIXOS_COMPOSTOS = new Set(['bem','mal','pré','pre','pós','pos','pró','pro','ex','vice','recém','recem','além','aquém','grão','grã','sem','anti','auto','contra','extra','infra','inter','intra','mini','multi','neo','semi','sobre','sub','super','ultra','micro','macro','segunda','terça','terca','quarta','quinta','sexta']);
function regraHifenizacao(texto){
  let removidos = 0;
  const resultado = texto.replace(/(\p{L}+)[-­]\n(\p{Ll}[\p{L}\p{M}]*)/gu, (m, a, b) => {
    if(PREFIXOS_COMPOSTOS.has(a.toLowerCase()) || b.toLowerCase().startsWith('feira')) return `${a}-${b}`;
    removidos++;
    return a + b;
  });
  return {resultado, removidos};
}

/* ---------- remontagem de parágrafos ---------- */
function regraParagrafos(texto){
  const linhas = texto.split('\n');
  const paragrafos = [];
  let atual = '';
  let juntas = 0;
  for(const bruta of linhas){
    const t = bruta.trim();
    if(!t){ if(atual){ paragrafos.push(atual); atual = ''; } continue; }
    if(!atual){ atual = t; continue; }
    // Linha com cara de cabeçalho de seção: nunca grudar no parágrafo anterior
    const ehCabecalhoSecao = /^\d+(?:\.\d+)+\.?\s+\S/.test(t) && contarPalavras(t) <= 12 && t.length <= 90;
    // Linha anterior com cara de cabeçalho: não grudar a próxima nela
    const atualEhCabecalho = /^\d+(?:\.\d+)+\.?\s+\S/.test(atual) && contarPalavras(atual) <= 12 && atual.length <= 90;
    const terminou = /[.!?…:;»””]\s*$/.test(atual);
    const comecaNova = /^[\p{Lu}0-9«””¿¡—–]/u.test(t);
    if(ehCabecalhoSecao || atualEhCabecalho || (terminou && comecaNova)){
      paragrafos.push(atual); atual = t;
    } else {
      atual += ' ' + t; juntas++;
    }
  }
  if(atual) paragrafos.push(atual);
  return {resultado: paragrafos.join('\n\n'), removidos: juntas};
}

function regraEspacos(texto){
  return texto
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ /g, ' ');
}

/* =====================================================================
   Detecção de capítulos
   ===================================================================== */
function detectarCapitulosTexto(texto){
  const paragrafos = texto.split(/\n\n+/);
  const capitulos = [];
  let atual = {titulo: null, pars: []};
  for(const p of paragrafos){
    const t = p.trim();
    if(!t) continue;
    // Só números de nível único (1, 2, 3…) quebram capítulo; subseções (1.1, 2.3.1)
    // ficam como títulos de seção DENTRO do capítulo (ehParagrafoTitulo cuida deles).
    const ehTitulo = t.length <= 70 && !/[.!?…]$/.test(t) &&
      (RE_TITULO.test(t) || /^[IVXLCDM]{1,7}$/.test(t) ||
       (/^\d{1,3}\.?\s+\S/.test(t) && !/^\d+\.\d/.test(t) && contarPalavras(t) <= 12) ||
       (t === t.toUpperCase() && /\p{Lu}/u.test(t) && t.length >= 3 && contarPalavras(t) <= 8));
    if(ehTitulo && atual.pars.length){
      capitulos.push(atual);
      atual = {titulo: t, pars: []};
    } else if(ehTitulo && !atual.titulo){
      atual.titulo = t;
    } else {
      atual.pars.push(t);
    }
  }
  if(atual.pars.length) capitulos.push(atual);
  if(capitulos.length <= 1) return dividirPorTamanho(texto);
  return capitulos.map((c, i) => ({
    titulo: c.titulo || `Trecho ${i + 1}`,
    texto: c.pars.join('\n\n')
  })).filter(c => contarPalavras(c.texto) > 5);
}

function dividirPorTamanho(texto){
  const pars = texto.split(/\n\n+/).filter(p => p.trim());
  const capitulos = [];
  let atual = [], palavras = 0;
  for(const p of pars){
    atual.push(p);
    palavras += contarPalavras(p);
    if(palavras >= 2200){
      capitulos.push({titulo: `Trecho ${capitulos.length + 1}`, texto: atual.join('\n\n')});
      atual = []; palavras = 0;
    }
  }
  if(atual.length) capitulos.push({titulo: `Trecho ${capitulos.length + 1}`, texto: atual.join('\n\n')});
  return capitulos.length ? capitulos : [{titulo: 'Texto', texto}];
}

/* =====================================================================
   Classificação do miolo: o que merece ser LIDO em voz alta.
   Sumário, ficha catalográfica, créditos, referências etc. são marcados
   como não-lidos por padrão (o usuário pode reincluir na tela de preparo).
   ===================================================================== */
const RE_TITULO_DESCARTE = /^(sum[áa]rio|[íi]ndice(\s|$)|ficha\s+catalogr|cataloga[çc][ãa]o|copyright|cr[ée]ditos|expediente|folha\s+de\s+rosto|refer[êe]ncias?(\s+bibliogr[áa]ficas?)?$|bibliografia$|notas?$|gloss[áa]rio|agradecimentos?|dedicat[óo]ria|sobre\s+(o|a)\s+autor|colof[ãa]o|errata|cr[ée]ditos\s+da\s+edi[çc][ãa]o|equipe\s+editorial|lista\s+de\s+(figuras?|tabelas?|quadros?|siglas?|abrevia)|ap[êe]ndice|anexo)/i;

function classificarCapitulo(cap){
  const titulo = (cap.titulo || '').trim();
  const texto = cap.texto || '';
  const palavras = contarPalavras(texto);

  if(RE_TITULO_DESCARTE.test(titulo)) return {incluir: false, motivo: 'seção editorial'};
  // Capítulos muito curtos: só excluir se forem claramente editoriais (título reconhecido)
  // Não excluir capítulos do miolo só por serem curtos — podem ser epígrafes, cartas, etc.
  if(palavras < 5 && !titulo) return {incluir: false, motivo: 'quase sem texto'};

  const pars = texto.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  // sumário: muitas linhas curtas terminando em número de página
  const linhasToc = pars.filter(p => p.length <= 120 && (/[.·…]{2,}\s*\d{1,4}$/.test(p) || /\s{2,}\d{1,4}$/.test(p) || /\t\d{1,4}$/.test(p)));
  if(pars.length >= 4 && linhasToc.length / pars.length >= 0.4) return {incluir: false, motivo: 'sumário'};

  // ficha catalográfica / página de direitos
  const marcasFicha = (texto.match(/ISBN|CIP\b|CDD\b|CDU\b|cataloga[çc][ãa]o|todos os direitos|direitos reservados|impresso no brasil|dep[óo]sito legal|\d+ª\s+edi[çc][ãa]o|conselho editorial/gi) || []).length;
  if(marcasFicha >= 2 && palavras < 400) return {incluir: false, motivo: 'ficha/direitos'};

  // bloco de referências: maioria dos parágrafos com cara de citação ABNT
  const parsRef = pars.filter(p => /^\p{Lu}[\p{Lu}\s,.'-]+,\s*\p{Lu}/u.test(p) && /\b(19|20)\d{2}\b/.test(p));
  if(pars.length >= 5 && parsRef.length / pars.length >= 0.6) return {incluir: false, motivo: 'referências'};

  return {incluir: true, motivo: ''};
}

/* =====================================================================
   Pipeline completo
   ===================================================================== */
const REGRAS_PADRAO = {cabecalhos: true, numeros: true, notas: true, hifen: true, paragrafos: true, miolo: true};

function tamanhoCorpo(paginas){
  const tams = [];
  for(const p of paginas) for(const l of p.linhas) if(l.tam > 0) tams.push(l.tam);
  tams.sort((a, b) => a - b);
  return tams.length ? tams[Math.floor(tams.length / 2)] : 10;
}

function executarLimpeza(bruto, regras){
  const contagens = {cabecalhos: 0, numeros: 0, notas: 0, hifen: 0, paragrafos: 0, miolo: 0};
  let capitulos;

  if(bruto.tipo === 'epub'){
    capitulos = bruto.capitulos.map(c => {
      let t = regraEspacos(c.texto);
      if(regras.hifen){
        const r = regraHifenizacao(t);
        t = r.resultado; contagens.hifen += r.removidos;
      }
      return {titulo: c.titulo, texto: t};
    });
  } else if(bruto.tipo === 'pdf'){
    let paginas = bruto.paginas;
    const corpo = tamanhoCorpo(paginas);
    if(regras.cabecalhos){ const r = regraCabecalhoRodape(paginas); paginas = r.resultado; contagens.cabecalhos = r.removidos; }
    if(regras.numeros){ const r = regraNumeroPagina(paginas); paginas = r.resultado; contagens.numeros = r.removidos; }
    if(regras.notas){ const r = regraNotasRodape(paginas, corpo); paginas = r.resultado; contagens.notas = r.removidos; }

    const linhasTexto = [];
    for(const pag of paginas){
      for(const l of pag.linhas){
        const fonteGrande = l.tam >= corpo * 1.35 && contarPalavras(l.texto) <= 12 && l.texto.length <= 90;
        const secaoNumerada = /^\d{1,3}\.?\s+\S/.test(l.texto) && !/^\d+\.\d/.test(l.texto) && contarPalavras(l.texto) <= 12 && l.texto.length <= 90 && !/[.!?…]$/.test(l.texto);
        const ehTitulo = fonteGrande || secaoNumerada;
        linhasTexto.push(ehTitulo ? `\n\n${l.texto}\n\n` : l.texto);
      }
      linhasTexto.push('');
    }
    let texto = linhasTexto.join('\n');
    if(regras.hifen){ const r = regraHifenizacao(texto); texto = r.resultado; contagens.hifen = r.removidos; }
    if(regras.paragrafos){ const r = regraParagrafos(texto); texto = r.resultado; contagens.paragrafos = r.removidos; }
    texto = regraEspacos(texto);
    capitulos = detectarCapitulosTexto(texto);
  } else {
    // TXT
    let texto = regraEspacos(bruto.texto.replace(/\r\n?/g, '\n'));
    if(regras.numeros){
      const linhas = texto.split('\n');
      texto = linhas.filter(l => {
        const t = l.trim();
        if(t && ehNumeroPagina(t) && /\d/.test(t)){ contagens.numeros++; return false; }
        return true;
      }).join('\n');
    }
    if(regras.hifen){ const r = regraHifenizacao(texto); texto = r.resultado; contagens.hifen = r.removidos; }
    if(regras.paragrafos){ const r = regraParagrafos(texto); texto = r.resultado; contagens.paragrafos = r.removidos; }
    capitulos = detectarCapitulosTexto(texto);
  }

  // classificação do miolo: marca o que não deve ir para a voz
  capitulos = capitulos.map(c => {
    const cls = regras.miolo ? classificarCapitulo(c) : {incluir: true, motivo: ''};
    if(!cls.incluir) contagens.miolo++;
    return {...c, incluir: cls.incluir, motivo: cls.motivo};
  });

  return {capitulos, contagens};
}

Object.assign(window, {
  contarPalavras, RE_TITULO, tituloFalado, ehParagrafoTitulo, ehNumeroPagina, RE_NUM_PAG,
  ehConteudoCitacao,
  limparFalaCitacoes,
  regraCabecalhoRodape, regraNumeroPagina, regraNotasRodape, regraHifenizacao, regraParagrafos,
  regraEspacos, detectarCapitulosTexto, dividirPorTamanho, classificarCapitulo,
  REGRAS_PADRAO, executarLimpeza, tamanhoCorpo
});
