/**
 * 発注書フォーム - GAS v8 (メール承認 + 緊急バイパス)
 *
 * 通常(PASS): フォーム → 承認者メール(承認/却下リンク) → 承認後 → 発注担当者へ通知
 * 緊急:       フォーム → 承認者+発注担当者に同時メール → 即発注可能
 *
 * ステータス: 申請中 → 承認済 → 発注済 / 却下
 *             緊急の場合: 緊急承認済（自動）
 */
var INDEX_SHEET = '発注一覧';
var TEMPLATE_SHEET = '20260415001_4';

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
  SpreadsheetApp.getUi().alert('OK');
}

// ============ POST ============
function doPost(e) {
  try {
    return ContentService.createTextOutput(JSON.stringify(processOrder(JSON.parse(e.postData.contents)))).setMimeType(ContentService.MimeType.JSON);
  } catch (er) {
    return ContentService.createTextOutput(JSON.stringify({success:false,error:er.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============ GET: 承認/却下アクション ============
function doGet(e) {
  var action = e.parameter.action;
  var id = e.parameter.id;
  if (!action || !id) return HtmlService.createHtmlOutput('<h2>発注書APIは稼働中です</h2>');

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
    notifyPurchaser(id, orderNo, supplier, orderer, total, sheetUrl);
    return HtmlService.createHtmlOutput(resultPage('承認しました',
      '注文No.: ' + orderNo + '<br>仕入先: ' + supplier + '<br>金額: &yen;' + Number(total).toLocaleString() +
      '<br><br>発注担当者に通知しました。', '#188038', ss.getUrl()));

  } else if (action === 'reject') {
    if (currentStatus !== '申請中') return HtmlService.createHtmlOutput(resultPage('処理済', 'この発注書は既に処理済みです', '#5f6368'));
    applyStatusColor(sheet, rowIdx, '却下');
    return HtmlService.createHtmlOutput(resultPage('却下しました', '注文No.: ' + orderNo, '#d93025', ss.getUrl()));
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
  return { success: true, message: '発注書を登録しました', orderNo: data.orderNo, spreadsheetUrl: ss.getUrl(), sheetUrl: sheetUrl };
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

  var bi = getBranchInfo(data.branch);
  var d = data.issueDate.split('-');

  sh.getRange('AH1').setValue(parseInt(d[0]));
  sh.getRange('AL1').setValue(parseInt(d[1]));
  sh.getRange('AO1').setValue(parseInt(d[2]));
  sh.getRange('AH3').setValue(data.orderNo);
  sh.getRange('A10').setValue(data.supplier);
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
    '<a href="'+ss.getUrl()+'" style="display:block;text-align:center;padding:14px;background:#1a73e8;color:white;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin:16px 0">スプレッドシートを開く</a>' +
    '</div></div>';

  MailApp.sendEmail({
    to: PURCHASER.email,
    subject: '【発注依頼】' + supplier + ' / ' + orderNo,
    body: '承認済: ' + supplier + ' / ' + orderNo + '\nスプレッドシート: ' + ss.getUrl(),
    htmlBody: hb
  });
}
