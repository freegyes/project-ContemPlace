import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';

export type SupabaseClientType = SupabaseClient;

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

/**
 * Attempt to claim this update_id. Returns true if new, false if duplicate.
 * Throws on unexpected DB errors.
 */
export async function tryClaimUpdate(
  db: SupabaseClient,
  updateId: number,
): Promise<boolean> {
  const { error } = await db
    .from('processed_updates')
    .insert({ update_id: updateId });

  if (!error) return true;

  if (error.code === '23505') {
    return false; // duplicate — already processed
  }

  // Unexpected error — log but allow processing to continue
  console.error(JSON.stringify({
    event: 'dedup_insert_error',
    error: error.message,
    code: error.code,
    update_id: updateId,
  }));
  return true;
}
