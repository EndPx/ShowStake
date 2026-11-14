// Conservative operational preflight for the exact two-action self-upgrade.
// It is not a protocol-enforced max fee: the gas price can change after reading.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const integer=(value,label)=>{
  assert.ok((typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)) || (typeof value==='number'&&Number.isSafeInteger(value)&&value>=0) || (typeof value==='bigint'&&value>=0n),`invalid ${label}`);
  return BigInt(value);
};
const triple=(value,label)=>{
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value),`missing ${label}`);
  assert.deepEqual(Object.keys(value).sort(),['execution','send_not_sir','send_sir'],`unknown ${label} fields`);
  return integer(value.execution,`${label}.execution`)+integer(value.send_not_sir,`${label}.send_not_sir`)+integer(value.send_sir,`${label}.send_sir`);
};

export function calculateSharedUpgradeFeeBound({transactionCosts,gasPrice,wasmBytes,initializerMethod,initializerArgs,attachedGas}) {
  assert.ok(transactionCosts&&typeof transactionCosts==='object'&&!Array.isArray(transactionCosts),'missing transaction costs');
  assert.deepEqual(Object.keys(transactionCosts).sort(),[
    'action_creation_config','action_receipt_creation_config','burnt_gas_reward',
    'data_receipt_creation_config','ml_dsa_65_verification_cost',
    'pessimistic_gas_price_inflation_ratio','storage_usage_config',
  ],'unknown transaction cost schema');
  assert.ok(Buffer.isBuffer(wasmBytes)||wasmBytes instanceof Uint8Array,'Wasm bytes required');
  assert.ok(wasmBytes.length>0,'empty Wasm');
  assert.ok(typeof initializerMethod==='string'&&initializerMethod.length>0,'initializer method required');
  assert.ok(Buffer.isBuffer(initializerArgs)||initializerArgs instanceof Uint8Array,'encoded initializer args required');
  const a=transactionCosts.action_creation_config;
  assert.ok(a&&typeof a==='object'&&!Array.isArray(a),'missing action cost config');
  const d=transactionCosts.data_receipt_creation_config;
  assert.ok(d&&typeof d==='object'&&!Array.isArray(d),'missing data receipt config');
  assert.deepEqual(Object.keys(d).sort(),['base_cost','cost_per_byte'],'unknown data receipt schema');
  const ratio=transactionCosts.pessimistic_gas_price_inflation_ratio;
  assert.ok(Array.isArray(ratio)&&ratio.length===2,'invalid price inflation ratio');
  const numerator=integer(ratio[0],'inflation numerator'),denominator=integer(ratio[1],'inflation denominator');
  assert.ok(denominator>0n&&numerator>0n,'invalid inflation ratio');
  const gas=integer(attachedGas,'attached gas'),price=integer(gasPrice,'gas price');
  assert.ok(gas>0n&&price>0n,'zero gas or gas price');
  // Sum both send variants plus execution for every cost: deliberately larger
  // than a self-receipt. Four action receipts and two refund transfers/data
  // receipts provide bounded overhead for this reviewed no-promise initializer.
  const methodBytes=BigInt(Buffer.byteLength(initializerMethod,'utf8')+initializerArgs.length);
  const base=gas
    +4n*triple(transactionCosts.action_receipt_creation_config,'action receipt')
    +2n*triple(d.base_cost,'data receipt base')
    +2048n*triple(d.cost_per_byte,'data receipt bytes')
    +2n*triple(a.transfer_cost,'refund transfer')
    +triple(a.deploy_contract_cost,'deploy base')
    +BigInt(wasmBytes.length)*triple(a.deploy_contract_cost_per_byte,'deploy bytes')
    +triple(a.function_call_cost,'function base')
    +methodBytes*triple(a.function_call_cost_per_byte,'function bytes');
  const inflatedPrice=(price*(numerator>denominator?numerator:denominator)+denominator-1n)/denominator;
  // Additional 2x gas margin covers estimation conservatism; this remains an
  // operational estimate, not a bound on later protocol/market changes.
  const boundedGas=base*2n,fee=boundedGas*inflatedPrice;
  return {baseGas:base.toString(),boundedGas:boundedGas.toString(),observedGasPrice:price.toString(),inflatedGasPrice:inflatedPrice.toString(),maxFeeAtomic:fee.toString(),gasMarginMultiplier:'2',protocolInflationNumerator:numerator.toString(),protocolInflationDenominator:denominator.toString()};
}

export function requireFeeWithinLimit(input,limit) {
  const result=calculateSharedUpgradeFeeBound(input);
  assert.ok(BigInt(result.maxFeeAtomic)<=integer(limit,'approved maximum'),'fee bound exceeds approved maximum');
  return result;
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&process.argv[2]==='--self-test') {
  const config=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  const input={transactionCosts:config.runtime_config.transaction_costs,gasPrice:'100000000',wasmBytes:Buffer.alloc(276035),initializerMethod:'migrate_empty_create',initializerArgs:Buffer.from('{}'),attachedGas:'10000000000000'};
  const maximum='10000000000000000000000';
  const normal=requireFeeWithinLimit(input,maximum);
  assert.throws(()=>requireFeeWithinLimit({...input,gasPrice:'200000000'},maximum),/fee bound exceeds/);
  const expensive=structuredClone(input.transactionCosts);expensive.action_creation_config.deploy_contract_cost_per_byte.execution=1000000000;
  assert.throws(()=>requireFeeWithinLimit({...input,transactionCosts:expensive},maximum),/fee bound exceeds/);
  const malformed=structuredClone(input.transactionCosts);malformed.action_receipt_creation_config.execution='1.5';
  assert.throws(()=>calculateSharedUpgradeFeeBound({...input,transactionCosts:malformed}),/invalid/);
  assert.throws(()=>calculateSharedUpgradeFeeBound({...input,transactionCosts:{...input.transactionCosts,unreviewed_cost:1}}),/unknown/);
  console.log(JSON.stringify({status:'PASS_LOCAL',tests:5,normal}));
}
