import assert from 'node:assert/strict';
import {shouldHydrateCreate} from './create-recovery-ui.ts';
const index='showstake:multi-create-active:mainnet:contract:alice.near';
assert.equal(shouldHydrateCreate(true,index,index),false,'an invalid or repaired draft must not relock the retry');
assert.equal(shouldHydrateCreate(true,index,'showstake:multi-create-active:mainnet:contract:bob.near'),true,'account switch must rehydrate');
assert.equal(shouldHydrateCreate(true,index,null),true,'disconnect must rehydrate');
assert.equal(shouldHydrateCreate(false,index,index),true,'normal draft initialization still loads an attempt');
console.log('PASS_LOCAL recovery editor remains unlocked during invalid draft and resets across accounts');
