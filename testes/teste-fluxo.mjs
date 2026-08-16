// Fluxo completo de interface: importar TXT → preparar → salvar → player → estrada.
import { carregarApp, criarVerificador, arquivoDe } from './harness.mjs';

const dom = await carregarApp();
const w = dom.window;
const d = w.document;
const { falhas, verificar } = criarVerificador();
const visivel = (id) => !d.getElementById(id).classList.contains('oculto');
const espera = (ms) => new Promise(r => setTimeout(r, ms));

verificar('biblioteca visível ao abrir', visivel('tela-biblioteca'));
verificar('estante vazia anunciada', visivel('biblioteca-vazia'));

await w.iniciarPreparo(arquivoDe(w, './dados/teste.txt', 'teste.txt', 'text/plain'));
await espera(250);
verificar('preparo visível', visivel('tela-preparo') && visivel('preparo-conteudo'));
verificar('título sugerido', d.getElementById('campo-titulo').value === 'teste');
verificar('amostra tem texto', d.getElementById('amostra-texto').textContent.length > 300);
verificar('regras do TXT listadas (4)', d.querySelectorAll('#lista-regras .regra').length === 4);
verificar('lista de capítulos com checkboxes', d.querySelectorAll('#lista-capitulos .cap-item').length === 3);

// desmarcar um capítulo
const chkCap = d.querySelector('#lista-capitulos .cap-item input');
chkCap.checked = false;
chkCap.dispatchEvent(new w.Event('change'));
verificar('capítulo desmarcado fica riscado', d.querySelector('#lista-capitulos .cap-item').classList.contains('pulado'));

d.getElementById('btn-salvar-livro').click();
await espera(350);
verificar('player visível após salvar', visivel('tela-player'));
// eram 3 capítulos: o III é auto-pulado (quase sem texto) e o I foi desmarcado à mão
verificar('só capítulos incluídos no seletor (1)', d.getElementById('sel-capitulo').options.length === 1,
  `(veio ${d.getElementById('sel-capitulo').options.length})`);
verificar('frases renderizadas', d.querySelectorAll('#texto-leitura .frase').length > 30);
verificar('frase atual marcada', !!d.querySelector('#texto-leitura .frase.atual'));

const alvo = d.querySelectorAll('#texto-leitura .frase')[5];
alvo.click();
verificar('clique na frase move o cursor', alvo.classList.contains('atual'));

d.getElementById('btn-frase-prox').click();
verificar('próxima frase', d.querySelector('.frase.atual')?.dataset.i === '6');
d.getElementById('btn-cap-prox').click();
verificar('próximo capítulo (pulando excluído)', d.getElementById('sel-capitulo').value !== '');

let erroPlay = null;
try{ d.getElementById('btn-play').click(); }catch(e){ erroPlay = e; }
verificar('play sem motores não explode', erroPlay === null, String(erroPlay));

// painel de voz
d.getElementById('btn-config-voz').click();
verificar('painel de voz abre', visivel('painel-voz'));

// modo estrada
d.getElementById('btn-modo-estrada').click();
verificar('modo estrada abre', visivel('modo-estrada'));
verificar('frase grande preenchida', d.getElementById('estrada-frase').textContent.length > 10);
d.getElementById('estrada-vel').click();
verificar('velocidade cicla', d.getElementById('estrada-vel').firstChild.textContent !== '1,0×');
d.getElementById('btn-sair-estrada').click();
verificar('modo estrada fecha', !visivel('modo-estrada'));

d.getElementById('btn-voltar-biblioteca').click();
await espera(150);
verificar('volta à estante', visivel('tela-biblioteca'));
verificar('livro na estante com capa', d.querySelectorAll('.cartao-livro .capa').length === 1);
verificar('cartão Continuar', d.getElementById('continuar-card').textContent.includes('Continuar'));

d.querySelector('.btn-apagar').click();
await espera(200);
verificar('livro apagado', d.querySelectorAll('.cartao-livro').length === 0);

console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nFLUXO OK');
process.exit(falhas.length ? 1 : 0);
