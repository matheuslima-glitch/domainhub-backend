const path = require('path');
const RAIZ = path.join(__dirname, '..', '..');

process.env.SUPABASE_URL = 'x';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
process.env.SUPABASE_USER_ID = 'x';
process.env.NAMECHEAP_API_USER = 'x';
process.env.NAMECHEAP_API_KEY = 'x';
process.env.NAMECHEAP_CLIENT_IP = 'x';

const casos = [
  ['https://domainhubgex.com', 'https://domainhubgex.com'],
  ['domainhubgex.com', 'https://domainhubgex.com'],
  ['https://domainhubgex.com/', 'https://domainhubgex.com'],
  ['  domainhubgex.com/  ', 'https://domainhubgex.com'],
  ['http://localhost:8080', 'http://localhost:8080'],
  ['', ''],
];

const alvo = path.join(RAIZ, 'src/config/env');
let falhas = 0;
console.log('NORMALIZACAO DE PAINEL_URL\n');
casos.forEach(([entrada, esperado]) => {
  process.env.PAINEL_URL = entrada;
  delete require.cache[require.resolve(alvo)];
  const c = require(alvo);
  const bate = c.PAINEL_URL === esperado;
  if (!bate) falhas++;
  console.log(
    '  ' + (bate ? 'ok ' : '❌ ') + JSON.stringify(entrada).padEnd(26) + '-> ' + JSON.stringify(c.PAINEL_URL) +
    (bate ? '' : '   esperava ' + JSON.stringify(esperado)),
  );
});
console.log('\n' + casos.length + ' casos, ' + falhas + ' falhas.');
process.exit(falhas ? 1 : 0);
