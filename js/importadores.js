'use strict';
/* Importadores de arquivo: TXT, EPUB (leitor ZIP próprio) e PDF (pdf.js),
   incluindo extração de capa. Cada importador devolve
   {tipo, tituloSugerido, autor, capa (Blob|null), paginas | texto | capitulos}. */

function decodificarTexto(buf){
  try{ return new TextDecoder('utf-8', {fatal: true}).decode(buf); }
  catch{ return new TextDecoder('windows-1252').decode(buf); }
}

async function importarTxt(arquivo){
  const texto = decodificarTexto(await arquivo.arrayBuffer());
  return {tipo: 'txt', tituloSugerido: arquivo.name.replace(/\.txt$/i, ''), autor: '', capa: null, texto};
}

/* ---------- leitor ZIP mínimo (suficiente para EPUB) ---------- */
async function lerZip(buf){
  const dv = new DataView(buf);
  let eocd = -1;
  const inicio = Math.max(0, buf.byteLength - 65558);
  for(let i = buf.byteLength - 22; i >= inicio; i--){
    if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error('Arquivo EPUB inválido (estrutura ZIP não encontrada).');
  const total = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  const entradas = new Map();
  for(let n = 0; n < total; n++){
    if(dv.getUint32(off, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(off + 10, true);
    const tamComp = dv.getUint32(off + 20, true);
    const nLen = dv.getUint16(off + 28, true);
    const eLen = dv.getUint16(off + 30, true);
    const cLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const nome = td.decode(new Uint8Array(buf, off + 46, nLen));
    entradas.set(nome, {metodo, tamComp, localOff});
    off += 46 + nLen + eLen + cLen;
  }
  async function extrair(nome){
    const e = entradas.get(nome);
    if(!e) return null;
    if(dv.getUint32(e.localOff, true) !== 0x04034b50) throw new Error('EPUB corrompido.');
    const nLen = dv.getUint16(e.localOff + 26, true);
    const eLen = dv.getUint16(e.localOff + 28, true);
    const dados = new Uint8Array(buf, e.localOff + 30 + nLen + eLen, e.tamComp);
    if(e.metodo === 0) return dados.slice().buffer;
    if(e.metodo === 8){
      const ds = new DecompressionStream('deflate-raw');
      const resp = new Response(new Blob([dados.slice()]).stream().pipeThrough(ds));
      return await resp.arrayBuffer();
    }
    throw new Error(`Compressão ZIP não suportada (método ${e.metodo}).`);
  }
  return {entradas, extrair};
}

function resolverCaminho(base, href){
  const partes = (base ? base.split('/') : []);
  for(const seg of decodeURIComponent(href.split('#')[0]).split('/')){
    if(seg === '..') partes.pop();
    else if(seg !== '.' && seg !== '') partes.push(seg);
  }
  return partes.join('/');
}

async function importarEpub(arquivo, aoProgresso){
  const buf = await arquivo.arrayBuffer();
  const zip = await lerZip(buf);
  const parser = new DOMParser();
  const lerXml = async (nome) => {
    const dados = await zip.extrair(nome);
    if(!dados) return null;
    return parser.parseFromString(decodificarTexto(dados), 'text/xml');
  };
  const container = await lerXml('META-INF/container.xml');
  const rootfile = container?.querySelector('rootfile')?.getAttribute('full-path');
  if(!rootfile) throw new Error('EPUB sem container.xml válido.');
  const opf = await lerXml(rootfile);
  if(!opf) throw new Error('EPUB sem arquivo OPF.');
  const baseOpf = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/')) : '';

  const titulo = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || arquivo.name.replace(/\.epub$/i, '');
  const autor = opf.getElementsByTagNameNS('*', 'creator')[0]?.textContent?.trim() || '';

  const manifesto = new Map();
  for(const item of opf.querySelectorAll('manifest > item')){
    manifesto.set(item.getAttribute('id'), {
      href: item.getAttribute('href'),
      tipo: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || ''
    });
  }

  // capa: item com properties="cover-image" ou <meta name="cover" content="id">
  let capa = null;
  try{
    let itemCapa = [...manifesto.values()].find(it => /\bcover-image\b/.test(it.props));
    if(!itemCapa){
      const metaCapa = opf.querySelector('meta[name="cover"]')?.getAttribute('content');
      if(metaCapa) itemCapa = manifesto.get(metaCapa);
    }
    if(itemCapa && /image/.test(itemCapa.tipo)){
      const dados = await zip.extrair(resolverCaminho(baseOpf, itemCapa.href));
      if(dados) capa = new Blob([dados], {type: itemCapa.tipo});
    }
  }catch{}

  const ordem = [...opf.querySelectorAll('spine > itemref')]
    .filter(ir => ir.getAttribute('linear') !== 'no')
    .map(ir => manifesto.get(ir.getAttribute('idref')))
    .filter(it => it && /html|xml/.test(it.tipo) && !/\bnav\b/.test(it.props));

  const capitulos = [];
  let n = 0;
  for(const item of ordem){
    n++;
    aoProgresso?.(n, ordem.length, 'Extraindo capítulos…');
    const dados = await zip.extrair(resolverCaminho(baseOpf, item.href));
    if(!dados) continue;
    const doc = parser.parseFromString(decodificarTexto(dados), 'text/html');
    doc.querySelectorAll('script,style,nav,sup,aside,[hidden]').forEach(e => e.remove());
    const corpo = doc.body;
    if(!corpo) continue;
    let tituloCap = '';
    const h = corpo.querySelector('h1,h2,h3');
    if(h) tituloCap = h.textContent.replace(/\s+/g, ' ').trim();
    const blocos = corpo.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption,td');
    let pars = [];
    if(blocos.length){
      pars = [...blocos].map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    } else {
      pars = corpo.textContent.split(/\n\s*\n/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    }
    const texto = pars.join('\n\n');
    if(contarPalavras(texto) < 15) continue;
    capitulos.push({titulo: tituloCap || `Capítulo ${capitulos.length + 1}`, texto});
    await new Promise(r => setTimeout(r, 0));
  }
  if(!capitulos.length) throw new Error('Não encontrei texto legível neste EPUB.');
  return {tipo: 'epub', tituloSugerido: titulo, autor, capa, capitulos};
}

/* ---------- PDF via pdf.js ---------- */
async function importarPdf(arquivo, aoProgresso){
  if(typeof pdfjsLib === 'undefined') throw new Error('Suporte a PDF não carregou. Recarregue a página.');
  if(typeof Worker !== 'undefined'){
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }
  const buf = await arquivo.arrayBuffer();
  const doc = await pdfjsLib.getDocument({data: buf, useSystemFonts: true, isEvalSupported: false}).promise;

  // capa: primeira página renderizada em miniatura
  let capa = null;
  try{
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const ctx = canvas?.getContext ? canvas.getContext('2d') : null;
    if(ctx && canvas.toBlob){
      const pag1 = await doc.getPage(1);
      const escala = 480 / pag1.getViewport({scale: 1}).width;
      const vp = pag1.getViewport({scale: Math.min(1.5, escala)});
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await pag1.render({canvasContext: ctx, viewport: vp}).promise;
      capa = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.8));
    }
  }catch{}

  const paginas = [];
  for(let p = 1; p <= doc.numPages; p++){
    aoProgresso?.(p, doc.numPages, 'Extraindo páginas…');
    const pag = await doc.getPage(p);
    const tc = await pag.getTextContent();
    const grupos = [];
    for(const it of tc.items){
      if(!('str' in it) || !it.str.trim()) continue;
      const y = it.transform[5];
      const tam = Math.hypot(it.transform[0], it.transform[1]) || 0;
      let g = grupos.find(l => Math.abs(l.y - y) <= Math.max(2.5, tam * 0.35));
      if(!g){ g = {y, partes: []}; grupos.push(g); }
      g.partes.push({x: it.transform[4], larg: it.width || 0, texto: it.str, tam});
    }
    grupos.sort((a, b) => b.y - a.y);
    const linhas = [];
    for(const g of grupos){
      g.partes.sort((a, b) => a.x - b.x);
      let texto = '', fimAnt = null;
      for(const parte of g.partes){
        if(fimAnt !== null && parte.x - fimAnt > 1.2 && !texto.endsWith(' ')) texto += ' ';
        texto += parte.texto;
        fimAnt = parte.x + parte.larg;
      }
      texto = texto.replace(/\s+/g, ' ').trim();
      if(!texto) continue;
      const tams = g.partes.map(p2 => p2.tam).filter(t => t > 0).sort((a, b) => a - b);
      linhas.push({texto, y: g.y, tam: tams.length ? tams[Math.floor(tams.length / 2)] : 0});
    }
    paginas.push({num: p, altura: pag.view[3] - pag.view[1], linhas});
    try{ pag.cleanup(); }catch{}
    await new Promise(r => setTimeout(r, 0));
  }
  let titulo = arquivo.name.replace(/\.pdf$/i, '');
  let autor = '';
  try{
    const meta = await doc.getMetadata();
    if(meta?.info?.Title && meta.info.Title.trim().length > 2) titulo = meta.info.Title.trim();
    if(meta?.info?.Author) autor = String(meta.info.Author).trim();
  }catch{}
  await doc.destroy();
  if(!paginas.some(p => p.linhas.length)) throw new Error('Este PDF não tem texto extraível — provavelmente é digitalizado (imagem). Seria preciso OCR, que este app não faz.');
  return {tipo: 'pdf', tituloSugerido: titulo, autor, capa, paginas};
}

Object.assign(window, {decodificarTexto, lerZip, resolverCaminho, importarTxt, importarEpub, importarPdf});
