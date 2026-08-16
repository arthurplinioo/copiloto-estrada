'use strict';
/* Motor de voz do sistema (speechSynthesis) — leitura imediata, sem download.
   Ciclo de vida endurecido para iOS: contador de geração invalida callbacks
   de utterances antigas; cancel()→speak() nunca acontece no mesmo tique. */

const falaSistema = {
  vozes: [],
  vozAtual: null,
  vozDesejadaURI: '',
  taxa: 1,
  utter: null,
  vigia: null,
  agendado: null,
  gen: 0,
  suportada: 'speechSynthesis' in window,

  carregarVozes(aoMudar){
    if(!this.suportada) return;
    const ler = () => {
      const todas = speechSynthesis.getVoices();
      if(!todas.length) return;
      const pt = todas.filter(v => /^pt([-_]|$)/i.test(v.lang));
      this.vozes = pt.length ? pt : todas;
      const escolhida = this.vozDesejadaURI ? this.vozes.find(v => v.voiceURI === this.vozDesejadaURI) : null;
      if(escolhida){ this.vozAtual = escolhida; }
      else {
        const brs = this.vozes.filter(v => /br/i.test(v.lang));
        this.vozAtual = brs.find(v => v.localService) || brs[0] || this.vozes[0] || null;
      }
      aoMudar?.();
    };
    ler();
    speechSynthesis.onvoiceschanged = ler;
  },

  _desanexar(){
    clearTimeout(this.vigia);
    clearTimeout(this.agendado);
    if(this.utter){ this.utter.onend = null; this.utter.onerror = null; this.utter = null; }
  },

  falar(texto, aoFim, aoErro){
    if(!this.suportada){ aoErro?.(new Error('sem-suporte')); return; }
    const g = ++this.gen;
    this._desanexar();

    const iniciar = () => {
      if(g !== this.gen) return;
      const u = new SpeechSynthesisUtterance(texto);
      if(this.vozAtual) u.voice = this.vozAtual;
      u.lang = this.vozAtual?.lang || 'pt-BR';
      u.rate = this.taxa;
      let terminou = false;
      const fim = () => {
        if(terminou || g !== this.gen) return;
        terminou = true;
        clearTimeout(this.vigia);
        aoFim?.();
      };
      u.onend = fim;
      u.onerror = (e) => {
        if(terminou || g !== this.gen) return;
        clearTimeout(this.vigia);
        if(e.error === 'interrupted' || e.error === 'canceled') return;
        terminou = true;
        aoErro?.(e);
      };
      const palavras = Math.max(3, contarPalavras(texto));
      const esperadoMs = (palavras / (170 * this.taxa)) * 60000;
      this.vigia = setTimeout(() => {
        if(g !== this.gen) return;
        speechSynthesis.cancel();
        fim();
      }, esperadoMs * 3 + 6000);
      this.utter = u; // referência viva: evita GC prematuro no Chrome
      speechSynthesis.speak(u);
    };

    if(speechSynthesis.speaking || speechSynthesis.pending){
      speechSynthesis.cancel();
      this.agendado = setTimeout(iniciar, 120);
    } else {
      iniciar();
    }
  },

  parar(){
    this.gen++;
    this._desanexar();
    if(this.suportada) speechSynthesis.cancel();
  }
};

// Chrome desktop pausa a síntese sozinho após ~15 s
setInterval(() => {
  if(falaSistema.suportada && speechSynthesis.speaking) speechSynthesis.resume();
}, 10000);

window.falaSistema = falaSistema;
