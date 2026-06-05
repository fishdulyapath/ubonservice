# API Conventions

## Base Path

All routes are prefixed with `/service/v1`. This matches the original Java/JAX-RS API so existing clients require no reconfiguration.

```
/service/v1/{resource-action}
```

## Endpoint Naming

- Use **lowercase, no hyphens** for route paths (matches original Java API naming).
- Verb-noun style: `getProductList`, `sendorder`, `additemtocart`.
- Do not introduce kebab-case or REST-style resource paths (`/products/:id`) unless building new endpoints with no existing Java counterpart.

## HTTP Methods

| Operation | Method |
|---|---|
| Read / query | `GET` |
| Create / write | `POST` |
| Delete | `DELETE` |
| Update | `PUT` or `PATCH` |

- Do not use `POST` for read operations — even for complex filter queries, prefer `GET` with query params.

## Query Parameters

- Required params are validated at the top of the handler. Return `400` immediately if missing.
- Pagination: use `page` (1-based) and `pageSize` query params. Pass them to `paginated()` helper.
- Filtering: use descriptive snake_case param names (e.g. `item_code`, `customer_code`).
- Never trust query params as safe for direct SQL insertion — always parameterize.

## Request Headers

| Header | Required | Description |
|---|---|---|
| `GUID` | Yes (most routes) | Session/request identifier |
| `configFileName` | Context | Config profile |
| `databaseName` | Context | Database selector override |
| `Authorization` | Auth routes | Bearer token |
| `Content-Type` | POST routes | `application/json` or `text/plain` |

## Response Format

All responses use the helpers from `src/utils/response.js`.

**Success (single record or action):**
```json
{ "status": "success", "data": { ... } }
```

**Success (paginated list):**
```json
{
  "status": "success",
  "data": [...],
  "pagination": { "page": 1, "pageSize": 20, "total": 150 }
}
```

**Error:**
```json
{ "status": "error", "message": "Human-readable reason" }
```

- Always return `Content-Type: application/json`.
- HTTP status codes: 200 OK, 400 Bad Request, 401 Unauthorized, 404 Not Found, 500 Internal Server Error.
- Do not return raw PostgreSQL error objects — sanitize before sending.

## Image Endpoints

Image endpoints (`/getImageList`, `/images`, `/imagesguid`) are special:

- `/images` and `/imagesguid` serve binary data (`Content-Type: image/jpeg` etc.).
- Must include `ETag` and `Cache-Control: public, max-age=604800` (7 days).
- Use the `sharp` library for any resize/format conversion — do not pipe raw buffers without validation.

## CORS

The server accepts all origins (`*`) with the custom headers listed above. This is intentional for internal staff-tool use — do not restrict without product approval.

## New Endpoints Checklist

Before adding a new endpoint:
- [ ] Route added to correct file in `src/routes/`
- [ ] Route mounted in `src/index.js` under `/service/v1`
- [ ] Required query/body params validated at top of handler
- [ ] All SQL uses `$1, $2…` parameterization
- [ ] Response uses `utils/response.js` helpers
- [ ] Multi-table writes wrapped in `withTransaction()`
- [ ] Error caught and returned with correct HTTP status
- [ ] Thai comment added tracing back to original Java method (if applicable)
