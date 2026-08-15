# Tocsin

> **Real-time voice AI disaster-coordination platform that listens to fragmented multilingual voice streams, maintains live incident state, calls verified tools, and coordinates emergency response.**

Built for **EchoSphere Hackathon** by Team **KNOTiC**.

---

## 🏛 Architecture Overview

- **Frontend (`/frontend`)**: Next.js 14 + TypeScript dashboard for live disaster operations (runs as non-root user `nextjs` in standalone mode).
- **Backend (`/backend`)**: Python + FastAPI with WebSockets for real-time incident state engine (runs as non-root user `appuser`).
- **Mock Services (`/mock-services`)**: Python FastMCP server exposing emergency tool endpoints to Agora/Gemini Live (runs as non-root user `mcpuser`).
- **Voice / Conversational AI**: Agora Voice Agent Builder with native Google Gemini Live (`mllm.provider = "gemini"`).
- **Data & State**: PostgreSQL (persistent storage via `postgres_data` volume) and Redis (real-time state cache via `redis_data` volume).
- **Infrastructure**: Multi-container Docker Compose (`docker-compose.yml`).

---

## 🚀 Quickstart & Setup Instructions

### 1. Prerequisites
- [Docker](https://www.docker.com/) & Docker Compose
- Node.js v20+ & Python 3.11+ (for local development outside containers)

### 2. Environment Configuration
Copy `.env.example` to `.env` and configure your credentials:
```bash
cp .env.example .env
```

Key environment variables:
- `AGORA_APP_ID`: Agora App ID
- `AGORA_APP_CERTIFICATE`: Agora App Certificate
- `GEMINI_API_KEY`: Google Gemini API Key
- `DATABASE_URL`: PostgreSQL connection string (`postgresql://tocsin:tocsin_password@postgres:5432/tocsin`)
- `REDIS_URL`: Redis connection string (`redis://redis:6379/0`)
- `CORS_ORIGINS`: Comma-separated list of allowed origins (`http://localhost:3000,http://127.0.0.1:3000`)
- `LOG_LEVEL`: Logging verbosity (`DEBUG`, `INFO`, `WARNING`, `ERROR`)

### 3. Run with Docker Compose
Start all services:
```bash
docker compose up --build -d
```

### 4. Service Endpoints
| Service | URL | Description |
|---|---|---|
| **Frontend** | `http://localhost:3000` | Incident Command Dashboard |
| **Backend API** | `http://localhost:8000` | REST API & WebSockets |
| **Backend Health** | `http://localhost:8000/health` | Health Check Endpoint |
| **Backend WebSocket**| `ws://localhost:8000/ws/incidents/{id}` | Live State Stream |
| **Mock Services (MCP)** | `http://localhost:8001/sse` | FastMCP SSE Endpoint |
| **PostgreSQL** | `localhost:5432` | Database (`tocsin`) |
| **Redis** | `localhost:6379` | Cache / Event Bus |

---

## 🔒 Security Considerations & Open Risks (Hackathon Scope)

1. **MCP Server Authentication**: The MCP server (`/mock-services`) listens on port 8001 via SSE without transport authentication for seamless Agora / Gemini Live local bridge connectivity. In production, this must be placed behind a secure API gateway, mutual TLS, or Bearer token header validation.
2. **CORS Restrictions**: Explicitly restricted to configured development origins (`CORS_ORIGINS`) rather than wildcards.
3. **Non-Root Execution**: All containers (`frontend`, `backend`, `mock-services`) run under isolated non-privileged system users (UID 1001).
4. **Credential Isolation**: Secrets are never hardcoded or committed to git; `.gitignore` strictly ignores local `.env` and `.env.local` files.
