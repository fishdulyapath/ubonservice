# Code Style Rules

Applies to all JavaScript files in `src/`.

## Language & Syntax

- **Plain JavaScript** — no TypeScript. Do not introduce `tsc`, `ts-node`, or `.ts` files without explicit approval.
- Use **ES6+** features: `const`/`let` (never `var`), arrow functions, destructuring, template literals, spread/rest.
- Use **`async/await`** for all asynchronous code. Do not mix `.then()/.catch()` chains into route handlers.
- Prefer named functions over anonymous callbacks for anything more than two lines.

## File Organization

- Route files live in `src/routes/` — one file per resource domain.
- Shared utilities belong in `src/utils/` — keep routes thin.
- A new route file must be imported and mounted in `src/index.js` under `/service/v1`.

## Database

- All SQL must use **parameterized queries**: `pool.query('SELECT … WHERE id = $1', [id])`.
- Never build SQL strings with string interpolation or concatenation from user-supplied values.
- Any operation touching multiple tables in one logical unit must wrap with `withTransaction()` from `db.js`.
- The image pool (`queryImages`) is only for the `demo_images` database — do not cross-query.

## Error Handling

- Every route handler must have a top-level `try/catch`.
- On caught errors, return via `response.fail()` with an appropriate HTTP status code (400 for client errors, 500 for server errors).
- Log errors to `console.error` before returning — include the route name and the error message.
- Do not leak internal SQL errors or stack traces to the client response.

## Response Format

- Always use helpers from `src/utils/response.js`: `success()`, `fail()`, `paginated()`.
- Do not hand-craft `res.json({ status: ... })` inline — use the helpers.

## Naming

- Route files: `camelCase.js` (e.g. `product.js`, `order.js`).
- Functions: `camelCase`.
- DB column refs in JS: keep them as returned by PostgreSQL (snake_case).
- SQL aliases: use snake_case matching the existing schema conventions.

## Comments

- Thai-language comments in route files are **intentional** — they trace logic back to the original Java implementation. Preserve them.
- Only add new comments when the *why* is non-obvious (hidden constraint, workaround for a DB quirk, etc.).
- Do not add JSDoc to every function. Only document complex utilities like `getProductPriceLocalx`.

## Formatting

- 2-space indentation.
- Single quotes for strings.
- Trailing comma in multiline objects/arrays.
- Semicolons required.
- Max line length: 120 characters.
