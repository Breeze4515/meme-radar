# 第三方组件清单

本项目的直接依赖固定为 `gmgn-cli@1.5.7`。当前锁文件还包含以下传递依赖：

| 组件 | 版本 | 许可证 |
|---|---:|---|
| gmgn-cli | 1.5.7 | MIT |
| commander | 12.1.0 | MIT |
| dotenv | 16.6.1 | BSD-2-Clause |
| ip-address | 10.7.0 | MIT |
| smart-buffer | 4.2.0 | MIT |
| socks | 2.8.10 | MIT |
| undici | 7.29.1 | MIT |

此表依据 `package-lock.json` 的包元数据生成。正式公开前仍需核对每个发布包内的许可证原文，以及各数据服务的 API 使用条款；开源软件许可证不等同于数据接口商业授权。

Windows 便携包附带 Node.js 运行时，许可证及第三方声明见包内 `runtime/LICENSE`，各依赖的许可证保留在 `node_modules/` 对应目录。

语音提醒通过浏览器调用用户设备上的本地中文语音。本项目不分发操作系统语音包或其合成录音；可用音色取决于用户设备。
