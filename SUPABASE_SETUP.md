# Squarewise cloud login and sync (Supabase)

Squarewise keeps local autosave active. Optional cloud sync uses the user's own Supabase project; this prototype does not ship a shared Squarewise server database or any service-role secret.

## 1. Create the private save table

Create a Supabase project, open **SQL Editor**, and run:

```sql
create table if not exists public.squarewise_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.squarewise_data enable row level security;

drop policy if exists "Users manage their own Squarewise save" on public.squarewise_data;
create policy "Users manage their own Squarewise save"
  on public.squarewise_data
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.squarewise_data to authenticated;
```

The row-level-security rule ensures each signed-in user can access only the row whose `user_id` is their own Supabase Auth user ID.

## 2. Enable email authentication and redirects

In **Authentication → Sign In / Providers**, enable Email. Email confirmation is supported; a new user may need to confirm their address before signing in. In **Authentication → URL Configuration**, set the Site URL to your full public app URL and add that URL to the allowed redirect URLs so confirmation and password-reset links return to Squarewise. For a GitHub Pages project site, include the repository path, for example `https://owner.github.io/repository/`; also allow the corresponding custom-domain URL if you use one. The password-reset redirect preserves this path. A temporary Arena preview origin may change, so use a stable HTTPS deployment for lasting cross-device sign-in.

## 3. Connect Squarewise

In **Project Settings → API**, copy the **Project URL** and the public **anon / publishable key**. In Squarewise, click the cloud icon, enter those two values, and save. Then create an account or sign in.

**Never enter the `service_role` key.** The public key is designed for browser use; the SQL row-level-security policy is what protects user data. Squarewise sends passwords directly to Supabase Auth over HTTPS and does not store them.

## What syncs

Cloud sync stores the profile, progress log, daily tasks, repertoire, study notes, and game-derived drills. Imported PGN files and full game records stay in the browser and are not uploaded. Local autosave continues to work without Supabase. When a cloud save already exists alongside unsynced local data, Squarewise asks which synced copy to keep before replacing either one.
