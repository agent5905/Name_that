import { apiHandler, json, realtimeAnonToken } from '../_lib/api';

// This returns Supabase's browser-safe legacy anon JWT. It is deliberately
// read from a server binding so it cannot be confused with the modern API key
// used for ordinary browser HTTP calls. RLS remains the authorization boundary.
export const onRequest = apiHandler('GET', ({ env }) => Promise.resolve(
  json({ token: realtimeAnonToken(env) }),
));
