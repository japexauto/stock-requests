-- Stock requests database.
-- Uses the SAME Supabase project as the courtesy-cars app, so staff use the same logins.
-- Paste this whole file into Supabase > SQL Editor and click Run, once.
-- Every table here starts with stock_ so nothing clashes with the courtesy-cars tables.

-- ---------------------------------------------------------------------------
-- Stock managers: who can add/edit items and mark requests ordered or arrived.
-- Add people with the SQL at the bottom of this file. There's no screen for it on purpose.
-- notify_email = true means they get an email for every new request.
-- ---------------------------------------------------------------------------
create table public.stock_managers (
  email         text primary key check (email = lower(email)),
  name          text not null default '',
  notify_email  boolean not null default true,
  created_at    timestamptz not null default now()
);

-- True when the signed-in person is on the managers list.
create function public.is_stock_manager() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.stock_managers
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- Stock items. Removing an item hides it (active = false) but keeps its history.
-- ---------------------------------------------------------------------------
create table public.stock_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  size_grade  text not null default '',   -- e.g. 5W-30, 205 L, 400 ml, Large
  supplier    text not null default '',
  order_qty   text not null default '',   -- usual order, e.g. "1 drum", "2 boxes of 100"
  notes       text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  text default lower(auth.jwt() ->> 'email')
);

-- ---------------------------------------------------------------------------
-- Requests. One row per "running low". Never deleted, so it doubles as the history.
-- Either item_id is set (scanned label) or there's a photo and/or note (no label).
-- ---------------------------------------------------------------------------
create table public.stock_requests (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid references public.stock_items(id),
  photo_path    text,
  note          text not null default '' check (length(note) <= 500),
  qty_left      text not null default '' check (length(qty_left) <= 40),
  urgency       text not null default 'normal' check (urgency in ('normal', 'urgent')),
  status        text not null default 'requested' check (status in ('requested', 'ordered', 'arrived', 'cancelled')),
  qty_ordered   text not null default '',
  requested_by  text,
  requested_at  timestamptz not null default now(),
  ordered_by    text,
  ordered_at    timestamptz,
  arrived_by    text,
  arrived_at    timestamptz,
  cancelled_by  text,
  cancelled_at  timestamptz,
  constraint something_to_order check (item_id is not null or photo_path is not null or length(trim(note)) > 0)
);

-- Stops duplicates: an item can only have one open request (requested or ordered) at a time.
create unique index stock_requests_one_open_per_item on public.stock_requests (item_id)
  where item_id is not null and status in ('requested', 'ordered');

create index stock_requests_requested_at on public.stock_requests (requested_at desc);
create index stock_requests_open on public.stock_requests (status) where status in ('requested', 'ordered');

-- Fills in who/when on the server so it can't be faked, and decides what staff can change.
--   Managers: anything.
--   The person who asked: while still "requested", can change quantity left, urgency, note, or cancel.
--   Anyone else: can only bump an open request from normal to urgent.
create function public.stock_requests_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  me  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  mgr boolean := public.is_stock_manager();
begin
  if tg_op = 'INSERT' then
    new.requested_by := me;
    new.requested_at := now();
    if not mgr then
      new.status := 'requested';
      new.qty_ordered := '';
    end if;
    new.ordered_by := null;   new.ordered_at := null;
    new.arrived_by := null;   new.arrived_at := null;
    new.cancelled_by := null; new.cancelled_at := null;
    if new.status = 'ordered' then new.ordered_by := me; new.ordered_at := now(); end if;
    return new;
  end if;

  -- UPDATE from here on
  if not mgr then
    if new.item_id      is distinct from old.item_id
    or new.photo_path   is distinct from old.photo_path
    or new.qty_ordered  is distinct from old.qty_ordered
    or new.requested_by is distinct from old.requested_by
    or new.requested_at is distinct from old.requested_at
    or new.ordered_by   is distinct from old.ordered_by   or new.ordered_at   is distinct from old.ordered_at
    or new.arrived_by   is distinct from old.arrived_by   or new.arrived_at   is distinct from old.arrived_at
    or new.cancelled_by is distinct from old.cancelled_by or new.cancelled_at is distinct from old.cancelled_at then
      raise exception 'Only the parts manager can change that.' using errcode = '42501';
    end if;

    if old.requested_by = me and old.status = 'requested' then
      if new.status not in ('requested', 'cancelled') then
        raise exception 'Only the parts manager can mark a request ordered or arrived.' using errcode = '42501';
      end if;
    else
      if new.status   is distinct from old.status
      or new.note     is distinct from old.note
      or new.qty_left is distinct from old.qty_left then
        raise exception 'That request belongs to someone else, or has already been ordered.' using errcode = '42501';
      end if;
      if new.urgency is distinct from old.urgency
         and not (old.urgency = 'normal' and new.urgency = 'urgent' and old.status in ('requested', 'ordered')) then
        raise exception 'You can only mark an open request as urgent.' using errcode = '42501';
      end if;
    end if;
  end if;

  -- Stamp who/when as the status moves on.
  if new.status is distinct from old.status then
    if new.status = 'ordered'   then new.ordered_by   := me; new.ordered_at   := now(); end if;
    if new.status = 'arrived'   then new.arrived_by   := me; new.arrived_at   := now();
      if new.ordered_at is null then new.ordered_by := me; new.ordered_at := now(); end if;
    end if;
    if new.status = 'cancelled' then new.cancelled_by := me; new.cancelled_at := now(); end if;
    -- A manager stepping a status back clears the later stamps.
    if new.status = 'requested' then
      new.ordered_by := null; new.ordered_at := null;
      new.arrived_by := null; new.arrived_at := null;
      new.cancelled_by := null; new.cancelled_at := null;
    end if;
    if new.status = 'ordered' then
      new.arrived_by := null; new.arrived_at := null;
      new.cancelled_by := null; new.cancelled_at := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger stock_requests_guard
  before insert or update on public.stock_requests
  for each row execute function public.stock_requests_guard();

-- ---------------------------------------------------------------------------
-- Phone notification subscriptions (one per phone that's turned alerts on).
-- ---------------------------------------------------------------------------
create table public.stock_push_subs (
  endpoint    text primary key,
  email       text not null default lower(auth.jwt() ->> 'email'),
  p256dh      text not null,
  auth        text not null,
  device      text not null default '',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security: on for every table. Only signed-in staff get anything.
-- The public (anon) key on its own can't read or write a single row.
-- ---------------------------------------------------------------------------
alter table public.stock_managers  enable row level security;
alter table public.stock_items     enable row level security;
alter table public.stock_requests  enable row level security;
alter table public.stock_push_subs enable row level security;

-- Belt and braces: take away the default table rights from logged-out visitors as well.
revoke all on public.stock_managers, public.stock_items, public.stock_requests, public.stock_push_subs from anon;
revoke execute on function public.is_stock_manager() from public, anon;
grant  execute on function public.is_stock_manager() to authenticated;
revoke execute on function public.stock_requests_guard() from public, anon, authenticated;

-- Managers list: staff can see it (the app uses it to show manager buttons). Changes only via SQL Editor.
create policy "Staff can see managers" on public.stock_managers
  for select to authenticated using (true);

-- Items: all staff can see; only managers add or edit. No deleting (archive instead).
create policy "Staff can see items" on public.stock_items
  for select to authenticated using (true);
create policy "Managers add items" on public.stock_items
  for insert to authenticated with check (public.is_stock_manager());
create policy "Managers edit items" on public.stock_items
  for update to authenticated using (public.is_stock_manager()) with check (public.is_stock_manager());

-- Requests: all staff can see (so nobody asks twice) and raise. Updates are checked by the trigger above.
-- No deleting, so the history stays complete.
create policy "Staff can see requests" on public.stock_requests
  for select to authenticated using (true);
create policy "Staff raise requests" on public.stock_requests
  for insert to authenticated with check (true);
create policy "Staff update requests" on public.stock_requests
  for update to authenticated using (true) with check (true);

-- Phone alerts: managers only, and each person only sees their own phones.
create policy "Own alert subscriptions" on public.stock_push_subs
  for select to authenticated using (email = lower(auth.jwt() ->> 'email'));
create policy "Managers add alert subscriptions" on public.stock_push_subs
  for insert to authenticated with check (email = lower(auth.jwt() ->> 'email') and public.is_stock_manager());
create policy "Managers update own alert subscriptions" on public.stock_push_subs
  for update to authenticated using (email = lower(auth.jwt() ->> 'email'))
  with check (email = lower(auth.jwt() ->> 'email') and public.is_stock_manager());
create policy "Remove own alert subscriptions" on public.stock_push_subs
  for delete to authenticated using (email = lower(auth.jwt() ->> 'email'));

-- ---------------------------------------------------------------------------
-- Photos for unlabelled items. Private bucket: only signed-in staff can upload or view.
-- 5 MB limit; the app shrinks photos to well under that before uploading.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stock-photos', 'stock-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

create policy "Staff upload stock photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'stock-photos');
create policy "Staff view stock photos" on storage.objects
  for select to authenticated using (bucket_id = 'stock-photos');

-- ---------------------------------------------------------------------------
-- NOW ADD YOUR MANAGERS. Change the emails to the ones they sign in with, then run these lines.
-- They must already have a login (Authentication > Users), same as for courtesy cars.
-- ---------------------------------------------------------------------------
-- insert into public.stock_managers (email, name, notify_email) values
--   ('parts.manager@japex.co.uk', 'Parts manager', true),
--   ('stuart.hateley@japex.co.uk', 'Stuart', false);
