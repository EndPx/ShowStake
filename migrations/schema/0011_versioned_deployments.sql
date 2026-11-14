-- Versioned identities retain historical rows, foreign keys and consumer cursors.
ALTER TABLE deployments DROP CONSTRAINT deployments_network_contract_id_key;
ALTER TABLE deployments ADD CONSTRAINT deployments_revision_unique UNIQUE(network,contract_id,code_hash);

-- Factory children retain their original one-identity rule even though shared
-- contracts may have multiple reviewed deployments at the same account.
CREATE OR REPLACE FUNCTION register_factory_child(
  deployment_id uuid, child_network text, factory_id text, child_id text, start_height bigint
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE trusted public.factory_deployment_allowlist%ROWTYPE;
DECLARE existing_row public.deployments%ROWTYPE;
BEGIN
  SELECT * INTO STRICT trusted FROM public.factory_deployment_allowlist
    WHERE network = child_network AND factory_account = factory_id AND enabled;
  IF start_height < 0 OR start_height > 9007199254740991
     OR length(child_id) > 64 OR left(child_id,16) !~ '^[a-f0-9]{16}$'
     OR substring(child_id FROM 17 FOR 1) <> '.' OR substring(child_id FROM 18) <> factory_id THEN
    RAISE EXCEPTION 'invalid factory child identity';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(child_network || ':' || child_id, 0));
  SELECT * INTO existing_row FROM public.deployments WHERE network=child_network AND contract_id=child_id;
  IF FOUND THEN
    IF (SELECT count(*) FROM public.deployments WHERE network=child_network AND contract_id=child_id) <> 1
       OR existing_row.environment <> child_network OR existing_row.ft_contract_id <> trusted.canonical_ft
       OR existing_row.ft_decimals <> trusted.ft_decimals OR existing_row.code_hash <> trusted.leaf_code_hash
       OR existing_row.start_block <> start_height THEN
      RAISE EXCEPTION 'existing deployment identity mismatch';
    END IF;
    RETURN existing_row.id;
  END IF;
  INSERT INTO public.deployments(id,environment,network,contract_id,ft_contract_id,ft_decimals,start_block,code_hash)
    VALUES(deployment_id,child_network,child_network,child_id,trusted.canonical_ft,trusted.ft_decimals,start_height,trusted.leaf_code_hash);
  RETURN deployment_id;
END;
$$;
REVOKE ALL ON FUNCTION register_factory_child(uuid,text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_factory_child(uuid,text,text,text,bigint) TO showstake_worker;
