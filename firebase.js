// cardgame/web/firebase.js — 포가튼사가 카드게임 웹: Firebase 랭킹 + 머니 동기화.
//
// - 첫 접속: IndexedDB 에 playerId 있으면 Firebase 머니 불러와 바로 이어서 플레이.
//            없으면 이름 등록 모달 → Firebase 등록(중복 시 뒤에 번호).
// - 게임머니(Lua Game.gold) 변화: index.html Module.print 의 [GOLD] 핸들러가
//   FosaCard.onGoldChanged(money) 호출 → Firebase PUT + 표시 갱신.
// - 3초마다 Firebase 폴링 → 랭킹 1~19위 + 내 순위.
//
// love.js 부팅은 preRunInjectMoney 가 window.__moneyReady(Promise) 를 대기 →
// 모달/IndexedDB 로 머니 확정 후 resolve.
(function () {
  'use strict';

  var DB = 'https://fosacard-default-rtdb.asia-southeast1.firebasedatabase.app';
  var DEFAULT_MONEY = 10000;
  var IDB_NAME = 'fosacard_player';
  var IDB_STORE = 'kv';
  var IDB_KEY = 'playerId';
  var MONEY_CAP = 99999999;

  var playerId = null;
  var playerName = null;
  var myMoney = DEFAULT_MONEY;
  var lastPutMoney = null;

  // love.js preRunInjectMoney 가 기다리는 Promise
  var _resolveMoney;
  window.__moneyReady = new Promise(function (res) { _resolveMoney = res; });

  // ───────────── IndexedDB (playerId 영속) ─────────────
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([IDB_STORE], 'readonly');
          var r = tx.objectStore(IDB_STORE).get(key);
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }).catch(function () { return null; });
  }
  function idbPut(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction([IDB_STORE], 'readwrite');
          tx.objectStore(IDB_STORE).put(val, key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    }).catch(function () { return false; });
  }

  // ───────────── Firebase RTDB REST ─────────────
  function getJson(path) {
    return fetch(DB + path + '.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function putJson(path, body) {
    return fetch(DB + path + '.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function postJson(path, body) {
    return fetch(DB + path + '.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  // ───────────── 사용자 등록 (중복 시 뒤에 번호) ─────────────
  function registerUser(rawName) {
    var name = (rawName || '').trim().slice(0, 8);
    if (!name) return Promise.reject(new Error('empty'));
    return getJson('/users').then(function (users) {
      var taken = {};
      if (users) for (var k in users) { if (users[k] && users[k].name) taken[users[k].name] = true; }
      var finalName = name, n = 2;
      while (taken[finalName]) { finalName = name + n; n++; }
      return postJson('/users', {
        name: finalName, money: DEFAULT_MONEY, created: Date.now()
      }).then(function (res) {
        if (!res || !res.name) throw new Error('register failed');
        return { id: res.name, name: finalName };
      });
    });
  }

  // ───────────── 모달 ─────────────
  function showModal() {
    var modal = document.getElementById('cg-name-modal');
    var input = document.getElementById('cg-name-input');
    var ok = document.getElementById('cg-name-ok');
    var msg = document.getElementById('cg-name-msg');
    if (!modal) { // 모달 DOM 없으면 fallback (이름 없이 시작)
      finishNewUser('Player'); return;
    }
    modal.classList.remove('hidden');
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 100);

    var busy = false;
    function submit() {
      if (busy) return;
      var name = (input.value || '').trim();
      if (!name) { msg.textContent = '이름을 입력하세요'; return; }
      busy = true; ok.disabled = true; msg.textContent = '등록 중...';
      registerUser(name).then(function (u) {
        playerId = u.id; playerName = u.name;
        return idbPut(IDB_KEY, playerId).then(function () {
          modal.classList.add('hidden');
          finishNewUser(u.name);
        });
      }).catch(function () {
        busy = false; ok.disabled = false; msg.textContent = '등록 실패 — 다시 시도하세요';
      });
    }
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  function finishNewUser(name) {
    playerName = name || playerName || 'Player';
    myMoney = DEFAULT_MONEY;
    lastPutMoney = DEFAULT_MONEY;
    _resolveMoney(DEFAULT_MONEY);
    startRankingPoll();
  }
  function finishReturning(money) {
    myMoney = (money != null && money >= 0) ? money : DEFAULT_MONEY;
    lastPutMoney = myMoney;
    _resolveMoney(myMoney);
    startRankingPoll();
  }

  // ───────────── 랭킹 패널 토글 (X 닫기 / 🏆 열기) ─────────────
  function setupRankingToggle() {
    var panel = document.getElementById('cg-ranking');
    var closeBtn = document.getElementById('cg-rank-close');
    var openBtn = document.getElementById('cg-rank-open');
    if (!panel) return;
    if (closeBtn) closeBtn.addEventListener('click', function () {
      panel.classList.add('hidden');
      if (openBtn) openBtn.classList.remove('hidden');
    });
    if (openBtn) openBtn.addEventListener('click', function () {
      panel.classList.remove('hidden');
      openBtn.classList.add('hidden');
    });
  }

  // ───────────── 부트 ─────────────
  function boot() {
    setupRankingToggle();
    idbGet(IDB_KEY).then(function (pid) {
      if (pid) {
        playerId = pid;
        getJson('/users/' + pid).then(function (u) {
          if (u && typeof u.money === 'number') {
            playerName = u.name || 'Player';
            finishReturning(u.money);
          } else {
            // 손상/삭제된 레코드 → 머니 10000 으로 복구 PUT
            playerName = (u && u.name) || 'Player';
            putJson('/users/' + pid, { name: playerName, money: DEFAULT_MONEY, created: Date.now() });
            finishReturning(DEFAULT_MONEY);
          }
        });
      } else {
        showModal();
      }
    });
  }

  // ───────────── 머니 변화 (Lua → [GOLD] → 여기) ─────────────
  function onGoldChanged(money) {
    if (typeof money !== 'number' || money < 0) return;
    if (money > MONEY_CAP) money = MONEY_CAP;
    myMoney = money;
    updateMyDisplay();
    if (playerId && money !== lastPutMoney) {
      lastPutMoney = money;
      putJson('/users/' + playerId + '/money', money);
    }
    renderRankingFromCache(); // 내 순위 즉시 반영 (캐시 기반)
  }

  // ───────────── 랭킹 (3초 폴링) ─────────────
  var _rankCache = [];
  var _pollTimer = null;
  function startRankingPoll() {
    if (_pollTimer) return;
    pollOnce();
    _pollTimer = setInterval(pollOnce, 3000);
  }
  function pollOnce() {
    getJson('/users').then(function (users) {
      if (!users) return;
      var arr = [];
      for (var id in users) {
        var u = users[id];
        if (!u) continue;
        arr.push({ id: id, name: u.name || '?', money: (typeof u.money === 'number') ? u.money : 0 });
      }
      arr.sort(function (a, b) { return b.money - a.money; });
      _rankCache = arr;
      renderRankingFromCache();
    });
  }
  function renderRankingFromCache() {
    var listEl = document.getElementById('cg-rank-list');
    var meEl = document.getElementById('cg-me');
    if (!listEl) return;
    var arr = _rankCache;
    // 내 순위/머니는 캐시 + 실시간 myMoney 반영
    var myIdx = -1;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === playerId) { myIdx = i; arr[i].money = myMoney; break; }
    }
    // myMoney 반영 후 재정렬 (내 위치 갱신)
    arr.sort(function (a, b) { return b.money - a.money; });
    myIdx = -1;
    for (var j = 0; j < arr.length; j++) { if (arr[j].id === playerId) { myIdx = j; break; } }

    var html = '';
    var top = arr.slice(0, 19);
    for (var k = 0; k < top.length; k++) {
      var u = top[k];
      var mine = (u.id === playerId) ? ' mine' : '';
      html += '<li class="cg-rank-item' + mine + '"><span class="cg-rank-no">' + (k + 1) +
        '</span><span class="cg-rank-name">' + escapeHtml(u.name) +
        '</span><span class="cg-rank-money">' + fmt(u.money) + '</span></li>';
    }
    listEl.innerHTML = html;
    if (meEl) {
      var rankTxt = (myIdx >= 0) ? (myIdx + 1) + '위' : '-위';
      meEl.textContent = (playerName || '나') + ' · ' + fmt(myMoney) + ' · ' + rankTxt;
    }
  }
  function updateMyDisplay() { renderRankingFromCache(); }

  function fmt(n) { return (n | 0).toLocaleString('en-US'); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ───────────── export + 시작 ─────────────
  window.FosaCard = {
    DEFAULT_MONEY: DEFAULT_MONEY,
    onGoldChanged: onGoldChanged,
    getPlayerId: function () { return playerId; }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
