# human-browser

Codex / Claude Code から、ユーザーのログイン済み Chrome をローカル daemon + 拡張経由で操作する最小実装です。

## 構成

- `src/cli/human-browser.ts`: 単一CLI入口
- `src/daemon/*`: 常駐ブリッジ
- `extension/*`: Chrome拡張 (MV3)
- `vendor/agent-browser/*`: snapshot/ref整形ロジックのvendor
- `test/*`: unit + integration

## セットアップ（最短）

```bash
git clone <repository-url> ~/.human-browser
cd ~/.human-browser
npm install
npm link
./scripts/install-wrapper.sh
cp docs/profiles.example.json ~/.human-browser/profiles.json
```

`scripts/install-wrapper.sh` は `~/.local/bin/human-browser` にラッパーを配置します。  
既存ラッパーがある場合は `.bak.YYYYmmdd-HHMMSS` を残してから上書きします。
Python 3 が必要です（`python3 --version` で確認）。

この時点ではまだ利用開始できません。次の「profile ごとの初期化」を必ず実行してください。

## profile ごとの初期化

ポート重複を避けて、使いたい profile の数だけ `init` します。

```bash
human-browser --config ~/.human-browser/config.<profile-name-1>.json init --port 18765 --show-token
human-browser --config ~/.human-browser/config.<profile-name-2>.json init --port 18766 --show-token
# 必要な数だけ追加
```

`--show-token` で表示された `token` と `extension_ws_url` は、後述の拡張 popup 設定に使います。

## Codex / Claude Code からの自動起動（推奨）

エージェントが `human-browser` を呼ぶたびに daemon が必要です。  
macOS は LaunchAgent 常駐を推奨します。

```bash
# profiles.json に設定した launchd_plist / launchd_label を確認
human-browser profile list --json

# 各 profile について実行
launchctl bootstrap "gui/$(id -u)" "<launchd_plist>"
launchctl kickstart -k "gui/$(id -u)/<launchd_label>"
```

ラッパー（`~/.local/bin/human-browser`）は `daemon` 以外のコマンド実行前に `http://127.0.0.1:<port>/health` を確認し、落ちていれば `launchctl kickstart -k` で自動復帰を試みます。  
自動起動を無効化したい場合は `HUMAN_BROWSER_AUTOSTART=0` を設定してください。

## 複数ブラウザ（任意の名前・任意の数）と自動選択

- ラッパー（`~/.local/bin/human-browser`）は profile ルーティングをサポートします。
- `--profile <name>`（別名: `--browser <name>`）で明示指定できます。
- 明示指定なしでも、`open/goto/navigate` の URL・ヒント文字列・作業ディレクトリ・前回選択状態から profile を自動解決します。
- URLがないコマンドでヒントを与える場合は `HUMAN_BROWSER_CONTEXT_HINT` を使えます（例: `HUMAN_BROWSER_CONTEXT_HINT='work browser' human-browser status`）。
- `HUMAN_BROWSER_CONTEXT_HINT` 未指定時は、プロジェクト文脈（`cwd` / `git remote` / `README.md` / `AGENTS.md` / `.env*`）からキーワードを自動抽出してルーティングヒントとして使います（`HUMAN_BROWSER_AUTO_CONTEXT=0` で無効化）。
- profile 状態確認/操作:
  - `human-browser profile list --json`
  - `human-browser profile current --json`
  - `human-browser profile use <profile-name> --json`
  - `human-browser profile resolve --url https://example.com --hint "<profile-hint>" --json`
- ルーティング設定ファイルは `~/.human-browser/profiles.json`（任意）。サンプルは `docs/profiles.example.json`。
- 通常コマンドで `--config` 未指定の場合、ラッパーが選択 profile の config を自動注入します。

## ログイン失敗時のフォールバック試行（試行錯誤）

- `open/goto/navigate` はデフォルトで profile failover を有効化（`HUMAN_BROWSER_PROFILE_FAILOVER=1`）。
- 初回profileで開けない、またはログイン画面/権限エラーと判定した場合に、候補profileへ順次リトライします。
- 候補順は `profile resolve` の `candidate_profiles`（URL/ヒント/状態ベース）に従います。
- 明示的に制御したい場合:
  - 強制ON: `--retry-profiles`
  - 強制OFF: `--no-retry-profiles`
  - 成功判定ヒント: `--expect-text "Dashboard"` / `--expect-selector ".app-shell"`

例:

```bash
# ログインが必要なURLを、表示確認しながらprofile横断で試す
human-browser --retry-profiles --expect-text "Vercel Dashboard" open https://vercel.com/dashboard

# ヒントを与えて auto route + failover
HUMAN_BROWSER_CONTEXT_HINT="work browser" human-browser --expect-selector "#app" open https://example.com
```

判定調整用 env:

- `HUMAN_BROWSER_BLOCK_MARKERS`（`|`区切り）
- `HUMAN_BROWSER_MIN_CONTENT_CHARS`（デフォルト: `40`）

`init` 後に表示される以下を拡張popupに設定:

- `extension_ws_url` 例: `ws://127.0.0.1:18765/bridge`
- `token` (`init` はデフォルトで token を隠すため、`human-browser init --show-token` で表示)

注意:
- `human-browser init --force` は既存configの token を維持します（稼働中daemonとの token 不整合を避けるため）。
- token を更新する場合は `human-browser rotate-token --show-token` を使い、daemon再起動と拡張のtoken更新を行ってください。

## Chrome拡張の読み込み

1. `chrome://extensions` を開く
2. デベロッパーモードを ON
3. 「パッケージ化されていない拡張機能を読み込む」で `extension/` を選択
4. popupで `Daemon WS URL` と `Token` を保存
5. popup の status が `connected` になることを確認

token を更新した場合は、`human-browser rotate-token --show-token` 実行後に popup へ再設定してください。

## 動作確認チェックリスト

```bash
human-browser profile list --json
human-browser profile current --json
human-browser profile resolve --hint "<profile-hint>" --json
human-browser --profile <profile-name> --json status
human-browser --profile <profile-name> open https://example.com
human-browser --profile <profile-name> snapshot --interactive --cursor --compact
human-browser --profile <profile-name> diagnose --limit 20
```

## 最小操作例

```bash
human-browser status
human-browser tabs
human-browser snapshot
human-browser snapshot --interactive --cursor --compact --depth 3 --selector '#app'
human-browser click '#login'
human-browser fill '#email' hello@example.com
human-browser open https://example.com
human-browser hover '#menu'
human-browser screenshot
human-browser screenshot page.png --full
human-browser pdf page.pdf
human-browser eval 'document.title'
human-browser get text '#main'
human-browser get html '#main'
human-browser wait '#main'
human-browser cookies
human-browser cookies set session abc123
human-browser network start
human-browser network dump --clear
human-browser console dump --clear
# refs (@e1/ref=e1/e1) で操作する場合は --snapshot が必須
human-browser click @e1 --snapshot <snapshot_id>
human-browser fill @e2 hello@example.com --snapshot <snapshot_id>
human-browser diagnose --limit 20
# token を表示する場合のみ明示フラグを使う
human-browser ws --show-token
human-browser rotate-token --show-token
```

`snapshot` はデフォルトで本文コンテキストも含む全体スナップショットを返します。`--interactive` を付けると操作候補のみに絞ります。

## 仕様

- CLI仕様: `docs/cli-spec.md`
- protocol仕様: `docs/protocol.md`
