# MonitorAEMET — Government Weather API Uptime Monitor

A real-time monitor that measures the **reliability and uptime of official public weather observation APIs** — specifically AEMET (Spain) and Météo-France (France) — to answer a simple question: **are these government APIs reliable enough for an ordinary person** (not a lab or a professional meteorologist) to use in their daily life?

The system periodically queries each official service, records which stations respond with data and which do not, builds a historical availability log, and displays it on a colour-coded web dashboard.

## 🌍 Live instance

- **<https://aemetuptime.sakenaura.com/>**

## ❓ Project motivation

National meteorological agencies publish open data through official APIs. These services are typically designed for institutions, newsrooms, or professional researchers — not for the everyday user who just wants to check "will it rain tomorrow?"

This project empirically measures the **real-world availability** of those APIs by asking:

- Does the official API respond every time a regular user queries it?
- Which stations go offline, and for how long?
- What is the actual uptime percentage of each observation network?
- Which stations are stable and which are intermittent?

The answer is a set of **per-station uptime statistics** and a **colour-coded map** that shows at a glance which official data sources can be trusted for everyday use.

## 🖥️ How it works

Two independent monitors run inside a single Docker container on a scheduled loop:

| Network | Stations | Cycle | Schedule (min) |
|---------|----------|-------|-----------------|
| AEMET (Spain) | ~857 | 30 min | :01 and :31 |
| Météo-France (France) | 2 151 | 20 min | :00, :20 and :40 |

Each cycle, every station is queried for recent observations. If the API confirms data exists, the station is counted as **online**; if not, **offline**. The results are accumulated into a historical uptime log and rendered on the map.

### Colour legend

| Colour | Uptime | Interpretation |
|--------|--------|----------------|
| 🟢 Green | ≥ 99 % | Excellent service, reliable for daily use |
| 🟡 Yellow | 90 – 99 % | Usable, with occasional short interruptions |
| 🔴 Red | < 90 % | Poor availability, not recommended as a source |
| ⚪ Grey | Insufficient data | Fewer than 3 checks recorded |

> Stations start as grey and need at least 3 checks before receiving a colour, preventing false alarms from tiny samples.

### Why is the green threshold at 99 %?

Industry and critical infrastructure typically demand **"five nines" (99.999 %)** availability — only ~26 seconds of downtime per month. That standard applies to datacentres, telecoms, and financial systems.

This project targets a **different audience**: the ordinary citizen who wants to know whether they can trust a public weather API. For that purpose the benchmark is more human:

- **≥ 99 %** (fewer than ~7 hours of downtime per year) is **fully reliable** for everyday use.
- **90–99 %** is **acceptable**, with occasional gaps the user should be aware of.
- **< 90 %** (more than 36 days of downtime per year) makes the source **unfit as a daily reference**.

In short, this dashboard answers **"Can I count on this official data?"**, not **"Does this meet a five-nines SLA?"** A green station means a normal user can rely on it; a red station means they should look elsewhere.

### How are API rate limits handled?

The official services impose **request quotas** (rate limits). To keep the study honest:

- Requests are **spread evenly** across each check cycle (e.g. ~2 req/s for Météo-France), never burst-fired.
- If the API returns an **HTTP 429 (rate limited)**, the affected station is **excluded from that cycle's statistics** — it is neither counted as online nor as offline. Uptime is only computed from checks that actually reached the server.
- This way a station is never marked "down" simply because the monitor ran out of API credits.

## 🚀 Deployment

### Prerequisites

- Docker and Docker Compose.
- Official API keys (optional for viewing the dashboard, required for data collection):
  - **AEMET:** key from `opendata.aemet.es`.
  - **Météo-France:** credentials from [portail-api.meteofrance.fr](https://portail-api.meteofrance.fr/) (DPObs).

### Configuration

Copy `config.json` (not in the repository — contains secrets):

```json
{
  "apiKey": "<AEMET_API_KEY>",
  "port": 3000,
  "intervalMin": 30,
  "franceIntervalMin": 20,
  "mfMaxRps": 2,
  "meteoFranceAuth": [
    "<MeteoFrance_Basic_credential_1>"
  ]
}
```

- `intervalMin` / `franceIntervalMin`: check cycle in minutes for each country.
- `mfMaxRps`: target request rate per second per Météo-France account.
- `meteoFranceAuth`: an array of credentials — one per account. Adding accounts multiplies the available request quota.

### Start

```bash
docker compose up -d --build
```

Dashboard available at `http://localhost:3000`.

### Data

Historical checks and station lists are stored in `data/`:

- `stations.json`, `uptime.json` — AEMET.
- `fr-stations.json`, `fr-uptime.json` — Météo-France.

## 🗂️ Structure

```
├── server.js              # Monitor engine + HTTP server
├── config.json            # Configuration and API keys (NOT in git)
├── docker-compose.yml     # Container orchestration
├── Dockerfile
├── public/                # Dashboard (HTML, CSS, JS)
└── data/                  # Generated monitor data
```

## ⚖️ License

Independent project, not affiliated with AEMET or Météo-France. Data originates from the public APIs of both agencies and is used in compliance with their terms of service.
