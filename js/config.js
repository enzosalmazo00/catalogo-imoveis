export const SUPABASE_URL = "https://jljkpeoxisljrseqjhgm.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_2WpGlGa2378gP9lzcbzmHA_THO_PyXx";
export const STORAGE_BUCKET = "property-images";

export const db = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);

export const adminDb = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  { auth: { storageKey: "catalogo-admin-auth" } }
);

export const advisorDb = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  { auth: { storageKey: "catalogo-advisor-auth" } }
);

export function publicImageUrl(path) {
  if (!path) return "";
  return db.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}
