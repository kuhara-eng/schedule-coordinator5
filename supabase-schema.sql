-- schedule-coordinator secure sharing schema
-- URLに含まれる board/share_id と token/access_token の両方が一致した場合だけRPC経由で読み書きできます。

create extension if not exists pgcrypto;

create table if not exists public.schedule_boards (
  share_id text primary key,
  access_token text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.schedule_boards
  add column if not exists access_token text;

update public.schedule_boards
set access_token = encode(gen_random_bytes(32), 'hex')
where access_token is null;

alter table public.schedule_boards
  alter column access_token set not null;

create unique index if not exists schedule_boards_share_token_idx
  on public.schedule_boards (share_id, access_token);

alter table public.schedule_boards enable row level security;

drop policy if exists "schedule_boards_select" on public.schedule_boards;
drop policy if exists "schedule_boards_insert" on public.schedule_boards;
drop policy if exists "schedule_boards_update" on public.schedule_boards;
drop policy if exists "schedule_boards_no_direct_select" on public.schedule_boards;
drop policy if exists "schedule_boards_no_direct_insert" on public.schedule_boards;
drop policy if exists "schedule_boards_no_direct_update" on public.schedule_boards;
drop policy if exists "schedule_boards_realtime_select" on public.schedule_boards;

-- anonからの直接SELECT/INSERT/UPDATEは許可しません。
-- 読み書きは下のSECURITY DEFINER RPCだけを使います。
create policy "schedule_boards_no_direct_select"
  on public.schedule_boards for select
  to anon
  using (false);

create policy "schedule_boards_no_direct_insert"
  on public.schedule_boards for insert
  to anon
  with check (false);

create policy "schedule_boards_no_direct_update"
  on public.schedule_boards for update
  to anon
  using (false)
  with check (false);

create or replace function public.get_schedule_board(
  p_share_id text,
  p_access_token text
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select data
  from public.schedule_boards
  where share_id = p_share_id
    and access_token = p_access_token
  limit 1;
$$;

create or replace function public.save_schedule_board(
  p_share_id text,
  p_access_token text,
  p_data jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.schedule_boards (share_id, access_token, data, updated_at)
  values (p_share_id, p_access_token, p_data, now())
  on conflict (share_id) do update
    set data = excluded.data,
        updated_at = now()
    where public.schedule_boards.access_token = excluded.access_token;

  if not found then
    raise exception 'schedule board not found or access token mismatch'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on table public.schedule_boards from anon, authenticated;
revoke all on function public.get_schedule_board(text, text) from public;
revoke all on function public.save_schedule_board(text, text, jsonb) from public;

grant execute on function public.get_schedule_board(text, text) to anon;
grant execute on function public.save_schedule_board(text, text, jsonb) to anon;

drop function if exists public.upsert_schedule_board(text, text, jsonb);

-- RealtimeはPostgres changesではなくBroadcast通知を使います。
-- テーブルへの直接SELECTを許可しないため、DB行payloadは配信しません。
-- クライアントは share_id + access_token のチャンネル通知を受けた後、access_token付きRPCで最新データを再取得します。
