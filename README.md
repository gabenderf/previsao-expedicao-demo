# Motor de previsão da expedição

> **Cópia pública de demonstração.** O código é o mesmo do sistema em uso na expedição da Hope Cirúrgica, publicado para consulta. Ficaram de fora a documentação interna de operação e segurança e qualquer dado real: nenhuma URL ou chave de banco acompanha o repositório, e os dados de exemplo são fictícios. Veja o sistema rodando em modo demonstração no [portfólio](https://gabeand.ia.br).

Responde à pergunta que a liderança faz todo dia: a que horas a fila obrigatória acaba, e sobra
gente para outro setor? O motor simula a fila em passos de 5 minutos, com as chegadas repartidas por
uma curva horária calibrada com 15.000 pedidos reais, e devolve o término, o ritmo necessário e as
janelas ociosas.

## Arquivos

| Arquivo | O que é |
|---|---|
| `motor/previsao.js` | O motor: função pura, sem relógio implícito, rede nem DOM (o instante entra por parâmetro). É copiado sem edição para o coletor e para o painel. |
| `motor/prazo.js` | Regras de prazo de envio (o que precisa sair hoje). |
| `motor/parser.js` | Leitura das telas de fila do UpSeller. |
| `motor/parser.test.html` | Testes do parser no navegador. As páginas salvas do UpSeller que ele usa como fixture não vão para o repositório, porque têm pedidos reais. |
| `motor/servidor-fixture.js` | Servidor estático mínimo para rodar os testes do parser. |
| `schema.sql` | Tabelas e views no Supabase: snapshots da fila, fila do dia e fila pendente por diferença de conjuntos. |

Quem roda o motor em produção é o [coletor da fila](https://github.com/gabenderf/coletor-fila-demo),
e o [Hope SaaS](https://github.com/gabenderf/hope-saas-demo) recalcula a previsão viva com a mesma função.
