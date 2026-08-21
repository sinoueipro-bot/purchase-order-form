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
var EST_INDEX_SHEET = '見積一覧';
// ★ 2026-05-29 在庫管理タブ: 発注を「商品1行ずつ」に展開し、在庫管理担当が分類をプルダウンで選ぶ
var STOCK_SHEET = '在庫管理';  // 旧・単一在庫管理(移行元)。移行後は「在庫管理_旧」にリネーム。新規は拠点別へ書く。
var STOCK_CATEGORIES = ['保安費', '器具仕入れ', '消耗品費', '顧客設備'];

// ★ 2026-08-21: 在庫管理を拠点別タブに分割（本社/福岡）。事業所で自動振り分け。
var STOCK_SHEET_HONSHA = '在庫管理_本社';
var STOCK_SHEET_FUKUOKA = '在庫管理_福岡';
// 事業所名 → 在庫管理タブ名。「福岡店」だけ福岡、それ以外(本社/空/不明)は本社に寄せる(井上さん判断D)。
function _stockSheetName(branch) {
  return (String(branch || '').trim() === '福岡店') ? STOCK_SHEET_FUKUOKA : STOCK_SHEET_HONSHA;
}
function _allStockSheetNames() { return [STOCK_SHEET_HONSHA, STOCK_SHEET_FUKUOKA]; }
// 在庫管理タブ(拠点別 or 旧)か判定。onEdit等のガードに使用。
function _isStockSheetName(name) {
  return name === STOCK_SHEET_HONSHA || name === STOCK_SHEET_FUKUOKA || name === STOCK_SHEET;
}
// 事業所に対応する在庫管理シートを取得(無ければ拠点別に作成)
function _getStockSheet(ss, branch) {
  var nm = _stockSheetName(branch);
  var s = ss.getSheetByName(nm);
  if (!s) { initStockSheetNamed(nm); s = ss.getSheetByName(nm); }
  return s;
}
// 実在する拠点別在庫管理シート配列(集計/取消/再展開などで両タブを走査するのに使う)
function _existingStockSheets(ss) {
  var out = [];
  _allStockSheetNames().forEach(function (nm) { var s = ss.getSheetByName(nm); if (s) out.push(s); });
  return out;
}

// ★ 運用切替フラグ（true = 新フロー / 個別シート作らない、false = 旧フロー）
// 問題があればこれをfalseに戻すだけで旧動作に戻る
var NEW_FLOW = false;

// ★ 画面承認用のパスワード（メール承認は不要。画面UI経由の承認のみ要求）
// 変更したい場合はここを書き換えてGASを再デプロイ
var APPROVAL_PASSWORD = 'ipro1234';

// テンプレート名候補（複数名前でも探す。先頭から順にヒットしたものを使用）
var PO_TEMPLATE_CANDIDATES = ['発注書(テンプレート)', '発注書（テンプレート）', 'テンプレート', '発注書テンプレート', '発注テンプレート'];
var EST_TEMPLATE_CANDIDATES = ['見積書(テンプレート)', '見積書（テンプレート）', '見積テンプレート', '見積書テンプレート', 'テンプレート見積'];

// 互換のため旧定数を残す（既存コード参照用）
var TEMPLATE_SHEET = '発注書(テンプレート)';
var EST_TEMPLATE_SHEET = '見積書(テンプレート)';

// テンプレートシートを候補名から探す
function findTemplateSheet(ss, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var s = ss.getSheetByName(candidates[i]);
    if (s) return s;
  }
  return null;
}

// ★ メールアドレス設定
// テスト: 全て井上将吾に送信。本番時は各担当者のアドレスに変更
var APPROVER_PASS = { name: '井上将吾', email: 's.inoue.ipro@gmail.com' };
var APPROVER_URGENT = { name: '井上将吾', email: 's.inoue.ipro@gmail.com' };
var PURCHASER = { name: '井上将吾', email: 's.inoue.ipro@gmail.com' };
// ★ 事務員メアド一覧 (2026-05-27 追加・通常承認後通知 + 緊急SOS時の同報先)
//   ここに追加すると notifyPurchaser / sendUrgentEmail で全員に同報されます
// 2026-06-03: 本来の事務員2名に差し替え (旧: 承認者4名の仮メアド v108)
var JIMUIN_EMAILS = [
  'manabe@i-pro.co.jp',      // 眞鍋 (事務員)
  'tsujitsuka@i-pro.co.jp'   // 辻塚 (事務員)
];

// ★ 注文者(発注依頼者) 名前→メアド対応表 (2026-06-03)
//   承認/却下メールを申請者本人へ直接届けるためのルーティング表 (notifyOrderer で使用)。
//   ★ index.html の STAFF (発注依頼者ドロップダウン) と必ず同じ顔ぶれで維持すること。
var STAFF_EMAILS = {
  '眞鍋': 'manabe@i-pro.co.jp',
  '松永': 'ipro_ip02@icloud.com',
  '中嶋': 'nakashima@i-pro.co.jp',
  '川上': 'kawakami@i-pro.co.jp',
  '入江': 'ipro_ip06@icloud.com',
  '川口': 'ipro_ip04@icloud.com',
  '辻塚': 'tsujitsuka@i-pro.co.jp',
  '三浦': 'ipro_ip03@icloud.com',
  '三井': 'mitsui@i-pro.co.jp',
  '渡邊': 'ipro_ip05@icloud.com',
  '久我': 'kuga@i-pro.co.jp',
  '岩﨑': 'ipro_ip07@icloud.com',
  '𦚰村': 'ipro_ip08@icloud.com',
  // 2026-06-04 管理職3名(原田部長/亀谷常務/井上将吾)を注文者にも追加。岩崎店長は既存の岩﨑と同一人物のため注文者には追加せず。本人へ承認/却下通知を直送するためのメアド
  '原田部長': 'harada@i-pro.co.jp',
  '亀谷常務': 'kametani@i-pro.co.jp',
  '井上将吾': 's.inoue.ipro@gmail.com'
};

// ★ 発注者(orderPerson) 名前→メアド対応表 (2026-06-05)
//   承認後の「発注してください」通知(notifyPurchaser)を、固定の事務員ではなく
//   申請時に選んだ発注者本人へ届けるためのルーティング表。
//   ★ index.html の ORDER_PERSONS (発注者ドロップダウン) と必ず同じ顔ぶれで維持すること。
// 2026-06-18 発注者ドロップダウンを全16名(=STAFF)に拡張したため、本人ルーティングも STAFF_EMAILS と同一に統一。
//   岩崎店長 は旧データ互換のため別名で残置(岩﨑と同一人物)。
var ORDER_PERSON_EMAILS = Object.assign({}, STAFF_EMAILS, { '岩崎店長': 'iwasaki@i-pro.co.jp' });

// ★ 2026-06-27: PC版+スマホ版の2メアドを持つメンバー。発注者/申請者として選ばれたら【両方】へ通知。
//   ★ 名前→[全メアド]。STAFF_EMAILS/ORDER_PERSON_EMAILS の単一メアドより優先。追加者はここに足すだけ。
var MULTI_EMAILS = {
  '原田部長': ['harada@i-pro.co.jp', 'ipro_ip01@icloud.com'],
  '松永':     ['ipro_ip02@icloud.com', 'matsunaga@i-pro.co.jp'],
  '三浦':     ['ipro_ip03@icloud.com', 'miura@i-pro.co.jp'],
  '川口':     ['ipro_ip04@icloud.com', 'kawaguchi@i-pro.co.jp']
};
// 名前(+予備の単一メアド)から通知先メアド配列を返す。MULTI_EMAILS該当者は両方、それ以外は予備1件。
function _emailsForPerson(name, fallbackEmail) {
  if (name && MULTI_EMAILS[name] && MULTI_EMAILS[name].length) return MULTI_EMAILS[name].slice();
  return fallbackEmail ? [fallbackEmail] : [];
}

// ★ 発注権限保持者 (2026-06-17): この5人が発注依頼者なら承認フロー不要。
//   承認者を空欄で送信 → 自動で「承認済」+ 発注依頼を発注者へ。★ index.html の ORDER_AUTHORITY と一致させること。
var ORDER_AUTHORITY = ['辻塚', '原田部長', '眞鍋', '岩﨑', '亀谷常務'];

// ============ 初期化 ============
function initSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) s = ss.insertSheet(INDEX_SHEET);
  // 列構造（2026-05-21 拡張）:
  //   A〜M: 基本情報
  //   N=明細JSON, O=特記事項, P=更新日時
  //   Q=発注完了日 (2026-05-12 追加)
  //   R=事務員通知不要 (2026-05-21 追加・申請時の選択)
  //   S=入荷チェック (2026-05-21 追加・事務員手動入力)
  //   T=保安費, U=消耗品費, V=器具仕入れ, W=顧客設備 (2026-05-21 追加・事務員手動入力)
  // 2026-05-27 v84: U列=高額単価◎/V列=無償M に変更 (旧 消耗品費/器具仕入れ は廃止)
  var headers = ['受付日時','注文No.','発行日','仕入先','事業所','現場名','合計金額','注文者','緊急','承認者','ステータス','シートリンク','ID','明細JSON','特記事項','更新日時','発注完了日','事務員通知不要','入荷チェック','保安費','高額単価(10万超)','無償(M)','顧客設備'];
  s.getRange(1,1,1,headers.length).setValues([headers]);
  s.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#4285f4').setFontColor('#fff');
  s.setFrozenRows(1);
  s.setColumnWidth(17, 150); // 発注完了日
  s.setColumnWidth(18, 120); // 事務員通知不要
  s.setColumnWidth(19, 110); // 入荷チェック
  s.setColumnWidth(20, 100); // 保安費
  s.setColumnWidth(21, 100); // 消耗品費
  s.setColumnWidth(22, 110); // 器具仕入れ
  s.setColumnWidth(23, 110); // 顧客設備
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
// 見積関連の formType (estimate / quickPO / batchPO / updateEstimate) は
// 2026-05-12 発注専用化で削除。復元は docs/RESTORE_ESTIMATE.md 参照
function doPost(e) {
  try {
    // (2026-05-27 v75) クリティカル調査用: 受信した生データを丸ごとログ出力
    Logger.log('====== doPost 受信 ======');
    Logger.log('postData.contents: ' + (e && e.postData ? e.postData.contents : '<null>'));
    var data = JSON.parse(e.postData.contents);
    Logger.log('parsed data keys: ' + Object.keys(data).join(','));
    Logger.log('data.lines (raw): ' + JSON.stringify(data.lines));
    Logger.log('data.lines.length: ' + ((data.lines && data.lines.length) || 0));
    if (data.lines) {
      data.lines.forEach(function(ln, i) {
        Logger.log('  line[' + i + ']: maker=[' + ln.maker + '] product=[' + ln.product + '] qty=[' + ln.qty + '] price=[' + ln.price + ']');
      });
    }
    var result;
    if (data.formType === 'updateOrder') {
      result = updateOrder(data);
    } else {
      result = processOrder(data);
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (er) {
    Logger.log('doPost エラー: ' + er.toString());
    return ContentService.createTextOutput(JSON.stringify({success:false,error:er.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ★ 各列の幅を測定し、A4幅を超えているか診断する
// GASエディタで「measureColumnWidths」を実行 → どの列が広いか特定
function measureColumnWidths() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!t) { Logger.log('テンプレートが見つかりません'); return; }
  var total = 0;
  var widths = [];
  var maxCol = Math.min(43, t.getMaxColumns());
  for (var c = 1; c <= maxCol; c++) {
    var w = t.getColumnWidth(c);
    widths.push(columnToLetter(c) + '=' + w + 'px');
    total += w;
  }
  Logger.log('====== 列幅診断 ======');
  Logger.log('各列幅: ' + widths.join(' / '));
  Logger.log('列幅合計: ' + total + 'px');
  // A4縦の印刷可能幅 (余白0.3inch両側=0.6inch): (21.0cm - 1.52cm) / 2.54 * 96dpi
  var a4PrintW = Math.round((21.0 - 1.52) / 2.54 * 96);
  Logger.log('A4縦の印刷可能幅(余白0.3inch): 約' + a4PrintW + 'px');
  Logger.log('超過倍率: ' + (total / a4PrintW).toFixed(2) + '倍');
  if (total > a4PrintW) {
    Logger.log('→ ★列幅がA4超過。スプシが ' + (a4PrintW/total).toFixed(2) + '倍に自動縮小 → 縦余白の原因');
    Logger.log('→ shrinkColumnsToA4() で列幅を ' + (a4PrintW/total).toFixed(2) + '倍に縮めればA4内に収まる');
  } else {
    Logger.log('→ A4内に収まっている');
  }
  // 行高合計も参考表示
  var totalH = 0, maxRow = Math.min(64, t.getMaxRows());
  for (var r = 1; r <= maxRow; r++) totalH += t.getRowHeight(r);
  var a4PrintH = Math.round((29.7 - 1.52) / 2.54 * 96);
  Logger.log('行高合計(1-' + maxRow + '行): ' + totalH + 'px / A4縦の印刷可能高さ: 約' + a4PrintH + 'px');
  Logger.log('====== 完了 ======');
}

// ★ 行高を拡大して縦横比をA4に合わせる (余白を消す・読みやすさ優先版)
// 列幅は変えない→文字の横幅維持。行高だけ増やして縦横比をA4(0.691)に一致させる。
// これでfitw(幅合わせ)印刷時に縦余白がゼロになり、行間も広がって読みやすくなる。
// GASエディタで「expandRowsToA4」を実行。
function expandRowsToA4() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!t) { Logger.log('テンプレートが見つかりません'); return; }
  var maxCol = Math.min(43, t.getMaxColumns());
  var maxRow = Math.min(64, t.getMaxRows());
  var totalW = 0, totalH = 0;
  for (var c = 1; c <= maxCol; c++) totalW += t.getColumnWidth(c);
  for (var r = 1; r <= maxRow; r++) totalH += t.getRowHeight(r);
  // A4縦の印刷可能領域 736px(幅) : 1065px(高さ) = 縦横比0.691
  // 幅はそのまま、目標の高さ = 幅 ÷ 0.691 = 幅 × 1065/736
  var targetH = totalW * 1065 / 736;
  var ratio = targetH / totalH;
  Logger.log('====== 行高拡大(A4比合わせ) ======');
  Logger.log('現在: 幅' + totalW + 'px / 高さ' + totalH + 'px (縦横比 ' + (totalW/totalH).toFixed(3) + ')');
  Logger.log('A4比0.691に合わせる目標高さ: ' + Math.round(targetH) + 'px → 行高を ' + ratio.toFixed(3) + '倍');
  if (ratio > 1.02) {
    for (var r2 = 1; r2 <= maxRow; r2++) {
      var h = t.getRowHeight(r2);
      t.setRowHeight(r2, Math.round(h * ratio));
    }
    SpreadsheetApp.flush();
    var newH = 0;
    for (var r3 = 1; r3 <= maxRow; r3++) newH += t.getRowHeight(r3);
    Logger.log('✅ 行高を ' + ratio.toFixed(3) + '倍に拡大。新しい高さ合計: ' + Math.round(newH) + 'px');
    Logger.log('→ 縦横比が ' + (totalW/newH).toFixed(3) + ' (A4比0.691) に。fitw印刷で縦余白がほぼ消える');
    Logger.log('→ 列幅は変更なし=文字の横幅維持。行間が広がり読みやすくなった');
  } else {
    Logger.log('既にA4比に近い。拡大不要');
  }
  Logger.log('====== 完了 ======');
}

// ★ 列幅をA4幅に収まるよう一律縮小 (列幅超過が縦余白の原因のとき)
// ⚠️ 実行前に measureColumnWidths で確認。文字が切れる可能性があるので実行後に要確認
function shrinkColumnsToA4() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!t) { Logger.log('テンプレートが見つかりません'); return; }
  var total = 0, maxCol = Math.min(43, t.getMaxColumns());
  for (var c = 1; c <= maxCol; c++) total += t.getColumnWidth(c);
  var a4PrintW = Math.round((21.0 - 1.52) / 2.54 * 96);
  if (total <= a4PrintW) { Logger.log('既にA4内。縮小不要'); return; }
  var ratio = a4PrintW / total;
  Logger.log('列幅を ' + ratio.toFixed(3) + '倍に縮小します (合計 ' + total + 'px → ' + a4PrintW + 'px)');
  for (var c = 1; c <= maxCol; c++) {
    var w = t.getColumnWidth(c);
    t.setColumnWidth(c, Math.max(8, Math.round(w * ratio)));
  }
  SpreadsheetApp.flush();
  var newTotal = 0;
  for (var c2 = 1; c2 <= maxCol; c2++) newTotal += t.getColumnWidth(c2);
  Logger.log('✅ 縮小完了。新しい列幅合計: ' + newTotal + 'px');
  Logger.log('→ テンプレを100%表示してA4に収まるか確認。文字が切れていたら個別調整 or フォント縮小');
}

// ★ テンプレートを発注書範囲(64行×43列AQ)ぴったりにトリミング
// スプシ印刷で「現在のシート」を選ぶだけで発注書だけが印刷されるようにする。
// copyTo で作る発注書シートも64行を引き継ぐ。GASエディタで1回だけ実行。
function trimTemplateRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!t) { Logger.log('テンプレートが見つかりません'); return; }
  Logger.log('トリミング前: ' + t.getMaxRows() + '行 × ' + t.getMaxColumns() + '列');
  // 行65以降を削除 (発注書は行64まで)。安全のため値の有無を確認
  var maxRows = t.getMaxRows();
  if (maxRows > 64) {
    var below = t.getRange(65, 1, maxRows - 64, t.getMaxColumns()).getValues();
    var hasValue = below.some(function(row){ return row.some(function(c){ return c !== '' && c !== null; }); });
    if (hasValue) {
      Logger.log('⚠️ 行65以降に値があります。削除を中止。手動で確認してください');
    } else {
      t.deleteRows(65, maxRows - 64);
      Logger.log('✅ 行65以降を削除');
    }
  } else {
    Logger.log('行は既に64以下');
  }
  // 列44(AR)以降を削除 (発注書は AQ=43列まで)
  var maxCols = t.getMaxColumns();
  if (maxCols > 43) {
    t.deleteColumns(44, maxCols - 43);
    Logger.log('✅ 列44(AR)以降を削除');
  } else {
    Logger.log('列は既に43以下');
  }
  Logger.log('トリミング後: ' + t.getMaxRows() + '行 × ' + t.getMaxColumns() + '列');
  Logger.log('→ 次: テンプレシートで Ctrl+P → 向き=縦向き / スケール=ページに合わせる / 余白=狭い を設定');
  Logger.log('   (copyToで作られる発注書シートが設定を引き継ぎ、スプシ印刷も一発になる)');
}

// 列番号(1始まり) → アルファベット (1→A, 27→AA, 43→AQ)
function columnToLetter(col) {
  var letter = '';
  while (col > 0) {
    var mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// ============ ★ デバッグ: 発注書レイアウトの実サイズ・アスペクト比を測定 ============
// GASエディタで「measureOrderLayout」を実行 → 縦向き/横向きどちらが最適か判定
function measureOrderLayout() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!t) { Logger.log('テンプレートが見つかりません'); return; }
  // シートの実サイズを超えないようにクランプ (66行未満のテンプレ対応)
  var maxRows = t.getMaxRows();
  var maxCols = t.getMaxColumns();
  var endRow = Math.min(66, maxRows);
  var endCol = Math.min(43, maxCols);
  var totalWidth = 0, totalHeight = 0;
  for (var c = 1; c <= endCol; c++) totalWidth += t.getColumnWidth(c);
  for (var r = 1; r <= endRow; r++) totalHeight += t.getRowHeight(r);
  var ratio = totalWidth / totalHeight;
  Logger.log('====== 発注書レイアウト実サイズ測定 ======');
  Logger.log('  テンプレ名: [' + t.getName() + ']');
  Logger.log('  シート最大: ' + maxRows + '行 × ' + maxCols + '列');
  Logger.log('  測定範囲: ' + endCol + '列 × ' + endRow + '行');
  Logger.log('  幅: ' + totalWidth + ' px / 高さ: ' + totalHeight + ' px');
  Logger.log('  アスペクト比 W/H = ' + ratio.toFixed(3));
  Logger.log('  A4縦 W/H = 0.707 / A4横 W/H = 1.414');
  var verdict = ratio < 0.85 ? '縦長 → 縦向き(portrait)が最適'
              : (ratio > 1.2 ? '横長 → 横向き(landscape)が最適'
              : 'ほぼ正方形 → どちらの向きでも余白が出る(レイアウト調整推奨)');
  Logger.log('  判定: ' + verdict);
  Logger.log('  発注書の実際の最終行(getLastRow): ' + t.getLastRow() + ' / 最終列(getLastColumn): ' + t.getLastColumn());
  Logger.log('  → range は A1:' + columnToLetter(t.getLastColumn()) + t.getLastRow() + ' が最適');
  Logger.log('====== 完了 ======');
}

// ============ ★ デバッグ: 最新の発注書シートの結合構造と値を確認 ============
// GASエディタで「inspectActualSheet」を選んで実行 → 実行ログで最新の発注書シートの
// 行18-22の値・結合範囲が見える。明細書込みが効かない原因 (結合内側セル等) を特定。
function inspectActualSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  // 発注一覧/見積一覧/テンプレ系を除外して、最新の発注書シートを探す
  var excludeNames = ['発注一覧', '見積一覧', '見積書(テンプレート)', '発注書(テンプレート)', 'テンプレート'];
  var target = null;
  for (var i = sheets.length - 1; i >= 0; i--) {
    var name = sheets[i].getName();
    if (excludeNames.indexOf(name) === -1 && name.indexOf('テンプレ') === -1 && name.indexOf('見積_') !== 0) {
      target = sheets[i];
      break;
    }
  }
  if (!target) { Logger.log('発注書シートが見つかりません'); return; }
  Logger.log('====== 最新発注書シートの構造調査 ======');
  Logger.log('シート名: [' + target.getName() + '] sheetId=' + target.getSheetId());

  // 行18-22 と 50-58 の主要セルの結合範囲と現在の値を出力
  var addrs = [
    'A18','C18','H18','P18','Z18','AB18','AG18','AL18',
    'A19','C19','H19','P19','Z19','AB19','AG19','AL19',
    'A20','C20','H20','P20','Z20','AB20','AG20','AL20',
    'A22','C22','H22',
    // 下半分 (納入先/請求先/納入希望日/現場名)
    'F50','F51','F52','F53','F54','F55','F56','F57',
    'J53','J54','J55',
    'R53','R54','R55',
    'V53','V54','V55',
    'L51','L53','P51'
  ];
  addrs.forEach(function(addr) {
    var cell = target.getRange(addr);
    var merged = cell.getMergedRanges();
    var val = cell.getValue();
    var mergedStr = (merged && merged.length > 0)
      ? merged.map(function(r){ return r.getA1Notation(); }).join(',')
      : 'なし';
    Logger.log('  ' + addr + ' value=[' + val + '] merged=[' + mergedStr + ']');
  });
  // テンプレートシートも同じく出力
  Logger.log('====== テンプレートシートの構造調査 ======');
  var tmpl = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!tmpl) { Logger.log('テンプレートが見つかりません'); return; }
  Logger.log('テンプレ名: [' + tmpl.getName() + ']');
  addrs.forEach(function(addr) {
    var cell = tmpl.getRange(addr);
    var merged = cell.getMergedRanges();
    var val = cell.getValue();
    var mergedStr = (merged && merged.length > 0)
      ? merged.map(function(r){ return r.getA1Notation(); }).join(',')
      : 'なし';
    Logger.log('  ' + addr + ' value=[' + val + '] merged=[' + mergedStr + ']');
  });
  Logger.log('====== 完了 ======');
}

// ============ ★ デバッグ: 過去発注のN列(明細JSON)を読んで実態確認 ============
// GASエディタで「debugLatestOrders」を選んで実行 → 実行ログで最新5件の送信データが見える
function debugLatestOrders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) { Logger.log('発注一覧シートが見つかりません'); return; }
  var lastRow = s.getLastRow();
  Logger.log('====== 発注一覧 最新5件のデバッグ ======');
  Logger.log('総行数: ' + lastRow);
  var startRow = Math.max(2, lastRow - 4);
  for (var r = startRow; r <= lastRow; r++) {
    var row = s.getRange(r, 1, 1, 23).getValues()[0];
    Logger.log('--- 行 ' + r + ' ---');
    Logger.log('  受付日時: ' + row[0]);
    Logger.log('  注文No.: ' + row[1]);
    Logger.log('  仕入先: ' + row[3]);
    Logger.log('  事業所: ' + row[4]);
    Logger.log('  現場名: ' + row[5]);
    Logger.log('  合計金額: ' + row[6]);
    Logger.log('  注文者: ' + row[7]);
    Logger.log('  ID: ' + row[12]);
    Logger.log('  N列(明細JSON): ' + row[13]);
    try {
      var lines = JSON.parse(row[13] || '[]');
      Logger.log('  明細件数: ' + lines.length);
      lines.forEach(function(ln, i) {
        Logger.log('    [' + i + '] maker=[' + ln.maker + '] product=[' + ln.product + '] model=[' + ln.model + '] qty=[' + ln.qty + '] price=[' + ln.price + '] type=[' + ln.type + ']');
      });
    } catch (er) {
      Logger.log('  JSON parse エラー: ' + er.toString());
    }
  }
  Logger.log('====== 完了 ======');
}

// ============ JSON応答ヘルパー ============
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============ GET: 承認/却下 + 見積API ============
function doGet(e) {
  var action = e.parameter.action;
  var id = e.parameter.id;

  // 発注関連API
  if (action === 'listOrders') return jsonResponse(getOrderList());
  if (action === 'cancelOrder') return jsonResponse(cancelOrder(id));
  if (action === 'cancelApprovedOrder') return jsonResponse(cancelApprovedOrder(id, e.parameter.reason));
  if (action === 'markOrderCompleted') return jsonResponse(markOrderCompleted(id));
  if (action === 'hideCompleted') return jsonResponse(hideCompletedSheets());
  if (action === 'showAllSheets') return jsonResponse(showAllSheets());
  if (action === 'getPdf') return jsonResponse(getSheetPdfBase64(e.parameter.gid));
  if (action === 'getPdfById') return jsonResponse(getPdfById(id, e.parameter.type));
  if (action === 'getOrderDetails') return jsonResponse(getOrderDetails(id));
  // 画面UI経由の承認API（パスワード必須）
  if (action === 'approveByUI') return jsonResponse(approveOrderByUI(id, e.parameter.password));
  if (action === 'ensureStockMemo') return jsonResponse(_ensureStockMemoColumnApi(e.parameter.pw));
  if (action === 'backfillStock') return jsonResponse(backfillMissingStock(e.parameter.pw));
  if (action === 'setupTrigger') return jsonResponse(_setupTriggerApi(e.parameter.pw));
  if (action === 'recomputeTotals') return jsonResponse(recomputeAllTotals(e.parameter.pw));
  if (action === 'deleteOrphanTabs') return jsonResponse(deleteOrphanOrderTabs(e.parameter.pw, e.parameter.dry === '1', e.parameter.hidden === '1'));
  if (action === 'deleteAllEstimates') return jsonResponse(deleteAllEstimates(e.parameter.pw, e.parameter.dry === '1'));
  if (action === 'migrateStockSplit') return jsonResponse(migrateStockSplitByBranch(e.parameter.pw, e.parameter.dry === '1'));
  if (action === 'renameOldStock') return jsonResponse(renameOldStockSheet(e.parameter.pw));
  if (action === 'ensureStockDelivery') return jsonResponse(_ensureStockDeliveryColumnApi(e.parameter.pw));
  // 見積関連API (listEstimates / getEstimateData / markTransferred / getEstimateDetails)
  // と一時API hideEstimateAll は 2026-05-12 発注専用化で削除。復元は docs/RESTORE_ESTIMATE.md

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

    // R列 (idx=17): 事務員通知不要フラグ
    var skipPurchaser = String(data[rowIdx-1][17] || '') === 'YES';

    // 承認時の通知: 申請者(注文者)に必ず通知 + 事務員(PURCHASER)にも通知（skipPurchaser=true は除外）
    try { notifyOrderer(id, orderNo, supplier, orderer, total, sheetUrl, '承認済'); } catch(e) { Logger.log('申請者通知エラー: ' + e.toString()); }
    if (!skipPurchaser) {
      try { notifyPurchaser(id, orderNo, supplier, orderer, total, sheetUrl); } catch(e) { Logger.log('事務員通知エラー: ' + e.toString()); }
    }

    var notifyMsg = skipPurchaser ? '申請者に通知しました（事務員通知はスキップ）' : '申請者と事務員に通知しました';
    return HtmlService.createHtmlOutput(resultPage('承認しました',
      '注文No.: ' + orderNo + '<br>仕入先: ' + supplier + '<br>金額: &yen;' + Number(total).toLocaleString() +
      '<br><br>' + notifyMsg + '。', '#188038', sheetUrl));

  } else if (action === 'reject') {
    if (currentStatus !== '申請中') return HtmlService.createHtmlOutput(resultPage('処理済', 'この発注書は既に処理済みです', '#5f6368'));
    applyStatusColor(sheet, rowIdx, '却下');
    // 却下時: 申請者に通知
    try { notifyOrderer(id, orderNo, supplier, orderer, total, sheetUrl, '却下'); } catch(e) { Logger.log('却下通知エラー: ' + e.toString()); }
    return HtmlService.createHtmlOutput(resultPage('却下しました', '注文No.: ' + orderNo + '<br><br>申請者に通知しました。', '#d93025', sheetUrl));
  }

  return HtmlService.createHtmlOutput(resultPage('エラー', '不明なアクション', '#d93025'));
}

// ============ API: 画面UI経由の承認（パスワード必須・JSON応答） ============
// メール承認はパスワード不要（メール到達自体が認証）
// 画面UI承認は誰でもアクセスできる公開ページなのでパスワード必須
function approveOrderByUI(id, password) {
  // パスワード検証（GAS側で必ず実施。クライアント側だけだと開発者ツールで回避可能）
  if (!password) return { success: false, error: 'パスワードが必要です' };
  if (password !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  if (!id) return { success: false, error: 'IDが必要です' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INDEX_SHEET);
  if (!sheet) return { success: false, error: '発注一覧が見つかりません' };

  var data = sheet.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) { rowIdx = i + 1; break; }
  }
  if (rowIdx === -1) return { success: false, error: '該当する発注書が見つかりません' };

  var row = data[rowIdx - 1];
  var currentStatus = row[10];
  if (currentStatus !== '申請中') {
    return { success: false, error: 'この発注書は既に処理済みです（現在: ' + currentStatus + '）' };
  }

  // ステータスを承認済に変更
  applyStatusColor(sheet, rowIdx, '承認済');

  var orderNo = row[1];
  var supplier = row[3];
  var orderer = row[7];
  var total = row[6];
  var approverName = row[9]; // J列: 承認者名
  var sheetUrl = row[11];
  var skipPurchaser = String(row[17] || '') === 'YES'; // R列: 事務員通知不要

  // 発注書シートの承認欄に承認者名を書き込む（既存ロジック流用）
  try { writeApproverToOrderSheet(ss, sheetUrl, approverName); } catch(e) { Logger.log('承認者名書込エラー: ' + e.toString()); }

  // 申請者通知 + 事務員通知（事務員はskipPurchaser=false時のみ）
  try { notifyOrderer(id, orderNo, supplier, orderer, total, sheetUrl, '承認済'); } catch(e) { Logger.log('申請者通知エラー: ' + e.toString()); }
  if (!skipPurchaser) {
    try { notifyPurchaser(id, orderNo, supplier, orderer, total, sheetUrl); } catch(e) { Logger.log('事務員通知エラー: ' + e.toString()); }
  }

  return {
    success: true,
    message: '承認しました',
    orderNo: orderNo,
    supplier: supplier,
    total: total
  };
}

// 結果表示HTML
function resultPage(title, body, color, ssUrl) {
  var link = ssUrl ? '<a href="'+ssUrl+'" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#1a73e8;color:white;border-radius:6px;text-decoration:none;font-weight:bold">スプレッドシートで確認</a>' : '';
  return '<div style="font-family:sans-serif;max-width:500px;margin:40px auto;text-align:center">' +
    '<div style="background:'+color+';color:white;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">'+title+'</h2></div>' +
    '<div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px"><p>'+body+'</p>'+link+'</div></div>';
}

// ★ 2026-06-18: 注文Noを当日内でユニークに採番。提出Noの日付8桁を接頭辞に既存最大連番+1を返す。
function _nextUniqueOrderNo(ss, submittedNo) {
  var prefix = String(submittedNo || '').replace(/[^0-9]/g, '').slice(0, 8);
  if (prefix.length < 8) prefix = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  var s = ss.getSheetByName(INDEX_SHEET);
  var maxSeq = 0;
  if (s && s.getLastRow() > 1) {
    var col = s.getRange(2, 2, s.getLastRow() - 1, 1).getValues();  // B列=注文No
    for (var i = 0; i < col.length; i++) {
      var v = String(col[i][0] || '');
      if (v.indexOf(prefix) === 0) {
        var seq = parseInt(v.slice(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    }
  }
  return prefix + String(maxSeq + 1).padStart(3, '0');
}

// ============ 発注処理 ============
function processOrder(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // ★ 2026-06-18: 注文Noを当日内でユニークに採番(同日2件目→...002)。フロントの暫定001を上書き
  data.orderNo = _nextUniqueOrderNo(ss, data.orderNo);
  var tabName = data.issueDate.replace(/-/g,'') + '_' + data.orderer;
  if (data.siteName) tabName += '_' + data.siteName;

  // ★ 2026-05-27 v82 修正: 画面で選んだ承認者(data.approverEmail)を最優先で使う
  //   旧コードは無条件に固定値(井上)で上書きしていたため、誰を選んでも井上に飛んでいた
  // ★ 2026-06-17: フォールバック前に「承認者が空欄だったか」を記録 (発注権限者の承認スキップ判定に使う)
  var noApproverSelected = !data.approverEmail;
  if (!data.approverEmail) {
    var approver = data.urgent ? APPROVER_URGENT : APPROVER_PASS;
    data.approverName = approver.name;
    data.approverEmail = approver.email;
  }

  var uniqueId = Utilities.getUuid();
  var os = null;
  var sheetUrl = '';

  if (NEW_FLOW) {
    // 個別シート作らない → 一覧のみ
    addToIndex(ss, data, null, uniqueId);
  } else {
    os = createFromTemplate(ss, tabName, data);
    addToIndex(ss, data, os, uniqueId);
    // 見積書から転記された場合、発注シートを見積シートの隣に配置
    if (data.sourceEstimateNo) {
      try {
        var allSheets = ss.getSheets();
        for (var si = 0; si < allSheets.length; si++) {
          if (allSheets[si].getName().indexOf('見積_') === 0 && allSheets[si].getName().indexOf(data.sourceEstimateNo) !== -1) {
            ss.setActiveSheet(os);
            ss.moveActiveSheet(si + 2);
            break;
          }
        }
      } catch(e) {}
    }
    sheetUrl = ss.getUrl() + '#gid=' + os.getSheetId();
  }

  if (data.selfOrder) {
    // ★ 2026-06-03: 営業が自分で発注。承認スキップ＝即発注扱い・メール送信なし
    var sheetS = ss.getSheetByName(INDEX_SHEET);
    applyStatusColor(sheetS, sheetS.getLastRow(), '自己発注');
  } else if (data.urgent) {
    var sheet = ss.getSheetByName(INDEX_SHEET);
    var lr = sheet.getLastRow();
    applyStatusColor(sheet, lr, '緊急承認済');
    sendUrgentEmail(data, os, uniqueId);
  } else if (noApproverSelected && ORDER_AUTHORITY.indexOf(data.orderer) !== -1) {
    // ★ 2026-06-17: 発注権限者が承認者を選ばず送信 → 承認不要。自動で承認済 + 発注依頼を発注者へ
    var sheetA = ss.getSheetByName(INDEX_SHEET);
    var lrA = sheetA.getLastRow();
    applyStatusColor(sheetA, lrA, '承認済');
    sheetA.getRange(lrA, 10).setValue('承認不要(発注権限)');  // J列(10)=承認者欄に明記
    if (!data.skipPurchaserNotify) {
      try { notifyPurchaser(uniqueId, data.orderNo, data.supplier, data.orderer, data.total, sheetUrl); } catch(e) { Logger.log('発注依頼通知エラー(発注権限): ' + e.toString()); }
    }
  } else {
    sendApprovalEmail(data, os, uniqueId);
  }

  return { success: true, message: '発注書を登録しました', orderNo: data.orderNo, orderId: uniqueId, spreadsheetUrl: ss.getUrl(), sheetUrl: sheetUrl };
}

// ============ テンプレートコピー ============
function createFromTemplate(ss, tabName, data) {
  var template = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!template) throw new Error('発注書テンプレートが見つかりません。候補名: ' + PO_TEMPLATE_CANDIDATES.join(' / '));
  Logger.log('発注書テンプレート使用: ' + template.getName());

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
  // ★ 2026-05-27 v79 修正: 仕入先は A10 に書く (A10:H11 結合の左上)
  //   旧 A9 は結合外 (or 結合の上端) で「9行目」に書かれていた
  try { sh.getRange('A10').setValue(data.supplier); } catch(e) {}
  try { sh.getRange('A9').setValue(''); } catch(e) {}  // 旧位置クリア
  sh.getRange('AL12').setValue(data.branch);
  // ★ 2026-05-27 v85: 住所ブロックは枠内の行13-15 (Z13=〒, Z14=住所, Z15=TEL/FAX)
  //   旧 Z12/Z13/Z14 は1行上にズレており、〒が枠外(行12)に出ていた → テンプレと同じ枠内に収める
  try { sh.getRange('Z13').setValue(bi.zip); } catch(e) {}                  // 〒
  try { sh.getRange('Z14').setValue(bi.addr); } catch(e) {}                 // 住所
  try { sh.getRange('Z15').setValue(bi.tel + ' ' + bi.fax); } catch(e) {}   // TEL/FAX
  // 枠外(行12)に出ていた古い〒をクリア
  try { sh.getRange('Z12').setValue(''); } catch(e) {}
  // テンプレに残る古い値クリア (AB列)
  try { sh.getRange('AB13').setValue(''); } catch(e) {}
  try { sh.getRange('AB14').setValue(''); } catch(e) {}
  try { sh.getRange('AB15').setValue(''); } catch(e) {}

  var lines = data.lines || [];
  Logger.log('createFromTemplate 対象シート: [' + sh.getName() + '] sheetId=' + sh.getSheetId());
  Logger.log('createFromTemplate: lines.length=' + lines.length + ', lines=' + JSON.stringify(lines));
  // ★★★ 2026-05-27 v77 重大修正 ★★★
  // テンプレート実構造: ヘッダー=行17-18結合 (A17:B18 等)、明細1件目=行19-20結合 (A19:B20 等)
  // 旧 r = 18 + idx*2 → 行18はヘッダー結合の内側 → setValue が無視されて全部空だった
  // 正解: r = 19 + idx*2 → 各明細行の結合の「左上」セルに書き込む
  function _writeAndVerify(addr, val, label) {
    try {
      sh.getRange(addr).setValue(val);
    } catch (e) {
      Logger.log('  ❌ ' + addr + ' (' + label + ') setValue 例外: ' + e.toString());
    }
  }
  for (var idx = 0; idx < 8; idx++) {
    var r = 19 + idx * 2;  // ★ 18→19 に修正
    var ln = lines[idx];
    var hasData = ln && (ln.maker || ln.product || (ln.qty && ln.qty > 0));
    if (hasData) {
      _writeAndVerify('A'+r, idx+1, 'No');
      _writeAndVerify('C'+r, ln.maker || '', 'maker');
      _writeAndVerify('H'+r, ln.product || '', 'product');
      _writeAndVerify('P'+r, ln.model || '', 'model');
      _writeAndVerify('Z'+r, ln.qty || '', 'qty');
      _writeAndVerify('AB'+r, ln.price || '', 'price');
      _writeAndVerify('AG'+r, (ln.qty && ln.price) ? ln.qty*ln.price : '', 'amount');
      _writeAndVerify('AL'+r, ln.remark || '', 'remark');
      Logger.log('Wrote row ' + r + ': ' + JSON.stringify(ln));
    } else {
      ['A','C','H','P','Z','AB','AG','AL'].forEach(function(c){
        try { sh.getRange(c+r).setValue(''); } catch(e) {}
      });
    }
  }
  // 書き込み後の verify (flush で確実に反映してから読む)
  SpreadsheetApp.flush();
  Logger.log('====== 書き込み後 verify ======');
  for (var idx = 0; idx < Math.min(lines.length, 8); idx++) {
    var r = 19 + idx * 2;  // ★ 18→19 に修正
    ['A','C','H','P','Z','AB','AG','AL'].forEach(function(c){
      var addr = c + r;
      var actual = sh.getRange(addr).getValue();
      Logger.log('  ' + addr + ' actual=[' + actual + ']');
    });
  }
  try { sh.getRange('AG49').setValue(data.total); } catch(e) {}

  // ★★★ 2026-05-27 v78 重大修正 ★★★
  // 明細(r=18→19)と同じく、納入先/請求先/納入希望日/現場名 も全て行が1つ下にズレていた
  // 旧コードは結合の右下セル(行51/53/55)に書いていて Google Sheets に黙って無視されていた
  // 正解: 結合の左上セル = 行52/54/56 に書く
  //   - F52: 納入先 (旧 F51)
  //   - F54: 請求先○ 本社 (旧 F53)
  //   - J54: 請求先○ 福岡店 (旧 J53)
  //   - R54: 納入希望日 月 (旧 R53)
  //   - V54: 納入希望日 日 (旧 V53)
  //   - F56: 現場名 (旧 F55)
  //
  // ◎ 納入先 (52行)
  try { sh.getRange('F52').setValue(data.deliveryPlace || ''); } catch(e) {}
  // 旧位置クリア (テンプレに残った可能性のある古い値消去)
  try { sh.getRange('F51').setValue(''); } catch(e) {}
  try { sh.getRange('L51').setValue(''); } catch(e) {}
  try { sh.getRange('P51').setValue(''); } catch(e) {}

  // ◎ 請求先 (54行) — 本社/福岡店の○マーク (2026-05-27 v81: 飯塚ガスセンターは廃止)
  try { sh.getRange('F54').setValue(data.branch==='本社'?'○':''); } catch(e) {}
  try { sh.getRange('J54').setValue(data.branch==='福岡店'?'○':''); } catch(e) {}
  // 旧位置クリア
  try { sh.getRange('F53').setValue(''); } catch(e) {}
  try { sh.getRange('J53').setValue(''); } catch(e) {}
  try { sh.getRange('L53').setValue(''); } catch(e) {}

  var today = new Date();
  // ◎ 納入希望日 (54行) — 月=R54、日=V54
  if (data.deliveryDate) {
    var dParts = String(data.deliveryDate).split('-');
    if (dParts.length === 3) {
      try { sh.getRange('R54').setValue(parseInt(dParts[1])); } catch(e) {}
      try { sh.getRange('V54').setValue(parseInt(dParts[2])); } catch(e) {}
    }
  } else {
    try { sh.getRange('R54').setValue(''); } catch(e) {}
    try { sh.getRange('V54').setValue(''); } catch(e) {}
  }
  // 旧位置クリア (テンプレに固定値 4/15 が残っていた可能性)
  try { sh.getRange('R53').setValue(''); } catch(e) {}
  try { sh.getRange('V53').setValue(''); } catch(e) {}

  // ◎ 現場名 (56行) — F56:AQ57 結合の左上 F56
  try { sh.getRange('F56').setValue(data.siteName||''); } catch(e) {}
  // 旧位置クリア (テンプレに固定値 KKK が残っていた可能性)
  try { sh.getRange('F55').setValue(''); } catch(e) {}
  try { sh.getRange('D55').setValue(''); } catch(e) {}
  try { sh.getRange('D56').setValue(''); } catch(e) {}
  // 特記事項(C59): 2026-06-03 申請フォームの特記事項(specialNotes)を発注書に記載。
  //   data.notes には二重発注検知用の転記マーカーが混入するため、印刷用はクリーンな specialNotes を使う。
  //   2026-06-04 修正: 旧 C58 は特記事項ボックス(結合 C59:AE64)の1行上の非結合セルで、値が枠外上にずれて表示されていた(v78 +1行ずれ未適用)。
  //   実測(debugNotesRegion)でボックス左上が C59 と確定 → C59 に書き込む。念のため旧位置 C58 はクリア。
  try { sh.getRange('C59').setValue(data.specialNotes || ''); } catch(e) {}
  try { sh.getRange('C58').setValue(''); } catch(e) {}
  sh.getRange('X62').setValue(today.getMonth()+1);
  sh.getRange('AA62').setValue(today.getDate());
  // ★ 2026-05-27 v82: 注文者は AJ61 (結合左上)。旧 AJ60 は結合外で表示されず空欄だった
  try { sh.getRange('AJ61').setValue(data.orderer); } catch(e) {}
  try { sh.getRange('AJ60').setValue(''); } catch(e) {}  // 旧位置クリア
  // ★ 2026-05-27 v95: AF66(行66)への書き込みは廃止。
  //   行66は発注書の枠外でPDF範囲(A1:AQ64)にも含まれず実質非表示だった。
  //   かつ行66書き込みはトリミング(64行化)後にシートを自動拡張してしまうため削除。
  //   緊急の識別は発注一覧I列「緊急」+ 承認メール件名【緊急】で行う。

  return sh;
}

function getBranchInfo(b) {
  var m = {
    '本社':{zip:'〒820-0081',addr:'福岡県飯塚市枝国507番地',tel:'TEL：(0948)22-1234',fax:'FAX：(0948)22-5777'},
    '福岡店':{zip:'〒814-0174',addr:'福岡市早良区田隈1-29-21 アイプロビル1F',tel:'TEL：(092)861-2071',fax:'FAX：(092)861-4175'},
    '飯塚ガスセンター':{zip:'〒820-0073',addr:'福岡県飯塚市平恒477-7',tel:'TEL：(0948)22-3611',fax:'FAX：(0948)22-9302'}
  };
  return m[b]||m['本社'];
}

// ============ 一覧シート ============
// ★ 2026-05-27 v83: 明細から経理向けフラグを計算
//   X列(高額単価): いずれかの商品の単価が10万円超なら「◎」
//   Y列(無償):     いずれかの商品の形態が M(無償) なら「M」
// 目的: 経理が請求書を1枚ずつ開かなくても、一覧で無償・高額発注を判別できる
function _calcOrderFlags(lines) {
  lines = lines || [];
  // ★ 2026-05-29: 10万「超」(>100000)だと10万ちょうどが除外されるため「10万以上」(>=100000)に変更
  var hasHigh = lines.some(function(ln){ return Number(ln.price) >= 100000; });
  var hasFree = lines.some(function(ln){ return String(ln.type) === 'M'; });
  return {
    highPrice: hasHigh ? '◎' : '',
    free: hasFree ? 'M' : ''
  };
}

// ★ 2026-05-29: ヘッダー名で列番号を探す (列削除・移動に強い・固定列番号の代替)
function _findColumnByHeader(s, headerName) {
  var lastCol = s.getLastColumn();
  if (lastCol < 1) return -1;
  var headers = s.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var c = 0; c < headers.length; c++) {
    if (String(headers[c]).trim() === headerName) return c + 1;  // 1始まり
  }
  return -1;
}

// ヘッダー名で列を探してフラグ値(◎/M)を書き込む (色付き)。列削除・移動に強い
function _writeFlagByHeader(s, row, headerName, value, color) {
  var col = _findColumnByHeader(s, headerName);
  if (col <= 0) return;  // ヘッダーが見つからなければ何もしない(壊さない)
  var cell = s.getRange(row, col);
  cell.setValue(value || '');
  if (value) cell.setFontColor(color).setFontWeight('bold').setHorizontalAlignment('center');
}

function addToIndex(ss, data, os, uniqueId) {
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) { initSheet(); s = ss.getSheetByName(INDEX_SHEET); }
  _compactSheetByKey(s, 2);  // ★ 2026-05-29: 追記前に空行を自動削除して上詰め(新規発注が常にデータ直後に追加される)
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  var url = os ? (ss.getUrl() + '#gid=' + os.getSheetId()) : '';
  var linesJson = JSON.stringify(data.lines || []);
  var flags = _calcOrderFlags(data.lines);  // U=高額単価 / V=無償 フラグ
  // 16列(A-P) + Q=発注完了日 + R=事務員通知不要 + S=入荷チェック + T=保安費 + U=高額単価◎ + V=無償M + W=顧客設備
  // ★ 2026-05-29: appendRow は基本情報 A-R(18列)のみ。高額単価・無償はヘッダー名で別途書く
  //   (列を削除・移動しても固定列番号とズレないようにするため)
  s.appendRow([
    now, data.orderNo, data.issueDate, data.supplier, data.branch, data.siteName||'',
    data.total, data.orderer, data.urgent?'緊急':'PASS', data.approverName, '申請中',
    url, uniqueId, linesJson, data.notes || '', now,
    '',  // Q: 発注完了日
    data.skipPurchaserNotify ? 'YES' : ''  // R: 事務員通知不要フラグ
  ]);
  var lr = s.getLastRow();
  s.getRange(lr, 7).setNumberFormat('#,##0');
  applyStatusColor(s, lr, '申請中');
  if (data.urgent) s.getRange(lr, 9).setFontColor('#d93025').setFontWeight('bold');
  // ★ 高額単価(◎)・無償(M) フラグはヘッダー名で列を探して書く (列削除・移動に強い)
  _writeFlagByHeader(s, lr, '高額単価(10万超)', flags.highPrice, '#d93025');
  _writeFlagByHeader(s, lr, '無償(M)', flags.free, '#1a73e8');
  // ★ 2026-05-29: 発注者を記録 (ヘッダー名「発注者」の列。無ければ末尾に自動作成)
  var colOP = _findColumnByHeader(s, '発注者');
  if (colOP <= 0) {
    colOP = s.getLastColumn() + 1;
    s.getRange(1, colOP).setValue('発注者').setFontWeight('bold').setBackground('#4285f4').setFontColor('#fff');
  }
  if (data.orderPersonName) s.getRange(lr, colOP).setValue(data.orderPersonName);
  // ★ 2026-06-04: 在庫管理への表示タイミング(井上さん指示)
  //   - 即発注(緊急承認済/自己発注): もう発注済なので申請時(ここ)で在庫管理に出す
  //   - 通常発注: 申請中/承認済では出さず「発注完了(markOrderCompleted)」時に出す
  //     (申請中で在庫管理に出ると事務員が「発注済だが未着」と誤認するため)
  //   発注一覧タブは従来どおり申請段階から表示。
  if (data.selfOrder || data.urgent) {
    try { addToStockSheet(ss, data, url); } catch(e) { Logger.log('在庫管理追記エラー(即発注): ' + e.toString()); }
  }
}

// ============ ★ 在庫管理シート (2026-05-29) ============
// 発注を「商品1行ずつ」に展開。在庫管理担当が 分類列(P) をプルダウンで選び経理へ渡す。
function initStockSheet() {  // ★ 2026-08-21: 拠点別2タブ(本社/福岡)を両方初期化
  initStockSheetNamed(STOCK_SHEET_HONSHA);
  initStockSheetNamed(STOCK_SHEET_FUKUOKA);
}
// 指定名の在庫管理タブを初期化(拠点別対応)
function initStockSheetNamed(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);
  // ★ 2026-06-04: 18列構成 (無償Nの右に「ステータス」O列追加・分類P/入庫済みQ/シートURLR に移動)
  var headers = ['受付日時','注文No.','仕入先','事業所','現場名','注文者','メーカー','商品名','型式','数量','単価','金額','備考','無償(M)','ステータス','分類','納品予定日','入庫済み','メモ','シートURL'];
  s.getRange(1,1,1,headers.length).setValues([headers]);
  s.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
  s.setFrozenRows(1);
  s.setColumnWidth(7, 130);   // メーカー
  s.setColumnWidth(8, 160);   // 商品名
  s.setColumnWidth(13, 120);  // 備考
  s.setColumnWidth(14, 80);   // 無償(M)
  s.setColumnWidth(15, 110);  // ステータス (緊急承認済/自己発注)
  s.setColumnWidth(16, 130);  // 分類
  s.setColumnWidth(17, 110);  // 納品予定日 (手動入力)
  s.setColumnWidth(18, 90);   // 入庫済み (チェックボックス)
  s.setColumnWidth(19, 240);  // メモ (手動入力)
  s.setColumnWidth(20, 220);  // シートURL
  s.getRange(1, 14).setBackground('#1a73e8').setFontColor('#fff'); // 無償(M)ヘッダー青
  s.getRange(1, 15).setBackground('#9334e6').setFontColor('#fff'); // ステータスヘッダー紫
  s.getRange(1, 16).setBackground('#fbbc04').setFontColor('#000'); // 分類ヘッダー黄
  s.getRange(2, 14, 1000, 1).clearDataValidations();  // 無償列はプルダウンなし
  s.getRange(2, 15, 1000, 1).clearDataValidations();  // ステータス列はプルダウンなし
  applyStockCategoryValidation(s);
  applyStockCheckboxValidation(s);
  Logger.log('在庫管理シート初期化完了 (19列)');
}

// ★ 2026-06-11: 在庫管理に「メモ」列(手動入力・R=18)が無ければ挿入。旧シートURL(18)はS(19)へ。冪等。
//   井上さん依頼「入庫済みの真横に手動メモ列」。全書込経路の冒頭で呼び、列構造を保証する。
function _ensureStockMemoColumn(s) {
  if (!s) return;
  var lastCol = s.getLastColumn();
  if (lastCol < 1) return;
  var headers = s.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf('メモ') !== -1) return;  // 既にメモ列あり=何もしない
  s.insertColumnAfter(17);  // 入庫済み(17)の右に挿入 → 旧シートURL(18)はS(19)へ自動シフト
  s.getRange(1, 18).setValue('メモ').setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
  s.setColumnWidth(18, 240);
  s.getRange(2, 18, 1000, 1).clearDataValidations();  // メモは自由入力(プルダウン/チェックなし)
  Logger.log('在庫管理にメモ列(R=18)挿入・シートURLはS=19へ移動');
}

// 既存シートにメモ列を今すぐ追加するAPI (doGet ?action=ensureStockMemo&pw=... から呼ぶ)
function _ensureStockMemoColumnApi(pw) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(STOCK_SHEET);
  if (!s) return { success: false, error: '在庫管理シートがありません' };
  var before = s.getLastColumn();
  _ensureStockMemoColumn(s);
  return { success: true, colsBefore: before, colsAfter: s.getLastColumn(), memoCol: _findColumnByHeader(s, 'メモ'), urlCol: _findColumnByHeader(s, 'シートURL') };
}

// ★ 2026-06-16: 在庫管理に「納品予定日」列(手動入力)を 分類 の右に挿入。入庫済み/メモ/シートURLは右へシフト。冪等。
//   井上さん依頼「分類と入庫済みの間に納品予定日」。全書込経路の冒頭で呼び列構造を保証。
function _ensureStockDeliveryColumn(s) {
  if (!s) return;
  var lastCol = s.getLastColumn();
  if (lastCol < 1) return;
  var headers = s.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf('納品予定日') !== -1) return;  // 既にあり
  var catCol = headers.indexOf('分類');               // 0始まり
  if (catCol === -1) return;                          // 分類が無い=想定外、触らない
  s.insertColumnAfter(catCol + 1);                    // 分類(1始まり catCol+1)の右に挿入
  var nc = catCol + 2;                                // 新「納品予定日」列(1始まり)
  s.getRange(1, nc).setValue('納品予定日').setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
  s.setColumnWidth(nc, 110);
  s.getRange(2, nc, 1000, 1).clearDataValidations();  // 分類のプルダウンを継承しないようクリア
  s.getRange(2, nc, 1000, 1).clearContent();          // 継承した値も消す(FALSE/残骸防止)
  Logger.log('在庫管理に納品予定日列を分類の右に挿入');
}

// 既存シートに納品予定日列を追加 + メモ列のFALSE残骸を一掃 (doGet ?action=ensureStockDelivery&pw=...)
function _ensureStockDeliveryColumnApi(pw) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(STOCK_SHEET);
  if (!s) return { success: false, error: '在庫管理シートがありません' };
  var before = s.getLastColumn();
  _ensureStockDeliveryColumn(s);
  // ★ メモ列のFALSE残骸を一掃(insertColumnAfter時にチェックボックス値を継承していた分)
  var memoCol = _findColumnByHeader(s, 'メモ');
  var cleared = 0;
  if (memoCol > 0 && s.getLastRow() > 1) {
    var rng = s.getRange(2, memoCol, s.getLastRow() - 1, 1);
    rng.clearDataValidations();
    var vals = rng.getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i][0];
      if (v === false || v === true || v === 'FALSE' || v === 'TRUE') { vals[i][0] = ''; cleared++; }
    }
    rng.setValues(vals);
  }
  return { success: true, colsBefore: before, colsAfter: s.getLastColumn(),
    deliveryCol: _findColumnByHeader(s, '納品予定日'), categoryCol: _findColumnByHeader(s, '分類'),
    checkCol: _findColumnByHeader(s, '入庫済み'), memoCol: memoCol, urlCol: _findColumnByHeader(s, 'シートURL'),
    memoFalseCleared: cleared };
}

// 分類列(P=16)に4択プルダウンを適用
function applyStockCategoryValidation(s) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STOCK_CATEGORIES, true)
    .setAllowInvalid(false)
    .build();
  s.getRange(2, 16, 1000, 1).setDataValidation(rule);  // 分類列 P(16)
}

// ★ 2026-05-31: 入庫済み列(Q=17)にチェックボックスを適用
function applyStockCheckboxValidation(s) {
  var rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  s.getRange(2, 18, 1000, 1).setDataValidation(rule);  // 入庫済み列(18)
}

// 発注1件の商品を在庫管理シートに追記 (addToIndex から呼ばれる)
function addToStockSheet(ss, data, sheetUrl) {
  var s = _getStockSheet(ss, data.branch);  // ★ 2026-08-21: 事業所で拠点別タブ(本社/福岡)に振り分け
  _ensureStockMemoColumn(s);  // メモ列が無ければ挿入してから書く (2026-06-11)
  _ensureStockDeliveryColumn(s);  // 納品予定日列が無ければ挿入してから書く (2026-06-16)
  // ★ 2026-06-04: 同一注文No が既に在庫管理にあれば二重追加しない(移行期・発注完了の再クリック対策)
  var _ex = s.getDataRange().getValues();
  for (var _ei = 1; _ei < _ex.length; _ei++) {
    if (String(_ex[_ei][1]) === String(data.orderNo)) { Logger.log('在庫管理: 注文No ' + data.orderNo + ' は既存のためスキップ'); return; }
  }
  _compactSheetByKey(s, 2);  // ★ 2026-05-29: 追記前に空行を自動削除して上詰め
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  // ★ 2026-06-04: ステータス(O列) = 緊急承認/自己発注のときだけ記載・通常発注は空欄
  var stockStatus = data.selfOrder ? '承認スキップ' : (data.urgent ? '緊急承認済' : '');
  var lines = data.lines || [];
  var rows = [];
  lines.forEach(function(ln) {
    if (ln && (ln.maker || ln.product || (ln.qty && ln.qty > 0))) {
      rows.push([
        now, data.orderNo, data.supplier, data.branch, data.siteName||'', data.orderer,
        ln.maker||'', ln.product||'', ln.model||'', ln.qty||'', ln.price||'',
        (ln.qty && ln.price) ? ln.qty*ln.price : '', ln.remark||'',
        (ln.type === 'M') ? 'M' : '',  // N: 無償(M)
        stockStatus,                   // O: ステータス
        '',                            // 分類(プルダウン)
        '',                            // 納品予定日 (手動入力)
        false,                         // 入庫済み (チェックボックス初期OFF)
        '',                            // メモ (手動入力・自動処理は触らない)
        sheetUrl||''                   // シートURL
      ]);
    }
  });
  if (rows.length > 0) {
    var startRow = s.getLastRow() + 1;
    s.getRange(startRow, 1, rows.length, 20).setValues(rows);
    s.getRange(startRow, 11, rows.length, 2).setNumberFormat('#,##0'); // 単価・金額
    // 無償(M)は N列を青太字 / ステータスは緊急=赤・自己発注=紫で目立たせる
    for (var ri = 0; ri < rows.length; ri++) {
      if (rows[ri][13] === 'M') s.getRange(startRow + ri, 14).setFontColor('#1a73e8').setFontWeight('bold').setHorizontalAlignment('center');
      if (rows[ri][14] === '緊急承認済') s.getRange(startRow + ri, 15).setFontColor('#d93025').setFontWeight('bold');
      else if (rows[ri][14] === '自己発注' || rows[ri][14] === '営業自己発注') s.getRange(startRow + ri, 15).setFontColor('#6a1b9a').setFontWeight('bold');
    }
    applyStockCategoryValidation(s);
    applyStockCheckboxValidation(s);
  }
}

// ★ 2026-06-30: 改名で取りこぼした「発注済だが在庫管理に無い」発注を再展開(冪等)。
//   既存行は addToStockSheet の注文No重複排除でそのまま保持(分類/入庫済み入力も維持)。
//   doGet ?action=backfillStock&pw=... から実行。承認済(未発注完了)は対象外=設計どおり。
function backfillMissingStock(pw) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: false, error: '発注一覧がありません' };
  var data = s.getDataRange().getValues();
  var STOCK_DONE = { '発注済': 1, '緊急承認済': 1, '自己発注': 1, '営業自己発注': 1 };
  var attempted = [];
  for (var i = 1; i < data.length; i++) {
    var status = String(data[i][10] || '');
    if (!STOCK_DONE[status]) continue;
    var reconLines = [];
    try { reconLines = JSON.parse(data[i][13] || '[]'); } catch(e2) {}
    var reconData = {
      orderNo: data[i][1], supplier: data[i][3], branch: data[i][4],
      siteName: data[i][5], orderer: data[i][7],
      urgent: (String(data[i][8]) === '緊急'),
      selfOrder: (status === '自己発注' || status === '営業自己発注'),
      lines: reconLines
    };
    try {
      addToStockSheet(ss, reconData, data[i][11] || '');  // 注文No重複は内部スキップ
      attempted.push(String(data[i][1]));
    } catch(e) { Logger.log('backfill エラー No.' + data[i][1] + ': ' + e.toString()); }
  }
  return { success: true, message: 'backfill完了(注文No重複は内部スキップ)', attemptedOrders: attempted, attemptedCount: attempted.length };
}

// ★ 2026-06-30: 編集トリガー(onEditInstallable)を有効化/再設定。doGet ?action=setupTrigger&pw=...
function _setupTriggerApi(pw) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  try {
    setupEditTrigger();
    var n = ScriptApp.getProjectTriggers().filter(function(t){ return t.getHandlerFunction() === 'onEditInstallable'; }).length;
    return { success: true, message: '編集トリガー設定完了', onEditInstallableTriggers: n };
  } catch (e) { return { success: false, error: e.toString() }; }
}

// ★ 2026-06-30: 在庫管理の金額合計を全注文Noぶん発注一覧の合計金額(G)へ再集計(>0のみ・空は保持)。
//   onEditが取りこぼした場合や、過去入力分の一括同期に。doGet ?action=recomputeTotals&pw=...
function recomputeAllTotals(pw) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (!idx) return { success: false, error: 'シートがありません' };
  var sums = {};
  _existingStockSheets(ss).forEach(function (stock) {  // ★ 2026-08-21: 拠点別両タブを合算
    var sv = stock.getDataRange().getValues();
    for (var i = 1; i < sv.length; i++) {
      var no = String(sv[i][1] || '').trim(); if (!no) continue;
      sums[no] = (sums[no] || 0) + _stockNum(sv[i][11]);
    }
  });
  var iv = idx.getDataRange().getValues();
  var updated = [];
  for (var j = 1; j < iv.length; j++) {
    var no = String(iv[j][1] || '').trim();
    if (sums.hasOwnProperty(no) && sums[no] > 0) {
      idx.getRange(j + 1, 7).setValue(sums[no]).setNumberFormat('#,##0');
      updated.push(no);
    }
  }
  return { success: true, message: '合計金額 再集計完了', updatedOrders: updated, updatedCount: updated.length };
}

// ★ 2026-08-21: 旧「在庫管理」の全行を事業所で本社/福岡タブに振り分けてコピー(全列保持・冪等)。
//   doGet ?action=migrateStockSplit&pw=...&dry=1(プレビュー)/dry=0(実行)。移行後は renameOldStock で旧タブ退避。
function migrateStockSplitByBranch(pw, dryRun) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var old = ss.getSheetByName(STOCK_SHEET);
  if (!old) return { success: false, error: '旧「在庫管理」タブがありません(移行済みの可能性)' };
  initStockSheetNamed(STOCK_SHEET_HONSHA);
  initStockSheetNamed(STOCK_SHEET_FUKUOKA);
  var honsha = ss.getSheetByName(STOCK_SHEET_HONSHA);
  var fukuoka = ss.getSheetByName(STOCK_SHEET_FUKUOKA);
  function keyset(sheet) {
    var set = {}, v = sheet.getDataRange().getValues();
    for (var i = 1; i < v.length; i++) {
      if (!String(v[i][1] || '').trim() && !String(v[i][7] || '').trim()) continue;
      set[[v[i][0], v[i][1], v[i][7]].join('|')] = 1;  // 受付日時|注文No|商品名
    }
    return set;
  }
  var kH = keyset(honsha), kF = keyset(fukuoka);
  var ov = old.getDataRange().getValues();
  var toH = [], toF = [];
  for (var i = 1; i < ov.length; i++) {
    var r = ov[i];
    if (!String(r[1] || '').trim() && !String(r[7] || '').trim()) continue;  // 空行スキップ
    var key = [r[0], r[1], r[7]].join('|');
    var row20 = r.slice(0, 20); while (row20.length < 20) row20.push('');
    // ★ 同一移行内では重複排除しない(同一発注の同名明細を潰さない)。キーは【移行前の】ターゲットにある分だけスキップ=再実行時の二重防止のみ。
    if (String(r[3] || '').trim() === '福岡店') { if (!kF[key]) toF.push(row20); }
    else { if (!kH[key]) toH.push(row20); }  // 本社 or 不明→本社
  }
  if (!dryRun) {
    if (toH.length) {
      var sh = honsha.getLastRow() + 1;
      honsha.getRange(sh, 1, toH.length, 20).setValues(toH);
      honsha.getRange(sh, 11, toH.length, 2).setNumberFormat('#,##0');
    }
    if (toF.length) {
      var sf = fukuoka.getLastRow() + 1;
      fukuoka.getRange(sf, 1, toF.length, 20).setValues(toF);
      fukuoka.getRange(sf, 11, toF.length, 2).setNumberFormat('#,##0');
    }
    applyStockCategoryValidation(honsha); applyStockCheckboxValidation(honsha);
    applyStockCategoryValidation(fukuoka); applyStockCheckboxValidation(fukuoka);
  }
  return { success: true, dryRun: !!dryRun, movedHonsha: toH.length, movedFukuoka: toF.length,
           note: dryRun ? 'プレビュー(未書込)' : '移行完了。確認後 renameOldStock で旧タブ退避を' };
}

// ★ 2026-08-21: 移行確認後、旧「在庫管理」→「在庫管理_旧」にリネームして退避。doGet ?action=renameOldStock&pw=...
function renameOldStockSheet(pw) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var old = ss.getSheetByName(STOCK_SHEET);
  if (!old) return { success: false, error: '「在庫管理」タブがありません' };
  if (ss.getSheetByName('在庫管理_旧')) return { success: false, error: '「在庫管理_旧」が既に存在します' };
  old.setName('在庫管理_旧');
  return { success: true, message: '在庫管理 → 在庫管理_旧 にリネームしました' };
}

// ★ 2026-06-30: 発注一覧に紐づかない(=削除済み発注の)発注書タブを一括削除。
//   除外: 発注一覧/在庫管理/入庫管理/見積一覧・テンプレ系・見積_系・現存発注のタブ。日付(YYYYMMDD_)タブのみ対象。
//   doGet ?action=deleteOrphanTabs&pw=...&dry=1(プレビュー) / dry=0(実削除)
function deleteOrphanOrderTabs(pw, dryRun, hiddenOnly) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (!idx) return { success: false, error: '発注一覧がありません' };
  var iv = idx.getDataRange().getValues();
  var liveGids = {};
  for (var i = 1; i < iv.length; i++) {
    var m = String(iv[i][11] || '').match(/gid=(\d+)/);
    if (m) liveGids[m[1]] = true;
  }
  var KEEP = { '発注一覧': 1, '在庫管理': 1, '在庫管理_本社': 1, '在庫管理_福岡': 1, '在庫管理_旧': 1, '入庫管理': 1, '見積一覧': 1 };
  try { ss.setActiveSheet(idx); } catch (e) {}
  var targetSheets = [], targetNames = [];
  var sheets = ss.getSheets();
  for (var k = 0; k < sheets.length; k++) {
    var sh = sheets[k], name = sh.getName(), gid = String(sh.getSheetId());
    if (KEEP[name]) continue;
    if (name.indexOf('テンプレ') !== -1) continue;   // 発注書/見積書テンプレート系は除外
    if (name.indexOf('見積') === 0) continue;         // 見積_/見積一覧 等は除外
    if (!/^\d{8}_/.test(name)) continue;              // 日付つき発注書タブのみ対象
    if (liveGids[gid]) continue;                      // 現存発注=残す
    if (hiddenOnly && !sh.isSheetHidden()) continue;  // 非表示のみ対象(表示中タブは残す)
    targetSheets.push(sh); targetNames.push(name);
  }
  var done = [];
  if (!dryRun) {
    for (var t = 0; t < targetSheets.length; t++) {
      try { ss.deleteSheet(targetSheets[t]); done.push(targetNames[t]); } catch (e) { Logger.log('タブ削除失敗 ' + targetNames[t] + ': ' + e.toString()); }
    }
  }
  return { success: true, dryRun: !!dryRun, count: targetNames.length, tabs: targetNames, deletedCount: done.length };
}

// ★ 2026-06-30: 見積タブ(見積_*)を全削除 + 見積一覧のデータ行を全クリア(ヘッダー1行目は残す)。井上さん指示=見積リセット。
//   doGet ?action=deleteAllEstimates&pw=...&dry=1(プレビュー) / dry=0(実削除)
function deleteAllEstimates(pw, dryRun) {
  if (pw !== APPROVAL_PASSWORD) return { success: false, error: 'パスワードが違います' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try { ss.setActiveSheet(ss.getSheetByName(INDEX_SHEET)); } catch (e) {}
  var sheets = ss.getSheets();
  var tabs = [];
  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    if (nm.indexOf('見積_') === 0) {  // 見積_YYYYMMDD_... のみ(見積書テンプレ・見積一覧は除外)
      tabs.push(nm);
      if (!dryRun) { try { ss.deleteSheet(sheets[i]); } catch (e2) { Logger.log('見積タブ削除失敗 ' + nm + ': ' + e2); } }
    }
  }
  var clearedRows = 0;
  var est = ss.getSheetByName(EST_INDEX_SHEET);
  if (est) {
    var lastRow = est.getLastRow();
    if (lastRow > 1) {
      clearedRows = lastRow - 1;
      if (!dryRun) est.deleteRows(2, lastRow - 1);
    }
  }
  return { success: true, dryRun: !!dryRun, tabs: tabs, deletedTabCount: tabs.length, clearedEstimateRows: clearedRows };
}

// ★ 既存の全発注を在庫管理シートに一括展開 (初回 or 再構築用・GASエディタで実行)
// ⚠️ 既存の 分類・入庫済み 入力は消える。初回構築時のみ実行すること
//   (ステータス列を「足すだけ」なら rebuild ではなく migrateStockAddStatusColumn を使う=入力保持)
function rebuildStockSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (!idx) { Logger.log('発注一覧シートがありません'); return; }
  // ヘッダー・列幅・プルダウンを最新化 (既存シートでもヘッダーを16列に上書き)
  initStockSheet();
  var s = ss.getSheetByName(STOCK_SHEET);
  // 既存データ(ヘッダー除く)をクリア (19列)
  if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow()-1, 20).clearContent();
  var data = idx.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    // ★ 2026-06-04: ステータス = K列(11)が緊急承認済/自己発注、または I列(9)='緊急'(作成時フラグ)なら記載
    var st10 = String(row[10]||'');
    var rowStatus = (st10 === '緊急承認済') ? st10 : ((st10 === '自己発注' || st10 === '営業自己発注') ? '承認スキップ' : (String(row[8]||'') === '緊急' ? '緊急承認済' : ''));
    var lines = [];
    try { lines = JSON.parse(row[13] || '[]'); } catch(e) {}
    lines.forEach(function(ln) {
      if (ln && (ln.maker || ln.product || (ln.qty && ln.qty > 0))) {
        rows.push([
          row[0], row[1], row[3], row[4], row[5]||'', row[7],   // 受付日時/注文No/仕入先/事業所/現場名/注文者
          ln.maker||'', ln.product||'', ln.model||'', ln.qty||'', ln.price||'',
          (ln.qty && ln.price) ? ln.qty*ln.price : '', ln.remark||'',
          (ln.type === 'M') ? 'M' : '',  // N: 無償(M)
          rowStatus,                     // O: ステータス
          '',                            // 分類(空)
          '',                            // 納品予定日 (rebuildは手動入力を消去)
          false,                         // 入庫済み (チェックボックス初期OFF)
          '',                            // メモ (rebuildは手動メモを消去=分類/入庫と同様)
          row[11]||''                    // シートURL
        ]);
      }
    });
  }
  if (rows.length > 0) {
    s.getRange(2, 1, rows.length, 20).setValues(rows);
    s.getRange(2, 11, rows.length, 2).setNumberFormat('#,##0');
    // 無償(M)は N列青太字 / ステータスは緊急=赤・自己発注=紫
    for (var ri = 0; ri < rows.length; ri++) {
      if (rows[ri][13] === 'M') s.getRange(ri+2, 14).setFontColor('#1a73e8').setFontWeight('bold').setHorizontalAlignment('center');
      if (rows[ri][14] === '緊急承認済') s.getRange(ri+2, 15).setFontColor('#d93025').setFontWeight('bold');
      else if (rows[ri][14] === '自己発注' || rows[ri][14] === '営業自己発注') s.getRange(ri+2, 15).setFontColor('#6a1b9a').setFontWeight('bold');
    }
    applyStockCategoryValidation(s);
    applyStockCheckboxValidation(s);
  }
  Logger.log('在庫管理シート再構築完了: ' + rows.length + ' 商品行');
}

// ★ 2026-06-04: 既存の在庫管理シートに「ステータス」列(O=15)を非破壊で挿入するマイグレーション
//   無償(N=14)の右に1列挿入 → 分類/入庫済み/シートURL は自動的に右へシフト(入力データ・チェック保持)。
//   既存行は発注一覧の作成時情報(K=緊急承認済/自己発注 or I=緊急)から遡及記入。
//   冪等: 既に O列(15)が「ステータス」なら何もしない。GASエディタで一度だけ実行する。
function migrateStockAddStatusColumn() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(STOCK_SHEET);
  if (!s) { Logger.log('在庫管理シートなし。initStockSheet/rebuildStockSheet で作成してください'); return; }
  var h15 = String(s.getRange(1, 15).getValue() || '');
  if (h15 === 'ステータス') { Logger.log('✅ 既にステータス列あり (移行不要)'); return; }
  if (h15 !== '分類') {
    Logger.log('⚠️ O列(15)が想定(「分類」)と違います: 実際["'+h15+'"]。レイアウト破損を避けるため中止。手動確認してください');
    return;
  }
  // 無償(N=14)の右に空列を挿入 → 分類→16 / 入庫済み→17 / シートURL→18 にシフト(データ・書式・入力規則ごと移動)
  s.insertColumnAfter(14);
  // 新O列(15)のヘッダー・書式・幅
  s.getRange(1, 15).setValue('ステータス').setFontWeight('bold').setBackground('#9334e6').setFontColor('#fff');
  s.setColumnWidth(15, 110);
  s.getRange(2, 15, Math.max(s.getMaxRows()-1,1), 1).clearDataValidations(); // ステータス列はプルダウンなし
  // 発注一覧から 注文No → ステータス のマップを作成
  var idx = ss.getSheetByName(INDEX_SHEET);
  var statusByOrderNo = {};
  if (idx && idx.getLastRow() > 1) {
    var idata = idx.getDataRange().getValues();
    for (var i = 1; i < idata.length; i++) {
      var no = String(idata[i][1] || ''); if (!no) continue;
      var k = String(idata[i][10] || ''), iflag = String(idata[i][8] || '');
      statusByOrderNo[no] = (k === '緊急承認済') ? k : ((k === '自己発注' || k === '営業自己発注') ? '承認スキップ' : (iflag === '緊急' ? '緊急承認済' : ''));
    }
  }
  // 既存行に遡及記入 (B列=注文No で照合)
  var last = s.getLastRow();
  if (last > 1) {
    var noCol = s.getRange(2, 2, last - 1, 1).getValues();   // B列 注文No
    var out = [];
    for (var r = 0; r < noCol.length; r++) {
      var no2 = String(noCol[r][0] || '');
      out.push([ statusByOrderNo.hasOwnProperty(no2) ? statusByOrderNo[no2] : '' ]);
    }
    s.getRange(2, 15, out.length, 1).setValues(out);
    for (var rr = 0; rr < out.length; rr++) {
      if (out[rr][0] === '緊急承認済') s.getRange(rr+2, 15).setFontColor('#d93025').setFontWeight('bold');
      else if (out[rr][0] === '自己発注' || out[rr][0] === '営業自己発注') s.getRange(rr+2, 15).setFontColor('#6a1b9a').setFontWeight('bold');
    }
  }
  // 入力規則を新しい列位置で再適用 (念のため): 分類→16 / 入庫済み→17
  applyStockCategoryValidation(s);
  applyStockCheckboxValidation(s);
  Logger.log('✅ ステータス列(O=15)を挿入し、既存 ' + Math.max(last-1,0) + ' 行に遡及記入しました');
}

// ★ 2026-06-04: 在庫管理を新ルールに合わせて整理 (井上さん指示)
//   新ルール = 在庫管理に出すのは「発注済の商品」だけ:
//     - 即発注(緊急承認済/自己発注): 申請時から表示 → 残す
//     - 通常発注: 発注完了(発注済)後のみ表示 → 申請中/承認済の行は削除
//   status が {申請中, 承認済, 却下, 取消} の在庫管理行を削除。{緊急承認済, 自己発注, 発注済, 経理確認済} は残す。
//   発注一覧に無い注文No(孤児)は触らない。冪等(新ルール下では再実行しても削除対象は増えない)。
function cleanupStockUnordered() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(STOCK_SHEET);
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (!s) { Logger.log('在庫管理シートなし'); return { removed: 0, error: '在庫管理なし' }; }
  if (!idx) { Logger.log('発注一覧シートなし'); return { removed: 0, error: '発注一覧なし' }; }
  // 注文No → ステータス(K列=idx10) のマップ
  var statusByNo = {};
  var idata = idx.getDataRange().getValues();
  for (var i = 1; i < idata.length; i++) {
    var no = String(idata[i][1] || ''); if (!no) continue;
    statusByNo[no] = String(idata[i][10] || '');
  }
  var REMOVE = { '申請中': 1, '承認済': 1, '却下': 1, '取消': 1 };
  var data = s.getDataRange().getValues();
  var toDelete = [], removedByStatus = {}, orphan = 0, kept = 0;
  for (var r = 1; r < data.length; r++) {
    var rno = String(data[r][1] || '');
    if (!rno) continue;                                       // 空行スキップ
    if (!statusByNo.hasOwnProperty(rno)) { orphan++; continue; } // 発注一覧に無い→保持
    var st = statusByNo[rno];
    if (REMOVE[st]) { toDelete.push(r + 1); removedByStatus[st] = (removedByStatus[st] || 0) + 1; }
    else { kept++; }
  }
  for (var d = toDelete.length - 1; d >= 0; d--) s.deleteRow(toDelete[d]);  // 下から削除
  var summary = '✅ 在庫管理クリーンアップ: 削除' + toDelete.length + '行 (' +
    Object.keys(removedByStatus).map(function(k){ return k + ':' + removedByStatus[k]; }).join(' / ') +
    ') / 残し' + kept + '行 / 孤児' + orphan + '行は保持';
  Logger.log(summary);
  return { removed: toDelete.length, removedByStatus: removedByStatus, kept: kept, orphan: orphan, summary: summary };
}

// ★ 2026-06-04: 「営業自己発注」表記を「自己発注」に統一 (井上さん指示: 営業以外も自己発注するため文言から「営業」を外す)
//   発注一覧 K列(11=idx10) / 在庫管理 O列(15=idx14) に残る旧値「営業自己発注」を「自己発注」へ置換。
//   値の置換のみ(色は再適用)。冪等(再実行時は対象0)。新規発注は既に「自己発注」で書込まれる(applyStatusColor/stockStatus)。
function migrateSelfOrderLabel() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var result = { index: 0, stock: 0 };
  // --- 発注一覧 K列(11) ---
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (idx) {
    var iv = idx.getDataRange().getValues();
    for (var i = 1; i < iv.length; i++) {
      if (String(iv[i][10]) === '営業自己発注') {
        applyStatusColor(idx, i + 1, '自己発注');  // 値+色を再適用
        result.index++;
      }
    }
  }
  // --- 在庫管理 O列(15=idx14) ---
  var stk = ss.getSheetByName(STOCK_SHEET);
  if (stk) {
    var sv = stk.getDataRange().getValues();
    for (var j = 1; j < sv.length; j++) {
      if (String(sv[j][14]) === '営業自己発注') {
        stk.getRange(j + 1, 15).setValue('自己発注').setFontColor('#6a1b9a').setFontWeight('bold');
        result.stock++;
      }
    }
  }
  result.summary = '✅ 営業自己発注→自己発注 統一: 発注一覧 ' + result.index + '行 / 在庫管理 ' + result.stock + '行';
  Logger.log(result.summary);
  return result;
}

// ============ ★ システム整合性チェック (2026-05-29) ============
// 発注一覧・在庫管理を手動で行削除/移動した後、システムに不具合がないか確認する。
// GASエディタで「checkSystemIntegrity」を実行 → ログで判定。
function checkSystemIntegrity() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('====== システム整合性チェック ======');
  var issues = 0;

  // --- 発注一覧 ---
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (!idx) {
    Logger.log('❌ 発注一覧シートが見つかりません (致命的・シート名が変わった可能性)'); issues++;
  } else {
    var expIdx = ['受付日時','注文No.','発行日','仕入先','事業所','現場名','合計金額','注文者','緊急','承認者','ステータス','シートリンク','ID'];
    var idxH = idx.getRange(1,1,1,Math.max(idx.getLastColumn(),13)).getValues()[0];
    var hOk = true;
    for (var h = 0; h < 13; h++) {  // 最重要13列(A-M)を厳密チェック
      if (String(idxH[h]||'') !== expIdx[h]) {
        Logger.log('⚠️ 発注一覧 列'+(h+1)+' ヘッダー不一致: 期待["'+expIdx[h]+'"] 実際["'+(idxH[h]||'')+'"]'); hOk=false; issues++;
      }
    }
    if (hOk) Logger.log('✅ 発注一覧ヘッダー(A〜M:注文No/ID等)正常');
    var d = idx.getDataRange().getValues();
    var ids = {}, idMissing=0, idDup=0, stBlank=0, dataRows=0;
    for (var i=1; i<d.length; i++) {
      if (!d[i][1] && !d[i][12]) continue;  // 完全空行スキップ
      dataRows++;
      if (!d[i][12]) idMissing++; else if (ids[d[i][12]]) idDup++; else ids[d[i][12]]=true;
      if (!d[i][10]) stBlank++;
    }
    Logger.log('発注一覧 有効データ行: '+dataRows+' / ID欠損: '+idMissing+' / ID重複: '+idDup+' / ステータス空: '+stBlank);
    if (idMissing>0) { Logger.log('⚠️ ID欠損行あり→承認/編集/同期で照合できない(その行のみ)。手動で行を消した残骸の可能性'); issues++; }
    if (idDup>0) { Logger.log('⚠️ ID重複あり→誤った行を更新する恐れ。コピペで複製した可能性'); issues++; }
  }

  // --- 在庫管理 ---
  var stock = ss.getSheetByName(STOCK_SHEET);
  if (!stock) {
    Logger.log('在庫管理シートなし(未作成 or 削除済み)。必要なら rebuildStockSheet で再生成可');
  } else {
    var expStock = ['受付日時','注文No.','仕入先','事業所','現場名','注文者','メーカー','商品名','型式','数量','単価','金額','備考','無償(M)','ステータス','分類','納品予定日','入庫済み','メモ','シートURL'];
    var stH = stock.getRange(1,1,1,Math.max(stock.getLastColumn(),18)).getValues()[0];
    var sOk = true;
    for (var h2=0; h2<18; h2++) {
      if (String(stH[h2]||'') !== expStock[h2]) {
        Logger.log('⚠️ 在庫管理 列'+(h2+1)+' ヘッダー不一致: 期待["'+expStock[h2]+'"] 実際["'+(stH[h2]||'')+'"]'); sOk=false; issues++;
      }
    }
    if (sOk) Logger.log('✅ 在庫管理ヘッダー正常');
    Logger.log('在庫管理 データ行: '+(stock.getLastRow()-1));
  }

  // --- 結論 ---
  Logger.log('--- 行削除・移動の影響評価 ---');
  Logger.log('・新規発注/承認/編集/同期は 注文No・ID で照合 → 行順・行削除の影響なし');
  Logger.log('・削除した発注は記録が消えるだけ(システムは正常動作)');
  Logger.log('====== 検出された問題: '+issues+'件 ======');
  Logger.log(issues===0 ? '✅ 不具合の懸念なし。安全に使えます' : '⚠️ 上記の警告を確認してください(多くはヘッダー復旧で解決)');
}

// ★ 発注一覧・在庫管理の「空行」を削除してデータを上に詰める (2026-05-29)
// 行移動/値クリアで残った空行により appendRow が画面外の下に追加される問題を解消。
// GASエディタで「cleanupEmptyRows」を実行。書式(ステータス色等)は行ごと削除なので保持される。
function cleanupEmptyRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var deleted = 0;
  // --- 発注一覧: 注文No(B列) も ID(M列) もない行を削除 ---
  var s = ss.getSheetByName(INDEX_SHEET);
  if (s && s.getLastRow() > 1) {
    var data = s.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {       // 下から削除(インデックスずれ防止)
      if (!data[i][1] && !data[i][12]) { s.deleteRow(i + 1); deleted++; }
    }
    // データ最終行より下の余分な空行も削除 (予備5行残す)
    var maxR = s.getMaxRows(), lastR = s.getLastRow();
    if (maxR > lastR + 5) s.deleteRows(lastR + 1, maxR - lastR - 5);
  }
  // --- 在庫管理: 注文No(B列) も 商品名(H列) もない行を削除 ---
  var st = ss.getSheetByName(STOCK_SHEET);
  if (st && st.getLastRow() > 1) {
    var sdata = st.getDataRange().getValues();
    for (var j = sdata.length - 1; j >= 1; j--) {
      if (!sdata[j][1] && !sdata[j][7]) { st.deleteRow(j + 1); deleted++; }
    }
    var maxR2 = st.getMaxRows(), lastR2 = st.getLastRow();
    if (maxR2 > lastR2 + 5) st.deleteRows(lastR2 + 1, maxR2 - lastR2 - 5);
  }
  Logger.log('✅ 空行を ' + deleted + ' 行削除しました。データが上に詰まり、今後の発注は正しい位置(データの次)に追加されます');
}

// ★ keyCol列が空の行を削除して詰める (新規追記の直前に呼ぶ・自動詰め)
// これにより空行が残っていても appendRow が常にデータの直後(上詰め)に追加される
function _compactSheetByKey(s, keyCol) {
  var last = s.getLastRow();
  if (last <= 1) return;
  var values = s.getRange(1, keyCol, last, 1).getValues();
  for (var i = last - 1; i >= 1; i--) {  // 下から削除(インデックスずれ防止)
    var v = values[i][0];
    if (v === '' || v === null) s.deleteRow(i + 1);
  }
}

// ============ ★ スプシ直接編集の自動同期 (2026-05-29 v100) ============
// 発注書シートをスプシで直接修正したら、発注一覧・在庫管理を自動更新する。
// ★ setupEditTrigger() を GASエディタで1回だけ実行してトリガーを有効化する必要がある。
function setupEditTrigger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // 既存の同名トリガーを削除 (重複防止)
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onEditInstallable') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditInstallable').forSpreadsheet(ss).onEdit().create();
  Logger.log('✅ 編集トリガー(onEditInstallable)を設定しました。今後は発注書シートを直接編集すると発注一覧・在庫管理が自動更新されます');
}

// ★ 2026-06-30: 簡易onEditトリガー(インストール不要・各編集者の操作で自動発火)。
//   在庫管理の 単価/金額 手入力 → 発注一覧の合計金額を自動集計。同一スプシの読み書きのみなので簡易トリガーで可。
function onEdit(e) {
  try {
    if (!e || !e.range || !_isStockSheetName(e.range.getSheet().getName())) return;
    _syncStockAmountToIndex(e);
  } catch (err) {}
}

// インストーラブル onEdit トリガー本体
function onEditInstallable(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var _nm = sheet.getName();
    // ★ 2026-06-30: 在庫管理で 単価/金額 を手入力 → 発注一覧の該当合計金額を自動集計・転記
    if (_isStockSheetName(_nm)) { _syncStockAmountToIndex(e); _notifyStockDeliveryEdit(e); return; }
    if (!_isOrderSheet(_nm)) return;  // 発注書シート以外は無視
    var row = e.range.getRow();
    if (row < 18 || row > 49) return;             // 明細・集計部の編集のみ対象
    syncFromOrderSheet(sheet);
  } catch (err) {
    Logger.log('onEditInstallable エラー: ' + err.toString());
  }
}

// ★ 2026-06-30: 在庫管理の 単価(K=11)/金額(L=12) を手入力したら、その注文Noの金額合計を
//   発注一覧の合計金額(G=7) へ転記(空欄を埋める/更新)。当月の発注金額把握用。
//   単価編集で金額が空なら 単価×数量 を自動入力(手入力済み金額は上書きしない)。
function _syncStockAmountToIndex(e) {
  var sh = e.range.getSheet();
  var c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
  if (c2 < 11 || c1 > 12) return;  // 単価(11)/金額(12) 列を含む編集のみ
  var r1 = Math.max(e.range.getRow(), 2), r2 = e.range.getLastRow();
  if (r2 < 2) return;
  var ss = e.source || SpreadsheetApp.getActiveSpreadsheet();
  var priceEdited = (c1 <= 11 && c2 >= 11);  // 単価(11)列が編集範囲に含まれるか
  // 単価を編集したら 金額=単価×数量 を再計算(既存金額も上書き)。金額だけ直接編集したらその値を尊重。
  for (var r = r1; r <= r2; r++) {
    var qty = _stockNum(sh.getRange(r, 10).getValue());
    var price = _stockNum(sh.getRange(r, 11).getValue());
    var amtCell = sh.getRange(r, 12);
    var amtRaw = amtCell.getValue();
    if (price > 0 && qty > 0 && (priceEdited || amtRaw === '' || amtRaw === null)) {
      amtCell.setValue(qty * price).setNumberFormat('#,##0');
    }
  }
  SpreadsheetApp.flush();
  // 影響を受けた注文Noを集める
  var affected = {};
  for (var rr = r1; rr <= r2; rr++) {
    var no = String(sh.getRange(rr, 2).getValue() || '').trim();
    if (no) affected[no] = true;
  }
  var sv = sh.getDataRange().getValues();
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (!idx) return;
  var iv = idx.getDataRange().getValues();
  for (var key in affected) {
    var sum = 0;
    for (var i = 1; i < sv.length; i++) {
      if (String(sv[i][1]).trim() === key) sum += _stockNum(sv[i][11]);  // 金額=index11
    }
    if (sum > 0) {  // 金額未入力(=0)のときは発注一覧を空のまま保持・上書きしない
      for (var j = 1; j < iv.length; j++) {
        if (String(iv[j][1]).trim() === key) idx.getRange(j + 1, 7).setValue(sum).setNumberFormat('#,##0');
      }
    }
  }
}
function _stockNum(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ★ 2026-06-30: 在庫管理の Q列(納品予定日=17)記入 / R列(入庫済み=18)チェック時、その行の
//   注文者(申請者本人)へメール通知。※MailApp使用のため【インストール型トリガー(onEditInstallable)経由のみ】動作。
//   簡易onEditからは呼ばない(権限不足で送信不可)。メアド未登録の注文者はスキップ(誤送信防止)。
function _notifyStockDeliveryEdit(e) {
  var sh = e.range.getSheet();
  var c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
  var hitDelivery = (c1 <= 17 && c2 >= 17);  // Q=納品予定日
  var hitReceived = (c1 <= 18 && c2 >= 18);  // R=入庫済み
  if (!hitDelivery && !hitReceived) return;
  var r1 = Math.max(e.range.getRow(), 2), r2 = e.range.getLastRow();
  for (var r = r1; r <= r2; r++) {
    var orderer = String(sh.getRange(r, 6).getValue() || '').trim();   // 注文者 F=6
    if (!orderer) continue;
    var emails = (MULTI_EMAILS[orderer] && MULTI_EMAILS[orderer].length) ? MULTI_EMAILS[orderer].slice()
               : ((STAFF_EMAILS && STAFF_EMAILS[orderer]) ? [STAFF_EMAILS[orderer]] : []);
    if (!emails.length) { Logger.log('在庫管理通知: 注文者「' + orderer + '」のメアド未登録→スキップ'); continue; }
    var orderNo = String(sh.getRange(r, 2).getValue() || '').trim();   // 注文No B=2
    var supplier = String(sh.getRange(r, 3).getValue() || '').trim();  // 仕入先 C=3
    var site = String(sh.getRange(r, 5).getValue() || '').trim();      // 現場名 E=5
    var product = String(sh.getRange(r, 8).getValue() || '').trim();   // 商品名 H=8
    var deliveryDate = sh.getRange(r, 17).getValue();
    var received = sh.getRange(r, 18).getValue();
    var subj, body;
    if (hitReceived && received === true) {
      subj = '【入庫完了】' + (product || site || orderNo);
      body = orderer + ' 様\n\n発注された商品が入庫されました。\n\n注文No.: ' + orderNo + '\n仕入先: ' + supplier + '\n現場名: ' + site + '\n商品: ' + product + '\n\n(在庫管理システムより自動送信)';
    } else if (hitDelivery && deliveryDate !== '' && deliveryDate !== null) {
      var dStr = (Object.prototype.toString.call(deliveryDate) === '[object Date]')
        ? Utilities.formatDate(deliveryDate, 'Asia/Tokyo', 'yyyy/MM/dd') : String(deliveryDate);
      // e.oldValue(前の値)があれば=変更、無ければ=新規設定。※単一セル編集時のみ前値が取れる
      var hadOld = (e && e.oldValue !== undefined && e.oldValue !== null && String(e.oldValue).trim() !== '');
      var actLabel = hadOld ? '変更' : '設定';
      var oldLine = hadOld ? ('変更前: ' + String(e.oldValue) + '\n') : '';
      subj = '【納品予定日' + actLabel + '】' + (product || site || orderNo) + ' → ' + dStr;
      body = orderer + ' 様\n\n発注された商品の納品予定日が' + actLabel + 'されました。\n\n' + oldLine + '納品予定日: ' + dStr + '\n注文No.: ' + orderNo + '\n仕入先: ' + supplier + '\n現場名: ' + site + '\n商品: ' + product + '\n\n(在庫管理システムより自動送信)';
    } else {
      continue;  // Q削除・R=false等は通知しない
    }
    try { MailApp.sendEmail({ to: emails.join(','), subject: subj, body: body }); }
    catch (err) { Logger.log('在庫管理通知メール失敗 No.' + orderNo + ': ' + err.toString()); }
  }
}

// シート名が「発注書シート」(YYYYMMDD_ で始まる) か判定
function _isOrderSheet(name) {
  var exclude = ['発注一覧','在庫管理','見積一覧','見積書(テンプレート)','発注書(テンプレート)','テンプレート'];
  if (exclude.indexOf(name) !== -1) return false;
  if (name.indexOf('テンプレ') !== -1) return false;
  if (name.indexOf('見積_') === 0) return false;
  return /^\d{8}_/.test(name);
}

// 発注書シートの明細を読んで、発注一覧・在庫管理を更新
function syncFromOrderSheet(sheet) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var orderNo = sheet.getRange('AH3').getValue();
  if (!orderNo) return;
  var idx = ss.getSheetByName(INDEX_SHEET);
  if (!idx) return;
  var idxData = idx.getDataRange().getValues();
  var idxRow = -1;
  for (var i = 1; i < idxData.length; i++) {
    if (String(idxData[i][1]) === String(orderNo)) { idxRow = i + 1; break; }
  }
  if (idxRow === -1) return;
  // 元の明細JSON から type (形態U/M) を順番で保持 (発注書シートにtype列がないため)
  var oldLines = [];
  try { oldLines = JSON.parse(idxData[idxRow-1][13] || '[]'); } catch(e) {}
  // 発注書シートの明細を読む (行19,21,... = 19+idx*2)
  var lines = [];
  var total = 0;
  for (var k = 0; k < 8; k++) {
    var r = 19 + k * 2;
    var maker = sheet.getRange('C'+r).getValue();
    var product = sheet.getRange('H'+r).getValue();
    var qty = Number(sheet.getRange('Z'+r).getValue()) || 0;
    var price = Number(sheet.getRange('AB'+r).getValue()) || 0;
    if (maker || product || qty > 0) {
      var amount = qty * price;
      total += amount;
      lines.push({
        maker: maker || '', product: product || '',
        model: sheet.getRange('P'+r).getValue() || '',
        qty: qty, price: price, amount: amount,
        remark: sheet.getRange('AL'+r).getValue() || '',
        type: (oldLines[k] && oldLines[k].type) ? oldLines[k].type : 'U'
      });
    }
  }
  // 発注一覧を更新 (N列=明細JSON / G列=合計 / 高額単価・無償=ヘッダー名で)
  idx.getRange(idxRow, 14).setValue(JSON.stringify(lines));
  idx.getRange(idxRow, 7).setValue(total).setNumberFormat('#,##0');
  var flags = _calcOrderFlags(lines);
  _writeFlagByHeader(idx, idxRow, '高額単価(10万超)', flags.highPrice, '#d93025');
  _writeFlagByHeader(idx, idxRow, '無償(M)', flags.free, '#1a73e8');
  // 在庫管理を更新 (分類は保持)
  _resyncStockForOrder(ss, orderNo, idxData[idxRow-1], lines);
}

// 在庫管理シートの該当発注行を更新 (分類O列は保持)
function _resyncStockForOrder(ss, orderNo, idxRowData, lines) {
  var s = _getStockSheet(ss, idxRowData[4]);  // ★ 2026-08-21: 発注一覧E列=事業所 で拠点別タブを選択
  if (!s) return;
  _ensureStockMemoColumn(s);  // メモ列保証 (2026-06-11)
  _ensureStockDeliveryColumn(s);  // 納品予定日列保証 (2026-06-16)
  var data = s.getDataRange().getValues();
  var stockRows = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(orderNo)) stockRows.push(i + 1);  // B列=注文No
  }
  // ★ 2026-06-04: 在庫管理は発注完了後のみ存在。未登録(=まだ発注完了していない)なら編集同期で新規追加しない
  if (stockRows.length === 0) return;
  if (stockRows.length === lines.length) {
    // 商品数が同じ → 各行を値更新 (分類O列・行順を保持)
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j], rr = stockRows[j];
      s.getRange(rr, 7, 1, 7).setValues([[ln.maker||'', ln.product||'', ln.model||'', ln.qty||'', ln.price||'', ln.amount||'', ln.remark||'']]);
      s.getRange(rr, 14).setValue((ln.type==='M')?'M':'');  // N 無償
      s.getRange(rr, 11, 1, 2).setNumberFormat('#,##0');
      // ステータス(15)〜シートURL(20) は触らない=保持 (分類/納品予定日/入庫済み/メモ含む)
    }
  } else {
    // 商品数が変わった → 削除して再追加 (分類・入庫済みは商品名で引き継ぎ)
    var categoryMap = {};
    var deliveryMap = {};
    var checkedMap = {};
    var memoMap = {};
    for (var c = 0; c < data.length; c++) {
      if (String(data[c][1]) === String(orderNo)) {
        categoryMap[data[c][7]] = data[c][15];   // 分類(16)
        deliveryMap[data[c][7]] = data[c][16];   // 納品予定日(17)
        checkedMap[data[c][7]] = data[c][17];    // 入庫済み(18)
        memoMap[data[c][7]] = data[c][18];       // メモ(19)
      }
    }
    // ★ 2026-06-04: ステータスは発注一覧の作成時情報から再導出 (K=緊急承認済/自己発注 or I=緊急)
    var st10b = String(idxRowData[10]||'');
    var statusVal = (st10b === '緊急承認済') ? st10b : ((st10b === '自己発注' || st10b === '営業自己発注') ? '承認スキップ' : (String(idxRowData[8]||'') === '緊急' ? '緊急承認済' : ''));
    for (var d = stockRows.length - 1; d >= 0; d--) s.deleteRow(stockRows[d]);
    var now = idxRowData[0], supplier = idxRowData[3], branch = idxRowData[4], siteName = idxRowData[5], orderer = idxRowData[7], url = idxRowData[11];
    var rows = [];
    lines.forEach(function(ln) {
      rows.push([
        now, orderNo, supplier, branch, siteName||'', orderer,
        ln.maker||'', ln.product||'', ln.model||'', ln.qty||'', ln.price||'',
        ln.amount||'', ln.remark||'', (ln.type==='M')?'M':'',  // L金額/M備考/N無償
        statusVal,                                       // O: ステータス
        categoryMap[ln.product]||'',                     // 分類
        deliveryMap[ln.product]||'',                     // 納品予定日 (商品名で引き継ぎ)
        checkedMap[ln.product] === true ? true : false,  // 入庫済み (商品名で引き継ぎ)
        memoMap[ln.product]||'',                          // メモ (商品名で引き継ぎ)
        url||''                                          // シートURL
      ]);
    });
    if (rows.length > 0) {
      var startRow = s.getLastRow() + 1;
      s.getRange(startRow, 1, rows.length, 20).setValues(rows);
      s.getRange(startRow, 11, rows.length, 2).setNumberFormat('#,##0');
      for (var ri = 0; ri < rows.length; ri++) {
        if (rows[ri][13] === 'M') s.getRange(startRow + ri, 14).setFontColor('#1a73e8').setFontWeight('bold').setHorizontalAlignment('center');
        if (rows[ri][14] === '緊急承認済') s.getRange(startRow + ri, 15).setFontColor('#d93025').setFontWeight('bold');
        else if (rows[ri][14] === '自己発注' || rows[ri][14] === '営業自己発注') s.getRange(startRow + ri, 15).setFontColor('#6a1b9a').setFontWeight('bold');
      }
      applyStockCategoryValidation(s);
      applyStockCheckboxValidation(s);
    }
  }
}

// ★ 2026-05-27 v83: 既存の全発注に X(高額単価◎)・Y(無償M) フラグを遡及計算
//   GASエディタで「backfillOrderFlags」を一度実行すれば既存データ全件に反映される
function backfillOrderFlags() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) { Logger.log('発注一覧シートなし'); return; }
  var lastRow = s.getLastRow();
  // ★ 2026-05-29: ヘッダー名で列を探す(列削除・移動に対応)。固定列番号は使わない
  var colHigh = _findColumnByHeader(s, '高額単価(10万超)');
  var colFree = _findColumnByHeader(s, '無償(M)');
  if (colHigh <= 0 || colFree <= 0) {
    Logger.log('⚠️ ヘッダー「高額単価(10万超)」または「無償(M)」が発注一覧に見つかりません。ヘッダー行を確認(削除した場合は手動で復活)してください');
    return;
  }
  Logger.log('高額単価列=' + columnToLetter(colHigh) + ' / 無償列=' + columnToLetter(colFree));
  if (lastRow < 2) { Logger.log('データ行なし'); return; }
  // N列(14)=明細JSON を読んでフラグ計算 → ヘッダー名の列に書き込み
  var jsonCol = s.getRange(2, 14, lastRow - 1, 1).getValues();
  var cnt = 0;
  for (var i = 0; i < jsonCol.length; i++) {
    var lines = [];
    try { lines = JSON.parse(jsonCol[i][0] || '[]'); } catch(e) {}
    var flags = _calcOrderFlags(lines);
    _writeFlagByHeader(s, i+2, '高額単価(10万超)', flags.highPrice, '#d93025');
    _writeFlagByHeader(s, i+2, '無償(M)', flags.free, '#1a73e8');
    cnt++;
  }
  Logger.log('backfillOrderFlags 完了 (ヘッダー名ベース): ' + cnt + '件に反映');
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
    case '自己発注':
    case '営業自己発注':
      cell.setFontColor('#6a1b9a').setBackground('#f3e5f5'); break;
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
// 形態コード → 表示名 (M=M, U=その他) ★2026-06-04: Mは「無償」表記をやめ「M」に変更(井上さん指示・承認メールの形態列)
function typeLabel(t) {
  if (t === 'M') return 'M';
  if (t === 'U') return 'その他';
  return t || '-';
}
function buildDetailRows(lines) {
  var dr = '';
  (lines||[]).forEach(function(l,i){
    dr += '<tr><td style="border:1px solid #ddd;padding:6px;text-align:center">'+(i+1)+'</td><td style="border:1px solid #ddd;padding:6px">'+l.maker+'</td><td style="border:1px solid #ddd;padding:6px">'+l.product+'</td><td style="border:1px solid #ddd;padding:6px;text-align:right">'+l.qty+'</td><td style="border:1px solid #ddd;padding:6px;text-align:right">&yen;'+Number(l.price).toLocaleString()+'</td><td style="border:1px solid #ddd;padding:6px;text-align:right">&yen;'+Number(l.amount).toLocaleString()+'</td><td style="border:1px solid #ddd;padding:6px;text-align:center">'+typeLabel(l.type)+'</td></tr>';
  });
  return dr;
}

function buildSummaryTable(data) {
  return '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' +
    '<tr><td style="padding:8px;font-weight:bold;width:100px;background:#f8f9fa">発行日</td><td style="padding:8px">'+data.issueDate+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">注文No.</td><td style="padding:8px">'+data.orderNo+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">仕入先</td><td style="padding:8px">'+data.supplier+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">事業所</td><td style="padding:8px">'+data.branch+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">現場名</td><td style="padding:8px">'+(data.siteName||'-')+'</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">注文者</td><td style="padding:8px">'+data.orderer+'</td></tr></table>';
}

function buildDetailTable(lines) {
  return '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px"><thead><tr style="background:#d9e2f3"><th style="border:1px solid #ddd;padding:6px">No</th><th style="border:1px solid #ddd;padding:6px">メーカー</th><th style="border:1px solid #ddd;padding:6px">商品名</th><th style="border:1px solid #ddd;padding:6px">数量</th><th style="border:1px solid #ddd;padding:6px">単価</th><th style="border:1px solid #ddd;padding:6px">金額</th><th style="border:1px solid #ddd;padding:6px">形態</th></tr></thead><tbody>'+buildDetailRows(lines)+'</tbody></table>';
}

// ============ 通常メール: 承認者へ（承認/却下リンク付き） ============
// 画面で選んだ承認者(data.approverEmail)に直接送信。未指定時のみ固定値にフォールバック
function sendApprovalEmail(data, os, uniqueId) {
  var approverEmail = data.approverEmail || (data.urgent ? APPROVER_URGENT.email : APPROVER_PASS.email);
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

  // 承認者 + 発注者(指定時)に送信。重複排除 (2026-05-29)
  var toListA = [approverEmail];
  _emailsForPerson(data.orderPersonName, data.orderPersonEmail).forEach(function(_e){ if (_e && toListA.indexOf(_e) === -1) toListA.push(_e); });
  MailApp.sendEmail({ to: toListA.join(','), subject: subj, body: '承認: '+approveUrl+'\n却下: '+rejectUrl, htmlBody: hb });
}

// ============ ★ 緊急メール: 承認者+発注担当者に同時送信 ============
// 画面で選んだ承認者(data.approverEmail)に直接送信
function sendUrgentEmail(data, os, uniqueId) {
  var approverEmail = data.approverEmail || APPROVER_URGENT.email;
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

  // 承認者 + 発注者(指定時) + 事務員全員の宛先を統合（重複排除）
  var toList = [approverEmail];
  _emailsForPerson(data.orderPersonName, data.orderPersonEmail).forEach(function(_e){ if (_e && toList.indexOf(_e) === -1) toList.push(_e); });
  (JIMUIN_EMAILS || []).forEach(function(em){
    if (em && toList.indexOf(em) === -1) toList.push(em);
  });

  MailApp.sendEmail({ to: toList.join(','), subject: subj, body: plainBody, htmlBody: hb });
}

// ============ 申請者(注文者)に通知（承認/却下時） ============
// 現状: STAFFに個別メアド未登録のため、暫定で PURCHASER.email に送信し
// 件名に「申請者: 〇〇 様」と明記。後でSTAFFをオブジェクト化したら data.ordererEmail で個別送信に切替可
function notifyOrderer(id, orderNo, supplier, orderer, total, sheetUrl, status) {
  var isApproved = (status === '承認済');
  var headerColor = isApproved ? '#188038' : '#d93025';
  var headerText = isApproved ? '【発注承認】あなたの申請が承認されました' : '【発注却下】あなたの申請が却下されました';
  var msg = isApproved
    ? '<p>あなたが申請した発注書が承認されました。事務員にも通知済みです。</p>'
    : '<p>申し訳ありませんが、あなたが申請した発注書は<strong style="color:#d93025">却下</strong>されました。<br>必要があれば再度申請してください。</p>';

  var hb = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:' + headerColor + ';color:white;padding:16px;border-radius:8px 8px 0 0"><h2 style="margin:0;font-size:16px">' + headerText + '</h2></div>' +
    '<div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">' +
    '<p style="font-size:14px;color:#666">申請者: <strong>' + orderer + ' 様</strong></p>' +
    msg +
    '<table style="width:100%;border-collapse:collapse;margin:16px 0">' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa;width:120px">注文No.</td><td style="padding:8px">' + orderNo + '</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">仕入先</td><td style="padding:8px">' + supplier + '</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;background:#f8f9fa">金額</td><td style="padding:8px">&yen;' + Number(total).toLocaleString() + '</td></tr></table>' +
    '<a href="' + sheetUrl + '" style="display:block;text-align:center;padding:14px;background:#1a73e8;color:white;border-radius:8px;text-decoration:none;font-size:15px;font-weight:bold;margin:16px 0">発注書を確認する</a>' +
    '</div></div>';

  // 2026-06-03: 申請者本人のメアドへ直接送信 (STAFF_EMAILS で名前→メアド解決)。未登録なら従来通り PURCHASER へフォールバック
  var ordererTo = (MULTI_EMAILS[orderer]) ? MULTI_EMAILS[orderer].join(',')
    : ((STAFF_EMAILS && STAFF_EMAILS[orderer]) ? STAFF_EMAILS[orderer] : PURCHASER.email);
  MailApp.sendEmail({
    to: ordererTo,
    subject: (isApproved ? '【承認通知】' : '【却下通知】') + '申請者: ' + orderer + ' / ' + supplier + ' / ' + orderNo,
    body: (isApproved ? '承認されました' : '却下されました') + '\n注文No.: ' + orderNo + '\n仕入先: ' + supplier + '\n金額: ' + Number(total).toLocaleString() + '円',
    htmlBody: hb
  });
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

  // ★ 2026-06-05: 発注依頼の宛先 = 申請時に選んだ発注者本人 (ORDER_PERSON_EMAILS で名前→メアド解決)。
  //   発注者が未選択 or 対応表に無い場合のみ、従来どおり事務員全員(JIMUIN_EMAILS)へフォールバック。
  var _toAddr = (JIMUIN_EMAILS || [PURCHASER.email]).join(',');
  try {
    var _idxS = ss.getSheetByName(INDEX_SHEET);
    var _colOP = _findColumnByHeader(_idxS, '発注者');
    if (_colOP > 0) {
      var _vals = _idxS.getDataRange().getValues();
      for (var _i = 1; _i < _vals.length; _i++) {
        if (_vals[_i][12] === id) {
          var _opName = String(_vals[_i][_colOP - 1] || '').trim();
          if (_opName && MULTI_EMAILS[_opName]) _toAddr = MULTI_EMAILS[_opName].join(',');
          else if (_opName && ORDER_PERSON_EMAILS[_opName]) _toAddr = ORDER_PERSON_EMAILS[_opName];
          break;
        }
      }
    }
  } catch(_e) { Logger.log('発注者ルックアップエラー: ' + _e.toString()); }
  MailApp.sendEmail({
    to: _toAddr,
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
        // ★ 2026-05-31: AF60→AF61 (結合左上)。注文者AJ61と同じ +1行ズレを修正
        //   旧 AF60 は結合の外で表示されなかった (注文者AJ60→AJ61と同じパターン)
        try { orderSheet.getRange('AF61').setValue(approverName); } catch(e) {}
        try { orderSheet.getRange('AF60').setValue(''); } catch(e) {}  // 旧位置クリア
        var now = new Date();
        try { orderSheet.getRange('AE63').setValue((now.getMonth()+1) + '/' + now.getDate()); } catch(e) {}
        try { orderSheet.getRange('AE62').setValue(''); } catch(e) {}  // 旧位置クリア (日付も同じパターン)
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
  //                                                                                                     L:シートリンク M:ID    N:発注申請  O:明細JSON  P:事業所  Q:特記事項  R:更新日時
  var headers = ['受付日時','見積No.','見積日','お客様名','件名','担当者','合計(税込)','合計(税抜)','原価合計','粗利率','ステータス','シートリンク','ID','発注申請','明細JSON','事業所','特記事項','更新日時'];
  s.getRange(1,1,1,headers.length).setValues([headers]);
  s.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
  s.setFrozenRows(1);
  s.setColumnWidth(1, 140);
  s.setColumnWidth(2, 120);
  s.setColumnWidth(4, 120);
  s.setColumnWidth(7, 100);
  s.setColumnWidth(11, 80);
  s.setColumnWidth(14, 100);
  s.setColumnWidth(15, 80);  // 明細JSON（狭めでOK）
  // 明細JSON列は折り返しなし、薄いグレーで技術的な列だと分かるように
  s.getRange(1, 15).setBackground('#9aa0a6');
  Logger.log('initEstimateSheet完了');
}

// ============ 見積一覧スキーマ拡張（既存シート用 - 1回だけ実行） ============
function upgradeEstimateSchema() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) return { success: false, error: '見積一覧がありません' };
  var lastCol = s.getLastColumn();
  // N列 = 発注申請 (14), O列 = 明細JSON (15), P列 = 事業所 (16), Q列 = 特記事項 (17), R列 = 更新日時 (18)
  var newHeaders = ['明細JSON','事業所','特記事項','更新日時'];
  for (var i = 0; i < newHeaders.length; i++) {
    var col = 15 + i;  // O列から
    var cur = s.getRange(1, col).getValue();
    if (cur !== newHeaders[i]) {
      s.getRange(1, col).setValue(newHeaders[i]).setFontWeight('bold').setBackground('#0f9d58').setFontColor('#fff');
    }
  }
  s.setColumnWidth(15, 80);
  Logger.log('upgradeEstimateSchema完了');
  return { success: true };
}

// ============ 発注一覧スキーマ拡張（既存シート用 - 1回だけ実行） ============
function upgradeOrderSchema() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: false, error: '発注一覧がありません' };
  // N列 = 明細JSON (14), O列 = 特記事項 (15), P列 = 更新日時 (16)
  var newHeaders = ['明細JSON','特記事項','更新日時'];
  for (var i = 0; i < newHeaders.length; i++) {
    var col = 14 + i;  // N列から
    var cur = s.getRange(1, col).getValue();
    if (cur !== newHeaders[i]) {
      s.getRange(1, col).setValue(newHeaders[i]).setFontWeight('bold').setBackground('#4285f4').setFontColor('#fff');
    }
  }
  s.setColumnWidth(14, 80);
  Logger.log('upgradeOrderSchema完了');
  return { success: true };
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

// ============ 売値計算（粗利率方式: 原価 ÷ (1 - 粗利率)）============
// 丸めなし。小数点以下を単純切り捨て（Math.floor）
// 例: 原価10,000 + 粗利率30% = 10,000 / 0.7 = 14,285.71... → 14,285円
// 粗利率 = (売値 - 原価) / 売値 (業界標準)
// roundingStr 引数は互換性のため残す（無視）
function calcSellingPrice(cost, marginRate, roundingStr) {
  if (!cost) return 0;
  var m = marginRate || 0; // 小数 (0.3 = 30%)
  if (m >= 1) m = 0.99;    // 0除算防止 (粗利100%以上は不可)
  if (m < 0) m = 0;
  return Math.floor(cost / (1 - m));
}

// ============ 見積書処理 ============
function processEstimate(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabName = '見積_' + data.estimateDate.replace(/-/g, '');
  if (data.customerName) tabName += '_' + data.customerName.substring(0, 10);
  if (data.staff) tabName += '_' + data.staff;
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
    // 実粗利率も上乗せ率ベース: (売値 - 原価) / 原価
    ln.actualMargin = lineCost > 0 ? Math.round(((ln.amount - lineCost) / lineCost) * 1000) / 1000 : 0;
    ln.profit = ln.amount - lineCost;
    subtotal += ln.amount;
    costTotal += lineCost;
  }
  var tax = Math.floor(subtotal * 0.1);  // 消費税10%（切り捨て）
  var grandTotal = subtotal + tax;
  // 全体粗利率も上乗せ率ベース
  var overallMargin = costTotal > 0 ? Math.round((subtotal - costTotal) / costTotal * 1000) / 1000 : 0;

  data.subtotal = subtotal;
  data.tax = tax;
  data.grandTotal = grandTotal;
  data.costTotal = costTotal;
  data.overallMargin = overallMargin;

  // NEW_FLOW: 個別シート作らずに一覧のみ更新
  var sheet = null;
  var sheetUrl = '';
  if (NEW_FLOW) {
    // 個別シートを作らない
    addToEstimateIndex(ss, data, null, uniqueId);
    sheetUrl = ''; // シートURLなし（編集モーダル経由でアクセス）
  } else {
    // 旧フロー: テンプレコピー or プログラム生成
    var tplSheet = findTemplateSheet(ss, EST_TEMPLATE_CANDIDATES);
    Logger.log('見積テンプレート: ' + (tplSheet ? tplSheet.getName() : '見つからず→プログラム生成'));
    sheet = tplSheet
      ? createEstimateFromTemplate(ss, tplSheet, tabName, data)
      : createEstimateSheet(ss, tabName, data);
    addToEstimateIndex(ss, data, sheet, uniqueId);
    sheetUrl = ss.getUrl() + '#gid=' + sheet.getSheetId();
  }
  return {
    success: true,
    message: '見積書を作成しました',
    estimateNo: data.estimateNo,
    id: uniqueId,
    spreadsheetUrl: ss.getUrl(),
    sheetUrl: sheetUrl
  };
}

// ============ 見積書: 既存テンプレートをコピーして使う ============
// 見積テンプレートシート (見積連動発注原紙.xlsx と同じ構造) からコピー
// セル配置（Excelテンプレート準拠）:
//   H1: 発行日, K2: 日付連番, A4:D4: お客様名, I5: 事業所, I10: 担当者
//   C9: 件名, C10: 納期, C11: 受渡場所, C12: 支払条件, E12: 支払日数
//   A15-A32: 明細(B=メーカー, C=品名, D=型式, E=数量, F=単位, I=定価, J=丸め, K=原価, L=粗利率, M=原価0対象)
//   A36-A38: 特記事項
function createEstimateFromTemplate(ss, template, tabName, data) {
  var sh = template.copyTo(ss);
  var name = tabName; var i = 1;
  while (ss.getSheetByName(name)) { name = tabName + '_' + i; i++; }
  sh.setName(name);
  sh.setTabColor('#0f9d58'); // 緑
  // 見積一覧の直後に配置
  try {
    var idx = ss.getSheetByName(EST_INDEX_SHEET);
    if (idx) {
      ss.setActiveSheet(sh);
      ss.moveActiveSheet(idx.getIndex() + 1);
    }
  } catch(e) {}

  // ヘッダー部の埋め込み
  // テンプレ構造: H1=「発行日」(ラベル) I1=日付値、H2=「見積No.」(ラベル) I2=No.値、J5=事業所
  var d = data.estimateDate.split('-');
  try { sh.getRange('I1').setValue(new Date(parseInt(d[0]), parseInt(d[1])-1, parseInt(d[2]))); } catch(e) {}    // I1: 発行日値
  try { sh.getRange('I2').setValue(data.estimateNo || ''); } catch(e) {}                                          // I2: 見積No.
  try { sh.getRange('A4').setValue(data.customerName || ''); } catch(e) {}
  try { sh.getRange('J5').setValue(data.branch || '本社'); } catch(e) {}                    // J5: 事業所名
  try { sh.getRange('I10').setValue(data.staff || ''); } catch(e) {}
  if (data.subject) { try { sh.getRange('C9').setValue(data.subject); } catch(e) {} }

  // 事業所に応じた住所を G7 セルに書き込み（テンプレ確認済みのセル位置）
  // テンプレ固定値「▽本社\n〒820-0073\n福岡県飯塚市平恒477-7\nTEL...」を上書き
  var bi = getBranchInfo(data.branch || '本社');
  var branchLabel = (data.branch === '福岡店') ? '▽福岡' :
                     (data.branch === '飯塚ガスセンター') ? '▽飯塚ガスセンター' : '▽本社';
  var addressBlock = branchLabel + '\n' + bi.zip + '\n' + bi.addr + '\n' + bi.tel + ' ' + bi.fax;
  try { sh.getRange('G7').setValue(addressBlock); } catch(e) {}

  // 明細行（15-32行）- 新テンプレ構造に合わせる
  // 列構成: A=No. B=メーカー C=品名 D=型式・仕様 E=数量 F=単位 G=単価 H=金額 I=備考
  // 備考(I列)にはメーカー名は記載しない（B列のメーカー欄を使うため）
  var lines = data.lines || [];
  for (var idx2 = 0; idx2 < 18; idx2++) {
    var r = 15 + idx2;
    var ln = lines[idx2];
    if (ln && ln.cost) {
      try { sh.getRange(r, 1).setValue(idx2 + 1); } catch(e) {}                                          // A: No.
      try { sh.getRange(r, 2).setValue(ln.maker || ''); } catch(e) {}                                    // B: メーカー
      try { sh.getRange(r, 3).setValue(ln.product || ''); } catch(e) {}                                  // C: 品名
      try { sh.getRange(r, 4).setValue(ln.model || ''); } catch(e) {}                                    // D: 型式・仕様
      try { sh.getRange(r, 5).setValue(ln.qty || 0); } catch(e) {}                                       // E: 数量
      try { sh.getRange(r, 6).setValue(ln.unit || '台'); } catch(e) {}                                   // F: 単位
      try { sh.getRange(r, 7).setValue(ln.sellingPrice || 0).setNumberFormat('#,##0'); } catch(e) {}     // G: 単価(売値)
      try { sh.getRange(r, 8).setValue(ln.amount || 0).setNumberFormat('#,##0'); } catch(e) {}           // H: 金額
      try { sh.getRange(r, 9).setValue(''); } catch(e) {}                                                // I: 備考（空）
    }
  }
  // 合計行 (33-35) H列に変更（金額列が H に移動したため）
  try { sh.getRange('H33').setValue(data.subtotal || 0).setNumberFormat('#,##0'); } catch(e) {}          // 小計
  try { sh.getRange('H34').setValue(data.tax || 0).setNumberFormat('#,##0'); } catch(e) {}               // 消費税
  try { sh.getRange('H35').setValue(data.grandTotal || 0).setNumberFormat('#,##0'); } catch(e) {}        // 合計
  // 御見積金額欄 C7
  try { sh.getRange('C7').setValue(data.grandTotal || 0).setNumberFormat('#,##0"円"'); } catch(e) {}

  // 特記事項
  if (data.notes) { try { sh.getRange('B36').setValue(data.notes); } catch(e) {} }

  return sh;
}

// ============ 見積書シート作成（Excelレイアウト再現・フォールバック版） ============
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
  var url = sheet ? (ss.getUrl() + '#gid=' + sheet.getSheetId()) : '';
  // 発注申請リンク（スプシからワンクリックでWebフォームに転記）
  var formUrl = 'https://sinoueipro-bot.github.io/purchase-order-form/?quickPO=' + uniqueId;
  // 明細JSON（編集時に復元するため）
  var linesJson = JSON.stringify(data.lines || []);

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
    '',                           // N: 発注申請リンク（HYPERLINK数式で上書き）
    linesJson,                    // O: 明細JSON
    data.branch || '本社',        // P: 事業所
    data.notes || '',             // Q: 特記事項
    now                           // R: 更新日時
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

  // 明細は見積一覧の O列(idx=14)に保存されている明細JSONから取得
  // 見積書シートのセル直読みは列構造変更で破綻するため、addToEstimateIndex で保存されたJSONを単一の真実とする
  var lines = [];
  var jsonStr = data[rowIdx][14];
  if (jsonStr) {
    try {
      var parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        for (var k = 0; k < parsed.length; k++) {
          var ln = parsed[k] || {};
          var qtyN = parseInt(ln.qty);
          var costN = parseInt(ln.cost);
          var sellingN = parseInt(ln.sellingPrice);
          lines.push({
            maker: String(ln.maker || ''),
            product: String(ln.product || ''),
            model: String(ln.model || ''),
            qty: isNaN(qtyN) ? 0 : qtyN,
            unit: String(ln.unit || '台'),
            cost: isNaN(costN) ? 0 : costN,                    // 原価（仕入価格）
            sellingPrice: isNaN(sellingN) ? 0 : sellingN,      // 売値
            price: isNaN(costN) ? 0 : costN,                   // 発注書の単価＝原価（仕入先への発注価格）
            remark: ''
          });
        }
      }
    } catch (e) {
      Logger.log('明細JSON parse error: ' + e.toString());
    }
  }

  // 二重発注防止: この見積から既に発注書を作成したメーカーを抽出
  // 発注一覧の特記事項(O列, idx=14)と明細JSON(N列, idx=13)の両方をチェック
  // ステータスが「取消」「却下」のものは無効として除外（再発注可能）
  var estimateNo = data[rowIdx][1];
  var orderedMakers = [];
  var orderSheet = ss.getSheetByName(INDEX_SHEET);
  if (orderSheet && estimateNo) {
    var orderData = orderSheet.getDataRange().getValues();
    for (var oi = 1; oi < orderData.length; oi++) {
      var oRow = orderData[oi];
      var oStatus = String(oRow[10] || '');
      if (oStatus === '取消' || oStatus === '却下') continue;

      var oNotes = String(oRow[14] || '');
      var oLinesJson = String(oRow[13] || '');

      // 見積No.が notes・linesJson のどちらかに含まれているか判定
      var keyword = '見積No.' + estimateNo;
      var matchesEstimate = (oNotes.indexOf(keyword) !== -1) ||
                            (oLinesJson.indexOf(keyword) !== -1);
      if (!matchesEstimate) continue;

      // メーカー抽出: 明細JSONを優先（複数行ある場合に全メーカー取得可能）
      if (oLinesJson) {
        try {
          var oLines = JSON.parse(oLinesJson);
          if (Array.isArray(oLines)) {
            for (var li = 0; li < oLines.length; li++) {
              var lnMk = oLines[li] && oLines[li].maker;
              if (lnMk && orderedMakers.indexOf(lnMk) === -1) orderedMakers.push(String(lnMk));
            }
          }
        } catch (e) { Logger.log('orderedMakers JSON parse error: ' + e.toString()); }
      }
      // 補助: notes の "メーカー: XXX" もパース
      var makerMatch = oNotes.match(/メーカー[:：]\s*([^\s\/]+)/);
      if (makerMatch && makerMatch[1]) {
        var mk = makerMatch[1].trim();
        if (orderedMakers.indexOf(mk) === -1) orderedMakers.push(mk);
      }
    }
  }

  return {
    success: true,
    estimateNo: data[rowIdx][1],
    estimateDate: data[rowIdx][2],
    customerName: data[rowIdx][3],
    subject: data[rowIdx][4],
    staff: data[rowIdx][5],          // 担当者 → 発注書の注文者に使う
    branch: data[rowIdx][15] || '本社',
    notes: data[rowIdx][16] || '',
    lines: lines,
    orderedMakers: orderedMakers     // 既に発注済みのメーカー一覧（二重発注防止用）
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
      if (currentStatus !== '承認済' && currentStatus !== '緊急承認済' && currentStatus !== '自己発注' && currentStatus !== '営業自己発注') {
        return { success: false, error: '承認済または自己発注の発注のみ完了にできます (現在: ' + currentStatus + ')' };
      }
      applyStatusColor(s, i + 1, '発注済');
      // 発注完了日を Q列(17) に記録
      try {
        var completedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
        s.getRange(i + 1, 17).setValue(completedAt);
      } catch(e) { Logger.log('発注完了日書込エラー: ' + e.toString()); }
      // ★ 2026-06-04: 発注完了したこのタイミングで在庫管理へ商品を展開(申請中では出さない)。
      //   発注一覧の行から data を復元して addToStockSheet に渡す。ステータスは完了前の状態から導出。
      try {
        var reconLines = [];
        try { reconLines = JSON.parse(data[i][13] || '[]'); } catch(e2) {}
        var reconData = {
          orderNo: data[i][1], supplier: data[i][3], branch: data[i][4],
          siteName: data[i][5], orderer: data[i][7],
          urgent: (String(data[i][8]) === '緊急'),
          selfOrder: (currentStatus === '自己発注' || currentStatus === '営業自己発注'),
          lines: reconLines
        };
        addToStockSheet(ss, reconData, data[i][11] || '');
      } catch(e) { Logger.log('在庫管理 発注完了追記エラー: ' + e.toString()); }
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

// ★ 2026-07-13: 承認後・直接発注後の発注を「一覧から取消」(記録を残す)。60秒制限なし・タブは非表示(削除しない)。
//   申請中は既存の却下で対応。取消/却下済みは対象外。doGet ?action=cancelApprovedOrder&id=...&reason=...
function cancelApprovedOrder(id, reason) {
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
  var status = String(data[rowIdx][10] || '').trim();
  var CANCELLABLE = { '承認済': 1, '発注済': 1, '自己発注': 1, '営業自己発注': 1, '緊急承認済': 1 };
  if (status === '申請中') return { success: false, error: '申請中は「却下」で対応してください' };
  if (status === '取消' || status === '却下') return { success: false, error: '既に' + status + '済みです' };
  if (!CANCELLABLE[status]) return { success: false, error: '取消できないステータスです(' + status + ')' };

  var orderNo = data[rowIdx][1];
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  // 1. ステータス → 取消 (K列)
  applyStatusColor(s, rowIdx + 1, '取消');
  // 2. 記録を残す: K列(ステータス)セルに 取消日時・元ステータス・理由 をメモ
  try {
    var note = '🗑取消 ' + now + '（元: ' + status + '）' + (reason ? '\n理由: ' + reason : '');
    s.getRange(rowIdx + 1, 11).setNote(note);
  } catch (e) { Logger.log('取消メモ書込エラー: ' + e.toString()); }
  // 3. 発注書タブは非表示(削除しない=記録保持)
  try {
    var sheet = findSheetByUrl(ss, data[rowIdx][11]);
    if (sheet && !sheet.isSheetHidden()) sheet.hideSheet();
  } catch (e) { Logger.log('取消タブ非表示エラー: ' + e.toString()); }
  // 4. 在庫管理に展開済み(発注済)なら、その注文Noの行を「取消」表示に(事務員が受領しないよう)
  try {
    _existingStockSheets(ss).forEach(function (stock) {  // ★ 2026-08-21: 拠点別両タブを走査
      var sv = stock.getDataRange().getValues();
      for (var k = 1; k < sv.length; k++) {
        if (String(sv[k][1]).trim() === String(orderNo).trim()) {
          stock.getRange(k + 1, 15).setValue('取消').setFontColor('#c5221f').setFontWeight('bold');  // O列=ステータス
        }
      }
    });
  } catch (e) { Logger.log('在庫管理 取消反映エラー: ' + e.toString()); }

  return { success: true, message: 'No.' + orderNo + ' を取消しました（記録は残ります）', orderNo: orderNo };
}

// ============ API: シートのPDFをBase64で返す ============
// 非表示シートにも対応（一時的に表示→取得→非表示に戻す）
function getSheetPdfBase64(gid) {
  if (!gid) return { success: false, error: 'gidが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var gidNum = parseInt(gid);
  var targetSheet = null;
  var wasHidden = false;

  // 対象シートを特定し、非表示なら一時的に表示
  try {
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === gidNum) {
        targetSheet = sheets[i];
        if (targetSheet.isSheetHidden()) {
          wasHidden = true;
          targetSheet.showSheet();
          SpreadsheetApp.flush(); // 表示化を確実に反映
        }
        break;
      }
    }
  } catch(e) { Logger.log('シート特定エラー: ' + e.toString()); }

  try {
    var ssId = ss.getId();
    // ★ v96: scale=4 は Sheets export で無効だったため fitw=true(幅合わせ)に戻す。
    //   根本対策は列幅をA4幅に収めること(shrinkColumnsToA4)。列幅が収まれば fitw で等倍表示になる。
    //   range=A1:AQ64 (注文者枠=AJ61:AM64結合の底=行64まで含める)
    var url = 'https://docs.google.com/spreadsheets/d/' + ssId +
              '/export?format=pdf&gid=' + gid +
              '&range=A1:AQ64' +
              '&portrait=true&size=A4&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenum=false&fzr=false' +
              '&top_margin=0.3&bottom_margin=0.3&left_margin=0.3&right_margin=0.3';
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
  } finally {
    // 元々非表示だったら再度非表示に戻す
    if (wasHidden && targetSheet) {
      try { targetSheet.hideSheet(); } catch(e) { Logger.log('再非表示失敗: ' + e.toString()); }
    }
  }
}

// ============ API: 見積書の詳細取得（編集モーダル用） ============
function getEstimateDetails(id) {
  if (!id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) return { success: false, error: '見積一覧がありません' };
  var data = s.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) {
      var linesJson = data[i][14] || '[]';
      var lines = [];
      try { lines = JSON.parse(linesJson); } catch(e) { lines = []; }
      return {
        success: true,
        data: {
          id: id,
          estimateNo: data[i][1],
          estimateDate: _dateToYmd(data[i][2]),
          customerName: data[i][3],
          subject: data[i][4],
          staff: data[i][5],
          grandTotal: data[i][6],
          subtotal: data[i][7],
          costTotal: data[i][8],
          margin: data[i][9],
          status: data[i][10],
          sheetUrl: data[i][11],
          lines: lines,
          branch: data[i][15] || '本社',
          notes: data[i][16] || ''
        }
      };
    }
  }
  return { success: false, error: '見積書が見つかりません' };
}

// ============ API: 発注書の詳細取得（編集モーダル用） ============
function getOrderDetails(id) {
  if (!id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: false, error: '発注一覧がありません' };
  var data = s.getDataRange().getValues();
  var opCol = _findColumnByHeader(s, '発注者');  // 発注者列(引用複製で使用・ヘッダー名検索)
  for (var i = 1; i < data.length; i++) {
    if (data[i][12] === id) {
      var linesJson = data[i][13] || '[]';
      var lines = [];
      try { lines = JSON.parse(linesJson); } catch(e) { lines = []; }
      return {
        success: true,
        data: {
          id: id,
          orderNo: data[i][1],
          issueDate: _dateToYmd(data[i][2]),
          supplier: data[i][3],
          branch: data[i][4],
          siteName: data[i][5],
          total: data[i][6],
          orderer: data[i][7],
          urgent: data[i][8] === '緊急',
          approverName: data[i][9],
          status: data[i][10],
          sheetUrl: data[i][11],
          lines: lines,
          notes: data[i][14] || '',
          orderPersonName: (opCol > 0 && data[i][opCol - 1]) ? data[i][opCol - 1] : ''
        }
      };
    }
  }
  return { success: false, error: '発注書が見つかりません' };
}

// 日付を YYYY-MM-DD 文字列に
function _dateToYmd(d) {
  if (!d) return '';
  if (typeof d === 'string') {
    var m = d.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    return d;
  }
  try {
    return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
  } catch(e) { return String(d); }
}

// ============ API: 見積書を更新 ============
function updateEstimate(data) {
  if (!data.id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(EST_INDEX_SHEET);
  if (!s) return { success: false, error: '見積一覧がありません' };
  var rows = s.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][12] === data.id) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return { success: false, error: '見積書が見つかりません' };

  // ステータスチェック: 発注済のものは編集不可
  var status = rows[rowIdx][10];
  if (status === '発注済') return { success: false, error: '発注済みの見積書は編集できません' };

  // 明細の再計算
  var lines = data.lines || [];
  var subtotal = 0, costTotal = 0;
  for (var li = 0; li < lines.length; li++) {
    var ln = lines[li];
    var marginDec = (ln.marginRate || 0) / 100;
    var selling = calcSellingPrice(ln.cost || 0, marginDec, ln.rounding || '0');
    ln.sellingPrice = selling;
    ln.amount = selling * (ln.qty || 0);
    var lineCost = (ln.zeroCost === true) ? 0 : ((ln.cost || 0) * (ln.qty || 0));
    if ((ln.cost || 0) < 0) lineCost = 0;
    ln.costAmount = lineCost;
    ln.actualMargin = lineCost > 0 ? Math.round(((ln.amount - lineCost) / lineCost) * 1000) / 1000 : 0;
    ln.profit = ln.amount - lineCost;
    subtotal += ln.amount;
    costTotal += lineCost;
  }
  var tax = Math.floor(subtotal * 0.1);
  var grandTotal = subtotal + tax;
  var overallMargin = costTotal > 0 ? Math.round((subtotal - costTotal) / costTotal * 1000) / 1000 : 0;
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  // 該当行を更新（C〜Q列）
  var r = rowIdx + 1;
  s.getRange(r, 3).setValue(data.estimateDate || '');
  s.getRange(r, 4).setValue(data.customerName || '');
  s.getRange(r, 5).setValue(data.subject || '');
  s.getRange(r, 6).setValue(data.staff || '');
  s.getRange(r, 7).setValue(grandTotal);
  s.getRange(r, 8).setValue(subtotal);
  s.getRange(r, 9).setValue(costTotal);
  s.getRange(r, 10).setValue(overallMargin);
  s.getRange(r, 15).setValue(JSON.stringify(lines));
  s.getRange(r, 16).setValue(data.branch || '本社');
  s.getRange(r, 17).setValue(data.notes || '');
  s.getRange(r, 18).setValue(now);

  return {
    success: true,
    message: '見積書を更新しました',
    grandTotal: grandTotal,
    subtotal: subtotal,
    costTotal: costTotal
  };
}

// ============ API: 発注書を更新 ============
function updateOrder(data) {
  if (!data.id) return { success: false, error: 'IDが必要です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: false, error: '発注一覧がありません' };
  var rows = s.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][12] === data.id) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return { success: false, error: '発注書が見つかりません' };

  // ステータスチェック: 申請中のみ編集可能
  var status = rows[rowIdx][10];
  if (status !== '申請中') return { success: false, error: '申請中の発注書のみ編集できます（現在: ' + status + '）' };

  // 明細の合計再計算
  var lines = data.lines || [];
  var total = 0;
  for (var li = 0; li < lines.length; li++) {
    var ln = lines[li];
    var amount = (ln.qty || 0) * (ln.price || 0);
    ln.amount = amount;
    total += amount;
  }
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  var r = rowIdx + 1;
  s.getRange(r, 3).setValue(data.issueDate || '');
  s.getRange(r, 4).setValue(data.supplier || '');
  s.getRange(r, 5).setValue(data.branch || '');
  s.getRange(r, 6).setValue(data.siteName || '');
  s.getRange(r, 7).setValue(total);
  s.getRange(r, 8).setValue(data.orderer || '');
  s.getRange(r, 14).setValue(JSON.stringify(lines));
  s.getRange(r, 15).setValue(data.notes || '');
  s.getRange(r, 16).setValue(now);
  // ★ 2026-05-29: 明細変更に伴い 高額単価・無償フラグを再計算。ヘッダー名で列を探して書く
  var flags = _calcOrderFlags(lines);
  _writeFlagByHeader(s, r, '高額単価(10万超)', flags.highPrice, '#d93025');
  _writeFlagByHeader(s, r, '無償(M)', flags.free, '#1a73e8');

  return {
    success: true,
    message: '発注書を更新しました',
    total: total
  };
}

// ============ API: IDベースのPDF生成（NEW_FLOW用 - 一時シート生成→PDF→削除） ============
function getPdfById(id, type) {
  if (!id) return { success: false, error: 'IDが必要です' };
  // 発注専用化（2026-05-12）: type='estimate' は無効
  if (type !== 'order') return { success: false, error: '発注書以外のPDF出力は無効です' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var details = getOrderDetails(id);
  var tplCandidates = PO_TEMPLATE_CANDIDATES;
  var fillFunc = _fillOrderTemplate;
  if (!details.success) return details;

  // 既にシートがある場合（旧フロー）はgidから直接PDF
  var existingUrl = details.data.sheetUrl;
  if (existingUrl) {
    var m = existingUrl.match(/gid=(\d+)/);
    if (m) {
      var pdfRes = getSheetPdfBase64(m[1]);
      // PDF成功時は対応するシート名を filename として付与（ダウンロード時のファイル名に使用）
      if (pdfRes && pdfRes.success) {
        var sheetsAll = ss.getSheets();
        for (var si = 0; si < sheetsAll.length; si++) {
          if (String(sheetsAll[si].getSheetId()) === String(m[1])) {
            pdfRes.filename = sheetsAll[si].getName();
            break;
          }
        }
      }
      return pdfRes;
    }
  }

  // 一時シート生成
  var tpl = findTemplateSheet(ss, tplCandidates);
  if (!tpl) return { success: false, error: 'テンプレートが見つかりません' };
  var tmp = tpl.copyTo(ss);
  var tmpName = '_pdf_temp_' + Utilities.getUuid().substring(0, 8);
  tmp.setName(tmpName);

  try {
    // データを埋め込む
    fillFunc(tmp, details.data);
    SpreadsheetApp.flush();
    // PDF取得
    var result = getSheetPdfBase64(tmp.getSheetId());
    // NEW_FLOW（一時シート）の場合は、対応する番号でファイル名を組み立てる
    if (result && result.success) {
      if (type === 'order') {
        result.filename = (details.data.issueDate ? String(details.data.issueDate).replace(/-/g,'') + '_' : '')
          + (details.data.orderer || '') + (details.data.siteName ? '_' + details.data.siteName : '');
      } else {
        result.filename = '見積_' + (details.data.estimateDate ? String(details.data.estimateDate).replace(/-/g,'') : '')
          + (details.data.customerName ? '_' + details.data.customerName : '')
          + (details.data.staff ? '_' + details.data.staff : '');
      }
    }
    return result;
  } finally {
    // 一時シートを削除
    try { ss.deleteSheet(tmp); } catch(e) { Logger.log('一時シート削除失敗: ' + e.toString()); }
  }
}

// 見積テンプレートにデータを埋め込む
function _fillEstimateTemplate(sh, data) {
  var d = (data.estimateDate || '').split('-');
  try { if (d.length === 3) sh.getRange('I1').setValue(new Date(parseInt(d[0]), parseInt(d[1])-1, parseInt(d[2]))); } catch(e) {}  // I1: 発行日値
  try { sh.getRange('I2').setValue(data.estimateNo || ''); } catch(e) {}
  try { sh.getRange('A4').setValue(data.customerName || ''); } catch(e) {}
  try { sh.getRange('J5').setValue(data.branch || '本社'); } catch(e) {}                    // J5: 事業所名
  try { sh.getRange('I10').setValue(data.staff || ''); } catch(e) {}
  if (data.subject) try { sh.getRange('C9').setValue(data.subject); } catch(e) {}

  // 事業所に応じた住所を G7 セルに書き込み（テンプレ確認済み）
  var bi = getBranchInfo(data.branch || '本社');
  var branchLabel = (data.branch === '福岡店') ? '▽福岡' :
                     (data.branch === '飯塚ガスセンター') ? '▽飯塚ガスセンター' : '▽本社';
  var addressBlock = branchLabel + '\n' + bi.zip + '\n' + bi.addr + '\n' + bi.tel + ' ' + bi.fax;
  try { sh.getRange('G7').setValue(addressBlock); } catch(e) {}

  // 明細（A=No. B=メーカー C=品名 D=型式 E=数量 F=単位 G=単価 H=金額 I=備考）
  var lines = data.lines || [];
  var subtotal = 0;
  for (var idx = 0; idx < 18; idx++) {
    var r = 15 + idx;
    var ln = lines[idx];
    if (ln) {
      try { sh.getRange(r, 1).setValue(idx + 1); } catch(e) {}
      try { sh.getRange(r, 2).setValue(ln.maker || ''); } catch(e) {}                                    // B: メーカー
      try { sh.getRange(r, 3).setValue(ln.product || ''); } catch(e) {}                                  // C: 品名
      try { sh.getRange(r, 4).setValue(ln.model || ''); } catch(e) {}                                    // D: 型式
      try { sh.getRange(r, 5).setValue(ln.qty || 0); } catch(e) {}                                       // E: 数量
      try { sh.getRange(r, 6).setValue(ln.unit || '台'); } catch(e) {}                                   // F: 単位
      try { sh.getRange(r, 7).setValue(ln.sellingPrice || 0).setNumberFormat('#,##0'); } catch(e) {}     // G: 単価
      try { sh.getRange(r, 8).setValue(ln.amount || 0).setNumberFormat('#,##0'); } catch(e) {}           // H: 金額
      try { sh.getRange(r, 9).setValue(''); } catch(e) {}                                                // I: 備考（空）
      subtotal += (ln.amount || 0);
    }
  }
  var tax = Math.floor(subtotal * 0.1);
  var grandTotal = subtotal + tax;
  try { sh.getRange('H33').setValue(subtotal).setNumberFormat('#,##0'); } catch(e) {}
  try { sh.getRange('H34').setValue(tax).setNumberFormat('#,##0'); } catch(e) {}
  try { sh.getRange('H35').setValue(grandTotal).setNumberFormat('#,##0'); } catch(e) {}
  try { sh.getRange('C7').setValue(grandTotal).setNumberFormat('#,##0"円"'); } catch(e) {}
  if (data.notes) try { sh.getRange('B36').setValue(data.notes); } catch(e) {}
}

// 発注テンプレートにデータを埋め込む
function _fillOrderTemplate(sh, data) {
  var bi = getBranchInfo(data.branch);
  var d = (data.issueDate || '').split('-');

  try { if (d.length === 3) { sh.getRange('AH1').setValue(parseInt(d[0])); sh.getRange('AL1').setValue(parseInt(d[1])); sh.getRange('AO1').setValue(parseInt(d[2])); } } catch(e) {}
  try { sh.getRange('AH3').setValue(data.orderNo); } catch(e) {}
  try { sh.getRange('A9').setValue(data.supplier); } catch(e) {}
  try { sh.getRange('AL12').setValue(data.branch); } catch(e) {}
  // 住所/TEL は結合主セル Z12/Z13/Z14 に直接書く
  try { sh.getRange('Z12').setValue(bi.zip); } catch(e) {}
  try { sh.getRange('Z13').setValue(bi.addr); } catch(e) {}
  try { sh.getRange('Z14').setValue(bi.tel + ' ' + bi.fax); } catch(e) {}
  // テンプレに残っている古い TEL/FAX をクリア
  try { sh.getRange('AB13').setValue(''); } catch(e) {}
  try { sh.getRange('AB14').setValue(''); } catch(e) {}
  try { sh.getRange('AB15').setValue(''); } catch(e) {}

  var lines = data.lines || [];
  // 明細は2行結合なので idx*2 で2行ステップ
  for (var idx = 0; idx < 8; idx++) {
    var r = 18 + idx * 2;
    var ln = lines[idx];
    if (ln && ln.maker) {
      try { sh.getRange('A'+r).setValue(idx+1); } catch(e) {}
      try { sh.getRange('C'+r).setValue(ln.maker); } catch(e) {}
      try { sh.getRange('H'+r).setValue(ln.product); } catch(e) {}
      try { sh.getRange('P'+r).setValue(ln.model||''); } catch(e) {}
      try { sh.getRange('Z'+r).setValue(ln.qty); } catch(e) {}
      try { sh.getRange('AB'+r).setValue(ln.price); } catch(e) {}
      try { sh.getRange('AG'+r).setValue((ln.qty||0)*(ln.price||0)); } catch(e) {}
      try { sh.getRange('AL'+r).setValue(ln.remark||''); } catch(e) {}
    }
  }
  try { sh.getRange('AG49').setValue(data.total || 0); } catch(e) {}
  // 51行は「納入先」行。F51 にユーザー入力の納品先を書く（L51/P51 は空でクリア）
  try { sh.getRange('F51').setValue(data.deliveryPlace || ''); } catch(e) {}
  try { sh.getRange('L51').setValue(''); } catch(e) {}
  try { sh.getRange('P51').setValue(''); } catch(e) {}
  // 53行は「請求先」行。本社/福岡店の○マーク（debug確認: F53=本社○,J53=福岡店○）
  try { sh.getRange('F53').setValue(data.branch==='本社'?'○':''); } catch(e) {}
  try { sh.getRange('J53').setValue(data.branch==='福岡店'||data.branch==='飯塚ガスセンター'?'○':''); } catch(e) {}
  try { sh.getRange('L53').setValue(''); } catch(e) {}
  var today = new Date();
  // 納入希望日（R53=月、V53=日）
  if (data.deliveryDate) {
    var dParts = String(data.deliveryDate).split('-');
    if (dParts.length === 3) {
      try { sh.getRange('R53').setValue(parseInt(dParts[1])); } catch(e) {}
      try { sh.getRange('V53').setValue(parseInt(dParts[2])); } catch(e) {}
    }
  } else {
    try { sh.getRange('R53').setValue(''); } catch(e) {}
    try { sh.getRange('V53').setValue(''); } catch(e) {}
  }
  // 納品先は上の F51 で書き込み済み
  // 現場名（件名）F55 結合主セル
  try { sh.getRange('F55').setValue(data.siteName||''); } catch(e) {}
  try { sh.getRange('D55').setValue(''); } catch(e) {}
  // 特記事項は廃止（商品毎の備考に置き換え）
  try { sh.getRange('C58').setValue(''); } catch(e) {}
  try { sh.getRange('AJ60').setValue(data.orderer); } catch(e) {}
  try { sh.getRange('AF66').setValue(data.urgent?'緊急':'PASS'); } catch(e) {}
}

// _hideEstimateAll は 2026-05-12 の見積シート非表示化作業で使用し、削除済み。
// 復元時に再度シートを非表示にしたい場合は docs/RESTORE_ESTIMATE.md の手順参照

// ============ DEPRECATED 一時: 最新発注書の全データ確認 ============
function __unused_debugLatest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INDEX_SHEET);
  if (!s) return { success: false, error: '発注一覧なし' };
  var data = s.getDataRange().getValues();
  if (data.length < 2) return { success: false, error: 'データなし' };
  var last = data[data.length - 1];
  // 個別シート（最新の20260514_など）の明細書き込み行 18-22 を確認
  var sheets = ss.getSheets();
  var target = null;
  for (var j = sheets.length - 1; j >= 0; j--) {
    if (/^\d{8}_/.test(sheets[j].getName()) && !sheets[j].isSheetHidden()) {
      target = sheets[j]; break;
    }
  }
  var rows = [];
  if (target) {
    for (var r = 18; r <= 22; r++) {
      ['A','C','H','P','Z','AB','AG','AL'].forEach(function(col) {
        var v = target.getRange(col + r).getValue();
        if (v !== '' && v !== null) rows.push(col + r + '=' + String(v).substring(0, 30));
      });
    }
    // 現場名 D55
    var siteName = target.getRange('D55').getValue();
    rows.push('D55=' + String(siteName));
  }
  return {
    success: true,
    sheetName: target ? target.getName() : null,
    listOrderNo: last[1],
    listSiteName: last[5],  // F列 = 現場名
    linesJsonRaw: String(last[13] || '').substring(0, 1000),
    sheetRows: rows
  };
}

// ============ DEPRECATED ============
function __unused_debug55() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tpl = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!tpl) return { success: false, error: 'テンプレなし' };
  var merged = [];
  var mr = tpl.getRange('A55:AT56').getMergedRanges();
  for (var i = 0; i < mr.length; i++) merged.push(mr[i].getA1Notation());
  // 各セルの値
  var cells = [];
  for (var c = 1; c <= 26; c++) {
    var col = String.fromCharCode(64 + c);
    [55, 56].forEach(function(r) {
      var v = tpl.getRange(col + r).getValue();
      if (v !== '' && v !== null) cells.push(col + r + '=' + JSON.stringify(v));
    });
  }
  return { success: true, mergedRanges: merged, cells: cells };
}

// ============ DEPRECATED ============
function __unused_debugDetail() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tpl = findTemplateSheet(ss, PO_TEMPLATE_CANDIDATES);
  if (!tpl) return { success: false, error: 'テンプレなし' };
  // 18-30行で明細書き込み位置 A,C,H,P,Z,AB,AG,AL の値を取得
  var cells = [];
  var mergedRanges = tpl.getRange('A18:AT30').getMergedRanges();
  var merged = [];
  for (var i = 0; i < mergedRanges.length; i++) {
    merged.push(mergedRanges[i].getA1Notation());
  }
  // 同時に各行の高さ確認
  var rowH = [];
  for (var r = 18; r <= 30; r++) {
    rowH.push('r' + r + 'h=' + tpl.getRowHeight(r));
  }
  // D55 の場所も確認
  var d55Merged = '';
  var d55Range = tpl.getRange('D55');
  if (d55Range.isPartOfMerge()) {
    d55Merged = d55Range.getMergedRanges()[0].getA1Notation();
  }
  return {
    success: true,
    mergedRanges: merged.slice(0, 30),
    rowHeights: rowH,
    d55MergedAt: d55Merged
  };
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
