/**
 * previsao.js — snapshot da fila → horário de término, ritmo necessário e
 * janelas de ociosidade.
 *
 * FUNÇÃO PURA: sem DOM, sem fetch, sem Supabase, sem relógio implícito (o
 * instante entra por parâmetro). É o que permite testar cenários inteiros
 * em memória e rodar o MESMO código no coletor (meta congelada) e no
 * dashboard (previsão viva) — se fossem dois códigos, o alerta de
 * divergência da Parte 4.6 dispararia por bug em vez de por realidade.
 *
 * Ver ../CLAUDE.md Partes 4.5 e 4.6.
 */
(function (global) {
  'use strict';

  var PASSO_MIN = 5;
  var MIN_POR_HORA = 60;

  // ------------------------------------------------------------------
  // Utilidades de tempo
  // ------------------------------------------------------------------

  /** '07:40' + um dia de referência → Date. */
  function horaDoDia(referencia, texto) {
    var partes = String(texto).split(':');
    var d = new Date(referencia.getFullYear(), referencia.getMonth(), referencia.getDate());
    d.setHours(Number(partes[0]) || 0, Number(partes[1]) || 0, 0, 0);
    return d;
  }

  function minutosEntre(a, b) { return (b - a) / 60000; }

  function inicioDoDia(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // ------------------------------------------------------------------
  // Segmentação por prazo
  // ------------------------------------------------------------------

  /**
   * Separa os pendentes em baldes de vencimento. É a saída que o projeto
   * quer ("vencem hoje 118 → 13h20; vencem amanhã 62 → 16h40"), e ela sai
   * de graça do prazo que o UpSeller já traz por pedido.
   */
  function segmentarPorPrazo(pendentes, agora) {
    var hoje = inicioDoDia(agora).getTime();
    var amanha = hoje + 86400000;
    var depoisDeAmanha = hoje + 2 * 86400000;

    var baldes = { atrasado: 0, hoje: 0, amanha: 0, depois: 0, sem_prazo: 0 };

    for (var i = 0; i < pendentes.length; i++) {
      var p = pendentes[i];
      if (!p.expira_em) { baldes.sem_prazo++; continue; }

      var t = new Date(p.expira_em).getTime();
      if (t < agora.getTime()) baldes.atrasado++;
      else if (t < amanha) baldes.hoje++;
      else if (t < depoisDeAmanha) baldes.amanha++;
      else baldes.depois++;
    }
    return baldes;
  }

  // ------------------------------------------------------------------
  // Projeção de volume
  // ------------------------------------------------------------------

  /**
   * Volume total esperado do dia, a partir da primeira rodada (7h40).
   *
   * Fator por DIA DA SEMANA — nunca um fator único. O fator global (1,274)
   * é enganoso: a variação vem de misturar dias estruturalmente
   * diferentes, não de instabilidade. Ver CLAUDE.md Parte 3.6.
   *
   * Segunda tem fator 1,000 com desvio zero: às 7h40 a carga obrigatória
   * já está toda visível, e a previsão de segunda é exata, não estimada.
   */
  function projetarVolumeDoDia(vistosNaPrimeiraRodada, diaSemana, config) {
    var fator = (config.fatores_dia_semana || {})[String(diaSemana)];
    if (!fator) return null;          // fim de semana: não há prazo, nada a projetar
    return Math.round(vistosNaPrimeiraRodada * fator);
  }

  /**
   * Distribui as chegadas que ainda faltam ao longo das horas restantes,
   * usando a curva medida (8h 13% · 9h 19% · 10h 22% · 11h 21% · 12h 20%).
   *
   * O terço que falta NÃO chega de uma vez: entra mais ou menos no mesmo
   * ritmo em que a fila é consumida. Modelar isso como um bloco único
   * criaria um pico artificial e uma janela ociosa que não existe.
   */
  function chegadasPorPasso(chegadasRestantes, agora, fimTurno, config) {
    var curva = config.curva_chegada || {};
    var porPasso = {};                 // chave: minutos desde `agora`

    // Peso total das horas que ainda vão acontecer.
    var pesoRestante = 0;
    Object.keys(curva).forEach(function (h) {
      if (Number(h) >= agora.getHours()) pesoRestante += curva[h];
    });
    if (chegadasRestantes <= 0 || pesoRestante <= 0) return porPasso;

    Object.keys(curva).forEach(function (h) {
      var hora = Number(h);
      if (hora < agora.getHours()) return;

      var qtd = chegadasRestantes * (curva[h] / pesoRestante);

      // Espalhar dentro da hora, em passos de PASSO_MIN.
      var inicioHora = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hora, 0, 0, 0);
      var passosNaHora = MIN_POR_HORA / PASSO_MIN;
      for (var k = 0; k < passosNaHora; k++) {
        var t = new Date(inicioHora.getTime() + k * PASSO_MIN * 60000);
        if (t < agora || t > fimTurno) continue;
        var chave = Math.round(minutosEntre(agora, t));
        porPasso[chave] = (porPasso[chave] || 0) + qtd / passosNaHora;
      }
    });

    return porPasso;
  }

  // ------------------------------------------------------------------
  // Simulação
  // ------------------------------------------------------------------

  /**
   * Linha do tempo em passos de 5 min. NÃO é `volume ÷ capacidade`.
   *
   * Simular importa por dois motivos (CLAUDE.md 4.5):
   *   1. É impossível terminar antes do último pedido chegar. Como o pago
   *      até 13h precisa sair no mesmo dia, o último item da carga
   *      obrigatória entra às 12h59 — o piso de horário emerge daqui
   *      sozinho, sem número mágico no código.
   *   2. As janelas de ociosidade saem de graça, e elas são o segundo
   *      objetivo da ferramenta ("dá para liberar gente para outro setor").
   *
   * ⚠️ SEM parada explícita de almoço quando `ritmo_inclui_pausas` é true.
   * `ped_h_real` é `pedidos ÷ span do primeiro ao último bipe`, e esse span
   * atravessa as 13h — o almoço JÁ ESTÁ dentro do ritmo. Parar a simulação
   * por uma hora desconta o almoço duas vezes e infla o horário previsto em
   * cerca de uma hora. (O CLAUDE.md tinha as duas versões; esta é a
   * consistente. A outra só valeria com um ritmo "limpo", que não temos.)
   */
  function rodarSimulacao(filaInicial, chegadas, inicio, fim, pessoas, ritmoPorPessoa, config) {
    var porPasso = pessoas * ritmoPorPessoa * (PASSO_MIN / MIN_POR_HORA);
    var fila = filaInicial;
    var acumuladoChegadas = 0;
    var zerouEm = null;
    var janelas = [];
    var janelaAberta = null;
    var minutosOciosos = 0;

    for (var m = 0; m <= minutosEntre(inicio, fim); m += PASSO_MIN) {
      var t = new Date(inicio.getTime() + m * 60000);

      var entrando = chegadas[m] || 0;
      acumuladoChegadas += entrando;
      fila += entrando;

      var capacidade = porPasso;
      // Default é TRUE (ritmo já contém as pausas). Escrito como `!== false`
      // de propósito: config vindo do banco pode não trazer a coluna, e
      // `undefined` cairia na parada de almoço — justamente a dupla
      // contagem que custa uma hora de previsão.
      if (config.ritmo_inclui_pausas === false) {
        var almocoIni = horaDoDia(inicio, config.almoco_inicio || '13:00');
        var almocoFim = horaDoDia(inicio, config.almoco_fim || '14:00');
        if (t >= almocoIni && t < almocoFim) capacidade = 0;
      }

      var feito = Math.min(fila, capacidade);
      fila -= feito;

      if (fila <= 0.0001) {
        // Fim do passo, não o início: o trabalho daquele intervalo só está
        // pronto quando ele termina. Creditar no início adiantava toda
        // previsão em 5 minutos — pouco por passo, mas sempre no sentido
        // otimista, que é o lado errado para uma meta.
        if (zerouEm === null) zerouEm = new Date(t.getTime() + PASSO_MIN * 60000);
        if (!janelaAberta) janelaAberta = t;
        // Ociosidade só conta a capacidade que sobrou neste passo.
        minutosOciosos += (capacidade - feito) / (capacidade || 1) * PASSO_MIN * pessoas;
      } else {
        zerouEm = null;                  // voltou a ter fila: não terminou de fato
        if (janelaAberta) {
          janelas.push({ de: janelaAberta, ate: t });
          janelaAberta = null;
        }
      }
    }

    if (janelaAberta) janelas.push({ de: janelaAberta, ate: fim });

    return {
      termino: zerouEm,                  // null = não zera dentro do turno
      sobrou: Math.max(0, Math.round(fila)),
      chegadas_simuladas: Math.round(acumuladoChegadas),
      janelas_ociosas: janelas,
      horas_pessoa_ociosas: Math.round((minutosOciosos / 60) * 10) / 10
    };
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------

  /**
   * @param {Object} entrada
   * @param {Array}  entrada.pendentes    pedidos ainda não separados (view fila_pendente)
   * @param {Date}   entrada.agora
   * @param {Object} entrada.equipe       { pessoas, ritmo_ped_h }
   * @param {Object} entrada.config       espelha a tabela config_previsao
   * @param {number} [entrada.vistos_hoje]              união do dia (denominador)
   * @param {number} [entrada.vistos_primeira_rodada]   base da projeção de volume
   */
  function prever(entrada) {
    var agora = entrada.agora;
    var config = entrada.config;
    var equipe = entrada.equipe;
    var pendentes = entrada.pendentes || [];

    var inicioTurno = horaDoDia(agora, config.inicio_turno || '07:40');
    var fimTurno = horaDoDia(agora, config.fim_turno || '17:40');

    // ⚠️ Início do TURNO (7h40) ≠ início da PRODUÇÃO (8h30).
    // A raspagem roda às 7h40, mas os operadores só começam a separar por
    // volta das 8h30. Simular a partir das 7h40 dava ~50 min de produção
    // que não acontece — em 3 pessoas a 35/h, uns 90 pedidos de otimismo.
    // O ritmo em si não muda: ped_h_real é medido do primeiro ao último
    // bipe, então já começa quando a pessoa começa.
    var inicioProducao = horaDoDia(agora, config.inicio_producao || '08:30');
    var inicio = agora > inicioProducao ? agora : inicioProducao;

    var baldes = segmentarPorPrazo(pendentes, agora);

    // Quanto ainda deve entrar hoje.
    var volumeDia = null, chegadasRestantes = 0;
    if (entrada.vistos_primeira_rodada) {
      volumeDia = projetarVolumeDoDia(entrada.vistos_primeira_rodada, agora.getDay(), config);
      if (volumeDia != null) {
        chegadasRestantes = Math.max(0, volumeDia - (entrada.vistos_hoje || entrada.vistos_primeira_rodada));
      }
    }
    // As chegadas são calculadas a partir de AGORA, não do início da
    // produção: pedidos entram na fila entre 7h40 e 8h30 mesmo sem ninguém
    // separando. Essas viram fila inicial, não chegada futura — senão o
    // motor as descartaria e subestimaria a carga da manhã.
    var chegadasBrutas = chegadasPorPasso(chegadasRestantes, agora, fimTurno, config);
    var acumuladoAntesDaProducao = 0;
    var chegadas = {};

    Object.keys(chegadasBrutas).forEach(function (chave) {
      var t = new Date(agora.getTime() + Number(chave) * 60000);
      if (t < inicio) {
        acumuladoAntesDaProducao += chegadasBrutas[chave];
      } else {
        var novaChave = Math.round(minutosEntre(inicio, t));
        chegadas[novaChave] = (chegadas[novaChave] || 0) + chegadasBrutas[chave];
      }
    });

    var filaInicial = pendentes.length + acumuladoAntesDaProducao;

    var ritmo = equipe.ritmo_ped_h;
    var pessimista = ritmo * (config.fator_pessimista || 0.75);

    var p50 = rodarSimulacao(filaInicial, chegadas, inicio, fimTurno, equipe.pessoas, ritmo, config);
    var p90 = rodarSimulacao(filaInicial, chegadas, inicio, fimTurno, equipe.pessoas, pessimista, config);

    // ⚠️ A pergunta urgente é sobre o balde de HOJE, não sobre a fila
    // inteira. Medido em 17/08/2026 às 16h: 387 pendentes dos quais só 6
    // venciam no dia — a fila inteira "não fechava no turno" e o painel
    // ficava vermelho com a operação tranquila. Os 373 de amanhã são
    // adiantamento, não atraso.
    //
    // Chegadas ficam fora desta simulação: o que entra durante o dia
    // raramente vence no mesmo dia (nada pago na segunda vence na segunda,
    // e o pago após as 13h vai para o dia seguinte — Parte 3.6). Tratar
    // como se vencesse hoje inventaria urgência.
    var obrigatorios = baldes.atrasado + baldes.hoje;
    var hojeP50 = rodarSimulacao(obrigatorios, {}, inicio, fimTurno, equipe.pessoas, ritmo, config);
    var hojeP90 = rodarSimulacao(obrigatorios, {}, inicio, fimTurno, equipe.pessoas, pessimista, config);

    // Ritmo necessário: individual de propósito. O horário de término é
    // coletivo, mas o painel do operador é individual — mostrar o horário
    // lá faria o operador rápido ver o número piorar por causa do colega.
    // Ver CLAUDE.md 4.6.
    var horasRestantes = Math.max(0.25, minutosEntre(inicio, fimTurno) / 60);

    // Ritmo necessário é sobre o que é OBRIGATÓRIO hoje. Calculá-lo sobre a
    // fila inteira daria 80/h num dia em que só 6 pedidos vencem — número
    // inalcançável e sem sentido, que destruiria a confiança no painel.
    var ritmoNecessario = (obrigatorios + chegadasRestantes) / horasRestantes / equipe.pessoas;
    if (config.piso_ritmo_necessario) {
      ritmoNecessario = Math.max(ritmoNecessario, config.piso_ritmo_necessario);
    }

    // Ritmo para zerar TUDO (incluindo o adiantamento de amanhã). É o
    // "esticar", não a obrigação — separado de propósito.
    var ritmoParaTudo = (pendentes.length + chegadasRestantes) / horasRestantes / equipe.pessoas;

    return {
      agora: agora,
      inicio_producao: inicio,
      baldes: baldes,
      pendentes: pendentes.length,
      // Registrado para auditar a previsão depois: com equipe sobrescrita
      // para 5 numa terça, é isto que explica um horário otimista.
      equipe_usada: { pessoas: equipe.pessoas, ritmo_ped_h: ritmo },
      volume_previsto_dia: volumeDia,
      chegadas_restantes: Math.round(chegadasRestantes),

      // Faixa, nunca horário cravado: a variabilidade não sustenta precisão
      // de minutos, e precisão falsa destrói a confiança na primeira vez que
      // erra (CLAUDE.md Parte 5, decisão 4).
      //
      // OBRIGATÓRIO = atrasados + vencem hoje. É o número que cobra.
      obrigatorios: obrigatorios,
      termino_hoje_p50: hojeP50.termino,
      termino_hoje_p90: hojeP90.termino,

      // TUDO = obrigatório + adiantamento de amanhã. É o "se der".
      termino_tudo_p50: p50.termino,
      termino_tudo_p90: p90.termino,

      // ⚠️ A META PUBLICADA é sobre o OBRIGATÓRIO, no ritmo NORMAL.
      //
      // Revisa a decisão 12 (18/08/2026): era o cenário pessimista, mas a
      // ponta lenta saiu da tela e o piso do ritmo necessário virou 35/h.
      // Publicar uma meta calculada a 26/h enquanto se cobra 35/h seria
      // incoerente — e duas horas diferentes no painel confundem mais do
      // que a margem protege.
      //
      // O viés conservador continua existindo, só que num lugar só: a
      // equipe é fixa em 3 mesmo quando há mais gente na bancada.
      termino_para_meta: hojeP50.termino,

      ritmo_necessario: Math.round(ritmoNecessario * 10) / 10,
      ritmo_para_zerar_tudo: Math.round(ritmoParaTudo * 10) / 10,

      // ⚠️ Ociosidade é medida sobre o OBRIGATÓRIO, não sobre a fila
      // inteira. A pergunta é "cumprido o que vence hoje, sobra gente para
      // ajudar outro setor?" — e sobre a fila inteira a resposta é sempre
      // zero, porque sempre há adiantamento de amanhã para consumir.
      horas_pessoa_ociosas: hojeP50.horas_pessoa_ociosas,
      janelas_ociosas: hojeP50.janelas_ociosas,
      horas_pessoa_ociosas_fila_inteira: p50.horas_pessoa_ociosas,

      // ⚠️ Falta de capacidade é sobre o OBRIGATÓRIO. Não fechar o
      // adiantamento de amanhã é normal e não é alarme.
      falta_capacidade: hojeP50.termino === null,
      sobra_obrigatoria_no_fim: hojeP50.sobrou,
      sobra_total_no_fim: p50.sobrou
    };
  }

  var api = {
    prever: prever,
    segmentarPorPrazo: segmentarPorPrazo,
    projetarVolumeDoDia: projetarVolumeDoDia,
    _chegadasPorPasso: chegadasPorPasso,
    _horaDoDia: horaDoDia
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FilaPrevisao = api;
})(typeof window !== 'undefined' ? window : globalThis);
