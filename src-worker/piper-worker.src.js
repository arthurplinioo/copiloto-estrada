// Worker do motor Piper (vits-web): toda a síntese neural roda aqui,
// fora da thread principal. Protocolo de mensagens em português.
import * as tts from '@diffusionstudio/vits-web';

const post = (m, t) => self.postMessage(m, t || []);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.tipo === 'vozes') {
      let lista = [];
      try {
        const todas = await tts.voices();
        lista = todas
          .filter(v => (v.key || '').startsWith('pt_BR'))
          .map(v => ({ id: v.key, nome: v.name || v.key, qualidade: v.quality || '' }));
      } catch { /* offline: cai nas conhecidas abaixo */ }
      if (!lista.length) {
        lista = [
          { id: 'pt_BR-faber-medium', nome: 'Faber (masculina, natural)', qualidade: 'medium' },
          { id: 'pt_BR-edresson-low', nome: 'Edresson (masculina, leve)', qualidade: 'low' },
        ];
      }
      post({ tipo: 'vozes', reqId: m.reqId, lista });

    } else if (m.tipo === 'armazenadas') {
      const ids = await tts.stored();
      post({ tipo: 'armazenadas', reqId: m.reqId, ids });

    } else if (m.tipo === 'baixar') {
      await tts.download(m.vozId, (p) => {
        post({ tipo: 'progresso-download', vozId: m.vozId, carregado: p.loaded, total: p.total });
      });
      post({ tipo: 'download-pronto', reqId: m.reqId, vozId: m.vozId });

    } else if (m.tipo === 'remover') {
      await tts.remove(m.vozId);
      post({ tipo: 'removida', reqId: m.reqId, vozId: m.vozId });

    } else if (m.tipo === 'gerar') {
      const wav = await tts.predict({ text: m.texto, voiceId: m.vozId });
      const buf = await wav.arrayBuffer();
      post({ tipo: 'wav', reqId: m.reqId, buf }, [buf]);
    }
  } catch (err) {
    post({ tipo: 'erro', reqId: m.reqId, msg: String(err?.message || err) });
  }
};

post({ tipo: 'worker-pronto' });
