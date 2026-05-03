# dayplanner-pwa

iPhone PWA。デイプランナー：1日のスケジュール + メモを1画面に集約。

## ユーザー
日本語。非エンジニア。略称・専門用語は避けて日本語で説明。
危険操作（金銭/秘密情報/破壊的）以外は確認なしで進めて良い。

## 構成
- フロント: 素のHTML/CSS/JS（フレームワークなし）。ビルド工程なし。
- 公開: Vercel自動デプロイ（mainにpush → 1〜2分後反映）
- データ: localStorage（日付ごとに `dp_tasks_YYYY-MM-DD` / `dp_todo_YYYY-MM-DD`）
- ローカル開発: `python3 -m http.server 3335 --directory public`

## ファイル
- `public/index.html` - シェル
- `public/js/app.js` - 全機能（renderSchedule / renderForm / etc.）
- `public/css/style.css` - スタイル（iOS風ライトテーマ）
- `public/sw.js` - Service Worker（network-first + 自動更新）
- `public/manifest.json` - PWA設定

## 主要機能
- スケジュール: 時間設定 + 重さ(軽い/普通/重い) + アラーム + 完了チェック
- 完了タスクは10秒後に自動非表示 → 「📂 完了履歴」から復元可
- メモ: 時間未定の備忘録。Enterで追加、🕐で時間設定 → スケジュール化
- 達成率バッジ（タイトル横に小さく）
- 候補機能: 過去のタスク名を頻度順サジェスト

## デプロイ
git push origin main → Vercelが自動でビルド/公開。確認URLは Vercel dashboard。

## UI方針
- iOS風ライトテーマ（白ベース・赤アクセント）
- 1画面で完結（タブなし）
- 余白多めで見やすく
- 上80%=スケジュール / 下20%=追加+メモ

## 既知の注意点
- toISOString() は UTC 変換でJSTから日付がズレる → 必ず `getFullYear/Month/Date` でローカル組立
- Service Worker のキャッシュはバージョン文字列で更新。app.jsを変えたら sw.js のキャッシュ名も更新
- iOS PWAのプライベートブラウジングではlocalStorage使用不可
