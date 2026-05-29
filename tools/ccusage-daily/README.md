# ccusage-daily — Claude Code トークン使用量の日次記録

Max プラン（定額）で Claude Code を使っていると、実際の請求は定額なので
「どれだけ使ったか」「従量課金だったらいくらだったか」が見えにくい。

このツールは、**手元の Mac で毎日 `ccusage` を実行**してトークン使用量と
**従量課金換算コスト**を集計し、**GitHub リポジトリに push** して後から
どこでも（クラウド含め）見返せるようにする。

## なぜローカル実行なのか

`ccusage` はローカルログ `~/.claude/projects/*.jsonl` を読む。このログは
Claude Code を実行したマシンに溜まるため、収集は手元 Mac で行う必要がある。
さらにログは `cleanupPeriodDays`（既定 30 日）で自動削除されるので、
**毎日スナップショットを残して git 履歴に蓄積する**ことに意味がある。

> 注: `ccusage` の「コスト」はサブスクを無視し、トークン量 × 従量課金単価で
> 算出した**推定額**。Max ユーザーにとっては「従量課金ならいくらか」の逆算値。

## 構成

| ファイル | 役割 |
|---|---|
| `collect.sh` | `ccusage daily --json` を実行 → マージ → commit & push |
| `merge.mjs` | 日次データを日付キーで累積 JSON / CSV にマージ（Node、依存なし） |
| `com.user.ccusage-daily.plist` | launchd で毎日 09:00 に実行する設定 |

出力（データ用リポジトリ側）:
- `data/usage.json` … 全日分の累積（日付キー）
- `data/usage.csv` … 同内容のフラット CSV（表計算で開ける）
- `data/snapshot-YYYY-MM-DD.json` … その日の生スナップショット

## セットアップ（macOS）

### 1. データ保存用の GitHub リポジトリを用意

使用量を貯めるリポジトリをひとつ作り、手元にクローンする（例）:

```bash
# GitHub 上に空リポジトリ claude-usage-log を作成しておく
git clone git@github.com:<YOUR_NAME>/claude-usage-log.git ~/claude-usage-log
```

> このツール本体（`tools/ccusage-daily/`）の置き場と、データの push 先は
> 別リポジトリにするのがおすすめ（履歴がノイズにならない）。同じリポジトリでも可。

### 2. スクリプトに実行権限を付与

```bash
chmod +x tools/ccusage-daily/collect.sh
```

### 3. 手動で 1 回テスト

```bash
USAGE_REPO_DIR=~/claude-usage-log \
  tools/ccusage-daily/collect.sh
```

`data/usage.csv` が更新され、push されれば成功。

### 4. 毎日自動実行（launchd）

```bash
# plist 内の REPLACE_ME 2 か所（collect.sh の絶対パス / USAGE_REPO_DIR）を編集してから:
cp tools/ccusage-daily/com.user.ccusage-daily.plist \
   ~/Library/LaunchAgents/com.user.ccusage-daily.plist
launchctl load ~/Library/LaunchAgents/com.user.ccusage-daily.plist
```

ログは `/tmp/ccusage-daily.out.log` / `/tmp/ccusage-daily.err.log`。

停止:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.ccusage-daily.plist
```

## 後から見返す

- `data/usage.csv` を GitHub 上でそのまま閲覧 / ダウンロード
- 期間や月次を見たいときは手元で `npx ccusage@latest monthly` 等も併用

## 注意

- `~/Library/LaunchAgents` の launchd は**ログイン中のみ**動作する。常時稼働させたい
  なら別途サーバ等が必要だが、個人利用なら通常これで十分。
- push 先リポジトリは使用量（コストの目安）を含む。公開リポジトリにするかは要検討。
