# SML Staff Service Express

Express.js REST API — a Node.js port of the original Java/JAX-RS MarketPlaceWebService, serving the SML staff-facing marketplace.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (plain JavaScript, no TypeScript) |
| Framework | Express 4.x |
| Database | PostgreSQL via `pg` (two pools: main + images) |
| Image processing | `sharp` |
| Dev server | `nodemon` |
| Frontend (planned) | Vue 3 + Vite |

## Running the Project

```bash
# Install dependencies
npm install

# Development (auto-reload via nodemon)
npm run dev

# Production
npm start
```

The server starts on **port 47302** (or `process.env.PORT`).

## Project Structure

```
src/
├── index.js          # Express app bootstrap, CORS, route mounting
├── db.js             # Two pg pools (main DB + image DB), withTransaction helper
├── routes/
│   ├── auth.js       # GET /loginemp, GET /logincus
│   ├── product.js    # Product list, detail, set, balance/price
│   ├── order.js      # POST /sendorder — complex order creation with VAT
│   ├── cart.js       # Cart CRUD against ws_cart_order_temp
│   ├── customer.js   # Customer master data
│   ├── financial.js  # Financial/accounting endpoints
│   ├── document.js   # Document (invoice/report) endpoints
│   ├── favorite.js   # Customer favourite items
│   └── image.js      # Image serving with ETag + 7-day cache
└── utils/
    ├── response.js   # success(), fail(), paginated() helpers
    └── priceHelper.js # getProductPriceLocalx() — 7-strategy cascading price logic
```

## API Base Path

All endpoints are mounted under `/service/v1`.

```
GET  /service/v1/loginemp
GET  /service/v1/getProductList
POST /service/v1/sendorder
...
```

## Database

Two PostgreSQL databases, both configured via `.env`:

- **demo** (`DB_NAME`) — transactional data (products, orders, customers)
- **demo_images** (`DB_IMAGES_NAME`) — binary image BLOBs

Key tables: `ic_inventory`, `ic_trans`, `ic_trans_detail`, `ar_customer`, `staff_cart_order`, `images`.

All queries use **parameterized placeholders** (`$1, $2, …`) — never string-interpolate user input into SQL.

Connections disable sequential scans on connect: `SET enable_seqscan = false`.

## Pricing Logic

`src/utils/priceHelper.js` — `getProductPriceLocalx()` implements 7 cascading price strategies:

1. Customer-specific price
2. Customer-group price
3. Promotion price
4. Standard price
5. Formula-based price
6. Barcode price
7. Last recorded price

Do **not** simplify or refactor this function without fully understanding the downstream business impact. It replicates exact Java logic including intentional quirks.

## Request Headers (Required by Clients)

| Header | Purpose |
|---|---|
| `GUID` | Session identifier |
| `configFileName` | Config profile selector |
| `databaseName` | Target database override |
| `Authorization` | Auth token |

## Environment Variables

Copy `.env.example` to `.env` — never commit `.env` directly.

| Key | Description |
|---|---|
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port |
| `DB_USER` | DB username |
| `DB_PASSWORD` | DB password |
| `DB_NAME` | Main database name |
| `DB_IMAGES_NAME` | Image database name |
| `PORT` | HTTP server port (default 47302) |
| `PROVIDER` | Environment tag (e.g. DEMO, PROD) |

## Key Conventions

- Use `async/await` — no raw `.then()/.catch()` chains in routes.
- All DB mutations that touch multiple tables must use `withTransaction()` from `db.js`.
- Always return responses via helpers in `utils/response.js`.
- Inline SQL comments in Thai are intentional — they trace back to the original Java methods.
- Keep routes thin: business logic belongs in `utils/`, not inline in route handlers.

## Planned Vue 3 Frontend

A Vue 3 + Vite frontend will be added in a sibling directory (`../smlstaff-vue/` or `../frontend/`). When added:

- It will consume this API via Axios pointing to `http://localhost:47302/service/v1`.
- Auth flow uses the `GUID` header, stored in Pinia.
- UI component library: TBD (likely PrimeVue or Quasar).

## Agents

| Agent | Use for |
|---|---|
| `code-reviewer` | General code quality review |
| `security-auditor` | SQL injection, auth bypass, data exposure |
| `ux-ui-frontend-designer` | Vue 3 UI/UX design and component structure |
