# DomainHub Backend

Sistema profissional completo para gerenciamento automatizado de domínios com IA, oferecendo máxima performance e escalabilidade.

## 🚀 Descrição

Backend robusto em Node.js/Express para gerenciamento completo de domínios:
- **Compra automatizada com IA** (GPT-4) ou manual
- **Plataformas:** WordPress com instalação automática e AtomiCat para domínios genéricos
- **Consulta de saldo** Namecheap em tempo real com conversão USD/BRL
- **Sincronização automática** de 1.300+ domínios
- **Analytics Cloudflare** para 465+ domínios
- **Configuração DNS** e segurança automatizada
- **Instalação WordPress** via Softaculous/cPanel
- **Notificações WhatsApp** em tempo real

## 💡 Arquitetura

```
Frontend React → Supabase Edge Functions → Render Backend (IP estático) → APIs Externas → Supabase DB
                                                    ↓
                                            [Namecheap, OpenAI, Cloudflare, cPanel, WhatsApp]
```

### Vantagens da Arquitetura
- **IP estático** garantido (whitelist Namecheap)
- **Processamento assíncrono** com callbacks em tempo real
- **Cache inteligente** multi-nível
- **Retry automático** com backoff exponencial
- **Logs estruturados** com emojis para debug
- **Zero custo** (Free Tier Render)
- **Alta disponibilidade** e escalabilidade horizontal

## 📁 Estrutura do Projeto

```
src/
├── server.js                    # Servidor Express principal
├── config/
│   └── env.js                   # Configuração de variáveis
├── purchase-domains/            # 🆕 LÓGICA DE COMPRA COM IA
│   ├── wordpress/
│   │   └── index.js             # Compra + Cloudflare + WordPress (750+ linhas)
│   └── atomicat/
│       └── index.js             # Compra genérica simplificada (600+ linhas)
├── services/
│   ├── namecheap/
│   │   ├── balance.js           # Consulta saldo em tempo real
│   │   └── domains.js           # Sync e gestão de domínios
│   └── supabase/
│       ├── balance.js           # Persistência de saldo
│       └── domains.js           # Operações de domínios
├── routes/
│   ├── balance/
│   │   └── index.js             # Endpoints de saldo
│   ├── domains/
│   │   └── index.js             # Endpoints de domínios  
│   └── purchase-domains/        # 🆕 ROTAS DE COMPRA
│       └── index.js             # Orquestração de compras (300+ linhas)
├── middlewares/
│   └── error.js                 # Tratamento global de erros
└── cron/
    └── sync-domains.js          # Job 4/4h - sincronização
```

## 🛠️ Instalação

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/domainhub-backend.git
cd domainhub-backend

# Instale as dependências
npm install

# Para desenvolvimento local
npm run dev
```

## ⚙️ Configuração

### Variáveis de Ambiente Obrigatórias

```bash
# Supabase (Database)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
SUPABASE_USER_ID=uuid-do-usuario

# Namecheap (Domínios)
NAMECHEAP_API_USER=seu-usuario
NAMECHEAP_API_KEY=sua-api-key

# OpenAI (Geração com IA)
OPENAI_API_KEY=sk-proj-xxx
```

### Variáveis Opcionais (Recomendadas)

```bash
# Cloudflare (DNS e Segurança)
CLOUDFLARE_EMAIL=seu@email.com
CLOUDFLARE_API_KEY=sua-api-key
CLOUDFLARE_ACCOUNT_ID=seu-account-id

# cPanel/Softaculous (WordPress)
CPANEL_URL=https://seu-cpanel.com
CPANEL_USERNAME=usuario
CPANEL_API_TOKEN=token-api

# WhatsApp (Notificações)
ZAPI_INSTANCE=instancia
ZAPI_CLIENT_TOKEN=token
WHATSAPP_PHONE_NUMBER=5531999999999
```

## 🚀 Deploy no Render

### 1. Criar Web Service
```
Dashboard → New → Web Service
├── Repository: Conectar GitHub
├── Name: domainhub-backend
├── Region: Oregon (US West)
├── Branch: main
├── Runtime: Node
├── Build Command: npm install
├── Start Command: npm start
└── Instance Type: Free
```

### 2. Configurar Variáveis
Dashboard → Environment → Add todas as variáveis

### 3. Whitelist IP (CRÍTICO!)
```bash
# Após deploy, obtenha o IP
curl https://seu-app.onrender.com/api/ip

# Adicione na Namecheap
https://ap.www.namecheap.com/settings/tools/apiaccess/
```

## 📡 API Endpoints

### 🎯 Compra de Domínios

#### Compra com IA
```http
POST /api/purchase-domains
Content-Type: application/json

{
  "quantidade": 1,
  "idioma": "portuguese",
  "plataforma": "wordpress",  // ou "atomicat"
  "nicho": "saúde"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Processo de compra iniciado",
  "sessionId": "uuid-v4",
  "plataforma": "wordpress",
  "quantidade": 1
}
```

#### Compra Manual
```http
POST /api/purchase-domains/manual
Content-Type: application/json

{
  "domain": "exemplo.online"
}
```

#### Verificar Status
```http
GET /api/purchase-domains/status/:sessionId
```

**Response com progresso em tempo real:**
```json
{
  "success": true,
  "progress": {
    "session_id": "uuid",
    "step": "cloudflare",
    "status": "in_progress",
    "message": "Configurando Cloudflare...",
    "domain_name": "exemplo.online"
  }
}
```

### 💰 Saldo Namecheap

#### Consulta com Conversão BRL
```http
GET /api/balance
```

**Response:**
```json
{
  "success": true,
  "data": {
    "balance_usd": 50.00,
    "balance_brl": 265.00,
    "exchange_rate": 5.30,
    "currency": "USD",
    "last_synced_at": "2025-01-18T10:30:00Z"
  }
}
```

#### Stream Tempo Real (SSE)
```http
GET /api/balance/stream
```

```javascript
// Frontend usage
const eventSource = new EventSource('/api/balance/stream');
eventSource.onmessage = (e) => {
  const balance = JSON.parse(e.data);
  updateUI(balance);
};
```

### 📊 Domínios

#### Sincronizar Todos
```http
GET /api/domains/sync-all
```

#### Listar com Paginação
```http
GET /api/domains?page=1&limit=50
```

#### Informações Detalhadas
```http
GET /api/domains/:domainName/info
```

### 🔧 Utilidades

#### IP do Servidor
```http
GET /api/ip
```

#### Health Check
```http
GET /health
```

## 🔄 Fluxos de Compra

### WordPress Flow
```mermaid
1. Gerar com IA (OpenAI GPT-4) → 3 palavras criativas
2. Verificar Disponibilidade (Namecheap API)
3. Verificar Preço → Limite $1.00
4. Comprar Domínio (Namecheap)
5. Configurar Nameservers → Cloudflare
6. Setup Cloudflare → DNS + SSL + WAF
7. Instalar WordPress → Softaculous/cPanel
8. Notificar WhatsApp → Status completo
9. Callbacks Supabase → Progresso real-time
```

### AtomiCat Flow
```mermaid
1. Gerar Genérico (OpenAI) → Palavras comerciais
2. Verificar Disponibilidade (Namecheap)
3. Verificar Preço → Limite $1.00
4. Comprar Domínio (Namecheap)
5. Notificar WhatsApp → Domínio pronto
6. Callbacks Supabase → Status updates
```

## 🔌 Integrações

### OpenAI GPT-4
- Modelo: `gpt-4o-mini`
- Geração inteligente de domínios
- Prompts otimizados por plataforma
- Retry com criatividade aumentada

### Namecheap API
- Verificação disponibilidade
- Análise de preços
- Compra automatizada
- Gestão de nameservers
- Sincronização de 1.300+ domínios

### Cloudflare API
- Criação de zonas DNS
- Configuração SSL Full
- Regras WAF (firewall)
- Analytics de tráfego
- Cache e otimização

### Softaculous/cPanel
- Instalação WordPress automática
- Configuração de plugins
- Credenciais seguras
- Backup automático

### WhatsApp Z-API
- Notificações em tempo real
- Status de compra
- Alertas de erro
- Confirmações de instalação

### Supabase Realtime
- Callbacks de progresso
- Updates em tempo real
- Persistência de dados
- Logs de atividade

## ⚡ Performance

### Cache Strategy
```
Saldo............: Tempo Real
Domínios.........: 4 horas  
Analytics........: 24 horas
```

### Otimizações
- **Compression:** Gzip responses
- **Helmet:** Security headers
- **Connection Pool:** Supabase reuse
- **Batch Processing:** 100 domínios/lote
- **Rate Limit:** Proteção automática
- **Async Processing:** Non-blocking
- **Retry Logic:** Exponential backoff

## 📊 Monitoramento

### Logs Estruturados
```
🚀 [WORDPRESS] Iniciando compra
🤖 [AI] Domínio gerado: exemplo.online
🔍 [NAMECHEAP] Verificando disponibilidade
💳 [NAMECHEAP] Comprando domínio
☁️ [CLOUDFLARE] Configurando DNS
📦 [WORDPRESS] Instalando via Softaculous
✅ [SUCCESS] Domínio comprado com sucesso
```

### Métricas
- **Tempo resposta:** < 2s (endpoints síncronos)
- **Taxa sucesso:** > 95% (com retry)
- **Uptime:** 99.9% (Free Tier)
- **Rate limits:** Respeitados automaticamente

### Health Monitoring
```bash
# Configure UptimeRobot
URL: https://seu-backend.onrender.com/health
Interval: 5 minutos
```

## 🛡️ Segurança

- **Helmet.js:** Headers de segurança
- **CORS:** Configurado para frontend
- **Service Keys:** Apenas em variáveis
- **Rate Limiting:** Proteção contra abuse
- **Timeout:** 30s para evitar travamentos
- **IP Whitelist:** Namecheap obrigatório
- **SSL/TLS:** Comunicação criptografada

## 🐛 Troubleshooting

### "IP not whitelisted"
```bash
# Obtenha o IP atual
curl https://seu-backend.onrender.com/api/ip
# Adicione em: https://ap.www.namecheap.com/settings/tools/apiaccess/
# Aguarde 10 minutos
```

### "OPENAI_API_KEY não configurada"
```bash
# Adicione no Render Dashboard → Environment
OPENAI_API_KEY=sk-proj-xxxxx
```

### "Rate limit atingido"
Sistema aguarda automaticamente. Verifique logs para detalhes.

### "Domínio indisponível após 10 tentativas"
IA gerará alternativas automaticamente. Aumente criatividade se necessário.

## 🔄 Jobs Automáticos (Cron)

### Sincronização de Domínios
```javascript
// A cada 4 horas
Horário: '0 */4 * * *'
Função: Sincronizar 1.300+ domínios Namecheap
Batch: 100 domínios por vez
Retry: 3 tentativas com delay
```

## 📈 Roadmap

- [x] Compra de domínios com IA (WordPress + AtomiCat)
- [x] Saldo Namecheap em tempo real
- [x] Sincronização automática de domínios
- [x] Instalação WordPress automática
- [x] Notificações WhatsApp
- [x] Callbacks em tempo real
- [ ] Analytics Cloudflare (465 domínios)
- [ ] Dashboard de métricas
- [ ] Renovação automática


## 📝 Licença

Proprietário - GEX Corporation LTDA © 2025

## 🤝 Suporte

**Desenvolvido para:** DomainHub - Sistema Profissional de Gestão de Domínios

**Stack:** Node.js, Express, OpenAI, Namecheap, Cloudflare, Supabase, WhatsApp

**Ambiente:** Render.com (Production Ready)