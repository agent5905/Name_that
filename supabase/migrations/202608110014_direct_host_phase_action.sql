-- Live phase cues are latency-sensitive. This narrowly exposed wrapper removes
-- the Pages proxy hop while preserving the authoritative, row-locked state
-- machine and its 256-bit host capability check.
create or replace function public.host_action_direct(
  p_code text,
  p_host_token text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected bytea;
  v_supplied bytea;
begin
  if p_code is null or p_host_token is null or p_action is null
    or p_code !~ '^[A-HJ-NP-Z2-9]{5}$'
    or p_host_token !~ '^[A-Za-z0-9_-]{43}$'
    or p_action not in ('start','lock','reveal','show_results','next_round','end') then
    raise exception using errcode = '22023', message = 'INVALID_INPUT';
  end if;
  v_supplied := extensions.digest(p_host_token, 'sha256');
  select r.host_token_hash into v_expected from public.rooms r where r.code = p_code;
  if not found or v_expected is distinct from v_supplied then
    raise exception using errcode = '42501', message = 'HOST_UNAUTHORIZED';
  end if;
  return public.host_action(p_code, pg_catalog.encode(v_supplied, 'hex'), p_action);
end;
$$;

revoke all on function public.host_action_direct(text,text,text) from public;
grant execute on function public.host_action_direct(text,text,text) to anon, authenticated;
