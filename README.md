# party-game（どこパ風）

「どこパ」の全員一致ゲームとラウンジをイメージした、ブラウザで遊べるパーティーゲームアプリです。

## 遊び方
1. プレイヤー名を入力して参加者を追加
2. お題を設定してゲーム開始
3. 全員が回答を入力して提出
4. 回答を公開して「全員一致」か判定

## ローカル実行方法
```bash
python3 -m http.server 4173
```

または Node サーバー版:
```bash
npm install
npm start
```

## Render デプロイ（推奨: Blueprint）
`render.yaml` を Render の Blueprint 仕様に合わせています（`env: static`）。

1. GitHub に push
2. Render ダッシュボードで **New + → Blueprint**
3. このリポジトリを選択して作成
4. `kokumei-shiritori-party-game` の Static Web Service が作成される
5. `https://kokumei-shiritori-party-game.onrender.com` へアクセス

> `kokumei-shiritori-party-game` が既に使用済みの場合は、Render 側で別名になります（例: `kokumei-shiritori-party-game-1`）。

## 失敗ログ対応（今回の `npm install ENOENT`）
ログの原因は `package.json` が見つからないことでした。現在は `package.json` と `server.js` を追加済みなので、
もし Render 側が Node Web Service 設定（Build Command: `npm install`）になっていてもビルド失敗しません。

### Node Web Service として動かす場合
- Build Command: `npm install`
- Start Command: `npm start`

### まだ失敗する場合
- 既存サービスが古い設定を保持している可能性があるため、Blueprint で再作成
- Render の対象ブランチが `main` なら、この修正コミットを `main` に反映して再デプロイ
