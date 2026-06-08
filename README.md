# GPT SSO Loginer 中文使用说明

[English Version](./README.en.md)

这是一个用于批量完成 Codex/OpenAI SSO 登录，并把登录结果导入本地 `codex-tools` 的自动化工具。

项目会调用真实 Chrome 浏览器。首次运行时会打开 `https://invite.kyl23333.xyz/`，你只需要在这个浏览器窗口里手动登录平台并完成 Cloudflare 验证，后续脚本会复用这个专用 Chrome 配置目录。

## 项目能做什么

1. 为每个账号生成新的 Codex/OpenAI OAuth 登录链接。
2. 在 `auth.openai.com` 输入当前邮箱。
3. 点击 SSO 工作空间或 SSO 授权入口。
4. 自动进入 `oauth.luminet.cn` / `oauth.kyl23333.xyz` 的外部授权页面。
5. 从 `invite.kyl23333.xyz` 读取平台分配的邮箱列表。
6. 精确匹配当前邮箱，并点击同一行后面的登录按钮。
7. 处理 OpenAI 登录确认页和 Codex 授权确认页。
8. 如果提前出现 `/add-phone` 手机号页面，会丢弃当前 OAuth，重新为同一个账号走一遍新链接。
9. 捕获 `localhost` 回调，并写入本地 `codex-tools`。
10. 如果账号已经存在于 `codex-tools`，会自动跳过，不重复使用。

## 准备条件

- Windows 系统。
- 已安装 Google Chrome。
- 已安装 Node.js 18 或更高版本。
- 已安装并配置好 `codex-tools`。
- 你拥有可登录 `https://invite.kyl23333.xyz/` 的平台账号。

## 安装步骤

```powershell
git clone https://github.com/oldsix686/GPT-SSO-Loginer-for-Codex-Tools.git gpt-sso-loginer
cd gpt-sso-loginer
npm install
Copy-Item .env.example .env
```

如果你的 Chrome 不在默认路径，需要编辑 `.env`：

```env
CHROME_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

默认配置已经适配 `codex-tools`：

```env
TARGET=codex-tools
BROWSER_MODE=cdp
BROWSER_CDP_URL=http://127.0.0.1:9222
SYNC_PLATFORM_EMAILS_BEFORE_LOGIN=true
SKIP_USED_EMAILS=true
TRACK_USED_EMAILS=true
MAX_RETRIES=3
STOP_ON_FAILURE=true
```

## 第一次运行

先启动真实 Chrome：

```powershell
npm run real-chrome
```

命令会打开一个新的 Chrome 窗口，并进入：

```text
https://invite.kyl23333.xyz/
```

请在这个打开的 Chrome 窗口里完成平台登录和 Cloudflare 验证。完成后不要关闭 Chrome。

## 单账号测试

平台登录完成后，先跑一个账号测试：

```powershell
npm run login-one
```

这个命令会自动：

- 从 `invite.kyl23333.xyz` 同步邮箱到 `emails.txt`。
- 取第一个未使用账号。
- 走完整 SSO 登录流程。
- 成功后写入 `codex-tools`。

## 批量运行

单账号测试成功后，运行：

```powershell
npm run login
```

脚本会按顺序处理 `emails.txt` 里的账号。已经写入 `codex-tools` 或已经标记使用过的账号会自动跳过。

## 手动提供邮箱

默认情况下，脚本会自动从平台页面同步邮箱。

如果你想手动提供邮箱，可以复制示例文件：

```powershell
Copy-Item emails.example.txt emails.txt
```

然后编辑 `emails.txt`，一行一个邮箱。

如果你不想自动同步平台邮箱，可以在 `.env` 中设置：

```env
SYNC_PLATFORM_EMAILS_BEFORE_LOGIN=false
```

## 常用命令

```powershell
npm run real-chrome
```

打开真实 Chrome，并进入平台登录页。

```powershell
npm run sync-platform-emails
```

从当前已登录的平台页面同步邮箱到 `emails.txt`。

```powershell
npm run login-one
```

只登录并导入一个账号，适合测试。

```powershell
npm run login
```

批量登录并导入所有未使用账号。

## 重要文件说明

- `.env`：本地配置文件，不要提交到 GitHub。
- `emails.txt`：平台同步或你手动填写的邮箱列表，不要提交。
- `used-emails.txt`：已经使用过的邮箱记录，不要提交。
- `artifacts/`：运行日志、结果文件、失败截图，不要提交。
- `profiles/`：专用 Chrome 用户数据目录，包含登录 Cookie，不要提交。
- `%APPDATA%\com.carry.codex-tools\accounts.json`：`codex-tools` 默认账号数据文件。

## 安全注意

不要把下面这些文件或目录上传到 GitHub：

- `.env`
- `emails.txt`
- `emails.txt.*`
- `used-emails.txt`
- `artifacts/`
- `profiles/`
- `accounts.json`
- 任何 `.bak` 或 `.log` 文件

这些文件可能包含平台邮箱、OAuth 回调链接、浏览器 Cookie、本地 token 或账号数据。

项目中的 `.gitignore` 已经默认忽略这些文件。上传前建议执行：

```powershell
git status --short
```

确认待提交文件里没有本地账号数据。

## Cloudflare 说明

脚本不会绕过 Cloudflare 验证。

如果遇到 Cloudflare 页面，请在脚本打开的 Chrome 窗口中手动完成验证。验证通过后，Cookie 会保存在 `profiles/real-chrome-cdp` 中，后续运行会继续复用。

## 手机号页面说明

如果 OpenAI 在进入 Codex 授权页之前跳到：

```text
https://auth.openai.com/add-phone
```

脚本会自动为同一个邮箱重新生成新的 OAuth 链接并重试。

只有到达 Codex 授权同意页，或者捕获到 `localhost` 回调之后，脚本才会把该邮箱标记为已使用。

## 结果查看

运行结果会写入：

```text
artifacts/batch-results.csv
artifacts/batch-results.jsonl
```

如果失败，会在对应账号目录下保存失败截图、HTML 和错误信息，方便排查。
