# Spec Delta

## Purpose

Proteger os domínios do DomainHub contra acesso automatizado por meio de uma regra de desafio gerenciado na zona Cloudflare de cada domínio, com aplicação, simulação e remoção controladas, relatório e aviso de falha.

## ADDED Requirements

### Requirement: Acesso restrito a super admin
O sistema SHALL aceitar pedidos de aplicação em lote do antibot somente de usuários autenticados que sejam super admin. Qualquer outro pedido MUST ser recusado sem nenhuma chamada de escrita à Cloudflare.

#### Scenario: Usuário comum é recusado
- **WHEN** um usuário logado que não é super admin envia um pedido de lote
- **THEN** o sistema responde 403 e nenhuma zona é consultada ou alterada

#### Scenario: Cargo não pode ser conferido
- **WHEN** a verificação de super admin falha por erro do banco
- **THEN** o sistema responde 503 e nenhuma zona é alterada

### Requirement: Simulação como modo padrão
Quando o pedido não informar o modo, o sistema SHALL executar em modo simulação. A simulação MUST NOT alterar nenhuma zona e SHALL informar, por domínio, o que seria feito no modo de aplicação.

#### Scenario: Pedido sem modo
- **WHEN** um super admin envia uma lista de domínios sem informar o modo
- **THEN** o sistema responde com o resultado previsto de cada domínio e nenhuma chamada de escrita é feita à Cloudflare

### Requirement: Aplicação da regra antibot
No modo de aplicação, o sistema SHALL garantir que a zona de cada domínio da lista tenha uma regra personalizada ativa, com a ação de desafio gerenciado para qualquer host, na primeira posição e marcada com a referência do DomainHub.

#### Scenario: Zona sem a regra
- **WHEN** o modo é aplicação e a zona do domínio não tem a regra antibot
- **THEN** a regra é criada ativa, na primeira posição, e o domínio é reportado como `criada`

#### Scenario: Zona ainda sem regras personalizadas
- **WHEN** o modo é aplicação e a zona nunca teve regras personalizadas
- **THEN** o conjunto de regras personalizadas da zona é criado contendo a regra antibot, e o domínio é reportado como `criada`

#### Scenario: Regra do DomainHub desativada
- **WHEN** o modo é aplicação e a zona já tem a regra com a referência do DomainHub, porém desativada
- **THEN** a regra é reativada e o domínio é reportado como `reativada`

### Requirement: Sem regra duplicada
O sistema MUST NOT criar uma segunda regra antibot numa zona que já tenha a regra com a referência do DomainHub ou uma regra equivalente criada à mão, ou seja, com a mesma expressão e a ação de desafio gerenciado.

#### Scenario: Execução repetida
- **WHEN** o modo de aplicação roda duas vezes para o mesmo domínio
- **THEN** a segunda execução reporta `ja_existia` e não faz nenhuma chamada de escrita

#### Scenario: Regra equivalente criada à mão
- **WHEN** a zona já tem uma regra ativa sem a referência do DomainHub, com a expressão de qualquer host e a ação de desafio gerenciado
- **THEN** o domínio é reportado como `ja_existia` e nenhuma regra é criada

### Requirement: Limite de regras da zona
O sistema MUST NOT acrescentar a regra quando a zona já tiver o número máximo de regras personalizadas permitido pelo plano, e SHALL reportar o domínio como pulado.

#### Scenario: Zona cheia
- **WHEN** o modo é aplicação e a zona já tem 5 regras personalizadas sem a regra antibot
- **THEN** o domínio é reportado como `limite` e a zona não é alterada

### Requirement: Remoção da regra antibot
No modo de remoção, o sistema SHALL apagar somente a regra marcada com a referência do DomainHub, mantendo todas as outras regras da zona, inclusive as criadas à mão.

#### Scenario: Zona com a regra do DomainHub
- **WHEN** o modo é remoção e a zona tem a regra com a referência do DomainHub
- **THEN** essa regra é apagada, as demais continuam iguais e o domínio é reportado como `removida`

#### Scenario: Zona sem a regra do DomainHub
- **WHEN** o modo é remoção e a zona não tem a regra com a referência do DomainHub
- **THEN** nada é alterado e o domínio é reportado como `nada_a_remover`

### Requirement: Somente domínios do DomainHub
O sistema MUST agir apenas sobre domínios cadastrados na base do DomainHub e MUST NOT alterar a zona principal, mesmo que ela seja informada na lista.

#### Scenario: Domínio fora da base
- **WHEN** a lista contém um domínio que não está cadastrado na base
- **THEN** o domínio é reportado como `desconhecido` e nenhuma chamada à Cloudflare é feita para ele

#### Scenario: Zona principal na lista
- **WHEN** a lista contém o domínio da zona principal
- **THEN** o domínio é reportado como `recusado` e a zona principal não é alterada

#### Scenario: Domínio sem zona na Cloudflare
- **WHEN** o domínio está na base, mas não existe zona com esse nome na Cloudflare
- **THEN** o domínio é reportado como `sem_zona`

### Requirement: Validação da lista
O sistema SHALL aceitar de 1 a 50 domínios por pedido, normalizando os nomes (sem espaços, em minúsculas, sem repetidos). Uma lista inválida ou um modo desconhecido MUST ser recusado sem nenhuma chamada à Cloudflare.

#### Scenario: Lista grande demais
- **WHEN** o pedido traz 51 domínios
- **THEN** o sistema responde 400 e nenhuma zona é consultada

#### Scenario: Lista vazia ou modo desconhecido
- **WHEN** o pedido não traz domínios ou informa um modo que não existe
- **THEN** o sistema responde 400 e nenhuma zona é consultada

#### Scenario: Nomes repetidos
- **WHEN** a lista traz o mesmo domínio duas vezes, com caixa ou espaços diferentes
- **THEN** o domínio é processado uma única vez

### Requirement: Relatório por domínio
O sistema SHALL devolver, para cada domínio pedido, o modo executado, o resultado e a mensagem de erro quando houver, além do total de domínios por resultado.

#### Scenario: Lista com resultados variados
- **WHEN** um lote termina com domínios criados, já existentes e com erro
- **THEN** a resposta lista cada domínio uma vez, com o seu resultado, e traz a contagem de cada resultado

### Requirement: Falha isolada e aviso no Telegram
A falha num domínio MUST NOT interromper os demais. Quando algum domínio falhar no modo de aplicação ou de remoção, o sistema SHALL enviar um único resumo ao canal de alertas do Telegram.

#### Scenario: Cloudflare falha em um domínio
- **WHEN** a Cloudflare devolve erro para um domínio no meio do lote
- **THEN** esse domínio é reportado como `erro`, os demais são processados normalmente e um resumo com as falhas é enviado ao Telegram

#### Scenario: Lote sem falhas
- **WHEN** todos os domínios do lote terminam sem erro
- **THEN** nenhum alerta de falha é enviado
