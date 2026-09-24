# Render Free + Supabase persistence

The web app no longer needs `/var/data` or a Render Persistent Disk.

## Supabase
1. Create a Supabase project.
2. SQL Editor -> run `SUPABASE-SETUP.sql`.
3. Supabase Settings -> API Keys -> copy the server-only Secret key (`sb_secret_...`).

## Render Web Service ENV
Set:

```env
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_STATE_TABLE=nexivo_state
NEXIVO_DB_FILE=data/db.json
```

Do NOT put the Supabase Secret key in browser code, GitHub, or `NEXT_PUBLIC_*` variables.

The app loads the authoritative JSON state from the single `nexivo_state` row at startup and mirrors changes back to Supabase after writes. The local `data/db.json` is only a process cache.
