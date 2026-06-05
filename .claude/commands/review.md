---
description: Review staged changes or a specific file for quality, security, and API convention compliance
---

Review the following code carefully. If $ARGUMENTS is provided, review that file or path. Otherwise review the current git diff (staged + unstaged changes).

Act as the `code-reviewer` agent. Focus on:

1. **Correctness** — does the logic match the intent? Check edge cases.
2. **Security** — are all SQL queries parameterized? Is user input validated before use? Are auth checks in place?
3. **API conventions** — does the response use `utils/response.js` helpers? Does the endpoint follow `/service/v1` base path conventions?
4. **DB transactions** — do multi-table writes use `withTransaction()`?
5. **Error handling** — are errors caught and returned with appropriate HTTP status codes?
6. **Pricing logic** — if `priceHelper.js` is touched, flag it prominently and explain the impact.

Output a structured review:
- **Summary** (2–3 sentences)
- **Issues** (numbered list, each with severity: Critical / Major / Minor and a suggested fix)
- **Looks good** (what was done well)

Target: a mid-level Node.js developer familiar with Express and PostgreSQL.
