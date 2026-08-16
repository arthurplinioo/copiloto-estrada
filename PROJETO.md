# Copiloto de Estrada — PROJETO.md

Fonte da verdade sobre arquitetura e decisões. Leia antes de qualquer tarefa.

## Uma frase

PWA em JavaScript puro que transforma livros (PDF/EPUB/TXT) em audiolivro com voz
neural Piper rodando localmente, para ouvir offline no carro — tela apagada,
tela de bloqueio e CarPlay — sem backend, sem login, sem custo.

## Arquitetura

```
index.html                  concha; scripts clássicos (globais) — testáveis no jsdom
css/estilo.css              identidade: âmbar de farol sobre asfalto; serifa nos títulos
js/bd.js                    IndexedDB (livros, progresso, config, wavs, capAudio) c/ fallback memória
js/limpeza.js               regras puras de limpeza + classificador de miolo + capítulos
js/frases.js                divisão em frases; títulos têm `falado` sem numeração
js/importadores.js          TXT / EPUB (leitor ZIP próprio + DecompressionStream) / PDF (pdf.js) + capas
js/fala-sistema.js          motor speechSynthesis (imediato; ciclo de vida endurecido p/ iOS)
js/motor-piper.js           motor neural: worker, geração resumível, WAV concat + mapa de tempos
js/piper-worker.bundle.js   bundle esbuild de src-worker/piper-worker.src.js (@diffusionstudio/vits-web)
js/app.js                   UI + player unificado + Media Session + Modo Estrada
vendor/pdf*.js              pdf.js 3.11.174 vendorado (worker real no navegador)
sw.js                       offline: concha pré-cacheada; CDNs do motor em cache-first
testes/                     jsdom dirige a página real com arquivos reais
ferramentas/                geradores (ícones, dados de teste)
```

## Decisões que não se negociam

1. **Sem rede em runtime** além do primeiro carregamento e do download da voz.
   O service worker cacheia a concha e as dependências de CDN do motor
   (onnxruntime/phonemize); o modelo de voz fica no OPFS via vits-web.
2. **A interface nunca trava.** Síntese Piper roda em Web Worker; parsing de PDF
   usa o worker do pdf.js; loops longos cedem a thread a cada página/frase.
3. **Progresso é sagrado.** Salvo a cada frase (nos dois motores), no `pagehide`
   e no `visibilitychange`. Nunca só ao sair.
4. **Geração é resumível.** Cada frase vira um WAV em `wavs`; o capítulo pronto
   é concatenado em `capAudio` com mapa de tempos e as frases são apagadas.
   Interrompeu no meio? Retoma do ponto exato. Nunca gere o livro inteiro de uma vez —
   capítulo atual + próximo, sob demanda.
5. **Dois motores, um player.** Piper (áudio real → funciona com tela apagada,
   Media Session, CarPlay) e sistema (imediato, exige tela ligada no iOS).
   Se o capítulo neural fica pronto no meio da leitura, a troca acontece na
   fronteira da frase, sem perder o lugar.
6. **Um único `<audio>` por sessão** — recriar o elemento quebra a permissão de
   reprodução no iOS.
7. **Alvos de toque:** ≥44 px na interface normal, ≥88 px no Modo Estrada.
8. **Português do Brasil** em interface, código e comentários.

## Limpeza de texto (o coração do app)

Ordem no PDF: cabeçalhos/rodapés por frequência (dígitos→`#`, títulos isentos) →
números de página (romanos validados de verdade) → notas de rodapé (fonte menor
no pé) → hifenização (compostos preservados) → remontagem de parágrafos →
detecção de capítulos (fonte grande, RE_TITULO, ou por tamanho).

Depois, o **classificador de miolo** marca o que não deve ir para a voz:
sumário (linhas terminando em número de página), ficha catalográfica (ISBN/CIP/
direitos), créditos, referências (padrão ABNT), capítulos quase vazios.
O usuário revisa por checkbox na tela de preparo. Títulos são lidos **sem a
numeração** ("1.1.1 Tal coisa" → fala "Tal coisa") via `tituloFalado`.

## Como testar

`npm test` (ou os três: `node testes/teste-parsers.mjs`, `teste-regras.mjs`,
`teste-fluxo.mjs`). Os testes carregam o `index.html` real no jsdom e dirigem a
página com um PDF acadêmico feio, um EPUB e um TXT longo gerados por
`ferramentas/gerar-dados-teste.mjs`. Depois do parsing, os testes imprimem uma
amostra do texto limpo — confira à mão quando mexer nas regras.

O que o jsdom **não** cobre (testar de verdade no iPhone):
- síntese Piper (Worker + OPFS + onnxruntime) e o download da voz;
- reprodução de áudio, tela de bloqueio, CarPlay, Wake Lock;
- instalação como PWA e comportamento offline do service worker.

## Rebuild do bundle do worker

```bash
npm run bundle
```

## Onde ter cuidado extra

- **OPFS no iOS**: o vits-web grava o modelo com `createWritable`, que exige
  iOS/Safari ≥ 18.2. Em versões antigas o download falha → o app cai para a voz
  do sistema com aviso; não tratar como bug.
- **Media Session**: atualizar metadata (título, capítulo, capa) a cada troca de
  capítulo, ou a tela de bloqueio mostra informação errada.
- **Trocar a voz Piper apaga o áudio gerado** do livro aberto (voz nova = áudio novo).
- **Reimportar um livro** (mesmo nome+tamanho) invalida o áudio antigo.

## O que não fazer

- Nada de analytics, telemetria, login ou nuvem.
- Nada de modal durante a reprodução.
- Não gere áudio do livro inteiro numa única operação.
- Não adicione dependência de runtime que chame API externa (as únicas exceções,
  já cacheadas: CDNs do onnxruntime/phonemize e o huggingface para baixar voz).
