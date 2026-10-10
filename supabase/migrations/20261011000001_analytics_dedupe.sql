-- Duplicate protection for Insights records. The API stamps data->>'dedupeKey' (stable external ID, or
-- normalized platform + title + Date published) on every analytics item it writes. Existing rows are left
-- untouched (no key, so no conflicts); nothing is deleted or rewritten.
create unique index if not exists items_analytics_dedupe_key
  on public.items (workspace_id, (data->>'dedupeKey'))
  where collection = 'analytics' and data->>'dedupeKey' is not null;
