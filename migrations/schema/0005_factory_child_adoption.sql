-- Only the migration operator enables a reviewed factory. Application services
-- cannot create or modify trust roots; registry workers can read them.
CREATE TABLE factory_deployment_allowlist (
  network text NOT NULL CHECK (network IN ('testnet','mainnet')),
  factory_account text NOT NULL,
  factory_code_hash text NOT NULL,
  leaf_code_hash text NOT NULL,
  leaf_wasm_sha256 text NOT NULL CHECK (leaf_wasm_sha256 ~ '^[a-f0-9]{64}$'),
  leaf_policy_version text NOT NULL,
  canonical_ft text NOT NULL,
  ft_decimals smallint NOT NULL CHECK (ft_decimals = 6),
  provider_account text NOT NULL,
  provider_kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (network, factory_account)
);
REVOKE ALL ON factory_deployment_allowlist FROM PUBLIC, showstake_api, showstake_worker;
GRANT SELECT ON factory_deployment_allowlist TO showstake_worker;

-- This function constrains DB identity only. The worker must independently
-- verify finalized registry, code and keyless-child evidence before invoking it.
CREATE FUNCTION register_factory_child(
  deployment_id uuid, child_network text, factory_id text, child_id text, start_height bigint
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE trusted public.factory_deployment_allowlist%ROWTYPE;
DECLARE found public.deployments%ROWTYPE;
BEGIN
  SELECT * INTO STRICT trusted FROM public.factory_deployment_allowlist
    WHERE network = child_network AND factory_account = factory_id AND enabled;
  IF start_height < 0 OR start_height > 9007199254740991
     OR length(child_id) > 64
     OR left(child_id,16) !~ '^[a-f0-9]{16}$'
     OR substring(child_id FROM 17 FOR 1) <> '.'
     OR substring(child_id FROM 18) <> factory_id THEN
    RAISE EXCEPTION 'invalid factory child identity';
  END IF;
  INSERT INTO public.deployments
    (id,environment,network,contract_id,ft_contract_id,ft_decimals,start_block,code_hash)
    VALUES (deployment_id,child_network,child_network,child_id,trusted.canonical_ft,
            trusted.ft_decimals,start_height,trusted.leaf_code_hash)
    ON CONFLICT (network,contract_id) DO NOTHING;
  SELECT * INTO STRICT found FROM public.deployments
    WHERE network = child_network AND contract_id = child_id;
  IF found.environment <> child_network OR found.ft_contract_id <> trusted.canonical_ft
     OR found.ft_decimals <> trusted.ft_decimals OR found.code_hash <> trusted.leaf_code_hash
     OR found.start_block <> start_height THEN
    RAISE EXCEPTION 'existing deployment identity mismatch';
  END IF;
  RETURN found.id;
END;
$$;
REVOKE ALL ON FUNCTION register_factory_child(uuid,text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_factory_child(uuid,text,text,text,bigint) TO showstake_worker;
