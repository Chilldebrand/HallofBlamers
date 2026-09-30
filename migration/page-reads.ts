import { writeFileSync } from 'node:fs';
import { tables, quote } from './postgres-schema';

// All SQL and projections are chosen here, never from a browser-supplied table/column.
function projection(table:string, fields?:string[]) {
 const cols=fields??tables.find(t=>t.name===table)!.columns.map(c=>c.name);
 return cols.map(quote).join(',');
}
function rows(key:string,table:string,where='',fields?:string[]) {
 return `'${key}',COALESCE((SELECT jsonb_agg(r) FROM (SELECT ${projection(table,fields)} FROM hob_private.${quote(table)} ${where}) r),'[]'::jsonb)`;
}
const safeFranchises=['id','canonical_name','manager_name','joined_season','departed_season','active','accent_color'];
const publicRecaps=['id','season','week','style','status','markdown_final','created_at'];
export function generatePageReads() {
 const common=[rows('seasons','seasons','ORDER BY season DESC',['season','status','team_count','reg_season_weeks']),rows('franchises','franchises','ORDER BY canonical_name',safeFranchises),rows('teamSeasons','team_seasons')];
 const cases:Record<string,string[]>={
  home:[rows('matchups','matchups','WHERE season=y AND week=w ORDER BY id'),rows('seasonStats','season_stats','WHERE season=y'),rows('careerStats','career_stats'),rows('beltReigns','belt_reigns','WHERE is_current'),rows('records','record_entries','WHERE rank=1'),rows('recaps','recaps',"WHERE status='published' ORDER BY season DESC,week DESC,id DESC LIMIT 1",publicRecaps)],
  matchups:[rows('weeks','weeks','WHERE season=y ORDER BY week'),rows('matchups','matchups','WHERE season=y AND week=w AND (requested_id IS NULL OR id=requested_id) ORDER BY id'),rows('rosterSlots','roster_slots','WHERE requested_id IS NOT NULL AND season=y AND week=w AND team_season_id IN (SELECT home_team_season_id FROM hob_private.matchups WHERE id=requested_id AND season=y AND week=w UNION SELECT away_team_season_id FROM hob_private.matchups WHERE id=requested_id AND season=y AND week=w)'),rows('players','players','WHERE requested_id IS NOT NULL AND espn_player_id IN (SELECT player_id FROM hob_private.roster_slots WHERE season=y AND week=w)'),rows('teamWeek','team_week','WHERE season=y AND week=w'),rows('contextNotes','context_notes','WHERE season=y AND week=w'),rows('beltMatches','belt_matches','WHERE season=y AND week=w')],
  history:[],
  franchises:[rows('careerStats','career_stats','WHERE requested_id IS NULL OR franchise_id=requested_id'),rows('seasonStats','season_stats','WHERE franchise_id=requested_id ORDER BY season DESC'),rows('eloHistory','elo_history','WHERE franchise_id=requested_id ORDER BY season,week'),rows('beltReigns','belt_reigns','WHERE franchise_id=requested_id ORDER BY reign_no DESC'),rows('records','record_entries','WHERE franchise_id=requested_id ORDER BY record_key,rank'),rows('achievements','achievements','WHERE franchise_id=requested_id ORDER BY season DESC,week DESC'),rows('h2hPairs','h2h_pairs','WHERE franchise_a=requested_id OR franchise_b=requested_id')],
  h2h:[rows('h2hPairs','h2h_pairs'),rows('matchups','matchups','WHERE requested_id IS NOT NULL AND is_final AND (home_team_season_id IN (SELECT id FROM hob_private.team_seasons WHERE franchise_id=requested_id) OR away_team_season_id IN (SELECT id FROM hob_private.team_seasons WHERE franchise_id=requested_id)) ORDER BY season DESC,week DESC')],
  seasons:[rows('seasonStats','season_stats','WHERE requested_season IS NULL OR season=y ORDER BY season DESC,final_standing NULLS LAST'),rows('weeks','weeks','WHERE season=y ORDER BY week'),rows('matchups','matchups','WHERE requested_season IS NOT NULL AND season=y ORDER BY week,id'),rows('draftPicks','draft_picks','WHERE requested_season IS NOT NULL AND season=y ORDER BY overall_pick'),rows('players','players','WHERE espn_player_id IN (SELECT player_id FROM hob_private.draft_picks WHERE season=y)')],
  records:[rows('records','record_entries','ORDER BY record_key,rank')],
  belt:[rows('beltReigns','belt_reigns','ORDER BY reign_no DESC'),rows('beltMatches','belt_matches','ORDER BY season DESC,week DESC')],
  timeline:[rows('seasonStats','season_stats'),rows('beltReigns','belt_reigns'),rows('records','record_entries','WHERE rank=1')],
  transactions:[rows('transactions','transactions','WHERE season=y ORDER BY processed_at DESC NULLS LAST,id DESC LIMIT 100 OFFSET page_offset',['id','season','type','status','bid_amount','proposed_at','processed_at']),rows('transactionItems','transaction_items','WHERE transaction_id IN (SELECT id FROM hob_private.transactions WHERE season=y ORDER BY processed_at DESC NULLS LAST,id DESC LIMIT 100 OFFSET page_offset)'),rows('players','players','WHERE espn_player_id IN (SELECT player_id FROM hob_private.transaction_items WHERE transaction_id IN (SELECT id FROM hob_private.transactions WHERE season=y ORDER BY processed_at DESC NULLS LAST,id DESC LIMIT 100 OFFSET page_offset))')],
  'what-if':[rows('teamWeek','team_week','WHERE season=y ORDER BY week')],
  recaps:[rows('recaps','recaps',"WHERE status='published' AND id IN (SELECT max(id) FROM hob_private.recaps WHERE status='published' GROUP BY season,week) AND (requested_season IS NULL OR season=y) AND (requested_week IS NULL OR week=w) ORDER BY season DESC,week DESC,id DESC",publicRecaps)],
  admin:[rows('managers','managers','ORDER BY name',['id','name','role','franchise_id','created_at']),rows('memberships','memberships','',['manager_id','revoked_at']),rows('syncRuns','sync_runs','ORDER BY id DESC LIMIT 10',['id','started_at','finished_at','tier','status','views_fetched','snapshots_new']),rows('statBuilds','stat_builds','ORDER BY id DESC LIMIT 5',['id','started_at','finished_at','status','duration_ms']),rows('settings','app_settings',"WHERE key IN ('draft_date','recap_voice_notes')",['key','value_json'])],
  'admin-recaps':[rows('recaps','recaps','WHERE requested_id IS NULL OR id=requested_id ORDER BY season DESC,week DESC,id DESC',[...publicRecaps,'markdown_draft']),rows('settings','app_settings',"WHERE key='recap_voice_notes'",['key','value_json'])],
 };
 return `-- Explicit, membership-gated projections for the active Pages routes.
CREATE OR REPLACE FUNCTION public.hob_page(page_route text, requested_season integer DEFAULT NULL, requested_week integer DEFAULT NULL, requested_id integer DEFAULT NULL, requested_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET extra_float_digits=3 AS $$
DECLARE page_result jsonb; y integer; w integer; page_offset integer;
BEGIN
 IF public.hob_viewer() IS NULL THEN RAISE EXCEPTION 'League membership required' USING ERRCODE='42501'; END IF;
 IF page_route LIKE 'admin%' AND public.hob_viewer()->>'role' IS DISTINCT FROM 'commissioner' THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
 IF requested_season IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hob_private.seasons WHERE season=requested_season) THEN RAISE EXCEPTION 'Season not found' USING ERRCODE='22023'; END IF;
 IF requested_week IS NOT NULL AND (requested_week<1 OR requested_week>25) THEN RAISE EXCEPTION 'Invalid week' USING ERRCODE='22023'; END IF;
 IF requested_offset IS NULL OR requested_offset<0 OR requested_offset>100000 THEN RAISE EXCEPTION 'Invalid offset' USING ERRCODE='22023'; END IF;
 page_offset:=requested_offset;
 y:=COALESCE(requested_season,(SELECT max(season) FROM hob_private.seasons));
 w:=COALESCE(requested_week,(SELECT min(week) FROM hob_private.matchups WHERE season=y AND NOT is_final),(SELECT max(week) FROM hob_private.matchups WHERE season=y),1);
 page_result:=jsonb_build_object('shell',public.hob_shell(),'season',y,'week',w,${common.join(',')});
 CASE page_route
 ${Object.entries(cases).map(([name,parts])=>`WHEN '${name}' THEN page_result:=page_result || ${parts.length?`jsonb_build_object(${parts.join(',')})`:`'{}'::jsonb`};`).join('\n ')}
 ELSE RAISE EXCEPTION 'Page not found' USING ERRCODE='22023';
 END CASE;
 RETURN page_result;
END $$;
REVOKE ALL ON FUNCTION public.hob_page(text,integer,integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_page(text,integer,integer,integer,integer) TO authenticated;
`;
}
if(process.argv.includes('--write')) writeFileSync('supabase/migrations/202609300005_recap_versions.sql',generatePageReads());


