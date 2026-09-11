Meme雷达开源版 · Windows

第一次测试：
1. 必须先把整个压缩包解压，不能直接在压缩软件里运行。
2. 从 https://nodejs.org/ 安装当前 LTS 版 Node.js。
3. 双击 START-HERE-WINDOWS.bat。
4. 浏览器打开后，点击“首次使用 / 创建 API”。
5. 复制雷达生成的公钥，在 GMGN 只开读取、关闭交易，再把 API Key 填回雷达。
6. 测试结束后回到黑色命令窗口，按 Ctrl+C 停止雷达。

如果浏览器没有自动打开，请手动访问：
http://127.0.0.1:3791/

START-HERE-WINDOWS.bat 和 TEST-WINDOWS.bat 都是前台测试入口。
START-WINDOWS.bat 是测试完成后的后台启动入口。
网络提示：便携版会自动读取 Windows 系统代理。若连接 GMGN 超时，请先确认浏览器能打开 GMGN，并在代理/VPN软件中开启“系统代理”，然后完全关闭雷达黑色窗口再重新启动。
