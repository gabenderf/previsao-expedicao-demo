/**
 * prazo.js — regra de prazo de FALLBACK, para quando a Shopee não manda a
 * informação e o UpSeller exibe "Expira em" vazio.
 *
 * ⚠️ LEIA ANTES DE USAR: a decisão de arquitetura do projeto é **ler o
 * prazo do UpSeller, não reimplementar as regras** (CLAUDE.md Parte 3.5).
 * O marketplace altera prazo caso a caso — atraso logístico, campanha,
 * disputa — e nenhuma regra codificada captura essas exceções.
 *
 * Este arquivo existe só porque há um caso em que não há o que ler: por
 * instabilidade do lado da Shopee, alguns pedidos chegam ao UpSeller sem
 * prazo nenhum (confirmado pelo dono do projeto em 17/08/2026; observado
 * em 2 de 83 pedidos numa raspagem real).
 *
 * REGRA DE OURO: todo prazo derivado aqui fica marcado com
 * `prazo_origem = 'regra'`. Prazo estimado que se passa por prazo real é
 * pior que prazo ausente — some a capacidade de auditar, e no dia em que a
 * regra estiver errada ninguém descobre.
 */
(function (global) {
  'use strict';

  /** Horário de corte: o que é PAGO até as 13h precisa sair no mesmo dia. */
  var HORA_CORTE = 13;

  /**
   * Mapeamento pagamento → prazo, confirmado empiricamente sobre 15.000
   * pedidos do export do UpSeller (CLAUDE.md Parte 3.6):
   *
   *   Ter/Qua/Qui/Sex até 13h  → mesmo dia
   *   Ter/Qua/Qui após 13h     → dia seguinte
   *   Sex após 13h             → segunda
   *   Sábado (dia todo)        → segunda
   *   Domingo (dia todo)       → terça
   *   Segunda (dia todo)       → terça      ← nada pago na segunda vence na segunda
   *
   * ⚠️ NÃO trata feriado. A regra "feriado empurra para o próximo dia útil"
   * nunca foi validada empiricamente (não houve feriado no período do
   * dataset). Em semana com feriado, o prazo derivado pode vir um dia
   * adiantado — conservador, mas errado.
   */
  function prazoPelaRegra(pagoEm) {
    if (!pagoEm) return null;

    var pago = (pagoEm instanceof Date) ? pagoEm : new Date(pagoEm);
    if (isNaN(pago.getTime())) return null;

    var diaSemana = pago.getDay();               // 0 = domingo
    var antesDoCorte = pago.getHours() < HORA_CORTE;

    var destino = new Date(pago.getFullYear(), pago.getMonth(), pago.getDate());

    if (diaSemana === 0) {                       // domingo → terça
      destino.setDate(destino.getDate() + 2);
    } else if (diaSemana === 6) {                // sábado → segunda
      destino.setDate(destino.getDate() + 2);
    } else if (diaSemana === 1) {                // segunda → terça (o dia todo)
      destino.setDate(destino.getDate() + 1);
    } else if (diaSemana === 5 && !antesDoCorte) { // sexta após 13h → segunda
      destino.setDate(destino.getDate() + 3);
    } else if (!antesDoCorte) {                  // ter/qua/qui/sex após 13h → dia seguinte
      destino.setDate(destino.getDate() + 1);
    }
    // ter/qua/qui/sex até 13h → mesmo dia (nenhum ajuste)

    // Todo prazo da Shopee é 23:59:59 de algum dia (CLAUDE.md 3.6).
    destino.setHours(23, 59, 59, 0);
    return destino;
  }

  /**
   * Completa os prazos ausentes de uma lista de pedidos, marcando a origem.
   *
   * Devolve os mesmos objetos com dois campos garantidos:
   *   - expira_em      (pode continuar null, se nem pago_em existir)
   *   - prazo_origem   'upseller' | 'regra' | null
   */
  function aplicarFallback(pedidos) {
    for (var i = 0; i < pedidos.length; i++) {
      var p = pedidos[i];

      if (p.expira_em) {
        p.prazo_origem = 'upseller';
        continue;
      }

      var derivado = prazoPelaRegra(p.pago_em);
      if (derivado) {
        p.expira_em = derivado.toISOString();
        p.prazo_origem = 'regra';
      } else {
        // Sem prazo e sem pagamento: não inventar. O pedido entra na fila
        // sem balde de vencimento, e isso precisa ficar visível.
        p.prazo_origem = null;
      }
    }
    return pedidos;
  }

  var api = { prazoPelaRegra: prazoPelaRegra, aplicarFallback: aplicarFallback, HORA_CORTE: HORA_CORTE };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FilaPrazo = api;
})(typeof window !== 'undefined' ? window : globalThis);
