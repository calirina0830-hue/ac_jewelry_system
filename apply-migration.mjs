import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const supabaseUrl = 'https://yultgjgbyzopirwatpnh.supabase.co';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceRoleKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

const migrationPath = join(process.cwd(), 'supabase', 'migrations', '202610160002_merge_existing_reserved_reservations.sql');
const sql = readFileSync(migrationPath, 'utf-8');

console.log('Applying migration...');
console.log('SQL length:', sql.length);

const { data, error } = await supabase.rpc('exec_sql', { sql });

if (error) {
  console.error('Error applying migration:', error);
  process.exit(1);
}

console.log('Migration applied successfully:', data);