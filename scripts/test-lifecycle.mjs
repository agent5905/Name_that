import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';

const required=(name)=>{const value=process.env[name];if(!value)throw new Error(`Missing ${name}.`);return value;};
const admin=createClient(required('VITE_SUPABASE_URL'),required('SUPABASE_SECRET_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
const hash=(value)=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code=()=>Array.from(randomBytes(5),b=>alphabet[b%alphabet.length]).join('');
const rpc=async(name,args)=>{const result=await admin.rpc(name,args);if(result.error)throw result.error;return result.data;};
const expectMarker=async(name,args,marker)=>{const result=await admin.rpc(name,args);assert(result.error?.message.includes(marker),`${name} must fail with ${marker}`);};
const pngFixture=(role)=>{const image=new PNG({width:32,height:32});for(let y=0;y<32;y+=1)for(let x=0;x<32;x+=1){const offset=(y*32+x)*4;const bright=(x+y)%2===0;image.data[offset]=role==='mystery'?(bright?18:41):(bright?229:118);image.data[offset+1]=role==='mystery'?(bright?30:58):(bright?102:198);image.data[offset+2]=role==='mystery'?(bright?48:82):(bright?76:236);image.data[offset+3]=255;}return PNG.sync.write(image,{colorType:6});};
const decodeBase64Url=(value)=>Buffer.from(value,'base64url');
const encryptReveal=async(bytes,location)=>{const key=await crypto.subtle.importKey('raw',decodeBase64Url(location.key),{name:'AES-GCM'},false,['encrypt']);return new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:decodeBase64Url(location.iv),additionalData:new TextEncoder().encode(location.aad)},key,bytes));};
const decryptReveal=async(ciphertext,location)=>{const key=await crypto.subtle.importKey('raw',decodeBase64Url(location.key),{name:'AES-GCM'},false,['decrypt']);return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64Url(location.iv),additionalData:new TextEncoder().encode(location.aad)},key,ciphertext));};
const cleanupRooms=[];const cleanupAdmins=[];const cleanupPaths=[];const cleanupLimitHashes=[];const cleanupErrors=[];
try {
  const adminSource=hash(randomBytes(32)),mediaSource=hash(randomBytes(32)),byteSource=hash(randomBytes(32));
  cleanupLimitHashes.push(adminSource,mediaSource,byteSource);
  for(let index=0;index<5;index+=1)assert.equal((await rpc('consume_admin_profile_attempt',{p_source_hash:adminSource})).allowed,true);
  assert.equal((await rpc('consume_admin_profile_attempt',{p_source_hash:adminSource})).allowed,false,'Admin identities must have a counter separate from rooms.');
  for(let index=0;index<30;index+=1)assert.equal((await rpc('consume_media_source_attempt',{p_source_hash:mediaSource})).allowed,true);
  assert.equal((await rpc('consume_media_source_attempt',{p_source_hash:mediaSource})).allowed,false,'Rotating owners must not multiply source upload attempts.');
  for(let index=0;index<50;index+=1)assert.equal((await rpc('reserve_media_source_bytes',{p_source_hash:byteSource,p_byte_size:5242880})).allowed,true);
  assert.equal((await rpc('reserve_media_source_bytes',{p_source_hash:byteSource,p_byte_size:1})).allowed,false,'Rotating owners must not multiply source bytes.');
  const adminTokenA=token(),adminTokenB=token();
  const ownerA=await rpc('create_admin_profile',{p_admin_token_hash:hash(adminTokenA)});
  const ownerB=await rpc('create_admin_profile',{p_admin_token_hash:hash(adminTokenB)});
  cleanupAdmins.push(ownerA.id,ownerB.id);
  const mutationSource=hash(randomBytes(32));cleanupLimitHashes.push(mutationSource);
  const projectBefore=(await admin.from('game_project_daily_budget').select('mutations').eq('singleton',true).maybeSingle()).data?.mutations??0;
  await expectMarker('create_game_definition',{p_admin_token_hash:hash(adminTokenB),p_source_hash:mutationSource,p_name:'',p_questions:[]},'INVALID_GAME_NAME');
  const projectAfter=(await admin.from('game_project_daily_budget').select('mutations').eq('singleton',true).maybeSingle()).data?.mutations??0;
  assert.equal(projectAfter,projectBefore,'Failed definition validation must roll back the shared mutation budget.');
  const draft=await rpc('create_game_definition',{p_admin_token_hash:hash(adminTokenA),p_source_hash:mutationSource,p_name:'Lifecycle game',p_questions:[]});
  await expectMarker('get_game_definition',{p_admin_token_hash:hash(adminTokenB),p_game_id:draft.id},'GAME_NOT_FOUND');
  await expectMarker('update_game_definition',{p_admin_token_hash:hash(adminTokenB),p_source_hash:mutationSource,p_game_id:draft.id,p_revision:1,p_name:'stolen',p_questions:[]},'GAME_NOT_FOUND');
  await expectMarker('delete_game_definition',{p_admin_token_hash:hash(adminTokenB),p_source_hash:mutationSource,p_game_id:draft.id},'GAME_NOT_FOUND');
  const pairSource=hash(randomBytes(32));cleanupLimitHashes.push(pairSource);
  const asset=randomUUID();const mysteryPath=`game-media/${ownerA.id}/${asset}-mystery.png`;const revealPath=`game-media/${ownerA.id}/${asset}-reveal.png`;
  cleanupPaths.push(mysteryPath,revealPath);
  const mysteryBytes=pngFixture('mystery'),revealBytes=pngFixture('reveal');
  assert.notDeepEqual(mysteryBytes,revealBytes,'Mystery and Reveal must be separately uploaded images.');
  const registerArgs={p_admin_token_hash:hash(adminTokenA),p_source_hash:pairSource,p_game_id:draft.id,p_mystery_path:mysteryPath,p_reveal_path:revealPath,p_mystery_mime:'image/png',p_reveal_mime:'image/png',p_mystery_bytes:mysteryBytes.byteLength,p_reveal_bytes:revealBytes.byteLength};
  const media=await rpc('register_game_media_pair',registerArgs);
  for(const[storagePath,bytes]of[[mysteryPath,mysteryBytes],[revealPath,revealBytes]]){const uploaded=await admin.storage.from('reveal-media').upload(storagePath,bytes,{contentType:'image/png',upsert:false});if(uploaded.error)throw uploaded.error;}
  await rpc('complete_game_media_pair',{p_admin_token_hash:hash(adminTokenA),p_game_id:draft.id,p_media_id:media.id});
  const budgetBefore=(await admin.from('project_media_daily_budget').select('reserved_bytes').eq('singleton',true).single()).data.reserved_bytes;
  const sourceBefore=(await admin.from('media_source_byte_limits').select('reserved_bytes').eq('source_hash',`\\x${pairSource}`).single()).data.reserved_bytes;
  const duplicateReservation=await admin.rpc('register_game_media_pair',registerArgs);
  assert(duplicateReservation.error,'Duplicate reservation must fail.');
  const budgetAfter=(await admin.from('project_media_daily_budget').select('reserved_bytes').eq('singleton',true).single()).data.reserved_bytes;
  const sourceAfter=(await admin.from('media_source_byte_limits').select('reserved_bytes').eq('source_hash',`\\x${pairSource}`).single()).data.reserved_bytes;
  assert.equal(budgetAfter,budgetBefore,'A failed media reservation must roll back the shared daily charge.');
  assert.equal(sourceAfter,sourceBefore,'A failed media reservation must roll back the source byte charge.');
  const unusedKey=randomUUID();
  const unused=await rpc('register_game_media_pair',{p_admin_token_hash:hash(adminTokenA),p_source_hash:pairSource,p_game_id:draft.id,p_mystery_path:`game-media/${ownerA.id}/${unusedKey}-mystery.png`,p_reveal_path:`game-media/${ownerA.id}/${unusedKey}-reveal.png`,p_mystery_mime:'image/png',p_reveal_mime:'image/png',p_mystery_bytes:10,p_reveal_bytes:10});
  await rpc('complete_game_media_pair',{p_admin_token_hash:hash(adminTokenA),p_game_id:draft.id,p_media_id:unused.id});
  const questions=[
    {prompt:'Mystery one',revealName:'Alex',mysteryMediaAssetId:media.id,revealMediaAssetId:media.id,funFact:'Alex builds tiny robots.',choices:[{text:'Alex',isCorrect:true},{text:'Blair',isCorrect:false}]},
    {prompt:'Mystery two',revealName:'Casey',mysteryMediaAssetId:media.id,revealMediaAssetId:media.id,funFact:'Casey has visited every continent.',choices:[{text:'Drew',isCorrect:false},{text:'Casey',isCorrect:true},{text:'Emery',isCorrect:false}]},
  ];
  const game=await rpc('update_game_definition',{p_admin_token_hash:hash(adminTokenA),p_source_hash:mutationSource,p_game_id:draft.id,p_revision:1,p_name:'Lifecycle game',p_questions:questions});
  const roomCode=code(),hostToken=token(),key=randomUUID();
  const room=await rpc('create_game_session',{p_admin_token_hash:hash(adminTokenA),p_game_id:game.id,p_code:roomCode,p_host_token_hash:hash(hostToken),p_idempotency_key:key});
  cleanupRooms.push({id:room.roomId,code:roomCode});
  const retry=await rpc('create_game_session',{p_admin_token_hash:hash(adminTokenA),p_game_id:game.id,p_code:code(),p_host_token_hash:hash(hostToken),p_idempotency_key:key});
  assert.equal(retry.roomId,room.roomId);
  await expectMarker('create_game_session',{p_admin_token_hash:hash(adminTokenA),p_game_id:game.id,p_code:code(),p_host_token_hash:hash(token()),p_idempotency_key:key},'IDEMPOTENCY_CONFLICT');
  const edited=await rpc('update_game_definition',{p_admin_token_hash:hash(adminTokenA),p_source_hash:mutationSource,p_game_id:game.id,p_revision:2,p_name:'Changed later',p_questions:[{...questions[0],funFact:'Changed after the immutable session was created.'}]});
  assert.equal(edited.revision,3);
  let host=await rpc('host_room',{p_code:roomCode,p_host_token_hash:hash(hostToken)});
  assert.equal(host.roundCount,2);assert.equal(host.gameRevision,2);assert.equal(host.gameName,'Lifecycle game');
  const lobbyPlayerToken=token();await rpc('join_room',{p_code:roomCode,p_display_name:'Lobby',p_participant_token_hash:hash(lobbyPlayerToken)});
  await rpc('host_action',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_action:'start'});
  const openJoin=await rpc('join_room',{p_code:roomCode,p_display_name:'Open',p_participant_token_hash:hash(token())});assert.equal(openJoin.eligibleFromRound,0);
  await rpc('host_action',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_action:'lock'});
  const lockedToken=token();const lockedJoin=await rpc('join_room',{p_code:roomCode,p_display_name:'Locked',p_participant_token_hash:hash(lockedToken)});assert.equal(lockedJoin.eligibleFromRound,1);
  const snapshot=await admin.from('room_snapshots').select('*').eq('room_code',roomCode).single();assert.equal(snapshot.data.eligible_participant_count,2);
  await expectMarker('submit_answer',{p_code:roomCode,p_player_id:lockedJoin.playerId,p_participant_token_hash:hash(lockedToken),p_employee_id:snapshot.data.choices[0].id},'ANSWERS_CLOSED');
  await rpc('host_action',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_action:'reveal'});
  const revealedSnapshot=await admin.from('room_snapshots').select('revealed_employee').eq('room_code',roomCode).single();
  assert.equal(revealedSnapshot.data.revealed_employee.funFact,'Alex builds tiny robots.','Saved session fun facts must remain immutable after definition edits.');
  const revealJoin=await rpc('join_room',{p_code:roomCode,p_display_name:'Reveal',p_participant_token_hash:hash(token())});assert.equal(revealJoin.eligibleFromRound,1);
  await rpc('host_action',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_action:'show_results'});
  await expectMarker('host_action',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_action:'end'},'ILLEGAL_TRANSITION');
  await rpc('host_action',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_action:'next_round'});
  host=await rpc('host_room',{p_code:roomCode,p_host_token_hash:hash(hostToken)});assert.equal(host.currentRound,1);
  for(const action of ['lock','reveal','show_results','end'])await rpc('host_action',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_action:action});
  await expectMarker('join_room',{p_code:roomCode,p_display_name:'Too late',p_participant_token_hash:hash(token())},'GAME_ENDED');
  await rpc('delete_game_definition',{p_admin_token_hash:hash(adminTokenA),p_source_hash:mutationSource,p_game_id:game.id});
  await expectMarker('get_game_definition',{p_admin_token_hash:hash(adminTokenA),p_game_id:game.id},'GAME_NOT_FOUND');
  const afterDeleteRetry=await rpc('create_game_session',{p_admin_token_hash:hash(adminTokenA),p_game_id:game.id,p_code:code(),p_host_token_hash:hash(hostToken),p_idempotency_key:key});assert.equal(afterDeleteRetry.roomId,room.roomId);
  const disposable=await rpc('create_game_definition',{p_admin_token_hash:hash(adminTokenA),p_source_hash:mutationSource,p_name:'Purge me',p_questions:[]});
  await rpc('delete_game_definition',{p_admin_token_hash:hash(adminTokenA),p_source_hash:mutationSource,p_game_id:disposable.id});
  await admin.from('games').update({deleted_at:new Date(Date.now()-2*86400000).toISOString()}).in('id',[game.id,disposable.id]);
  await rpc('cleanup_stale_studio_state',{});
  assert.equal((await admin.from('games').select('id').eq('id',disposable.id)).data.length,0,'Unreferenced deleted games must be purged.');
  assert.equal((await admin.from('games').select('id').eq('id',game.id)).data.length,1,'A retained room must protect game provenance for replay.');
  for(const storagePath of [mysteryPath,revealPath]){const retained=await admin.storage.from('reveal-media').download(storagePath);assert.equal(retained.error,null);assert((await retained.data.arrayBuffer()).byteLength>100);}
  const claimed=await rpc('claim_game_media_gc',{p_admin_token_hash:hash(adminTokenA)});
  assert(claimed.some(item=>item.id===unused.id),'Deleted definition must release unused media.');
  assert(!claimed.some(item=>item.id===media.id),'Retained sessions must protect immutable media.');
  await rpc('finalize_game_media_gc',{p_admin_token_hash:hash(adminTokenA),p_media_ids:claimed.map(item=>item.id)});
  const againToken=token(),againKey=randomUUID(),againCode=code();
  const again=await rpc('play_again_session',{p_code:roomCode,p_host_token_hash:hash(hostToken),p_new_code:againCode,p_new_host_token_hash:hash(againToken),p_idempotency_key:againKey});
  cleanupRooms.push({id:again.roomId,code:againCode});
  const againSnapshot=await admin.from('room_snapshots').select('*').eq('room_code',againCode).single();assert.equal(againSnapshot.data.phase,'lobby');assert.equal(againSnapshot.data.connected_participant_count,0);assert.equal(againSnapshot.data.submitted_answer_count,0);assert.equal(againSnapshot.data.round_count,2);
  const originalQuestion=(await admin.from('session_questions').select('id').eq('room_id',room.roomId).eq('position',1).single()).data;
  const replayQuestion=(await admin.from('session_questions').select('id').eq('room_id',again.roomId).eq('position',1).single()).data;
  const originalCrypto=await rpc('room_preload_media',{p_code:roomCode,p_round:1,p_asset_id:originalQuestion.id,p_kind:'reveal'});
  const replayCrypto=await rpc('room_preload_media',{p_code:againCode,p_round:1,p_asset_id:replayQuestion.id,p_kind:'reveal'});
  assert.notEqual(originalCrypto.key,replayCrypto.key,'Play Again must mint a fresh reveal key per session question.');
  assert.notEqual(originalCrypto.iv,replayCrypto.iv,'Play Again must mint a fresh reveal IV per session question.');
  assert.notEqual(originalCrypto.aad,replayCrypto.aad,'Play Again must bind ciphertext to the new room and question.');
  const replaySource=await admin.storage.from('reveal-media').download(replayCrypto.storagePath);if(replaySource.error)throw replaySource.error;
  const replayPlaintext=new Uint8Array(await replaySource.data.arrayBuffer());
  const replayCiphertext=await encryptReveal(replayPlaintext,replayCrypto);
  assert.deepEqual(await decryptReveal(replayCiphertext,replayCrypto),replayPlaintext);
  await assert.rejects(decryptReveal(replayCiphertext,originalCrypto),undefined,'A revealed Room A key must not decrypt Room B preload ciphertext.');
  const replayRoundZero=(await admin.from('session_questions').select('id').eq('room_id',again.roomId).eq('position',0).single()).data;
  const replayCorrect=(await admin.from('session_choices').select('id').eq('question_id',replayRoundZero.id).eq('is_correct',true).single()).data;
  await expectMarker('reveal_preload_key',{p_code:againCode,p_choice_id:replayCorrect.id},'MEDIA_NOT_REVEALED');
  await rpc('host_action',{p_code:againCode,p_host_token_hash:hash(againToken),p_action:'start'});
  await rpc('host_action',{p_code:againCode,p_host_token_hash:hash(againToken),p_action:'lock'});
  await rpc('host_action',{p_code:againCode,p_host_token_hash:hash(againToken),p_action:'reveal'});
  const released=await rpc('reveal_preload_key',{p_code:againCode,p_choice_id:replayCorrect.id});
  const replayRoundZeroCrypto=await rpc('room_preload_media',{p_code:againCode,p_round:0,p_asset_id:replayRoundZero.id,p_kind:'reveal'});
  assert.deepEqual(released,{key:replayRoundZeroCrypto.key,iv:replayRoundZeroCrypto.iv,mimeType:replayRoundZeroCrypto.mimeType,aad:replayRoundZeroCrypto.aad});
  for(const action of ['show_results','next_round','lock','reveal','show_results','end'])await rpc('host_action',{p_code:againCode,p_host_token_hash:hash(againToken),p_action:action});
  const thirdToken=token(),thirdCode=code();
  const third=await rpc('play_again_session',{p_code:againCode,p_host_token_hash:hash(againToken),p_new_code:thirdCode,p_new_host_token_hash:hash(thirdToken),p_idempotency_key:randomUUID()});
  cleanupRooms.push({id:third.roomId,code:thirdCode});
  await rpc('host_action',{p_code:thirdCode,p_host_token_hash:hash(thirdToken),p_action:'start'});
  const states=await Promise.all([roomCode,againCode,thirdCode].map(async roomCodeValue=>(await admin.from('room_snapshots').select('phase').eq('room_code',roomCodeValue).single()).data.phase));
  assert.deepEqual(states,['complete','complete','question_open']);
  await admin.from('game_mutation_limits').upsert({owner_id:ownerB.id,window_started_at:new Date().toISOString(),attempts:200});
  assert.equal((await rpc('consume_game_mutation_attempt',{p_admin_token_hash:hash(adminTokenB)})).allowed,false,'Game mutation churn must stop at the owner budget.');
  console.log('Saved-game lifecycle integration checks passed (explicit Mystery/Reveal PNG pair, transactional budget rollback, session-scoped reveal crypto, phase-gated key release, A/B finished, C active, delete-safe media, owners, drafts, variable choices, immutable sessions/fun facts, late joins, finality, idempotency, play again).');
} finally {
  for(const room of cleanupRooms){const snapshotDelete=await admin.from('room_snapshots').delete().eq('room_code',room.code);if(snapshotDelete.error)cleanupErrors.push(`snapshot ${room.code}: ${snapshotDelete.error.message}`);const roomDelete=await admin.from('rooms').delete().eq('id',room.id);if(roomDelete.error)cleanupErrors.push(`room ${room.code}: ${roomDelete.error.message}`);}
  for(const owner of cleanupAdmins){const deleted=await admin.from('admin_profiles').delete().eq('id',owner);if(deleted.error)cleanupErrors.push(`admin ${owner}: ${deleted.error.message}`);}
  if(cleanupPaths.length){const removed=await admin.storage.from('reveal-media').remove(cleanupPaths);if(removed.error)cleanupErrors.push(`media objects: ${removed.error.message}`);}
  for(const sourceHash of cleanupLimitHashes){const encoded=`\\x${Buffer.from(sourceHash,'hex').toString('hex')}`;for(const table of ['admin_profile_creation_limits','media_source_upload_limits','media_source_byte_limits','game_source_daily_budgets']){const deleted=await admin.from(table).delete().eq('source_hash',encoded);if(deleted.error)cleanupErrors.push(`${table}: ${deleted.error.message}`);}}
  if(cleanupRooms.length){const roomIds=cleanupRooms.map(room=>room.id),roomCodes=cleanupRooms.map(room=>room.code);const roomsLeft=await admin.from('rooms').select('*',{count:'exact',head:true}).in('id',roomIds);const snapshotsLeft=await admin.from('room_snapshots').select('*',{count:'exact',head:true}).in('room_code',roomCodes);if(roomsLeft.error||roomsLeft.count!==0)cleanupErrors.push(`room verification: ${roomsLeft.error?.message??`${roomsLeft.count} remain`}`);if(snapshotsLeft.error||snapshotsLeft.count!==0)cleanupErrors.push(`snapshot verification: ${snapshotsLeft.error?.message??`${snapshotsLeft.count} remain`}`);}
  if(cleanupAdmins.length){const adminsLeft=await admin.from('admin_profiles').select('*',{count:'exact',head:true}).in('id',cleanupAdmins);if(adminsLeft.error||adminsLeft.count!==0)cleanupErrors.push(`admin verification: ${adminsLeft.error?.message??`${adminsLeft.count} remain`}`);}
  for(const storagePath of cleanupPaths){const remaining=await admin.storage.from('reveal-media').download(storagePath);if(!remaining.error)cleanupErrors.push(`media verification: ${storagePath} remains`);}
  if(cleanupErrors.length){console.error(`Lifecycle cleanup failed: ${cleanupErrors.join('; ')}`);process.exitCode=1;}else console.log(`Lifecycle cleanup verified (${cleanupRooms.length} rooms, ${cleanupAdmins.length} admin profiles, ${cleanupPaths.length} media objects, ${cleanupLimitHashes.length} source identities removed).`);
}
