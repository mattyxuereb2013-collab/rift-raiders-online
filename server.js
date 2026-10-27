/** RIFT RAIDERS private team server. Node.js 20+, no npm packages. */
'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const PORT=Number(process.env.PORT)||8787;
const HOST=process.env.HOST||'0.0.0.0';
const rooms=new Map();
const MAX_PLAYERS=4;
const clients=new Set();
// Fallback session leaderboard; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for permanent scores.
const scores=[];
// Most recent known RP for each player. Server cache resets on restart.
const ranks=new Map();
const rankSeason=()=>{let d=new Date();return d.getUTCFullYear()+'-Q'+(Math.floor(d.getUTCMonth()/3)+1)};
let activeRankSeason=rankSeason();
function checkRankSeason(){let current=rankSeason();if(activeRankSeason!==current){ranks.clear();activeRankSeason=current}}
const withRank=row=>{checkRankSeason();return {...row,rankPoints:ranks.has(row.name.toLowerCase())?ranks.get(row.name.toLowerCase()):null}};
const publicDbUrl=(process.env.SUPABASE_URL||'https://pziwwizieiyjpvtlkvjs.supabase.co').replace(/\/$/,'');
const publicDbKey=process.env.SUPABASE_PUBLISHABLE_KEY||'sb_publishable_Dn41VgZfEBr-wsg8EBICnQ_CseQ8f_G';
async function publicDbCall(endpoint){let r=await fetch(publicDbUrl+'/rest/v1/'+endpoint,{headers:{apikey:publicDbKey},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Public ranks unavailable: HTTP '+r.status);return r.json()}
async function accountRankRows(rows){let season=rankSeason(),[profiles,ranks]=await Promise.all([publicDbCall('raider_profiles?select=user_id,display_name&limit=1000'),publicDbCall('raider_account_ranks?select=user_id,rank_points&season=eq.'+encodeURIComponent(season)+'&limit=1000')]);let nameById=new Map(profiles.map(p=>[p.user_id,p.display_name.toLowerCase()])),byName=new Map();for(let r of ranks){let name=nameById.get(r.user_id);if(name)byName.set(name,r.rank_points)}return rows.map(row=>({...row,rankPoints:byName.has(row.name.toLowerCase())?byName.get(row.name.toLowerCase()):null}))}
async function cloudRankRows(rows){return accountRankRows(rows)}
async function cloudSaveRank(name,points,season){return dbCall('rpc/save_raider_rank',{method:'POST',body:JSON.stringify({p_name:name,p_season:season,p_rank_points:points})})}
const cleanName=s=>String(s||'Raider').replace(/[<>\x00-\x1f]/g,'').slice(0,18)||'Raider';
const dbUrl=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const dbKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const permanentScores=!!(dbUrl&&dbKey);
async function dbCall(endpoint,options={}){
 const response=await fetch(dbUrl+'/rest/v1/'+endpoint,{...options,headers:{apikey:dbKey,Authorization:'Bearer '+dbKey,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('Leaderboard database error: HTTP '+response.status);
 return response.status===204?null:response.json();
}
function jsonResponse(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}

function send(c,obj){if(!c||c.dead||c.socket.destroyed)return;if(c.socket.writableLength>65536&&['world','state','fx'].includes(obj.t))return;try{let data=Buffer.from(JSON.stringify(obj));if(data.length>65535)return;let h=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);c.socket.write(Buffer.concat([h,data]))}catch(e){closeClient(c)}}
function broadcast(room,msg,except){for(let c of room.players)if(c!==except)send(c,msg)}
function roomFor(c){return c.room?rooms.get(c.room):null}
const ALLOWED_SKILLS=new Set(['nuke','back','drones','orb','cutter','freeze','heal','lightning','shield','blackhole','rocket','meteor','flame','boomerang','explosive','pulse','haste','laserlance','frostburst','starbarrage']);
function cleanSkills(input){
 const out={};
 if(!input||typeof input!=='object'||Array.isArray(input))return out;
 for(const [key,value] of Object.entries(input)){
  if(!ALLOWED_SKILLS.has(key))continue;
  const level=Number(value);
  if(Number.isFinite(level)&&level>=1)out[key]=Math.min(5,Math.floor(level));
 }
 return out;
}


const CLUTCH_MS=30000;
function clutchFail(room){
 if(!room||!room.clutch)return;
 room.clutch=null;room.clutchCooldown=Date.now()+12000;
 broadcast(room,{t:'clutchFail'});
}
function clutchTick(room){
 if(!room||!room.started||room.players.size<2)return;
 const now=Date.now(),members=[...room.players],alive=members.filter(c=>Number(c.hp)>0);
 if(room.clutch){
  const active=room.clutch;
  if(!members.some(c=>c.id===active.survivor)||!alive.some(c=>c.id===active.survivor)){clutchFail(room);return}
  if(now>=active.endsAt){
   room.clutch=null;room.clutchCooldown=now+12000;
   for(const c of members){if(Number(c.hp)<=0){c.hp=50;send(c,{t:'clutchRevive'})}}
   broadcast(room,{t:'clutchWin',survivor:active.survivor});
  }
  return;
 }
 if(now<(room.clutchCooldown||0))return;
 if(alive.length===1&&members.some(c=>Number(c.hp)<=0)){
  room.clutch={survivor:alive[0].id,endsAt:now+CLUTCH_MS};
  broadcast(room,{t:'clutch',survivor:alive[0].id,name:alive[0].name,duration:CLUTCH_MS});
 }
}
setInterval(()=>{for(const room of rooms.values())if(room.started)clutchTick(room)},150);

function partyState(room){return {t:'party',map:room.map,players:[...room.players].map(p=>({id:p.id,name:p.name,ready:!!p.ready,host:p.id===room.host,skin:p.skin||'standard',pet:p.pet||'none'}))}}
function broadcastParty(room){broadcast(room,partyState(room))}
function closeClient(c){if(c.dead)return;c.dead=true;clients.delete(c);let room=roomFor(c);if(room){room.players.delete(c);if(room.clutch&&(room.clutch.survivor===c.id||room.players.size<2))clutchFail(room);if(room.host===c.id){for(let other of room.players){send(other,{t:'hostgone'});other.room=null}rooms.delete(room.code)}else{broadcast(room,{t:'leave',id:c.id});broadcastParty(room);if(!room.players.size)rooms.delete(room.code)}}c.room=null;try{c.socket.destroy()}catch(e){}}
function hashPass(pass,salt){return crypto.scryptSync(pass,salt,32)}
function equalPass(pass,room){try{return crypto.timingSafeEqual(hashPass(pass,room.salt),room.hash)}catch(e){return false}}
function newCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';for(let n=0;n<30;n++){let code='';for(let i=0;i<6;i++)code+=chars[crypto.randomInt(chars.length)];if(!rooms.has(code))return code}throw Error('Cannot allocate lobby code')}
function validatePassword(m){return typeof m.password==='string'&&m.password.length>=4&&m.password.length<=32}
function welcome(c,room){c.room=room.code;c.ready=false;room.players.add(c);send(c,{t:'welcome',id:c.id,host:room.host===c.id,map:room.map,room:room.code,...(room.host===c.id?{inviteToken:room.inviteToken}:{}),players:[...room.players].filter(x=>x!==c).map(x=>({id:x.id,name:x.name,ready:!!x.ready}))});broadcast(room,{t:'join',id:c.id,name:c.name,ready:false},c);broadcastParty(room)}
function processMsg(c,m){if(!m||typeof m!=='object'||typeof m.t!=='string')return;
 if(m.t==='create'||m.t==='join'){
  if(c.room){send(c,{t:'error',message:'Already in a lobby.'});return}
  if(m.t==='create'&&!validatePassword(m)){send(c,{t:'error',message:'Password must have 4–32 characters.'});return}
  c.name=cleanName(m.name);
  if(m.t==='create'){
   let code=newCode(),salt=crypto.randomBytes(16),room={code,salt,hash:hashPass(m.password,salt),inviteToken:crypto.randomBytes(24).toString('hex'),clutch:null,clutchCooldown:0,map:/^[a-z]{3,12}$/.test(String(m.map))?String(m.map):'neon',players:new Set(),host:c.id,started:false};
   rooms.set(code,room);welcome(c,room);return;
  }
  let code=String(m.room||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8),room=rooms.get(code);
  if(!room){send(c,{t:'error',message:'Lobby not found. Check the code.'});return}
  let invited=typeof m.inviteToken==='string'&&/^[0-9a-f]{48}$/.test(m.inviteToken)&&crypto.timingSafeEqual(Buffer.from(m.inviteToken,'hex'),Buffer.from(room.inviteToken,'hex'));
  if(!invited&&!validatePassword(m)){send(c,{t:'error',message:'Enter a lobby password or use a friend invitation.'});return}
  if(!invited&&!equalPass(m.password,room)){send(c,{t:'error',message:'Wrong lobby password.'});return}
  if(room.started){send(c,{t:'error',message:'Match already started. Ask the host to make a new lobby.'});return}
  if(room.players.size>=MAX_PLAYERS){send(c,{t:'error',message:'Lobby full (4 players maximum).'});return}
  welcome(c,room);return;
 }
 const room=roomFor(c);if(!room||!room.players.has(c))return;
 if(m.t==='loadout'){
  if(room.started)return;
  const skins=['standard','rookie','spider','shadow','gold','cyber','galaxy','phantom','celestial','infernoskin','glacierskin'];
  const pets=['none','dog','cat','fox','owl','wolf','dragon','phoenix','griffin','bee','turtle','bat','robot','unicorn','golem','rocketpet','hydrapet','crystalpet','omegapet'];
  c.skin=skins.includes(m.skin)?m.skin:'standard';c.pet=pets.includes(m.pet)?m.pet:'none';
  c.ready=false;broadcastParty(room);return;
 }
 if(m.t==='emote'){
  if(room.started||!['dance','wave','flex'].includes(m.emote)||Date.now()-(c.lastEmote||0)<3000)return;
  c.lastEmote=Date.now();broadcast(room,{t:'emote',id:c.id,emote:m.emote});return;
 }
 if(m.t==='ready'){
  if(room.started)return;
  c.ready=!!m.ready;
  broadcastParty(room);return;
 }
 if(m.t==='map'){
  if(room.started)return;
  if(c.id!==room.host){send(c,{t:'error',message:'Only the host can choose the map.'});return}
  const map=String(m.map||'');
  if(!/^[a-z]{3,12}$/.test(map)){send(c,{t:'error',message:'Invalid map.'});return}
  room.map=map;
  for(const player of room.players)player.ready=false;
  broadcastParty(room);return;
 }
 if(m.t==='start'){
  if(c.id!==room.host){send(c,{t:'error',message:'Only the host can start.'});return}
  if(room.players.size<2){send(c,{t:'error',message:'Wait for a teammate before starting.'});return}
  if([...room.players].some(p=>!p.ready)){send(c,{t:'error',message:'Every player must press READY first.'});return}
  if(room.started)return;room.started=true;for(const player of room.players)player.hp=100;broadcast(room,{t:'start',map:room.map});return;
 }
 if(!room.started)return;
 if(m.t==='state'){
  if(!Number.isFinite(m.x)||!Number.isFinite(m.y))return;
  let state={t:'state',id:c.id,name:c.name,x:Math.max(0,Math.min(6000,m.x)),y:Math.max(0,Math.min(6000,m.y)),angle:Number(m.angle)||0,hp:Math.max(0,Math.min(10000,Number(m.hp)||0)),skin:String(m.skin||'standard').slice(0,20),gun:String(m.gun||'pistol').slice(0,20),pet:String(m.pet||'none').slice(0,20),skills:cleanSkills(m.skills)};
  c.hp=state.hp;broadcast(room,state,c);return;
 }
 if(m.t==='shot'){
  if(c.id===room.host)return;
  const host=[...room.players].find(x=>x.id===room.host);
  if(host&&Number.isFinite(m.angle))send(host,{t:'shot',id:c.id,angle:m.angle,gun:String(m.gun||'pistol').slice(0,20),upgrade:Math.max(0,Math.min(5,Number(m.upgrade)||0))});return;
 }
 if(m.t==='fx'&&c.id===room.host){
  if(!['rocket','meteor','nuke','lightning'].includes(m.kind))return;
  if(!Number.isFinite(m.x)||!Number.isFinite(m.y))return;
  const x=Math.max(0,Math.min(6000,m.x)),y=Math.max(0,Math.min(6000,m.y));
  const radius=Math.max(0,Math.min(500,Number(m.radius)||80));
  const tx=Number.isFinite(m.tx)?Math.max(0,Math.min(6000,m.tx)):x;
  const ty=Number.isFinite(m.ty)?Math.max(0,Math.min(6000,m.ty)):y;
  broadcast(room,{t:'fx',kind:m.kind,x,y,radius,tx,ty},c);return;
 }
 if(m.t==='world'&&c.id===room.host){
  if(Array.isArray(m.enemies)&&m.enemies.length<=100&&Array.isArray(m.bullets)&&m.bullets.length<=500)broadcast(room,{t:'world',time:m.time,wave:m.wave,enemies:m.enemies,bullets:m.bullets,meteors:Array.isArray(m.meteors)?m.meteors.slice(0,15):[],drops:m.drops||[],turrets:m.turrets||[],chests:m.chests||[],event:m.event||''},c);return;
 }
 if(m.t==='reward'&&c.id===room.host){let coins=Math.max(0,Math.min(50,Math.floor(m.coins)||0));if(coins)broadcast(room,{t:'reward',coins},c);return}
 if((m.t==='hurt'||m.t==='xp'||m.t==='revive'||m.t==='bonus')&&c.id===room.host){let dest=[...room.players].find(x=>x.id===m.to);if(dest){if(m.t==='hurt')send(dest,{t:'hurt',damage:Math.max(0,Math.min(60,Number(m.damage)||0))});else if(m.t==='xp')send(dest,{t:'xp',xp:Math.max(0,Math.min(100,Math.floor(m.xp)||0))});else if(m.t==='revive')send(dest,{t:'revive'});else send(dest,{t:'bonus',kind:['coins','heal','boost'].includes(m.kind)?m.kind:'heal',amount:Math.max(0,Math.min(200,Number(m.amount)||0))})}return}
}
function decodeFrames(c,chunk){
 if(c.dead)return;
 c.buf=Buffer.concat([c.buf,chunk]);
 if(c.buf.length>140000){closeClient(c);return}
 while(c.buf.length>=2){
  const first=c.buf[0],opcode=first&15,fin=!!(first&128),b1=c.buf[1],masked=!!(b1&128);
  let len=b1&127,off=2;
  if(len===126){if(c.buf.length<4)return;len=c.buf.readUInt16BE(2);off=4}
  else if(len===127){closeClient(c);return}
  if(len>65535||!masked||((opcode===8||opcode===9||opcode===10)&&(!fin||len>125))){closeClient(c);return}
  if(c.buf.length<off+4+len)return;
  const mask=c.buf.subarray(off,off+4),body=c.buf.subarray(off+4,off+4+len);
  c.buf=c.buf.subarray(off+4+len);
  const raw=Buffer.allocUnsafe(len);
  for(let i=0;i<len;i++)raw[i]=body[i]^mask[i%4];
  if(opcode===8){closeClient(c);return}
  if(opcode===9){try{c.socket.write(Buffer.concat([Buffer.from([0x8a,raw.length]),raw]))}catch(e){closeClient(c)}continue}
  if(opcode===10)continue;
  if(opcode===1){if(c.fragmented){closeClient(c);return}c.fragmented=fin?null:[raw]}
  else if(opcode===0){if(!c.fragmented){closeClient(c);return}c.fragmented.push(raw)}
  else{closeClient(c);return}
  if(!fin)continue;
  const payload=opcode===1?raw:Buffer.concat(c.fragmented);
  c.fragmented=null;
  if(payload.length>65535){closeClient(c);return}
  try{processMsg(c,JSON.parse(payload.toString('utf8')))}
  catch(e){console.error('Bad client message:',e.message)}
 }
}

// Seasonal battle pass: 30 levels; paid unlocks are granted ONLY after a verified Stripe webhook.
const STRIPE_SECRET=process.env.STRIPE_SECRET_KEY||'';
const passMatchCooldown=new Map();
const STRIPE_WEBHOOK_SECRET=process.env.STRIPE_WEBHOOK_SECRET||'';
async function passUser(req){let auth=String(req.headers.authorization||'');if(!auth.startsWith('Bearer '))throw Error('Sign in first');let token=auth.slice(7);let r=await fetch(publicDbUrl+'/auth/v1/user',{headers:{apikey:publicDbKey,Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Session expired; sign in again');let u=await r.json();if(!u.id)throw Error('Account not found');return u}
async function passState(userId){let season=rankSeason();let rows=await dbCall('raider_battle_pass?select=xp,premium,free_claimed,premium_claimed&user_id=eq.'+encodeURIComponent(userId)+'&season=eq.'+season);return {season,xp:0,premium:false,free_claimed:[],premium_claimed:[],...(rows[0]||{}),price_eur:2,levels:30}}
function readJson(req,limit=4096){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',c=>{size+=c.length;if(size>limit){reject(Error('Request too large'));req.destroy()}else chunks.push(c)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'))}catch(e){reject(e)}});req.on('error',reject)})}
async function stripeCheckout(userId,season,origin){let body=new URLSearchParams();
body.set('mode','payment');body.set('success_url',origin+'/?battlepass=success');body.set('cancel_url',origin+'/?battlepass=cancel');
body.set('client_reference_id',userId);body.set('metadata[user_id]',userId);body.set('metadata[season]',season);
body.set('line_items[0][price_data][currency]','eur');body.set('line_items[0][price_data][unit_amount]','200');body.set('line_items[0][price_data][product_data][name]','RIFT RAIDERS Premium Battle Pass '+season);body.set('line_items[0][quantity]','1');
let r=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+STRIPE_SECRET,'Content-Type':'application/x-www-form-urlencoded'},body:body.toString(),signal:AbortSignal.timeout(10000)});let v=await r.json();if(!r.ok||!v.url)throw Error(v.error?.message||'Could not start secure checkout');return v.url}
function stripeVerify(payload,header){if(!STRIPE_WEBHOOK_SECRET||!header)return false;let t=header.match(/(?:^|,)t=(\d+)/),signatures=[...header.matchAll(/(?:^|,)v1=([a-f0-9]{64})/g)].map(m=>m[1]);if(!t||Math.abs(Date.now()/1000-Number(t[1]))>300)return false;let digest=crypto.createHmac('sha256',STRIPE_WEBHOOK_SECRET).update(t[1]+'.'+payload).digest('hex');return signatures.some(sig=>crypto.timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(digest,'hex')))}

const server=http.createServer((req,res)=>{
 let pathname;try{pathname=new URL(req.url,'http://localhost').pathname}catch(e){res.writeHead(400);res.end();return}
 if(pathname==='/battlepass/webhook'&&req.method==='POST'){
  let raw='',size=0;req.on('data',c=>{size+=c.length;if(size>65536){req.destroy();return}raw+=c.toString('utf8')});
  req.on('end',async()=>{if(!stripeVerify(raw,req.headers['stripe-signature'])){jsonResponse(res,400,{error:'Invalid payment signature'});return}
   try{let event=JSON.parse(raw),session=event.data?.object;
    if(event.type==='checkout.session.completed'&&session?.payment_status==='paid'&&session?.currency==='eur'&&session?.amount_total===200&&session?.metadata?.user_id&&session?.metadata?.season){
      await dbCall('rpc/raider_pass_activate',{method:'POST',body:JSON.stringify({p_user_id:session.metadata.user_id,p_season:session.metadata.season,p_stripe_session:session.id})});
    }
    jsonResponse(res,200,{received:true});
   }catch(e){console.error('Battle pass webhook:',e.message);jsonResponse(res,503,{error:'Payment activation will be retried'})}
  });return;
 }
 // Premium sales retired; stale clients cannot start a new checkout.
 if(pathname==='/battlepass/checkout'){jsonResponse(res,410,{error:'The premium pass has been removed. The free battle pass is available in game.'});return}
 if(pathname.startsWith('/battlepass/')&&['/battlepass/status','/battlepass/claim','/battlepass/checkout','/battlepass/match'].includes(pathname)){
  (async()=>{try{
   if(!permanentScores)throw Error('Battle Pass database not configured on server');
   const user=await passUser(req),season=rankSeason();
   if(pathname==='/battlepass/status'&&req.method==='GET'){jsonResponse(res,200,await passState(user.id));return}
   if(pathname==='/battlepass/match'&&req.method==='POST'){
    let v=await readJson(req),wave=Math.max(1,Math.min(100,Math.floor(Number(v.wave)||1))),kills=Math.max(0,Math.min(1000,Math.floor(Number(v.kills)||0))),now=Date.now();
    if(now-(passMatchCooldown.get(user.id)||0)<60000){jsonResponse(res,429,{error:'Battle Pass XP can only be earned once per minute'});return}
    passMatchCooldown.set(user.id,now);
    let earned=Math.min(100,Math.floor(15+wave*2+Math.sqrt(kills)*3));
    let xp=await dbCall('rpc/raider_pass_add_xp',{method:'POST',body:JSON.stringify({p_user_id:user.id,p_season:season,p_xp:earned})});
    jsonResponse(res,200,{xp,earned});return;
   }
   if(pathname==='/battlepass/claim'&&req.method==='POST'){let v=await readJson(req),level=Number(v.level),premium=v.track==='premium';
    if(!Number.isInteger(level)||level<1||level>30||!['free','premium'].includes(v.track))throw Error('Invalid reward');
    let granted=await dbCall('rpc/raider_pass_claim',{method:'POST',body:JSON.stringify({p_user_id:user.id,p_season:season,p_level:level,p_premium:premium})});
    jsonResponse(res,200,{granted:granted===true,level,track:v.track});return;
   }
   if(pathname==='/battlepass/checkout'&&req.method==='POST'){
    if(!STRIPE_SECRET||!STRIPE_WEBHOOK_SECRET){jsonResponse(res,503,{error:'Premium checkout is not configured yet'});return}
    let state=await passState(user.id);if(state.premium){jsonResponse(res,409,{error:'Premium already unlocked for this season'});return}
    let origin=process.env.GAME_PUBLIC_URL||'https://rift-raiders-online.onrender.com';
    jsonResponse(res,200,{url:await stripeCheckout(user.id,season,origin)});return;
   }
   jsonResponse(res,405,{error:'Method not allowed'});
  }catch(e){jsonResponse(res,/sign in|session expired/i.test(e.message)?401:400,{error:e.message})}})();return;
 }
 if(pathname==='/leaderboard'&&req.method==='GET'){
  const board=new URL(req.url,'http://localhost').searchParams.get('type')||'ranks';
  if(board==='waves'){
   const query=permanentScores?dbCall('raider_scores?select=name,wave,kills,mode&order=wave.desc,kills.desc&limit=100'):Promise.resolve([...scores].sort((a,b)=>b.wave-a.wave||b.kills-a.kills));
   query.then(rows=>jsonResponse(res,200,rows)).catch(()=>jsonResponse(res,503,{error:'Wave leaderboard unavailable'}));return;
  }
  if(board==='trophies'){
   (async()=>{try{const totals=await publicDbCall('raider_trophy_totals?select=user_id,trophies&order=trophies.desc,user_id.asc&limit=100');if(!totals.length){jsonResponse(res,200,[]);return}
   const ids=totals.map(r=>r.user_id).filter(id=>/^[0-9a-f-]{36}$/i.test(id));
   const profiles=await publicDbCall('raider_profiles?select=user_id,display_name&user_id=in.('+ids.join(',')+')');
   const names=new Map(profiles.map(p=>[p.user_id,p.display_name]));
   jsonResponse(res,200,totals.filter(r=>names.has(r.user_id)).map(r=>({name:names.get(r.user_id),trophies:Number(r.trophies)})));
   }catch(e){jsonResponse(res,503,{error:'Trophy leaderboard unavailable'})}})();return;
  }
  (async()=>{try{
   const ranked=await publicDbCall('raider_account_ranks?select=user_id,rank_points&season=eq.'+encodeURIComponent(rankSeason())+'&order=rank_points.desc,user_id.asc&limit=100');
   if(!ranked.length){jsonResponse(res,200,[]);return}
   const ids=ranked.map(r=>r.user_id).filter(id=>/^[0-9a-f-]{36}$/i.test(id));
   const profiles=await publicDbCall('raider_profiles?select=user_id,display_name&user_id=in.('+ids.join(',')+')');
   const names=new Map(profiles.map(p=>[p.user_id,p.display_name]));
   let runs=scores;
   if(permanentScores){
    const filter=profiles.map(p=>'"'+String(p.display_name).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"').join(',');
    runs=filter?await dbCall('raider_scores?select=name,wave,kills,mode&name=in.'+encodeURIComponent('('+filter+')')):[];
   }
   const byName=new Map(runs.map(r=>[r.name.toLowerCase(),r]));
   const rows=ranked.filter(r=>names.has(r.user_id)).map(r=>{const name=names.get(r.user_id);return {...(byName.get(name.toLowerCase())||{wave:0,kills:0,mode:'unplayed'}),name,rankPoints:Number(r.rank_points)||0}});
   jsonResponse(res,200,rows);
  }catch(e){console.error('Rank leaderboard:',e.message);jsonResponse(res,503,{error:'Rank leaderboard temporarily unavailable'})}})();return;
 }
 if(pathname==='/rank/history'&&req.method==='GET'){
  if(!permanentScores){jsonResponse(res,503,{error:'Rank archive requires permanent storage'});return}
  const name=cleanName(new URL(req.url,'http://localhost').searchParams.get('name'));
  const key=encodeURIComponent(name.toLowerCase());
  dbCall('raider_rank_seasons?select=season,rank_points,updated_at&player_key=eq.'+key+'&order=season.desc&limit=40')
   .then(rows=>jsonResponse(res,200,rows))
   .catch(e=>{console.error(e.message);jsonResponse(res,503,{error:'Rank archive unavailable'})});return;
 }
 if(pathname==='/rank'&&req.method==='POST'){
  let body='',done=false;req.on('data',c=>{body+=c;if(body.length>2048){done=true;req.destroy()}});
  req.on('end',()=>{if(done)return;let name,points,season;try{
    let v=JSON.parse(body);name=cleanName(v.name);points=Math.floor(Number(v.rankPoints));season=String(v.rankSeason||'');
    if(!Number.isFinite(points)||points<0||points>100000||season!==rankSeason())throw Error('Invalid rank');
   }catch(e){jsonResponse(res,400,{error:'Invalid rank progress'});return}
   if(!permanentScores){jsonResponse(res,503,{error:'Permanent rank storage is not configured'});return}
   cloudSaveRank(name,points,season).then(saved=>jsonResponse(res,200,{ok:true,rankPoints:saved,rankSeason:season}))
    .catch(e=>{console.error(e.message);jsonResponse(res,503,{error:'Rank sync unavailable; your device copy remains saved'})});
  });return;
 }
 if(pathname==='/score'&&req.method==='POST'){
  let body='',done=false;req.on('data',c=>{body+=c;if(body.length>2048){done=true;req.destroy()}});
  req.on('end',()=>{if(done)return;let name,wave,kills,mode,rankPoints,reportedSeason;
   try{let v=JSON.parse(body);name=cleanName(v.name);wave=Math.max(1,Math.min(999,Math.floor(Number(v.wave)||1)));
    kills=Math.max(0,Math.min(999999,Math.floor(Number(v.kills)||0)));mode=v.mode==='online'?'online':'offline';
    rankPoints=v.rankPoints===undefined?null:Math.max(0,Math.min(100000,Math.floor(Number(v.rankPoints)||0)));
    reportedSeason=String(v.rankSeason||'');
   }catch(e){jsonResponse(res,400,{error:'Invalid score'});return}
   checkRankSeason();
   if(rankPoints!==null&&reportedSeason===activeRankSeason)ranks.set(name.toLowerCase(),rankPoints);
   if(permanentScores){
    const saveScore=dbCall('rpc/save_best_raider_score',{method:'POST',body:JSON.stringify({p_name:name,p_wave:wave,p_kills:kills,p_mode:mode})});
    const saveRank=rankPoints!==null&&reportedSeason===rankSeason()?cloudSaveRank(name,rankPoints,reportedSeason):Promise.resolve(null);
    Promise.allSettled([saveScore,saveRank]).then(([scoreResult,rankResult])=>{
     if(scoreResult.status==='rejected')console.error('Score persistence:',scoreResult.reason?.message);
     if(rankResult.status==='rejected')console.error('Rank persistence:',rankResult.reason?.message);
     jsonResponse(res,scoreResult.status==='fulfilled'&&rankResult.status==='fulfilled'?200:503,
      {ok:scoreResult.status==='fulfilled',rankSaved:rankResult.status==='fulfilled'&&rankPoints!==null,rankPoints:rankResult.status==='fulfilled'?rankResult.value:null});
    });return;
   }
   const existing=scores.find(s=>s.name.toLowerCase()===name.toLowerCase());
   if(existing){if(wave>existing.wave||(wave===existing.wave&&kills>existing.kills))Object.assign(existing,{name,wave,kills,mode})}
   else scores.push({name,wave,kills,mode});
   scores.sort((a,b)=>b.wave-a.wave||b.kills-a.kills);scores.length=Math.min(scores.length,100);
   jsonResponse(res,200,{ok:true,rankSaved:false});
  });return;
 }
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size,players:clients.size}));return}
 const staticFiles={'/icon-192.png':['icon-192.png','image/png'],'/icon-512.png':['icon-512.png','image/png'],'/manifest.webmanifest':['manifest.webmanifest','application/manifest+json; charset=utf-8'],'/icon.svg':['icon.svg','image/svg+xml'],'/sw.js':['sw.js','application/javascript; charset=utf-8']};
 if(Object.hasOwn(staticFiles,pathname)){
  const [filename,mime]=staticFiles[pathname];
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',...(pathname==='/sw.js'?{'Service-Worker-Allowed':'/'}:{})});
  fs.createReadStream(path.join(__dirname,filename)).pipe(res);return;
 }
 if(pathname!=='/'&&pathname!=='/index.html'){res.writeHead(404);res.end('Not found');return}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(path.join(__dirname,'index.html')).pipe(res)
});
server.on('upgrade',(req,socket)=>{
 socket.setNoDelay(true);
 if(req.url!=='/ws'&&req.url!=='/'){socket.destroy();return}
 let key=req.headers['sec-websocket-key'];if(!key||typeof key!=='string'||!/^[-A-Za-z0-9+/=]{20,32}$/.test(key)){socket.destroy();return}
 const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 let c={id:crypto.randomBytes(8).toString('hex'),socket,room:null,name:'Raider',dead:false,buf:Buffer.alloc(0),fragmented:null};
 clients.add(c);socket.on('data',d=>decodeFrames(c,d));socket.on('error',()=>closeClient(c));socket.on('close',()=>closeClient(c));
});
server.listen(PORT,HOST,()=>console.log('RIFT RAIDERS online lobby server: http://localhost:'+PORT+' | players 2–4 | private password lobbies'));


