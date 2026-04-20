/**
 * 発注書・見積書フォーム - GAS v9 (見積書機能追加)
 *
 * 【発注書】
 * 通常(PASS): フォーム → 承認者メール(承認/却下リンク) → 承認後 → 発注担当者へ通知
 * 緊急:       フォーム → 承認者+発注担当者に同時メール → 即発注可能
 *
 * 【見積書】
 * フォーム → スプシに見積書シート生成 + 見積一覧に記録
 * → 印刷してお客さんに提出（社内承認不要）
 * → 合意後、見積一覧から「発注書に転記」ボタン
 */
var INDEX_SHEET = '発注一覧';
var TEMPLATE_SHEET = 'テンプレート';
var EST_INDEX_SHEET = '見積一覧';

// ★ メールアドレス設定
// テスト: 全て井上将吾に送信。本番時は各担当者のアドレスに変更
var APPROVER_PASS = { name: '井上将吾', email: 's.inoue.ipro@gmail.com' };
var APPROVER_URGENT = { name: '井上将吾', email: 's.inoue.ipro@gmail.com' };
var PURCHASER = { name: '井上将吾', email: 's.inoue.ipro@gmail.com' };

// ============ 初期化 ============
function initSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) s = ss.insertSheet(INDEX_SHEET);
  s.getRange(1,1,1,13).setValues([['受付日時','注文No.','発行日','仕入先','事業所','現場名','合計金額','注文者','緊急','承認者','ステータス','シートリンク','ID']]);
  s.getRange(1,1,1,13).setFontWeight('bold').setBackground('#4285f4').setFontColor('#fff');
  s.setFrozenRows(1);
  Logger.log('initSheet完了');
}

// ============ 発注一覧を修正（1回だけ実行） ============
function fixIndexSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) { initSheet(); return; }

  // 既存データを取得
  var data = s.getDataRange().getValues();

  // ヘッダーにステータス列があるか確認
  var header = data[0];
  var hasStatus = header.indexOf('ステータス') !== -1;

  if (!hasStatus) {
    // ステータス列がない場合: K列に挿入
    // 現在: A〜J(承認者), K(シートリンク), L以降
    // 修正: A〜J(承認者), K(ステータス), L(シートリンク), M(ID)
    s.insertColumnAfter(10); // J列の後にK列を挿入

    // K1にヘッダー設定
    s.getRange(1, 11).setValue('ステータス');

    // 既存データ行にステータスを追加
    for (var i = 1; i < data.length; i++) {
      var cell = s.getRange(i + 1, 11);
      cell.setValue('申請中');
      cell.setFontWeight('bold').setFontColor('#b06000').setBackground('#fef7e0');
    }
  }

  // ヘッダー行のスタイルを再設定
  var lastCol = s.getLastColumn();
  s.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#4285f4').setFontColor('#fff');
  s.setFrozenRows(1);

  // 列幅調整
  s.setColumnWidth(11, 100); // ステータス

  Logger.log('fixIndexSheet完了: ステータス列追加');
}

// ============ POST ============
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var result;
    if (data.formType === 'estimate') {
      result = processEstimate(data);
    } else if (data.formType === 'quickPO') {
      result = quickTransferToPO(data);
    } else if (data.formType === 'batchPO') {
      result = batchTransferToPO(data);
    } else {
      result = processOrder(data);
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (er) {
    return ContentService.createTextOutput(JSON.stringify({success:false,error:er.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============ JSON応答ヘルパー ============
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============ GET: 承認/却下 + 見積API ============
function doGet(e) {
  var action = e.parameter.action;
  var id = e.parameter.id;

  // 見積書API（JSON応答）
  if (action === 'listEstimates') return jsonResponse(getEstimateList());
  if (action === 'getEstimateData') return jsonResponse(getEstimateData(id));
  if (action === 'markTransferred') return jsonResponse(markEstimateTransferred(id));
  if (action === 'listOrders') return jsonResponse(getOrderList());
  if (action === 'cancelOrder') return jsonResponse(cancelOrder(id));
  if (action === 'markOrderCompleted') return jsonResponse(markOrderCompleted(id));
  if (action === 'hideCompleted') return jsonResponse(hideCompletedSheets());
  if (action === 'showAllSheets') return jsonResponse(showAllSheets());
  if (action === 'getPdf') return jsonResponse(getSheetPdfBase64(e.parameter.gid));

  if (!action || !id) return HtmlService.createHtmlOutput('<h2>発注書・見積書APIは稼働中です</h2>');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INDEX_SHEET);
  var data = sheet.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) { rowIdx = i + 1; break; }
  }
  if (rowIdx === -1) return HtmlService.createHtmlOutput(resultPage('エラー', '該当する発注書が見つかりません', '#d93025'));

  var currentStatus = data[rowIdx-1][10];
  var orderNo = data[rowIdx-1][1];
  var supplier = data[rowIdx-1][3];
  var orderer = data[rowIdx-1][7];
  var total = data[rowIdx-1][6];
  var sheetUrl = data[rowIdx-1][11];

  if (action === 'approve') {
    if (currentStatus !== '申請中') return HtmlService.createHtmlOutput(resultPage('処理済', 'この発注書は既に処理済みです（' + currentStatus + '）', '#5f6368'));
    applyStatusColor(sheet, rowIdx, '承認済');

    // ★ 発注書シートの承認欄に承認者名を書き込む
    var approverName = data[rowIdx-1][9]; // J列: 承認者名
    writeApproverToOrderSheet(ss, sheetUrl, approverName);

    notifyPurchaser(id, orderNo, supplier, orderer, total, sheetUrl);
    return HtmlService.createHtmlOutput(resultPage('承認しました',
      '注文No.: ' + orderNo + '<br>仕入先: ' + supplier + '<br>金額: &yen;' + Number(total).toLocaleString() +
      '<br><br>発注担当者に通知しました。', '#188038', sheetUrl));

  } else if (action === 'reject') {
    if (currentStatus !== '申請中') return HtmlService.createHtmlOutput(resultPage('処理済', 'この発注書は既に処理済みです', '#5f6368'));
    applyStatusColor(sheet, rowIdx, '却下');
    return HtmlService.createHtmlOutput(resultPage('却下しました', '注文No.: ' + orderNo, '#d93025', sheetUrl));
  }

  return HtmlService.createHtmlOutput(resultPage('エラー', '不明なアクション', '#d93025'));
}

// 結果表示HTML
function resultPage(title, body, color, ssUrl) {
  var link = ssUrl ? '<a href="'+ssUrl+'" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#1a73e8;color:white;border-radius:6px;text-decoration:none;font-weight:bold">スプレッドシートで確認</a>' : '';
  return '<div style="font-family:sans-serif;max-width:500px;margin:40px auto;text-align:center">' +
    '<div style="background:'+color+';color:white;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">'+title+'</h2></div>' +
    '<div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px"><p>'+body+'</p>'+link+'</div></div>';
}

// ============ 発注処理 ============
function processOrder(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabName = data.issueDate.replace(/-/g,'') + '_' + data.orderer;
  if (data.siteName) tabName += '_' + data.siteName;

  var approver = data.urgent ? APPROVER_URGENT : APPROVER_PASS;
  data.approverName = approver.name;
  data.approverEmail = approver.email;

  var uniqueId = Utilities.getUuid();
  var os = createFromTemplate(ss, tabName, data);
  addToIndex(ss, data, os, uniqueId);

  // ★ 見積書から転記された場合、発注シートを見積シートの隣に配置
  if (data.sourceEstimateNo) {
    try {
      var allSheets = ss.getSheets();
      for (var si = 0; si < allSheets.length; si++) {
        if (allSheets[si].getName().indexOf('見積_') === 0 && allSheets[si].getName().indexOf(data.sourceEstimateNo) !== -1) {
          ss.setActiveSheet(os);
          ss.moveActiveSheet(si + 2); // 見積シートの直後
          break;
        }
      }
    } catch(e) { /* 移動失敗は無視 */ }
  }

  if (data.urgent) {
    // ★ 緊急: 承認者＋発注担当者に同時メール → ステータスは「緊急承認済」
    var sheet = ss.getSheetByName(INDEX_SHEET);
    var lr = sheet.getLastRow();
    applyStatusColor(sheet, lr, '緊急承認済');

    sendUrgentEmail(data, os, uniqueId);
  } else {
    // 通常: 承認者にメール（承認/却下リンク付き）
    sendApprovalEmail(data, os, uniqueId);
  }

  var sheetUrl = ss.getUrl() + '#gid=' + os.getSheetId();
  return { success: true, message: '発注書を登録しました', orderNo: data.orderNo, orderId: uniqueId, spreadsheetUrl: ss.getUrl(), sheetUrl: sheetUrl };
}

// ============ テンプレートコピー ============
function createFromTemplate(ss, tabName, data) {
  var template = ss.getSheetByName(TEMPLATE_SHEET);
  if (!template) throw new Error('テンプレート「' + TEMPLATE_SHEET + '」が見つかりません');

  var sh = template.copyTo(ss);
  var name = tabName; var i = 1;
  while (ss.getSheetByName(name)) { name = tabName + '_' + i; i++; }
  sh.setName(name);
  sh.setHiddenGridlines(true);
  sh.setTabColor('#1a73e8'); // ★ 発注書タブ = 青

  var bi = getBranchInfo(data.branch);
  var d = data.issueDate.split('-');

  sh.getRange('AH1').setValue(parseInt(d[0]));
  sh.getRange('AL1').setValue(parseInt(d[1]));
  sh.getRange('AO1').setValue(parseInt(d[2]));
  sh.getRange('AH3').setValue(data.orderNo);
  sh.getRange('A9').setValue(data.supplier);  // A9:H10結合セル
  sh.getRange('AL12').setValue(data.branch);
  sh.getRange('AB13').setValue(bi.zip);
  sh.getRange('AB14').setValue(bi.addr);
  sh.getRange('AB15').setValue(bi.tel + ' ' + bi.fax);

  var lines = data.lines || [];
  for (var idx = 0; idx < 16; idx++) {
    var r = 18 + idx;
    var ln = lines[idx];
    if (ln && ln.maker) {
      sh.getRange('A'+r).setValue(idx+1);
      sh.getRange('C'+r).setValue(ln.maker);
      sh.getRange('H'+r).setValue(ln.product);
      sh.getRange('P'+r).setValue(ln.model||'');
      sh.getRange('Z'+r).setValue(ln.qty);
      sh.getRange('AB'+r).setValue(ln.price);
      sh.getRange('AG'+r).setValue(ln.qty*ln.price);
      sh.getRange('AL'+r).setValue(ln.remark||'');
    } else {
      ['A','C','H','P','Z','AB','AG','AL'].forEach(function(c){sh.getRange(c+r).setValue('');});
    }
  }
  sh.getRange('AG49').setValue(data.total);

  sh.getRange('F51').setValue(data.branch==='本社'?'○':'');
  sh.getRange('L51').setValue(data.branch==='福岡店'?'○':'');
  sh.getRange('P51').setValue(data.branch!=='本社'&&data.branch!=='福岡店'?'○':'');
  sh.getRange('F53').setValue(data.branch==='本社'?'○':'');
  sh.getRange('L53').setValue(data.branch==='福岡店'||data.branch==='飯塚ガスセンター'?'○':'');

  var today = new Date();
  sh.getRange('S53').setValue(today.getMonth()+1);
  sh.getRange('V53').setValue(today.getDate());
  sh.getRange('D55').setValue(data.siteName||'');
  sh.getRange('C58').setValue(data.notes||'');
  sh.getRange('X62').setValue(today.getMonth()+1);
  sh.getRange('AA62').setValue(today.getDate());
  sh.getRange('AJ60').setValue(data.orderer);
  sh.getRange('AF66').setValue(data.urgent?'緊急':'PASS');

  return sh;
}

function getBranchInfo(b) {
  var m = {
    '本社':{zip:'〒820-0081',addr:'福岡県飯塚市枝国507番地',tel:'TEL：(0948)22-1234',fax:'FAX：(0948)22-5777'},
    '福岡店':{zip:'〒814-0174',addr:'福岡県福岡市早良区田隈1-29-21',tel:'TEL：(092)861-2071',fax:'FAX：(092)861-4175'},
    '飯塚ガスセンター':{zip:'〒820-0073',addr:'福岡県飯塚市平恒477-7',tel:'TEL：(0948)22-3611',fax:'FAX：(0948)22-9302'}
  };
  return m[b]||m['福岡店'];
}

// ============ 一覧シート ============
function addToIndex(ss, data, os, uniqueId) {
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) { initSheet(); s = ss.getSheetByName(INDEX_SHEET); }
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  var url = ss.getUrl() + '#gid=' + os.getSheetId();
  s.appendRow([now, data.orderNo, data.issueDate, data.supplier, data.branch, data.siteName||'', data.total, data.orderer, data.urgent?'緊急':'PASS', data.approverName, '申請中', url, uniqueId]);
  var lr = s.getLastRow();
  s.getRange(lr, 7).setNumberFormat('#,##0');
  applyStatusColor(s, lr, '申請中');
  if (data.urgent) s.getRange(lr, 9).setFontColor('#d93025').setFontWeight('bold');
}

// ============ ステータス色分け ============
function applyStatusColor(sheet, row, status) {
  var cell = sheet.getRange(row, 11);
  cell.setValue(status).setFontWeight('bold');
  switch (status) {
    case '申請中':
      cell.setFontColor('#b06000').setBackground('#fef7e0'); break;
    case '承認済':
      cell.setFontColor('#137333').setBackground('#e6f4ea'); break;
    case '緊急承認済':
      cell.setFontColor('#ffffff').setBackground('#d93025'); break;
    case '発注済':
      cell.setFontColor('#1a73e8').setBackground('#e8f0fe'); break;
    case '経理確認済':
      cell.setFontColor('#5f6368').setBackground('#f1f3f4'); break;
    case '却下':
      cell.setFontColor('#c5221f').setBackground('#fce8e6'); break;
    case '取消':
      cell.setFontColor('#5f6368').setBackground('#f1f3f4').setFontStyle('italic'); break;
  }
}

// ============ 明細HTMLテーブル（メール共通部品） ============
function buildDetailRows(lines) {
  var dr = '';
  (lines||[]).forEach(function(l,i){
    dr += '<tr><td style="border:1px solid #ddd;padding:6px;text-align:center">'+(i+1)+'</td><td style="border:1px solid #ddd;padding:6px">'+l.maker+'</td><td style="border:1px solid #ddd;padding:6px">'+l.product+'</td><td style="border:1px solid #ddd;padding:6px;text-align:right">'+l.qty+'</td><td style="border:1px solid #ddd;padding:6px;text-align:right">&yen;'+Number(l.price).toLocaleString()+'</td><td style="border:1px solid #ddd;padding:6px;text-align:right">&yen;'+Number(l.amount).toLocaleString()+'</td></tr>';
  });
  return dr;
}

function buildSummaryTable(data) {
  return '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' +
    '<tr><td style="padding:8px;font-weight:bold;width:100px;background:#f8f9fa">発行日</td><td style="padding:8px">'+data.issueDate+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">注文No.</td><td style="padding:8px">'+data.orderNo+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">仕入先</td><td style="padding:8px">'+data.supplier+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">事業所</td><td style="padding:8px">'+data.branch+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">注文者</td><td style="padding:8px">'+data.orderer+'</td></tr></table>';
}

function buildDetailTable(lines) {
  return '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px"><thead><tr style="background:#d9e2f3"><th style="border:1px solid #ddd;padding:6px">No</th><th style="border:1px solid #ddd;padding:6px">メーカー</th><th style="border:1px solid #ddd;padding:6px">商品名</th><th style="border:1px solid #ddd;padding:6px">数量</th><th style="border:1px solid #ddd;padding:6px">単価</th><th style="border:1px solid #ddd;padding:6px">金額</th></tr></thead><tbody>'+buildDetailRows(lines)+'</tbody></table>';
}

// ============ 通常メール: 承認者へ（承認/却下リンク付き） ============
function sendApprovalEmail(data, os, uniqueId) {
  var approver = data.urgent ? APPROVER_URGENT : APPROVER_PASS;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetUrl = ss.getUrl() + '#gid=' + os.getSheetId();
  var gasUrl = ScriptApp.getService().getUrl();
  var approveUrl = gasUrl + '?action=approve&id=' + uniqueId;
  var rejectUrl = gasUrl + '?action=reject&id=' + uniqueId;

  var subj = '発注承認依頼: ' + data.supplier + ' / 注文No.' + data.orderNo;

  var hb = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1a73e8;color:white;padding:16px;border-radius:8px 8px 0 0"><h2 style="margin:0;font-size:18px">発注承認依頼</h2></div>' +
    '<div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">' +
    buildSummaryTable(data) +
    buildDetailTable(data.lines) +
    '<div style="text-align:right;font-size:20px;font-weight:bold;color:#1a73e8;margin:16px 0">合計: &yen;'+Number(data.total).toLocaleString()+'</div>' +
    '<div style="display:flex;gap:12px;margin:24px 0">' +
    '<a href="'+approveUrl+'" style="flex:1;display:block;text-align:center;padding:14px;background:#188038;color:white;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold">承認する</a>' +
    '<a href="'+rejectUrl+'" style="flex:1;display:block;text-align:center;padding:14px;background:#d93025;color:white;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold">却下する</a>' +
    '</div>' +
    '<div style="text-align:center;margin-top:12px"><a href="'+sheetUrl+'" style="color:#1a73e8;font-weight:bold">スプレッドシートで詳細確認</a></div>' +
    '</div></div>';

  MailApp.sendEmail({ to: approver.email, subject: subj, body: '承認: '+approveUrl+'\n却下: '+rejectUrl, htmlBody: hb });
}

// ============ ★ 緊急メール: 承認者+発注担当者に同時送信 ============
function sendUrgentEmail(data, os, uniqueId) {
  var approver = APPROVER_URGENT;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetUrl = ss.getUrl() + '#gid=' + os.getSheetId();

  var subj = '【緊急】発注書: ' + data.supplier + ' / 注文No.' + data.orderNo + '（即発注）';

  var hb = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#d93025;color:white;padding:16px;border-radius:8px 8px 0 0"><h2 style="margin:0;font-size:18px">【緊急】発注書 → 即発注</h2></div>' +
    '<div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">' +

    '<div style="background:#fce8e6;border:2px solid #d93025;border-radius:8px;padding:12px;margin-bottom:16px;text-align:center">' +
    '<p style="margin:0;font-size:15px;font-weight:bold;color:#d93025">緊急のため承認をスキップし、即発注扱いです</p></div>' +

    buildSummaryTable(data) +
    buildDetailTable(data.lines) +
    '<div style="text-align:right;font-size:20px;font-weight:bold;color:#d93025;margin:16px 0">合計: &yen;'+Number(data.total).toLocaleString()+'</div>' +

    '<a href="'+sheetUrl+'" style="display:block;text-align:center;padding:14px;background:#1a73e8;color:white;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin:16px 0">スプレッドシートで確認</a>' +
    '</div></div>';

  var plainBody = '【緊急】発注書\n注文No.: ' + data.orderNo + '\n仕入先: ' + data.supplier +
    '\n合計: ' + Number(data.total).toLocaleString() + '円\n\n緊急のため即発注扱い\nスプレッドシート: ' + ss.getUrl();

  // 承認者と発注担当者の宛先を統合（重複排除）
  var toList = [approver.email];
  if (PURCHASER.email !== approver.email) {
    toList.push(PURCHASER.email);
  }

  MailApp.sendEmail({ to: toList.join(','), subject: subj, body: plainBody, htmlBody: hb });
}

// ============ 発注担当者に通知（通常承認後） ============
function notifyPurchaser(id, orderNo, supplier, orderer, total, sheetUrl) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var hb = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#188038;color:white;padding:16px;border-radius:8px 8px 0 0"><h2 style="margin:0">承認済 → 発注してください</h2></div>' +
    '<div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">' +
    '<p>以下の発注書が承認されました。発注手続きをお願いします。</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:16px 0">' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">注文No.</td><td style="padding:8px">'+orderNo+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">仕入先</td><td style="padding:8px">'+supplier+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">注文者</td><td style="padding:8px">'+orderer+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">合計</td><td style="padding:8px">&yen;'+Number(total).toLocaleString()+'</td></tr></table>' +
    '<a href="'+sheetUrl+'" style="display:block;text-align:center;padding:14px;background:#1a73e8;color:white;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin:16px 0">発注書シートを開く</a>' +
    '</div></div>';

  MailApp.sendEmail({
    to: PURCHASER.email,
    subject: '【発注依頼】' + supplier + ' / ' + orderNo,
    body: '承認済: ' + supplier + ' / ' + orderNo + '\n発注書: ' + sheetUrl,
    htmlBody: hb
  });
}

// ============ 承認者名を発注書シートに書き込む ============
function writeApproverToOrderSheet(ss, sheetUrl, approverName) {
  try {
    var match = sheetUrl.match(/gid=(\d+)/);
    if (!match) return;
    var gid = parseInt(match[1]);
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === gid) {
        var orderSheet = sheets[i];
        orderSheet.getRange('AF60').setValue(approverName);
        var now = new Date();
        orderSheet.getRange('AE62').setValue((now.getMonth()+1) + '/' + now.getDate());
        break;
      }
    }
  } catch (e) {
    Logger.log('承認者名書き込みエラー: ' + e.toString());
  }
}


// ================================================================
// ============ 見積書機能 ============
// ================================================================

// ============ 見積一覧初期化 ============
function initEstimateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) s = ss.insertSheet(EST_INDEX_SHEET);
  var headers = ['受付日時','見積No.','見積日','お客様名','件名','担当者','合計(税込)','合計(税抜)','原価合計','粗利率','ステータス','シートリンク','ID','発注申請'];
  s.getRange(1,1,1,headers.length).setValues([headers]);
  s.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
  s.setFrozenRows(1);
  s.setColumnWidth(1, 140);
  s.setColumnWidth(2, 120);
  s.setColumnWidth(4, 120);
  s.setColumnWidth(7, 100);
  s.setColumnWidth(11, 80);
  s.setColumnWidth(14, 100); // 発注申請
  Logger.log('initEstimateSheet完了');
}

// ============ 見積一覧に発注申請リンク列を追加（既存データ補修） ============
function fixEstimateLinks() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) return;
  // ヘッダーにN列がなければ追加
  if (s.getRange(1, 14).getValue() !== '発注申請') {
    s.getRange(1, 14).setValue('発注申請').setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
    s.setColumnWidth(14, 100);
  }
  // 既存行にリンクを追加
  var data = s.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var uid = data[i][12]; // M列: ID
    var status = data[i][10]; // K列: ステータス
    if (uid && status === '作成済' && !data[i][13]) {
      var formUrl = 'https://sinoueipro-bot.github.io/purchase-order-form/?quickPO=' + uid;
      s.getRange(i + 1, 14).setFormula('=HYPERLINK("' + formUrl + '","📦発注申請")').setFontColor('#1a73e8').setFontWeight('bold');
    }
  }
  Logger.log('fixEstimateLinks完了: ' + (data.length - 1) + '行処理');
}

// ============ シート整理（1回実行後に削除してOK） ============
// ============ 完了シートを非表示化（削除せずタブバーをスッキリさせる） ============
// 発注一覧K列: 発注済/取消/却下 → 対応する発注書シートを非表示
// 見積一覧K列: 発注済 → 対応する見積書シートを非表示
function hideCompletedSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hiddenCount = 0;
  var skippedCount = 0;

  // 発注一覧から非表示対象を抽出
  var orderSheet = ss.getSheetByName(INDEX_SHEET);
  if (orderSheet) {
    var data = orderSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var status = data[i][10]; // K列: ステータス
      if (status === '発注済' || status === '取消' || status === '却下') {
        var sheetUrl = data[i][11]; // L列: シートリンク
        var sheet = findSheetByUrl(ss, sheetUrl);
        if (sheet && !sheet.isSheetHidden()) {
          try { sheet.hideSheet(); hiddenCount++; } catch(e) { skippedCount++; }
        }
      }
    }
  }

  // 見積一覧から非表示対象を抽出
  var estSheet = ss.getSheetByName(EST_INDEX_SHEET);
  if (estSheet) {
    var eData = estSheet.getDataRange().getValues();
    for (var j = 1; j < eData.length; j++) {
      var eStatus = eData[j][10]; // K列: ステータス
      if (eStatus === '発注済') {
        var eUrl = eData[j][11];
        var eSh = findSheetByUrl(ss, eUrl);
        if (eSh && !eSh.isSheetHidden()) {
          try { eSh.hideSheet(); hiddenCount++; } catch(e) { skippedCount++; }
        }
      }
    }
  }

  Logger.log('非表示化完了: ' + hiddenCount + '枚 (失敗: ' + skippedCount + '枚)');
  return { success: true, hidden: hiddenCount, skipped: skippedCount };
}

// ============ 全シートを再表示 ============
function showAllSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var shownCount = 0;
  sheets.forEach(function(s) {
    if (s.isSheetHidden()) {
      try { s.showSheet(); shownCount++; } catch(e) {}
    }
  });
  Logger.log('再表示完了: ' + shownCount + '枚');
  return { success: true, shown: shownCount };
}

// ============ ヘルパー: URLからシートを特定 ============
function findSheetByUrl(ss, sheetUrl) {
  if (!sheetUrl) return null;
  var match = String(sheetUrl).match(/gid=(\d+)/);
  if (!match) return null;
  var gid = parseInt(match[1]);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  return null;
}

// ============ シート整理（削除せず並び替え+色分け） ============
function organizeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var systemNames = ['発注一覧', '見積一覧', 'テンプレート'];
  var systemSheets = [], estSheets = [], orderSheets = [];
  sheets.forEach(function(s) {
    var name = s.getName();
    if (systemNames.indexOf(name) !== -1) systemSheets.push(s);
    else if (name.indexOf('見積_') === 0) estSheets.push(s);
    else orderSheets.push(s);
  });
  // システムシートは固定順（発注一覧→見積一覧→テンプレート）
  systemSheets.sort(function(a, b) {
    return systemNames.indexOf(a.getName()) - systemNames.indexOf(b.getName());
  });
  // データシートは名前(日付)で新しい順
  estSheets.sort(function(a, b) { return b.getName().localeCompare(a.getName()); });
  orderSheets.sort(function(a, b) { return b.getName().localeCompare(a.getName()); });
  // 並び替え: システム→見積→発注
  var ordered = systemSheets.concat(estSheets).concat(orderSheets);
  ordered.forEach(function(s, i) {
    ss.setActiveSheet(s);
    ss.moveActiveSheet(i + 1);
  });
  // 色分け
  var tpl = ss.getSheetByName('テンプレート'); if (tpl) tpl.setTabColor('#5f6368');
  var oIdx = ss.getSheetByName('発注一覧'); if (oIdx) oIdx.setTabColor('#1a73e8');
  var eIdx = ss.getSheetByName('見積一覧'); if (eIdx) eIdx.setTabColor('#0f9d58');
  estSheets.forEach(function(s) { try { s.setTabColor('#c8f0d4'); } catch(e){} });   // 薄緑
  orderSheets.forEach(function(s) { try { s.setTabColor('#cce0f8'); } catch(e){} }); // 薄青
  // 最初のシート（発注一覧）をアクティブに
  if (oIdx) ss.setActiveSheet(oIdx);
  Logger.log('整理完了: システム' + systemSheets.length + ' + 見積' + estSheets.length + ' + 発注' + orderSheets.length + ' = ' + ordered.length + 'シート');
  return { systemCount: systemSheets.length, estCount: estSheets.length, orderCount: orderSheets.length };
}

function cleanupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var keep = ['テンプレート', '発注一覧', '見積一覧'];
  var sheets = ss.getSheets();
  var deleted = [];
  for (var i = sheets.length - 1; i >= 0; i--) {
    var name = sheets[i].getName();
    if (keep.indexOf(name) === -1) {
      ss.deleteSheet(sheets[i]);
      deleted.push(name);
    }
  }
  // タブ並び順: 発注一覧→見積一覧→テンプレート
  var order = ['発注一覧', '見積一覧', 'テンプレート'];
  for (var j = 0; j < order.length; j++) {
    var s = ss.getSheetByName(order[j]);
    if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(j + 1); }
  }
  // タブ色設定
  var orderSheet = ss.getSheetByName('発注一覧');
  if (orderSheet) orderSheet.setTabColor('#1a73e8');
  var estSheet = ss.getSheetByName('見積一覧');
  if (estSheet) estSheet.setTabColor('#0f9d58');
  var tplSheet = ss.getSheetByName('テンプレート');
  if (tplSheet) tplSheet.setTabColor('#5f6368');

  Logger.log('削除: ' + deleted.join(', '));
  Logger.log('残り: ' + order.join(', '));
}

// ============ 売値計算（Excelの丸めロジック再現） ============
// Excel: =IF(LEFT(J,1)="8",ROUNDDOWN(K/(1-L),LEN(J)*-1)+J,ROUNDUP(K/(1-L),-LEN(J)))
// K=原価, L=粗利率(小数), J=丸めパターン
function calcSellingPrice(cost, marginRate, roundingStr) {
  if (!cost || !marginRate) return 0;
  var raw = cost / (1 - marginRate);
  var rStr = String(roundingStr || '0');
  var digits = rStr.length;
  var factor = Math.pow(10, digits);

  if (rStr.charAt(0) === '8') {
    // ROUNDDOWN + 丸め値を加算 (例: 14286 → 14280 + 8 = 14288)
    return Math.floor(raw / factor) * factor + parseInt(rStr);
  } else {
    // ROUNDUP (例: 14286 → 14290)
    return Math.ceil(raw / factor) * factor;
  }
}

// ============ 見積書処理 ============
function processEstimate(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabName = '見積_' + data.estimateDate.replace(/-/g, '');
  if (data.customerName) tabName += '_' + data.customerName.substring(0, 10);
  var uniqueId = Utilities.getUuid();

  // 明細の売値・金額を計算
  var lines = data.lines || [];
  var subtotal = 0;   // 税抜合計(売値)
  var costTotal = 0;   // 原価合計
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var marginDec = (ln.marginRate || 0) / 100; // %→小数
    var selling = calcSellingPrice(ln.cost || 0, marginDec, ln.rounding || '0');
    ln.sellingPrice = selling;
    ln.amount = selling * (ln.qty || 0);
    var lineCost = (ln.zeroCost === true) ? 0 : ((ln.cost || 0) * (ln.qty || 0));
    if ((ln.cost || 0) < 0) lineCost = 0;
    ln.costAmount = lineCost;
    ln.actualMargin = ln.amount > 0 ? Math.round((1 - lineCost / ln.amount) * 1000) / 1000 : 0;
    ln.profit = ln.amount - lineCost;
    subtotal += ln.amount;
    costTotal += lineCost;
  }
  var tax = Math.floor(subtotal * 0.1);  // 消費税10%（切り捨て）
  var grandTotal = subtotal + tax;
  var overallMargin = subtotal > 0 ? Math.round((subtotal - costTotal) / subtotal * 1000) / 1000 : 0;

  data.subtotal = subtotal;
  data.tax = tax;
  data.grandTotal = grandTotal;
  data.costTotal = costTotal;
  data.overallMargin = overallMargin;

  var sheet = createEstimateSheet(ss, tabName, data);
  addToEstimateIndex(ss, data, sheet, uniqueId);

  var sheetUrl = ss.getUrl() + '#gid=' + sheet.getSheetId();
  return {
    success: true,
    message: '見積書を作成しました',
    estimateNo: data.estimateNo,
    spreadsheetUrl: ss.getUrl(),
    sheetUrl: sheetUrl
  };
}

// ============ 見積書シート作成（Excelレイアウト再現・改良版） ============
function createEstimateSheet(ss, tabName, data) {
  var sh = ss.insertSheet();
  var name = tabName; var i = 1;
  while (ss.getSheetByName(name)) { name = tabName + '_' + i; i++; }
  sh.setName(name);
  sh.setHiddenGridlines(true);
  sh.setTabColor('#0f9d58'); // ★ 見積書タブ = 緑

  // 列幅設定 (A-P)
  var widths = [35,80,120,100,40,35,75,85,70,45,70,50,40,70,55,70];
  for (var w = 0; w < widths.length; w++) sh.setColumnWidth(w + 1, widths[w]);

  var d = data.estimateDate.split('-');
  var bi = getBranchInfo(data.branch || '本社');
  var BS = SpreadsheetApp.BorderStyle;

  // ==== ヘッダー部 (行1-13) ====
  sh.setRowHeight(1, 28); sh.setRowHeight(2, 20); sh.setRowHeight(3, 8); sh.setRowHeight(4, 30);

  // 行1-2: 御見積書 + 発行日/見積No.
  sh.getRange('A1:E2').merge().setValue('御見積書').setFontSize(20).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('G1').setValue('発行日').setFontSize(9).setFontColor('#666');
  sh.getRange('H1:I1').merge().setValue(parseInt(d[0]) + '年' + parseInt(d[1]) + '月' + parseInt(d[2]) + '日').setHorizontalAlignment('right');
  sh.getRange('G2').setValue('見積No.').setFontSize(9).setFontColor('#666');
  sh.getRange('H2:I2').merge().setValue(data.estimateNo || '').setHorizontalAlignment('right').setFontWeight('bold');

  // 行4: お客様名（下線付き）
  sh.getRange('A4:D4').merge().setValue(data.customerName || '').setFontSize(14).setFontWeight('bold');
  sh.getRange('E4').setValue('様').setFontSize(14);
  sh.getRange('A4:E4').setBorder(null, null, true, null, null, null, '#333', BS.SOLID_MEDIUM);

  // 行5: 事業所・会社情報
  sh.getRange('F5').setValue('株式会社アイプロ').setFontWeight('bold');
  sh.getRange('I5').setValue(data.branch || '本社');

  // 行6-7: 挨拶文 + 事業所住所
  sh.getRange('A6:E6').merge().setValue('下記の通り御見積申し上げます。\n何卒ご用命くださいます様お願い申し上げます。').setWrap(true).setFontSize(10).setVerticalAlignment('top');
  sh.getRange('F6:I7').merge().setValue(bi.zip + '\n' + bi.addr + '\n' + bi.tel + ' ' + bi.fax).setWrap(true).setFontSize(9);

  // 行7-8: 見積金額（枠付き）
  sh.getRange('A7:B7').merge().setValue('御見積金額').setFontWeight('bold').setFontSize(11);
  sh.getRange('C7:D8').merge().setValue(data.grandTotal || 0).setNumberFormat('#,##0"円"').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('right').setVerticalAlignment('middle').setBackground('#f0f7ff');
  sh.getRange('C7:D8').setBorder(true, true, true, true, null, null, '#1a73e8', BS.SOLID_MEDIUM);
  sh.getRange('A8:B8').merge().setValue('（消費税込）').setFontSize(9).setFontColor('#666');
  sh.getRange('F8:I8').merge().setValue('登録番号：T2290001045807').setFontSize(9).setFontColor('#666');

  // 行9-12: 件名等（罫線付きテーブル）
  var infoLabels = [['件名：','A9:B9',data.subject||'','C9:D9'],['納期：','A10:B10',data.delivery||'','C10:D10'],['受渡場所：','A11:B11',data.deliveryPlace||'','C11:D11'],['支払条件：','A12:B12',data.paymentTerms||'','C12:D12']];
  for (var il = 0; il < infoLabels.length; il++) {
    sh.getRange(infoLabels[il][1]).merge().setValue(infoLabels[il][0]).setFontWeight('bold').setFontSize(10).setBackground('#f8f9fa');
    sh.getRange(infoLabels[il][3]).merge().setValue(infoLabels[il][2]).setFontSize(10);
  }
  sh.getRange('A9:D12').setBorder(true, true, true, true, true, true, '#bbb', BS.SOLID);
  sh.getRange('I9').setValue('担当').setFontWeight('bold').setFontSize(9).setFontColor('#666');
  sh.getRange('I10:I11').merge().setValue(data.staff || '').setFontWeight('bold');
  sh.getRange('E12:I13').merge().setValue(data.paymentDetail || '');
  sh.getRange('J13').setValue('粗利益設定入力(黄色部分)※税別').setFontSize(8).setFontColor('#b06000');

  // ==== 明細ヘッダー (行14) ====
  sh.setRowHeight(14, 28);
  var hdrA = ['No.', 'メーカー', '品名', '型式・仕様', '数量', '単位', '単価', '金額'];
  var hdrB = ['定価(税別)', '丸め', '原価(単価)', '設定粗利率', '原価0対象', '原価(金額)', '実粗利率', '粗利益高'];
  sh.getRange(14, 1, 1, 8).setValues([hdrA]).setFontWeight('bold').setFontSize(9).setBackground('#d9e2f3').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(14, 9, 1, 8).setValues([hdrB]).setFontWeight('bold').setFontSize(8).setBackground('#fff2cc').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(14, 1, 1, 16).setBorder(true, true, true, true, true, true, '#666', BS.SOLID);

  // ==== 明細行 (行15-32) ====
  var lines = data.lines || [];
  var lastDataRow = 14; // 最後にデータがある行
  for (var idx = 0; idx < 18; idx++) {
    var r = 15 + idx;
    sh.setRowHeight(r, 22);
    var ln = lines[idx];
    if (ln && ln.cost) {
      lastDataRow = r;
      sh.getRange(r, 1).setValue(idx + 1).setHorizontalAlignment('center');
      sh.getRange(r, 2).setValue(ln.maker || '');
      sh.getRange(r, 3).setValue(ln.product || '');
      sh.getRange(r, 4).setValue(ln.model || '');
      sh.getRange(r, 5).setValue(ln.qty || 0).setHorizontalAlignment('center');
      sh.getRange(r, 6).setValue(ln.unit || '台').setHorizontalAlignment('center');
      sh.getRange(r, 7).setValue(ln.sellingPrice || 0).setNumberFormat('#,##0').setHorizontalAlignment('right');
      sh.getRange(r, 8).setValue(ln.amount || 0).setNumberFormat('#,##0').setHorizontalAlignment('right').setFontWeight('bold');
      sh.getRange(r, 9).setValue(ln.listPrice || '').setNumberFormat('#,##0');
      sh.getRange(r, 10).setNumberFormat('@').setValue(String(ln.rounding || '0'));
      sh.getRange(r, 11).setValue(ln.cost || 0).setNumberFormat('#,##0');
      sh.getRange(r, 12).setValue((ln.marginRate || 0) / 100).setNumberFormat('0.0%');
      sh.getRange(r, 13).setValue(ln.zeroCost ? '○' : '').setHorizontalAlignment('center');
      sh.getRange(r, 14).setValue(ln.costAmount || 0).setNumberFormat('#,##0');
      sh.getRange(r, 15).setValue(ln.actualMargin || 0).setNumberFormat('0.0%');
      sh.getRange(r, 16).setValue(ln.profit || 0).setNumberFormat('#,##0');
      sh.getRange(r, 9, 1, 8).setBackground('#fffde7');
      // 偶数行にストライプ
      if (idx % 2 === 1) sh.getRange(r, 1, 1, 8).setBackground('#f8fafd');
    }
    // 顧客用列の罫線
    sh.getRange(r, 1, 1, 8).setBorder(null, true, true, true, true, null, '#bbb', BS.SOLID);
    sh.getRange(r, 9, 1, 8).setBorder(null, null, true, null, true, null, '#ddd', BS.DOTTED);
  }
  // 明細全体の外枠（太線）
  sh.getRange(14, 1, lastDataRow - 13, 8).setBorder(true, true, true, true, null, null, '#333', BS.SOLID_MEDIUM);

  // ==== 集計部 (行33-35) ====
  sh.getRange('A33:B33').merge().setValue('税率区分').setFontWeight('bold').setBackground('#e8eaed').setFontSize(9);
  sh.getRange('C33').setValue('金額(税抜)').setFontSize(9).setBackground('#e8eaed');
  sh.getRange('D33').setValue('消費税').setFontSize(9).setBackground('#e8eaed');
  sh.getRange('G33').setValue('小計').setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange('H33').setValue(data.subtotal || 0).setNumberFormat('#,##0').setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange('N33').setValue(data.costTotal || 0).setNumberFormat('#,##0');
  sh.getRange('O33').setValue(data.overallMargin || 0).setNumberFormat('0.0%');
  sh.getRange('P33').setValue((data.subtotal || 0) - (data.costTotal || 0)).setNumberFormat('#,##0');

  sh.getRange('A34:B34').merge().setValue('10％対象').setBackground('#e8eaed').setFontSize(9);
  sh.getRange('C34').setValue(data.subtotal || 0).setNumberFormat('#,##0');
  sh.getRange('D34').setValue(data.tax || 0).setNumberFormat('#,##0');
  sh.getRange('G34').setValue('消費税').setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange('H34').setValue(data.tax || 0).setNumberFormat('#,##0').setFontWeight('bold').setHorizontalAlignment('right');

  sh.getRange('A35:B35').merge().setValue('8％対象').setBackground('#e8eaed').setFontSize(9);
  sh.setRowHeight(35, 30);
  sh.getRange('G35').setValue('合計').setFontWeight('bold').setFontSize(12).setHorizontalAlignment('right');
  sh.getRange('H35').setValue(data.grandTotal || 0).setNumberFormat('#,##0').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('right').setBackground('#e8f0fe');
  sh.getRange('A33:D35').setBorder(true, true, true, true, true, true, '#999', BS.SOLID);
  sh.getRange('G33:H35').setBorder(true, true, true, true, true, true, '#333', BS.SOLID_MEDIUM);

  // ==== 特記事項 (行36-38) ====
  sh.getRange('A36:A38').merge().setValue('特記事項').setFontWeight('bold').setVerticalAlignment('top').setBackground('#f8f9fa');
  sh.getRange('B36:I36').merge().setValue(data.notes || '');
  sh.getRange('B37:I37').merge();
  sh.getRange('B38:I38').merge();
  sh.getRange('A36:I38').setBorder(true, true, true, true, null, null, '#999', BS.SOLID);

  // 社内列は非表示
  try { sh.hideColumns(9, 8); } catch(e) {}

  return sh;
}

// ============ ワンクリック発注申請（見積→発注を直接処理） ============
function quickTransferToPO(data) {
  // data: { estimateId, approverEmail, urgent, orderer }
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 見積データを取得
  var estResult = getEstimateData(data.estimateId);
  if (!estResult.success) return estResult;

  // 2. 発注書データを構築
  var today = new Date();
  var dateStr = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM-dd');
  var orderNo = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyyMMdd') + '001';

  // 仕入先: 見積書の明細から推定（最初のメーカー名 or 手動で後から修正）
  var supplier = estResult.lines.length > 0 ? estResult.lines[0].maker : '';

  var poLines = [];
  for (var li = 0; li < estResult.lines.length; li++) {
    var el = estResult.lines[li];
    poLines.push({
      maker: el.maker,
      product: el.product,
      model: el.model || '',
      qty: el.qty,
      price: el.price, // 原価
      amount: el.qty * el.price,
      remark: '見積No.' + estResult.estimateNo,
      type: 'U'
    });
  }
  var total = 0;
  for (var t = 0; t < poLines.length; t++) total += poLines[t].amount;

  var approver = data.urgent ? APPROVER_URGENT : APPROVER_PASS;

  var poData = {
    issueDate: dateStr,
    orderNo: orderNo,
    supplier: supplier,
    branch: data.branch || '本社',
    lines: poLines,
    total: total,
    siteName: estResult.subject || '',
    notes: '見積No.' + estResult.estimateNo + 'からの発注',
    orderer: data.orderer || '',
    urgent: data.urgent || false,
    approverName: approver.name,
    approverEmail: approver.email
  };

  // 3. 既存の発注処理を実行
  var result = processOrder(poData);

  // 4. 見積書のステータスを「発注済」に更新
  if (result.success) {
    markEstimateTransferred(data.estimateId);
  }

  return result;
}

// ============ 見積一覧に追加 ============
function addToEstimateIndex(ss, data, sheet, uniqueId) {
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) { initEstimateSheet(); s = ss.getSheetByName(EST_INDEX_SHEET); }
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  var url = ss.getUrl() + '#gid=' + sheet.getSheetId();
  // 発注申請リンク（スプシからワンクリックでWebフォームに転記）
  var formUrl = 'https://sinoueipro-bot.github.io/purchase-order-form/?quickPO=' + uniqueId;

  s.appendRow([
    now,                          // A: 受付日時
    data.estimateNo || '',        // B: 見積No.
    data.estimateDate || '',      // C: 見積日
    data.customerName || '',      // D: お客様名
    data.subject || '',           // E: 件名
    data.staff || '',             // F: 担当者
    data.grandTotal || 0,         // G: 合計(税込)
    data.subtotal || 0,           // H: 合計(税抜)
    data.costTotal || 0,          // I: 原価合計
    data.overallMargin || 0,      // J: 粗利率
    '作成済',                      // K: ステータス
    url,                          // L: シートリンク
    uniqueId,                     // M: ID
    ''                            // N: 発注申請リンク（HYPERLINK数式で上書き）
  ]);
  var lr = s.getLastRow();
  s.getRange(lr, 7).setNumberFormat('#,##0');
  s.getRange(lr, 8).setNumberFormat('#,##0');
  s.getRange(lr, 9).setNumberFormat('#,##0');
  s.getRange(lr, 10).setNumberFormat('0.0%');
  // N列: 発注申請リンク
  s.getRange(lr, 14).setFormula('=HYPERLINK("' + formUrl + '","📦発注申請")').setFontColor('#1a73e8').setFontWeight('bold');
  // ステータス色
  applyEstimateStatus(s, lr, '作成済');
}

// ============ 見積ステータス色分け ============
function applyEstimateStatus(sheet, row, status) {
  var cell = sheet.getRange(row, 11);
  cell.setValue(status).setFontWeight('bold');
  switch (status) {
    case '作成済':
      cell.setFontColor('#0f9d58').setBackground('#e6f4ea'); break;
    case '発注済':
      cell.setFontColor('#1a73e8').setBackground('#e8f0fe'); break;
    case '失注':
      cell.setFontColor('#5f6368').setBackground('#f1f3f4'); break;
  }
}

// ============ API: 見積一覧取得 ============
function getEstimateList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) return { success: true, estimates: [] };

  var data = s.getDataRange().getValues();
  var estimates = [];
  for (var i = 1; i < data.length; i++) {
    estimates.push({
      timestamp: data[i][0],
      estimateNo: data[i][1],
      estimateDate: data[i][2],
      customerName: data[i][3],
      subject: data[i][4],
      staff: data[i][5],
      grandTotal: data[i][6],
      subtotal: data[i][7],
      costTotal: data[i][8],
      margin: data[i][9],
      status: data[i][10],
      sheetUrl: data[i][11],
      id: data[i][12]
    });
  }
  return { success: true, estimates: estimates };
}

// ============ API: 見積データ取得（転記用） ============
function getEstimateData(id) {
  if (!id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) return { success: false, error: '見積一覧がありません' };

  var data = s.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return { success: false, error: '見積書が見つかりません' };

  // 見積書シートから明細を読み取る
  var sheetUrl = data[rowIdx][11];
  var match = sheetUrl.match(/gid=(\d+)/);
  if (!match) return { success: false, error: 'シートURLが不正です' };
  var gid = parseInt(match[1]);
  var estSheet = null;
  var sheets = ss.getSheets();
  for (var j = 0; j < sheets.length; j++) {
    if (sheets[j].getSheetId() === gid) { estSheet = sheets[j]; break; }
  }
  if (!estSheet) return { success: false, error: '見積書シートが見つかりません' };

  // 明細行を読み取り（行15-32, K列=原価, E列=数量 etc）
  var lines = [];
  for (var r = 15; r <= 32; r++) {
    var maker = estSheet.getRange(r, 2).getValue();
    if (!maker) continue;
    lines.push({
      maker: maker,
      product: estSheet.getRange(r, 3).getValue(),
      model: estSheet.getRange(r, 4).getValue(),
      qty: estSheet.getRange(r, 5).getValue(),
      price: estSheet.getRange(r, 11).getValue(),  // K列=原価 → 発注書の単価
      remark: ''
    });
  }

  return {
    success: true,
    estimateNo: data[rowIdx][1],
    customerName: data[rowIdx][3],
    subject: data[rowIdx][4],
    lines: lines
  };
}

// ============ API: 見積書を発注済みに ============
function markEstimateTransferred(id) {
  if (!id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) return { success: false, error: '見積一覧がありません' };

  var data = s.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) {
      applyEstimateStatus(s, i + 1, '発注済');
      return { success: true, message: '発注済に更新しました' };
    }
  }
  return { success: false, error: '見積書が見つかりません' };
}

// ============ API: 発注一覧取得 ============
function getOrderList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: true, orders: [] };
  var data = s.getDataRange().getValues();
  var orders = [];
  for (var i = 1; i < data.length; i++) {
    orders.push({
      timestamp: data[i][0],
      orderNo: data[i][1],
      issueDate: data[i][2],
      supplier: data[i][3],
      branch: data[i][4],
      siteName: data[i][5],
      total: data[i][6],
      orderer: data[i][7],
      urgent: data[i][8],
      approverName: data[i][9],
      status: data[i][10],
      sheetUrl: data[i][11],
      id: data[i][12]
    });
  }
  return { success: true, orders: orders };
}

// ============ API: 発注書を「発注済」にマーク+非表示化 ============
function markOrderCompleted(id) {
  if (!id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: false, error: '発注一覧がありません' };

  var data = s.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) {
      var currentStatus = data[i][10];
      if (currentStatus !== '承認済' && currentStatus !== '緊急承認済') {
        return { success: false, error: '承認済の発注のみ完了にできます (現在: ' + currentStatus + ')' };
      }
      applyStatusColor(s, i + 1, '発注済');
      // シートを非表示化
      try {
        var sheet = findSheetByUrl(ss, data[i][11]);
        if (sheet && !sheet.isSheetHidden()) sheet.hideSheet();
      } catch(e) {}
      return { success: true, message: '発注完了にしました' };
    }
  }
  return { success: false, error: '発注書が見つかりません' };
}

// ============ API: 発注書の取消（60秒以内） ============
function cancelOrder(id) {
  if (!id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: false, error: '発注一覧がありません' };

  var data = s.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return { success: false, error: '発注書が見つかりません' };

  // 受付から60秒以内かチェック
  var timestamp = data[rowIdx][0];
  var ts = (typeof timestamp === 'string') ? new Date(timestamp) : timestamp;
  var elapsed = (new Date()).getTime() - ts.getTime();
  if (elapsed > 60 * 1000) {
    return { success: false, error: '送信から60秒を超えたため取消できません' };
  }

  // 発注書シートを削除
  try {
    var sheetUrl = data[rowIdx][11];
    var match = sheetUrl.match(/gid=(\d+)/);
    if (match) {
      var gid = parseInt(match[1]);
      var sheets = ss.getSheets();
      for (var j = 0; j < sheets.length; j++) {
        if (sheets[j].getSheetId() === gid) {
          ss.deleteSheet(sheets[j]);
          break;
        }
      }
    }
  } catch(e) { Logger.log('発注書シート削除エラー: ' + e.toString()); }

  // 発注一覧のステータスを「取消」に
  applyStatusColor(s, rowIdx + 1, '取消');

  // 承認者にキャンセル通知メール
  try {
    var orderNo = data[rowIdx][1];
    var supplier = data[rowIdx][3];
    var approverEmail = APPROVER_PASS.email; // テスト用に固定
    MailApp.sendEmail({
      to: approverEmail,
      subject: '【取消】発注書: ' + supplier + ' / ' + orderNo,
      body: '先ほど送信した発注書は取り消されました。\n\n注文No.: ' + orderNo + '\n仕入先: ' + supplier + '\n\n承認は不要です。',
    });
  } catch(e) { Logger.log('キャンセル通知エラー: ' + e.toString()); }

  return { success: true, message: '発注を取り消しました' };
}

// ============ API: シートのPDFをBase64で返す（ブラウザ印刷用） ============
function getSheetPdfBase64(gid) {
  if (!gid) return { success: false, error: 'gidが必要です' };
  try {
    var ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    var url = 'https://docs.google.com/spreadsheets/d/' + ssId +
              '/export?format=pdf&gid=' + gid +
              '&portrait=true&size=A4&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenum=false&fzr=false';
    var response = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      return { success: false, error: 'PDF取得失敗(' + response.getResponseCode() + ')' };
    }
    return {
      success: true,
      base64: Utilities.base64Encode(response.getBlob().getBytes())
    };
  } catch(e) {
    return { success: false, error: e.toString() };
  }
}

// ============ メーカー→仕入先マッピング ============
var MAKER_TO_SUPPLIER = {
  'パロマ':'株式会社パロマ','リンナイ':'NX商事株式会社','ノーリツ':'ノーリツリビングクリエイト株式会社',
  'パーパス':'千代田エル・ピー・ジー機器株式会社','長府製作所':'株式会社長府製作所',
  'LIXIL':'渡辺パイプ株式会社','TOTO':'渡辺パイプ株式会社','タカラスタンダード':'渡辺パイプ株式会社',
  'KVK':'渡辺パイプ株式会社','カクダイ':'渡辺パイプ株式会社','タカギ':'渡辺パイプ株式会社',
  'マルゼン':'株式会社マルゼン','ホシザキ':'株式会社栄智機器','タニコー':'株式会社栄智機器',
  '桂精機':'中国工業株式会社','新コスモス電機':'中国工業株式会社','大栄産業':'東洋アルチタイト株式会社',
  '初田製作所':'愛知時計電機株式会社','ホクエイ':'矢崎エナジーシステム株式会社',
  '矢崎':'矢崎エナジーシステム株式会社','I・T・O':'エヌ・ティ・ティテレコン株式会社',
  '中国工業':'中国工業株式会社','宮入バルブ製作所':'中国工業株式会社'
};

// ============ メーカー別一括発注 ============
function batchTransferToPO(data) {
  // data: { estimateId, approverEmail, orderer, branch, urgent }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var estResult = getEstimateData(data.estimateId);
  if (!estResult.success) return estResult;

  // メーカーごとにグループ化（発注なし・工事は除外）
  var groups = {};
  for (var i = 0; i < estResult.lines.length; i++) {
    var ln = estResult.lines[i];
    if (ln.maker === '発注なし' || ln.maker === '工事' || !ln.maker) continue;
    if (!groups[ln.maker]) groups[ln.maker] = [];
    groups[ln.maker].push(ln);
  }

  var makerNames = Object.keys(groups);
  if (makerNames.length === 0) return { success: false, error: '発注対象のメーカーがありません' };

  var today = new Date();
  var dateStr = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy-MM-dd');
  var approver = data.urgent ? APPROVER_URGENT : APPROVER_PASS;
  var created = [];

  // 各メーカーごとに発注書を作成
  for (var m = 0; m < makerNames.length; m++) {
    var maker = makerNames[m];
    var lines = groups[maker];
    var supplier = MAKER_TO_SUPPLIER[maker] || maker;

    var poLines = [];
    var total = 0;
    for (var li = 0; li < lines.length; li++) {
      var el = lines[li];
      var amount = (el.qty || 0) * (el.price || 0);
      poLines.push({
        maker: el.maker,
        product: el.product,
        model: el.model || '',
        qty: el.qty,
        price: el.price,
        amount: amount,
        remark: '見積No.' + estResult.estimateNo,
        type: 'U'
      });
      total += amount;
    }

    var orderNo = Utilities.formatDate(today, 'Asia/Tokyo', 'yyyyMMdd') + String(m + 1).padStart(3, '0');

    var poData = {
      issueDate: dateStr,
      orderNo: orderNo,
      supplier: supplier,
      branch: data.branch || '本社',
      lines: poLines,
      total: total,
      siteName: estResult.subject || '',
      notes: '見積No.' + estResult.estimateNo + ' / メーカー: ' + maker,
      orderer: data.orderer || '',
      urgent: data.urgent || false,
      approverName: approver.name,
      approverEmail: approver.email,
      sourceEstimateNo: estResult.estimateNo
    };

    try {
      var result = processOrder(poData);
      if (result.success) {
        created.push({ maker: maker, supplier: supplier, orderNo: orderNo, lines: lines.length });
      }
    } catch (e) {
      Logger.log('発注作成エラー (' + maker + '): ' + e.toString());
    }
  }

  // 見積ステータスを「発注済」に更新
  if (created.length > 0) {
    markEstimateTransferred(data.estimateId);
  }

  return {
    success: true,
    message: created.length + '件の発注書を作成しました',
    created: created,
    total: makerNames.length,
    skipped: makerNames.length - created.length
  };
}
