'use strict';
/* Service worker: depois do primeiro carregamento, o app abre sem internet.
   - Concha do app (HTML/CSS/JS/pdf.js): pré-cache, cache-first.
   - Dependências do motor neural (CDN do onnxruntime e do phonemize): cache-first
     em runtime — baixadas uma vez, servidas do cache para sempre.
   - Modelos de voz (huggingface): o vits-web guarda no OPFS; aqui só repassamos. */

const CONCHA = [
  './',
  'index.html',
  'css/estilo.css',
  'js/bd.js',
  'js/limpeza.js',
  'js/frases.js',
  'js/importadores.js',
  'js/fala-sistema.js',
  'js/motor-piper.js',
  'js/piper-worker.bundle.js',
  'js/app.js',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'manifest.webmanifest',
  'icones/icone-192.png',
  'icones/icone-512.png',
  'icones/icone-180.png'
];
// Bump this string on every deploy to invalidate the old cache.
const VERSAO = 'copiloto-v6';

const HOSTS_CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(CONCHA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(chaves => Promise.all(chaves.filter(k => k !== VERSAO).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if(e.request.method !== 'GET') return;

  // concha do app: cache-first com atualização em segundo plano
  if(url.origin === location.origin){
    e.respondWith(
      caches.match(e.request).then(cacheado => {
        const rede = fetch(e.request).then(resp => {
          if(resp.ok) caches.open(VERSAO).then(c => c.put(e.request, resp.clone())).catch(() => {});
          return resp.clone();
        }).catch(() => cacheado);
        return cacheado || rede;
      })
    );
    return;
  }

  // CDNs do motor neural: cache-first (imutáveis, com versão na URL)
  if(HOSTS_CDN.includes(url.hostname)){
    e.respondWith(
      caches.match(e.request).then(cacheado => cacheado || fetch(e.request).then(resp => {
        if(resp.ok){
          caches.open(VERSAO).then(c => c.put(e.request, resp.clone())).catch(() => {});
        }
        return resp.clone();
      }))
    );
  }
  // huggingface (modelos): passa direto — o vits-web guarda no OPFS
});
