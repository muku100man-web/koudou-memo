/* 行動メモ — 記録はすべてこの端末の IndexedDB に保存する。
   外部と通信するのは「現在地」ボタンで住所を調べるときだけ（緯度・経度を住所検索サービスに送る）。 */
(function(){
"use strict";
const APP_VERSION = "1.0.1";
const DEFAULT_PLACES = ["リサイクルセンター","北西粗大","大安粗大","藤原粗大"];
const DEFAULT_QUICK  = ["約束","覚え","いただきもの"];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const hm  = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2));
const WD = ["日","月","火","水","木","金","土"];
const lines = s => s.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
const toInput = ms => { const d=new Date(ms); return `${ymd(d)}T${hm(d)}`; };
const fromInput = s => { const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s||""); return m ? new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5]).getTime() : NaN; };

const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;

/* ---------- IndexedDB ---------- */
const idb = {
  db:null,
  open(){
    return new Promise((ok,ng)=>{
      const r = indexedDB.open("koudou-memo",1);
      r.onupgradeneeded = ()=>{ const d=r.result;
        d.createObjectStore("records",{keyPath:"id"});
        d.createObjectStore("images",{keyPath:"id"});
        d.createObjectStore("meta"); };
      r.onsuccess = ()=>{ this.db=r.result; ok(); };
      r.onerror = ()=>ng(r.error);
    });
  },
  tx(store, mode, fn){
    return new Promise((ok,ng)=>{
      const t = this.db.transaction(store, mode); let out;
      const s = Array.isArray(store) ? store.map(n=>t.objectStore(n)) : t.objectStore(store);
      const r = fn(s); if(r && "onsuccess" in r) r.onsuccess = ()=>{ out=r.result; };
      t.oncomplete = ()=>ok(out); t.onerror = ()=>ng(t.error); t.onabort = ()=>ng(t.error);
    });
  },
  all(store){ return this.tx(store,"readonly",s=>s.getAll()); },
  get(store,key){ return this.tx(store,"readonly",s=>s.get(key)); },
  put(store,val,key){ return this.tx(store,"readwrite",s=>key===undefined?s.put(val):s.put(val,key)); },
  del(store,key){ return this.tx(store,"readwrite",s=>s.delete(key)); },
};
const meta = { get:k=>idb.get("meta",k), set:(k,v)=>idb.put("meta",v,k) };

/* ---------- state ---------- */
let records = [];
let places = DEFAULT_PLACES.slice();
let quick  = DEFAULT_QUICK.slice();
let tab = "list";
let month = (()=>{ const d=new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
const imgURL = new Map();             // 画像ID → 表示用URL
async function urlFor(id){
  if(imgURL.has(id)) return imgURL.get(id);
  const rec = await idb.get("images",id).catch(()=>null); if(!rec) return "";
  const u = URL.createObjectURL(rec.blob); imgURL.set(id,u); return u;
}
async function hydrate(root){
  for(const img of root.querySelectorAll("img[data-img]")){
    const u = await urlFor(img.dataset.img); if(u) img.src = u;
  }
}

/* ---------- toast ---------- */
let toastTimer = null, toastDone = null;
function toast(msg, actLabel, act, ms=3200){
  if(toastDone){ const f=toastDone; toastDone=null; f(); }
  clearTimeout(toastTimer);
  $("#toastMsg").textContent = msg;
  const b = $("#toastAct");
  if(actLabel){ b.textContent = actLabel; b.hidden = false; b.onclick = ()=>{ clearTimeout(toastTimer); toastDone=null; $("#toast").hidden=true; act(); }; }
  else b.hidden = true;
  $("#toast").hidden = false;
  toastTimer = setTimeout(()=>{ $("#toast").hidden = true; if(toastDone){ const f=toastDone; toastDone=null; f(); } }, ms);
}

/* ---------- render ---------- */
function paintToday(){ const n=new Date(); $("#today").textContent = `${n.getMonth()+1}月${n.getDate()}日(${WD[n.getDay()]})`; }
function dayLabel(key){
  const [y,m,d] = key.split("-").map(Number); const dt = new Date(y,m-1,d);
  const now = new Date(); const t = ymd(now); const yst = ymd(new Date(now.getFullYear(),now.getMonth(),now.getDate()-1));
  const rel = key===t ? "今日" : key===yst ? "きのう" : "";
  const s = `${y!==now.getFullYear()?y+"年":""}${m}月${d}日(${WD[dt.getDay()]})`;
  return `${s}${rel?` <span class="rel">${rel}</span>`:""}`;
}

function render(){
  document.querySelectorAll(".tabs button").forEach(b=>b.setAttribute("aria-selected", String(b.dataset.tab===tab)));
  $("#listView").hidden = tab!=="list";
  $("#monthView").hidden = tab!=="month";
  if(tab==="list") renderList(); else renderMonth();
}

function recHTML(r){
  const d = new Date(r.at);
  const isReport = r.place && places.includes(r.place);
  const pl = r.place ? `<div class="place">${esc(r.place)}${isReport?`<span class="badge">報告</span>`:""}</div>` : (r.memo ? "" : `<div class="place none">（場所なし）</div>`);
  return `<li><button class="rec" data-id="${esc(r.id)}">
    <span class="time">${hm(d)}</span>
    <span class="rbody">${pl}
      ${r.memo?`<div class="memo">${esc(r.memo)}</div>`:""}
      ${r.address?`<div class="addr">${ICON_PIN}<span>${esc(r.address)}</span></div>`:(r.lat!=null?`<div class="addr">${ICON_PIN}<span>位置のみ記録</span></div>`:"")}
      ${(r.images||[]).length?`<div class="thumbs">${r.images.map(id=>`<img data-img="${esc(id)}" alt="">`).join("")}</div>`:""}
    </span></button></li>`;
}

function renderList(){
  const el = $("#listView");
  if(!records.length){
    el.innerHTML = `<div class="empty">${ICON_PIN}<p class="big">まだ記録がありません</p><p>下の「記録する」から、行った場所や<br>やったことを一言で残せます。</p></div>`;
    return;
  }
  const sorted = [...records].sort((a,b)=>b.at-a.at || (b.createdAt||0)-(a.createdAt||0));
  const groups = new Map();
  for(const r of sorted){ const k=ymd(new Date(r.at)); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(r); }
  let html = "";
  for(const [k,list] of groups){
    list.sort((a,b)=>a.at-b.at || (a.createdAt||0)-(b.createdAt||0));   // 1日の中は朝→夜の順
    html += `<section class="day"><h2>${dayLabel(k)}</h2><ol class="cards">${list.map(recHTML).join("")}</ol></section>`;
  }
  el.innerHTML = html;
  hydrate(el);
}

function monthData(){
  const y = month.getFullYear(), m = month.getMonth();
  const inMonth = records.filter(r=>{ const d=new Date(r.at); return d.getFullYear()===y && d.getMonth()===m; });
  const days = new Map();                      // 日付 → その日に行った報告対象の場所
  const counts = Object.fromEntries(places.map(p=>[p,new Set()]));
  for(const r of inMonth){
    if(!r.place || !places.includes(r.place)) continue;
    const k = ymd(new Date(r.at));
    if(!days.has(k)) days.set(k,new Set());
    days.get(k).add(r.place); counts[r.place].add(k);
  }
  const rows = [...days.keys()].sort().map(k=>{
    const [yy,mm,dd] = k.split("-").map(Number);
    const ps = places.filter(p=>days.get(k).has(p));     // 設定の並び順にそろえる
    return { label:`${mm}/${dd}(${WD[new Date(yy,mm-1,dd).getDay()]})`, mm, dd, ps };
  });
  return { y, m, total:inMonth.length, rows, counts };
}

function renderMonth(){
  const el = $("#monthView");
  const { y, m, total, rows, counts } = monthData();
  const now = new Date(); const isThis = y===now.getFullYear() && m===now.getMonth();
  el.innerHTML = `
    <div class="monthnav">
      <button type="button" id="prevM" aria-label="前の月">‹</button>
      <h2>${y}年${m+1}月</h2>
      <button type="button" id="nextM" aria-label="次の月" ${isThis?"disabled":""}>›</button>
    </div>
    <div class="counts">${places.map(p=>`<div class="count"><div class="nm">${esc(p)}</div><div class="v">${counts[p].size}<small>日</small></div></div>`).join("")}</div>
    <div class="report">
      ${rows.length ? `<table><thead><tr><th>日付</th><th>行った場所</th></tr></thead><tbody>
        ${rows.map(r=>`<tr><td>${r.label}</td><td>${r.ps.map(esc).join("、")}</td></tr>`).join("")}
      </tbody></table>` : `<p class="none">この月は、報告に使う場所の記録がありません</p>`}
    </div>
    ${rows.length?`<button type="button" class="copybtn" id="copyBtn">表をコピー（Excelに貼りつけ用）</button>`:""}
    <p class="note">この月の記録は全部で ${total} 件です。報告に使う場所は「設定」で変えられます。</p>`;
  $("#prevM").onclick = ()=>{ month = new Date(y, m-1, 1); renderMonth(); };
  $("#nextM").onclick = ()=>{ month = new Date(y, m+1, 1); renderMonth(); };
  const cb = $("#copyBtn");
  if(cb) cb.onclick = ()=>{
    const text = rows.map(r=>`${y}/${r.mm}/${r.dd}\t${r.ps.join("、")}`).join("\n");
    copyText(text).then(ok=>toast(ok ? "コピーしました。Excelに貼りつけできます" : "コピーできませんでした"));
  };
}

async function copyText(text){
  try{ await navigator.clipboard.writeText(text); return true; }
  catch(e){
    const ta = document.createElement("textarea"); ta.value=text; ta.setAttribute("readonly",""); ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0,text.length);
    let ok=false; try{ ok=document.execCommand("copy"); }catch(_){}
    ta.remove(); return ok;
  }
}

/* ---------- sheets ---------- */
let openSheetEl = null;
function showSheet(el){
  openSheetEl = el; el.hidden = false; $("#scrim").hidden = false; document.body.classList.add("lock");
}
function hideSheet(){
  if(!openSheetEl) return;
  openSheetEl.hidden = true; $("#scrim").hidden = true; document.body.classList.remove("lock"); openSheetEl = null;
}

/* ---------- 記録の入力 ---------- */
let draft = null;          // 編集中の記録（コピー）
let newBlobs = new Map();  // まだ保存していない写真 ID → Blob
let snapshot = "";

function formState(){
  return JSON.stringify({ at:$("#fAt").value, place:$("#fPlace").value, addr:$("#fAddr").value, memo:$("#fMemo").value,
    imgs:draft?.images, lat:draft?.lat });
}
function isDirty(){ return draft && formState()!==snapshot; }

function openForm(rec){
  const isNew = !rec;
  draft = rec ? JSON.parse(JSON.stringify(rec)) : { id:uid(), at:Date.now(), place:"", address:"", lat:null, lon:null, memo:"", images:[] };
  draft._new = isNew;
  newBlobs = new Map();
  $("#sheetTitle").textContent = isNew ? "記録する" : "記録を直す";
  $("#fAt").value = toInput(draft.at);
  $("#fPlace").value = draft.place || "";
  $("#fAddr").value = draft.address || "";
  $("#fMemo").value = draft.memo || "";
  setGps("");
  paintMapLink();
  $("#deleteBtn").hidden = isNew;
  paintPlaceChips(); paintQuickChips(); paintPhotos();
  snapshot = formState();
  showSheet($("#sheet"));
  $("#sheet .sheetbody").scrollTop = 0;
}

function closeForm(force){
  if(!force && isDirty() && !confirm("入力した内容を保存せずに閉じますか？")) return;
  draft = null; newBlobs = new Map(); hideSheet();
}

function paintPlaceChips(){
  const cur = $("#fPlace").value.trim();
  $("#placeChips").innerHTML = places.map(p=>`<button type="button" class="chip" data-place="${esc(p)}" aria-pressed="${p===cur}">${esc(p)}</button>`).join("");
}
function paintQuickChips(){
  $("#quickChips").innerHTML = quick.map(q=>`<button type="button" class="chip q" data-quick="${esc(q)}">${esc(q)}</button>`).join("");
}
async function paintPhotos(){
  const el = $("#photos");
  el.innerHTML = draft.images.map(id=>`<div class="ph"><img data-img="${esc(id)}" alt=""><button type="button" data-rm="${esc(id)}" aria-label="写真を外す">✕</button></div>`).join("")
    + `<button type="button" class="addph" id="addPhoto"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>追加</span></button>`;
  for(const img of el.querySelectorAll("img[data-img]")){
    const id = img.dataset.img;
    if(newBlobs.has(id)){ if(!imgURL.has(id)) imgURL.set(id, URL.createObjectURL(newBlobs.get(id))); img.src = imgURL.get(id); }
    else { const u = await urlFor(id); if(u) img.src = u; }
  }
}

/* 写真は長辺1600pxに縮めて保存する（容量の節約） */
function shrink(file){
  return new Promise(ok=>{
    const u = URL.createObjectURL(file); const img = new Image();
    img.onload = ()=>{
      try{
        const max = 1600, s = Math.min(1, max/Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth*s); c.height = Math.round(img.naturalHeight*s);
        c.getContext("2d").drawImage(img,0,0,c.width,c.height);
        c.toBlob(b=>{ URL.revokeObjectURL(u); ok(b && b.size < file.size ? b : file); }, "image/jpeg", 0.82);
      }catch(e){ URL.revokeObjectURL(u); ok(file); }
    };
    img.onerror = ()=>{ URL.revokeObjectURL(u); ok(file); };
    img.src = u;
  });
}

async function saveForm(){
  const at = fromInput($("#fAt").value);
  if(isNaN(at)){ toast("日時を入れてください"); return; }
  const place = $("#fPlace").value.trim(), memo = $("#fMemo").value.trim(), address = $("#fAddr").value.trim();
  if(!place && !memo && !address && !draft.images.length){ toast("場所かメモのどちらかを入れてください"); return; }
  const old = records.find(r=>r.id===draft.id);
  const rec = { id:draft.id, at, place, address, lat:draft.lat, lon:draft.lon, memo, images:draft.images.slice(),
    createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
  $("#saveBtn").disabled = true;
  try{
    for(const id of rec.images) if(newBlobs.has(id)) await idb.put("images",{id, blob:newBlobs.get(id)});
    await idb.put("records", rec);
    for(const id of (old?.images||[])) if(!rec.images.includes(id)){ await idb.del("images",id).catch(()=>{}); dropURL(id); }
  }catch(e){
    $("#saveBtn").disabled = false;
    toast(e?.name==="QuotaExceededError" ? "保存容量がいっぱいです。古い写真を減らしてください" : "保存できませんでした。もう一度お試しください", null, null, 5000);
    return;
  }
  $("#saveBtn").disabled = false;
  if(old) Object.assign(old, rec); else records.push(rec);
  const wasNew = !old;
  closeForm(true);
  render();
  toast(wasNew ? "記録しました" : "直しました");
}

function dropURL(id){ const u=imgURL.get(id); if(u){ URL.revokeObjectURL(u); imgURL.delete(id); } }

async function deleteCurrent(){
  if(!draft || draft._new) return;
  if(!confirm("この記録を削除しますか？")) return;
  const rec = records.find(r=>r.id===draft.id); if(!rec) return;
  try{ await idb.del("records", rec.id); }catch(e){ toast("削除できませんでした"); return; }
  records = records.filter(r=>r.id!==rec.id);
  closeForm(true); render();
  // 「元に戻す」のために写真はすぐには消さない
  toastDone = null;
  toast("削除しました", "元に戻す", async ()=>{
    try{ await idb.put("records", rec); records.push(rec); render(); toast("元に戻しました"); }catch(e){ toast("元に戻せませんでした"); }
  }, 6000);
  toastDone = async ()=>{ for(const id of (rec.images||[])){ await idb.del("images",id).catch(()=>{}); dropURL(id); } };
}

/* ---------- 現在地 → 住所 ---------- */
/* 記録した位置（なければ住所）をiPhoneの「マップ」で開くリンク */
function paintMapLink(){
  const a = $("#mapLink"); if(!a || !draft) return;
  const addr = $("#fAddr").value.trim(), name = $("#fPlace").value.trim();
  if(draft.lat!=null && draft.lon!=null){
    a.href = `https://maps.apple.com/?ll=${draft.lat},${draft.lon}&q=${encodeURIComponent(name||addr||"記録した場所")}`;
    a.hidden = false;
  }else if(addr){
    a.href = `https://maps.apple.com/?q=${encodeURIComponent(addr)}`; a.hidden = false;
  }else a.hidden = true;
}
function setGps(msg, err){ const p=$("#gpsStatus"); p.textContent = msg; p.classList.toggle("err", !!err); }

function withTimeout(ms){ const c = new AbortController(); setTimeout(()=>c.abort(), ms); return c.signal; }

/* 国土地理院の市区町村コード表（必要になったときに1回だけ読み込む） */
let muniPromise = null;
function loadMuni(){
  if(window.GSI && GSI.MUNI_ARRAY && Object.keys(GSI.MUNI_ARRAY).length) return Promise.resolve(GSI.MUNI_ARRAY);
  if(muniPromise) return muniPromise;
  muniPromise = new Promise(ok=>{
    window.GSI = window.GSI || {}; GSI.MUNI_ARRAY = GSI.MUNI_ARRAY || {};
    const s = document.createElement("script"); s.src = "https://maps.gsi.go.jp/js/muni.js"; s.async = true;
    const t = setTimeout(()=>{ muniPromise=null; ok(null); }, 8000);
    s.onload = ()=>{ clearTimeout(t); ok(GSI.MUNI_ARRAY); };
    s.onerror = ()=>{ clearTimeout(t); muniPromise=null; ok(null); };
    document.head.appendChild(s);
  });
  return muniPromise;
}
async function muniName(code){
  const cache = (()=>{ try{ return JSON.parse(localStorage.getItem("muni")||"{}"); }catch(e){ return {}; } })();
  if(cache[code]) return cache[code];
  const arr = await loadMuni(); if(!arr) return "";
  const v = arr[code] || arr[String(parseInt(code,10))] || arr[String(code).padStart(5,"0")];
  if(!v) return "";
  const p = String(v).split(",");                         // 例: "13,東京都,13101,千代田区"
  const name = ((p[1]||"") + (p[3]||"")).replace(/[\s　]/g,"");
  cache[code] = name; try{ localStorage.setItem("muni", JSON.stringify(cache)); }catch(e){}
  return name;
}
async function geocodeGSI(lat, lon){
  const r = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`, {signal:withTimeout(8000)});
  if(!r.ok) throw new Error("gsi");
  const j = await r.json(); const res = j && j.results; if(!res) return "";
  const city = res.muniCd ? await muniName(res.muniCd) : "";
  return (city + (res.lv01Nm && res.lv01Nm!=="－" ? res.lv01Nm : "")).trim();
}
async function geocodeOSM(lat, lon){
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=ja&lat=${lat}&lon=${lon}`, {signal:withTimeout(8000)});
  if(!r.ok) throw new Error("osm");
  const j = await r.json(); if(!j || !j.display_name) return "";
  // "番地, 町, 区, 市, 県, 郵便番号, 日本" を日本の順に並べ替える
  return j.display_name.split(",").map(s=>s.trim()).filter(s=>s && s!=="日本" && !/^\d{3}-?\d{4}$/.test(s)).reverse().join("");
}
async function reverseGeocode(lat, lon){
  try{ const a = await geocodeGSI(lat, lon); if(a) return a; }catch(e){}
  return geocodeOSM(lat, lon);
}

function locate(){
  if(!navigator.geolocation){ setGps("この端末では位置情報が使えません", true); return; }
  const btn = $("#gpsBtn"); if(btn.getAttribute("aria-busy")==="true") return;
  btn.setAttribute("aria-busy","true"); setGps("現在地を調べています…");
  const forId = draft && draft.id;
  navigator.geolocation.getCurrentPosition(async pos=>{
    if(!draft || draft.id!==forId){ btn.removeAttribute("aria-busy"); return; }
    const lat = +pos.coords.latitude.toFixed(6), lon = +pos.coords.longitude.toFixed(6);
    draft.lat = lat; draft.lon = lon; paintMapLink();
    setGps("住所を調べています…");
    try{
      const a = await reverseGeocode(lat, lon);
      if(!draft || draft.id!==forId) return;
      if(a){ $("#fAddr").value = a; setGps(""); paintMapLink(); }
      else setGps("住所が見つかりませんでした。位置は記録されます。", true);
    }catch(e){
      if(draft && draft.id===forId) setGps("通信できないため住所を出せませんでした。位置は記録されます。", true);
    }finally{ btn.removeAttribute("aria-busy"); }
  }, err=>{
    btn.removeAttribute("aria-busy");
    setGps(err.code===1
      ? "位置情報が許可されていません。iPhoneの「設定」→「プライバシーとセキュリティ」→「位置情報サービス」で許可してください。"
      : "現在地を取得できませんでした。少し場所を変えてもう一度お試しください。", true);
  }, { enableHighAccuracy:true, timeout:15000, maximumAge:30000 });
}

/* ---------- 設定 ---------- */
function openSettings(){
  $("#sPlaces").value = places.join("\n");
  $("#sQuick").value = quick.join("\n");
  $("#ver").textContent = `行動メモ ver ${APP_VERSION}　記録 ${records.length} 件`;
  showSheet($("#settings"));
}
async function closeSettings(){
  const p = lines($("#sPlaces").value), q = lines($("#sQuick").value);
  places = p; quick = q;
  try{ await meta.set("places", places); await meta.set("quick", quick); }catch(e){ toast("設定を保存できませんでした"); }
  hideSheet(); render();
}

const blobToDataURL = b => new Promise((ok,ng)=>{ const fr=new FileReader(); fr.onload=()=>ok(fr.result); fr.onerror=()=>ng(fr.error); fr.readAsDataURL(b); });
async function dataURLToBlob(u){ return (await fetch(u)).blob(); }

async function exportData(){
  try{
    const images = [];
    for(const r of records) for(const id of (r.images||[])){
      const rec = await idb.get("images", id); if(rec) images.push({ id, data: await blobToDataURL(rec.blob) });
    }
    const json = JSON.stringify({ app:"koudou-memo", version:APP_VERSION, exportedAt:new Date().toISOString(), places, quick, records, images });
    const name = `行動メモ_${ymd(new Date())}.json`;
    const file = new File([json], name, { type:"application/json" });
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      try{ await navigator.share({ files:[file], title:name }); return; }
      catch(e){ if(e && e.name==="AbortError") return; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  }catch(e){ toast("書き出しできませんでした"); }
}

async function importData(file){
  let j;
  try{ j = JSON.parse(await file.text()); }catch(e){ toast("ファイルを読めませんでした"); return; }
  if(!j || j.app!=="koudou-memo" || !Array.isArray(j.records)){ toast("行動メモのバックアップではありません"); return; }
  if(!confirm(`${j.records.length} 件の記録を読み込みます。同じ記録は新しいほうが残ります。よろしいですか？`)) return;
  let added = 0;
  try{
    for(const im of (j.images||[])) if(im && im.id && im.data) await idb.put("images", { id:im.id, blob: await dataURLToBlob(im.data) });
    for(const r of j.records){
      if(!r || !r.id || typeof r.at!=="number") continue;
      const cur = records.find(x=>x.id===r.id);
      if(cur && (cur.updatedAt||0) >= (r.updatedAt||0)) continue;
      const rec = { id:r.id, at:r.at, place:String(r.place||""), address:String(r.address||""), lat:r.lat??null, lon:r.lon??null,
        memo:String(r.memo||""), images:Array.isArray(r.images)?r.images:[], createdAt:r.createdAt||Date.now(), updatedAt:r.updatedAt||Date.now() };
      await idb.put("records", rec);
      if(cur) Object.assign(cur, rec); else records.push(rec);
      added++;
    }
    if(!(await meta.get("places")) && Array.isArray(j.places)){ places = j.places; await meta.set("places", places); }
    if(!(await meta.get("quick"))  && Array.isArray(j.quick)){  quick = j.quick;   await meta.set("quick", quick); }
  }catch(e){ toast("読み込みの途中で失敗しました"); render(); return; }
  hideSheet(); render();
  toast(`${added} 件を読み込みました`);
}

/* ---------- 写真の拡大 ---------- */
function viewPhoto(src){
  const v = document.createElement("div"); v.className = "viewer"; v.innerHTML = `<img alt="" src="${esc(src)}">`;
  v.onclick = ()=>v.remove(); document.body.appendChild(v);
}

/* ---------- events ---------- */
function bind(){
  document.querySelectorAll(".tabs button").forEach(b=>b.onclick = ()=>{ tab=b.dataset.tab; render(); window.scrollTo(0,0); });
  $("#addBtn").onclick = ()=>openForm(null);
  $("#listView").addEventListener("click", e=>{
    const b = e.target.closest(".rec"); if(!b) return;
    const r = records.find(x=>x.id===b.dataset.id); if(r) openForm(r);
  });
  $("#scrim").onclick = ()=>{ if(openSheetEl && openSheetEl.id==="settings") closeSettings(); else closeForm(false); };
  $("#cancelBtn").onclick = ()=>closeForm(false);
  $("#sheet").addEventListener("submit", e=>{ e.preventDefault(); saveForm(); });
  $("#deleteBtn").onclick = deleteCurrent;
  $("#gpsBtn").onclick = locate;
  $("#fPlace").addEventListener("input", paintPlaceChips);
  $("#fAddr").addEventListener("input", paintMapLink);
  $("#fPlace").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); $("#fMemo").focus(); } });
  $("#placeChips").addEventListener("click", e=>{
    const c = e.target.closest("[data-place]"); if(!c) return;
    const inp = $("#fPlace"); inp.value = inp.value.trim()===c.dataset.place ? "" : c.dataset.place; paintPlaceChips();
  });
  $("#quickChips").addEventListener("click", e=>{
    const c = e.target.closest("[data-quick]"); if(!c) return;
    const ta = $("#fMemo"); const v = ta.value.replace(/\s+$/,"");
    ta.value = (v ? v + "\n" : "") + c.dataset.quick + " ";
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  $("#photos").addEventListener("click", e=>{
    const rm = e.target.closest("[data-rm]");
    if(rm){ const id = rm.dataset.rm; draft.images = draft.images.filter(x=>x!==id); if(newBlobs.has(id)){ newBlobs.delete(id); dropURL(id); } paintPhotos(); return; }
    if(e.target.closest("#addPhoto")){ $("#photoInput").value = ""; $("#photoInput").click(); return; }
    const img = e.target.closest("img"); if(img && img.src) viewPhoto(img.src);
  });
  $("#photoInput").addEventListener("change", async e=>{
    const files = [...(e.target.files||[])]; if(!files.length || !draft) return;
    for(const f of files){ const b = await shrink(f); const id = uid(); newBlobs.set(id, b); draft.images.push(id); }
    paintPhotos();
  });
  $("#openSettings").onclick = openSettings;
  $("#settingsDone").onclick = closeSettings;
  $("#exportBtn").onclick = exportData;
  $("#importFile").addEventListener("change", e=>{ const f=e.target.files && e.target.files[0]; e.target.value=""; if(f) importData(f); });
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ paintToday(); if(!openSheetEl) render(); } });
}

async function init(){
  paintToday(); bind();
  try{
    await idb.open();
    records = (await idb.all("records")) || [];
    places = (await meta.get("places")) || DEFAULT_PLACES.slice();
    quick  = (await meta.get("quick"))  || DEFAULT_QUICK.slice();
  }catch(e){
    $("#listView").innerHTML = `<div class="empty"><p class="big">データを開けませんでした</p><p>Safariのプライベートブラウズでは保存できません。通常のタブかホーム画面のアプリから開いてください。</p></div>`;
    return;
  }
  render();
  if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  if("serviceWorker" in navigator && location.protocol!=="file:") navigator.serviceWorker.register("sw.js").catch(()=>{});
}
init();
})();
