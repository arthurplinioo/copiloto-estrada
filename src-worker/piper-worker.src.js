// Worker do motor Piper (vits-web): toda a síntese neural roda aqui,
// fora da thread principal. Protocolo de mensagens em português.
//
// ATENÇÃO — limitação conhecida do vits-web (versão 1.0.3): predict() cria uma
// InferenceSession nova a cada frase e nunca a libera (não há release/dispose
// na biblioteca). Cada sessão segura o modelo (~60 MB) na memória do WASM, então
// depois de algumas dezenas de frases o navegador mata a aba. A thread principal
// contorna isso reciclando este worker de tempos em tempos (ver piper.gerar).
import * as tts from '@diffusionstudio/vits-web';
import * as ort from 'onnxruntime-web';

const post = (m, t) => self.postMessage(m, t || []);

/* ---------------------------------------------------------------------------
   Correção do vazamento do vits-web.

   predict() faz InferenceSession.create() a CADA frase e nunca libera — a
   biblioteca não tem uma única chamada de release/dispose. Cada sessão guarda
   o modelo (~60 MB) no heap do WASM, então o consumo cresce sem parar até o
   navegador matar a aba.

   Como o worker é empacotado junto com o vits-web, o `import("onnxruntime-web")`
   dele resolve para este mesmo módulo. Envolvemos InferenceSession.create para
   reaproveitar UMA sessão por voz: acaba o vazamento e cada frase fica mais
   rápida (não recria a sessão nem relê o modelo do OPFS).
--------------------------------------------------------------------------- */
let vozCorrente = null;          // voz da chamada em andamento
let sessaoCache = null;          // {vozId, sessao}
let patchAplicado = false;
let reaproveitou = false;        // a ÚLTIMA geração reusou a sessão de fato?

function aplicarPatchSessao(){
  try{
    const alvo = ort?.InferenceSession;
    if(!alvo || typeof alvo.create !== 'function') return false;
    const criarOriginal = alvo.create.bind(alvo);
    alvo.create = async (modelo, opcoes) => {
      const vozId = vozCorrente;
      if(sessaoCache && sessaoCache.vozId === vozId && vozId != null){
        reaproveitou = true;       // reaproveitou DE VERDADE
        return sessaoCache.sessao; // aqui morria a memória
      }
      reaproveitou = false;
      if(sessaoCache?.sessao?.release){
        try{ await sessaoCache.sessao.release(); }catch{}
      }
      sessaoCache = null;
      const sessao = await criarOriginal(modelo, opcoes);
      sessaoCache = {vozId, sessao};
      return sessao;
    };
    return true;
  }catch{ return false; }
}

async function liberarSessao(){
  if(sessaoCache?.sessao?.release){
    try{ await sessaoCache.sessao.release(); }catch{}
  }
  sessaoCache = null;
}

// Vozes pt-BR que o vits-web não consegue sintetizar: o phonemizador usa a
// tabela de fonemas padrão do Piper e ignora o phoneme_id_map do modelo, então
// modelos com tabela menor estouram no nó Gather do encoder
// ("indices element out of data bounds"). Não adianta rebaixar o modelo.
const INCOMPATIVEIS = new Set(['pt_BR-edresson-low']);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.tipo === 'vozes') {
      let lista = [];
      let completa = false; // veio da rede? offline a lista é só um mínimo
      try {
        const todas = await tts.voices();
        lista = todas
          .filter(v => /^pt_(BR|PT)/.test(v.key || ''))
          .map(v => ({ id: v.key, nome: v.name || v.key, qualidade: v.quality || '' }));
        completa = lista.length > 0;
      } catch { /* offline: cai nas conhecidas abaixo */ }
      if (!lista.length) {
        lista = [
          { id: 'pt_BR-faber-medium', nome: 'Faber (masculina)', qualidade: 'medium' },
          { id: 'pt_PT-tugão-medium', nome: 'Tugão (masculina, sotaque de Portugal)', qualidade: 'medium' },
        ];
      }
      lista = lista.filter(v => !INCOMPATIVEIS.has(v.id));
      // 'completa' evita que o app troque a voz do usuário só porque abriu sem
      // internet e a lista veio curta — trocar a voz descartava o áudio pronto.
      post({ tipo: 'vozes', reqId: m.reqId, lista, completa, incompativeis: [...INCOMPATIVEIS] });

    } else if (m.tipo === 'armazenadas') {
      const ids = await tts.stored();
      post({ tipo: 'armazenadas', reqId: m.reqId, ids });

    } else if (m.tipo === 'baixar') {
      await tts.download(m.vozId, (p) => {
        post({ tipo: 'progresso-download', vozId: m.vozId, carregado: p.loaded, total: p.total });
      });
      post({ tipo: 'download-pronto', reqId: m.reqId, vozId: m.vozId });

    } else if (m.tipo === 'remover') {
      // soltar o modelo antes de apagar, senão o arquivo fica preso no OPFS
      if (vozCorrente === m.vozId) { await liberarSessao(); vozCorrente = null; }
      await tts.remove(m.vozId);
      // Conferir de verdade: se o arquivo continuar lá, o botão "apagar voz"
      // mentia para o usuário. Acontecia quando o modelo ainda estava carregado.
      const restou = (await tts.stored()).includes(m.vozId);
      post({ tipo: 'removida', reqId: m.reqId, vozId: m.vozId, restou });

    } else if (m.tipo === 'limpar-tudo') {
      await liberarSessao(); vozCorrente = null;
      await tts.flush(); // apaga a pasta inteira de modelos
      post({ tipo: 'limpo', reqId: m.reqId });

    } else if (m.tipo === 'gerar') {
      if (INCOMPATIVEIS.has(m.vozId)) {
        throw new Error(`A voz ${m.vozId} não funciona neste motor (tabela de fonemas incompatível).`);
      }
      if (!patchAplicado) patchAplicado = aplicarPatchSessao();
      if (vozCorrente !== m.vozId) await liberarSessao();
      vozCorrente = m.vozId;
      reaproveitou = false;
      const wav = await tts.predict({ text: m.texto, voiceId: m.vozId });
      const buf = await wav.arrayBuffer();
      // 'reaproveitou' só é true quando a sessão veio do cache — nunca deduzir
      // isso de "consegui envolver a função", que é sempre verdade.
      post({ tipo: 'wav', reqId: m.reqId, buf, sessaoReaproveitada: reaproveitou }, [buf]);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    // O erro do ONNX é ilegível para quem só quer ouvir um livro; traduzir.
    const incompativel = /out of data bounds|enc_p\/emb\/Gather/i.test(msg);
    post({
      tipo: 'erro', reqId: m.reqId, incompativel,
      msg: incompativel
        ? 'Esta voz não é compatível com o motor neural deste app.'
        : msg
    });
  }
};

post({ tipo: 'worker-pronto' });
