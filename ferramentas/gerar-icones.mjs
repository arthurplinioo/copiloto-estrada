// Gera os ícones PNG do app sem dependências: pinta pixels (fundo âmbar,
// estrada escura em perspectiva com faixa tracejada) e codifica PNG na mão.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf){
  let t = crc32.t;
  if(!t){
    t = crc32.t = new Int32Array(256);
    for(let n = 0; n < 256; n++){
      let c = n;
      for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
  }
  let c = -1;
  for(let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(tipo, dados){
  const b = Buffer.alloc(8 + dados.length + 4);
  b.writeUInt32BE(dados.length, 0);
  b.write(tipo, 4, 'ascii');
  dados.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + dados.length)), 8 + dados.length);
  return b;
}
function png(largura, altura, pixels){ // pixels: RGBA Buffer
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const linhas = Buffer.alloc(altura * (1 + largura * 4));
  for(let y = 0; y < altura; y++){
    linhas[y * (1 + largura * 4)] = 0;
    pixels.copy(linhas, y * (1 + largura * 4) + 1, y * largura * 4, (y + 1) * largura * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(linhas, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function desenhar(N){
  const px = Buffer.alloc(N * N * 4);
  const por = (x, y, r, g, b) => {
    const i = (y * N + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  const AMBAR = [232, 161, 61], ASFALTO = [20, 22, 27], FAIXA = [242, 238, 228];
  for(let y = 0; y < N; y++){
    for(let x = 0; x < N; x++){
      // fundo âmbar
      let [r, g, b] = AMBAR;
      // estrada: trapézio em perspectiva (estreito no topo, largo embaixo)
      const t = y / N;                       // 0 topo → 1 base
      const meia = N * (0.055 + 0.33 * t * t); // meia-largura da pista
      const dx = Math.abs(x - N / 2);
      if(t > 0.18 && dx < meia){
        [r, g, b] = ASFALTO;
        // faixa central tracejada, afinando com a distância
        const larguraFaixa = Math.max(1, meia * 0.11);
        const passo = N * 0.16 * (0.35 + t);
        if(dx < larguraFaixa && ((y % Math.round(passo)) / passo) < 0.55) [r, g, b] = FAIXA;
      }
      por(x, y, r, g, b);
    }
  }
  return png(N, N, px);
}

mkdirSync(new URL('../icones/', import.meta.url), { recursive: true });
for(const n of [180, 192, 512]){
  writeFileSync(new URL(`../icones/icone-${n}.png`, import.meta.url), desenhar(n));
}
console.log('ícones gerados: 180, 192, 512');
