/**
 * 発注書フォーム - Google Apps Script
 * Excel発注書と同一フォーマットでスプレッドシートに出力
 */

const INDEX_SHEET = '発注一覧';

// ============ 初期化 ============
function initSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(INDEX_SHEET);
  if (!sheet) { sheet = ss.insertSheet(INDEX_SHEET); }
  const headers = ['受付日時','注文No.','発行日','仕入先','事業所','現場名','合計金額','注文者','緊急','承認者','シートリンク'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#4285f4').setFontColor('#fff');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(4, 200);
  sheet.setColumnWidth(7, 110);
  sheet.setColumnWidth(11, 200);
  SpreadsheetApp.getUi().alert('一覧シートを作成しました');
}

// ============ API ============
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const result = processOrder(data);
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);
}

// ============ メイン ============
function processOrder(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orderSheet = createOrderSheet(ss, data.orderNo, data);
  addToIndex(ss, data, orderSheet);
  sendApprovalEmail(data, orderSheet);
  return { success: true, message: '発注書を登録しました', orderNo: data.orderNo };
}

// ============ 事業所マスタ ============
function getBranchInfo(branchName) {
  const branches = {
    '本社': { zip: '〒820-0081', addr: '福岡県飯塚市枝国507番地', tel: 'TEL：(0948)22-1234', fax: 'FAX：(0948)22-5777' },
    '福岡店': { zip: '〒814-0174', addr: '福岡県福岡市早良区田隈1-29-21', tel: 'TEL：(092)861-2071', fax: 'FAX：(092)861-4175' },
    '飯塚ガスセンター': { zip: '〒820-0073', addr: '福岡県飯塚市平恒477-7', tel: 'TEL：(0948)22-3611', fax: 'FAX：(0948)22-9302' }
  };
  return branches[branchName] || branches['福岡店'];
}

// ============ Excel完全再現シート ============
function createOrderSheet(ss, sheetName, data) {
  let name = sheetName;
  let i = 1;
  while (ss.getSheetByName(name)) { name = sheetName + '_' + i; i++; }
  const sh = ss.insertSheet(name);

  const thin = SpreadsheetApp.BorderStyle.SOLID;
  const hair = SpreadsheetApp.BorderStyle.DOTTED;
  const headerBg = '#d9e2f3';  // 薄い青（Excelヘッダー）
  const branchInfo = getBranchInfo(data.branch);

  // ---- 列数を43列（A〜AQ）に設定 ----
  // 主要列幅をExcelに合わせる
  sh.setColumnWidth(1, 20);   // A (No.)
  for (var c = 2; c <= 25; c++) sh.setColumnWidth(c, 25); // B〜Y
  sh.setColumnWidth(26, 25);  // Z
  sh.setColumnWidth(27, 15);  // AA
  sh.setColumnWidth(28, 20);  // AB
  for (var c = 29; c <= 31; c++) sh.setColumnWidth(c, 25); // AC〜AE
  sh.setColumnWidth(32, 20);  // AF
  for (var c = 33; c <= 37; c++) sh.setColumnWidth(c, 20); // AG〜AK
  sh.setColumnWidth(38, 15);  // AL (端)
  for (var c = 38; c <= 43; c++) sh.setColumnWidth(c, 25); // AL〜AQ

  // =============================================
  // Row 1-2: 発行日（右上）
  // =============================================
  sh.getRange('AD1:AG2').merge().setValue('発行日').setHorizontalAlignment('center').setVerticalAlignment('middle');
  // 年月日を分割して配置
  var issueDate = data.issueDate.split('-');
  sh.getRange('AH1:AJ2').merge().setValue(parseInt(issueDate[0])).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AK1:AK2').merge().setValue('年').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AL1:AM2').merge().setValue(parseInt(issueDate[1])).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AN1:AN2').merge().setValue('月').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AO1:AP2').merge().setValue(parseInt(issueDate[2])).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AQ1:AQ2').merge().setValue('日').setHorizontalAlignment('center').setVerticalAlignment('middle');

  // =============================================
  // Row 3-4: 注文No.
  // =============================================
  sh.getRange('AD3:AG4').merge().setValue('注文No.').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AH3:AQ4').merge().setValue(data.orderNo).setHorizontalAlignment('center').setVerticalAlignment('middle');

  // =============================================
  // Row 6-7: 「注文書」タイトル
  // =============================================
  sh.getRange('A6:AQ7').merge().setValue('注文書').setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');

  // =============================================
  // Row 10-11: 仕入先名 + 御中
  // =============================================
  sh.getRange('A10:R11').merge().setValue(data.supplier).setFontSize(12).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('S10:V11').merge().setValue('御中').setHorizontalAlignment('center').setVerticalAlignment('middle');
  // 事業所名（右上）
  sh.getRange('AL11:AQ12').merge().setValue(data.branch).setFontSize(12).setHorizontalAlignment('left').setVerticalAlignment('middle');

  // =============================================
  // Row 13-15: 挨拶文（左） + 住所（右）
  // =============================================
  sh.getRange('A13:S15').merge().setValue('平素よりお世話になっております。\n下記の商品を注文いたします。\n納入予定日のご連絡お願いいたします。').setFontSize(10).setVerticalAlignment('top').setWrap(true);
  sh.getRange('AB13:AQ13').merge().setValue(branchInfo.zip).setFontSize(9).setHorizontalAlignment('left');
  sh.getRange('AB14:AQ14').merge().setValue(branchInfo.addr).setFontSize(9).setHorizontalAlignment('left');
  sh.getRange('AB15:AQ15').merge().setValue(branchInfo.tel + ' ' + branchInfo.fax).setFontSize(9).setHorizontalAlignment('left');

  // =============================================
  // Row 17-18: 明細ヘッダー
  // =============================================
  var hdr = [
    ['A17:B18', 'No.'], ['C17:G18', 'メーカー'], ['H17:O18', '商品名'],
    ['P17:Y18', '型式'], ['Z17:AA18', '数量'], ['AB17:AF18', '単価'],
    ['AG17:AK18', '金額'], ['AL17:AQ18', '備考']
  ];
  hdr.forEach(function(h) {
    sh.getRange(h[0]).merge().setValue(h[1]).setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(10);
  });
  // ヘッダー行全体に罫線
  sh.getRange('A17:AQ18').setBorder(true, true, true, true, null, null, '#000000', thin);
  // 各列区切りに罫線
  ['B18','G18','O18','Y18','AA18','AF18','AK18'].forEach(function(c) {
    sh.getRange(c).setBorder(null, null, null, true, null, null, '#000000', hair);
  });

  // =============================================
  // Row 19〜48: 明細行（16行、各2行高さ）
  // =============================================
  var lines = data.lines || [];
  for (var idx = 0; idx < 16; idx++) {
    var r = 19 + idx * 2; // 19,21,23...49
    var line = lines[idx] || {};

    sh.getRange('A' + r + ':B' + (r + 1)).merge().setValue(line.maker ? (idx + 1) : '').setHorizontalAlignment('center').setVerticalAlignment('middle');
    sh.getRange('C' + r + ':G' + (r + 1)).merge().setValue(line.maker || '').setVerticalAlignment('middle');
    sh.getRange('H' + r + ':O' + (r + 1)).merge().setValue(line.product || '').setFontSize(9).setVerticalAlignment('middle');
    sh.getRange('P' + r + ':Y' + (r + 1)).merge().setValue(line.model || '').setFontSize(9).setHorizontalAlignment('left').setVerticalAlignment('middle');
    sh.getRange('Z' + r + ':AA' + (r + 1)).merge().setValue(line.qty || '').setHorizontalAlignment('center').setVerticalAlignment('middle');
    sh.getRange('AB' + r + ':AF' + (r + 1)).merge().setValue(line.price || '').setVerticalAlignment('middle');
    sh.getRange('AG' + r + ':AK' + (r + 1)).merge().setValue(line.amount || (line.qty && line.price ? line.qty * line.price : '')).setVerticalAlignment('middle');
    sh.getRange('AL' + r + ':AQ' + (r + 1)).merge().setValue(line.remark || '').setVerticalAlignment('middle');

    // 数値フォーマット
    if (line.price) sh.getRange('AB' + r).setNumberFormat('#,##0');
    if (line.amount || (line.qty && line.price)) sh.getRange('AG' + r).setNumberFormat('#,##0');

    // 罫線（各行に細線）
    sh.getRange('A' + r + ':AQ' + (r + 1)).setBorder(null, true, true, true, null, null, '#000000', hair);
    // 列区切り
    ['B','G','O','Y','AA','AF','AK'].forEach(function(c) {
      sh.getRange(c + r + ':' + c + (r + 1)).setBorder(null, null, null, true, null, null, '#000000', hair);
    });
  }
  // 明細エリア外枠
  sh.getRange('A17:AQ50').setBorder(true, true, true, true, null, null, '#000000', thin);

  // =============================================
  // Row 49-50: 合計行
  // =============================================
  sh.getRange('A49:AF50').merge().setValue('合計').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AG49:AK50').merge().setValue(data.total).setNumberFormat('#,##0').setVerticalAlignment('middle');
  sh.getRange('A49:AQ50').setBorder(true, true, true, true, null, null, '#000000', thin);

  // =============================================
  // Row 52-53: 納入先
  // =============================================
  sh.getRange('A52:E53').merge().setValue('納入先').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('H52:L53').merge().setValue('本社').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('O52:S53').merge().setValue('福岡店').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('V52:Z53').merge().setValue('その他').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('A52:Z53').setBorder(true, true, true, true, null, null, '#000000', thin);

  // =============================================
  // Row 54-55: 請求先 + 納入希望日
  // =============================================
  sh.getRange('A54:E55').merge().setValue('請求先').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('H54:L55').merge().setValue('本社').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('O54:S55').merge().setValue('福岡店').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('T54:W55').merge().setValue('納入希望日').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('A54:AE55').setBorder(true, true, true, true, null, null, '#000000', thin);

  // =============================================
  // Row 56-57: 現場名
  // =============================================
  sh.getRange('A56:E57').merge().setValue('現場名').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('F56:AQ57').merge().setValue(data.siteName || '').setHorizontalAlignment('left').setVerticalAlignment('middle');
  sh.getRange('A56:AQ57').setBorder(true, true, true, true, null, null, '#000000', thin);

  // =============================================
  // Row 60-65: 特記事項 + 注文者記入欄 + 承認欄
  // =============================================
  sh.getRange('A60:B65').merge().setValue('特記事項').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.getRange('C60:W60').merge().setValue(data.notes || '').setVerticalAlignment('middle');
  sh.getRange('C61:W65').merge().setValue('').setVerticalAlignment('middle');

  // 注文者記入欄
  sh.getRange('X60:AE61').merge().setValue('注文者記入欄').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle');
  // 承認欄
  sh.getRange('AF60:AI61').merge().setValue('承認欄').setBackground('#d9d9d9').setHorizontalAlignment('center').setVerticalAlignment('middle');
  // 注文者・担当者ヘッダー
  sh.getRange('AJ60:AM61').merge().setValue('注文者').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AN60:AQ61').merge().setValue('担当者').setBackground(headerBg).setHorizontalAlignment('center').setVerticalAlignment('middle');

  // 注文者名（大きく）
  sh.getRange('AJ62:AM65').merge().setValue(data.orderer).setFontSize(16).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AN62:AQ65').merge().setValue(data.approverName).setFontSize(16).setHorizontalAlignment('center').setVerticalAlignment('middle');

  // 緊急フラグ
  sh.getRange('AF62:AI65').merge().setValue(data.urgent ? '緊急' : '').setFontSize(16).setHorizontalAlignment('center').setVerticalAlignment('middle');
  if (data.urgent) {
    sh.getRange('AF62').setFontColor('#ff0000').setFontWeight('bold');
  }

  // 注文者記入欄の日付
  var today = new Date();
  sh.getRange('X64:Y65').merge().setValue(today.getMonth() + 1).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('Z64:AA65').merge().setValue('月').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AB64:AC65').merge().setValue(today.getDate()).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('AD64:AE65').merge().setValue('日').setHorizontalAlignment('center').setVerticalAlignment('middle');

  // 外枠罫線
  sh.getRange('A60:AQ65').setBorder(true, true, true, true, null, null, '#000000', thin);
  sh.getRange('X60:AQ65').setBorder(true, true, true, true, true, true, '#000000', thin);

  // =============================================
  // Row 68-69: 「PASS」or「緊急」入力欄
  // =============================================
  sh.getRange('AF68:AI68').merge().setValue('「PASS」or「緊急」を入力↓').setFontWeight('bold').setFontSize(10).setHorizontalAlignment('center').setBackground('#ffff00');
  sh.getRange('AF69:AI69').merge().setValue(data.urgent ? '緊急' : 'PASS').setHorizontalAlignment('center').setBackground('#f2f2f2').setFontSize(10);

  return sh;
}

// ============ 一覧シートに追記 ============
function addToIndex(ss, data, orderSheet) {
  var sheet = ss.getSheetByName(INDEX_SHEET);
  if (!sheet) { initSheet(); sheet = ss.getSheetByName(INDEX_SHEET); }
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  var sheetUrl = ss.getUrl() + '#gid=' + orderSheet.getSheetId();
  sheet.appendRow([now, data.orderNo, data.issueDate, data.supplier, data.branch, data.siteName || '', data.total, data.orderer, data.urgent ? '緊急' : 'PASS', data.approverName, sheetUrl]);
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 7).setNumberFormat('#,##0');
  if (data.urgent) { sheet.getRange(lastRow, 9).setFontColor('#d93025').setFontWeight('bold'); }
}

// ============ 承認者メール ============
function sendApprovalEmail(data, orderSheet) {
  var approverEmail = data.approverEmail; if (!approverEmail) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetUrl = ss.getUrl() + '#gid=' + orderSheet.getSheetId();
  var urgent = data.urgent ? '【緊急】' : '';
  var subject = urgent + '発注承認依頼: ' + data.supplier + ' / 注文No.' + data.orderNo;
  var detailRows = '';
  (data.lines || []).forEach(function(line, idx) {
    detailRows += '<tr><td style="border:1px solid #ddd;padding:6px;text-align:center">' + (idx + 1) + '</td><td style="border:1px solid #ddd;padding:6px">' + line.maker + '</td><td style="border:1px solid #ddd;padding:6px">' + line.product + '</td><td style="border:1px solid #ddd;padding:6px">' + (line.model || '-') + '</td><td style="border:1px solid #ddd;padding:6px;text-align:right">' + line.qty + '</td><td style="border:1px solid #ddd;padding:6px;text-align:right">&yen;' + Number(line.price).toLocaleString() + '</td><td style="border:1px solid #ddd;padding:6px;text-align:right">&yen;' + Number(line.amount).toLocaleString() + '</td></tr>';
  });
  var htmlBody = '<div style="font-family:sans-serif;max-width:600px"><div style="background:#1a73e8;color:white;padding:16px;border-radius:8px 8px 0 0"><h2 style="margin:0;font-size:18px">' + urgent + '発注承認依頼</h2></div><div style="border:1px solid #ddd;border-top:none;padding:16px;border-radius:0 0 8px 8px"><table style="width:100%;border-collapse:collapse;margin-bottom:16px"><tr><td style="padding:6px;font-weight:bold;width:100px">発行日</td><td>' + data.issueDate + '</td></tr><tr><td style="padding:6px;font-weight:bold">注文No.</td><td>' + data.orderNo + '</td></tr><tr><td style="padding:6px;font-weight:bold">仕入先</td><td>' + data.supplier + '</td></tr><tr><td style="padding:6px;font-weight:bold">事業所</td><td>' + data.branch + '</td></tr>' + (data.siteName ? '<tr><td style="padding:6px;font-weight:bold">現場名</td><td>' + data.siteName + '</td></tr>' : '') + '<tr><td style="padding:6px;font-weight:bold">注文者</td><td>' + data.orderer + '</td></tr></table><table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px"><thead><tr style="background:#d9e2f3"><th style="border:1px solid #ddd;padding:6px">No</th><th style="border:1px solid #ddd;padding:6px">メーカー</th><th style="border:1px solid #ddd;padding:6px">商品名</th><th style="border:1px solid #ddd;padding:6px">型式</th><th style="border:1px solid #ddd;padding:6px">数量</th><th style="border:1px solid #ddd;padding:6px">単価</th><th style="border:1px solid #ddd;padding:6px">金額</th></tr></thead><tbody>' + detailRows + '</tbody></table><div style="text-align:right;font-size:18px;font-weight:bold;margin-bottom:16px">合計: &yen;' + Number(data.total).toLocaleString() + '</div><div style="margin-top:16px;padding:12px;background:#d9e2f3;border-radius:8px;text-align:center"><a href="' + sheetUrl + '" style="color:#1a73e8;font-weight:bold;font-size:16px">スプレッドシートで発注書を確認</a></div></div></div>';
  var textBody = urgent + '発注承認依頼\n\n発行日: ' + data.issueDate + '\n注文No.: ' + data.orderNo + '\n仕入先: ' + data.supplier + '\n事業所: ' + data.branch + '\n\n';
  (data.lines || []).forEach(function(l, i) { textBody += (i + 1) + '. ' + l.maker + ' / ' + l.product + '  金額:' + Number(l.amount).toLocaleString() + '円\n'; });
  textBody += '\n合計: ' + Number(data.total).toLocaleString() + '円\n\nスプレッドシート: ' + sheetUrl + '\n';
  MailApp.sendEmail({ to: approverEmail, subject: subject, body: textBody, htmlBody: htmlBody });
}
