import { authUser } from '../_lib/auth.js';
return { nowv, base };
}


async function quality(env, postId){
const r = await env.DB.prepare(`SELECT
AVG(CASE WHEN dwell_ms>800 THEN 1.0 ELSE 0 END) as watch_ok,
(SELECT COUNT(*) FROM reactions WHERE post_id=?) as reacts,
(SELECT COUNT(*) FROM comments WHERE post_id=?) as comms
FROM views WHERE post_id=?`).bind(postId, postId, postId).first();
const q = 0.5*(r?.watch_ok||0) + 0.3*sigmoid((r?.reacts||0)/10) + 0.2*sigmoid((r?.comms||0)/5);
return clamp(q,0,1);
}


async function social(env, postId, user){
// simple: if you follow author or many mutuals interacted
const s = await env.DB.prepare(`SELECT u.id as author, (
SELECT COUNT(*) FROM follows f WHERE f.src_id=? AND f.dst_id=u.id
) as you_follow
FROM posts p JOIN users u ON p.user_id=u.id WHERE p.id=?`).bind(user.id, postId).first();
const youFollow = s?.you_follow?1:0;
return youFollow*0.7; // MVP
}


async function trend(env, postId){
// views last 10m vs last 24h avg
const now = Date.now();
const v10 = await env.DB.prepare(`SELECT COUNT(*) as c FROM views WHERE post_id=? AND ts>?`).bind(postId, now-10*60*1000).first();
const v24 = await env.DB.prepare(`SELECT COUNT(*) as c FROM views WHERE post_id=? AND ts>?`).bind(postId, now-24*60*60*1000).first();
const perMinBase = (v24?.c||0) / (24*60) + 0.1;
const cur = (v10?.c||0) / 10;
const ratio = cur / perMinBase;
return clamp(sigmoid(0.5*ratio), 0, 1);
}


export const onRequestGet = async ({ env, request }) => {
const user = await authUser(env, request);
if(!user) return bad('unauth', 401);
const url = new URL(request.url);
const limit = Math.min(parseInt(url.searchParams.get('limit')||'30',10), 50);


// recall: recent posts 48h not by blocked
const posts = await env.DB.prepare(`SELECT p.*, u.handle, u.display_name FROM posts p JOIN users u ON p.user_id=u.id WHERE p.created_at > ? ORDER BY p.created_at DESC LIMIT 300`).bind(Date.now()-48*60*60*1000).all();


const { nowv, base } = await getUserVectors(env, user);
const pref = base || new Array(8).fill(1/8);
const mix = (v) => {
const m = new Array(8).fill(0);
for(let i=0;i<8;i++){ m[i] = 0.5*(nowv[i]||0) + 0.3*(base?.[i]||0) + 0.2*(pref?.[i]||0); }
return m;
};
const userMix = mix();


// score
const scored = [];
for(const p of posts.results){
const e = JSON.parse(p.emotion_json||'[]');
const moodMatch = cosSim(e, userMix);
const q = await quality(env, p.id);
const s = await social(env, p.id, user);
const t = await trend(env, p.id);
const score = 0.35*moodMatch + 0.25*q + 0.20*s + 0.15*t; // diversity handled client-side MVP
scored.push({ ...p, _score: score, _moodMatch: moodMatch, _q:q, _s:s, _t:t });
}
scored.sort((a,b)=> b._score - a._score);


return json({ ok:true, feed: scored.slice(0, limit) });
};