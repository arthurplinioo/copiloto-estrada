# Copiloto de Estrada 🛣️

Leitor de livros em voz alta, feito para a estrada. Envie um **PDF, EPUB ou TXT**,
deixe o app limpar o texto (cabeçalhos, números de página, sumário, ficha
catalográfica, notas de rodapé, palavras hifenizadas) e ouça com **voz neural
brasileira rodando no seu próprio aparelho** — offline, com tela apagada,
controles na tela de bloqueio e no CarPlay.

**Use agora:** https://arthurplinioo.github.io/copiloto-estrada/

## No iPhone

1. Abra o link no Safari e toque em **Compartilhar → Adicionar à Tela de Início**.
2. Abra o app, toque em **Voz** e baixe a voz neural (uma vez só, ~60 MB).
3. Envie um livro, confira a amostra limpa e salve na estante.
4. Aperte o play. Pode apagar a tela: o áudio continua, com controles na tela
   de bloqueio e no CarPlay.

Sem conta, sem servidor, sem custo: os livros, o progresso e a voz ficam no seu
aparelho. Depois da primeira visita, o app abre até sem internet.

## Desenvolvimento

```bash
npm install
npm test          # três suítes jsdom com arquivos reais
npm run bundle    # regera js/piper-worker.bundle.js
npm run icones    # regera os ícones PNG
```

Arquitetura e decisões: [PROJETO.md](PROJETO.md).

Créditos: [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0),
[@diffusionstudio/vits-web](https://github.com/diffusion-studio/vits-web) (MPL-2.0)
e as vozes [Piper](https://github.com/rhasspy/piper) (MIT).
