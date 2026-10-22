# dsh-reference-session-collector (DRSC) — синхронизатор проекции сессий

**Плагин DeepSeek Harness (DSH)**: сканирует **только на чтение** журналы
сессий в `~/.dsh/sessions/**`, декодирует их и проецирует в собственную
SQLite-проекцию (segments / replaces / FTS5). Одна защищённая HTTP-маршрут
`GET/POST /api/dsh-reference-session-collector` предоставляет пометки поверхности,
сверку вызовов (recall) и полнотекстовый поиск с поддержкой китайского.
**Никогда не записывает в файлы сессий.**

## Статус

**Поставлено (v0.1.0)**: хостовая половина полностью — чистое ядро
проекции, хранилище SQLite (node:sqlite / FTS5), инкрементальный движок
синхронизации (предпроверка watermark, отслеживание архива, interval-планировщик),
слой запросов с трёхуровневым кэшем, защищённый HTTP-маршрут. Цепочка
гейтов `pnpm check` полностью зелёная (9 наборов / 66 тестов + dist-смоук).
**Осталось**: подключение потребителей (фаза 1 — сверка CCI, фаза 2 —
переключение корпуса steward, фаза 3 — дозаполнение якорей memory) и
бенчмарк эффективности T9.1.

## Архитектура

```
~/.dsh/sessions/** (только чтение) ──→ ProjectionSync (инкрементально, watermark=bytes+mtime)
                                   │ projectSessionEvents (чистое ядро)
                                   ▼
        ~/.dsh-reference-session-collector/projection.db (4 таблицы + fts5 + 3 уровня кэша)
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session-collector     CCI (фаза 1)   steward (2) / memory (3)
```

## Таблица HTTP-маршрутов

| op | параметры | возвращает |
|---|---|---|
| `status` | — | самодиагностика хранилища + статистика кэша + последний sync |
| `sessions` | `offset/limit` | сводка сессий (резидентная Map, 0 SQL) |
| `session` | `session=<id>`, опц. `turn=` / `fields=search` | детали segments (поля поиска) |
| `surface` | `session=<id>` | реестр поверхности (текущая + указатели замен) |
| `recall` | `session=<id>` | классификация пар замен (Σb / Σ(a−b)) |
| `search` | `q=<запрос>`, опц. `session=` | FTS5 BM25 (одинаковая сегментация zh/en) |
| `sync` (POST) | `{op:'sync'}` | accepted + последний результат |

## Дисциплина «только чтение»

- файлы сессий и `workspace.json` — всегда только чтение;
- все записи плагина идут исключительно в
  `~/.dsh-reference-session-collector/projection.db`;
- полная перезапись-замена на сессию (DELETE+INSERT в транзакции), идемпотентно;
- **ответственность за обезличивание не на DRSC**: хранится исходный текст,
  площадь утечки = сами файлы сессий.

## Переменные окружения

| переменная | по умолчанию | значение |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | корень журналов сессий |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | каталог БД проекции |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | интервал sync; `0` = только вручную |

## Установка / разработка

```
dsh plugin --profile web add dsh-reference-session-collector
pnpm install && pnpm check   # typecheck→lint→test→build→smoke
```

Требуется Node ≥ 22 (`zlib.zstdDecompressSync` + `node:sqlite`).

## Лицензия

MIT
