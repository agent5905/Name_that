import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const url = process.env.SUPABASE_URL ?? required('VITE_SUPABASE_URL');
const supabase = createClient(url, required('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const names = ['jordan-brooks', 'mateo-alvarez', 'maya-chen', 'priya-shah'];
for (const name of names) {
  const bytes = await readFile(new URL(`../content/portraits/${name}.webp`, import.meta.url));
  const { error } = await supabase.storage.from('reveal-media').upload(`portraits/${name}.webp`, bytes, {
    contentType: 'image/webp', cacheControl: '0', upsert: true,
  });
  if (error) throw new Error(`Upload failed for ${name}: ${error.message}`);
}
console.log(`Uploaded ${names.length} private WebP reveal assets.`);
