-- Supabase can default to extra_float_digits=0, which rounds float8 values
-- during JSON serialization. Preserve the original stored values in page DTOs.
ALTER FUNCTION public.hob_standings_source(integer) SET extra_float_digits TO '3';
