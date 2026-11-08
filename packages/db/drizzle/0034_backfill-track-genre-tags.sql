-- Backfill `tracks.genre_tags` for rows materialized while the pipeline did not
-- stamp them. Source of truth per track is the REQUEST's own style snapshot (the
-- vibe the track was generated under); the owning session's live snapshot is only
-- the fallback for requests predating `generation_requests.style_snapshot` — it
-- may misattribute tags across a past Change Vibe, which beats staying empty.
-- Tags are normalized (lower/btrim), de-blanked, and deduped to match what the
-- materialization write and every reader use.
update tracks t
set genre_tags = source.tags
from (
  select
    t2.id,
    (
      select jsonb_agg(distinct lower(btrim(tag.value)))
      from jsonb_array_elements_text(
        coalesce(
          case when jsonb_typeof(gr.style_snapshot -> 'genreTags') = 'array'
            then gr.style_snapshot -> 'genreTags' end,
          case when jsonb_typeof(s.session_style_snapshot -> 'genreTags') = 'array'
            then s.session_style_snapshot -> 'genreTags' end
        )
      ) as tag(value)
      where btrim(tag.value) <> ''
    ) as tags
  from tracks t2
  inner join generation_requests gr on gr.id = t2.generation_request_id
  left join activity_sessions s on s.id = gr.activity_session_id
) as source
where source.id = t.id
  and t.genre_tags = '[]'::jsonb
  and source.tags is not null;
