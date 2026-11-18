# dsh-reference-session-collector (DRSC)

**Sincronizador de projeção de referências de sessão** — um plugin do DeepSeek Harness (DSH).

Lê os logs de sessão em `~/.dsh/sessions` (**somente leitura**) e os decodifica num
único **repositório de projeção** SQLite compartilhado: texto original indexado por
`sessão × turno/passo × seq`, comprimentos de token pelo vocabulário DeepSeek,
marcadores de substituição da superfície CCI, ponteiros de resgate e um índice de
texto completo FTS5 — para que compressão de contexto (cci), o mordomo de sessão e
a memória-prima leiam todos a mesma projeção em vez de cada um decodificar os logs
por conta própria.

> Nomeação: `dsh-reference-session-collector` se abrevia **DRSC** — as iniciais de
> dsh-**R**eference-**S**ession-**C**ollector.

## Estado

**Entregue (v0.1.0)**: a metade host inteira — núcleo de projeção puro, repositório
de projeção SQLite (node:sqlite, FTS5), motor de sincronização incremental
(pré-checagem de watermark, acompanhamento de conjuntos arquivados, agendamento por
intervalo), superfície de consultas com cache de 3 camadas e a rota HTTP cercada. A
cadeia de portões `pnpm check` está verde (9 suítes / 66 testes) mais o smoke de dist
(`pnpm smoke`). **Restante**: ligação dos consumidores (fase 1 reconciliação CCI,
fase 2 virada de corpus do mordomo, fase 3 de preenchimento de âncoras de memória) e o benchmark
de eficiência (T9.1). A tabela de rotas e o schema do repositório abaixo estão
finalizados.

## Arquitetura

```
~/.dsh/sessions/** (read-only) ──→ ProjectionSync (incremental, watermark)
                                   │ projectSessionEvents (pure core)
                                   ▼
       projection.db (~/.dsh-reference-session-collector/, 4 tables + fts5, 3-layer cache)
                                   │
           ┌───────────────────────┼────────────────────┐
 /api/dsh-reference-session-collector     cci (phase 1)     steward (2) / memory (3)
 (status/surface/recall/…)      savings/recheck   corpus / history backfill
```

- **Repositório**: `sessions` (watermark + agregados) / `segments` (texto original ×
  turno/passo × tokens × marcador de superfície × vista de busca) / `replaces`
  (ponteiros de par de substituição, a/b/kind) + `segments_fts` (bm25 sobre texto
  segmentado por palavras com Intl.Segmenter('zh') numa tabela unicode61).
- **Auxílios ao CCI**: reconhecimento de marcadores de superfície (o que está na
  superfície agora e o que a substituiu) + estatísticas de ponteiros de resgate na
  superfície (pares de substituição com b>a são releituras; Σb responde diretamente
  pela economia negativa).
- **Três camadas de cache**: mmap/WAL do SQLite sempre ligados; agregados de sessões
  residentes em memória; livro-razão por sessão em LRU indexado pela geração de sync.

## Rota HTTP

Uma única rota cercada, despacho por op:

| op | parâmetros | devolve |
|---|---|---|
| `status` (padrão) | — | estado de repositório/cache/sync |
| `sessions` | `limit` `offset` | resumos de sessão paginados |
| `session` | `id`, faixa opcional `turn=`, `fields=search` opcional | detalhe da projeção da sessão |
| `surface` | `id` | livro-razão de marcadores de superfície |
| `recall` | `id` | pares de resgate + Σb (estatísticas de economia negativa, ponteiros de faixa) |
| `search` | `q`, `limit`, `session?` | acertos fts5 (com suporte a CJK) |
| `sync` (POST) | — | dispara a sync incremental; devolve accepted + lastResult |

Sem o serviço webServer o plugin continua sincronizando; falta apenas a face HTTP
(falha suave).

## Disciplina de somente leitura

`readFileSync` é a **única** chamada que este plugin faz contra os arquivos de sessão,
e não tem contraparte de escrita — nunca. O plugin só escreve em
`~/.dsh-reference-session-collector/projection.db`. Esse banco guarda **texto original
não sanitizado**; expô-lo equivale a expor os próprios arquivos de sessão. Qualquer
exigência de «corpus sanitizado» pertence aos consumidores, não ao DRSC.

## Configuração (v0)

Ainda sem superfície de ajustes (chega com a ligação da fase 2). Variáveis de ambiente:

| variável | padrão | significado |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | raiz dos logs de sessão |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | diretório do db de projeção |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | intervalo de sync; `0` = só manual |

## Roteiro

1. **Fase 1 · reconciliação cci**: monitor/verificação ganha uma coluna de resgate
   DRSC — alegações vs fórmula vs projeção, contabilização em três colunas (HTTP de
   somente leitura).
2. **Fase 2 · virada de corpus do mordomo**: o motor de busca embutido do mordomo lê
   o DRSC (segments.time/on_surface/search_text + last_time_ms/archived cobrem toda
   a sua face de acertos; mapeamento de campos em
   `.agents/plans/drs-start/findings.md`).
3. **Fase 3 · projeção histórica para a memória (somente leitura)**: o caminho de
   escrita l0 **não** se move (sanitização/redação/propriedade de record_id ficam no
   lado de captura da memória; é semanticamente incompatível com reescrita de sessão
   inteira). O DRSC só serve ao preenchimento de âncoras históricas e corpus. A camada vetorial
   (BGE-M3 int8) é um lote opcional à parte.

## Desenvolvimento

```bash
pnpm install
pnpm check       # typecheck → lint → test → build → smoke (uma cadeia)
```

Plano e progresso: `.agents/plans/drs-start/` (spec / findings / checklist /
tasks).

## License

MIT
