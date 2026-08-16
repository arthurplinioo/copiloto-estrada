// Gera arquivos de teste: TXT longo, EPUB válido e PDF "feio" (cabeçalho,
// número de página, nota de rodapé menor, hifenização de fim de linha).
import { writeFileSync } from 'node:fs';

/* ---------- TXT ---------- */
const par = (i) => `Este é o parágrafo ${i} de um livro de teste bastante longo, escrito para conferir se a leitura em voz alta flui de maneira natural. O narrador seguia pela estrada enquanto pensava em tudo o que havia deixado para trás, e a paisagem corria pela janela como um filme antigo.`;
let txt = 'CAPÍTULO I\n\n';
for (let i = 1; i <= 60; i++) {
  txt += par(i) + '\n\n';
  if (i === 30) txt += 'CAPÍTULO II\n\n';
  if (i % 10 === 0) txt += `${i / 10}\n\n`; // número de página perdido no meio
}
// bloco com quebra dura e hifenização, como sai de OCR
txt += 'CAPÍTULO III\n\nO velho cami-\nnhão subia a serra devagar, e o motorista acompa-\nnhava o ritmo do motor com os dedos no volante.\nA noite caía sem pressa sobre o vale.\n\n';
writeFileSync(new URL('./teste.txt', import.meta.url), txt, 'utf8');

/* ---------- EPUB (ZIP "stored", sem compressão — método 0) ---------- */
function crc32(buf) {
  let t = crc32.t;
  if (!t) {
    t = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zipStored(arquivos) {
  const locais = [], centrais = [];
  let off = 0;
  for (const [nome, conteudo] of arquivos) {
    const dados = Buffer.from(conteudo, 'utf8');
    const n = Buffer.from(nome, 'utf8');
    const crc = crc32(dados);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(dados.length, 18); lh.writeUInt32LE(dados.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locais.push(lh, n, dados);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(dados.length, 20); ch.writeUInt32LE(dados.length, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    centrais.push(Buffer.concat([ch, n]));
    off += 30 + n.length + dados.length;
  }
  const cd = Buffer.concat(centrais);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(arquivos.length, 8); eocd.writeUInt16LE(arquivos.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locais, cd, eocd]);
}
const capXhtml = (n, titulo, pars) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${titulo}</title></head>
<body><h2>${titulo}</h2>${pars.map(p => `<p>${p}</p>`).join('\n')}</body></html>`;
const parsE = (cap) => Array.from({ length: 18 }, (_, i) =>
  `Parágrafo ${i + 1} do ${cap}. A viagem continuava pela madrugada, com o rádio baixinho e a promessa de café na próxima parada. Ninguém sabia ao certo quantos quilômetros faltavam, mas isso não importava muito.`);
const epub = zipStored([
  ['mimetype', 'application/epub+zip'],
  ['META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
  ['OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">teste-estrada-1</dc:identifier>
<dc:title>Noites na BR-116</dc:title><dc:creator>A. Viajante</dc:creator><dc:language>pt-BR</dc:language>
</metadata>
<manifest>
<item id="c1" href="cap1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="cap2.xhtml" media-type="application/xhtml+xml"/>
<item id="c3" href="cap3.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`],
  ['OEBPS/nav.xhtml', capXhtml(0, 'Sumário', ['Capítulo 1', 'Capítulo 2'])],
  ['OEBPS/cap1.xhtml', capXhtml(1, 'A partida', parsE('primeiro capítulo'))],
  ['OEBPS/cap2.xhtml', capXhtml(2, 'O posto de gasolina', parsE('segundo capítulo'))],
  ['OEBPS/cap3.xhtml', capXhtml(3, 'A chegada', parsE('terceiro capítulo'))],
]);
writeFileSync(new URL('./teste.epub', import.meta.url), epub);

/* ---------- PDF acadêmico feio (sem compressão) ---------- */
function esc(t) { return t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
// WinAnsi: acentos funcionam com fonte padrão Helvetica
function paginaConteudo(num, totalPag) {
  const L = [];
  const cab = 'REVISTA BRASILEIRA DE ESTUDOS RODOVIARIOS - VOL. 12, N. 3';
  L.push(`BT /F1 8 Tf 60 780 Td (${esc(cab)}) Tj ET`);
  let y = 740;
  if (num === 1) { L.push(`BT /F2 18 Tf 60 ${y} Td (Capitulo 1: A hipotese da estrada) Tj ET`); y -= 34; }
  if (num === 3) { L.push(`BT /F2 18 Tf 60 ${y} Td (Capitulo 2: Metodos e caminhos) Tj ET`); y -= 34; }
  const temas = ['o asfalto quente', 'a neblina da serra', 'os faróis distantes', 'a chuva fina', 'o acostamento vazio', 'as placas apagadas'];
  const linhas = [
    `No trecho ${num} da pesquisa, o levantamento considerou ${temas[num - 1]}. O cami-`,
    `nhoneiro entrevistado no ponto ${num} descreveu a rotina noturna, e os dados mos-`,
    `travam que a leitura em voz alta precisa de texto continuo, sem restos de`,
    `cabecalho nem numeros soltos. A frase ${num} confirma o paragrafo desta pagina.`,
    `Um paragrafo novo comeca aqui tratando de ${temas[(num) % 6]} durante o estudo,`,
    `que continua na linha seguinte sem pontuacao final ate fechar agora mesmo.`,
  ];
  for (const ln of linhas) { L.push(`BT /F1 11 Tf 60 ${y} Td (${esc(ln)}) Tj ET`); y -= 16; }
  // nota de rodapé em fonte menor
  L.push(`BT /F1 7 Tf 60 120 Td (1. Nota de rodape metodologica que nao deveria ser lida em voz alta.) Tj ET`);
  L.push(`BT /F1 7 Tf 60 110 Td (2. Segunda nota, com referencia bibliografica extensa e inutil.) Tj ET`);
  // número de página
  L.push(`BT /F1 9 Tf 290 60 Td (${num}) Tj ET`);
  return L.join('\n');
}
const NP = 6;
const objetos = [];
objetos.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
const kids = Array.from({ length: NP }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
objetos.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${NP} >>\nendobj\n`);
for (let p = 1; p <= NP; p++) {
  const cont = paginaConteudo(p, NP);
  objetos.push(`${3 + (p - 1) * 2} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + (p - 1) * 2} 0 R /Resources << /Font << /F1 ${3 + NP * 2} 0 R /F2 ${4 + NP * 2} 0 R >> >> >>\nendobj\n`);
  objetos.push(`${4 + (p - 1) * 2} 0 obj\n<< /Length ${Buffer.byteLength(cont)} >>\nstream\n${cont}\nendstream\nendobj\n`);
}
objetos.push(`${3 + NP * 2} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
objetos.push(`${4 + NP * 2} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`);
let pdf = '%PDF-1.4\n';
const offs = [0];
for (const o of objetos) { offs.push(Buffer.byteLength(pdf)); pdf += o; }
const xrefOff = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objetos.length; i++) pdf += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
writeFileSync(new URL('./teste.pdf', import.meta.url), pdf, 'latin1');
console.log('ok: teste.txt, teste.epub, teste.pdf gerados');
