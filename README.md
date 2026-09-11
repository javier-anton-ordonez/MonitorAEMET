# MonitorAEMET

Monitor en tiempo real del **uptime y fiabilidad de las APIs oficiales de observación meteorológica** de España (AEMET) y Francia (Météo-France), con la pregunta de fondo: **¿son estas APIs lo bastante fiables para una persona común** —no un laboratorio ni un experto— que quiera consultar sus datos cotidianamente?

Cada pocos minutos el monitor interroga a los servicios oficiales, registra qué estaciones responden con observaciones y cuáles no, y construye un historial de disponibilidad que se consulta de forma visual en un panel web.

## 🌍 Dónde se puede ver

- **Panel público:** <https://aemetuptime.sakenaura.com/>

## ❓ Objetivo del proyecto

Los servicios meteorológicos públicos publican sus datos a través de APIs oficiales. Estas APIs se diseñan pensando en organismos, medios o instituciones profesionales, no necesariamente en el usuario particular que consulta "¿está lloviendo en mi zona?".

Este proyecto mide de forma empírica la **fiabilidad real** de esos servicios, respondiendo a preguntas como:

- ¿El API oficial responde siempre que una persona corriente lo consulta?
- ¿Hay estaciones que dejan de emitir datos y cuánto tiempo?
- ¿Qué porcentaje de disponibilidad real (uptime) tiene cada red de estaciones?
- ¿Qué estaciones son estables y cuáles son intermitentes?

La respuesta se materializa en **estadísticas de uptime por estación** y un **mapa coloreado** según la salud de cada una, para saber de un vistazo qué fuentes oficiales son fiables para el uso cotidiano.

## 🖥️ Cómo funciona

- Dos monitores independientes que se ejecutan en bucle dentro de un contenedor Docker:
  - **España (AEMET):** 856 estaciones, comprobadas cada 30 min (`:01` y `:31`).
  - **Francia (Météo-France):** 2.151 estaciones, comprobadas cada 20 min (`:00`, `:20` y `:40`).
- Cada comprobación consulta el estado de cada estación (¿ha emitido observaciones recientes?) y lo registra en un histórico.
- El panel web muestra el mapa, el uptime global por país y la evolución por estación.

### ¿Qué significa el color de una estación?

| Color | Significado |
|-------|-------------|
| 🟢 Verde | Uptime ≥ 99.9 % |
| 🟡 Amarillo | Uptime ≥ 99.0 % |
| 🔴 Rojo | Uptime < 99.0 % |
| ⚪ Gris | Sin datos suficientes (< 3 comprobaciones) |

> Las estaciones comienzan en gris y necesitan al menos 3 comprobaciones para obtener un diagnóstico de color, evitando falsas alarmas con muestras demasiado pequeñas.

### Y los límites de las APIs, ¿se tienen en cuenta?

Sí, y es un punto importante. Los servicios oficiales imponen **límites de peticiones** (rate limits / "créditos"). Para que el estudio sea honesto:

- Las peticiones se **reparten de forma constante** durante cada ciclo de comprobación (p. ej. ~2 peticiones/segundo en Francia), no en ráfagas.
- Si el API devuelve un **límite excedido (HTTP 429)**, esa estación **no se cuenta ni como caída ni como disponible**: simplemente se **descarta para ese ciclo**. El uptime solo se computa con comprobaciones que realmente llegaron al servidor.
- Así, una estación nunca aparece "caída" porque el monitor se quedara sin créditos; solo se considera caída cuando el API respondió y no había datos.

## 🚀 Despliegue

### Requisitos

- Docker y Docker Compose.
- Claves de API oficiales (opcionales para ver el panel, obligatorias para recoger datos):
  - **AEMET:** clave de `opendata.aemet.es`.
  - **Météo-France:** credenciales del [portail-api.meteofrance.fr](https://portail-api.meteofrance.fr/) (DPObs).

### Configuración

Copia `config.json` (no está en el repositorio por contener claves secretas):

```json
{
  "apiKey": "<API_KEY_AEMET>",
  "port": 3000,
  "intervalMin": 30,
  "franceIntervalMin": 20,
  "mfMaxRps": 2,
  "meteoFranceAuth": [
    "<Basic_MétéoFrance_cuenta_1>"
  ]
}
```

- `intervalMin` y `franceIntervalMin`: cadencia de comprobación de cada país (minutos).
- `mfMaxRps`: ritmo máximo de peticiones por segundo hacia Météo-France (por cuenta).
- `meteoFranceAuth`: un array; añade una entrada por cada cuenta API que quieras rotar (multiplica la capacidad de peticiones).

### Puesta en marcha

```bash
docker compose up -d --build
```

El panel queda disponible en `http://localhost:3000`.

### Datos

El histórico y la lista de estaciones se guardan en `data/`:

- `stations.json`, `uptime.json` — AEMET.
- `fr-stations.json`, `fr-uptime.json` — Météo-France.

## 🗂️ Estructura

```
├── server.js              # Motor del monitor + servidor web
├── config.json            # Configuración y claves (NO se sube a git)
├── docker-compose.yml     # Despliegue en contenedor
├── Dockerfile
├── public/                # Panel web (HTML, CSS, JS)
└── data/                  # Datos generados por el monitor
```

## 🔧 Estado actual

- España (AEMET): 856 estaciones, ~99 % online, red estable.
- Francia (Météo-France): 2.151 estaciones. La mayoría responde en la primera ventana; una fracción puede quedarse sin comprobar en un ciclo dado por los límites de peticiones del API, aunque **no se contabiliza como caída**.

## ⚖️ Licencia

Proyecto independiente de AEMET y Météo-France. Los datos proceden de las APIs oficiales públicas de ambos organismos y se respetan sus condiciones de uso.