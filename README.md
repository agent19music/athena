# Athena

AI knowledge assistant for professional teams. Staff ask a question in plain language and get an answer from their organisation’s own documents and forms, with the source cited. If the material does not cover it, Athena says so.

**Live:** [athena.uzskicorp.agency](https://athena.uzskicorp.agency)  
**App:** [app.athena.uzskicorp.agency](https://app.athena.uzskicorp.agency)

Built by [Uzski Corp](https://uzskicorp.agency), Nairobi.

---

## How it works

1. An admin signs up, creates an organisation, and connects sources: Notion, Tally, public Google Docs, and file uploads.
2. Ingest splits those into chunks, embeds them with Gemini, and stores them in Postgres (pgvector), scoped to that organisation.
3. A teammate asks in chat. Athena answers from those chunks and names the source.
4. A survey question returns the overall tone and the top issues. That briefing uses a model on NVIDIA Brev when it is configured, and Gemini when it is not.
5. Below the similarity cutoff, Athena does not invent an answer.

---

## Stack

| Layer | Choice |
|---|---|
| Marketing + app | Next.js 16, React, TypeScript |
| Sign-in | Clerk |
| Billing | Paddle (per seat) |
| Backend | FastAPI, Python |
| Embeddings | Gemini `gemini-embedding-2` (768 dimensions) |
| Document answers | Gemini `gemini-2.5-flash`, with `gemini-2.5-flash-lite` if the primary is rate-limited |
| Survey tone and briefing | Qwen on NVIDIA Brev when configured; otherwise Gemini |
| Vector store | PostgreSQL 16 + pgvector |
| Chunking | LangChain header split, then a character splitter |
| API host | Render (Docker). Database is Render Postgres |
| Errors | Sentry, with a Discord alert |

---

## Project structure

```
noc-ava/
├── apps/
│   ├── app/                 # Product (chat, admin, billing)
│   └── marketing/           # athena.uzskicorp.agency
├── backend/                 # FastAPI API (Render root)
├── docker-compose.yml       # Local Postgres + backend
├── AGENTS.md                # How to run and deploy
└── .github/workflows/
    └── deploy-backend.yml   # Push to main deploys the API to Render
```

---

## Local development

Backend runs in Docker. Do not install Python packages on the host.

```bash
pnpm install
docker compose up --build backend
pnpm dev:app
```

The app is at [http://localhost:3001](http://localhost:3001). Marketing is `pnpm dev:marketing` on port 3000.

Copy `backend/.env.example` to `backend/.env` and set `GEMINI_API_KEY`. Compose points the container at its own Postgres. After Python or dependency changes, rebuild the backend image.

Deploy and production env vars are in `AGENTS.md`.

---

## Sources

- **Public Google Docs** — “anyone with the link” docs, per organisation. No Google review.
- **Notion and Tally** — connected per organisation and ingested on sync.
- **Uploads** — text, Markdown, PDF, Word, HTML, and CSV.
- **Google Drive folder sync** — written, not the live path. An admin share with a service account is the next step. A Workspace marketplace app is later.

---

## Not in the product yet

- Asking from inside Slack
- Confluence
- Department-level access to survey results
- Private Drive without a manual folder share
