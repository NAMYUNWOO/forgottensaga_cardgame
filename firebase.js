// cardgame/web/firebase.js — 포가튼사가 카드게임 웹: Firebase 랭킹 + 머니 동기화.
//
// 보안(A안): 익명 인증(Anonymous Auth) + 본인 레코드만 쓰기.
//   - 부팅 시 Identity Toolkit REST 로 익명 토큰 발급(최초) 또는 refreshToken 으로 갱신.
//   - 사용자 레코드 key = 익명 uid. 모든 쓰기 요청에 ?auth=<idToken> 부착.
//   - RTDB 규칙: /users 읽기 공개, /users/$uid 쓰기는 auth.uid===$uid 만 허용.
//   → 남의 레코드/전체 삭제·조작 불가. (단 본인 점수 위조는 A로는 못 막음 — B 필요)
//
// 동작: [GOLD] → onGoldChanged(머니 PUT), [RESULT] → onResult(승/패 누적).
//       3초 폴링 랭킹(1~19 + 내 순위), 배팅0(승+패=0) 유저 제외.
(function () {
  'use strict';

  var DB = 'https://fosacard-default-rtdb.asia-southeast1.firebasedatabase.app';
  // Firebase 웹 API 키 (콘솔 → 프로젝트 설정 → 일반 → 웹 API 키). 익명 인증용.
  var API_KEY = 'AIzaSyBz9_cnBhRYHCRxxlSYCCtOZ1vsJW4C6ww';
  var DEFAULT_MONEY = 10000;
  var IDB_NAME = 'fosacard_player';
  var IDB_STORE = 'kv';
  var MONEY_CAP = 99999999;

  var auth = { uid: null, idToken: null, refreshToken: null };
  var playerId = null;   // = auth.uid
  var playerName = null;
  var myMoney = DEFAULT_MONEY;
  var lastPutMoney = null;
  var myWins = 0;
  var myLosses = 0;

  var _resolveMoney;
  window.__moneyReady = new Promise(function (res) { _resolveMoney = res; });

  // ───────────── IndexedDB (uid + refreshToken 영속) ─────────────
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
          var r = db.transaction([IDB_STORE], 'readonly').objectStore(IDB_STORE).get(key);
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

  // ───────────── 익명 인증 (Identity Toolkit / SecureToken REST) ─────────────
  function anonSignUp() {
    return fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.idToken) return false;
      auth.uid = d.localId; auth.idToken = d.idToken; auth.refreshToken = d.refreshToken;
      return idbPut('uid', auth.uid).then(function () {
        return idbPut('refreshToken', auth.refreshToken);
      }).then(function () { return true; });
    }).catch(function () { return false; });
  }
  function refreshIdToken() {
    if (!auth.refreshToken) return Promise.resolve(false);
    return fetch('https://securetoken.googleapis.com/v1/token?key=' + API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refreshToken)
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.id_token) return false;
      auth.uid = d.user_id; auth.idToken = d.id_token;
      if (d.refresh_token) { auth.refreshToken = d.refresh_token; idbPut('refreshToken', auth.refreshToken); }
      return true;
    }).catch(function () { return false; });
  }
  // 저장된 uid+refreshToken 으로 세션 복원, 없으면 새 익명 가입.
  function ensureAuth() {
    return Promise.all([idbGet('uid'), idbGet('refreshToken')]).then(function (vals) {
      var uid = vals[0], rt = vals[1];
      if (uid && rt) {
        auth.uid = uid; auth.refreshToken = rt;
        return refreshIdToken().then(function (ok) { return ok ? true : anonSignUp(); });
      }
      return anonSignUp();
    });
  }

  // ───────────── RTDB REST (읽기 공개 / 쓰기 ?auth) ─────────────
  function getJson(path) {
    return fetch(DB + path + '.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  // 쓰기 — ?auth=idToken 부착. 401(토큰 만료) 시 refresh 후 1회 재시도.
  function writeJson(path, body, method) {
    method = method || 'PUT';
    function go() {
      var url = DB + path + '.json' + (auth.idToken ? ('?auth=' + auth.idToken) : '');
      return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    }
    return go().then(function (r) {
      if ((r.status === 401 || r.status === 403) && auth.refreshToken) {
        return refreshIdToken().then(function (ok) { return ok ? go() : r; });
      }
      return r;
    }).then(function (r) { return (r && r.ok) ? r.json().catch(function () { return null; }) : null; })
      .catch(function () { return null; });
  }

  // ───────────── 사용자 등록 (key=uid, 이름 중복 시 번호) ─────────────
  function registerUser(rawName) {
    var name = (rawName || '').trim().slice(0, 8);
    if (!name) return Promise.reject(new Error('empty'));
    if (!auth.uid) return Promise.reject(new Error('no-auth'));
    return getJson('/users').then(function (users) {
      var taken = {};
      if (users) for (var k in users) {
        if (k !== auth.uid && users[k] && users[k].name) taken[users[k].name] = true;
      }
      var finalName = name, n = 2;
      while (taken[finalName]) { finalName = name + n; n++; }
      return writeJson('/users/' + auth.uid, {
        name: finalName, money: DEFAULT_MONEY, wins: 0, losses: 0, created: Date.now()
      }).then(function (res) {
        if (res === null) throw new Error('register failed');
        return { id: auth.uid, name: finalName };
      });
    });
  }

  // ───────────── 모달 ─────────────
  function showModal() {
    var modal = document.getElementById('cg-name-modal');
    var input = document.getElementById('cg-name-input');
    var ok = document.getElementById('cg-name-ok');
    var msg = document.getElementById('cg-name-msg');
    if (!modal) { finishNewUser('Player'); return; }
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
        modal.classList.add('hidden');
        finishNewUser(u.name);
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
    myMoney = DEFAULT_MONEY; lastPutMoney = DEFAULT_MONEY;
    _resolveMoney(DEFAULT_MONEY);
    startRankingPoll();
  }
  function finishReturning(money) {
    myMoney = (money != null && money >= 0) ? money : DEFAULT_MONEY;
    lastPutMoney = myMoney;
    _resolveMoney(myMoney);
    startRankingPoll();
  }

  // ───────────── 랭킹 패널 토글 ─────────────
  function setupRankingToggle() {
    var panel = document.getElementById('cg-ranking');
    var closeBtn = document.getElementById('cg-rank-close');
    var openBtn = document.getElementById('cg-rank-open');
    if (!panel) return;
    if (closeBtn) closeBtn.addEventListener('click', function () {
      panel.classList.add('hidden'); if (openBtn) openBtn.classList.remove('hidden');
    });
    if (openBtn) openBtn.addEventListener('click', function () {
      panel.classList.remove('hidden'); openBtn.classList.add('hidden');
    });
  }

  // ───────────── 부트 ─────────────
  function boot() {
    setupRankingToggle();
    ensureAuth().then(function (okAuth) {
      if (!okAuth || !auth.uid) {
        console.warn('[CARD] 익명 인증 실패 — Firebase 익명 로그인 설정/API키 확인 필요');
        // 인증 실패해도 게임은 진행 (랭킹 쓰기만 안 됨)
        finishNewUser(playerName || 'Player');
        return;
      }
      playerId = auth.uid;
      getJson('/users/' + auth.uid).then(function (u) {
        if (u && typeof u.money === 'number') {     // 복귀 사용자
          playerName = u.name || 'Player';
          myWins = u.wins || 0; myLosses = u.losses || 0;
          finishReturning(u.money);
        } else {                                    // 새 익명 사용자 → 이름 등록
          showModal();
        }
      });
    });
  }

  // ───────────── 머니 변화 ─────────────
  function onGoldChanged(money) {
    if (typeof money !== 'number' || money < 0) return;
    if (money > MONEY_CAP) money = MONEY_CAP;
    myMoney = money;
    if (playerId && money !== lastPutMoney) {
      lastPutMoney = money;
      writeJson('/users/' + playerId + '/money', money);
    }
    renderRankingFromCache();
  }

  // ───────────── 라운드 결과 승/패 ─────────────
  function onResult(outcome) {
    if (!playerId) return;
    if (outcome === 'win') {
      myWins += 1; writeJson('/users/' + playerId + '/wins', myWins);
    } else if (outcome === 'loss') {
      myLosses += 1; writeJson('/users/' + playerId + '/losses', myLosses);
    }
    renderRankingFromCache();
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
        arr.push({ id: id, name: u.name || '?',
          money: (typeof u.money === 'number') ? u.money : 0,
          wins: u.wins || 0, losses: u.losses || 0 });
      }
      _rankCache = arr;
      renderRankingFromCache();
    });
  }
  function renderRankingFromCache() {
    var listEl = document.getElementById('cg-rank-list');
    var meEl = document.getElementById('cg-me');
    if (!listEl) return;
    var arr = _rankCache.map(function (u) {
      if (u.id === playerId) {
        return { id: u.id, name: playerName || u.name, money: myMoney, wins: myWins, losses: myLosses };
      }
      return u;
    });
    arr = arr.filter(function (u) { return ((u.wins || 0) + (u.losses || 0)) > 0; });
    arr.sort(function (a, b) { return b.money - a.money; });
    var myIdx = -1;
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
      meEl.textContent = (playerName || '나') + ' · ' + fmt(myMoney) + ' · ' + rankTxt +
        ' · ' + myWins + '승 ' + myLosses + '패';
    }
  }

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
    onResult: onResult,
    getPlayerId: function () { return playerId; }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
