CREATE FUNCTION public.hob_shell() RETURNS jsonb
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
      'state',CASE (SELECT status FROM hob_private.sync_runs ORDER BY id DESC LIMIT 1) WHEN 'running' THEN 'running' WHEN 'error' THEN 'failed' ELSE 'idle' END,
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

CREATE FUNCTION public.hob_standings_source(requested_season integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF public.hob_viewer() IS NULL THEN RAISE EXCEPTION 'League access required' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object(
    'seasonOptions',COALESCE((SELECT jsonb_agg(jsonb_build_object('season',s.season,'status',s.status) ORDER BY s.season DESC) FROM hob_private.seasons s),'[]'::jsonb),
    'seasons',COALESCE((SELECT jsonb_agg(jsonb_build_object('season',s.season,'status',s.status,'team_count',s.team_count)) FROM hob_private.seasons s),'[]'::jsonb),
    'franchises',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'canonical_name',f.canonical_name,'active',f.active)) FROM hob_private.franchises f),'[]'::jsonb),
    'teamSeasons',COALESCE((SELECT jsonb_agg(jsonb_build_object('season',t.season,'franchise_id',t.franchise_id,'wins',t.wins,'losses',t.losses,'ties',t.ties,'points_for',t.points_for,'points_against',t.points_against,'final_standing',t.final_standing)) FROM hob_private.team_seasons t WHERE requested_season IS NULL OR t.season=requested_season),'[]'::jsonb),
    'seasonStats',COALESCE((SELECT jsonb_agg(jsonb_build_object('season',s.season,'franchise_id',s.franchise_id,'champion',s.champion,'sacko',s.sacko,'allplay_w',s.allplay_w,'allplay_l',s.allplay_l,'allplay_t',s.allplay_t,'luck_total',s.luck_total)) FROM hob_private.season_stats s WHERE requested_season IS NULL OR s.season=requested_season),'[]'::jsonb),
    'careerStats',COALESCE((SELECT jsonb_agg(jsonb_build_object('franchise_id',c.franchise_id,'wins',c.wins,'losses',c.losses,'ties',c.ties,'points_for',c.points_for,'points_against',c.points_against,'win_pct',c.win_pct,'seasons',c.seasons,'championships',c.championships,'sackos',c.sackos,'allplay_w',c.allplay_w,'allplay_l',c.allplay_l,'allplay_t',c.allplay_t,'luck_total',c.luck_total)) FROM hob_private.career_stats c),'[]'::jsonb),
    'weeks',COALESCE((SELECT jsonb_agg(jsonb_build_object('season',w.season,'week',w.week)) FROM hob_private.weeks w WHERE requested_season IS NULL OR w.season=requested_season),'[]'::jsonb),
    'weekResults',COALESCE((SELECT jsonb_agg(jsonb_build_object('franchise_id',w.franchise_id,'season',w.season,'week',w.week,'result',w.result,'margin',w.margin)) FROM hob_private.team_week w WHERE requested_season IS NULL OR w.season=requested_season),'[]'::jsonb),
    'shell',public.hob_shell()
  );
END
$$;
REVOKE ALL ON FUNCTION public.hob_standings_source(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_standings_source(integer) TO authenticated;
