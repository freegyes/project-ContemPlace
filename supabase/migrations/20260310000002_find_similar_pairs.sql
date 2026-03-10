-- Find all note pairs with cosine similarity above a threshold.
-- Replaces per-note match_notes RPC calls in the gardener similarity linker,
-- reducing N subrequests to 1.
--
-- Uses a self-join with lexicographic UUID ordering (a.id < b.id) so each pair
-- appears exactly once. This is a brute-force O(N²) comparison — appropriate for
-- hundreds of notes. At 1000+ notes, consider an ANN-based approach.
--
-- NOTE: The <=> operator must use OPERATOR(extensions.<=>) syntax because
-- PostgREST's execution context cannot resolve operators via search_path alone,
-- even when the extensions schema is included. Explicit schema references
-- for tables (public.notes) are also required for the same reason.

create or replace function public.find_similar_pairs(
  similarity_threshold float default 0.70,
  max_pairs int default 10000
)
returns table (
  note_a uuid,
  note_b uuid,
  similarity float
)
language plpgsql stable
set search_path = 'public, extensions'
as $$
begin
  return query
  select
    a.id as note_a,
    b.id as note_b,
    (1 - (a.embedding operator(extensions.<=>) b.embedding))::float as similarity
  from public.notes a
  join public.notes b on a.id < b.id
  where
    a.embedding is not null
    and b.embedding is not null
    and a.archived_at is null
    and b.archived_at is null
    and 1 - (a.embedding operator(extensions.<=>) b.embedding) > similarity_threshold
  order by similarity desc
  limit max_pairs;
end;
$$;
