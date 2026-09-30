CREATE FUNCTION public.hob_save_setting(setting_key text, setting_value text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.hob_viewer()->>'role' IS DISTINCT FROM 'commissioner' THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
 IF setting_key IS NULL OR setting_key NOT IN ('draft_date','recap_voice_notes') OR setting_value IS NULL OR length(setting_value)>12000 THEN RAISE EXCEPTION 'Invalid setting'; END IF;
 IF setting_key='draft_date' AND (setting_value !~ '^\d{4}-\d{2}-\d{2}$' OR setting_value::date < '2000-01-01'::date OR setting_value::date > '2100-12-31'::date) THEN RAISE EXCEPTION 'Invalid date'; END IF;
 INSERT INTO hob_private.app_settings(key,value_json,updated_at) VALUES(setting_key,to_jsonb(setting_value),now()) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at;
END $$;
REVOKE ALL ON FUNCTION public.hob_save_setting(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_save_setting(text,text) TO authenticated;

CREATE FUNCTION public.hob_add_manager(manager_name text, franchise integer DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE new_id integer;
BEGIN
 IF public.hob_viewer()->>'role' IS DISTINCT FROM 'commissioner' THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
 IF manager_name IS NULL OR length(trim(manager_name)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Name must be 1 to 100 characters'; END IF;
 INSERT INTO hob_private.managers(name,franchise_id,role,invite_token,created_at) VALUES(trim(manager_name),franchise,'manager',gen_random_uuid()::text,now()) RETURNING id INTO new_id;
 RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION public.hob_add_manager(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_add_manager(text,integer) TO authenticated;

CREATE FUNCTION public.hob_save_recap(recap_id integer, recap_season integer, recap_week integer, markdown text, expected_markdown text, expected_status text, operation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE existing hob_private.recaps; saved_id integer;
BEGIN
 IF public.hob_viewer()->>'role' IS DISTINCT FROM 'commissioner' THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
 IF operation IS NULL OR operation NOT IN ('save','publish','unpublish') OR markdown IS NULL OR length(markdown)>100000 THEN RAISE EXCEPTION 'Invalid recap'; END IF;
 IF operation='publish' AND length(trim(markdown))=0 THEN RAISE EXCEPTION 'A published recap cannot be empty'; END IF;
 IF recap_id IS NULL THEN
  IF operation<>'save' OR recap_week IS NULL OR recap_week NOT BETWEEN 1 AND 25 OR NOT EXISTS(SELECT 1 FROM hob_private.seasons WHERE season=recap_season) THEN RAISE EXCEPTION 'Invalid season or week'; END IF;
  PERFORM pg_advisory_xact_lock(82416,recap_season*100+recap_week);
  IF EXISTS(SELECT 1 FROM hob_private.recaps WHERE season=recap_season AND week=recap_week AND style='weekly') THEN RAISE EXCEPTION 'A weekly recap already exists. Open it to edit.'; END IF;
  INSERT INTO hob_private.recaps(season,week,style,status,facts_json,markdown_draft,created_at) VALUES(recap_season,recap_week,'weekly','draft','{}',markdown,now()) RETURNING id INTO saved_id;
 ELSE
  SELECT * INTO existing FROM hob_private.recaps WHERE id=recap_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recap not found'; END IF;
  IF existing.markdown_draft IS DISTINCT FROM expected_markdown OR existing.status IS DISTINCT FROM expected_status THEN RAISE EXCEPTION 'This recap changed. Reload before saving.'; END IF;
  UPDATE hob_private.recaps SET markdown_draft=markdown,
    status=CASE WHEN operation='publish' THEN 'published' ELSE 'edited' END,
    markdown_final=CASE WHEN operation='publish' THEN markdown ELSE markdown_final END
  WHERE id=recap_id;
  saved_id:=recap_id;
 END IF;
 RETURN saved_id;
END $$;
REVOKE ALL ON FUNCTION public.hob_save_recap(integer,integer,integer,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_save_recap(integer,integer,integer,text,text,text,text) TO authenticated;
