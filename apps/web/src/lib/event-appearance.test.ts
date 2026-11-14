import assert from 'node:assert/strict';
import {COVER_TEMPLATES,DEFAULT_EVENT_APPEARANCE,DEFAULT_EVENT_COVER,decodeEventDetails,encodeEventDetails,eventThemeVariables,normalizeAppearance,readableThemeText,safeEventCover,shuffleEventAppearance} from './event-appearance.ts';
import {eventRulesPreview} from './mainnet-event-preview.ts';
const custom={style:'grid',color:'#385fd1',font:'mono',mode:'dark'} as const;
const description='Guests check in with the organizer.\nNo-show commitments are shared by attendees. \u{1F39F}\uFE0F';
const packed=encodeEventDetails(description,custom,COVER_TEMPLATES[1].url)!;
assert.ok(packed);assert.deepEqual(decodeEventDetails(packed),{description,appearance:custom,cover:COVER_TEMPLATES[1].url});
assert.deepEqual(decodeEventDetails('Legacy attendance rules'),{description:'Legacy attendance rules',appearance:null,cover:null});
assert.equal(decodeEventDetails('ShowStake event metadata v1\n{broken').appearance,null);
const injection='ShowStake event metadata v1\n'+JSON.stringify({description:'Keep rules',appearance:{style:'url(javascript:bad)',color:'red;position:fixed',mode:'dark',font:'evil'},cover:DEFAULT_EVENT_COVER});
assert.deepEqual(decodeEventDetails(injection).appearance,{...DEFAULT_EVENT_APPEARANCE,mode:'dark'});
for(const url of ['javascript:alert(1)','data:image/svg+xml,<svg/>','http://example.com/cover.png','https://name:password@example.com/a','/api/private/secret','//evil.test/p.png'])assert.equal(safeEventCover(url),null,url);
assert.equal(safeEventCover('https://example.com/cover.webp'),'https://example.com/cover.webp');
assert.equal(encodeEventDetails('',custom,DEFAULT_EVENT_COVER),null);
assert.equal(encodeEventDetails('a'.repeat(8192),custom,DEFAULT_EVENT_COVER),null);
assert.equal(encodeEventDetails('\u{1F39F}\uFE0F'.repeat(2000),custom,DEFAULT_EVENT_COVER),null);
for(const cover of COVER_TEMPLATES){const next=shuffleEventAppearance(DEFAULT_EVENT_APPEARANCE,cover.url,()=>.99);assert.notEqual(next.cover,cover.url);assert.notEqual(next.appearance.style,'minimal');assert.equal(next.appearance.color,DEFAULT_EVENT_APPEARANCE.color);}
assert.deepEqual(normalizeAppearance(null),DEFAULT_EVENT_APPEARANCE);
assert.equal(readableThemeText('#000000'),'#ffffff');assert.equal(readableThemeText('#ffffff'),'#04142b');
const vars=eventThemeVariables(custom);assert.equal(vars.colorScheme,'dark');assert.equal(vars['--event-heading-font'],'ui-monospace, monospace');assert.match(vars['--theme-primary']!,/^#[0-9a-f]{6}$/);
// The appearance is carried through the existing rules/transaction ABI, with no money or timing field added.
const form={event_id:'event-theme',title:'Community meetup',location:'Jakarta',rules_text:packed,deposit:'2000000',capacity:'5',reg_open:'2026-12-01T12:00',reg_close:'2026-12-02T12:00',checkin_open:'2026-12-02T12:00',checkin_close:'2026-12-02T14:00'};
const proposal=eventRulesPreview(form)!;assert.ok(proposal);assert.equal(proposal.args.rules.deposit,'2000000');assert.equal(proposal.args.rules.capacity,5);assert.equal(proposal.args.rules.rules_text,packed);assert.equal(decodeEventDetails(proposal.args.rules.rules_text).description,description);assert.equal(Object.keys(proposal.args.rules).length,11);
console.log('PASS_LOCAL appearance round-trip, legacy rules, malformed metadata, image URL denial, UTF8 bounds, shuffle, dark/font variables and unchanged create ABI');
