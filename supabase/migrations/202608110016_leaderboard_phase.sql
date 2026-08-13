-- Enum values must commit before later migrations may reference them.
alter type public.game_phase add value if not exists 'leaderboard_displayed' before 'complete';
