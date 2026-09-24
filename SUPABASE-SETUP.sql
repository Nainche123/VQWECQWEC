create table if not exists public.nexivo_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- Server-only table. Do not expose this table to the browser with a publishable key.
alter table public.nexivo_state enable row level security;

-- The application uses the Supabase secret/service-role key from Render, so no public policies are needed.
