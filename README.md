# TrayPulse

Bluetooth / ワイヤレス機器のバッテリー残量をタスクトレイ（Windows）・メニューバー（macOS）に常駐表示する Electron アプリです。
オーディオデバイスの切り替え、マイクのミュート、アプリごとの音量調整、スクリーンショットもトレイからすばやく操作できます。

> English summary is at the bottom.

## 機能

| 機能 | Windows | macOS |
|---|---|---|
| Bluetooth 機器のバッテリー残量（Classic / BLE） | ✅ | ✅ (要検証) |
| **タスクバーに右寄せで直接表示**（通知領域の左） | ✅ Windows 10 / 11 | — (メニューバーに % 表示) |
| トレイアイコンに残量 % を表示（一番少ない機器 or 指定機器） | ✅ | ✅ メニューバーに % 表示 (要検証) |
| 機器ごとに専用トレイアイコンを表示 | ✅ | ✅ (要検証) |
| 残量低下の通知（機器ごとにしきい値設定） | ✅ | ✅ |
| 充電完了の通知（80 / 90 / 100%） | ✅ | ✅ |
| イヤホンの左・右・ケースを個別表示 | △ 機器が複数の Battery Service を公開している場合のみ | ✅ AirPods / Beats など (要検証) |
| 出力デバイスの切り替え | ✅ | ✅ `switchaudio-osx` が必要 |
| 入力デバイス（マイク）の切り替え | ✅ | ✅ `switchaudio-osx` が必要 |
| マイクのミュート切り替え + グローバルショートカット + トレイに状態表示 | ✅ | ✅ (入力音量 0 で代替) |
| アプリごとの音量ミキサー | ✅ | ❌ OS の制約で非対応 |
| スクリーンショット（範囲 / 全画面） | ✅ | ✅ (要検証) |
| ログイン時の自動起動 | ✅ | ✅ |
| 機器の並べ替え・表示名変更・非表示 | ✅ | ✅ |
| ライト / ダークテーマ、日本語 / 英語 | ✅ | ✅ |
| 自動アップデート（GitHub Releases） | ✅ | ✅ |
| 取得間隔の設定・省電力モード | ✅ | ✅ |
| プラグインで対応機器を追加 | ✅ | ✅ |

### タスクバー表示（Windows）

Windows 11 ではタスクバーに独自のツールバー（DeskBand）を追加する仕組みが廃止されたため、
TrafficMonitor などと同じ方法で、小さな透明ウィンドウをタスクバー（`Shell_TrayWnd`）の子ウィンドウにして通知領域のすぐ左に配置しています。

- 設定タブの「残量の表示場所」で **タスクバー / タスクトレイ / 両方** を切り替えられます（Windows の既定はタスクバー）。
- 左クリックでポップアップ、右クリックでメニュー、マイクのアイコンのクリックでミュートを切り替えます。
- 別プロセスの子ウィンドウになった Chromium はマウス入力を受け取れないため、クリックはヘルパーの低レベルマウスフック（`WH_MOUSE_LL`）で検出しています。フックが扱うのは **ウィジェットの範囲内のクリックだけ** で、それ以外のマウス操作はそのまま通します。
- タスクバーが縦向きの場合など、タスクバーに表示できない場合は自動的にタスクトレイ表示に切り替わります。
- エクスプローラーが再起動した場合は、ウィジェットを自動で作り直します。

### 既定のショートカット

| 操作 | Windows | macOS |
|---|---|---|
| マイクのミュート切り替え | `Ctrl + Alt + M` | `⌘ ⌥ M` |
| 範囲スクリーンショット | `Ctrl + Alt + S` | `⌘ ⌥ S` |
| 全画面スクリーンショット | `Ctrl + Alt + F` | `⌘ ⌥ F` |

設定タブから変更できます。

## 開発

```powershell
npm install
npm start          # 起動
npm run dev        # 起動してすぐポップアップを表示
```

> npm 11 以降は依存パッケージのインストールスクリプトを許可制にしています。`package.json` の `allowScripts` に Electron を登録済みですが、
> `node_modules/electron/dist` が空の場合は `node node_modules/electron/install.js` を実行してください。

### 配布用ビルド

```powershell
npm run dist:win   # Windows インストーラー (dist/*.exe)
npm run dist:mac   # macOS (dist/*.dmg) ※ Mac 上で実行
```

`v0.1.0` のようなタグを push すると、GitHub Actions（`.github/workflows/build.yml`）が Windows / macOS 版をビルドし、GitHub Releases に公開します。
自動アップデートはこの Releases（`package.json` の `repository.url`）を参照します。

### UI のスクリーンショットを撮る（開発用）

```powershell
$env:TRAYPULSE_CAPTURE = "$PWD\screens"; npm start
```

各タブの PNG を保存して終了します。

## 仕組み

```
src/
  main/
    main.js              アプリ本体（トレイ・ポップアップ・IPC・通知・ショートカット）
    trays.js             トレイアイコン管理（メイン / マイク / 機器ごと）
    taskbarWidget.js     タスクバーに埋め込むウィジェット（Windows）
    devices.js           ポーリング、機器の記憶、通知判定
    store.js             設定 (JSON) の保存
    i18n.js              多言語
    graphics/            依存なしのアンチエイリアス描画 + PNG エンコーダ（トレイアイコン生成）
    providers/           バッテリー取得プロバイダー
      win-bluetooth.js   Windows: SetupAPI のデバイスプロパティ + WinRT GATT Battery Service
      mac-bluetooth.js   macOS: system_profiler + ioreg
    audio/               オーディオ制御（win.js / mac.js）
    native/win/          Windows ヘルパー（PowerShell + C#、実行時にメモリ上でコンパイル）
    platform/winHelper.js  ヘルパーとの JSON-lines 通信
  preload/preload.js     レンダラーに公開する API（contextIsolation 有効）
  renderer/              ポップアップ UI（素の HTML / CSS / JS）
  widget/                タスクバーウィジェットの UI
  locales/               ja.json / en.json
```

### Windows

- **バッテリー**: Windows がデバイスノードに公開している `DEVPKEY_Bluetooth_Battery` を SetupAPI で読みます。設定アプリに表示される値と同じです。
  それに加えて、BLE 機器の GATT Battery Service (0x180F) を WinRT で読みます。
- **オーディオ**: Core Audio (MMDevice / IAudioSessionManager2 / IPolicyConfig) を C# の COM 相互運用で呼び出します。
- **タスクバー表示**: SetParent で Shell_TrayWnd に埋め込み、2 秒ごとに通知領域の位置に合わせて再配置します。
- ヘルパーは `powershell.exe` 上で動き、C# を `Add-Type` でメモリ上にコンパイルします。.NET SDK やネイティブモジュールのビルドは不要です。
  DLL をディスクにキャッシュしないのは、Smart App Control が未署名 DLL の読み込みをブロックするためです。

### macOS（コントリビューター募集中 🙏）

macOS 部分は実機で検証できていません。動作確認や修正の Pull Request を歓迎します。特に次の点を確認してください。

- `providers/mac-bluetooth.js`: `system_profiler SPBluetoothDataType -json` のキー名（`device_batteryLevelLeft` など）と `ioreg` の出力の解析
- `audio/mac.js`: `SwitchAudioSource -f json` の出力形式、`osascript` による音量とミュートの操作
- `trays.js`: メニューバーでの template image と `setTitle` の表示
- `screenshot.js`: `screencapture -i` と、画面収録の権限がない場合の挙動

## プラグイン

設定タブ →「プラグインフォルダを開く」で開くフォルダに `.js` ファイル（または `index.js` を含むフォルダ）を置き、アプリを再起動すると、対応機器を追加できます。
サンプルは [examples/plugins/sample-provider.js](examples/plugins/sample-provider.js) にあります。

```js
module.exports = {
  id: 'my-provider',
  name: 'My Provider',
  platforms: ['win32', 'darwin'],
  async getDevices(ctx) {
    return [{ id: 'my:device1', name: 'My Mouse', kind: 'mouse', level: 80, connected: true }];
  },
};
```

Logicool HID++（Unifying / Bolt / Lightspeed）、DualSense、Xbox コントローラーなどのプラグインも歓迎します。

> ⚠ プラグインはアプリと同じ権限で動作します。信頼できるものだけを入れてください。

## ライセンス

MIT

---

## English

**TrayPulse** is a cross-platform (Windows / macOS) Electron tray app that shows the battery level of Bluetooth and wireless devices,
shown right-aligned directly on the Windows taskbar (or in the tray / macOS menu bar), with quick audio controls (output/input switching, mic mute with a global hotkey, per-app volume mixer on Windows) and screenshot shortcuts.

- `npm install && npm start` to run, `npm run dist` to package.
- Battery data comes from pluggable *providers* (`src/main/providers`). Drop extra providers into the plugins folder.
- The macOS implementation has **not been tested on real hardware yet**. Testing and PRs are very welcome!
