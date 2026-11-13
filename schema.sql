-- ====================================================================
-- Previsão de Expedição — schema das tabelas novas (Supabase)
-- Execute no SQL Editor do mesmo projeto Supabase usado pela extensão
-- e pelo dashboard. Idempotente: pode rodar por cima sem duplicar nada.
--
-- ⚠️ ESTE SCRIPT É ESTRITAMENTE ADITIVO.
-- Ele NÃO altera nenhuma tabela existente (pedidos_separados,
-- operadores_metas, configuracoes_gerais, logs_acesso, usuarios_painel).
-- A extensão dos operadores e o dashboard continuam funcionando sem
-- qualquer atualização — tabela nova é invisível para quem não consulta.
-- Ver ../upseller-extension/database.sql para o schema já existente.
-- ====================================================================


-- ====================================================================
-- 1. fila_snapshots — cabeçalho de cada raspagem de UMA tela
--
-- Uma linha por (rodada × etapa): as telas "Para Enviar" e "Para Imprimir"
-- são páginas diferentes do UpSeller e são raspadas separadamente.
-- A coluna `rodada` agrupa as duas leituras de um mesmo ciclo.
--
-- ⚠️ As DUAS telas precisam ser raspadas e somadas. Raspar só uma leria 6
-- pedidos num dia de 1.250, porque a liderança move a carga de "Para
-- Enviar" para "Para Imprimir" ao longo da manhã. Ver CLAUDE.md Parte 1.1.
-- ====================================================================
CREATE TABLE IF NOT EXISTS fila_snapshots (
    id BIGSERIAL PRIMARY KEY,
    raspado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),

    -- Data do turno em horário LOCAL (America/Sao_Paulo), calculada pelo
    -- coletor. Não derivar de raspado_em no SQL: os timestamps são UTC e
    -- uma raspagem das 21h viraria o dia seguinte.
    dia_operacional DATE NOT NULL,

    -- para_enviar | para_imprimir  (para_emitir está fora de escopo por ora)
    etapa VARCHAR(30) NOT NULL,

    -- Qual sub-aba da tela foi medida. "Para Imprimir" tem quatro
    -- ("Todos", "Etiqueta não impressa", "Etiqueta impressa", "Cancelado") e
    -- abre por padrão na segunda, que é só uma fatia. O correto é 'Todos'.
    --
    -- ⚠️ Snapshots com sub_aba NULL em etapa='para_imprimir' são
    -- ANTERIORES a esta correção (17/08/2026) e mediram apenas "Etiqueta
    -- não impressa" — subestimam a fila em ~30-50%. Não usar como baseline.
    sub_aba VARCHAR(40),

    -- Agrupa as leituras das duas telas de um mesmo ciclo. NULL em
    -- raspagem manual avulsa.
    rodada VARCHAR(40),

    origem VARCHAR(50) NOT NULL DEFAULT 'coletor-fila',

    -- ok            → capturado >= o Total do rodapé da tela
    -- incompleto    → capturou menos (rolagem/paginação falhou)
    -- falha_sessao  → redirecionou para o login; NÃO confundir com fila vazia
    -- erro          → qualquer outra falha; ver coluna erro
    status VARCHAR(20) NOT NULL DEFAULT 'ok',

    total_capturado INTEGER NOT NULL DEFAULT 0,
    total_esperado INTEGER,
    paginas SMALLINT,

    -- Por que a raspagem parou (18/08/2026). Diagnóstico: distingue uma
    -- coleta que terminou de uma que foi INTERROMPIDA por trava nossa —
    -- e as duas podem produzir o mesmo status='ok'.
    --
    --   total_atingido    → capturou o que o rodapé prometia (o normal)
    --   fim_da_lista      → acabaram as páginas
    --   prazo             → estourou ROLAGEM.PRAZO_RASPAGEM_MS
    --   max_paginas       → bateu na trava de páginas
    --   pagina_retrocedeu → a grade voltou para uma página anterior
    --   pagina_nao_trocou → clicou em "próxima" e a lista não mudou
    --
    -- ⚠️ Snapshots com motivo_parada NULL são anteriores a esta coluna.
    motivo_parada VARCHAR(30),

    erro TEXT
);

COMMENT ON TABLE fila_snapshots IS
'Cabeçalho de cada raspagem de uma tela de fila do UpSeller. Append-only.';

CREATE INDEX IF NOT EXISTS idx_fila_snapshots_rodada ON fila_snapshots (dia_operacional, rodada);

CREATE INDEX IF NOT EXISTS idx_fila_snapshots_dia ON fila_snapshots (dia_operacional, raspado_em DESC);


-- ====================================================================
-- 2. fila_snapshot_itens — um pedido por linha, por rodada
--
-- O mesmo pedido aparece em várias rodadas do dia (e pode mudar de
-- etapa entre elas). Isso é proposital: é o que permite montar a UNIÃO
-- dos pedidos do dia. Ver CLAUDE.md Parte 1.2.
-- ====================================================================
CREATE TABLE IF NOT EXISTS fila_snapshot_itens (
    id BIGSERIAL PRIMARY KEY,
    snapshot_id BIGINT NOT NULL REFERENCES fila_snapshots(id) ON DELETE CASCADE,

    -- Desnormalizado de propósito: a query de união filtra por dia e
    -- ficaria cara tendo que passar pelo cabeçalho a cada leitura.
    dia_operacional DATE NOT NULL,

    -- para_emitir | para_enviar | para_imprimir
    etapa VARCHAR(30) NOT NULL,

    -- Chave principal do modelo de união. Nº do UpSeller SEM o "#": UP209K410061.
    -- É a única chave presente em TODAS as etapas.
    num_pedido VARCHAR(50) NOT NULL,

    -- Nº do pedido no marketplace (260816EXEMPLO1). Guardado para
    -- conferência manual e para cruzar com o export .xlsx do UpSeller.
    num_pedido_plataforma VARCHAR(60),

    -- ⚠️ NULL em "Para Emitir" e "Para Enviar": o rastreio só nasce no
    -- processamento (sub-aba "Obtendo Nº de Rastreio"). É a chave de
    -- cruzamento com pedidos_separados.codigo_rastreio quando existe.
    codigo_rastreio VARCHAR(100),

    loja VARCHAR(100),          -- Hope Cirurgica, RJL Imports, ... (não filtrar: mesma equipe separa todas)
    plataforma VARCHAR(50),     -- Shopee, TikTok Shop, ...

    -- "Shopee Xpress", "Retirada pelo Comprador", ... Guardado porque a
    -- retirada pelo comprador pode ter fluxo diferente na bancada — a
    -- confirmar. Não usado no cálculo por enquanto.
    logistica VARCHAR(80),

    estado VARCHAR(40),         -- "Para Enviar", "Para Imprimir", ... (o rótulo da própria tela)

    pago_em TIMESTAMP WITH TIME ZONE,

    -- Só existe em "Para Enviar" (some em "Para Imprimir").
    ordenado_em TIMESTAMP WITH TIME ZONE,

    -- Só existe a partir de "Para Imprimir": é quando a LIDERANÇA processou
    -- o pedido e gerou a etiqueta. Medição de graça de quando o trabalho de
    -- processamento acontece — útil para entender a corrida descrita na
    -- Parte 1.1 do CLAUDE.md.
    arranjada_em TIMESTAMP WITH TIME ZONE,

    -- Prazo ABSOLUTO, convertido pelo coletor a partir do "Expira em"
    -- (que é relativo) somado ao raspado_em. Ver CLAUDE.md Parte 3.5:
    -- o prazo vem da Shopee e pode MUDAR entre raspagens — por isso as
    -- views abaixo sempre usam a linha mais recente de cada pedido.
    expira_em TIMESTAMP WITH TIME ZONE,

    -- O texto cru ("1d 15h 30m"), para auditar a conversão acima.
    expira_em_texto VARCHAR(50),

    -- 'upseller' → prazo lido da tela (o que a Shopee mandou)
    -- 'regra'    → a Shopee NÃO mandou prazo (instabilidade do lado dela) e
    --              o valor foi derivado da regra de corte/fim de semana
    --              (motor/prazo.js)
    -- NULL       → sem prazo e sem pagamento: não há como estimar
    --
    -- ⚠️ Existe para que prazo estimado nunca se passe por prazo real. A
    -- decisão do projeto é LER o prazo do marketplace (CLAUDE.md 3.5); a
    -- regra é exceção, e precisa ser auditável. Se a proporção de 'regra'
    -- crescer, é sinal de problema de sincronização, não de normalidade.
    prazo_origem VARCHAR(10),

    -- Mesmo formato de pedidos_separados.itens: [{"sku":"1,5L-PERFU-FLEX","quantidade":1}]
    -- Os SKUs são idênticos entre as telas e o checkout — join direto, sem normalização.
    itens JSONB
);

COMMENT ON TABLE fila_snapshot_itens IS
'Um pedido por linha, por rodada de raspagem. Repetição entre rodadas é proposital (modelo de união).';

CREATE INDEX IF NOT EXISTS idx_fila_itens_dia_pedido   ON fila_snapshot_itens (dia_operacional, num_pedido);
CREATE INDEX IF NOT EXISTS idx_fila_itens_dia_rastreio ON fila_snapshot_itens (dia_operacional, codigo_rastreio);
CREATE INDEX IF NOT EXISTS idx_fila_itens_snapshot     ON fila_snapshot_itens (snapshot_id);

-- 2.1 Migrações das tabelas DESTE projeto.
--
-- CREATE TABLE IF NOT EXISTS não adiciona coluna em tabela que já existe,
-- então colunas novas precisam de ALTER explícito. Mantidos aqui para que
-- rodar o script inteiro de novo continue funcionando, tanto em banco novo
-- quanto em banco que já recebeu uma versão anterior.
--
-- ⚠️ Só ALTERam tabelas criadas por este arquivo. Nenhuma tabela da
-- ../upseller-extension é tocada — a extensão dos operadores continua sem
-- precisar de atualização.
ALTER TABLE fila_snapshot_itens ADD COLUMN IF NOT EXISTS prazo_origem VARCHAR(10);
ALTER TABLE fila_snapshot_itens ADD COLUMN IF NOT EXISTS logistica VARCHAR(80);
ALTER TABLE fila_snapshot_itens ADD COLUMN IF NOT EXISTS estado VARCHAR(40);
ALTER TABLE fila_snapshot_itens ADD COLUMN IF NOT EXISTS ordenado_em TIMESTAMP WITH TIME ZONE;
ALTER TABLE fila_snapshot_itens ADD COLUMN IF NOT EXISTS arranjada_em TIMESTAMP WITH TIME ZONE;
ALTER TABLE fila_snapshots      ADD COLUMN IF NOT EXISTS paginas SMALLINT;
ALTER TABLE fila_snapshots      ADD COLUMN IF NOT EXISTS rodada VARCHAR(40);
ALTER TABLE fila_snapshots      ADD COLUMN IF NOT EXISTS sub_aba VARCHAR(40);
ALTER TABLE fila_snapshots      ADD COLUMN IF NOT EXISTS motivo_parada VARCHAR(30);
ALTER TABLE config_previsao     ADD COLUMN IF NOT EXISTS inicio_producao TIME NOT NULL DEFAULT '08:30';
ALTER TABLE config_previsao     ADD COLUMN IF NOT EXISTS ritmo_inclui_pausas BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE config_previsao     ADD COLUMN IF NOT EXISTS fator_pessimista NUMERIC(3,2) NOT NULL DEFAULT 0.75;
ALTER TABLE previsao_dia        ADD COLUMN IF NOT EXISTS previsao_atual JSONB;
ALTER TABLE previsao_dia        ADD COLUMN IF NOT EXISTS previsao_atualizada_em TIMESTAMP WITH TIME ZONE;

-- Piso do ritmo necessário passou a ter padrão 35 (18/08/2026). Preenche
-- só onde está NULL, para não desfazer um ajuste manual futuro.
UPDATE config_previsao SET piso_ritmo_necessario = 35 WHERE piso_ritmo_necessario IS NULL;

ALTER TABLE previsao_dia ADD COLUMN IF NOT EXISTS obrigatorios_inicial INTEGER;
ALTER TABLE previsao_dia ADD COLUMN IF NOT EXISTS pendentes_inicial INTEGER;

-- Preenche retroativamente o retrato inicial dos dias que já têm previsão,
-- a partir da PRIMEIRA coleta bem-sucedida de cada etapa.
--
-- Só considera status='ok': a primeira tentativa do dia costuma ser a que
-- falha (rolagem apertada, sessão fria), e usar uma coleta truncada como
-- "início do dia" registraria uma fila menor do que a real — o oposto do
-- que o número deve mostrar.
--
-- Só preenche onde está NULL, então rodar de novo não sobrescreve nada.
UPDATE previsao_dia p
SET obrigatorios_inicial = sub.obrigatorios,
    pendentes_inicial    = sub.total
FROM (
    SELECT i.dia_operacional,
           count(DISTINCT i.num_pedido) AS total,
           count(DISTINCT i.num_pedido) FILTER (
               WHERE (i.expira_em AT TIME ZONE 'America/Sao_Paulo')::date <= i.dia_operacional
           ) AS obrigatorios
    FROM fila_snapshot_itens i
    WHERE i.snapshot_id IN (
        SELECT DISTINCT ON (s.dia_operacional, s.etapa) s.id
        FROM fila_snapshots s
        WHERE s.status = 'ok'
        ORDER BY s.dia_operacional, s.etapa, s.raspado_em
    )
    GROUP BY i.dia_operacional
) sub
WHERE p.dia_operacional = sub.dia_operacional
  AND p.obrigatorios_inicial IS NULL;


-- ====================================================================
-- 3. previsao_dia — meta congelada + registro previsto vs. realizado
--
-- Uma linha por dia. A META é congelada de propósito (CLAUDE.md 4.6):
-- o operador não pode ver o horário afrouxar sozinho. A previsão VIVA
-- não mora aqui — é recalculada pelo dashboard em memória.
-- ====================================================================
CREATE TABLE IF NOT EXISTS previsao_dia (
    dia_operacional DATE PRIMARY KEY,

    -- --- meta comprometida (só muda por ação de um gestor) ---
    meta_hora_termino TIMESTAMP WITH TIME ZONE,
    meta_ritmo_necessario NUMERIC(5,1),
    meta_publicada_em TIMESTAMP WITH TIME ZONE,
    meta_publicada_por VARCHAR(50),

    -- --- retrato da PRIMEIRA coleta do dia (congelado junto com a meta) ---
    -- Serve de referência no painel: "600 obrigatórios agora, eram 700 no
    -- início do dia" conta uma história que o número sozinho não conta.
    -- Escrito uma vez só, igual à meta — se fosse atualizado a cada coleta,
    -- deixaria de ser "início do dia".
    obrigatorios_inicial INTEGER,
    pendentes_inicial INTEGER,

    -- --- insumos usados no cálculo (para auditar a previsão depois) ---
    equipe_prevista JSONB,          -- [{"id_operador":"12","nome":"...","ped_h":45.8}]
    volume_visivel INTEGER,         -- o que estava na fila na 1ª rodada
    volume_previsto INTEGER,        -- após aplicar o fator do dia da semana
    fator_aplicado NUMERIC(4,3),

    -- --- previsão VIVA: recalculada a cada coleta ---
    -- Fica em JSONB porque é o retrato completo do cálculo (baldes por
    -- prazo, p50/p90, janelas ociosas) e o formato ainda vai mudar
    -- enquanto o modelo se calibra. A meta acima é que NÃO se move.
    previsao_atual JSONB,
    previsao_atualizada_em TIMESTAMP WITH TIME ZONE,

    -- --- realizado (preenchido no fim do dia; é o que calibra o modelo) ---
    realizado_total INTEGER,
    realizado_hora_termino TIMESTAMP WITH TIME ZONE,

    atualizado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now())
);

COMMENT ON TABLE previsao_dia IS
'Meta congelada do dia (lida pela extensão dos operadores) + comparação previsto vs. realizado.';


-- ====================================================================
-- 4. config_previsao — parâmetros ajustáveis sem mexer em código
--
-- Mesma lógica da Meta Global (configuracoes_gerais): mudar horário de
-- turno ou fator semanal não pode exigir reinstalar extensão em cada
-- máquina. Linha única, id = 1.
-- ====================================================================
CREATE TABLE IF NOT EXISTS config_previsao (
    id SMALLINT PRIMARY KEY DEFAULT 1,

    inicio_turno TIME NOT NULL DEFAULT '07:40',
    fim_turno    TIME NOT NULL DEFAULT '17:40',
    almoco_inicio TIME NOT NULL DEFAULT '13:00',
    almoco_fim    TIME NOT NULL DEFAULT '14:00',

    -- ⚠️ Início do TURNO (7h40, quando a raspagem roda) ≠ início da
    -- PRODUÇÃO. Os operadores começam a separar por volta das 8h30.
    -- Simular a partir das 7h40 dava ~50 min de produção inexistente:
    -- com 3 pessoas a 35/h, uns 90 pedidos de otimismo.
    inicio_producao TIME NOT NULL DEFAULT '08:30',

    -- Equipe usada no cálculo. Padrão 3 mesmo quando há mais gente na
    -- bancada — erro para o lado seguro ("surpresa positiva é melhor que
    -- negativa"). SOBRESCREVER aqui em dia de volume alto: numa terça de
    -- 1.200+ pedidos, 3 pessoas não fecham o turno, e pôr 4 ou 5 faz o
    -- cálculo refletir a escala real. Mesmo padrão da Meta Global: muda no
    -- banco, sem reinstalar extensão em máquina nenhuma.
    equipe_padrao SMALLINT NOT NULL DEFAULT 3,
    ritmo_padrao NUMERIC(5,1) NOT NULL DEFAULT 35.0,   -- ped/h de fallback (meta já em uso, bem calibrada)

    -- Fator de projeção por dia da semana (0=domingo … 6=sábado).
    -- Ver CLAUDE.md Parte 3.6 — NÃO usar fator único, a variação é estrutural.
    fatores_dia_semana JSONB NOT NULL
        DEFAULT '{"1":1.000,"2":1.175,"3":1.431,"4":1.371,"5":1.360}'::jsonb,

    -- Distribuição da chegada da manhã, em fração do que ainda falta entrar.
    curva_chegada JSONB NOT NULL
        DEFAULT '{"8":0.13,"9":0.19,"10":0.22,"11":0.21,"12":0.20}'::jsonb,

    -- Piso do ritmo necessário. RESOLVIDO em 18/08/2026: 35/h, que é o
    -- ritmo que a operação exige do operador independentemente da carga.
    -- Sem piso, um dia leve derrubava o número para ~5/h e o painel virava
    -- licença para desacelerar. NULL desliga o piso (mostra a conta crua).
    piso_ritmo_necessario NUMERIC(5,1) DEFAULT 35,

    -- ⚠️ TRUE = ped_h_real já contém almoço e pausas (é `pedidos ÷ span do
    -- primeiro ao último bipe`, e esse span atravessa as 13h). Nesse caso a
    -- simulação NÃO pode parar no almoço: desconta duas vezes e infla o
    -- horário previsto em uma hora inteira. Só virar FALSE se um dia
    -- houver um ritmo "limpo", medido sem as pausas dentro.
    ritmo_inclui_pausas BOOLEAN NOT NULL DEFAULT true,

    -- Multiplicador do ritmo para a ponta pessimista da faixa (p90).
    -- A meta publicada usa o p90, não a mediana — "surpresa positiva é
    -- melhor que negativa" (CLAUDE.md Parte 5, decisão 12).
    fator_pessimista NUMERIC(3,2) NOT NULL DEFAULT 0.75,

    atualizado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT config_previsao_linha_unica CHECK (id = 1)
);

INSERT INTO config_previsao (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- ====================================================================
-- 5. familias_embalagem — família de SKU → peças por embalagem fechada
--
-- Conhecimento de negócio que NÃO dá para derivar do histórico e que
-- muda quando entram produtos novos. Ver CLAUDE.md Parte 2:
-- 100X-TOU-DESC é 1 pacote lacrado (barato); 50X-TOU-DESC obriga a
-- abrir e contar metade (caro) — o "menor" custa MAIS.
-- Baixa prioridade: esses SKUs têm volume pequeno hoje.
-- ====================================================================
CREATE TABLE IF NOT EXISTS familias_embalagem (
    familia VARCHAR(50) PRIMARY KEY,
    tamanho_embalagem INTEGER NOT NULL,
    observacao TEXT,
    atualizado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now())
);

INSERT INTO familias_embalagem (familia, tamanho_embalagem, observacao) VALUES
    ('TOU-DESC', 100, 'Toucas descartáveis — embalagem de 100'),
    ('AGULHA',   100, 'Embalagem de 100'),
    ('ATADURA',   12, 'Dúzia — 60X-ATADURA = 5 pacotes')
ON CONFLICT (familia) DO NOTHING;


-- ====================================================================
-- 5.1 ⚠️ A ÚNICA exceção à regra "não altera tabela existente"
--
-- pedidos_separados é da ../upseller-extension. Esta coluna é declarada lá
-- também (database.sql, seção 2.1) — repetida aqui para que rodar só este
-- script deixe o banco coerente. ADD COLUMN IF NOT EXISTS é idempotente,
-- então as duas declarações não brigam.
--
-- É ADITIVA e opcional: a extensão dos operadores e o dashboard não leem
-- esta coluna. Nada quebra em quem não for atualizado — as bipagens de
-- máquinas com a versão antiga simplesmente gravam NULL aqui.
--
-- Motivo: o rastreio só nasce no processamento, então pedido em "Para
-- Enviar" não tinha chave para casar com a bipagem. Ver CLAUDE.md 1.2b.
-- ====================================================================
ALTER TABLE pedidos_separados ADD COLUMN IF NOT EXISTS num_pedido VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_pedidos_num_pedido ON pedidos_separados (num_pedido);


-- ====================================================================
-- 6. Views — o modelo de união (CLAUDE.md Parte 1.2)
--
-- ⚠️ Nunca somar/subtrair CONTADORES do UpSeller. O contador de
-- "Para Imprimir" só baixa quando o operador clica em "Enviar" (envio
-- em lote), então ele atrasa em relação à extensão. Combinar os dois
-- números subtrai os mesmos pedidos duas vezes assim que o operador
-- clica — erro intermitente. Trabalhar com CONJUNTOS de nº de pedido.
--
-- security_invoker = true faz a view respeitar o RLS de quem consulta,
-- em vez do dono da view (exigido pelo Supabase; PG 15+).
-- ====================================================================

-- ⚠️ DROP antes de CREATE, de propósito.
--
-- CREATE OR REPLACE VIEW só permite ACRESCENTAR colunas no fim da lista.
-- Inserir uma coluna no meio (foi o caso de prazo_origem) faz o Postgres
-- entender que a coluna daquela posição está sendo renomeada, e ele recusa:
--   ERROR 42P16: cannot change name of view column "itens" to "prazo_origem"
--
-- View não guarda dado nenhum — é consulta salva. Derrubar e recriar é
-- seguro. A ordem importa: fila_pendente depende de fila_do_dia, então cai
-- primeiro. (DROP explícito em vez de CASCADE: CASCADE derrubaria também
-- qualquer coisa que alguém tenha criado por cima sem avisar.)
DROP VIEW IF EXISTS demanda_sku_dia;
DROP VIEW IF EXISTS fila_pendente;
DROP VIEW IF EXISTS fila_do_dia;

-- 6.1 fila_do_dia — a UNIÃO: cada pedido visto no dia, uma vez só,
-- com os dados da raspagem MAIS RECENTE em que ele apareceu.
--
-- Duas propriedades importantes caem daqui:
--   a) o prazo usado é sempre o mais recente (a Shopee muda prazo caso
--      a caso — CLAUDE.md 3.5 proíbe reutilizar prazo antigo);
--   b) um pedido que sumiu da tela porque o operador clicou em "Enviar"
--      CONTINUA no conjunto — ele existiu, faz parte da carga do dia.
CREATE OR REPLACE VIEW fila_do_dia
WITH (security_invoker = true) AS
SELECT DISTINCT ON (i.dia_operacional, i.num_pedido)
       i.dia_operacional,
       i.num_pedido,
       i.num_pedido_plataforma,
       i.codigo_rastreio,
       i.etapa            AS etapa_mais_recente,
       i.estado,                    -- rótulo da própria tela; usado para excluir cancelados
       i.loja,
       i.plataforma,
       i.logistica,
       i.pago_em,
       i.expira_em,
       i.prazo_origem,
       i.itens,
       s.raspado_em       AS visto_pela_ultima_vez_em
FROM fila_snapshot_itens i
JOIN fila_snapshots s ON s.id = i.snapshot_id
WHERE s.status IN ('ok', 'incompleto')
ORDER BY i.dia_operacional, i.num_pedido, s.raspado_em DESC;

COMMENT ON VIEW fila_do_dia IS
'União dos pedidos vistos no dia (1 linha por pedido, dados da raspagem mais recente). Denominador da previsão.';


-- 6.2 fila_pendente — o que ainda falta separar: DIFERENÇA de conjuntos.
--
-- Um pedido sem codigo_rastreio ainda está em Para Emitir/Para Enviar,
-- portanto não pode ter sido bipado — conta como pendente.
CREATE OR REPLACE VIEW fila_pendente
WITH (security_invoker = true) AS
SELECT f.*
FROM fila_do_dia f
-- A sub-aba "Todos" de "Para Imprimir" inclui os CANCELADOS, que não são
-- trabalho de bancada. Filtro defensivo: nenhum estado legítimo contém
-- "cancel".
-- ⚠️ NÃO VERIFICADO — não houve pedido cancelado em nenhuma raspagem até
-- 17/08/2026 (a sub-aba "Cancelado" marcava 0). Conferir o texto real da
-- coluna Estado quando aparecer o primeiro.
WHERE COALESCE(f.estado, '') NOT ILIKE '%cancel%'
  -- ⚠️ DUAS chaves, não uma. O rastreio só existe a partir de "Para
  -- Imprimir"; pedido visto apenas em "Para Enviar" só casa pelo nº do
  -- pedido. Com uma chave só, 56 de 102 bipagens não casavam e a fila
  -- pendente ficava inflada o dia inteiro (CLAUDE.md 1.2b).
  --
  -- Enquanto houver máquina de operador com a extensão antiga,
  -- p.num_pedido virá NULL nas bipagens dela e só o rastreio casará —
  -- degrada para o comportamento anterior, não quebra.
  AND NOT EXISTS (
      SELECT 1
      FROM pedidos_separados p
      WHERE (f.codigo_rastreio IS NOT NULL AND p.codigo_rastreio = f.codigo_rastreio)
         OR (f.num_pedido      IS NOT NULL AND p.num_pedido      = f.num_pedido)
  );

COMMENT ON VIEW fila_pendente IS
'Pedidos do dia ainda não bipados pela extensão. Diferença de conjuntos, nunca subtração de contadores.';


-- 6.3 demanda_sku_dia — quanto de cada SKU sai hoje.
--
-- Responde uma pergunta que o UpSeller não responde de forma organizada:
-- "qual será a baixa de estoque do dia, por produto?". Saber isso às 7h40
-- permite descobrir desabastecimento ANTES do turno, e não no meio dele
-- com o operador parado na frente da prateleira.
--
-- Sai de graça: o `itens` JSONB já é capturado por pedido desde a primeira
-- versão do parser, no mesmo formato de pedidos_separados.itens.
--
-- ⚠️ DUAS MEDIDAS DIFERENTES, de propósito:
--
--   unidades_anuncio — quantas vezes o item foi comprado (o "× 2" da tela)
--   pecas            — quantas peças físicas saem do estoque
--
-- A diferença é o prefixo NX- do SKU: `3X-LEN-ECO-70X50` com quantidade 1
-- é UM anúncio mas TRÊS peças. Para reposição de estoque vale `pecas`.
--
-- Só o prefixo no INÍCIO do SKU é multiplicador. `1X-500-PAP-INTER` é
-- 1 pacote de 500 folhas (o 500 é o produto), e `3X-LEN-ECO-50X50` tem
-- multiplicador 3 com 50X50 de tamanho. Ver CLAUDE.md Parte 2.
--
-- ⚠️ `pecas` NÃO é o custo de separação. `100X-TOU-DESC` são 100 peças mas
-- UMA ação (pacote lacrado), enquanto `50X-TOU-DESC` obriga a abrir e
-- contar — mais caro que o de 100. Esforço depende de familias_embalagem;
-- esta view é sobre ESTOQUE, não sobre tempo.
CREATE OR REPLACE VIEW demanda_sku_dia
WITH (security_invoker = true) AS
SELECT
    f.dia_operacional,
    item->>'sku' AS sku,
    CASE
        WHEN f.expira_em IS NULL THEN 'sem prazo'
        WHEN (f.expira_em AT TIME ZONE 'America/Sao_Paulo')::date <  f.dia_operacional     THEN 'atrasado'
        WHEN (f.expira_em AT TIME ZONE 'America/Sao_Paulo')::date =  f.dia_operacional     THEN 'hoje'
        WHEN (f.expira_em AT TIME ZONE 'America/Sao_Paulo')::date =  f.dia_operacional + 1 THEN 'amanha'
        ELSE 'depois'
    END AS prazo,
    count(*) AS pedidos,
    sum((item->>'quantidade')::int) AS unidades_anuncio,
    sum(
        (item->>'quantidade')::int
        * COALESCE(NULLIF(substring(item->>'sku' FROM '^(\d+)X-'), '')::int, 1)
    ) AS pecas
FROM fila_do_dia f
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(f.itens, '[]'::jsonb)) AS item
WHERE COALESCE(f.estado, '') NOT ILIKE '%cancel%'
GROUP BY 1, 2, 3;

COMMENT ON VIEW demanda_sku_dia IS
'Demanda de estoque por SKU e prazo. pecas = quantidade × multiplicador NX- do SKU; não confundir com custo de separação.';


-- ====================================================================
-- 7. Row Level Security
--
-- Mesmo padrão do database.sql da extensão: cada tabela liberada só
-- para as operações que os apps de fato usam.
-- ====================================================================

-- 7.1 Snapshots: append-only (histórico de raspagem nunca é editado).
ALTER TABLE fila_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_fila_snapshots" ON fila_snapshots;
CREATE POLICY "anon_select_fila_snapshots" ON fila_snapshots FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_fila_snapshots" ON fila_snapshots;
CREATE POLICY "anon_insert_fila_snapshots" ON fila_snapshots FOR INSERT TO anon WITH CHECK (true);

ALTER TABLE fila_snapshot_itens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_fila_itens" ON fila_snapshot_itens;
CREATE POLICY "anon_select_fila_itens" ON fila_snapshot_itens FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_fila_itens" ON fila_snapshot_itens;
CREATE POLICY "anon_insert_fila_itens" ON fila_snapshot_itens FOR INSERT TO anon WITH CHECK (true);

-- 7.2 previsao_dia: precisa de UPDATE — o gestor republica a meta e o
-- realizado é preenchido no fim do dia.
ALTER TABLE previsao_dia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_previsao_dia" ON previsao_dia;
CREATE POLICY "anon_select_previsao_dia" ON previsao_dia FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_previsao_dia" ON previsao_dia;
CREATE POLICY "anon_insert_previsao_dia" ON previsao_dia FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_previsao_dia" ON previsao_dia;
CREATE POLICY "anon_update_previsao_dia" ON previsao_dia FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- 7.3 config_previsao: linha única fixa — só leitura e atualização.
ALTER TABLE config_previsao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_config_previsao" ON config_previsao;
CREATE POLICY "anon_select_config_previsao" ON config_previsao FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_update_config_previsao" ON config_previsao;
CREATE POLICY "anon_update_config_previsao" ON config_previsao FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- 7.4 familias_embalagem: CRUD completo (editável no dashboard).
ALTER TABLE familias_embalagem ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_familias" ON familias_embalagem;
CREATE POLICY "anon_select_familias" ON familias_embalagem FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_familias" ON familias_embalagem;
CREATE POLICY "anon_insert_familias" ON familias_embalagem FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_familias" ON familias_embalagem;
CREATE POLICY "anon_update_familias" ON familias_embalagem FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_familias" ON familias_embalagem;
CREATE POLICY "anon_delete_familias" ON familias_embalagem FOR DELETE TO anon USING (true);

-- 7.5 Views herdam o RLS das tabelas de origem (security_invoker),
-- mas precisam de GRANT próprio.
GRANT SELECT ON fila_do_dia     TO anon;
GRANT SELECT ON fila_pendente   TO anon;
GRANT SELECT ON demanda_sku_dia TO anon;


-- ====================================================================
-- 8. Retenção (executar manualmente de vez em quando, ou agendar)
--
-- Raspando de hora em hora, ~1.250 pedidos × 3 etapas × 10 rodadas dá
-- algo como 12 mil linhas/dia em fila_snapshot_itens. Não atrapalha as
-- consultas da extensão (tabelas separadas, com índice), mas cresce.
--
-- O que importa a longo prazo é previsao_dia (previsto vs. realizado),
-- que é minúscula e deve ser guardada para sempre. O detalhe do
-- snapshot só serve para diagnóstico recente.
--
-- ⚠️ O DELETE abaixo está comentado de propósito: a RLS bloqueia DELETE
-- via anon key, então ele só roda no SQL Editor, conscientemente.
-- ====================================================================
-- DELETE FROM fila_snapshots WHERE dia_operacional < current_date - INTERVAL '90 days';
-- (fila_snapshot_itens sai junto por ON DELETE CASCADE)
