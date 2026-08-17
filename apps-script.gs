/**
 * 首爾記帳 — 雲端同步後端
 *
 * 貼到 Google 試算表的 Apps Script 裡，部署成網頁 App。
 * 設定步驟見 SYNC.md。
 *
 * 每一列第一欄是「代號」。上傳時只會刪掉並重寫自己代號的那些列，
 * 不同代號各自獨立，兩支手機不會互相蓋掉。
 */

var TAB  = 'expenses';
var HEAD = ['代號', 'Day', '分類', '韓元', '原始台幣', '項目', '更新時間'];

/* 讀取：GET ?act=pull&user=代號 */
function doGet(e) {
  try {
    var user = String((e && e.parameter && e.parameter.user) || '').trim();
    if (!user) return out({ ok: false, err: 'no user' });
    return out({ ok: true, rows: readUser(user) });
  } catch (err) {
    return out({ ok: false, err: String(err) });
  }
}

/* 寫入：POST {act:"push", user:"代號", rows:[...]} */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var req = JSON.parse(e.postData.contents);
    var user = String(req.user || '').trim();
    if (!user) return out({ ok: false, err: 'no user' });
    if (req.act !== 'push') return out({ ok: false, err: 'unknown act' });
    var rows = Array.isArray(req.rows) ? req.rows : [];
    writeUser(user, rows);
    return out({ ok: true, n: rows.length });
  } catch (err) {
    return out({ ok: false, err: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB);
  if (!sh) {
    sh = ss.insertSheet(TAB);
    sh.appendRow(HEAD);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readUser(user) {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, HEAD.length).getValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[0]).trim() !== user) continue;
    var a = Number(r[3]);
    if (!(a > 0)) continue;
    var rec = { d: Number(r[1]) || 0, c: String(r[2] || '其他'), a: Math.round(a), n: String(r[5] || '') };
    if (Number(r[4]) > 0) rec.nt = Math.round(Number(r[4]));
    rows.push(rec);
  }
  return rows;
}

/* 先把這個代號的舊列全部清掉，再整批寫回。
   一個代號只會有一支手機在寫，所以「整批取代」不會弄丟別人的資料。 */
function writeUser(user, rows) {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last >= 2) {
    var col = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = col.length - 1; i >= 0; i--) {
      if (String(col[i][0]).trim() === user) sh.deleteRow(i + 2);
    }
  }
  if (!rows.length) return;
  var at = new Date();
  var body = rows.map(function (x) {
    return [
      user,
      Number(x.d) || 0,
      String(x.c || '其他'),
      Number(x.a) || 0,
      Number(x.nt) > 0 ? Number(x.nt) : '',
      String(x.n || ''),
      at
    ];
  });
  sh.getRange(sh.getLastRow() + 1, 1, body.length, HEAD.length).setValues(body);
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
