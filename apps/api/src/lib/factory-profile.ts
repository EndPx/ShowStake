export interface FactoryAccessProfile {
  schema: number;
  factoryPolicy: string;
  leafPolicy: string;
  leafSha256: string;
  leafCodeHash: string;
  canonicalFt?: string;
  providerAccount?: string;
  providerKind?: 'RHEA_MAINNET' | 'MOCK_TESTNET';
}
const LEGACY: FactoryAccessProfile = Object.freeze({schema:1,factoryPolicy:'showstake-factory-d039/1',leafPolicy:'showstake-native-usdc-rhea-review/1',leafSha256:'03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2',leafCodeHash:'CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os'});
const LINKED: FactoryAccessProfile = Object.freeze({schema:2,factoryPolicy:'showstake-factory-d039-global-ready/2',leafPolicy:'showstake-native-usdc-rhea-linked-withdraw-review/2',leafSha256:'49a591ba26a4a23d05c01cc343779f1c66aa5da0384e3a663a37f4e5edb59b70',leafCodeHash:'5xVC9cyZDeCJXpS8rhD4Hh3tNMBB4MNnvh5eYpW9y5Aw'});
/** Operator-side immutable deployment pins; never accept these from a request. */
export function parseFactoryAccessProfiles(raw?: string): Record<string,FactoryAccessProfile> {
  if (!raw) return {};
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid ACCESS_FACTORY_PROFILES');
  const out:Record<string,FactoryAccessProfile>={};
  for(const [key,row] of Object.entries(value)) {
    const network=key.startsWith('mainnet:')?'mainnet':key.startsWith('testnet:')?'testnet':null;
    if(!network||!new RegExp(`^${network}:[a-z0-9._-]+\\.${network==='mainnet'?'near':'testnet'}$`).test(key)||!row||typeof row!=='object'||Array.isArray(row))throw Error('invalid factory profile identity');
    const p=row as Record<string,unknown>;
    if(Object.keys(p).sort().join(',')!=='canonicalFt,factoryPolicy,leafCodeHash,leafPolicy,leafSha256,providerAccount,providerKind,schema'||p.schema!==3||p.factoryPolicy!=='showstake-factory-atomic-event/3'||p.leafPolicy!==(network==='mainnet'?'showstake-native-usdc-factory-rhea/3':'showstake-native-usdc-event/1')||typeof p.leafSha256!=='string'||!/^[a-f0-9]{64}$/.test(p.leafSha256)||typeof p.leafCodeHash!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.leafCodeHash))throw Error('invalid atomic factory profile');
    if(network==='mainnet'?(p.canonicalFt!=='17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'||p.providerAccount!=='contract.main.burrow.near'||p.providerKind!=='RHEA_MAINNET'):(typeof p.canonicalFt!=='string'||!p.canonicalFt.endsWith('.testnet')||typeof p.providerAccount!=='string'||!p.providerAccount.endsWith('.testnet')||p.providerKind!=='MOCK_TESTNET'))throw Error('factory network/provider mismatch');
    out[key]=Object.freeze({...p}) as unknown as FactoryAccessProfile;
  }
  return Object.freeze(out);
}
export function factoryAccessProfile(config:Record<string,unknown>, key:string, pins:Record<string,FactoryAccessProfile>={}):FactoryAccessProfile {
  const p=pins[key]??(config.schema_version===1?LEGACY:config.schema_version===2?LINKED:null);
  if(!p||config.schema_version!==p.schema||config.factory_policy_identity!==p.factoryPolicy||config.leaf_code_sha256!==p.leafSha256||config.leaf_policy_version!==p.leafPolicy||(p.schema===3&&config.atomic_event_initialization!==true))throw Error('factory release is not pinned');
  return p;
}
