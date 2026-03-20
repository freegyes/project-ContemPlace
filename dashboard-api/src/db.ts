import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config, StatsResponse, ClusterCard, ClusterDetailNote, ClusterDetailLink, RecentNote } from './types';

export { SupabaseClient };

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function fetchStats(
  db: SupabaseClient,
): Promise<Omit<StatsResponse, 'backup_last_commit'>> {
  // 9 parallel queries
  const [
    notesCountRes,
    linksCountRes,
    clustersRes,
    recentCountRes,
    oldestRes,
    newestRes,
    allNoteIdsRes,
    gardenerLastRunRes,
    imageCountRes,
  ] = await Promise.all([
    db.from('notes').select('*', { count: 'exact', head: true }).is('archived_at', null),
    db.from('links').select('*', { count: 'exact', head: true }),
    db.from('clusters').select('note_ids, resolution').order('resolution', { ascending: true }),
    db.from('notes').select('*', { count: 'exact', head: true }).is('archived_at', null).gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    db.from('notes').select('created_at').is('archived_at', null).order('created_at', { ascending: true }).limit(1),
    db.from('notes').select('created_at').is('archived_at', null).order('created_at', { ascending: false }).limit(1),
    db.from('notes').select('id').is('archived_at', null),
    db.from('clusters').select('created_at').order('created_at', { ascending: false }).limit(1),
    db.from('notes').select('*', { count: 'exact', head: true }).is('archived_at', null).not('image_url', 'is', null),
  ]);

  // 1 sequential query — fetch all links for orphan computation
  const allLinksRes = await db.from('links').select('from_id, to_id');

  // ── Extract values ──────────────────────────────────────────────────────────

  const totalNotes = (notesCountRes.count as number | null) ?? 0;
  const totalLinks = (linksCountRes.count as number | null) ?? 0;
  const recentCount = (recentCountRes.count as number | null) ?? 0;
  const imageCount = (imageCountRes.count as number | null) ?? 0;

  const clusterRows = (clustersRes.data as Array<{ note_ids: string[]; resolution: number }> | null) ?? [];
  const allNoteIds = ((allNoteIdsRes.data as Array<{ id: string }> | null) ?? []).map(r => r.id);
  const allLinks = (allLinksRes.data as Array<{ from_id: string; to_id: string }> | null) ?? [];

  // oldest / newest
  const oldestRows = (oldestRes.data as Array<{ created_at: string }> | null) ?? [];
  const newestRows = (newestRes.data as Array<{ created_at: string }> | null) ?? [];
  const oldestNote = oldestRows[0]?.created_at ?? null;
  const newestNote = newestRows[0]?.created_at ?? null;

  // gardener last run
  const gardenerRows = (gardenerLastRunRes.data as Array<{ created_at: string }> | null) ?? [];
  const gardenerLastRun = gardenerRows[0]?.created_at ?? null;

  // ── Derived values ──────────────────────────────────────────────────────────

  // total_clusters + unclustered: use the lowest available resolution
  let totalClusters = 0;
  let unclusteredCount = 0;
  if (clusterRows.length > 0) {
    const lowestResolution = clusterRows[0]!.resolution;
    const lowestRows = clusterRows.filter(r => r.resolution === lowestResolution);
    totalClusters = lowestRows.length;
    const clusteredIds = new Set(lowestRows.flatMap(r => r.note_ids));
    unclusteredCount = allNoteIds.filter(id => !clusteredIds.has(id)).length;
  } else {
    // No clusters yet — all notes are unclustered
    unclusteredCount = totalNotes;
  }

  // orphan_count: notes not appearing in any link endpoint
  const linkedIds = new Set<string>();
  for (const link of allLinks) {
    linkedIds.add(link.from_id);
    linkedIds.add(link.to_id);
  }
  const orphanCount = allNoteIds.filter(id => !linkedIds.has(id)).length;

  // rates
  const captureRate7d = Math.round((recentCount / 7) * 10) / 10;
  const avgLinksPerNote = totalNotes > 0
    ? Math.round((totalLinks / totalNotes) * 10) / 10
    : 0;

  return {
    total_notes: totalNotes,
    total_links: totalLinks,
    total_clusters: totalClusters,
    unclustered_count: unclusteredCount,
    image_count: imageCount,
    capture_rate_7d: captureRate7d,
    oldest_note: oldestNote,
    newest_note: newestNote,
    orphan_count: orphanCount,
    avg_links_per_note: avgLinksPerNote,
    gardener_last_run: gardenerLastRun,
  };
}

// ── Clusters ──────────────────────────────────────────────────────────────────

export async function fetchClusters(
  db: SupabaseClient,
  resolution: number,
): Promise<{ clusters: ClusterCard[]; available_resolutions: number[] }> {
  type ClusterRowRaw = {
    label: string;
    top_tags: string[];
    note_ids: string[];
    gravity: number;
  };

  const [clustersRes, resolutionsRes] = await Promise.all([
    db.from('clusters')
      .select('label, top_tags, note_ids, gravity')
      .eq('resolution', resolution)
      .order('gravity', { ascending: false }),
    db.from('clusters')
      .select('resolution')
      .order('resolution', { ascending: true }),
  ]);

  const clusterRows = (clustersRes.data as ClusterRowRaw[] | null) ?? [];
  const resolutionRows = (resolutionsRes.data as Array<{ resolution: number }> | null) ?? [];
  const availableResolutions = [...new Set(resolutionRows.map(r => r.resolution))];

  if (clusterRows.length === 0) {
    return { clusters: [], available_resolutions: availableResolutions };
  }

  // Collect all note IDs across clusters for batch fetch
  const allNoteIds = [...new Set(clusterRows.flatMap(r => r.note_ids))];

  // Batch-fetch titles and links in parallel
  const [notesRes, linksRes] = await Promise.all([
    db.from('notes')
      .select('id, title')
      .in('id', allNoteIds)
      .is('archived_at', null),
    db.from('links')
      .select('from_id, to_id')
      .in('from_id', allNoteIds)
      .in('to_id', allNoteIds),
  ]);

  // Build title map and active ID set
  const titleMap = new Map<string, string>();
  for (const n of (notesRes.data as Array<{ id: string; title: string }> | null) ?? []) {
    titleMap.set(n.id, n.title);
  }

  // Build active link pairs (both endpoints must be active/non-archived)
  const activeIds = new Set(titleMap.keys());
  const activeLinkPairs: Array<{ from_id: string; to_id: string }> = [];
  for (const link of (linksRes.data as Array<{ from_id: string; to_id: string }> | null) ?? []) {
    if (activeIds.has(link.from_id) && activeIds.has(link.to_id)) {
      activeLinkPairs.push(link);
    }
  }

  // Build ClusterCard for each cluster row
  const clusters: ClusterCard[] = clusterRows.map(row => {
    const activeNoteIds = row.note_ids.filter(id => titleMap.has(id));

    // Hub notes: top 2 by intra-cluster link count (same algorithm as mcp/src/db.ts)
    const clusterIds = new Set(activeNoteIds);
    const linkCounts = new Map<string, number>();
    for (const link of activeLinkPairs) {
      if (clusterIds.has(link.from_id) && clusterIds.has(link.to_id)) {
        linkCounts.set(link.from_id, (linkCounts.get(link.from_id) ?? 0) + 1);
        linkCounts.set(link.to_id, (linkCounts.get(link.to_id) ?? 0) + 1);
      }
    }

    const hubNotes = activeNoteIds
      .map(id => ({ id, title: titleMap.get(id)!, link_count: linkCounts.get(id) ?? 0 }))
      .filter(n => n.link_count > 0)
      .sort((a, b) => b.link_count - a.link_count)
      .slice(0, 2);

    return {
      label: row.label,
      top_tags: row.top_tags,
      note_count: activeNoteIds.length,
      gravity: row.gravity,
      note_ids: activeNoteIds,
      hub_notes: hubNotes,
    };
  });

  return { clusters, available_resolutions: availableResolutions };
}

// ── Cluster detail ────────────────────────────────────────────────────────────

export async function fetchClusterDetail(
  db: SupabaseClient,
  noteIds: string[],
): Promise<{ notes: ClusterDetailNote[]; links: ClusterDetailLink[] }> {
  const [notesRes, linksRes] = await Promise.all([
    db.from('notes')
      .select('id, title, tags, image_url, created_at')
      .in('id', noteIds)
      .is('archived_at', null),
    db.from('links')
      .select('from_id, to_id, link_type, confidence, created_by')
      .in('from_id', noteIds)
      .in('to_id', noteIds),
  ]);

  const notes = (notesRes.data as ClusterDetailNote[] | null) ?? [];
  const links = (linksRes.data as ClusterDetailLink[] | null) ?? [];

  return { notes, links };
}

// ── Recent notes ──────────────────────────────────────────────────────────────

export async function fetchRecent(
  db: SupabaseClient,
  limit: number,
): Promise<RecentNote[]> {
  const { data, error } = await db
    .from('notes')
    .select('id, title, tags, source, image_url, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(JSON.stringify({ event: 'dashboard_fetch_recent_error', error: error.message }));
    return [];
  }

  return (data as RecentNote[] | null) ?? [];
}
