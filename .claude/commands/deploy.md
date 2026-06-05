---
description: Guide through deploying the API to the target environment ($ARGUMENTS: dev | staging | prod)
---

Prepare and guide a deployment to the **$ARGUMENTS** environment (default: dev).

## Pre-Deploy Checklist

Run through this before proceeding:

1. **Clean working tree** — confirm `git status` shows no uncommitted changes.
2. **Dependencies up to date** — run `npm install` and confirm no unresolved peer conflicts.
3. **Environment file** — confirm `.env` exists and all required keys are set (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_IMAGES_NAME, PORT, PROVIDER).
4. **No hardcoded credentials** — grep for any plaintext passwords or tokens committed to source.
5. **Tests pass** — run `npm test` if a test suite exists.

## Deploy Steps

For the **$ARGUMENTS** environment:

```bash
# 1. Pull latest from the correct branch
git pull origin main   # or the environment branch

# 2. Install/update dependencies
npm install --omit=dev

# 3. Start or restart the process manager
# PM2 (if installed):
pm2 restart sml-staff-api --update-env
# Or systemd:
# sudo systemctl restart sml-staff-api

# 4. Confirm the service is responding
curl http://localhost:47302/service/v1/loginemp
```

## Post-Deploy Verification

- Check server logs for startup errors.
- Confirm DB pools connect successfully (look for connection pool ready message).
- Test the auth endpoint with a known employee ID.
- Confirm image serving still works (ETag headers present).

## Rollback

```bash
git log --oneline -10   # find previous good commit
git checkout <commit>   # pin to that commit
pm2 restart sml-staff-api
```

Flag any concerns before proceeding.
