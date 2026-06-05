# Testing Rules

> No test framework is currently installed. These rules define the target state when tests are added.

## Target Framework

Use **Jest** with **Supertest** for integration testing against the Express app.

```bash
npm install --save-dev jest supertest
```

Add to `package.json`:
```json
"scripts": {
  "test": "jest --runInBand",
  "test:watch": "jest --watch"
},
"jest": {
  "testEnvironment": "node",
  "testMatch": ["**/tests/**/*.test.js"]
}
```

## Test Location

All tests go in `tests/` at the project root, mirroring the `src/` structure:

```
tests/
├── routes/
│   ├── auth.test.js
│   ├── product.test.js
│   ├── order.test.js
│   └── cart.test.js
└── utils/
    └── priceHelper.test.js
```

## What to Test

### Route Integration Tests (priority: high)
- Test each route with valid inputs → assert response shape from `utils/response.js`.
- Test missing required query params → assert 400 error response.
- Test auth routes with invalid credentials → assert fail response.

### Unit Tests (priority: high for utils)
- `priceHelper.js` — `getProductPriceLocalx()` must have unit tests for each of the 7 pricing strategies with known inputs/outputs. This is the highest-risk function in the codebase.
- `response.js` — test `success()`, `fail()`, `paginated()` output shapes.

### Transaction Tests (priority: medium)
- Test that `withTransaction()` rolls back on error.

## Test Database

- Tests must connect to a **dedicated test database** (e.g. `DB_NAME=sml_test`).
- Never run tests against the demo/prod database.
- Use `dotenv` with a `.env.test` file for test-specific config.
- Do **not** mock the database pools — integration tests must hit a real PostgreSQL instance to catch query errors.

## Test Conventions

- Name tests descriptively: `'GET /getProductList returns paginated results for valid customer'`
- Group by route/function using `describe()`.
- Use `beforeAll`/`afterAll` for DB setup/teardown, not `beforeEach` (expensive connections).
- Assert HTTP status codes AND response body shape in every test.
- Keep tests independent — never rely on state from a previous test.

## Coverage Target

Once testing is set up, aim for:
- 80%+ line coverage on `src/utils/`
- 60%+ line coverage on `src/routes/`
