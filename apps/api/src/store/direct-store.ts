import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

export type DirectResource={id:string; objectKey:string; sha256:string; title:string; mimeType:string; bytesSize:number; publishedAt:string};
export interface DirectStore {
  eventRef(network:string,contract:string,eventId:string,ft:string,hash:string):Promise<string|null>;
  issue(a:{ref:string;binding:string;nonceHash:string;passId:string;registrationId:string;codeHash:string}):Promise<{id:string;expiresAt:number}>;
  consume(a:{id:string;ref:string;nonceHash:string;passId:string;registrationId:string;codeHash:string;ownerBinding:string;organizerBinding:string;requestId:string;authExpiresAt:number}):Promise<boolean>;
  add(a:{ref:string;binding:string;id:string;objectKey:string;sha256:string;title:string;mimeType:string;bytesSize:number;authExpiresAt:number}):Promise<DirectResource>;
  list(ref:string):Promise<DirectResource[]>;
}
export class PgDirectStore implements DirectStore {
 constructor(private readonly pool:Pool) {}
 async eventRef(network:string,contract:string,eventId:string,ft:string,hash:string):Promise<string|null>{
  const q=await this.pool.query<{id:string}>(`INSERT INTO direct_event_refs(id,deployment_id,chain_event_id)
  SELECT $1,id,$4 FROM deployments WHERE network=$2 AND environment=$2 AND contract_id=$3 AND ft_contract_id=$5 AND ft_decimals=6 AND code_hash=$6
  ON CONFLICT(deployment_id,chain_event_id) DO UPDATE SET chain_event_id=EXCLUDED.chain_event_id RETURNING id`,[randomUUID(),network,contract,eventId,ft,hash]);return q.rows[0]?.id??null;
 }
 async issue(a:{ref:string;binding:string;nonceHash:string;passId:string;registrationId:string;codeHash:string}) {const id=randomUUID();const q=await this.pool.query<{expires_at:Date}>(`INSERT INTO direct_qr_challenges(id,event_ref_id,owner_binding_id,nonce_hash,chain_pass_id,chain_registration_id,code_hash,issued_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,t,t+interval '60 seconds' FROM (SELECT clock_timestamp() t) v RETURNING expires_at`,[id,a.ref,a.binding,a.nonceHash,a.passId,a.registrationId,a.codeHash]);return {id,expiresAt:q.rows[0]!.expires_at.getTime()};}
 async consume(a:{id:string;ref:string;nonceHash:string;passId:string;registrationId:string;codeHash:string;ownerBinding:string;organizerBinding:string;requestId:string;authExpiresAt:number}):Promise<boolean>{
  const q=await this.pool.query(`WITH claimed AS (UPDATE direct_qr_challenges SET used_at=clock_timestamp() WHERE id=$1 AND event_ref_id=$2 AND nonce_hash=$3 AND chain_pass_id=$4 AND chain_registration_id=$5 AND code_hash=$6 AND owner_binding_id=$7 AND used_at IS NULL AND expires_at>clock_timestamp() AND clock_timestamp() < to_timestamp($10::double precision / 1000.0) RETURNING id) INSERT INTO direct_checkin_requests(id,challenge_id,organizer_binding_id,status) SELECT $8,id,$9,'PENDING_SIGNATURE' FROM claimed RETURNING id`,[a.id,a.ref,a.nonceHash,a.passId,a.registrationId,a.codeHash,a.ownerBinding,a.requestId,a.organizerBinding,a.authExpiresAt]);return q.rowCount===1;
 }
 async add(a:{ref:string;binding:string;id:string;objectKey:string;sha256:string;title:string;mimeType:string;bytesSize:number;authExpiresAt:number}):Promise<DirectResource>{const q=await this.pool.query<{published_at:Date}>(`INSERT INTO direct_content_resources(id,event_ref_id,uploader_binding_id,object_key,sha256,title,mime_type,bytes_size) SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE clock_timestamp() < to_timestamp($9::double precision / 1000.0) RETURNING published_at`,[a.id,a.ref,a.binding,a.objectKey,a.sha256,a.title,a.mimeType,a.bytesSize,a.authExpiresAt]);if(!q.rows[0])throw new Error('chain authorization expired');return {...a,publishedAt:q.rows[0].published_at.toISOString()};}
 async list(ref:string):Promise<DirectResource[]>{const q=await this.pool.query<{id:string;object_key:string;sha256:string;title:string;mime_type:string;bytes_size:number;published_at:Date}>(`SELECT id,object_key,sha256,title,mime_type,bytes_size,published_at FROM direct_content_resources WHERE event_ref_id=$1 ORDER BY published_at,id`,[ref]);return q.rows.map(r=>({id:r.id,objectKey:r.object_key,sha256:r.sha256,title:r.title,mimeType:r.mime_type,bytesSize:r.bytes_size,publishedAt:r.published_at.toISOString()}));}
}
