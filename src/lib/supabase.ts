import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

const supabaseUrl = config.supabase.url;
const supabaseKey = config.supabase.serviceRoleKey;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase credentials. Please check your .env file.');
}

export const supabase = createClient(supabaseUrl, supabaseKey); 