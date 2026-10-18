// The latest crew news after `cursor`. A long backlog shows its newest end, never its oldest page.
export async function latestNews(api, cursor, n = 40) {
  const tail = await api.get(`/api/events?tail=${n}`);
  const all = tail.events || [];
  const events = all.filter((e) => e.id > cursor);
  let older = false;
  if (events.length && events.length === all.length && all.length >= n) {
    const probe = await api.get(`/api/events?since=${Number(cursor) || 0}&limit=1`).catch(() => null);
    older = Boolean(probe?.events?.length) && probe.events[0].id < events[0].id;
  }
  return { events, older, last_event_id: tail.last_event_id ?? 0 };
}
