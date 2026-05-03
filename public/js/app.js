'use strict';

const CIRC = 2 * Math.PI * 96; // r=96
const STORE = 'dp_';
const HIDE_DELAY = 10000; // 完了後この時間でカードが自動非表示 (ms)
const tKey = d => `${STORE}tasks_${d}`;
const todKey = d => `${STORE}todo_${d}`;
const TMPL_KEY  = `${STORE}templates`;
const REWARD_KEY = `${STORE}reward`;
const SUGGEST_KEY = `${STORE}suggestions`;
// 全タスク保存日のキャッシュキー (カレンダーのドット表示用)
const tasksKeyPrefix = `${STORE}tasks_`;

const S = {
  date: today(),
  tasks: [],
  todos: [],
  templates: [],
  suggestions: [],
  reward: { thresholdPct: 80, durationMin: 30 },
  view: 'schedule',        // 'schedule' | 'timer' | 'result' | 'review' | 'templates' | 'form'
  tab: 'schedule',         // ★ メインタブ: 'schedule' | 'calendar' | 'todo'
  calendarMonth: null,     // 'YYYY-MM' (カレンダータブで表示中の月、nullなら S.date の月)
  activeId: null,
  formData: null,
  formMode: 'task',
  shiftNext: true,
  raf: null,
  bgTimer: null,
  // ── アラーム関連 ─────────────────────────
  alarmTimers: [],
  alarmModal: null,
  alarmCheckInterval: null,
  audioCtx: null,
  // ── オーバーレイ ─────────────────────────
  rewardSettingOpen: false,
  historyOpen: false,
  // ── 完了タスク自動非表示用 ──────────────
  hideTimer: null,
};

// ── タスク重さ定義 ──────────────────────────────────
const WEIGHTS = {
  light:  { label: '軽い', color: '#22c55e', bg: '#f0fdf4', border: '#bbf7d0' },
  normal: { label: '普通', color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe' },
  heavy:  { label: '重い', color: '#ef4444', bg: '#fef2f2', border: '#fecaca' },
};
const W_KEYS = ['light','normal','heavy'];

// ── Time utils ────────────────────────────────────
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
}
function p2(n) { return String(n).padStart(2,'0'); }
function toMin(t) { const [h,m]=t.split(':').map(Number); return h*60+m; }
function fromMin(n) { n=((n%1440)+1440)%1440; return `${p2(~~(n/60))}:${p2(n%60)}`; }
function addMin(t,n) { return fromMin(toMin(t)+n); }
function dur(s,e) { let d=toMin(e)-toMin(s); return d<0?d+1440:d; }
function fDur(m) { if(m<60)return`${m}分`; const h=~~(m/60),r=m%60; return r?`${h}時間${r}分`:`${h}時間`; }
function fSec(s) { s=Math.max(0,s); return `${p2(~~(s/60))}:${p2(s%60)}`; }
function fDate(d) {
  const dt=new Date(d+'T00:00:00');
  return `${dt.getMonth()+1}月${dt.getDate()}日（${'日月火水木金土'[dt.getDay()]}）`;
}
function nowRound() { const d=new Date(),m=Math.ceil((d.getHours()*60+d.getMinutes())/10)*10; return fromMin(m); }
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Storage ───────────────────────────────────────
function save()     { try{localStorage.setItem(tKey(S.date),JSON.stringify(S.tasks));}catch(_){} }
function load(d)    { try{return JSON.parse(localStorage.getItem(tKey(d))||'[]');}catch(_){return[];} }
function saveTodo() { try{localStorage.setItem(todKey(S.date),JSON.stringify(S.todos));}catch(_){} }
function loadTodo(d){ try{return JSON.parse(localStorage.getItem(todKey(d))||'[]');}catch(_){return[];} }
function saveTmpl() { try{localStorage.setItem(TMPL_KEY,JSON.stringify(S.templates));}catch(_){} }
function loadTmpl() { try{return JSON.parse(localStorage.getItem(TMPL_KEY)||'[]');}catch(_){return[];} }
function saveReward() { try{localStorage.setItem(REWARD_KEY,JSON.stringify(S.reward));}catch(_){} }
function loadReward() { try{const r=JSON.parse(localStorage.getItem(REWARD_KEY)||'null'); return r||{thresholdPct:80,durationMin:30};}catch(_){return{thresholdPct:80,durationMin:30};} }

// ── タスク名サジェスト (使用頻度順 + 最近使った順) ─────
function loadSuggestions() {
  try { return JSON.parse(localStorage.getItem(SUGGEST_KEY) || '[]'); } catch(_) { return []; }
}
function saveSuggestions() {
  try { localStorage.setItem(SUGGEST_KEY, JSON.stringify(S.suggestions)); } catch(_) {}
}
function bumpSuggestion(text) {
  const t = (text || '').trim();
  if (!t) return;
  const list = S.suggestions || (S.suggestions = []);
  const ex = list.find(s => s.text === t);
  const now = new Date().toISOString();
  if (ex) { ex.count = (ex.count || 1) + 1; ex.lastUsed = now; }
  else    { list.push({ text: t, count: 1, lastUsed: now }); }
  // 使用回数 desc → 最近使った順 desc
  list.sort((a, b) => (b.count - a.count) || ((b.lastUsed||'').localeCompare(a.lastUsed||'')));
  // 上位30件のみ保持 (古いものは消える)
  if (list.length > 30) S.suggestions = list.slice(0, 30);
  saveSuggestions();
}
function deleteSuggestion(text) {
  S.suggestions = (S.suggestions || []).filter(s => s.text !== text);
  saveSuggestions();
}

// カレンダー表示用: 日付 → タスク配列 のマップ
function loadTasksByDate() {
  const map = new Map();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(tasksKeyPrefix)) {
        const arr = JSON.parse(localStorage.getItem(k) || '[]');
        if (Array.isArray(arr) && arr.length > 0) {
          // 開始時刻順にソート
          arr.sort((a,b) => toMin(a.startTime||'00:00') - toMin(b.startTime||'00:00'));
          map.set(k.slice(tasksKeyPrefix.length), arr);
        }
      }
    }
  } catch(_) {}
  return map;
}

// 後方互換用 (カレンダー Set 版)
function loadAllTaskDates() {
  return new Set(loadTasksByDate().keys());
}

// ── Tasks ─────────────────────────────────────────
function mkTask(d) {
  // alarmBefore: 開始◯分前にアラーム (0=なし、5/10/15/30 推奨)
  const ab = (typeof d.alarmBefore === 'number') ? d.alarmBefore : 5;
  return { id:uid(), title:d.title||'', startTime:d.startTime||'09:00', endTime:d.endTime||'10:00',
           status:'pending', weight: WEIGHTS[d.weight] ? d.weight : 'normal',
           alarmBefore: ab,
           resultLabel:d.resultLabel||'', resultUnit:d.resultUnit||'',
           resultValue:'', review:null, timerStartedAt:null, timerElapsedSec:0,
           alarmedPre:false, alarmedStart:false };
}
function sortTasks() { S.tasks.sort((a,b)=>toMin(a.startTime)-toMin(b.startTime)); }
function shiftAfter(id,mins) {
  let after=false;
  S.tasks.forEach(t=>{ if(t.id===id){after=true;return;} if(after&&t.status==='pending'){t.startTime=addMin(t.startTime,mins);t.endTime=addMin(t.endTime,mins);} });
}

// ── Timer ─────────────────────────────────────────
function remSec() {
  const t=S.tasks.find(t=>t.id===S.activeId); if(!t)return 0;
  const total=dur(t.startTime,t.endTime)*60;
  if(!t.timerStartedAt)return total;
  return total-(t.timerElapsedSec+~~((Date.now()-t.timerStartedAt)/1000));
}
function stopRAF(){if(S.raf){cancelAnimationFrame(S.raf);S.raf=null;}}
function stopBg(){if(S.bgTimer){clearInterval(S.bgTimer);S.bgTimer=null;}}

function startTick() {
  stopRAF();
  let last=null;
  function tick() {
    const r=remSec(),s=~~r;
    if(s!==last){last=s;updateRing(r);if(r<=0&&r>-2)onEnd();}
    S.raf=requestAnimationFrame(tick);
  }
  S.raf=requestAnimationFrame(tick);
}
function onEnd() {
  if(navigator.vibrate)navigator.vibrate([200,100,200]);
  notify('⏱ 時間になりました！',S.tasks.find(t=>t.id===S.activeId)?.title||'');
}
function updateRing(rem) {
  const numEl=document.getElementById('ring-num'); if(!numEl)return;
  const otEl=document.getElementById('ring-ot');
  const ring=document.querySelector('.ring-fg');
  if(rem>=0){
    numEl.textContent=fSec(~~rem); numEl.style.color='';
    if(otEl)otEl.textContent='';
    const t=S.tasks.find(t=>t.id===S.activeId);
    if(ring&&t){const total=dur(t.startTime,t.endTime)*60;const p=total>0?Math.min(1,(total-rem)/total):1;ring.setAttribute('stroke-dashoffset',(CIRC*(1-p)).toFixed(2));}
  } else {
    numEl.textContent='+'+fSec(~~-rem); numEl.style.color='var(--red)';
    if(otEl)otEl.textContent='OVERTIME';
    if(ring)ring.setAttribute('stroke-dashoffset','0');
  }
  const mini=document.getElementById(`mini-${S.activeId}`);
  if(mini)mini.textContent=rem>=0?fSec(~~rem)+' 残り':'+'+fSec(~~-rem)+' 延長中';
}
function startBg() {
  stopBg();
  S.bgTimer=setInterval(()=>{
    if(!S.activeId){stopBg();return;}
    const r=remSec();
    if(r<=0&&r>-2)onEnd();
    const mini=document.getElementById(`mini-${S.activeId}`);
    if(mini)mini.textContent=r>=0?fSec(~~r)+' 残り':'+'+fSec(~~-r)+' 延長中';
  },1000);
}

// ── Notify ────────────────────────────────────────
async function reqNotif() {
  if(!('Notification'in window))return;
  if(Notification.permission!=='granted')await Notification.requestPermission();
  if(Notification.permission==='granted'){
    // 22:00 の通知が今日まだ出ていない場合のフラグ (1日1回)
    let lastNotified22 = null;
    setInterval(()=>{
      const d=new Date();
      const today22Key = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
      // 22:00ぴったり〜22:01の範囲で1日1回発火
      if(d.getHours()===22 && d.getMinutes() < 5 && lastNotified22 !== today22Key){
        lastNotified22 = today22Key;
        notifyNightPlanner();
      }
    },60000);
  }
}

// 通常通知 (本文のみ・クリック時 focus)
function notify(title, body, opts){
  if(Notification.permission!=='granted') return;
  try {
    const n = new Notification(title, { body, ...(opts||{}) });
    if (opts?.onclick) n.onclick = opts.onclick;
  } catch(_) {}
}

// 22時の「明日の予定を立てる時間です」通知
// Service Worker 経由で出すと PWA 閉じてても通知タップで該当画面へ遷移できる
async function notifyNightPlanner(){
  const title = '🌙 明日の予定を立てる時間です';
  const body  = 'タップしてやることを整理しましょう';
  const targetUrl = '/?openTodo=tomorrow';
  // SW があれば SW 経由で通知 (notificationclick で URL 飛べる)
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, {
        body, tag: 'night-planner',
        data: { url: targetUrl },
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
      });
      return;
    }
  } catch(_) {}
  // フォールバック: 通常通知 (フォアグラウンドのみ click 動作)
  notify(title, body, {
    tag: 'night-planner',
    onclick: () => {
      try { window.focus(); } catch(_) {}
      const tom = new Date(); tom.setDate(tom.getDate()+1);
      const ymd = `${tom.getFullYear()}-${p2(tom.getMonth()+1)}-${p2(tom.getDate())}`;
      S.tab = 'todo';
      setDate(ymd);
    },
  });
}

// ── Alarm system ─────────────────────────────────
// 音生成（外部ファイル不要・Web Audio API でビープ音）
function playBeep(times) {
  try {
    if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = S.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    times = times || 3;
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const t0 = ctx.currentTime + i * 0.45;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.4, t0 + 0.05);
      gain.gain.linearRampToValueAtTime(0, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    }
  } catch(_) {}
}
function vibrateBuzz() {
  try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch(_) {}
}

// 全アラームをクリア・再スケジュール（タスク変更時に呼ぶ）
function clearAlarms() {
  S.alarmTimers.forEach(h => clearTimeout(h));
  S.alarmTimers = [];
}
function scheduleAlarms() {
  clearAlarms();
  if (S.date !== today()) return;  // 今日以外はスケジュールしない
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  S.tasks.forEach(t => {
    if (t.status !== 'pending') return;
    const startMin = toMin(t.startTime);
    const ab = typeof t.alarmBefore === 'number' ? t.alarmBefore : 5;
    // ◯分前アラーム (alarmBefore=0 ならスキップ)
    if (ab > 0 && !t.alarmedPre) {
      const preMin = startMin - ab;
      if (preMin > nowMin) {
        const ms = (preMin - nowMin) * 60 * 1000;
        S.alarmTimers.push(setTimeout(() => firePre(t.id), ms));
      }
    }
    // 開始時刻アラーム
    if (!t.alarmedStart && startMin > nowMin) {
      const ms = (startMin - nowMin) * 60 * 1000;
      S.alarmTimers.push(setTimeout(() => fireStart(t.id), ms));
    }
  });
}

function firePre(id) {
  const t = S.tasks.find(x => x.id === id);
  if (!t || t.status !== 'pending') return;
  t.alarmedPre = true; save();
  playBeep(2);
  vibrateBuzz();
  const ab = t.alarmBefore || 5;
  notify(`⏰ ${ab}分前です`, `「${t.title}」がもうすぐ始まります (${t.startTime})`);
  S.alarmModal = { taskId: id, kind: 'pre' };
  render();
}
function fireStart(id) {
  const t = S.tasks.find(x => x.id === id);
  if (!t || t.status !== 'pending') return;
  t.alarmedStart = true; save();
  playBeep(4);
  vibrateBuzz();
  // 強制感を出すため500ms遅延でもう1セット
  setTimeout(() => { playBeep(2); vibrateBuzz(); }, 1800);
  notify('🚨 開始時刻です！', `「${t.title}」を始めましょう`);
  S.alarmModal = { taskId: id, kind: 'start' };
  render();
}

// アプリ起動中に1分ごとにチェック（バックグラウンド復帰後の取りこぼし防止）
function startAlarmCheck() {
  if (S.alarmCheckInterval) clearInterval(S.alarmCheckInterval);
  S.alarmCheckInterval = setInterval(() => {
    if (S.date !== today()) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    S.tasks.forEach(t => {
      if (t.status !== 'pending') return;
      const startMin = toMin(t.startTime);
      const ab = typeof t.alarmBefore === 'number' ? t.alarmBefore : 5;
      // ◯分前 (-1分の幅で発火)
      if (ab > 0 && !t.alarmedPre && nowMin >= startMin - ab && nowMin < startMin - ab + 1) firePre(t.id);
      // 開始時刻 (0〜1分の範囲で発火)
      if (!t.alarmedStart && nowMin >= startMin && nowMin < startMin + 1) fireStart(t.id);
    });
  }, 30000);  // 30秒ごとにチェック
}

// ── Stats ─────────────────────────────────────────
function stats() {
  const done=S.tasks.filter(t=>t.status==='done').length,total=S.tasks.length;
  const byUnit={};
  S.tasks.forEach(t=>{if(t.status==='done'&&t.resultValue&&t.resultUnit){const v=parseFloat(t.resultValue)||0;byUnit[t.resultUnit]=(byUnit[t.resultUnit]||0)+v;}});
  return {done,total,byUnit};
}

// ── Time selects ──────────────────────────────────
function tOpts(){const r=[];for(let h=0;h<24;h++)for(let m=0;m<60;m+=10)r.push(`${p2(h)}:${p2(m)}`);return r;}
function tSel(name,val){return `<select class="tsel" name="${name}">${tOpts().map(t=>`<option value="${t}"${t===val?' selected':''}>${t}</option>`).join('')}</select>`;}

// ── Render: Mini stats badge (タイトル横に小さく) ──
function renderStatsBadge() {
  const st = stats();
  if (st.total === 0) return '';
  const pct = ~~(st.done / st.total * 100);
  return `<span class="stats-badge">✓ ${st.done}/${st.total}<span class="stats-badge-pct">${pct}%</span></span>`;
}

// ── やることリストのコンテンツ部分 ────────────────
function renderTodoList() {
  const pending = S.todos.filter(t=>!t.done);
  const done    = S.todos.filter(t=>t.done);

  // 並び替え用に未完了タスクの index を取得
  const pendingIds = pending.map(p => p.id);

  const mkItem = (t, isDone) => {
    const isFirst = !isDone && pendingIds[0] === t.id;
    const isLast  = !isDone && pendingIds[pendingIds.length-1] === t.id;
    const sortBtns = isDone ? '' : `
      <div class="todo-sort-col">
        <button class="todo-sort-btn ${isFirst?'is-disabled':''}" data-tup="${t.id}" ${isFirst?'disabled':''} title="上へ">▲</button>
        <button class="todo-sort-btn ${isLast?'is-disabled':''}" data-tdown="${t.id}" ${isLast?'disabled':''} title="下へ">▼</button>
      </div>`;
    return `<div class="todo-item ${isDone?'is-done':''}" data-tid="${t.id}">
      <button class="todo-check ${isDone?'checked':''}" data-tcheck="${t.id}">
        ${isDone?'<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8l3.5 3.5L13 4.5" stroke="white" stroke-width="2" fill="none" stroke-linecap="round"/></svg>':''}
      </button>
      <span class="todo-text">${esc(t.text)}</span>
      ${sortBtns}
      ${!isDone?`<button class="todo-toschedule" data-toschedule="${t.id}" title="時間を決めてスケジュール化">🕐</button>`:''}
      <button class="todo-del" data-tdel="${t.id}">×</button>
    </div>`;
  };

  return `<div class="todo-screen">
    <div class="todo-input-row">
      <input type="text" class="todo-input" id="todo-input" placeholder="メモを入力 → Enterで追加" maxlength="50">
    </div>
    ${pending.length>0 ? `<div class="todo-group">${pending.map(t=>mkItem(t,false)).join('')}</div>` : ''}
    ${done.length>0 ? `<div class="todo-group todo-done-group">
      <div class="todo-group-label">完了 ${done.length}</div>
      ${done.map(t=>mkItem(t,true)).join('')}
    </div>` : ''}
  </div>`;
}

// ── Render: Main Screen (1画面集約版) ─────────────
// 上：今日の日付  /  中：やること  /  下：スケジュール
function renderSchedule() {
  const isToday = S.date === today();
  const cur = new Date(S.date + 'T00:00:00');
  const tom = new Date(cur); tom.setDate(cur.getDate()+1);
  const ymdTom = `${tom.getFullYear()}-${p2(tom.getMonth()+1)}-${p2(tom.getDate())}`;

  // 上: 今日の日付 + 前後日ナビ
  const header = `<div class="header header-compact main-header">
    <div class="header-nav">
      <button class="nav-btn" id="prev-day" title="前日">‹</button>
      ${!isToday ? `<button class="nav-btn nav-today" id="goto-today" title="今日に戻る">今日</button>` : ''}
      <button class="nav-btn" id="next-day" title="翌日">›</button>
    </div>
    <div class="header-eyebrow">${isToday ? 'TODAY · 今日' : fDate(S.date).split('（')[0].includes('1月')&&S.date<today() ? 'PAST' : 'PLAN'}</div>
    <div class="header-date">${fDate(S.date)}</div>
  </div>`;

  // ★ 完了から10秒経過したタスクは自動非表示 (今日のみ・履歴に保存される)
  const isToday2 = S.date === today();
  const nowMs = Date.now();
  const visibleTasks = S.tasks.filter(t => {
    if (t.status !== 'done') return true;
    if (!isToday2) return true;            // 過去/未来日は隠さず表示
    if (!t.completedAt) return true;       // 旧データ (completedAt なし) は表示
    return (nowMs - t.completedAt) < HIDE_DELAY;
  });
  // 履歴件数 (今日完了したタスクのうち画面から消えたもの)
  const hiddenCount = S.tasks.filter(t => t.status==='done' && t.completedAt && isToday2 && (nowMs - t.completedAt) >= HIDE_DELAY).length;

  // ★ 上: スケジュール (1日のメイン情報・大きく表示)
  const scheduleContent = visibleTasks.length === 0
    ? `<div class="section-empty">
        <div class="section-empty-icon">⏱</div>
        <div class="section-empty-text">今日の予定はまだありません<br>「+ 追加」で予定を作成</div>
       </div>`
    : `<div class="list">${visibleTasks.map(renderCard).join('')}</div>`;
  const scheduleSection = `<div class="section-title-row section-title-main">
    <h3 class="section-title section-title-lg">⏱ スケジュール <span class="section-sub">${visibleTasks.length}件</span></h3>
    <div class="title-right">
      ${renderStatsBadge()}
      ${hiddenCount>0 ? `<button class="history-link" id="btn-history">📂 ${hiddenCount}</button>` : ''}
    </div>
  </div>
  ${scheduleContent}`;

  // ★ 一番下: メモ (時間未定・🕐 で時間設定 → スケジュールへ)
  const pendingTodoCnt = S.todos.filter(t=>!t.done).length;
  const memoSection = `<div class="memo-section">
    <div class="section-title-row">
      <h3 class="section-title">📝 メモ <span class="section-sub">${pendingTodoCnt}件</span></h3>
      ${pendingTodoCnt>0 ? '<span class="section-hint">🕐 で時間を設定 → スケジュール化</span>' : ''}
    </div>
    ${renderTodoList()}
  </div>`;

  // 下部バー: + 追加
  const bottomBar = `<div class="bottom-bar">
    <button class="bar-btn primary" id="btn-add">＋ 追加</button>
    ${S.tasks.length>0?'<button class="bar-btn" id="btn-review">振り返り</button>':''}
  </div>`;

  return `<div class="main-wrapper">
    ${header}
    ${scheduleSection}
    <div class="mid-spacer"></div>
    ${bottomBar}
    ${memoSection}
    ${S.historyOpen ? renderHistory() : ''}
  </div>`;
}

// ── Render: 完了履歴オーバーレイ ────────────────
function renderHistory() {
  const items = S.tasks
    .filter(t => t.status==='done' && t.completedAt)
    .sort((a,b) => (b.completedAt||0) - (a.completedAt||0));
  const fmtTime = (ms) => {
    const d = new Date(ms);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const list = items.length === 0
    ? `<div class="hist-empty">完了したスケジュールはまだありません</div>`
    : items.map(t => `<div class="hist-item">
        <div class="hist-row1">
          <div class="hist-title">${esc(t.title)}</div>
          <button class="hist-restore" data-restore="${t.id}">↩ 戻す</button>
        </div>
        <div class="hist-meta">${t.startTime}〜${t.endTime} · 完了 ${fmtTime(t.completedAt)}</div>
      </div>`).join('');
  return `<div class="overlay" id="history-overlay">
    <div class="overlay-card">
      <div class="overlay-head">
        📂 完了履歴 (${fDate(S.date)})
        <button class="overlay-close" id="hist-close">×</button>
      </div>
      <div class="hist-list">${list}</div>
    </div>
  </div>`;
}

// ── Render: Reward setting overlay ────────────────
function renderRewardSetting() {
  const r = S.reward;
  return `<div class="overlay" id="reward-overlay">
    <div class="overlay-card">
      <div class="overlay-head">🎁 ご褒美時間の設定</div>
      <div class="overlay-row">
        <label>達成率</label>
        <select class="overlay-select" id="reward-pct">
          ${[50,60,70,80,90,100].map(n=>`<option value="${n}"${n===r.thresholdPct?' selected':''}>${n}%</option>`).join('')}
        </select>
      </div>
      <div class="overlay-row">
        <label>ご褒美時間</label>
        <select class="overlay-select" id="reward-dur">
          ${[10,15,20,30,45,60,90,120].map(n=>`<option value="${n}"${n===r.durationMin?' selected':''}>${n}分</option>`).join('')}
        </select>
      </div>
      <div class="overlay-btns">
        <button class="overlay-cancel" id="reward-cancel">キャンセル</button>
        <button class="overlay-ok" id="reward-save">保存</button>
      </div>
    </div>
  </div>`;
}

function renderCard(t) {
  const isActive=t.id===S.activeId;
  const isDone  =t.status==='done';
  const d=dur(t.startTime,t.endTime);
  const w = WEIGHTS[t.weight] || WEIGHTS.normal;
  let cls='card';
  if(isActive) cls+=' is-active';
  else if(isDone)               cls+=' is-done';
  else if(t.status==='skipped') cls+=' is-skipped';

  // 完了直後は「取り消し」ヒント (10秒以内のみ)
  const inUndoWindow = isDone && t.completedAt && (Date.now() - t.completedAt) < HIDE_DELAY;
  const doneMeta = inUndoWindow
    ? `<div class="card-meta card-done-text">✓ 完了 · まもなく履歴へ</div>`
    : `<div class="card-meta card-done-text">✓ 完了</div>`;
  const meta = isActive
    ? `<div class="card-meta card-timer-text" id="mini-${t.id}">計測中...</div>`
    : (isDone ? doneMeta : '');

  const canStart = t.status==='pending'||isActive;
  const startLabel = isActive ? '▶ タイマーを開く' : '▶ 開始する';
  const weightTag = `<span class="weight-tag" style="background:${w.bg};color:${w.color};border:1px solid ${w.border};">${w.label}</span>`;

  // 完了/未完了を1タップで切替するチェックボタン
  const doneBtn = `<button class="card-done-toggle ${isDone?'is-on':''}" data-done="${t.id}" title="${isDone?'未完了に戻す':'完了にする'}" aria-label="${isDone?'未完了に戻す':'完了にする'}">${isDone?'<svg width="18" height="18" viewBox="0 0 18 18"><path d="M3 9l4 4 8-9" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>':''}</button>`;

  return `<div class="${cls}" style="border-left:4px solid ${w.color};">
    <div class="card-row">
      ${doneBtn}
      <div class="card-body">
        <div class="card-time">${t.startTime}〜${t.endTime}<span class="dur-tag">${fDur(d)}</span>${weightTag}</div>
        <div class="card-title">${esc(t.title)}</div>
        ${meta}
      </div>
    </div>
    <div class="card-footer">
      ${inUndoWindow
        ? `<button class="card-undo-btn" data-undo="${t.id}">↩ 取り消し</button>`
        : (canStart?`<button class="card-start-btn" data-id="${t.id}">${startLabel}</button>`:'<div style="flex:1"></div>')}
      <button class="card-edit-btn" data-edit="${t.id}">編集</button>
    </div>
  </div>`;
}

// ── アラームモーダル（強制表示） ──────────────────
function renderAlarmModal() {
  if (!S.alarmModal) return '';
  const t = S.tasks.find(x => x.id === S.alarmModal.taskId);
  if (!t) return '';
  const isPre5 = S.alarmModal.kind === 'pre5';
  const w = WEIGHTS[t.weight] || WEIGHTS.normal;
  const headerColor = isPre5 ? '#f59e0b' : '#ef4444';
  const headerEmoji = isPre5 ? '⏰' : '🚨';
  const headerText  = isPre5 ? '5分後に開始' : '開始時刻です！';
  return `<div class="alarm-overlay">
    <div class="alarm-modal">
      <div class="alarm-head" style="background:${headerColor}">
        <div class="alarm-emoji">${headerEmoji}</div>
        <div class="alarm-headtxt">${headerText}</div>
      </div>
      <div class="alarm-body">
        <div class="alarm-time">${t.startTime}〜${t.endTime}</div>
        <div class="alarm-title">${esc(t.title)}</div>
        <div class="alarm-weight" style="color:${w.color}">● ${w.label}</div>
      </div>
      <div class="alarm-btns">
        <button class="alarm-btn alarm-skip" id="alarm-skip">スキップ</button>
        <button class="alarm-btn alarm-start" id="alarm-start" style="background:${headerColor}">▶ 開始する</button>
      </div>
    </div>
  </div>`;
}

// ── Render: Timer ─────────────────────────────────
function renderTimer() {
  const t=S.tasks.find(t=>t.id===S.activeId); if(!t){S.view='schedule';render();return'';}
  const r=remSec(),total=dur(t.startTime,t.endTime)*60;
  const p=total>0?Math.min(1,(total-Math.max(0,r))/total):1;
  const offset=(CIRC*(1-p)).toFixed(2);
  return `<div class="timer-screen">
    <div class="timer-head">
      <button class="back-btn" id="timer-back">← 戻る</button>
      <span class="timer-head-task">${t.startTime}〜${t.endTime}</span>
    </div>
    <div class="timer-main">
      <div class="timer-title">${esc(t.title)}</div>
      <div class="timer-range">${fDur(dur(t.startTime,t.endTime))}</div>
      <div class="ring-wrap">
        <svg class="ring-svg" viewBox="0 0 220 220">
          <circle class="ring-bg" cx="110" cy="110" r="96"/>
          <circle class="ring-fg" cx="110" cy="110" r="96"
            stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="${offset}"
            transform="rotate(-90 110 110)"/>
        </svg>
        <div class="ring-center">
          <span id="ring-num">${r>=0?fSec(~~r):'+'+fSec(~~-r)}</span>
          <div id="ring-ot"></div>
        </div>
      </div>
      <div class="timer-btns">
        <button class="tbtn tbtn-ext" id="btn-ext">+10分</button>
        <button class="tbtn tbtn-done" id="btn-done">✓ 完了</button>
        <button class="tbtn tbtn-skip" id="btn-skip">スキップ</button>
      </div>
      <label class="shift-toggle">
        <input type="checkbox" id="chk-shift" ${S.shiftNext?'checked':''}> 後の予定もずらす
      </label>
    </div>
  </div>`;
}

// ── Render: Result ────────────────────────────────
function renderResult() {
  const t=S.tasks.find(t=>t.id===S.activeId); if(!t){S.view='schedule';render();return'';}
  const has=t.resultLabel||t.resultUnit;
  return `<div class="result-screen">
    <div class="result-emoji">🎉</div>
    <div class="result-title">完了！</div>
    <div class="result-sub">${esc(t.title)}　お疲れ様でした</div>
    ${has?`<div class="result-field">
      <label>${esc(t.resultLabel||'成果')}</label>
      <div class="result-input-row">
        <input type="number" class="result-input" id="res-val" value="${esc(t.resultValue||'')}" placeholder="0" inputmode="numeric">
        ${t.resultUnit?`<span class="result-unit">${esc(t.resultUnit)}</span>`:''}
      </div>
    </div>`:`<div class="result-no-field">成果の記録はタスク編集で設定できます</div>`}
    <div class="result-btns">
      <button class="btn-sub" id="res-skip">スキップ</button>
      <button class="btn-main" id="res-save">保存して次へ</button>
    </div>
  </div>`;
}

// ── Render: Review ────────────────────────────────
function renderReview() {
  const st=stats();
  const resStr=Object.entries(st.byUnit).map(([u,v])=>u==='円'?`${v.toLocaleString()}円`:`${v}${u}`);
  return `<div class="review-screen">
    <div class="screen-head">
      <button class="back-btn" id="rev-back">← 戻る</button>
      <h2>振り返り</h2>
      <div></div>
    </div>
    ${resStr.length?`<div class="review-stats">
      <div class="rs-eyebrow">Today's Results</div>
      <div class="rs-nums">${resStr.join('　')}</div>
      <div class="rs-sub">${st.done}/${st.total} タスク完了</div>
    </div>`:''}
    <div class="review-list">
      ${S.tasks.map(t=>`<div class="review-card">
        <div class="rc-name">${esc(t.title)}</div>
        <div class="rc-time">${t.startTime}〜${t.endTime}</div>
        <div class="rc-btns">
          <button class="rc-btn ${t.review==='done'?'sel-done':''}" data-rid="${t.id}" data-rv="done">✓ できた</button>
          <button class="rc-btn ${t.review==='not_done'?'sel-not_done':''}" data-rid="${t.id}" data-rv="not_done">✗ できなかった</button>
          <button class="rc-btn ${t.review==='tomorrow'?'sel-tomorrow':''}" data-rid="${t.id}" data-rv="tomorrow">↪ 明日へ</button>
        </div>
      </div>`).join('')}
    </div>
    <div class="review-footer"><button class="btn-main btn-full" id="rev-done">完了</button></div>
  </div>`;
}

// ── Render: Templates ────────────────────────────
function renderTemplates() {
  return `<div class="review-screen">
    <div class="screen-head">
      <button class="back-btn" id="tmpl-back">← 戻る</button>
      <h2>固定予定</h2>
      <div></div>
    </div>
    <div style="padding:8px 16px 12px;">
      <div style="font-size:13px;color:var(--text2);line-height:1.5;">
        タップで今日のスケジュールに追加します。<br>タスク追加時に「固定予定に保存」をオンにすると登録できます。
      </div>
    </div>
    <div class="review-list">
      ${S.templates.length===0
        ? `<div class="todo-empty" style="margin-top:40px;">
            <div class="todo-empty-icon">📌</div>
            <div class="todo-empty-text">固定予定がありません<br>タスク追加時に登録できます</div>
           </div>`
        : S.templates.map(t=>`<div class="review-card tmpl-card" data-tmpl="${t.id}">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="flex:1">
                <div class="rc-name">${esc(t.title)}</div>
                <div class="rc-time">${t.startTime}〜${t.endTime}　${fDur(dur(t.startTime,t.endTime))}</div>
              </div>
              <div style="display:flex;gap:8px;">
                <button class="rc-btn" style="width:64px;flex:none" data-tmpl-add="${t.id}">＋ 追加</button>
                <button class="rc-btn" style="width:48px;flex:none;color:var(--text3)" data-tmpl-del="${t.id}">削除</button>
              </div>
            </div>
          </div>`).join('')}
    </div>
  </div>`;
}

// ── Render: Form ──────────────────────────────────
function renderForm() {
  const d=S.formData||{}, isEdit=!!d.id;
  // 「時間を指定する」: task mode = ON, todo mode = OFF
  const hasTime = d._mode === 'todo' ? false : (d.startTime !== undefined || d._mode === 'task' || isEdit);
  // Check if this task is already a template
  const isTemplate = d.id && S.templates.some(t=>t.sourceId===d.id);
  // アラーム選択肢 (デフォルト 5分前)
  const alarmCur = typeof d.alarmBefore === 'number' ? d.alarmBefore : 5;
  const alarmOpts = [0, 5, 10, 15, 30];
  const alarmChips = alarmOpts.map(n => `<button class="chip alarm-chip${alarmCur===n?' on':''}" data-alarm="${n}">${n===0?'なし':`${n}分前`}</button>`).join('');

  return `<div class="form-screen">
    <div class="screen-head">
      <button class="back-btn" id="form-back">← キャンセル</button>
      <h2>${isEdit?'編集':'追加'}</h2>
      ${isEdit?`<button class="del-btn" id="form-del">削除</button>`:'<div></div>'}
    </div>
    <div class="form-body">
      <div class="field-section">
        <div class="field-section-title">タスク名</div>
        <input class="finput" id="f-title" type="text" value="${esc(d.title||d.text||'')}" placeholder="仕入れ、出品、休憩…" maxlength="30">
        ${(!isEdit && (S.suggestions||[]).length > 0) ? `
        <div class="suggest-row" id="suggest-row">
          <div class="suggest-label">よく使うタスク</div>
          <div class="suggest-chips">
            ${S.suggestions.slice(0, 8).map(s => `<button type="button" class="suggest-chip" data-suggest="${esc(s.text)}">${esc(s.text)}</button>`).join('')}
          </div>
        </div>` : ''}
        ${!isEdit ? `
        <label class="tmpl-toggle" style="margin-top:12px;">
          <div class="tmpl-toggle-text">
            <span class="tmpl-toggle-label">時間を指定する</span>
            <span class="tmpl-toggle-sub">OFF にすると「やること」に追加されます</span>
          </div>
          <div class="toggle-switch ${hasTime?'on':''}" id="time-toggle-sw" role="switch" aria-checked="${hasTime}"></div>
        </label>` : ''}
        <div id="time-fields" class="${hasTime?'':'hidden'}">
          <div class="time-row" style="margin-top:12px;">
            <div class="time-side">
              <label>開始</label>
              ${tSel('startTime',d.startTime||'09:00')}
            </div>
            <div class="time-divider">—</div>
            <div class="time-side">
              <label>終了</label>
              ${tSel('endTime',d.endTime||'10:00')}
            </div>
          </div>
        </div>
      </div>
      <div id="task-only-fields" class="${hasTime?'':'hidden'}">
        <div class="chips-section">
          <div class="chips-title">タスクの重さ</div>
          <div class="chips weight-chips">
            ${W_KEYS.map(k => `<button class="chip weight-chip${(d.weight||'normal')===k?' on':''}" data-weight="${k}" style="--w-color:${WEIGHTS[k].color};--w-bg:${WEIGHTS[k].bg};--w-border:${WEIGHTS[k].border};">${WEIGHTS[k].label}</button>`).join('')}
          </div>
        </div>
        <div class="chips-section">
          <div class="chips-title">アラーム (開始時刻に加えて)</div>
          <div class="chips">${alarmChips}</div>
        </div>
        <label class="tmpl-toggle">
          <div class="tmpl-toggle-text">
            <span class="tmpl-toggle-label">固定予定に保存</span>
            <span class="tmpl-toggle-sub">毎回使う予定をテンプレートとして保存</span>
          </div>
          <div class="toggle-switch ${isTemplate?'on':''}" id="tmpl-toggle-sw" role="switch" aria-checked="${isTemplate}"></div>
        </label>
      </div>
      <button class="form-save-btn" id="form-save">${isEdit?'保存する':'追加する'}</button>
    </div>
  </div>`;
}

// ── Render ────────────────────────────────────────
// ── 完了タスク自動非表示スケジューラ ──────────────
function scheduleAutoHide() {
  if (S.hideTimer) { clearTimeout(S.hideTimer); S.hideTimer=null; }
  // 表示中の done タスクで最も古い completedAt から 10秒経過時に再描画
  const now = Date.now();
  const upcoming = S.tasks
    .filter(t => t.status==='done' && t.completedAt && (now - t.completedAt) < HIDE_DELAY)
    .map(t => HIDE_DELAY - (now - t.completedAt));
  if (upcoming.length === 0) return;
  const next = Math.max(50, Math.min(...upcoming) + 50);
  S.hideTimer = setTimeout(() => { S.hideTimer=null; render(); }, next);
}

function render() {
  stopRAF();
  const app=document.getElementById('app');
  let body = '';
  switch(S.view){
    case 'schedule':  body=renderSchedule();  break;
    case 'timer':     body=renderTimer();     break;
    case 'result':    body=renderResult();    break;
    case 'review':    body=renderReview();    break;
    case 'templates': body=renderTemplates(); break;
    case 'form':      body=renderForm();      break;
  }
  app.innerHTML = body + renderAlarmModal();  // ★ アラームモーダルは常に最上位
  bind();
  if(S.view==='timer'&&S.activeId){stopBg();startTick();}
  else if(S.view==='schedule'&&S.activeId) startBg();
  else stopBg();
}

// ── Events ────────────────────────────────────────
function bind() {
  const on=(id,fn)=>document.getElementById(id)?.addEventListener('click',fn);
  const all=(sel,fn)=>document.querySelectorAll(sel).forEach(fn);

  // ★ アラームモーダルのハンドラ（全画面共通）
  if (S.alarmModal) {
    on('alarm-start', () => {
      const id = S.alarmModal.taskId;
      S.alarmModal = null;
      const t = S.tasks.find(x => x.id === id);
      if (!t) { render(); return; }
      // 他のアクティブなタスクがあれば停止
      if (S.activeId && S.activeId !== id) {
        const p = S.tasks.find(x => x.id === S.activeId);
        if (p?.timerStartedAt) { p.timerElapsedSec += ~~((Date.now() - p.timerStartedAt)/1000); p.timerStartedAt = null; }
      }
      S.activeId = id;
      t.status = 'active';
      t.timerStartedAt = Date.now();
      save();
      S.view = 'timer';
      render();
    });
    on('alarm-skip', () => {
      const id = S.alarmModal.taskId;
      S.alarmModal = null;
      const t = S.tasks.find(x => x.id === id);
      if (t) { t.status = 'skipped'; save(); }
      render();
    });
    return;  // モーダル表示中は他のハンドラ登録不要
  }

  if(S.view==='schedule'){
    // ── 日付ナビ ─────────────────────────────
    on('prev-day',  ()=>changeDate(-1));
    on('next-day',  ()=>changeDate(+1));
    on('goto-today',()=>setDate(today()));

    // ── ご褒美設定 (overlay) ────────────────
    on('reward-edit',()=>{ S.rewardSettingOpen=true; render(); });
    on('reward-cancel',()=>{ S.rewardSettingOpen=false; render(); });
    on('reward-save',()=>{
      const pct=Number(document.getElementById('reward-pct')?.value)||80;
      const dur=Number(document.getElementById('reward-dur')?.value)||30;
      S.reward={thresholdPct:pct, durationMin:dur};
      saveReward();
      S.rewardSettingOpen=false;
      render();
    });

    // ── 「+追加」: シンプル入力フォームを開く ──
    // デフォルトは時間OFF (やること) → ユーザーが時間ONで時間設定可
    const addFn=()=>{
      const n=nowRound();
      S.formData={startTime:n,endTime:addMin(n,60),_mode:'todo'};  // ★ デフォルト やること
      S.view='form';render();
    };
    on('btn-add',addFn);
    on('btn-review',()=>{S.view='review';render();});

    // ── スケジュールカード操作 ───────────────
    all('.card-start-btn',btn=>btn.addEventListener('click',e=>{
      const id=e.currentTarget.dataset.id;
      if(S.activeId&&S.activeId!==id){
        const p=S.tasks.find(t=>t.id===S.activeId);
        if(p?.timerStartedAt){p.timerElapsedSec+=~~((Date.now()-p.timerStartedAt)/1000);p.timerStartedAt=null;}
      }
      const t=S.tasks.find(t=>t.id===id); if(!t)return;
      S.activeId=id; t.status='active'; t.timerStartedAt=Date.now(); save();
      S.view='timer'; render();
    }));
    all('[data-edit]',btn=>btn.addEventListener('click',e=>{
      const t=S.tasks.find(t=>t.id===e.currentTarget.dataset.edit); if(!t)return;
      S.formData={...t}; S.view='form'; render();
    }));
    // ★ 完了トグル (チェック) ──
    all('[data-done]',btn=>btn.addEventListener('click',e=>{
      e.stopPropagation();
      const id=e.currentTarget.dataset.done;
      const t=S.tasks.find(x=>x.id===id); if(!t)return;
      if (t.status==='done') {
        // 未完了に戻す
        t.status='pending';
        t.completedAt=null;
      } else {
        // 完了にする (アクティブなら停止)
        t.status='done';
        t.completedAt=Date.now();
        t.timerStartedAt=null;
        if (S.activeId===id) { S.activeId=null; stopRAF(); stopBg(); }
        // 10秒後に自動で画面から非表示
        scheduleAutoHide();
      }
      save(); scheduleAlarms(); render();
    }));
    // ★ 取り消し (10秒以内) ──
    all('[data-undo]',btn=>btn.addEventListener('click',e=>{
      e.stopPropagation();
      const id=e.currentTarget.dataset.undo;
      const t=S.tasks.find(x=>x.id===id); if(!t)return;
      t.status='pending';
      t.completedAt=null;
      save(); scheduleAlarms(); render();
    }));
    // ★ 完了履歴オープン/クローズ ──
    on('btn-history',()=>{ S.historyOpen=true; render(); });
    on('hist-close',()=>{ S.historyOpen=false; render(); });
    all('[data-restore]',btn=>btn.addEventListener('click',e=>{
      e.stopPropagation();
      const id=e.currentTarget.dataset.restore;
      const t=S.tasks.find(x=>x.id===id); if(!t)return;
      t.status='pending';
      t.completedAt=null;
      S.historyOpen=false;
      save(); scheduleAlarms(); render();
    }));

    // 完了タスクの自動非表示タイマー再設定 (描画毎)
    scheduleAutoHide();

    // ── やること操作 (一画面に集約) ──────────
    const addTodo=()=>{
      const inp=document.getElementById('todo-input');
      const text=inp?.value.trim(); if(!text)return;
      S.todos.push({id:uid(),text,done:false});
      saveTodo();
      bumpSuggestion(text);   // ★ やる事クイック追加でも候補に記録
      render();
      setTimeout(()=>document.getElementById('todo-input')?.focus(),50);
    };
    document.getElementById('todo-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')addTodo();});
    all('[data-tcheck]',btn=>btn.addEventListener('click',e=>{
      const id=e.currentTarget.dataset.tcheck;
      const t=S.todos.find(t=>t.id===id); if(!t)return;
      t.done=!t.done; saveTodo(); render();
    }));
    all('[data-tdel]',btn=>btn.addEventListener('click',e=>{
      const id=e.currentTarget.dataset.tdel;
      S.todos=S.todos.filter(t=>t.id!==id); saveTodo(); render();
    }));
    // やること並び替え (上下ボタン)
    const moveTodo = (id, dir) => {
      const pendingIdx = S.todos.filter(t=>!t.done).findIndex(t=>t.id===id);
      const pending = S.todos.filter(t=>!t.done);
      const done = S.todos.filter(t=>t.done);
      const ni = pendingIdx + dir;
      if (ni < 0 || ni >= pending.length) return;
      [pending[pendingIdx], pending[ni]] = [pending[ni], pending[pendingIdx]];
      S.todos = [...pending, ...done];
      saveTodo(); render();
    };
    all('[data-tup]',  btn=>btn.addEventListener('click',e=>moveTodo(e.currentTarget.dataset.tup,  -1)));
    all('[data-tdown]',btn=>btn.addEventListener('click',e=>moveTodo(e.currentTarget.dataset.tdown,+1)));
    // やること → スケジュール変換 (時間設定で下のスケジュールに移動)
    all('[data-toschedule]',btn=>btn.addEventListener('click',e=>{
      const id=e.currentTarget.dataset.toschedule;
      const todo=S.todos.find(t=>t.id===id); if(!todo)return;
      const n=nowRound();
      S.formData={
        title:todo.text,
        startTime:n, endTime:addMin(n,60),
        _mode:'task',
        _fromTodoId:id,
      };
      S.view='form'; render();
    }));
  }

  if(S.view==='timer'){
    on('timer-back',()=>{S.view='schedule';render();});
    on('btn-ext',()=>{
      const t=S.tasks.find(t=>t.id===S.activeId); if(!t)return;
      t.endTime=addMin(t.endTime,10);
      if(document.getElementById('chk-shift')?.checked)shiftAfter(S.activeId,10);
      save(); stopRAF(); render();
    });
    on('btn-done',()=>{
      const t=S.tasks.find(t=>t.id===S.activeId);
      if(t){t.status='done';t.timerStartedAt=null;}
      stopRAF(); save(); S.activeId=null;
      S.view='schedule'; render();
    });
    on('btn-skip',()=>{
      const t=S.tasks.find(t=>t.id===S.activeId);
      if(t){t.status='skipped';t.timerStartedAt=null;}
      save(); S.activeId=null; S.view='schedule'; render();
    });
    document.getElementById('chk-shift')?.addEventListener('change',e=>{S.shiftNext=e.target.checked;});
  }

  if(S.view==='result'){
    const fin=val=>{
      const t=S.tasks.find(t=>t.id===S.activeId);
      if(t){t.status='done';t.timerStartedAt=null;if(val!==null)t.resultValue=val;}
      save(); S.activeId=null; S.view='schedule'; render();
    };
    on('res-save',()=>fin(document.getElementById('res-val')?.value??''));
    on('res-skip',()=>fin(null));
  }

  if(S.view==='review'){
    on('rev-back',()=>{S.view='schedule';render();});
    on('rev-done',()=>{save();S.view='schedule';render();});
    all('.rc-btn',btn=>btn.addEventListener('click',e=>{
      const id=e.currentTarget.dataset.rid,rv=e.currentTarget.dataset.rv;
      const t=S.tasks.find(t=>t.id===id); if(!t)return;
      t.review=t.review===rv?null:rv;
      if(t.review==='tomorrow')copyTomorrow(t);
      save(); render();
    }));
  }

  if(S.view==='templates'){
    on('tmpl-back',()=>{S.view='schedule';render();});
    all('[data-tmpl-add]',btn=>btn.addEventListener('click',e=>{
      const id=e.currentTarget.dataset.tmplAdd;
      const tmpl=S.templates.find(t=>t.id===id); if(!tmpl)return;
      const n=nowRound();
      const d=dur(tmpl.startTime,tmpl.endTime);
      const task=mkTask({
        title:tmpl.title,
        startTime:n,
        endTime:addMin(n,d),
        resultLabel:tmpl.resultLabel,
        resultUnit:tmpl.resultUnit,
      });
      S.tasks.push(task); sortTasks(); save();
      S.view='schedule'; S.tab='schedule'; render();
    }));
    all('[data-tmpl-del]',btn=>btn.addEventListener('click',e=>{
      const id=e.currentTarget.dataset.tmplDel;
      if(!confirm('固定予定を削除しますか？'))return;
      S.templates=S.templates.filter(t=>t.id!==id); saveTmpl(); render();
    }));
  }

  if(S.view==='form'){
    // Toggle: 時間を指定する
    on('time-toggle-sw',()=>{
      const sw=document.getElementById('time-toggle-sw');
      const isOn=sw.classList.contains('on');
      sw.classList.toggle('on',!isOn);
      sw.setAttribute('aria-checked',String(!isOn));
      // 表示切替
      document.getElementById('time-fields')?.classList.toggle('hidden', isOn);
      document.getElementById('task-only-fields')?.classList.toggle('hidden', isOn);
    });
    // Toggle: 固定予定に保存
    on('tmpl-toggle-sw',()=>{
      const sw=document.getElementById('tmpl-toggle-sw');
      const isOn=sw.classList.contains('on');
      sw.classList.toggle('on',!isOn);
      sw.setAttribute('aria-checked',String(!isOn));
    });

    on('form-back',()=>{S.formData=null;S.view='schedule';render();});
    on('form-del',()=>{
      if(!confirm('削除しますか？'))return;
      S.tasks=S.tasks.filter(t=>t.id!==S.formData.id);
      if(S.activeId===S.formData.id){S.activeId=null;stopRAF();stopBg();}
      S.templates=S.templates.filter(t=>t.sourceId!==S.formData.id);
      saveTmpl(); save(); scheduleAlarms();
      S.formData=null; S.view='schedule'; render();
    });
    on('form-save',saveForm);

    // 重さの chip
    all('.weight-chip',c=>c.addEventListener('click',e=>{
      all('.weight-chip',x=>x.classList.remove('on'));
      e.currentTarget.classList.add('on');
    }));
    // アラームの chip
    all('.alarm-chip',c=>c.addEventListener('click',e=>{
      all('.alarm-chip',x=>x.classList.remove('on'));
      e.currentTarget.classList.add('on');
    }));
    // ★ 候補チップ → タスク名にセット
    all('.suggest-chip',c=>c.addEventListener('click',e=>{
      const text=e.currentTarget.dataset.suggest;
      const inp=document.getElementById('f-title');
      if (inp) { inp.value = text; inp.focus(); }
    }));
  }
}

function saveForm() {
  const title=document.getElementById('f-title')?.value.trim();
  if(!title){alert('タスク名を入力してください');return;}

  const isEdit = !!S.formData?.id;
  // 編集の場合は常に時間あり、新規の場合は toggle で判定
  const timeToggle = document.getElementById('time-toggle-sw');
  const hasTime = isEdit || (timeToggle ? timeToggle.classList.contains('on') : true);

  // ── やること (時間なし) として保存 ──
  if (!hasTime) {
    S.todos.push({id:uid(), text:title, done:false});
    saveTodo();
    bumpSuggestion(title);   // ★ 候補に記録 (やることでも記録)
    S.formData=null; S.view='schedule'; render();
    return;
  }

  // ── スケジュール (時間あり) として保存 ──
  const s=document.querySelector('[name="startTime"]')?.value;
  const e=document.querySelector('[name="endTime"]')?.value;
  if(toMin(s)>=toMin(e)){alert('終了時間は開始時間より後にしてください');return;}
  const weightEl=document.querySelector('.weight-chip.on');
  const weight=weightEl?.dataset.weight || 'normal';
  const alarmEl=document.querySelector('.alarm-chip.on');
  const alarmBefore=alarmEl ? Number(alarmEl.dataset.alarm) : 5;
  const saveAsTemplate=document.getElementById('tmpl-toggle-sw')?.classList.contains('on');

  let taskId;
  if(S.formData?.id){
    const i=S.tasks.findIndex(t=>t.id===S.formData.id);
    if(i>=0){S.tasks[i]={...S.tasks[i],title,startTime:s,endTime:e,weight,alarmBefore,
            // 開始時刻が変わったらアラームフラグをリセット
            alarmedPre: S.tasks[i].startTime===s ? S.tasks[i].alarmedPre : false,
            alarmedStart: S.tasks[i].startTime===s ? S.tasks[i].alarmedStart : false};}
    taskId=S.formData.id;
  } else {
    const task=mkTask({title,startTime:s,endTime:e,weight,alarmBefore});
    S.tasks.push(task);
    taskId=task.id;
  }

  // Template save/remove
  if(saveAsTemplate){
    S.templates=S.templates.filter(t=>t.sourceId!==taskId);
    S.templates.push({id:uid(),sourceId:taskId,title,startTime:s,endTime:e,weight});
    saveTmpl();
  } else if(S.formData?.id){
    const had=S.templates.some(t=>t.sourceId===taskId);
    if(had){ S.templates=S.templates.filter(t=>t.sourceId!==taskId); saveTmpl(); }
  }

  // ★ todo → schedule 変換 (元 todo を削除)
  if (S.formData?._fromTodoId) {
    S.todos = S.todos.filter(t => t.id !== S.formData._fromTodoId);
    saveTodo();
  }

  sortTasks(); save();
  scheduleAlarms();
  bumpSuggestion(title);   // ★ スケジュール保存後も候補に記録
  S.formData=null; S.view='schedule'; render();
}

// 指定日付に移動
function setDate(ds) {
  S.date = ds;
  S.tasks = load(ds);
  S.todos = loadTodo(ds);
  S.activeId = null; stopRAF(); stopBg();
  scheduleAlarms();
  render();
}

function changeDate(d) {
  // 現在の S.date から派生 → 直接書き換えず一旦 Date オブジェクトで計算
  const dt = new Date(S.date + 'T00:00:00');
  dt.setDate(dt.getDate() + d);
  // ★ UTC変換 (toISOString) は使わない。ローカル日付として組み立てる。
  // toISOString() を使うと JST→UTC で日付が前日にずれて移動できなくなる
  S.date = `${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}`;
  S.tasks = load(S.date);
  S.todos = loadTodo(S.date);
  S.activeId = null; stopRAF(); stopBg();
  scheduleAlarms();   // ★ 日付変更時もアラーム再スケジュール
  render();
}

function copyTomorrow(task) {
  const d = new Date(S.date + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  // ★ ローカル日付として組み立てる (UTC ズレ防止)
  const tom = `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
  const tasks=load(tom);
  if(tasks.find(t=>t.title===task.title&&t.startTime===task.startTime))return;
  tasks.push(mkTask({title:task.title,startTime:task.startTime,endTime:task.endTime,resultLabel:task.resultLabel,resultUnit:task.resultUnit}));
  tasks.sort((a,b)=>toMin(a.startTime)-toMin(b.startTime));
  try{localStorage.setItem(tKey(tom),JSON.stringify(tasks));}catch(_){}
}

async function init() {
  // ★ URLパラメータで起動時の画面を制御 (通知タップ → ?openTodo=tomorrow など)
  try {
    const url = new URL(window.location.href);
    const openTodo = url.searchParams.get('openTodo');
    if (openTodo === 'tomorrow') {
      const tom = new Date(); tom.setDate(tom.getDate()+1);
      S.date = `${tom.getFullYear()}-${p2(tom.getMonth()+1)}-${p2(tom.getDate())}`;
      S.tab = 'todo';
    } else if (openTodo === 'today') {
      S.tab = 'todo';
    }
    // パラメータをURLから消す (リロード時に再発動しないため)
    if (openTodo) {
      url.searchParams.delete('openTodo');
      history.replaceState(null, '', url.pathname + url.search);
    }
  } catch(_) {}

  S.tasks=load(S.date);
  S.todos=loadTodo(S.date);
  S.templates=loadTmpl();
  S.reward=loadReward();
  S.suggestions=loadSuggestions();
  // 旧フィールド名 alarmedPre5 → alarmedPre のマイグレーション
  S.tasks.forEach(t => { if (t.alarmedPre5 !== undefined && t.alarmedPre === undefined) { t.alarmedPre = t.alarmedPre5; delete t.alarmedPre5; } });
  const active=S.tasks.find(t=>t.status==='active'&&t.timerStartedAt);
  if(active)S.activeId=active.id;
  reqNotif();
  scheduleAlarms();      // ★ 起動時にアラームをスケジュール
  startAlarmCheck();     // ★ 30秒ごとの保険チェック
  // ★ ユーザーの最初のタップで AudioContext を起動（iOS対策・無音解除）
  document.addEventListener('click', () => {
    if (!S.audioCtx) { try { S.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_){} }
    if (S.audioCtx?.state === 'suspended') S.audioCtx.resume();
  }, { once: true });
  // ★ アプリ復帰時にもアラームを再スケジュール（バックグラウンドで時間が経った場合の対策）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleAlarms();
  });
  // ★ Service Worker 登録 + 自動更新検知
  if ('serviceWorker' in navigator) {
    // 新SWが制御を取得したら自動リロード（ユーザーは何もしなくていい）
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('[SW] new version → reloading');
      window.location.reload();
    });
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // 起動時とアプリ復帰時に毎回SW更新チェック
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
  render();
}
init();
