# Skill: Deploy Workflow

Step-by-step deploy process for SML Staff Service Express.

## Environments

| Tag | Branch | Port | DB |
|---|---|---|---|
| DEMO | `main` | 47302 | demo |
| PROD | `release/*` | 47302 | prod |

Set `PROVIDER` in `.env` to the correct tag before starting.

## Full Deploy Workflow

### 1. Pre-flight Checks

```bash
# Confirm clean working tree
git status

# Confirm on correct branch
git branch --show-current

# Check for any dependency issues
npm install
npm ls --depth=0
```

### 2. Environment Validation

Confirm all required `.env` keys are present:

```bash
node -e "
  require('dotenv').config();
  const required = ['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','DB_IMAGES_NAME','PORT','PROVIDER'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error('Missing:', missing); process.exit(1); }
  console.log('ENV OK — PROVIDER:', process.env.PROVIDER);
"
```

### 3. Database Connectivity Test

```bash
node -e "
  require('dotenv').config();
  const { Pool } = require('pg');
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  pool.query('SELECT 1').then(() => { console.log('DB OK'); pool.end(); }).catch(e => { console.error('DB FAIL:', e.message); process.exit(1); });
"
```

### 4. Start / Restart Service

**Using PM2:**
```bash
pm2 restart sml-staff-api --update-env
pm2 logs sml-staff-api --lines 50
```

**Using systemd:**
```bash
sudo systemctl restart sml-staff-api
sudo journalctl -u sml-staff-api -n 50 --no-pager
```

**Manual (dev only):**
```bash
npm start
```

### 5. Smoke Test

```bash
# Health: check the auth endpoint responds
curl -s "http://localhost:47302/service/v1/loginemp?emp_code=TEST" | jq '.status'

# Image endpoint: confirm ETag header present
curl -I "http://localhost:47302/service/v1/images?item_code=TESTITEM" 2>&1 | grep -i etag
```

### 6. Post-Deploy

- Confirm no ERROR lines in logs for first 2 minutes.
- Notify the team in the project channel with the commit SHA deployed.

## Rollback

```bash
git log --oneline -10
git checkout <previous-commit-sha>
pm2 restart sml-staff-api --update-env
```
