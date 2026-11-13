/**
 * parser.js — DOM das telas de pedidos do UpSeller → array de pedidos.
 *
 * FUNÇÃO PURA: recebe um Document/Element e devolve dados. Sem fetch, sem
 * Supabase, sem chrome.*, sem variável global de página. É isso que permite
 * testar contra um HTML salvo em disco, sem login e sem tocar em produção.
 *
 * Serve às TRÊS etapas (Para Emitir / Para Enviar / Para Imprimir) — elas
 * compartilham o mesmo componente de tabela, mudando só algumas colunas.
 * Ver ../CLAUDE.md Parte 1.
 *
 * ⚠️ REGRAS DE ANCORAGEM (não relaxar sem ler o CLAUDE.md):
 *   1. Nunca usar os atributos data-v-XXXXXXXX — mudam a cada deploy do UpSeller.
 *   2. Colunas são localizadas pelo TEXTO do cabeçalho, nunca por posição fixa:
 *      "Para Enviar" tem Ordenado/Pagado; "Para Imprimir" tem Pagado/Arranjada.
 *   3. Rótulos dentro da célula Tempo também são lidos por texto, pelo mesmo motivo.
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Utilidades de texto
  // ------------------------------------------------------------------

  /**
   * O UpSeller injeta marcas de direção (U+200E) dentro dos preços — "R$‎‎ 11,89"
   * tem dois caracteres invisíveis. Sem limpar, comparações de texto falham
   * de um jeito que não aparece no console.
   */
  function limpar(texto) {
    return String(texto == null ? '' : texto)
      .replace(/[‎‏ ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function textoDe(el) {
    return el ? limpar(el.textContent) : '';
  }

  // ------------------------------------------------------------------
  // Cabeçalho: nome da coluna → índice do <td>
  // ------------------------------------------------------------------

  function mapaColunas(tabela) {
    var mapa = {};
    var ths = tabela.querySelectorAll('thead th');
    for (var i = 0; i < ths.length; i++) {
      // A célula "Produtos" carrega um checkbox e um ícone junto do texto;
      // textContent resolve os dois casos (com e sem atributo title).
      var titulo = limpar(ths[i].querySelector('.title_item') ? ths[i].querySelector('.title_item').textContent : ths[i].textContent);
      if (titulo) mapa[titulo] = i;
    }
    return mapa;
  }

  /** Pega o <td> pelo nome da coluna. Devolve null se a coluna não existir nesta etapa. */
  function tdPorColuna(linha, mapa, nomeColuna) {
    if (!(nomeColuna in mapa)) return null;
    return linha.children[mapa[nomeColuna]] || null;
  }

  // ------------------------------------------------------------------
  // Célula "Tempo": pares rótulo → valor
  //
  // Estrutura observada (17/08/2026):
  //   <div class="mb_5"><div class="f_gray_8c">Pagado</div><div>17/08/2026 08:23</div></div>
  //
  // Localizado por ESTRUTURA (bloco com exatamente 2 divs folha), não pela
  // classe f_gray_8c — a classe é gerada e pode mudar; a forma não.
  // ------------------------------------------------------------------

  function paresRotuloValor(td) {
    var pares = {};
    if (!td) return pares;
    var divs = td.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      var bloco = divs[i];
      if (bloco.children.length !== 2) continue;
      var a = bloco.children[0];
      var b = bloco.children[1];
      if (a.tagName !== 'DIV' || b.tagName !== 'DIV') continue;
      if (a.children.length !== 0 || b.children.length !== 0) continue;
      var rotulo = limpar(a.textContent);
      var valor = limpar(b.textContent);
      if (rotulo && valor) pares[rotulo] = valor;
    }
    return pares;
  }

  // ------------------------------------------------------------------
  // Datas
  // ------------------------------------------------------------------

  /** "17/08/2026 08:23" → Date local. Devolve null se não casar. */
  function parseDataBR(texto) {
    var m = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(limpar(texto));
    if (!m) return null;
    var d = new Date(
      Number(m[3]), Number(m[2]) - 1, Number(m[1]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
    );
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * "1d 14h 43m" → milissegundos. Aceita subconjuntos ("14h 43m", "43m").
   *
   * ⚠️ "Expira em" é RELATIVO ao instante da raspagem. Sem somar ao raspadoEm
   * o dado perde o sentido assim que é gravado (CLAUDE.md Parte 3.5).
   */
  function parseDuracaoRelativa(texto) {
    var t = limpar(texto);
    if (!t) return null;
    var m = /(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(t);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    var ms = (Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60) * 1000;
    // O UpSeller mostra prazo vencido como texto negativo/"Expirado" — nesses
    // casos o regex acima não casa e devolvemos null, que é o correto:
    // melhor sem prazo do que com prazo inventado.
    return ms;
  }

  function iso(d) {
    return d ? d.toISOString() : null;
  }

  /**
   * Ajusta o prazo calculado para o 23:59:59 mais próximo.
   *
   * POR QUE ISSO EXISTE: "Expira em" é truncado ao minuto na tela, e o
   * horário da raspagem tem sua própria imprecisão. Somando os dois, o
   * instante calculado erra por alguns minutos — e quando o vencimento é
   * perto da meia-noite, esse erro faz o prazo PULAR DE DIA.
   *
   * Caso real (17/08/2026): raspagem estimada 2 min adiantada transformou
   * 18/08 23:59 em 19/08 00:01 — terça virou quarta. Como a previsão é
   * segmentada por "vence hoje × vence amanhã" (CLAUDE.md 3.5), isso joga
   * o pedido no balde errado.
   *
   * A normalização é segura porque o export do UpSeller mostra o Prazo de
   * Envio sempre como `AAAA-MM-DD 23:59:59` (CLAUDE.md Parte 3.6).
   *
   * ⚠️ Se algum marketplace novo passar a usar prazo no meio do dia, esta
   * função precisa virar opcional por canal. O texto cru fica guardado em
   * expira_em_texto, então dá para reprocessar sem raspar de novo.
   */
  function normalizarPrazoDiario(d) {
    if (!d) return null;
    var ajustado = new Date(d.getTime());
    if (ajustado.getHours() < 12) ajustado.setDate(ajustado.getDate() - 1);
    ajustado.setHours(23, 59, 59, 0);
    return ajustado;
  }

  // ------------------------------------------------------------------
  // Célula "Produtos": SKUs e quantidades
  //
  // Cada produto é um bloco com <a title="SKU">…</a> e <b>× N</b>.
  // Pedido misto = vários blocos irmãos DENTRO DO MESMO <td> (não viram
  // linha nova na tabela) — CLAUDE.md Parte 1.
  // ------------------------------------------------------------------

  var RE_QUANTIDADE = /^[×x]\s*(\d+)$/i;

  function parseItens(td) {
    var itens = [];
    if (!td) return itens;

    // Ancorar nos <b> de quantidade: é o único elemento que existe uma vez
    // por produto. Partir dos <a> daria falso positivo (há links de imagem).
    var negritos = td.querySelectorAll('b');
    for (var i = 0; i < negritos.length; i++) {
      var m = RE_QUANTIDADE.exec(limpar(negritos[i].textContent));
      if (!m) continue;

      var bloco = blocoDoProduto(negritos[i]);
      var link = bloco ? bloco.querySelector('a[title]') : null;
      var sku = link ? limpar(link.getAttribute('title')) || textoDe(link) : '';
      if (!sku) continue;

      itens.push({ sku: sku, quantidade: Number(m[1]) });
    }
    return itens;
  }

  /** Sobe do <b> até o ancestral que contém o link do SKU (no máx. 6 níveis). */
  function blocoDoProduto(el) {
    var atual = el;
    for (var i = 0; i < 6 && atual; i++) {
      atual = atual.parentElement;
      if (atual && atual.querySelector('a[title]')) return atual;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Código de rastreio — só existe a partir de "Para Imprimir"
  //
  // Estrutura na célula "Métodos de Envio" (validada 17/08/2026):
  //   <div title="Retirada pelo Comprador">Retirada pelo Comprador</div>
  //   <div>BR000000000000PSPXEX00000001</div>   ← o rastreio, em div própria
  //   <div><span>[Retirada]</span></div>
  //   <div><span class="f_placeholder">17/08/2026</span></div>
  //
  // Em "Para Enviar" a célula tem transportadora e [Retirada], mas nenhum
  // código — o rastreio nasce no processamento. Devolver null nesse caso é
  // o comportamento correto, não uma falha.
  //
  // ⚠️ É a CHAVE DE CRUZAMENTO com pedidos_separados.codigo_rastreio
  // (CLAUDE.md Parte 1.2). Errar aqui não quebra nada visivelmente: só faz
  // pedidos já separados parecerem pendentes para sempre.
  // ------------------------------------------------------------------

  // Código isolado: só maiúsculas e dígitos, comprido. Exclui a data
  // (tem barras), "[Retirada]" (colchetes) e nomes de transportadora
  // (têm minúsculas e espaços).
  var RE_RASTREIO_EXATO = /^[A-Z0-9]{10,}$/;
  var RE_RASTREIO_SOLTO = /\b([A-Z]{2}[A-Z0-9]{10,})\b/;

  function parseRastreio(td) {
    if (!td) return null;

    // Preferir a div-folha que contém SÓ o código: mais preciso que varrer
    // o texto inteiro da célula.
    var divs = td.querySelectorAll('div, span');
    for (var i = 0; i < divs.length; i++) {
      if (divs[i].children.length) continue;
      var t = limpar(divs[i].textContent);
      if (RE_RASTREIO_EXATO.test(t)) return t;
    }

    // Fallback: procurar no texto corrido, caso o layout mude.
    var texto = textoDe(td).replace(/\[[^\]]*\]/g, ' ');
    var m = RE_RASTREIO_SOLTO.exec(texto);
    return m ? m[1] : null;
  }

  // ------------------------------------------------------------------
  // Linha de cabeçalho do pedido (tr.top_row): nº, loja, plataforma
  // ------------------------------------------------------------------

  function parseTopRow(linhaDados) {
    var resultado = { num_pedido: null, loja: null, plataforma: null, logistica: null };

    // O irmão anterior é o tr.top_row do mesmo pedido. Usar o irmão em vez de
    // #trTop{data-id} evita depender do id, que só existe por acaso.
    var top = linhaDados.previousElementSibling;
    if (!top || top.className.indexOf('top_row') === -1) {
      var id = linhaDados.getAttribute('data-id');
      var doc = linhaDados.ownerDocument;
      top = id && doc ? doc.getElementById('trTop' + id) : null;
    }
    if (!top) return resultado;

    var links = top.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var t = textoDe(links[i]);
      if (t.charAt(0) === '#') {
        resultado.num_pedido = t.slice(1);   // #UP209K410669 → UP209K410669
        break;
      }
    }

    // "Logística/Armazém Indicado: Shopee Xpress"
    var comTitulo = top.querySelectorAll('span[title]');
    var elLogistica = null;
    for (var j = 0; j < comTitulo.length; j++) {
      var pai = comTitulo[j].parentElement;
      if (pai && textoDe(pai).indexOf('Logística') === 0) {
        elLogistica = comTitulo[j];
        resultado.logistica = limpar(comTitulo[j].getAttribute('title'));
        break;
      }
    }

    // A loja é o outro span[title] do cabeçalho (Hope Cirurgica, RJL Imports…).
    // Não filtrar por loja: a mesma equipe separa todas (confirmado 17/08/2026).
    for (var k = 0; k < comTitulo.length; k++) {
      if (comTitulo[k] === elLogistica) continue;
      var titulo = limpar(comTitulo[k].getAttribute('title'));
      if (titulo) resultado.loja = titulo;
    }

    // Plataforma: último span sem title com texto (Shopee, TikTok Shop…).
    var spans = top.querySelectorAll('span');
    for (var n = spans.length - 1; n >= 0; n--) {
      if (spans[n].hasAttribute('title')) continue;
      if (spans[n].children.length) continue;
      var texto = textoDe(spans[n]);
      if (texto && texto !== resultado.loja && texto.indexOf('Logística') === -1) {
        resultado.plataforma = texto;
        break;
      }
    }

    return resultado;
  }

  // ------------------------------------------------------------------
  // Paginação
  //
  // ⚠️ Com mais de 300 pedidos a paginação é OBRIGATÓRIA — em 17/08/2026 a
  // tela "Para Imprimir" mostrava "Total 698 · 1/3". A afirmação antiga de
  // que "cabe tudo em 1/1" só valia para filas pequenas (CLAUDE.md Parte 1).
  // ------------------------------------------------------------------

  function lerPaginacao(raiz) {
    var caixa = raiz.querySelector('.my_page_ui');
    var info = { total_esperado: null, pagina_atual: null, total_paginas: null,
                 por_pagina: null, tem_proxima: false };
    if (!caixa) return info;

    var mTotal = /Total\s+(\d+)/i.exec(textoDe(caixa));
    if (mTotal) info.total_esperado = Number(mTotal[1]);

    // Tamanho da pagina, lido do proprio seletor ("300/pagina").
    //
    // E o que permite saber quantas linhas ESTA pagina deveria ter. Sem
    // isso a rolagem so consegue comparar o acumulado de TODAS as paginas
    // contra o Total — o que so fecha na ultima pagina e deixa as
    // anteriores sem criterio de parada nenhum. Ver content.js →
    // esperadoNaPagina().
    //
    // O "\d+ /" exige a palavra "pagina" depois da barra, senao casaria
    // com o indicador de pagina atual ("1/2"), que vive na mesma caixa.
    var mPorPagina = /(\d+)\s*\/\s*p[áa]gina/i.exec(textoDe(caixa));
    if (mPorPagina) info.por_pagina = Number(mPorPagina[1]);

    var indicador = caixa.querySelector('.page_current_box .input_box');
    var mPag = /(\d+)\s*\/\s*(\d+)/.exec(textoDe(indicador));
    if (mPag) {
      info.pagina_atual = Number(mPag[1]);
      info.total_paginas = Number(mPag[2]);
    }

    var botao = caixa.querySelector('button[title="Página Seguinte"]');
    info.tem_proxima = !!(botao && !botao.disabled);

    return info;
  }

  // ------------------------------------------------------------------
  // API pública
  // ------------------------------------------------------------------

  /**
   * Lê os pedidos visíveis no DOM agora.
   *
   * ⚠️ Por causa do virtual scrolling, UMA chamada devolve só as linhas
   * visíveis (~42). Quem chama deve rolar e acumular, deduplicando por
   * num_pedido — ver acumularPedidos().
   *
   * @param {Document|Element} raiz
   * @param {{etapa?: string, raspadoEm?: Date}} opcoes
   */
  function lerPagina(raiz, opcoes) {
    opcoes = opcoes || {};
    var etapa = opcoes.etapa || null;
    var raspadoEm = opcoes.raspadoEm || new Date();

    var tabela = raiz.querySelector('table.my_custom_table');
    if (!tabela) {
      return { erro: 'tabela_nao_encontrada', pedidos: [], paginacao: lerPaginacao(raiz) };
    }

    var mapa = mapaColunas(tabela);
    var linhas = tabela.querySelectorAll('tbody tr[data-id]');
    var pedidos = [];

    for (var i = 0; i < linhas.length; i++) {
      var linha = linhas[i];
      var cabecalho = parseTopRow(linha);
      if (!cabecalho.num_pedido) continue;   // linha de layout, não é pedido

      var tempo = paresRotuloValor(tdPorColuna(linha, mapa, 'Tempo'));
      var pagoEm = parseDataBR(tempo['Pagado'] || tempo['Pago'] || '');
      var ordenadoEm = parseDataBR(tempo['Ordenado'] || '');
      var arranjadaEm = parseDataBR(tempo['Arranjada'] || '');

      var expiraTexto = tempo['Expira em'] || null;
      var expiraMs = expiraTexto ? parseDuracaoRelativa(expiraTexto) : null;
      var expiraBruto = expiraMs == null ? null : new Date(raspadoEm.getTime() + expiraMs);
      var expiraEm = opcoes.normalizarPrazo === false ? expiraBruto : normalizarPrazoDiario(expiraBruto);

      var tdPlataforma = tdPorColuna(linha, mapa, 'Nº de Pedido da Plataforma');
      var tdEnvio = tdPorColuna(linha, mapa, 'Métodos de Envio');

      pedidos.push({
        etapa: etapa,
        num_pedido: cabecalho.num_pedido,
        num_pedido_plataforma: tdPlataforma ? primeiroTextoUtil(tdPlataforma) : null,
        codigo_rastreio: parseRastreio(tdEnvio),
        loja: cabecalho.loja,
        plataforma: cabecalho.plataforma,
        logistica: cabecalho.logistica,
        ordenado_em: iso(ordenadoEm),
        pago_em: iso(pagoEm),
        arranjada_em: iso(arranjadaEm),
        expira_em: iso(expiraEm),
        expira_em_texto: expiraTexto,
        estado: textoDe(tdPorColuna(linha, mapa, 'Estado')),
        itens: parseItens(tdPorColuna(linha, mapa, 'Produtos'))
      });
    }

    return {
      erro: null,
      etapa: etapa,
      raspado_em: iso(raspadoEm),
      colunas: Object.keys(mapa),
      paginacao: lerPaginacao(raiz),
      pedidos: pedidos
    };
  }

  /** Primeiro texto não vazio dentro da célula (a célula tem divs vazios de layout). */
  function primeiroTextoUtil(td) {
    var divs = td.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      if (divs[i].children.length) continue;
      var t = limpar(divs[i].textContent);
      if (t) return t;
    }
    return textoDe(td) || null;
  }

  /**
   * Acumulador para a rolagem: junta o resultado de várias leituras,
   * deduplicando por num_pedido e mantendo sempre a leitura mais recente
   * (o pedido pode ter avançado de etapa entre uma rolagem e outra).
   */
  function acumularPedidos(acumulado, novos) {
    var mapa = acumulado || {};
    for (var i = 0; i < novos.length; i++) {
      mapa[novos[i].num_pedido] = novos[i];
    }
    return mapa;
  }

  /**
   * Quantas linhas ESTA página deveria ter.
   *
   * ⚠️ É o critério de parada que faltava na rolagem. A parada antecipada
   * comparava o acumulado de TODAS as páginas contra o `Total` do rodapé —
   * o que só é verdade na ÚLTIMA página. Nas anteriores não havia critério
   * nenhum: cada uma rolava até `chegouAoFim` ou até queimar MAX_PASSOS
   * (600 × 300ms = 180s), mesmo já tendo lido tudo que havia nela.
   *
   * Devolve null quando a paginação não expõe o tamanho da página — aí quem
   * chama degrada para o comportamento anterior em vez de quebrar.
   */
  function esperadoNaPagina(pag) {
    if (!pag || !pag.por_pagina || !pag.pagina_atual || pag.total_esperado == null) return null;

    // Última página: só o resto.
    if (pag.total_paginas && pag.pagina_atual >= pag.total_paginas) {
      var restante = pag.total_esperado - (pag.total_paginas - 1) * pag.por_pagina;
      return restante > 0 ? restante : null;
    }
    return Math.min(pag.por_pagina, pag.total_esperado);
  }

  var api = {
    lerPagina: lerPagina,
    lerPaginacao: lerPaginacao,
    esperadoNaPagina: esperadoNaPagina,
    acumularPedidos: acumularPedidos,
    // expostos para teste
    _limpar: limpar,
    _parseDataBR: parseDataBR,
    _parseDuracaoRelativa: parseDuracaoRelativa,
    _normalizarPrazoDiario: normalizarPrazoDiario
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FilaParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
