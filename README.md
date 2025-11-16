# DomainHub Backend

Backend Node.js/Express para gerenciamento automatizado de domínios, melhor performance e escalabilidade.

## Descrição

Sistema profissional para:
- Consulta de saldo Namecheap em tempo real com conversão USD/BRL
- Sincronização automática de domínios
- Analytics Cloudflare
- Compra automatizada de domínios via IA ou manual
- Gestão de DNS e configurações cPanel

## Arquitetura

```
Frontend React → Render Backend (IP estático) → APIs (Namecheap/Cloudflare) → Supabase DB
```

### Vantagens sobre N8N
- IP estático (whitelist Namecheap)
- Saldo em tempo real via SSE
- Cache inteligente
- Logs detalhados
- Custo zero (Free Tier Render)
- Altamente escalável

## Estrutura do Projeto

```
src/
├── server.js                    # Servidor Express principal
├── config/
│   └── env.js                   # Variáveis de ambiente
├── services/
│   ├── namecheap/
│   │   ├── balance.js           # Consulta saldo (ATIVO)
│   │   ├── domains.js           # Gestão domínios
│   │   └── purchase.js          # Compra domínios
│   ├── cloudflare/
│   │   ├── analytics.js         # Analytics
│   │   └── dns.js               # DNS management
│   ├── supabase/
│   │   ├── balance.js           # Operações saldo
│   │   └── domains.js           # Operações domínios
│   ├── cpanel/
│   │   └── wordpress.js         # Setup WordPress
│   └── notifications/
│       └── whatsapp.js          # ZAPI WhatsApp
├── routes/
│   ├── balance/
│   │   └── index.js             # Endpoints saldo (ATIVO)
│   ├── domains/
│   │   └── index.js             # Endpoints domínios
│   ├── cloudflare/
│   │   └── index.js             # Endpoints Cloudflare
│   └── purchase/
│       └── index.js             # Endpoints compra
├── cron/
│   ├── sync-namecheap.js        # Job - domínios
│   └── sync-cloudflare.js       # Job diário - analytics
├── middlewares/
│   ├── error.js                 # Error handler
│   └── validator.js             # Validação requests
└── utils/
    ├── cache.js                 # Sistema cache
    ├── logger.js                # Logs estruturados
    └── xml-parser.js            # Parser XML
```

## Instalação

```bash
git clone https://github.com/matheuslima-glitch/domainhub-backend.git
cd domainhub-backend
npm install
```

## Configuração

### Variáveis de Ambiente (Render)

Adicione no Render Dashboard → Environment:

```
PORT=3000
NODE_ENV=production

SUPABASE_URL=sua_url
SUPABASE_SERVICE_ROLE_KEY=sua_chave_service_role
SUPABASE_USER_ID=seu_user_id

NAMECHEAP_API_USER=seu_usuario
NAMECHEAP_API_KEY=sua_key

CLOUDFLARE_EMAIL=seu_email
CLOUDFLARE_API_KEY=sua_key

CPANEL_URL=sua_url
CPANEL_API_TOKEN=seu_token

ZAPI_INSTANCE=sua_instance
ZAPI_TOKEN=seu_token
ZAPI_CLIENT_TOKEN=seu_client_token
```

## Deploy no Render

### 1. Criar Web Service
- Acesse: https://dashboard.render.com
- New → Web Service
- Conecte repositório GitHub
- Configure:
  - **Name:** domainhub-backend
  - **Region:** Oregon (US West)
  - **Branch:** main
  - **Runtime:** Node
  - **Build Command:** `npm install`
  - **Start Command:** `npm start`
  - **Instance Type:** Free

### 2. Adicionar Variáveis
Cole todas as variáveis acima em Environment

### 3. Deploy
Clique em "Create Web Service"

### 4. Whitelist Namecheap (CRÍTICO)
Após deploy:
1. Acesse: `https://seu-app.onrender.com/api/ip`
2. Copie o IP retornado
3. Adicione em: https://ap.www.namecheap.com/settings/tools/apiaccess/
4. Aguarde 5-10 minutos para propagação

## API Endpoints

### Saldo Namecheap (Ativo)

#### Consulta Única
```http
GET /api/balance
```
Consulta saldo na Namecheap, converte USD→BRL, salva no Supabase.

**Response:**
```json
{
  "success": true,
  "data": {
    "balance_usd": 1234.56,
    "balance_brl": 6543.21,
    "exchange_rate": 5.30,
    "exchange_source": "Wise",
    "last_synced_at": "2025-01-15T10:30:00.000Z"
  }
}
```

#### Cache
```http
GET /api/balance/cached
```
Retorna último saldo salvo (sem consultar API).

#### Tempo Real (SSE)
```http
GET /api/balance/stream
```
Server-Sent Events com updates a cada 2 minutos.

**Uso:**
```javascript
const eventSource = new EventSource('/api/balance/stream');
eventSource.onmessage = (e) => {
  const balance = JSON.parse(e.data);
  console.log(balance);
};
```

#### Sincronização Manual
```http
POST /api/balance/sync
```
Força atualização imediata.

### Utilidades

#### IP do Servidor
```http
GET /api/ip
```
Retorna IP do Render para whitelist.

#### Health Check
```http
GET /health
```
Status do servidor.

## Integrações

### Namecheap API
- Consulta saldo
- Lista domínios (paginado)
- Info detalhada domínio
- Compra domínios
- Gestão DNS

### Cloudflare API
- Analytics de tráfego
- Gestão DNS
- Cache purge

### Supabase
- Tabela: `namecheap_balance` (saldo)
- Tabela: `domains` (domínios)
- Tabela: `cloudflare_analytics` (métricas)

### APIs Cotação
- Wise API (principal)
- ExchangeRate API (fallback)

## Performance

### Cache Strategy
- Saldo: 2 minutos
- Lista domínios: 4 horas
- Analytics: 24 horas

### Otimizações
- Compression middleware
- Helmet security
- Connection pooling Supabase
- Batch processing (50 domínios/lote)
- Rate limiting protection

## Monitoramento

### Logs
Render Dashboard → Logs (tempo real)

### Métricas
- Tempo resposta: < 4s
- Uptime: 99.9% (com UptimeRobot)
- Taxa erro: < 0.1%

### Health Check
UptimeRobot monitora `/health` a cada 5 minutos (evita sleep mode).

## Segurança

- Helmet.js (headers security)
- CORS configurado
- Variáveis nunca no código
- Service Role Key Supabase
- Rate limiting APIs
- Timeout 30s (evita travamentos)

## Troubleshooting

### "IP not whitelisted"
1. Confirme IP: `curl seu-app.onrender.com/api/ip`
2. Adicione na Namecheap
3. Aguarde 10 minutos

### "Service unavailable"
1. Verifique Render Dashboard
2. Revise logs
3. Confirme variáveis de ambiente

### "Exchange rate failed"
APIs cotação temporariamente indisponíveis. Sistema tenta 2 fontes automaticamente.

## Desenvolvimento

## Roadmap

- [x] Saldo Namecheap em tempo real
- [ ] Sync 1.300 domínios (4h)
- [ ] Sync 465 analytics Cloudflare (diário)
- [ ] Compra domínios com IA
- [ ] Webhooks N8N compatibility
- [ ] Dashboard métricas

## Licença

Proprietário - GEX Corporation LTDA

## Suporte

Repositório: https://github.com/matheuslima-glitch/domainhub-backend
