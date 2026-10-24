'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const server=fs.readFileSync('server.js','utf8');
const script=html.match(/<script>\s*\(\(\)=>\{'use strict';([\s\S]*?)<\/script>/);
test('browser game JavaScript parses',()=>{assert.ok(script,'game script found');assert.doesNotThrow(()=>new vm.Script("(()=>{'use strict';"+script[1]));});
test('server JavaScript parses',()=>assert.doesNotThrow(()=>new vm.Script(server)));
test('account features are connected to menu buttons',()=>{
for(const [id,fn] of [['profileBtn','profilesScreen'],['questsBtn','questsScreen'],['friendsBtn','friendsScreen'],['achievementsBtn','achievementsScreen'],['battlePassBtn','battlePassScreen']]){
assert.ok(html.includes('id="'+id+'"'),id+' button exists');
assert.ok(html.includes("$('"+id+"').onclick"),id+' has a click handler');
assert.ok(html.includes('function '+fn+'('),fn+' exists');
}
});
test('quests, friends, achievements and free pass use account-scoped RPCs',()=>{
for(const name of ['raider_record_match','raider_claim_quest','raider_friend_send','raider_friend_respond','raider_free_pass_claim'])assert.ok(html.includes('rpc/'+name),name);
assert.ok(html.includes('async function accountToken()'));
assert.ok(html.includes('async function accountDb('));
});
test('special Rift Titan boss event is hooked into gameplay',()=>{
assert.ok(html.includes('spawnEnemy(true,true)'));
assert.ok(html.includes('specialEvent?290'));
assert.ok(html.includes('runBossKills++'));
});
test('premium payments require verified server webhook',()=>{
assert.ok(server.includes("pathname==='/battlepass/webhook'"));
assert.ok(server.includes('stripeVerify(raw,'));
assert.ok(server.includes("session?.payment_status==='paid'"));
assert.ok(server.includes('STRIPE_WEBHOOK_SECRET'));
});
