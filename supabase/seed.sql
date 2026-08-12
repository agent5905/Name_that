insert into public.employees(slug, display_name, team, fun_fact, storage_path) values
  ('jordan-brooks', 'Jordan Brooks', 'Customer Success', 'Keeps a tiny notebook of surprisingly good sandwich ideas.', 'portraits/jordan-brooks.webp'),
  ('mateo-alvarez', 'Mateo Alvarez', 'Engineering', 'Can identify most songs from the first two seconds.', 'portraits/mateo-alvarez.webp'),
  ('maya-chen', 'Maya Chen', 'Design', 'Has visited a botanical garden in every city she has lived in.', 'portraits/maya-chen.webp'),
  ('priya-shah', 'Priya Shah', 'Operations', 'Once won a neighborhood trivia night with a tie-breaker about clouds.', 'portraits/priya-shah.webp')
on conflict (slug) do update set display_name = excluded.display_name, team = excluded.team,
  fun_fact = excluded.fun_fact, storage_path = excluded.storage_path, active = true;
