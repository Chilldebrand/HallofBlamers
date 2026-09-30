CREATE OR REPLACE FUNCTION public.hob_shell() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE viewer jsonb; result jsonb;
BEGIN
  viewer := public.hob_viewer();
  IF viewer IS NULL THEN RAISE EXCEPTION 'League access required' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('viewer',viewer,'managerName',m.name,'franchiseName',f.canonical_name,
    'flags',jsonb_build_object(
      'viewerFranchiseId',m.franchise_id,
      'championFranchiseId',(SELECT ss.franchise_id FROM hob_private.season_stats ss WHERE ss.champion AND ss.season=(SELECT max(season) FROM hob_private.seasons WHERE status='complete') LIMIT 1),
      'sackoFranchiseId',(SELECT ss.franchise_id FROM hob_private.season_stats ss WHERE ss.sacko AND ss.season=(SELECT max(season) FROM hob_private.seasons WHERE status='complete') LIMIT 1),
      'beltHolderFranchiseId',(SELECT b.franchise_id FROM hob_private.belt_reigns b WHERE b.is_current LIMIT 1)
    ),'sync',jsonb_build_object(
      'state',CASE (SELECT status FROM hob_private.sync_runs ORDER BY id DESC LIMIT 1) WHEN 'running' THEN 'running' WHEN 'failed' THEN 'failed' WHEN 'partial' THEN 'failed' WHEN 'auth_failed' THEN 'failed' ELSE 'idle' END,
      'lastSuccessAt',(SELECT max(finished_at) FROM hob_private.sync_runs WHERE status='ok'),
      'generationId',(SELECT id::text FROM hob_private.stat_builds WHERE status='ok' ORDER BY id DESC LIMIT 1)
    )) INTO result
  FROM hob_private.managers m LEFT JOIN hob_private.franchises f ON f.id=m.franchise_id
  WHERE m.id=(viewer->>'managerId')::integer;
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION public.hob_shell() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_shell() TO authenticated;


-- Compact computation projections. Original ESPN snapshots remain immutable.
CREATE TABLE hob_private.cloud_snapshot_cache (
 snapshot_id integer PRIMARY KEY REFERENCES hob_private.snapshots(id),
 version integer NOT NULL,
 payload text NOT NULL
);
ALTER TABLE hob_private.cloud_snapshot_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hob_private.cloud_snapshot_cache FROM PUBLIC,anon,authenticated;
