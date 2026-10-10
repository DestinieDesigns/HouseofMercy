-- Allow the shared content calendar to store events in public.items (collection 'calendarEvents').
-- Additive only: no rows are changed or removed. The existing check constraint is widened by one value.
alter table public.items drop constraint if exists items_collection_check;
alter table public.items add constraint items_collection_check
  check (collection in ('ideas','reminders','goals','analytics','hashtagSets','imports','calendarEvents'));
