# 御爱同萌每日暖心福袋自动领取

脚本文件：[ai2-daily-bonus.user.js](./ai2-daily-bonus.user.js)

## 功能

- 在已登录的 ai2.moe 页面中自动领取“每日暖心福袋”。
- 复用浏览器当前的登录 Cookie、站内 CSRF 参数和已经通过的 Cloudflare 会话。
- 成功后等待 20 小时 5 分钟再检查，避免服务器 20 小时冷却边界导致空请求。
- 使用一次性定时器按下次领取时间调度，不做每分钟轮询。
- 使用本地锁减少多个标签页同时领取。
- 提供 Tampermonkey 菜单命令：立即领取、查看状态、重置本地冷却。

## 使用

1. 在 Tampermonkey 中新建脚本，导入 `ai2-daily-bonus.user.js`。
2. 打开 `https://www.ai2.moe/` 并完成 Cloudflare 验证、登录账号。
3. 页面加载后约 3 秒自动检查并领取。之后只要浏览器打开着本站页面，脚本会按冷却时间自动检查。

Tampermonkey 的菜单中也可以手动触发领取或查看下次检查时间。

## 更新地址

在 Tampermonkey 脚本设置的“下载 URL”中填写：

```text
https://raw.githubusercontent.com/iahg0/auto-sign-ai2/main/ai2-daily-bonus.user.js
```

勾选“检查更新”并保存。每次发布新版本时必须递增脚本头部的 `@version`，否则 Tampermonkey 不会识别为可更新版本。

## 说明

- 脚本不绕过 Cloudflare，也不保存账号密码。Cloudflare 首次验证仍由浏览器完成。
- 浏览器关闭时脚本无法运行；可以在需要时打开本站，页面加载后会补做一次检查。
- 签到结果和冷却时间只保存在本机 Tampermonkey 存储中。
