# SenAI CRM Intelligence Platform

An enterprise-grade, AI-powered Customer Relationship Management (CRM) system that autonomously monitors a high-volume simulated email inbox, triages emails using multi-dimensional intelligence (Fast Heuristics, RAG vector embeddings, and LLM classifiers), executes autonomous agentic workflows via a ReAct reasoning loop, and visualizes insights in a premium dark-mode Single-Page Application (SPA) dashboard.

---

## 🛠 System Architecture

The diagram below represents the end-to-end data lifecycle: from real-time ingestion, synchronous heuristic filtering, queue dispatching, RAG context retrieval, Gemini LLM classification, the ReAct triage agent loop, database persistence, and real-time frontend visualization.

```mermaid
graph TD
    Client[Email Stream / Ingestion Client] -->|POST /api/ingest| IngestRoute[FastAPI /api/ingest Route]
    IngestRoute -->|1. Validate & Normalize| Normalizer[Normalization Service]
    Normalizer -->|2. Fast Heuristics <10ms| Heuristic[Heuristic Pre-filter]
    Heuristic -->|Spam / Internal| DB_Emails[(PostgreSQL - emails)]
    Heuristic -->|Valid Email| QueueJob[Create Processing Job]
    QueueJob -->|3. Dispatch Job| Dispatcher[Job Dispatcher]
    
    Dispatcher -->|celery=true| Celery[Celery Worker]
    Dispatcher -->|celery=false| Thread[Local Background Thread]
    
    Celery & Thread -->|4. Execute Task| Task[Triage & Classification Task]
    
    Task -->|5. Run Classification| ClassifyService[Classification Service]
    ClassifyService -->|6. Get Thread History| DB_Emails
    ClassifyService -->|7. Vector Query| VectorDB[(pgvector - knowledge_chunks)]
    ClassifyService -->|8. Scrape Brand Signals| Scraper[Web Reputation Scraper]
    Scraper -->|Read/Write Rating Cache| DB_Cache[(PostgreSQL - web_intelligence_cache)]
    
    ClassifyService & VectorDB & Scraper -->|9. Formulate Prompt| LLM[Gemini LLM API]
    LLM -->|10. Parse & Normalize Result| ClassifyService
    ClassifyService -->|11. Run ReAct Agent Loop| AgentService[Triage Agent Service]
    AgentService -->|12. Call Tools / Make Decision| AgentService
    AgentService -->|13. Persist Actions & Logs| DB_Actions[(PostgreSQL - actions)]
    
    DB_Emails & DB_Actions -->|14. Poll Feed / Stats / Trends| DashboardUI[Vanilla HTML5/CSS/JS Dashboard]
    DashboardUI -->|15. Approve/Edit Drafts & Manual Respond| API_CRM[CRM Routing Endpoints]
    API_CRM -->|16. Execute / Log Audits| DB_Audit[(PostgreSQL - audit_log)]
```

---

## 📂 Project Structure

```text
Dummy-SenAI/
├── backend/
│   ├── app/
│   │   ├── api/             # API Router endpoints (ingest, crm, intelligence, health)
│   │   ├── core/            # App configurations, middlewares, custom exception handlers
│   │   ├── db/              # SQLAlchemy session setup, models, and metadata
│   │   ├── schemas/         # Pydantic models for request validation and response formatting
│   │   ├── services/        # Business logic services (RAG search, Agent ReAct loop, Web Scraper)
│   │   └── workers/         # Celery task definitions and Celery app initialization
│   ├── database_schema.sql  # PostgreSQL initialization tables & pgvector schemas
│   ├── Dockerfile           # Backend API and Worker container configuration
│   ├── config.py            # Backend settings loaders
│   ├── processor.py         # Sync fallback orchestration utilities
│   ├── requirements.txt     # Python backend dependencies
│   └── scripts/             # Python DB seeding and setup scripts
├── frontend/
│   ├── index.html           # Dashboard layout
│   ├── index.css            # Dark mode design styles
│   └── app.js               # Dashboard controller and backend communicator
├── knowledge_base/          # Source markdown files for the RAG vector store
├── docker-compose.yml       # Orchestrates PostgreSQL + pgvector, Redis, FastAPI, and Celery
└── openapi.json             # Static OpenAPI Swagger spec for the backend API
```

---

## 🚀 Quick Start Guide

### Option A: Running with Docker Compose (Recommended)

To run the entire platform (PostgreSQL database, Redis queue, FastAPI application serving the frontend, and Celery background workers) in a single command:

1. **Clone the repository** and navigate to the project root.
2. **Create a `.env` file** inside the `backend` folder (or set the environment variables on your host) specifying your Gemini API credentials:
   ```env
   GEMINI_API_KEY=your_actual_gemini_api_key
   ```
3. **Launch Docker Compose**:
   ```bash
   docker compose up --build -d
   ```
   *This builds the FastAPI backend and Celery container, pulls PGVector and Redis, runs migrations, and serves the dashboard.*
4. **Access the Dashboard**: Open your browser and navigate to `http://localhost:8000/`.
5. **Seed the Knowledge Base**: Seed internal policies into the Vector DB:
   ```bash
   docker exec -it senai-api python scripts/seed_kb.py
   ```
6. **Simulate the Email Stream**: Replay the assessment dataset:
   ```bash
   docker exec -it senai-api python ../scripts/simulate_stream.py --speed 1
   ```

---

### Option B: Local Manual Setup

If you prefer to run the components natively on your machine:

#### 1. Database Setup
Ensure you have a PostgreSQL server running with the `pgvector` extension installed. Create a database named `crm_ai`.
Apply the schema:
```bash
psql -U postgres -d crm_ai -f backend/database_schema.sql
```

#### 2. Install Dependencies
Initialize a Python 3.11 virtual environment inside the `backend` directory:
```bash
cd backend
python -m venv venv
venv\Scripts\activate      # On Linux/macOS: source venv/bin/activate
pip install -r requirements.txt
```

#### 3. Configuration
Copy the `.env.example` file and fill in your details:
```bash
copy .env.example .env
```
Ensure your `DATABASE_URL` is set correctly:
```env
DATABASE_URL=postgresql+psycopg2://postgres:YOUR_PASSWORD@localhost:5432/crm_ai
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
ENABLE_CELERY_DISPATCH=false  # Sets automatic local background thread fallback if you don't run Redis
```

#### 4. Seed Knowledge Base
Run the seeding script to parse markdown policy files, calculate embeddings, and load them:
```bash
python scripts/seed_kb.py
```

#### 5. Start the Server
Start the FastAPI server reloading in development:
```bash
uvicorn app.main:app --reload
```
The application will serve:
*   **Web UI Dashboard** at `http://localhost:8000/`
*   **Swagger Docs** at `http://localhost:8000/docs`

#### 6. Run Email Simulation
Open another terminal, activate the environment, and replay the dataset:
```bash
python ../scripts/simulate_stream.py --speed 1
```

---

## ⚡ Core Features & Special Scenarios

The platform handles critical edge-case customer support scenarios as mandated in the specification:

### 1. GDPR Data Portability (msg_052)
*   **Heuristics Detection**: Synchronously flags keywords like "GDPR", "Article 20", "DPA", "portability".
*   **Agent Decision**: Flags the thread for legal reviews (`flag_for_legal()`), generates a statutory 30-day window auto-acknowledgement reply, and creates an internal compliance ticket. It is never auto-replied with general FAQ responses.

### 2. Ransomware Threat (msg_038)
*   **Heuristics Safeguard**: Flags suspicious security alerts and routing terms ("ransomware", "BTC", "publish data") instantly as `Critical` urgency and a security threat.
*   **Agent Action**: Blocks auto-replies, alerts the security queue, and escalates to human operations with high priority.

### 3. Misinformation by Chatbot (msg_056)
*   **Contextual RAG Retrieval**: When the customer complains about wrong advice given by our chatbot, the RAG pipeline retrieves the actual `refund_policy.md`, `escalation_matrix.md` and pricing matrix.
*   **Agent Response**: Recognizes the discrepancy, drafts an empathetic holding email citing the actual policy parameters without accepting legal liability, and escalates to human management.

### 4. Reputation Crisis (msg_033)
*   **Sentiment Trend Trigger**: Tracks sentiment scores dynamically per sender. When Karen's thread reaches 3+ consecutive negative emails without replies, it triggers a reputation alert.
*   **Enrichment**: The web scraper actively pulls public sentiment scores from G2 and Trustpilot, caching them for 6 hours (gracefully falling back to cached ratings if blocked).
*   **Agent Action**: Pre-fills an escalation brief citing the public ratings and suggests a high-priority retention discount based on the refund/retention playbook.

### 5. Billing Negotiation (alice.smith)
*   **Thread-History Grounding**: Reads the full 5-turn thread history to follow her journey from standard tiers, discounts, to upgrade. When handling her billing inquiry, it applies specific non-profit rates from `pricing_policy.md` instead of generic prices.

---

## 🧠 Architectural Decisions & Trade-offs

*   **PGVector Sequential Scan Force**: We programmatically execute `SET local enable_indexscan = off;` inside the similarity search query block. For datasets under 1,000 rows, approximate nearest neighbor index styles (like IVF-Flat or HNSW) prune pages, leading to recall inaccuracies. This ensures 100% vector accuracy in sub-10ms.
*   **Local Thread-Based Fallback**: Recognizing that running Redis and Celery adds operational complexity for local development or lightweight servers, the API automatically runs tasks in a background thread if `ENABLE_CELERY_DISPATCH=false` is set, allowing full asynchronous ingestion, classification, and agent execution in a single Python process.
*   **Vanilla CSS Glassmorphic SPA**: Avoided Tailwind CSS or bulky React frameworks, delivering a highly responsive, animated, dark-mode single-page UI built on pure HTML5, vanilla CSS Variables, and modular Javascript. Chart.js powers live sentiment analytics.
*   **Auditing and ID Idempotency**: Implements full database idempotency using database constraints on `emails.message_id` and records detailed audits of entity state modifications (diffs, performed by labels) inside the `audit_log` table.

---

## ⚠️ Known Limitations & Assumptions

*   **Mock Web Scraper Fallback**: If scrapers are blocked by CAPTCHAs or rate-limiting on Trustpilot or G2, they degrade gracefully to servingcached mock sentiment scores so agent loops do not crash.
*   **SentenceTransformer Model size**: Uses `sentence-transformers/all-MiniLM-L6-v2` locally which yields high-performance 384-dimensional vectors. It downloads the weights on the first run; subsequent runs run entirely offline.
*   **LLM API Safeguards**: If the Gemini connection drops or times out during agent processing, the system catches the exception, rolls back database sessions safely, and falls back to deterministic keyword-based heuristics to classify and route the email without losing track of the ingestion job.
