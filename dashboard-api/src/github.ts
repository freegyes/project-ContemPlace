const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedResult: { value: string | null; timestamp: number } | null = null;

export async function fetchBackupRecency(backupRepo: string, pat: string | null): Promise<string | null> {
  if (!pat || !backupRepo) return null;

  // In-memory cache (best-effort — isolate may be recycled)
  if (cachedResult && (Date.now() - cachedResult.timestamp) < CACHE_TTL_MS) {
    return cachedResult.value;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${backupRepo}/commits?per_page=1`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'contemplace-dashboard-api',
      },
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ event: 'github_backup_check_error', status: res.status }));
      cachedResult = { value: null, timestamp: Date.now() };
      return null;
    }
    const commits = await res.json() as Array<{ commit: { committer: { date: string } } }>;
    const date = commits[0]?.commit?.committer?.date ?? null;
    cachedResult = { value: date, timestamp: Date.now() };
    return date;
  } catch (err) {
    console.warn(JSON.stringify({ event: 'github_backup_fetch_error', error: String(err) }));
    cachedResult = { value: null, timestamp: Date.now() };
    return null;
  }
}

/** Reset cache — for testing only. */
export function _resetCache(): void {
  cachedResult = null;
}
