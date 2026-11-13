/**
 * servidor-fixture.js — servidor estático mínimo, só para testar o parser
 * contra as fixtures de HTML salvas do UpSeller.
 *
 * Sem dependências (http + fs do Node). Não faz parte do produto: nem o
 * coletor nem o dashboard usam isto.
 *
 *   node motor/servidor-fixture.js
 *   → http://localhost:8181/motor/parser.test.html
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// Aceita raiz e porta por argumento, para servir também o dashboard:
//   node motor/servidor-fixture.js ../../dashboard-expedicao 8182
const RAIZ = path.resolve(__dirname, '..', process.argv[2] || '.');
const PORTA = Number(process.argv[3]) || 8181;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  let relativo = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  // Diretório (inclusive a raiz) serve index.html — senão readFile falha
  // num diretório e responde 404 sem explicar por quê.
  if (relativo === '' || relativo.endsWith('/')) relativo += 'index.html';
  const alvo = path.resolve(RAIZ, relativo);

  // Não servir nada fora da pasta do projeto.
  if (!alvo.startsWith(RAIZ)) {
    res.writeHead(403).end('403');
    return;
  }

  fs.readFile(alvo, (erro, dados) => {
    if (erro) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404: ' + relativo);
      return;
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream' });
    res.end(dados);
  });
}).listen(PORTA, () => {
  console.log('fixtures em http://localhost:' + PORTA + '/  (raiz: ' + RAIZ + ')');
});
