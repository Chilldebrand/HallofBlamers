-- League membership is independent of having a valid Supabase Auth session.
-- No source table is exposed to PostgREST. Reviewed functions are the only API.
CREATE TABLE hob_private.memberships (
  auth_user_id uuid PRIMARY KEY,
  manager_id integer NOT NULL UNIQUE REFERENCES hob_private.managers(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hob_private.invites (
  token_hash text PRIMARY KEY,
  manager_id integer NOT NULL REFERENCES hob_private.managers(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hob_private.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hob_private.invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA hob_private FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA hob_private FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hob_private FROM anon, authenticated;

CREATE FUNCTION public.hob_viewer() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('authUserId', member.auth_user_id, 'managerId', manager.id,
    'role', CASE WHEN manager.role='commissioner' THEN 'commissioner' ELSE 'member' END)
  FROM hob_private.memberships member JOIN hob_private.managers manager ON manager.id=member.manager_id
  WHERE member.auth_user_id=auth.uid() AND member.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.hob_viewer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_viewer() TO anon, authenticated;

CREATE FUNCTION public.hob_create_invite(target_manager_id integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE token text;
BEGIN
  IF public.hob_viewer()->>'role' IS DISTINCT FROM 'commissioner' THEN
    RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501';
  END IF;
  -- Lock the target to serialize regeneration/redemption/revocation.
  PERFORM 1 FROM hob_private.managers WHERE id=target_manager_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown manager'; END IF;
  IF EXISTS (SELECT 1 FROM hob_private.memberships WHERE manager_id=target_manager_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Manager already has active membership';
  END IF;
  UPDATE hob_private.invites SET expires_at=now() WHERE manager_id=target_manager_id AND used_at IS NULL;
  token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  INSERT INTO hob_private.invites(token_hash,manager_id,expires_at)
    VALUES (encode(sha256(convert_to(token,'UTF8')),'hex'),target_manager_id,now()+interval '7 days');
  RETURN token;
END
$$;
REVOKE ALL ON FUNCTION public.hob_create_invite(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_create_invite(integer) TO authenticated;

CREATE FUNCTION public.hob_redeem_invite(token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE invitation hob_private.invites; target_id integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
  IF token IS NULL OR length(token) <> 64 THEN RAISE EXCEPTION 'Invalid or expired invitation'; END IF;
  SELECT manager_id INTO target_id FROM hob_private.invites
    WHERE token_hash=encode(sha256(convert_to(token,'UTF8')),'hex');
  IF target_id IS NULL THEN RAISE EXCEPTION 'Invalid or expired invitation'; END IF;
  PERFORM 1 FROM hob_private.managers WHERE id=target_id FOR UPDATE;
  SELECT * INTO invitation FROM hob_private.invites
    WHERE token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') FOR UPDATE;
  IF invitation.used_at IS NOT NULL OR invitation.expires_at <= now() THEN
    RAISE EXCEPTION 'Invalid or expired invitation';
  END IF;
  IF EXISTS (SELECT 1 FROM hob_private.memberships WHERE auth_user_id=auth.uid() AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Account already has active membership';
  END IF;
  IF EXISTS (SELECT 1 FROM hob_private.memberships WHERE manager_id=target_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Manager already has active membership';
  END IF;
  DELETE FROM hob_private.memberships WHERE revoked_at IS NOT NULL AND (manager_id=target_id OR auth_user_id=auth.uid());
  INSERT INTO hob_private.memberships(auth_user_id,manager_id) VALUES(auth.uid(),target_id);
  UPDATE hob_private.invites SET used_at=now() WHERE token_hash=invitation.token_hash;
  RETURN public.hob_viewer();
END
$$;
REVOKE ALL ON FUNCTION public.hob_redeem_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_redeem_invite(text) TO authenticated;

CREATE FUNCTION public.hob_revoke_member(target_manager_id integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.hob_viewer()->>'role' IS DISTINCT FROM 'commissioner' THEN
    RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501';
  END IF;
  IF (public.hob_viewer()->>'managerId')::integer=target_manager_id THEN
    RAISE EXCEPTION 'Cannot revoke your own commissioner access';
  END IF;
  PERFORM 1 FROM hob_private.managers WHERE id=target_manager_id FOR UPDATE;
  UPDATE hob_private.memberships SET revoked_at=now() WHERE manager_id=target_manager_id;
  UPDATE hob_private.invites SET expires_at=now() WHERE manager_id=target_manager_id AND used_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION public.hob_revoke_member(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hob_revoke_member(integer) TO authenticated;
