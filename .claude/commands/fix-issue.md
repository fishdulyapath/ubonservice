---
description: Diagnose and fix a bug or issue described in $ARGUMENTS
---

Fix the following issue: $ARGUMENTS

Follow this process:

1. **Understand** — restate the issue in one sentence to confirm understanding.
2. **Locate** — search the relevant route file(s) under `src/routes/` and utilities under `src/utils/`. Use grep/glob to find the affected code.
3. **Root cause** — identify the exact line(s) causing the problem. Quote them.
4. **Fix** — apply the minimal correct change. Do not refactor surrounding code.
5. **Verify** — explain why the fix addresses the root cause without introducing new issues.

Constraints:
- Keep SQL queries parameterized (`$1, $2, …`). Never concatenate user input into SQL strings.
- If the fix touches order creation or pricing logic, be especially careful — these have complex business rules. Flag if unsure.
- If the fix requires a DB schema change, describe the migration needed but do not auto-run it.
- Use existing `utils/response.js` helpers for all HTTP responses.
