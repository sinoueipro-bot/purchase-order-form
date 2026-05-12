# 見積書機能 復元手順

> このドキュメントは「発注専用化（2026-05-12）」で削除された **見積書機能** を将来的に復元するための手順書です。

---

## 削除時の状況

- **削除日**: 2026-05-12
- **削除前の最終コミット**: `2cd3f13` （fix: 日付をI1に・見積No.をI2に書き込み）
- **削除理由**: システムをシンプルに保つため、発注書機能のみに絞った
- **削除内容**:
  - HTML: 見積タブ、見積フォーム、メーカー別一括発注、未発注見積フィルタ、見積一覧表示など
  - GAS: `processEstimate` / `createEstimate*` / `getEstimateData` / `quickTransferToPO` / `batchTransferToPO` / `calcSellingPrice` 等
  - スプシ: 「見積一覧」「見積書(テンプレート)」「個別の見積_xxxx シート」は **非表示で残存**（データ削除なし）

---

## 復元ポイント（3重バックアップ）

### ① Gitタグ
```
v-with-estimate-2026-05-12
```
削除直前の完全な状態のスナップショット。

### ② アーカイブブランチ
```
archive/with-estimate
```
main から独立した別ブランチ。GitHub にも push 済み。

### ③ スプシのデータ
シートは非表示で物理的に残っているため、復元時はすぐに再表示すれば中身が使える。

---

## 復元手順（3つの方法）

### 方法A: 完全復元（推奨）

削除前の状態にすべて戻す:

```bash
cd 'C:/Users/ABC/Searches/purchase-order-gas'

# 1. アーカイブブランチからファイル復元
git checkout archive/with-estimate -- Code.gs index.html

# 2. 確認
git diff main --stat

# 3. コミット
git add Code.gs index.html
git commit -m "feat: 見積書機能を復元（archive/with-estimate から復旧）"

# 4. デプロイ
clasp push -f
clasp deploy --deploymentId AKfycbzqBN_Kj3hMVwrSBo7tF_B2hq6oU3uugBUGbj0Gf1-cBHs4vzDR5koS-5KRwCMFUcAO0Q --description "見積書機能を復元"

# 5. push
git push origin main
```

### 方法B: タグから復元

特定のバージョンに戻したい場合:

```bash
cd 'C:/Users/ABC/Searches/purchase-order-gas'
git checkout v-with-estimate-2026-05-12 -- Code.gs index.html
git add Code.gs index.html
git commit -m "feat: タグ v-with-estimate-2026-05-12 から見積書機能を復元"
clasp push -f
clasp deploy --deploymentId AKfycbzqBN_Kj3hMVwrSBo7tF_B2hq6oU3uugBUGbj0Gf1-cBHs4vzDR5koS-5KRwCMFUcAO0Q --description "見積書機能を復元"
git push origin main
```

### 方法C: 部分復元（特定の機能だけ取り出す）

例えば「メーカー別発注」だけ復活させたい場合:

```bash
# 1. アーカイブブランチを参照しつつ、関数だけコピペで取り出す
git show archive/with-estimate:Code.gs > /tmp/old_code.gs
# /tmp/old_code.gs から必要な関数だけコピー
```

---

## 復元後の追加作業

### ① スプシのシート再表示

GAS エディタで以下の関数を実行:

```js
function showHiddenEstimateSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var keep = ['見積一覧', '見積書(テンプレート)'];
  var sheets = ss.getSheets();
  sheets.forEach(function(s) {
    var name = s.getName();
    if (keep.indexOf(name) !== -1 || name.indexOf('見積_') === 0) {
      if (s.isSheetHidden()) {
        try { s.showSheet(); } catch(e) {}
      }
    }
  });
}
```

または、スプシ画面でメニュー「表示 → 非表示のシート」から手動で表示。

### ② テスト

復元前と同じテストシナリオで動作確認:
- 見積書作成
- メーカー別発注
- 見積→発注転記
- PDF出力

---

## 関連リンク

- **GitHub リポジトリ**: https://github.com/sinoueipro-bot/purchase-order-form
- **アーカイブブランチ**: https://github.com/sinoueipro-bot/purchase-order-form/tree/archive/with-estimate
- **タグ**: https://github.com/sinoueipro-bot/purchase-order-form/releases/tag/v-with-estimate-2026-05-12
- **GASプロジェクト**: https://script.google.com/u/0/home/projects/1Zf3zGp9Gg1uZm_nppeomgfnu2X3W1YCEsIcbIDZbio1BYWI4RpHLUUaP/edit
- **スプシ**: https://docs.google.com/spreadsheets/d/1l2eJD1SSJY7s0Y8GW4l-x4F7dLnOvwQJ1ieDn5GFj9s/edit

---

## 補足: 削除前の主要機能リスト

復元する場合、以下の機能が戻ります:

### 見積書フォーム
- お客様情報入力ウィザード（3ステップ）
- 商品明細入力（メーカー/品名/型式/数量/単位/原価/粗利率）
- 売値自動計算（`calcSellingPrice` / `calcSellingPriceJS`）
- 特記事項
- PDF出力

### 見積→発注転記
- ワンクリック発注（`quickTransferToPO`）
- メーカー別一括発注（`batchTransferToPO`）
- 既発注メーカーの二重発注防止
- 現場名・注文者・事業所の自動引き継ぎ

### 見積一覧
- 「未発注見積」フィルタボタン
- 編集モーダル
- 発注済ステータス更新

### スプシ構造
- 見積一覧シート（A〜R列、18列構成）
- 見積書(テンプレート)シート
- 個別見積書シート（`見積_YYYYMMDD_お客様名_担当者`）
