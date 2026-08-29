/**
 * 統合ダッシュボード + LINE / LINE WORKS 受信連携 (2026-08-29)
 *
 * 【全体像】「9つの確認先を1画面へ」方式
 *   LINE WORKS Bot ──┐ (Callback Webhook)
 *   LINE公式アカウント┴→ doPost(?hook=...) → 受信メッセージログ シートに蓄積
 *   Chatwork API / Gmail / 発注一覧 / 広告シート → getDashboardData で集約
 *   → ?page=dashboard&key=... の1画面ダッシュボードに表示
 *
 * 【LINE WORKS フリープランでの工夫】
 *   トーク履歴のエクスポート/監査ログは有償プラン機能だが、
 *   Bot(チャットボット)の登録・Callback受信はフリープランでも無料で利用可能。
 *   → Botをトークルームに招待し、流れてくるメッセージをWebhookで受けて
 *     スプレッドシートに蓄積する方式にした（招待以降のメッセージのみ蓄積）。
 *   ※APIレート制限(フリー: 60リクエスト/分)は「受信」には実質影響なし。
 *
 * 【セットアップ】docs/ダッシュボード_LINE_LINEWORKS連携.md 参照
 *   1. GASエディタで setupDashboard を実行（シート作成+トークン発行）
 *   2. 「デプロイ > デプロイを管理 > 編集 > 新バージョン」で再デプロイ
 *   3. LINE WORKS Developer Console / LINE Developers にWebhook URLを登録
 *
 * 【スクリプトプロパティ】(プロジェクトの設定 > スクリプト プロパティ)
 *   WEBHOOK_TOKEN            : Webhook認証トークン (setupDashboardが自動生成)
 *   DASHBOARD_KEY            : ダッシュボード画面のアクセスキー (自動生成)
 *   CHATWORK_API_TOKEN       : Chatwork APIトークン (任意・未読数の表示に使用)
 *   LINE_CHANNEL_ACCESS_TOKEN: LINE Messaging APIのチャネルアクセストークン
 *                              (任意・送信者名/グループ名の自動解決に使用)
 *   ADS_SPREADSHEET_ID       : 広告実績スプレッドシートID (任意)
 *   ADS_SHEET_NAME           : 広告実績のシート名 (任意・省略時は先頭シート)
 *   ALERT_KEYWORDS           : 要対応キーワード カンマ区切り (任意・省略時は既定値)
 */

// ============ ダッシュボード定数 ============
var DASH_INBOX_SHEET = '受信メッセージログ';
var DASH_NAMEMAP_SHEET = '名前対応表';
var DASH_INBOX_MAX_ROWS = 5000;      // ログの最大保持行数(超えたら古い行から削除)
var DASH_DEFAULT_KEYWORDS = ['至急', '大至急', '緊急', 'クレーム', 'トラブル', '故障', 'ガス漏れ', '保安', '見積', '発注', '請求', '支払', 'キャンセル', '本日中', '今日中', '急ぎ'];

function _dashProps() { return PropertiesService.getScriptProperties(); }
function _dashTz() { return Session.getScriptTimeZone() || 'Asia/Tokyo'; }
function _dashRandomKey() { return Utilities.getUuid().replace(/-/g, ''); }
function _fmtDT(d, tz) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, tz || _dashTz(), 'MM/dd HH:mm');
}
function _shortId(id) { return id ? String(id).slice(0, 8) + '…' : '不明'; }
function _md5short(seed) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, seed, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex.slice(0, 20);
}

// ============ 初期設定 (GASエディタから1回実行) ============
function setupDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  _ensureInboxSheet(ss);
  _ensureNameMapSheet(ss);
  var props = _dashProps();
  if (!props.getProperty('WEBHOOK_TOKEN')) props.setProperty('WEBHOOK_TOKEN', _dashRandomKey());
  if (!props.getProperty('DASHBOARD_KEY')) props.setProperty('DASHBOARD_KEY', _dashRandomKey());
  var wt = props.getProperty('WEBHOOK_TOKEN');
  var dk = props.getProperty('DASHBOARD_KEY');
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  var base = url || '<WebアプリURL(デプロイ後に確認)>';
  Logger.log('====== 統合ダッシュボード初期設定 完了 ======');
  Logger.log('');
  Logger.log('【1】LINE WORKS Bot の Callback URL (Developer Consoleに登録):');
  Logger.log(base + '?hook=lineworks&token=' + wt);
  Logger.log('');
  Logger.log('【2】LINE公式アカウント(Messaging API) の Webhook URL:');
  Logger.log(base + '?hook=line&token=' + wt);
  Logger.log('');
  Logger.log('【3】ダッシュボード画面URL (ブックマーク/スマホのホーム画面に追加):');
  Logger.log(base + '?page=dashboard&key=' + dk);
  Logger.log('');
  Logger.log('※URL先頭が表示されていない場合は未デプロイです。「デプロイ > デプロイを管理」でWebアプリURLを確認し、上記のパラメータを付けてください。');
  Logger.log('※詳しい手順: docs/ダッシュボード_LINE_LINEWORKS連携.md');
  return { url: url, webhookToken: wt, dashboardKey: dk };
}

// ★ 動作確認用: 偽のLINE WORKSメッセージを1件記録する (GASエディタから実行)
function testInboundWebhook() {
  _recordLineWorksEvent({
    type: 'message',
    source: { userId: 'test-user-001', channelId: 'test-channel-001' },
    issuedTime: new Date().toISOString(),
    content: { type: 'text', text: 'テストメッセージです（至急の確認をお願いします）' }
  }, '(testInboundWebhookで生成)');
  Logger.log('「' + DASH_INBOX_SHEET + '」シートにテスト行を追加しました。ダッシュボードを開いて表示を確認してください。');
}

// ============ シート準備 ============
function _ensureInboxSheet(ss) {
  var s = ss.getSheetByName(DASH_INBOX_SHEET);
  if (s) return s;
  s = ss.insertSheet(DASH_INBOX_SHEET);
  var headers = ['受信日時', 'チャネル', 'トークルーム', '送信者', '本文', '要対応', '送信者ID', 'ルームID', 'メッセージID', '種別', 'RAW'];
  s.getRange(1, 1, 1, headers.length).setValues([headers]);
  s.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#fff');
  s.setFrozenRows(1);
  s.setColumnWidth(1, 110);  // 受信日時
  s.setColumnWidth(2, 90);   // チャネル
  s.setColumnWidth(3, 140);  // トークルーム
  s.setColumnWidth(4, 100);  // 送信者
  s.setColumnWidth(5, 340);  // 本文
  s.setColumnWidth(6, 90);   // 要対応
  s.setColumnWidth(11, 200); // RAW
  return s;
}

function _ensureNameMapSheet(ss) {
  var s = ss.getSheetByName(DASH_NAMEMAP_SHEET);
  if (s) return s;
  s = ss.insertSheet(DASH_NAMEMAP_SHEET);
  var headers = ['チャネル', '種別', 'ID', '表示名(手入力OK)', 'メモ'];
  s.getRange(1, 1, 1, headers.length).setValues([headers]);
  s.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
  s.setFrozenRows(1);
  s.setColumnWidth(3, 260);
  s.setColumnWidth(4, 160);
  s.setColumnWidth(5, 200);
  // 使い方メモ (LINE WORKSはAPI都合で名前が取れないため、ここで人力マッピングする)
  s.getRange(2, 5).setValue('← LINE WORKSの送信者/ルームは初回受信時にIDだけ自動追記されます。表示名を入力するとダッシュボードに名前で表示されます');
  return s;
}

// ============ 名前対応表 (LINE WORKSのuserId/channelId → 表示名) ============
// 返り値: 表示名(未登録IDなら autoName で行を自動追記して autoName を返す)
function _resolveViaMap(channel, kind, id, autoName) {
  if (!id) return '';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = _ensureNameMapSheet(ss);
  var last = s.getLastRow();
  if (last >= 2) {
    var vals = s.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][2]) === String(id)) return String(vals[i][3] || '');
    }
  }
  // 未登録 → 行を自動追記(表示名は空 or API解決済みの名前)
  try { s.appendRow([channel, kind, String(id), autoName || '', '']); } catch (e) {}
  return autoName || '';
}

// ============ Webhook受信 (doPostから委譲) ============
// GASのdoPostはHTTPヘッダーを読めず署名検証(X-WORKS-Signature / X-Line-Signature)が
// 使えないため、代わりにURLの ?token= で認証する(URLは外部に出さないこと)。
function handleInboundWebhook(e) {
  var ok = ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  try {
    var hook = e.parameter.hook;
    var token = e.parameter.token || '';
    var expected = _dashProps().getProperty('WEBHOOK_TOKEN');
    if (!expected || token !== expected) {
      Logger.log('Webhook拒否: トークン不一致 (hook=' + hook + ')');
      return ContentService.createTextOutput('unauthorized');
    }
    var body = (e.postData && e.postData.contents) ? e.postData.contents : '';
    if (!body) return ok;  // LINEの疎通確認等、空ボディはそのまま200
    var json = JSON.parse(body);
    if (hook === 'lineworks') {
      _recordLineWorksEvent(json, body);
    } else if (hook === 'line') {
      _recordLineEvents(json, body);
    } else {
      Logger.log('Webhook: 未知のhook=' + hook);
    }
  } catch (er) {
    Logger.log('Webhook処理エラー: ' + er.toString());
  }
  return ok;  // 送信元のリトライ嵐を防ぐため常に200を返す
}

// ---- LINE WORKS Botコールバック (API 2.0形式・旧1.0形式も防御的に対応) ----
// 例: { type:'message', source:{userId, channelId, domainId},
//       issuedTime:'2026-08-29T03:00:00.000Z', content:{type:'text', text:'...'} }
function _recordLineWorksEvent(json, raw) {
  if (!json) return;
  if (json.type !== 'message') {
    Logger.log('LINE WORKS: message以外のイベント(' + json.type + ')はスキップ');
    return;
  }
  var src = json.source || {};
  var when = null;
  if (json.issuedTime) when = new Date(json.issuedTime);
  else if (json.createdTime) when = new Date(Number(json.createdTime));
  if (!when || isNaN(when.getTime())) when = new Date();

  var text = _lwContentToText(json.content || {});
  // LINE WORKSコールバックには一意のメッセージIDが無いため、内容から生成して重複排除
  var dedupId = 'lw_' + _md5short((src.channelId || 'dm') + '|' + (src.userId || '') + '|' + (json.issuedTime || json.createdTime || '') + '|' + text);
  if (_dashSeenBefore(dedupId)) return;

  var senderName = _resolveViaMap('LINE WORKS', 'ユーザー', src.userId, '');
  var roomId = src.channelId || '';
  var roomLabel;
  if (roomId) {
    var rn = _resolveViaMap('LINE WORKS', 'トークルーム', roomId, '');
    roomLabel = rn || ('ルーム ' + _shortId(roomId));
  } else {
    roomLabel = '1:1トーク';
  }
  _appendInboundRow({
    when: when, channel: 'LINE WORKS',
    room: roomLabel, roomId: roomId,
    sender: senderName || _shortId(src.userId), senderId: src.userId || '',
    text: text, msgId: dedupId, evType: 'message', raw: raw
  });
}

function _lwContentToText(c) {
  var t = c.type || '';
  if (t === 'text') return String(c.text || '');
  if (t === 'image') return '[画像]';
  if (t === 'sticker') return '[スタンプ]';
  if (t === 'file') return '[ファイル] ' + (c.fileName || '');
  if (t === 'location') return '[位置情報] ' + (c.address || '');
  return '[' + (t || '不明') + ']';
}

// ---- LINE Messaging API Webhook ----
// 例: { destination:'U...', events:[ { type:'message', timestamp:169...,
//        source:{type:'group', groupId, userId}, message:{id, type:'text', text}, webhookEventId, ... } ] }
function _recordLineEvents(json, raw) {
  var events = (json && json.events) || [];
  for (var i = 0; i < events.length; i++) {
    try { _recordOneLineEvent(events[i], raw); }
    catch (er) { Logger.log('LINEイベント記録エラー: ' + er.toString()); }
  }
}

function _recordOneLineEvent(ev, raw) {
  if (!ev) return;
  var text = '';
  var type = ev.type || '';
  if (type === 'message') text = _lineMessageToText(ev.message || {});
  else if (type === 'follow') text = '(友だち追加されました)';
  else if (type === 'join') text = '(グループ/複数人トークに追加されました)';
  else if (type === 'leave' || type === 'unfollow') text = '(' + type + ': 退出/ブロック)';
  else return;  // その他(unsend, memberJoined等)は記録しない

  var dedupId = ev.webhookEventId || (ev.message && ev.message.id ? 'lnmsg_' + ev.message.id : '');
  if (_dashSeenBefore(dedupId)) return;

  var src = ev.source || {};
  var when = ev.timestamp ? new Date(Number(ev.timestamp)) : new Date();
  var sender = _resolveLineSender(src);
  var room = _resolveLineRoom(src);
  _appendInboundRow({
    when: when, channel: 'LINE',
    room: room.label, roomId: room.id,
    sender: sender, senderId: src.userId || '',
    text: text, msgId: dedupId || ('ln_' + _md5short(raw.slice(0, 500) + when.getTime())), evType: type, raw: raw
  });
}

function _lineMessageToText(m) {
  var t = m.type || '';
  if (t === 'text') return String(m.text || '');
  if (t === 'image') return '[画像]';
  if (t === 'video') return '[動画]';
  if (t === 'audio') return '[音声]';
  if (t === 'file') return '[ファイル] ' + (m.fileName || '');
  if (t === 'sticker') return '[スタンプ]';
  if (t === 'location') return '[位置情報] ' + (m.address || '');
  return '[' + (t || '不明') + ']';
}

// LINEの送信者名: チャネルアクセストークンがあればAPIで表示名を解決(6時間キャッシュ)
function _resolveLineSender(src) {
  var uid = src.userId || '';
  if (!uid) return '不明';
  var cache = CacheService.getScriptCache();
  var ck = 'dash_ln_u_' + uid;
  var hit = cache.get(ck);
  if (hit) return hit;
  var name = '';
  var j = null;
  if (src.type === 'group' && src.groupId) j = _lineApiGetJson('/v2/bot/group/' + src.groupId + '/member/' + uid);
  else if (src.type === 'room' && src.roomId) j = _lineApiGetJson('/v2/bot/room/' + src.roomId + '/member/' + uid);
  else j = _lineApiGetJson('/v2/bot/profile/' + uid);
  if (j && j.displayName) name = String(j.displayName);
  // 対応表にも自動登録(APIで解決できなければ空欄行→手入力で補完できる)
  var mapped = _resolveViaMap('LINE', 'ユーザー', uid, name);
  var out = mapped || name || _shortId(uid);
  try { cache.put(ck, out, 21600); } catch (e) {}
  return out;
}

function _resolveLineRoom(src) {
  if (src.type === 'group' && src.groupId) {
    var cache = CacheService.getScriptCache();
    var ck = 'dash_ln_g_' + src.groupId;
    var hit = cache.get(ck);
    if (hit) return { label: hit, id: src.groupId };
    var j = _lineApiGetJson('/v2/bot/group/' + src.groupId + '/summary');
    var nm = (j && j.groupName) ? String(j.groupName) : '';
    var mapped = _resolveViaMap('LINE', 'グループ', src.groupId, nm);
    var label = mapped || nm || ('グループ ' + _shortId(src.groupId));
    try { cache.put(ck, label, 21600); } catch (e) {}
    return { label: label, id: src.groupId };
  }
  if (src.type === 'room' && src.roomId) {
    var mapped2 = _resolveViaMap('LINE', '複数人トーク', src.roomId, '');
    return { label: mapped2 || ('複数人トーク ' + _shortId(src.roomId)), id: src.roomId };
  }
  return { label: '1:1トーク', id: '' };
}

function _lineApiGetJson(path) {
  var token = _dashProps().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.line.me' + path, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText());
  } catch (e) { return null; }
}

// ---- 共通: 重複排除 / 行追記 ----
function _dashSeenBefore(id) {
  if (!id) return false;
  var c = CacheService.getScriptCache();
  var k = 'dash_seen_' + id;
  if (c.get(k)) return true;
  try { c.put(k, '1', 21600); } catch (e) {}
  return false;
}

function _appendInboundRow(rec) {
  var kw = _findAlertKeywords(rec.text);
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) {}
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var s = _ensureInboxSheet(ss);
    s.appendRow([
      rec.when, rec.channel, rec.room, rec.sender,
      String(rec.text || '').slice(0, 500), kw,
      rec.senderId, rec.roomId, rec.msgId, rec.evType,
      String(rec.raw || '').slice(0, 1500)
    ]);
    var r = s.getLastRow();
    if (kw) s.getRange(r, 1, 1, 11).setBackground('#fdecea');  // 要対応行は薄赤
    if (r > DASH_INBOX_MAX_ROWS + 500) s.deleteRows(2, r - DASH_INBOX_MAX_ROWS);
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function _getAlertKeywords() {
  var p = _dashProps().getProperty('ALERT_KEYWORDS');
  if (!p) return DASH_DEFAULT_KEYWORDS.slice();
  return p.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function _findAlertKeywords(text) {
  var t = String(text || '');
  if (!t) return '';
  var hits = [];
  var kws = _getAlertKeywords();
  for (var i = 0; i < kws.length; i++) {
    if (t.indexOf(kws[i]) !== -1) hits.push(kws[i]);
  }
  return hits.join(',');
}

// ============ ダッシュボード画面 (doGetから委譲) ============
function serveDashboardPage(e) {
  var props = _dashProps();
  var key = props.getProperty('DASHBOARD_KEY');
  if (!key) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:24px"><h3>初期設定が未完了です</h3>' +
      '<p>GASエディタで <b>setupDashboard</b> を実行してから、再デプロイしてください。<br>' +
      '手順: docs/ダッシュボード_LINE_LINEWORKS連携.md</p></div>');
  }
  if ((e.parameter.key || '') !== key) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:24px"><h3>アクセスキーが違います</h3>' +
      '<p>URL末尾に <b>?page=dashboard&amp;key=（setupDashboardで発行したキー）</b> を付けてアクセスしてください。</p></div>');
  }
  var t = HtmlService.createTemplateFromFile('dashboard');
  t.dashKey = key;
  return t.evaluate()
    .setTitle('アイプロ 統合ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============ ダッシュボード用データ集約 (google.script.runから呼ばれる) ============
function getDashboardData(key) {
  var props = _dashProps();
  var realKey = props.getProperty('DASHBOARD_KEY');
  if (!realKey || key !== realKey) return { error: 'アクセスキーが不正です' };
  var tz = _dashTz();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    now: Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm:ss'),
    inbound: _collectInbound(ss, tz),
    chatwork: _collectChatwork(),
    gmail: _collectGmail(tz),
    orders: _collectOrders(ss, tz),
    ads: _collectAds(),
    keywords: _getAlertKeywords(),
    lineTokenSet: !!props.getProperty('LINE_CHANNEL_ACCESS_TOKEN')
  };
}

// ---- LINE WORKS / LINE 受信ログ集計 ----
function _collectInbound(ss, tz) {
  var out = {
    lw: { today: 0, total: 0 },
    line: { today: 0, total: 0 },
    alerts: [], recent: []
  };
  var s = ss.getSheetByName(DASH_INBOX_SHEET);
  if (!s || s.getLastRow() < 2) return out;
  var last = s.getLastRow();

  // 全期間の件数はチャネル列だけ読む(軽量)
  var chCol = s.getRange(2, 2, last - 1, 1).getValues();
  for (var i = 0; i < chCol.length; i++) {
    if (chCol[i][0] === 'LINE WORKS') out.lw.total++;
    else if (chCol[i][0] === 'LINE') out.line.total++;
  }

  // 直近400行から タイムライン/本日件数/要対応 を作る
  var start = Math.max(2, last - 399);
  var vals = s.getRange(start, 1, last - start + 1, 10).getValues();
  var nameMap = _nameMapAll();
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var now = Date.now();
  for (var j = vals.length - 1; j >= 0; j--) {
    var d = (vals[j][0] instanceof Date) ? vals[j][0] : null;
    var channel = String(vals[j][1] || '');
    var senderId = String(vals[j][6] || '');
    var roomId = String(vals[j][7] || '');
    var rec = {
      time: _fmtDT(d, tz),
      channel: channel,
      room: (roomId && nameMap[roomId]) || String(vals[j][2] || ''),
      sender: (senderId && nameMap[senderId]) || String(vals[j][3] || ''),
      text: String(vals[j][4] || '').slice(0, 150),
      kw: String(vals[j][5] || '')
    };
    var isToday = d && Utilities.formatDate(d, tz, 'yyyy-MM-dd') === todayStr;
    if (isToday) {
      if (channel === 'LINE WORKS') out.lw.today++;
      else if (channel === 'LINE') out.line.today++;
    }
    if (out.recent.length < 40) out.recent.push(rec);
    // 要対応 = 直近48時間のキーワードヒット
    if (rec.kw && d && (now - d.getTime()) < 48 * 3600 * 1000 && out.alerts.length < 15) {
      out.alerts.push(rec);
    }
  }
  return out;
}

// 名前対応表を {ID: 表示名} で取得(表示名が入っている行のみ)
function _nameMapAll() {
  var map = {};
  try {
    var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DASH_NAMEMAP_SHEET);
    if (!s || s.getLastRow() < 2) return map;
    var vals = s.getRange(2, 3, s.getLastRow() - 1, 2).getValues();  // C:ID, D:表示名
    for (var i = 0; i < vals.length; i++) {
      var id = String(vals[i][0] || ''), nm = String(vals[i][1] || '');
      if (id && nm) map[id] = nm;
    }
  } catch (e) {}
  return map;
}

// ---- Chatwork (APIトークン設定時のみ) ----
function _collectChatwork() {
  var token = _dashProps().getProperty('CHATWORK_API_TOKEN');
  if (!token) return { configured: false };
  try {
    var opt = { headers: { 'X-ChatWorkToken': token }, muteHttpExceptions: true };
    var res = UrlFetchApp.fetch('https://api.chatwork.com/v2/my/status', opt);
    if (res.getResponseCode() !== 200) {
      return { configured: true, error: 'Chatwork API応答 HTTP ' + res.getResponseCode() + '（トークンを確認してください）' };
    }
    var st = JSON.parse(res.getContentText());
    var rooms = [];
    var res2 = UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms', opt);
    if (res2.getResponseCode() === 200) {
      var all = JSON.parse(res2.getContentText()) || [];
      all.sort(function (a, b) {
        return (b.mention_num - a.mention_num) || (b.unread_num - a.unread_num);
      });
      for (var i = 0; i < all.length && rooms.length < 8; i++) {
        if (all[i].unread_num > 0 || all[i].mention_num > 0) {
          rooms.push({ name: String(all[i].name || ''), unread: all[i].unread_num, mention: all[i].mention_num });
        }
      }
    }
    return {
      configured: true,
      unread: st.unread_num, mention: st.mention_num, myTasks: st.mytask_num,
      rooms: rooms
    };
  } catch (er) {
    return { configured: true, error: String(er) };
  }
}

// ---- Gmail ----
function _collectGmail(tz) {
  try {
    var unread = GmailApp.search('in:inbox is:unread', 0, 100);
    var todayCount = GmailApp.search('in:inbox newer_than:1d', 0, 100).length;
    var latest = GmailApp.search('in:inbox', 0, 5).map(function (th) {
      var msgs = th.getMessages();
      var m = msgs[msgs.length - 1];
      return {
        from: _mailDisplayName(m.getFrom()),
        subject: (th.getFirstMessageSubject() || '(件名なし)').slice(0, 60),
        time: _fmtDT(m.getDate(), tz),
        unread: th.isUnread()
      };
    });
    return { configured: true, unread: unread.length, unreadCap: unread.length >= 100, today: todayCount, todayCap: todayCount >= 100, latest: latest };
  } catch (er) {
    return { configured: false, error: 'Gmailを読めません。再デプロイ後にスクリプトの再認証(gmail.readonly)が必要です: ' + String(er) };
  }
}

function _mailDisplayName(from) {
  var s = String(from || '');
  var m = s.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : s).slice(0, 30);
}

// ---- 発注システム状況 (このスプレッドシート) ----
function _collectOrders(ss, tz) {
  var out = { pending: 0, today: 0, stockAwaiting: 0, recent: [] };
  try {
    var s = ss.getSheetByName(INDEX_SHEET);
    if (s && s.getLastRow() >= 2) {
      var data = s.getDataRange().getValues();
      var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
      for (var i = 1; i < data.length; i++) {
        var status = String(data[i][10] || '');
        if (status === '申請中') out.pending++;
        var d = data[i][0];
        if (d instanceof Date && Utilities.formatDate(d, tz, 'yyyy-MM-dd') === todayStr) out.today++;
      }
      for (var j = data.length - 1; j >= 1 && out.recent.length < 5; j--) {
        if (!data[j][1] && !data[j][12]) continue;
        out.recent.push({
          time: _fmtDT(data[j][0] instanceof Date ? data[j][0] : null, tz),
          orderNo: String(data[j][1] || ''),
          supplier: String(data[j][3] || '').slice(0, 20),
          orderer: String(data[j][7] || ''),
          total: Number(data[j][6] || 0),
          status: String(data[j][10] || '')
        });
      }
    }
    // 在庫管理(本社/福岡): 入庫済みチェックがまだの明細数
    var stocks = _existingStockSheets(ss);
    for (var k = 0; k < stocks.length; k++) {
      var st = stocks[k];
      var lastRow = st.getLastRow();
      if (lastRow < 2) continue;
      var lastCol = st.getLastColumn();
      var headers = st.getRange(1, 1, 1, lastCol).getValues()[0];
      var cProduct = headers.indexOf('商品名');
      var cDone = headers.indexOf('入庫済み');
      var cStatus = headers.indexOf('ステータス');
      if (cProduct === -1 || cDone === -1) continue;
      var rows = st.getRange(2, 1, lastRow - 1, lastCol).getValues();
      for (var r = 0; r < rows.length; r++) {
        if (!rows[r][cProduct]) continue;
        if (rows[r][cDone] === true) continue;
        if (cStatus !== -1 && String(rows[r][cStatus] || '').indexOf('取消') !== -1) continue;
        out.stockAwaiting++;
      }
    }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

// ---- 広告サマリー (任意: ADS_SPREADSHEET_ID を設定した場合のみ) ----
function _collectAds() {
  var props = _dashProps();
  var pid = props.getProperty('ADS_SPREADSHEET_ID');
  if (!pid) return { configured: false };
  try {
    var file = SpreadsheetApp.openById(pid);
    var name = props.getProperty('ADS_SHEET_NAME');
    var sh = name ? file.getSheetByName(name) : file.getSheets()[0];
    if (!sh) return { configured: true, error: 'シートが見つかりません: ' + name };
    var lastRow = sh.getLastRow();
    var lastCol = Math.min(sh.getLastColumn(), 8);
    if (lastRow < 2 || lastCol < 1) return { configured: true, title: file.getName(), headers: [], rows: [] };
    var headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var n = Math.min(5, lastRow - 1);
    var rows = sh.getRange(lastRow - n + 1, 1, n, lastCol).getDisplayValues();
    return { configured: true, title: file.getName() + ' / ' + sh.getName(), headers: headers, rows: rows };
  } catch (e) {
    return { configured: true, error: '広告シートを読めません: ' + String(e) };
  }
}
