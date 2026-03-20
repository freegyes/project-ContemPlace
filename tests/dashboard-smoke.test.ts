import { describe, it, expect } from 'vitest';

const API_URL = process.env.DASHBOARD_API_URL;
const API_KEY = process.env.DASHBOARD_API_KEY;

function headers() {
  return { Authorization: `Bearer ${API_KEY}` };
}

describe('dashboard-api smoke', () => {
  it('has required env vars', () => {
    expect(API_URL).toBeTruthy();
    expect(API_KEY).toBeTruthy();
  });

  it('GET /stats returns 200 with expected shape', async () => {
    const res = await fetch(`${API_URL}/stats`, { headers: headers() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('total_notes');
    expect(data).toHaveProperty('total_links');
    expect(data).toHaveProperty('total_clusters');
    expect(data).toHaveProperty('orphan_count');
    expect(data).toHaveProperty('image_count');
    expect(data).toHaveProperty('avg_links_per_note');
    expect(data).toHaveProperty('gardener_last_run');
    expect(data).toHaveProperty('backup_last_commit');
    expect(data.total_notes).toBeGreaterThan(0);
  });

  it('GET /clusters returns clusters with hub_notes', async () => {
    const res = await fetch(`${API_URL}/clusters?resolution=1.0`, { headers: headers() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('resolution', 1.0);
    expect(data).toHaveProperty('clusters');
    expect(data).toHaveProperty('available_resolutions');
    expect(Array.isArray(data.available_resolutions)).toBe(true);
    expect(data.clusters.length).toBeGreaterThan(0);
    const first = data.clusters[0];
    expect(first).toHaveProperty('hub_notes');
    expect(first).toHaveProperty('note_ids');
    expect(first).toHaveProperty('label');
    expect(first).toHaveProperty('gravity');
  });

  it('GET /clusters/detail returns notes + links for a cluster', async () => {
    // First get a cluster's note_ids
    const clusterRes = await fetch(`${API_URL}/clusters?resolution=1.0`, { headers: headers() });
    const clusterData = await clusterRes.json();
    const noteIds = clusterData.clusters[0].note_ids.slice(0, 10);

    const res = await fetch(`${API_URL}/clusters/detail?note_ids=${noteIds.join(',')}`, { headers: headers() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('notes');
    expect(data).toHaveProperty('links');
    expect(data.notes.length).toBeGreaterThan(0);
    // Verify response shape includes image_url and created_by
    expect(data.notes[0]).toHaveProperty('image_url');
    expect(data.notes[0]).toHaveProperty('tags');
    if (data.links.length > 0) {
      expect(data.links[0]).toHaveProperty('created_by');
      expect(data.links[0]).toHaveProperty('link_type');
    }
  });

  it('GET /recent returns notes with image_url', async () => {
    const res = await fetch(`${API_URL}/recent?limit=5`, { headers: headers() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('image_url');
    expect(data[0]).toHaveProperty('source');
    expect(data[0]).toHaveProperty('tags');
    expect(data[0]).toHaveProperty('title');
  });

  it('rejects request without auth', async () => {
    const res = await fetch(`${API_URL}/stats`);
    expect(res.status).toBe(401);
  });

  it('CORS headers present on response', async () => {
    const res = await fetch(`${API_URL}/stats`, { headers: headers() });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });
});
