/**
 * 首爾記帳 — 雲端同步後端（共用帳本版）
 *
 * 貼到 Google 試算表的 Apps Script 裡，部署成網頁 App。
 * 設定步驟見 SYNC.md。
 *
 * 一次來回同時做上傳與下載：手機把整包送上來，這邊按 id 合併
 * （at 比較大的那筆贏），再把合併結果整包回傳。
 * 所以兩支手機同時記帳不會互相抹掉，每次同步也都會自我修正。
 *
 * 刪除是用 del 欄位留墓碑，不是真的刪列——真的刪掉的話，
 * 另一支還留著那筆的手機下次同步會把它復活。
 */

var LEDGER = 'ledger';
var MEMBERS = 'members';
var RATES = 'rates';

var L_HEAD = ['群組', 'ID', '類型', 'Day', '分類', '韓元', '原始台幣', '項目',
              '付款人', '分攤人', '收款人', '刪除', '版本', '更新時間'];
var M_HEAD = ['群組', 'ID', '名字', '刪除', '版本', '更新時間'];
var R_HEAD = ['日期', 'KRW→TWD', '來源', '更新時間'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    var req = JSON.parse(e.postData.contents);
    var group = String(req.group || '').trim();
    if (!group) return out({ ok: false, err: 'no group' });

    /* 每日匯率：跟記帳分開走，因為要對外抓 Visa，比較慢也比較容易失敗 */
    if (req.act === 'rates') {
      var diag = [];
      var rr = syncRates(req.dates, req.manual, diag);
      return out({ ok: true, rates: rr, diag: diag, now: Date.now() });
    }
    if (req.act !== 'sync') return out({ ok: false, err: 'unknown act' });

    var rows = mergeRows(group, Array.isArray(req.rows) ? req.rows : []);
    var mems = mergeMems(group, Array.isArray(req.mems) ? req.mems : []);
    /* now 給手機對時用：合併是比 at 大小，手機時間不準會讓別人的修改永遠輸 */
    return out({ ok: true, rows: rows, mems: mems, now: Date.now() });
  } catch (err) {
    return out({ ok: false, err: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* 讀取用，方便在瀏覽器裡直接檢查資料 */
function doGet(e) {
  try {
    var group = String((e && e.parameter && e.parameter.group) || '').trim();
    if (!group) return out({ ok: false, err: 'no group' });
    return out({ ok: true, rows: readRows(group), mems: readMems(group), now: Date.now() });
  } catch (err) {
    return out({ ok: false, err: String(err) });
  }
}

function sheet(name, head) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    sh.setFrozenRows(1);
  }
  return sh;
}

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

/* ── 記帳 ── */

function readRows(group) {
  var sh = sheet(LEDGER, L_HEAD);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, L_HEAD.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (String(v[0]).trim() !== group) continue;
    var id = String(v[1]).trim();
    if (!id) continue;
    var r = { id: id, at: num(v[12]) };
    if (String(v[2]) === 'pay') {
      r.t = 'pay';
      r.a = Math.round(num(v[5]));
      r.by = String(v[8] || '');
      r.to = String(v[10] || '');
      /* 還款的幣別借用「分攤人」欄放（pay 類型本來就沒有分攤人），
         這樣不用加欄位、不會動到既有試算表的寬度 */
      if (String(v[9] || '').trim() === 'tw') r.tw = 1;
    } else {
      r.d = num(v[3]);
      r.c = String(v[4] || '其他');
      r.a = Math.round(num(v[5]));
      if (num(v[6]) > 0) r.nt = Math.round(num(v[6]));
      r.n = String(v[7] || '');
      r.by = String(v[8] || '');
      var sh2 = String(v[9] || '').trim();
      r.sh = sh2 ? sh2.split(',') : [];
    }
    if (String(v[11]) === '1') r.del = 1;
    out.push(r);
  }
  return out;
}

function mergeRows(group, incoming) {
  var cur = readRows(group);
  var map = {};
  var order = [];
  /* 寫入若曾經中途失敗，同一個 id 可能留著新舊兩列。後面那列是新的，讓它蓋掉
     前面那列，順序只記一次——否則合併結果會出現重複，而且愈滾愈多。 */
  cur.forEach(function (r) {
    if (map[r.id] === undefined) order.push(r.id);
    map[r.id] = r;
  });

  incoming.forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    var id = String(x.id || '').trim();
    if (!id) return;
    var at = num(x.at);
    var old = map[id];
    if (old && num(old.at) >= at) return;      /* 現有的比較新，留著 */
    var r;
    if (x.t === 'pay') {
      r = { id: id, t: 'pay', a: Math.round(num(x.a)), by: String(x.by || ''),
            to: String(x.to || ''), at: at };
      if (!r.by || !r.to) return;
      if (x.tw) r.tw = 1;
    } else {
      r = { id: id, d: num(x.d), c: String(x.c || '其他'), a: Math.round(num(x.a)),
            n: String(x.n || ''), by: String(x.by || ''),
            sh: Array.isArray(x.sh) ? x.sh.map(String) : [], at: at };
      if (num(x.nt) > 0) r.nt = Math.round(num(x.nt));
    }
    if (x.del) r.del = 1;
    if (!r.del && !(r.a > 0)) return;          /* 活著的紀錄一定要有金額 */
    if (!old) order.push(id);
    map[id] = r;
  });

  var merged = order.map(function (id) { return map[id]; });
  writeRows(group, merged);
  return merged;
}

/* 先把新資料寫到表尾，確定落地之後才刪舊列。
   反過來做（先刪再寫）的話，腳本要是在這兩步中間逾時或出錯，
   這個群組的資料就整個從表上消失了。 */
function writeRows(group, rows) {
  var sh = sheet(LEDGER, L_HEAD);
  var oldEnd = sh.getLastRow();
  if (!rows.length) { dropGroup(sh, group, oldEnd); return; }
  var now = new Date();
  var body = rows.map(function (r) {
    return [group, r.id, r.t === 'pay' ? 'pay' : 'exp',
            r.t === 'pay' ? '' : num(r.d),
            r.t === 'pay' ? '' : String(r.c || ''),
            num(r.a),
            num(r.nt) > 0 ? num(r.nt) : '',
            r.t === 'pay' ? '' : String(r.n || ''),
            String(r.by || ''),
            r.t === 'pay' ? (r.tw ? 'tw' : '') : (r.sh || []).join(','),
            r.t === 'pay' ? String(r.to || '') : '',
            r.del ? '1' : '',
            num(r.at),
            now];
  });
  sh.getRange(oldEnd + 1, 1, body.length, L_HEAD.length).setValues(body);
  SpreadsheetApp.flush();
  dropGroup(sh, group, oldEnd);
}

/* ── 成員 ── */

function readMems(group) {
  var sh = sheet(MEMBERS, M_HEAD);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, M_HEAD.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (String(v[0]).trim() !== group) continue;
    var id = String(v[1]).trim();
    if (!id) continue;
    var r = { id: id, n: String(v[2] || id), at: num(v[4]) };
    if (String(v[3]) === '1') r.del = 1;
    out.push(r);
  }
  return out;
}

function mergeMems(group, incoming) {
  var cur = readMems(group);
  var map = {}, order = [];
  cur.forEach(function (m) {
    if (map[m.id] === undefined) order.push(m.id);
    map[m.id] = m;
  });

  incoming.forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    var id = String(x.id || '').trim();
    if (!id) return;
    var at = num(x.at);
    var old = map[id];
    if (old && num(old.at) >= at) return;
    var m = { id: id, n: String(x.n || id).trim() || id, at: at };
    if (x.del) m.del = 1;
    if (!old) order.push(id);
    map[id] = m;
  });

  var merged = order.map(function (id) { return map[id]; });
  writeMems(group, merged);
  return merged;
}

function writeMems(group, mems) {
  var sh = sheet(MEMBERS, M_HEAD);
  var oldEnd = sh.getLastRow();
  if (!mems.length) { dropGroup(sh, group, oldEnd); return; }
  var now = new Date();
  var body = mems.map(function (m) {
    return [group, m.id, String(m.n || ''), m.del ? '1' : '', num(m.at), now];
  });
  sh.getRange(oldEnd + 1, 1, body.length, M_HEAD.length).setValues(body);
  SpreadsheetApp.flush();
  dropGroup(sh, group, oldEnd);
}

/* ── 每日匯率 ──
   結算要按「消費當天」的匯率換算，不然刷卡日期不同的人會多付或少付。
   抓到的匯率永久快取：過去某一天的匯率不會再變，沒必要重抓。
   手動填的優先權最高，Visa 永遠不會蓋掉它。 */

function readRates() {
  var sh = sheet(RATES, R_HEAD);
  var last = sh.getLastRow();
  var map = {};
  if (last < 2) return map;
  var vals = sh.getRange(2, 1, last - 1, R_HEAD.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var d = ymd(vals[i][0]);
    var v = Number(vals[i][1]);
    if (!d || !isFinite(v) || v <= 0) continue;
    map[d] = { r: v, src: String(vals[i][2] || '') };
  }
  return map;
}

/* 試算表可能把日期存成 Date 物件也可能是字串，統一成 YYYY-MM-DD */
function ymd(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  }
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function syncRates(dates, manual, diag) {
  var map = readRates();
  var dirty = false;

  /* 手動輸入的先寫進去，之後就不會再被 Visa 蓋掉 */
  if (manual && typeof manual === 'object') {
    for (var k in manual) {
      if (!ymd(k)) continue;
      var mv = Number(manual[k]);
      if (!isFinite(mv) || mv <= 0) continue;
      map[k] = { r: mv, src: '手動' };
      dirty = true;
    }
  }

  var want = Array.isArray(dates) ? dates : [];
  for (var i = 0; i < want.length; i++) {
    var d = ymd(want[i]);
    if (!d || map[d]) continue;              /* 已經有了就不要再抓 */
    var got = visaRate(d);
    if (got.r == null) {                     /* 抓不到就留空，下次再試 */
      if (diag && diag.length < 4) diag.push(d + '：' + got.err);
      continue;
    }
    map[d] = { r: got.r, src: 'visa' };
    dirty = true;
  }

  if (dirty) writeRates(map);

  var outMap = {};
  for (var kk in map) outMap[kk] = { r: map[kk].r, src: map[kk].src };
  return outMap;
}

function writeRates(map) {
  var sh = sheet(RATES, R_HEAD);
  var oldEnd = sh.getLastRow();
  var keys = Object.keys(map).sort();
  if (!keys.length) { dropRates(sh, oldEnd); return; }
  var now = new Date();
  var body = keys.map(function (d) {
    return [d, map[d].r, map[d].src || '', now];
  });
  sh.getRange(oldEnd + 1, 1, body.length, R_HEAD.length).setValues(body);
  SpreadsheetApp.flush();
  dropRates(sh, oldEnd);
}

/* 匯率表沒有群組欄，整段舊資料直接刪掉 */
function dropRates(sh, upto) {
  var last = sh.getLastRow();
  if (upto && upto < last) last = upto;
  for (var i = last; i >= 2; i--) sh.deleteRow(i);
}

/* Visa 的匯率查詢端點。這是他們網站自己用的，沒有正式文件，
   所以回應盡量寬鬆地解析，而且一定要通過合理範圍檢查才採用——
   寧可抓不到讓使用者手動填，也不要存一個錯的數字進去。 */
/* 在 Apps Script 編輯器裡選這支來執行：
   第一次跑會跳出授權對話框（UrlFetchApp 需要「連線至外部服務」權限，
   當初授權時程式碼還沒有這段，所以不會自動要求）。
   授權完它會把每個網址的實際結果印在執行紀錄裡，行不行一看就知道。 */
function testVisa() {
  var date = '2026-08-11';
  var p = date.split('-');
  var md = p[1] + '/' + p[2] + '/' + p[0];
  var qs = '/cmsapi/fx/rates?amount=1&fee=0'
         + '&utcConvertedDate=' + encodeURIComponent(md)
         + '&exchangedate=' + encodeURIComponent(md)
         + '&fromCurr=TWD&toCurr=KRW';
  for (var i = 0; i < VISA_HOSTS.length; i++) {
    var u = VISA_HOSTS[i] + qs;
    try {
      var res = UrlFetchApp.fetch(u, {
        muteHttpExceptions: true, followRedirects: true,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
        }
      });
      Logger.log(VISA_HOSTS[i] + ' → HTTP ' + res.getResponseCode());
      Logger.log('  ' + res.getContentText().substring(0, 300));
    } catch (err) {
      Logger.log(VISA_HOSTS[i] + ' → 例外：' + err);
    }
  }
  Logger.log('解析結果：' + JSON.stringify(visaRate(date)));
}

var VISA_HOSTS = ['https://usa.visa.com', 'https://www.visa.com.tw', 'https://www.visa.com.sg'];

function visaRate(date) {
  var p = date.split('-');
  var md = p[1] + '/' + p[2] + '/' + p[0];
  var qs = '/cmsapi/fx/rates?amount=1&fee=0'
         + '&utcConvertedDate=' + encodeURIComponent(md)
         + '&exchangedate=' + encodeURIComponent(md)
         + '&fromCurr=TWD&toCurr=KRW';
  var last = '沒有可用的來源';
  for (var i = 0; i < VISA_HOSTS.length; i++) {
    try {
      var res = UrlFetchApp.fetch(VISA_HOSTS[i] + qs, {
        muteHttpExceptions: true, followRedirects: true,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
        }
      });
      var code = res.getResponseCode();
      if (code !== 200) { last = 'HTTP ' + code; continue; }
      var body = res.getContentText();
      var o;
      try { o = JSON.parse(body); }
      catch (e) { last = '回應不是 JSON（' + body.substring(0, 40) + '…）'; continue; }
      var v = pickRate(o);
      if (v == null) { last = '找不到匯率欄位（' + Object.keys(o).join(',').substring(0, 40) + '）'; continue; }
      /* 換算方向不確定：KRW→TWD 約 0.023、TWD→KRW 約 43。
         兩者差三個數量級，用大小就分得出來，該倒過來就倒過來。 */
      var rate = v > 1 ? 1 / v : v;
      if (rate < 0.005 || rate > 0.1) { last = '數字不合理（' + v + '）'; continue; }
      return { r: rate, err: '' };
    } catch (err) {
      last = String(err).substring(0, 60);
    }
  }
  return { r: null, err: last };
}

function pickRate(o) {
  if (!o || typeof o !== 'object') return null;
  var names = ['conversionRate', 'fxRateVisa', 'fxRateWithAdditionalFee', 'convertedAmount'];
  for (var i = 0; i < names.length; i++) {
    var v = Number(o[names[i]]);
    if (isFinite(v) && v > 0) return v;
    if (o.originalValues) {
      var v2 = Number(o.originalValues[names[i]]);
      if (isFinite(v2) && v2 > 0) return v2;
    }
  }
  return null;
}

/* 從後面往前刪，才不會邊刪邊位移。
   upto 是舊資料的最後一列：只刪這一列以前的，剛寫進去的新資料不能碰。 */
function dropGroup(sh, group, upto) {
  var last = sh.getLastRow();
  if (upto && upto < last) last = upto;
  if (last < 2) return;
  var col = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0]).trim() === group) sh.deleteRow(i + 2);
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
