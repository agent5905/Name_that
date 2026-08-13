-- A room is strictly bounded to 225 players and leaderboards are materialized
-- only on an explicit phase transition. Maintaining a wide ordering index on
-- every scored answer adds write amplification to the hot answer path without
-- avoiding a meaningful sort. Keep the existing players(room_id) index and
-- sort the bounded room cohort when the host requests standings.

drop index if exists public.players_room_leaderboard_idx;
