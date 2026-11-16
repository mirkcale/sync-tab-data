# Tab Data Sync

一个 Chrome / Edge（Manifest V3）扩展：把一个标签页的 **localStorage、sessionStorage、Cookie** 复制到另一个已打开的标签页，或一个指定 URL 的新页面；也可以导出「快照」，在 Chrome ↔ Edge 之间搬运登录态。

典型用途：

- 本地开发和测试环境之间同步登录态，省去反复登录
- 把某个环境的调试数据（localStorage 里的 token、主题、草稿等）搬到另一个页面
- 排查「为什么换个标签页状态就不一样」这类问题

所有数据只在浏览器本地读写，扩展本身不发起任何网络请求。

## 功能

- 源标签页：从当前窗口所有 http/https 标签页中选择（默认当前页）
- 目标页面：可选择已打开的标签页，或输入 URL 新开一个标签页
- 同步内容：localStorage / sessionStorage / Cookie 可单独勾选
- Cookie 通过 `chrome.cookies` 读取，因此 **HttpOnly Cookie 也能复制**
- 写入方式：合并（保留目标已有键）或覆盖（先清空目标）
- 跨站复制时可选择把 Cookie 域名改写为目标站点
- 同步完成后自动刷新目标页面，让页面重新读取数据
- 跨浏览器快照：导出成 JSON 文件或复制到剪贴板，在 Chrome ↔ Edge 之间搬运，可选口令加密
- 记住上次的选项

## 安装

### Chrome

1. 打开 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目目录
4. 把「Tab Data Sync」固定到工具栏

### Edge

1. 打开 `edge://extensions/`
2. 打开左侧或页面中的「开发人员模式」
3. 点击「加载解压缩的扩展」，选择本项目目录

## 使用

1. 在源页面完成登录 / 准备好数据
2. 点击工具栏中的扩展图标
3. 「源标签页」默认是当前页，可以切换
4. 选择目标：
   - **已打开的标签页**：从下拉列表选择
   - **新标签页 / URL**：输入地址，如 `https://example.com/app`
5. 勾选要同步的内容，按需调整写入方式与两个选项
6. 点击「开始同步」，下方日志会显示每一步结果

> URL 模式下目标页会在**后台**打开（这是为了避免激活新标签页导致弹窗被关闭），
> 完成后点击「查看目标标签页」即可跳过去。

## 跨浏览器同步（Chrome ↔ Edge）

扩展只能访问自己所在浏览器的标签页、存储和 Cookie，Chrome 与 Edge 的扩展之间没有直接通信通道。所以跨浏览器同步通过「快照」中转，两个方向都支持：

1. 在源浏览器（例如 Chrome）打开目标站点并完成登录
2. 点击扩展图标 → 「跨浏览器快照」→ 选择源标签页
3. 设置口令（建议），点击「下载文件」或「复制到剪贴板」
4. 切到另一个浏览器（例如 Edge）打开同一站点
5. 扩展 → 「跨浏览器快照」→「选择文件」或「从剪贴板导入」
6. 核对预览里的来源与内容，选择目标标签页（或填 URL）→「导入到目标页面」

快照说明：

- 内容是 JSON：来源浏览器 / URL / 时间 + localStorage、sessionStorage、Cookie（含 HttpOnly）
- 加密使用 WebCrypto 的 PBKDF2-SHA256 + AES-GCM，口令不会写进文件；口令输错只会提示重试
- 不加密也能用，但文件里就是可直接登录的凭证，请勿外传
- 分区 Cookie（CHIPS）不会被导出
- 导入时的 Cookie 域名改写、`Secure` / `SameSite` 降级、合并/覆盖等行为，与站内同步完全一致

为什么不能「真正双向实时同步」：

- 浏览器扩展的沙箱按浏览器隔离，跨浏览器必须借助外部通道：文件、系统剪贴板，或自己搭一个本机中继服务（例如 `127.0.0.1` 上的小 HTTP 服务 + 房间码，扩展负责 push/pull）。本扩展内置的是前两种：零依赖，跨机器也能用（剪贴板方式限同一台机器）。
- 如果需要「在一边改完自动推过去」的效果，可以在此基础上加中继服务。

> 口令只用于本地加解密，扩展不会上传任何数据。

## 复制规则细节

### localStorage / sessionStorage

- 读取和写入都发生在标签页的顶层文档，即当前 origin 的存储
- 「合并」只写入源页面存在的键，目标页面其它键保持不变
- 「覆盖」会先 `clear()` 目标存储，再写入
- `sessionStorage` 绑定在标签页生命周期上：写进目标标签页后，该标签页关闭即消失
- iframe 中其它 origin 的存储不会被复制

### Cookie

| 情况 | 行为 |
| --- | --- |
| Cookie 域名与目标 host 匹配 | 保留原 `domain`（含 `.example.com` 这类父域 Cookie）和 `path` |
| 域名不匹配且勾选了改写 | 改为只属于目标 host 的 host-only Cookie |
| 域名不匹配且未勾选改写 | 跳过该 Cookie，并在日志中提示 |
| 目标页面是 `http://` 而 Cookie 带 `Secure` | 去掉 `Secure` 标记 |
| `SameSite=None` 但目标不是 https | 降级为 `SameSite=Lax` |
| 分区 Cookie（CHIPS，带 `partitionKey`） | 跳过（暂不支持） |
| 目标页面已有同名同域同路径 Cookie | 直接覆盖 |

其它属性（`path`、`expirationDate`、`httpOnly`）尽量按原样保留；会话 Cookie（没有过期时间）复制后仍是会话 Cookie。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `tabs` | 读取标签页标题 / URL，用于列表展示与定位目标页 |
| `scripting` | 向页面注入脚本，读写 localStorage / sessionStorage |
| `cookies` | 读取和写入 Cookie |
| `storage` | 记住弹窗里的选项 |
| `clipboardRead` / `clipboardWrite` | 快照的「复制到剪贴板 / 从剪贴板导入」 |
| `host_permissions` (`http/https`) | 上述 API 需要在对应站点上获得授权 |

扩展不使用任何远程服务，也不会把数据发送到外部。

## 已知限制

- 不支持 `chrome://`、`edge://`、扩展页面、Chrome 应用商店、`file://` 等页面（浏览器禁止注入）
- 跨浏览器同步需要手动导出/导入快照：Chrome 与 Edge 的扩展之间没有直接通道；剪贴板方式只适合同一台机器
- 只处理顶层文档；iframe 里其它 origin 的存储、IndexedDB、Cache Storage、Service Worker 数据不在范围内
- 目标页面如果在加载过程中发生跳转（例如被重定向到登录页），数据会写到跳转后的 origin
- 有些站点会校验 Cookie 与后端 session 是否匹配，跨站复制不保证登录态一定可用
- 普通窗口与无痕窗口之间没有做专门的存储分区处理
- 写入大量数据时可能触发浏览器的存储配额限制，此时会在日志中报错

## 目录结构

```
sync-tab-data/
├─ manifest.json
├─ background.js      # Service Worker：实际执行读写
├─ popup.html
├─ popup.css
├─ popup.js           # 弹窗交互、选项持久化
├─ icons/
│  ├─ icon16.png
│  ├─ icon32.png
│  ├─ icon48.png
│  └─ icon128.png
├─ tools/
│  ├─ make-icons.ps1  # 重新生成图标
│  └─ smoke-test.js   # 端到端冒烟测试
└─ README.md
```

## 开发

- 修改代码后，在 `chrome://extensions/` 点击扩展卡片上的「刷新」
- 后台逻辑的日志：扩展详情页 → Service Worker → 「检查」打开 DevTools
- 弹窗的日志：在弹窗上右键 → 「检查」
- 重新生成图标（Windows PowerShell）：

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\tools\make-icons.ps1
  ```

  `make-icons.ps1` 必须保存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 会按 ANSI 读取无 BOM 的脚本，中文注释可能吞掉换行符，导致后面的代码行被当成注释（本项目已经踩过这个坑）。

## 冒烟测试

`tools/smoke-test.js` 会启动一个 headless 浏览器（独立临时 profile，不影响日常使用的浏览器），加载扩展后用两个本地测试页（`localhost:8801` → `127.0.0.1:8802`）验证：

- Cookie（含 HttpOnly、Secure/SameSite 降级）跨域复制与域名改写
- localStorage / sessionStorage 的合并与覆盖
- URL 模式在后台新开标签页
- 快照导出 / 导入与口令加解密
- popup 点击「开始同步」→ 后台 → 目标页面的完整链路

```powershell
node .\tools\smoke-test.js
# 也可以指定浏览器路径：Edge / Chromium / Chrome for Testing
node .\tools\smoke-test.js "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

> 品牌版 Chrome 137+ 已移除 `--load-extension` 命令行开关，自动化测试请用 Edge、Chromium 或 Chrome for Testing；手动「加载已解压的扩展程序」不受影响。

## 安全提示

复制 Cookie / localStorage 等同于复制登录凭证；导出的快照文件同样包含这些凭证。请只在**你自己拥有或已获得授权**的站点上使用，不要把同步后的浏览器状态或快照文件交给不可信的人或环境。
