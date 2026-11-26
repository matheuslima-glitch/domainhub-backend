// =====================================================
// DISTRIBUIDOR DE NOTIFICAÇÃO
//
// Um lugar só que entrega o MESMO texto a todos os canais paralelos ao
// WhatsApp. Hoje são Discord e Telegram.
//
// POR QUE ELE EXISTE
//
// Quando o Discord foi acrescentado, o bloco de envio foi copiado para cinco
// lugares: `whatsapp/messages.js`, os dois fluxos de compra, o swap e o pedido
// de exclusão. São sete linhas quase idênticas em cada um. Acrescentar o
// Telegram do mesmo jeito dobraria isso para dez cópias, e o quarto canal
// exigiria mexer nos cinco arquivos de novo.
//
// Com este módulo, canal novo é UMA linha aqui dentro e nada nos chamadores.
//
// O QUE ELE GARANTE — e é por isso que cada canal tem seu próprio try/catch:
//
//   1. UM CANAL NÃO DERRUBA O OUTRO. Se o Discord lançar, o Telegram ainda é
//      chamado, e vice-versa. Isso inclui falha no próprio `require`: um
//      módulo com erro de sintaxe não leva os demais junto.
//   2. NUNCA LANÇA PARA QUEM CHAMOU. Notificação é acréscimo; ela não pode
//      derrubar a compra, o swap ou o pedido de exclusão que a originou.
//   3. ENTREGA O MESMO `opts` A TODOS. `critico` e `botao` valem para os dois
//      canais, e cada um decide o que fazer com eles.
//
// COMPATIBILIDADE: `send()` existe como apelido de `espelhar()` para os
// chamadores que já escreviam `.send(...)`. São a mesma função.
// =====================================================

// `parte`: tamanho máximo de cada mensagem quando um texto longo é dividido
// (espelharEmPartes). Fica abaixo do limite de cada canal — Discord 2.000, já
// contando o "@everyone", e Telegram 4.096 — com folga para a conversão de
// formatação (o Telegram troca *x* por <b>x</b>).
const CANAIS = [
  { nome: 'DISCORD', caminho: './discord', parte: 1800 },
  { nome: 'TELEGRAM', caminho: './telegram', parte: 3800 }
];

/**
 * Entrega a mensagem a todos os canais configurados.
 *
 * Devolve uma promessa que NUNCA rejeita, com um resultado por canal. Quem
 * chama pode dar `await` para esperar a entrega ou ignorar — hoje nenhum
 * chamador usa o retorno, e nenhum deve passar a depender dele: canal fora do
 * ar é normal e não significa que a operação de origem falhou.
 *
 * @param {string} message
 * @param {object} [opts] - { critico?: boolean, botao?: {rotulo, url} }
 */
async function espelhar(message, opts = {}) {
  const resultados = await Promise.all(
    CANAIS.map(async ({ nome, caminho }) => {
      try {
        const canal = require(caminho);
        const r = await canal.send(message, opts);
        return { canal: nome, ...(r || {}) };
      } catch (e) {
        // Chega aqui em erro de carregamento do módulo ou em exceção que o
        // canal não tratou. Os canais já devolvem { success: false } nas
        // falhas de rede previstas, então isto é a rede de segurança.
        console.error(`❌ [${nome}] Falha no canal: ${e.message}`);
        return { canal: nome, success: false, error: e.message };
      }
    })
  );

  return resultados;
}

/**
 * Entrega um texto LONGO, dividido em partes no tamanho de cada canal.
 *
 * `dividir(limite)` devolve a lista de partes para aquele limite. Cada canal
 * recebe as suas partes EM ORDEM, uma depois da outra; os canais correm em
 * paralelo e um não derruba o outro, como em `espelhar`.
 *
 * Por que por canal: o Telegram, canal principal, aceita o dobro do Discord.
 * Dividir tudo no tamanho do Discord mandaria ao Telegram o dobro de mensagens
 * sem necessidade.
 *
 * Só a primeira parte vai com `mencionar: true` — as demais são continuação,
 * e o Discord não repete o @everyone nelas.
 *
 * Como `espelhar`, NUNCA rejeita. Devolve um resultado por parte enviada.
 *
 * @param {(limite: number) => string[]} dividir
 * @param {object} [opts] - os mesmos de `espelhar`
 */
async function espelharEmPartes(dividir, opts = {}) {
  const porCanal = await Promise.all(
    CANAIS.map(async ({ nome, caminho, parte }) => {
      const resultados = [];
      try {
        const canal = require(caminho);
        const partes = dividir(parte);
        for (let i = 0; i < partes.length; i++) {
          const r = await canal.send(partes[i], { ...opts, mencionar: i === 0 });
          resultados.push({ canal: nome, parte: i + 1, partes: partes.length, ...(r || {}) });
        }
      } catch (e) {
        console.error(`❌ [${nome}] Falha no canal: ${e.message}`);
        resultados.push({ canal: nome, success: false, error: e.message });
      }
      return resultados;
    })
  );
  return porCanal.flat();
}

/**
 * Dispara sem esperar, para quem não pode pagar o tempo da rede.
 *
 * É o que os fluxos de compra e swap precisam: o alerta sai, mas o tempo de
 * resposta e o resultado da operação original ficam exatamente como eram.
 */
function espelharEmSegundoPlano(message, opts = {}) {
  espelhar(message, opts).catch((e) =>
    console.error('❌ [NOTIFY] Falha inesperada no distribuidor:', e.message)
  );
}

module.exports = { espelhar, espelharEmPartes, espelharEmSegundoPlano, send: espelhar, CANAIS };
