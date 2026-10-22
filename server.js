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
const cleanName=s=>String(s||'Raider').replace(/[<>\x00-\x1f]/g,'').slice(0,18)||'Raider';
function send(c,obj){if(!c||c.dead||c.socket.destroyed)return;try{let data=Buffer.from(JSON.stringify(obj));if(data.length>65535)return;let h=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);c.socket.write(Buffer.concat([h,data]))}catch(e){closeClient(c)}}
function broadcast(room,msg,except){for(let c of room.players)if(c!==except)send(c,msg)}
function roomFor(c){return c.room?rooms.get(c.room):null}
function closeClient(c){if(c.dead)return;c.dead=true;clients.delete(c);let room=roomFor(c);if(room){room.players.delete(c);if(room.host===c.id){for(let other of room.players){send(other,{t:'hostgone'});other.room=null}rooms.delete(room.code)}else{broadcast(room,{t:'leave',id:c.id});if(!room.players.size)rooms.delete(room.code)}}c.room=null;try{c.socket.destroy()}catch(e){}}
function hashPass(pass,salt){return crypto.scryptSync(pass,salt,32)}
function equalPass(pass,room){try{return crypto.timingSafeEqual(hashPass(pass,room.salt),room.hash)}catch(e){return false}}
function newCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';for(let n=0;n<30;n++){let code='';for(let i=0;i<6;i++)code+=chars[crypto.randomInt(chars.length)];if(!rooms.has(code))return code}throw Error('Cannot allocate lobby code')}
function validatePassword(m){return typeof m.password==='string'&&m.password.length>=4&&m.password.length<=32}
function welcome(c,room){c.room=room.code;room.players.add(c);send(c,{t:'welcome',id:c.id,host:room.host===c.id,map:room.map,room:room.code,players:[...room.players].filter(x=>x!==c).map(x=>({id:x.id,name:x.name}))});broadcast(room,{t:'join',id:c.id,name:c.name},c)}
function processMsg(c,m){if(!m||typeof m!=='object'||typeof m.t!=='string')return;
 if(m.t==='create'||m.t==='join'){
  if(c.room){send(c,{t:'error',message:'Already in a lobby.'});return}
  if(!validatePassword(m)){send(c,{t:'error',message:'Password must have 4–32 characters.'});return}
  c.name=cleanName(m.name);
  if(m.t==='create'){
   let code=newCode(),salt=crypto.randomBytes(16),room={code,salt,hash:hashPass(m.password,salt),map:/^[a-z]{3,12}$/.test(String(m.map))?String(m.map):'neon',players:new Set(),host:c.id,started:false};
   rooms.set(code,room);welcome(c,room);return;
  }
  let code=String(m.room||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8),room=rooms.get(code);
  if(!room){send(c,{t:'error',message:'Lobby not found. Check the code.'});return}
  if(!equalPass(m.password,room)){send(c,{t:'error',message:'Wrong lobby password.'});return}
  if(room.started){send(c,{t:'error',message:'Match already started. Ask the host to make a new lobby.'});return}
  if(room.players.size>=MAX_PLAYERS){send(c,{t:'error',message:'Lobby full (4 players maximum).'});return}
  welcome(c,room);return;
 }
 const room=roomFor(c);if(!room||!room.players.has(c))return;
 if(m.t==='start'){
  if(c.id!==room.host){send(c,{t:'error',message:'Only the host can start.'});return}
  if(room.players.size<2){send(c,{t:'error',message:'Wait for a teammate before starting.'});return}
  if(room.started)return;room.started=true;broadcast(room,{t:'start'});return;
 }
 if(!room.started)return;
 if(m.t==='state'){
  if(!Number.isFinite(m.x)||!Number.isFinite(m.y))return;
  let state={t:'state',id:c.id,name:c.name,x:Math.max(0,Math.min(6000,m.x)),y:Math.max(0,Math.min(6000,m.y)),angle:Number(m.angle)||0,hp:Number(m.hp)||0,skin:String(m.skin||'standard').slice(0,20),gun:String(m.gun||'pistol').slice(0,20),pet:String(m.pet||'none').slice(0,20),skills:m.skills&&typeof m.skills==='object'?m.skills:{}};
  broadcast(room,state,c);return;
 }
 if(m.t==='shot'){
  if(c.id===room.host)return;
  const host=[...room.players].find(x=>x.id===room.host);
  if(host&&Number.isFinite(m.angle))send(host,{t:'shot',id:c.id,angle:m.angle,gun:String(m.gun||'pistol').slice(0,20),upgrade:Math.max(0,Math.min(5,Number(m.upgrade)||0))});return;
 }
 if(m.t==='world'&&c.id===room.host){
  if(Array.isArray(m.enemies)&&m.enemies.length<=100&&Array.isArray(m.bullets)&&m.bullets.length<=500)broadcast(room,{t:'world',time:m.time,wave:m.wave,enemies:m.enemies,bullets:m.bullets,drops:m.drops||[],turrets:m.turrets||[]},c);return;
 }
 if(m.t==='reward'&&c.id===room.host){let coins=Math.max(0,Math.min(50,Math.floor(m.coins)||0));if(coins)broadcast(room,{t:'reward',coins},c);return}
 if((m.t==='hurt'||m.t==='xp')&&c.id===room.host){let dest=[...room.players].find(x=>x.id===m.to);if(dest){if(m.t==='hurt')send(dest,{t:'hurt',damage:Math.max(0,Math.min(60,Number(m.damage)||0))});else send(dest,{t:'xp',xp:Math.max(0,Math.min(100,Math.floor(m.xp)||0))})}return}
}
function decodeFrames(c,chunk){if(c.dead)return;c.buf=Buffer.concat([c.buf,chunk]);if(c.buf.length>140000){closeClient(c);return}while(c.buf.length>=2){let opcode=c.buf[0]&15,b1=c.buf[1],masked=!!(b1&128),len=b1&127,off=2;if(len===126){if(c.buf.length<4)return;len=c.buf.readUInt16BE(2);off=4}else if(len===127){closeClient(c);return}if(len>65535||!masked){closeClient(c);return}if(c.buf.length<off+4+len)return;let mask=c.buf.subarray(off,off+4),body=c.buf.subarray(off+4,off+4+len);c.buf=c.buf.subarray(off+4+len);if(opcode===8){closeClient(c);return}if(opcode===9){try{c.socket.write(Buffer.from([0x8a,0]))}catch(e){}continue}if(opcode!==1)continue;let raw=Buffer.allocUnsafe(len);for(let i=0;i<len;i++)raw[i]=body[i]^mask[i%4];try{processMsg(c,JSON.parse(raw.toString('utf8')))}catch(e){console.error('Bad client message:',e.message)}}}
const server=http.createServer((req,res)=>{
 let pathname;try{pathname=new URL(req.url,'http://localhost').pathname}catch(e){res.writeHead(400);res.end();return}
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size,players:clients.size}));return}
 if(pathname!=='/'&&pathname!=='/index.html'){res.writeHead(404);res.end('Not found');return}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(path.join(__dirname,'index.html')).pipe(res)
});
server.on('upgrade',(req,socket)=>{
 if(req.url!=='/ws'&&req.url!=='/'){socket.destroy();return}
 let key=req.headers['sec-websocket-key'];if(!key||typeof key!=='string'||!/^[-A-Za-z0-9+/=]{20,32}$/.test(key)){socket.destroy();return}
 const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 let c={id:crypto.randomBytes(8).toString('hex'),socket,room:null,name:'Raider',dead:false,buf:Buffer.alloc(0)};
 clients.add(c);socket.on('data',d=>decodeFrames(c,d));socket.on('error',()=>closeClient(c));socket.on('close',()=>closeClient(c));
});
server.listen(PORT,HOST,()=>console.log('RIFT RAIDERS online lobby server: http://localhost:'+PORT+' | players 2–4 | private password lobbies'));
