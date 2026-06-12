# Backend

This backend starts with the ingestion milestone from the SenAI technical assessment.
It follows the existing `database_schema.sql` as the database contract and keeps
ingestion-specific metadata in existing JSONB columns instead of creating parallel
tables.

## Current scope

- `POST /api/ingest` accepts one email payload.
- The payload is validated, normalized, deduplicated by `message_id`, linked to a
  contact and thread, scored with fast heuristics, stored in PostgreSQL, and tracked
  with a `processing_jobs` row.
- Background jobs now run Layer 2 LLM classification and Layer 3 autonomous triage.
- `POST /api/classify/{email_id}` classifies an ingested email with thread history,
  knowledge-base snippets, structured JSON output, policy citations, and sentiment
  trend refresh.
- `POST /api/agent/run/{email_id}` persists an agent action and Thought/Action/
  Observation trace. `POST /api/agent/dry-run/{email_id}` returns the same reasoning
  without writing an action.
- `GET /api/analytics/sentiment-trend` returns daily and moving-average sentiment
  points for dashboards.
- `GET /api/results/actions` lists persisted agent decisions for a dashboard/API
  result view.
- `GET /api/status/{job_id}` returns processing job state.
- `GET /health` checks that the API process is alive.
- `GET /api/health` checks application and database availability.
- `scripts/simulate_stream.py` replays `email-data-advanced.json` into the API at a
  configurable speed.
- Full phase documentation: [`docs/phase-01-ingestion-pipeline.md`](docs/phase-01-ingestion-pipeline.md).

## Setup

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Create the database and apply the existing SQL schema:

```bash
psql -U postgres -d crm_ai -f database_schema.sql
```

If `psql` is not available, use the Python helper after configuring `.env`:

```bash
python scripts/apply_schema.py
```

Or start PostgreSQL and Redis with Docker Compose from the repository root:

```bash
docker compose up -d postgres redis
```

Run the API:

```bash
uvicorn app.main:app --reload
```

Run the worker when Redis is available:

```bash
celery -A app.workers.celery_app.celery_app worker --loglevel=info
```

Optional Gemini configuration:

```bash
set GEMINI_API_KEY=your_key_here
set GEMINI_MODEL=gemini-1.5-flash
```

If `GEMINI_API_KEY` is not configured, the classifier uses a deterministic local
fallback so ingestion, sentiment analytics, and the agent can still be tested.

Replay the dataset:

```bash
python ..\scripts\simulate_stream.py --speed 1
python ..\scripts\simulate_stream.py --speed 10 --limit 20
```

## Ingestion contract

Required fields:

- `message_id`
- `sender`
- `subject`
- `body`
- `timestamp`
- `thread_id`

`subject` and `body` may be empty strings. Missing fields, malformed timestamps,
invalid email addresses, oversized payloads, and malformed JSON return the standard
error envelope:

```json
{
  "error_code": "VALIDATION_ERROR",
  "message": "Invalid request payload",
  "details": {}
}
```

## Design notes

- Idempotency uses the existing unique constraint on `emails.message_id`.
- Initial triage maps to existing columns: `emails.category`, `emails.urgency`,
  `emails.requires_human`, flag columns, and `threads.priority`.
- Numeric priority score, reasons, normalization warnings, and basic entity hints are
  stored in `emails.raw_entities.ingestion`.
- The API commits ingestion before attempting Celery dispatch. If Redis is down, the
  job stays in `Pending` with dispatch metadata so the email is not lost.
- Layer 2 prompt context includes the full thread history available in the database,
  RAG chunks from `knowledge_chunks`, and a strict JSON schema:
  `category`, `sentiment`, `sentiment_score`, `urgency`, `requires_human`,
  `escalation_reason`, `suggested_reply`, `confidence`, `detected_entities`, and
  `policy_citations`.
- Conflict handling strategy: security/legal signals override positive or neutral
  tone; explicit urgency and deadlines override soft category matches; confidence
  below `0.70` always routes to human review; three consecutive negative messages
  from the same sender raise an escalation alert.
- Layer 3 exposes these tools: `search_knowledge_base`, `get_thread_history`,
  `get_contact_profile`, `check_account_status`, `draft_reply`,
  `escalate_to_human`, `create_internal_ticket`, and `flag_for_legal`.
- The agent stores a Thought -> Action -> Observation trace in `actions.agent_reasoning_log`,
  caps itself at six tool calls, and never creates an auto-reply for `Critical`
  urgency.
