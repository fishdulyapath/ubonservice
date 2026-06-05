# Skill: Security Review

Perform a focused security audit of the specified file(s) or the current diff.

## Scope

Check for the following vulnerability classes, prioritized by severity:

### Critical

1. **SQL Injection**
   - Search for any template literals or string concatenation used to build SQL strings with user-supplied values.
   - All queries must use `pool.query('...WHERE col = $1', [userValue])` form.
   - Flag any `query(\`...${req.query.x}...\`)` or `query('...' + req.query.x + '...')` patterns.

2. **Authentication Bypass**
   - Check that protected routes verify the `GUID` or `Authorization` header before executing DB queries.
   - Verify that auth checks happen before any data is returned, not after.

3. **Sensitive Data Exposure**
   - Confirm DB error messages, stack traces, and internal query details are never returned in HTTP responses.
   - Verify `.env` secrets are not logged or echoed back in any response.

### High

4. **Input Validation**
   - Confirm numeric params (page, pageSize, IDs) are coerced/validated before use as SQL params.
   - Confirm string params are length-bounded where they feed SQL `LIKE` clauses.

5. **Insecure Direct Object Reference**
   - Check that customer-specific endpoints verify the requesting user is authorized to see that `customer_code`.
   - Verify order lookups are scoped to the authenticated session, not just any supplied ID.

### Medium

6. **Mass Assignment / Unfiltered Body**
   - Verify `req.body` fields are explicitly whitelisted before insertion into queries.
   - Do not spread `req.body` directly into a DB insert.

7. **Image Endpoint Abuse**
   - Confirm image serving endpoints validate `item_code`/`guid` before hitting the DB.
   - Confirm `sharp` pipeline has size limits to prevent resource exhaustion via crafted images.

## Output Format

For each finding:
- **Severity**: Critical / High / Medium / Low / Info
- **Location**: `src/routes/filename.js:line`
- **Description**: what the vulnerability is
- **Exploit scenario**: how it could be abused
- **Fix**: exact code change required

End with a **Summary table** of all findings.
