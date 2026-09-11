# 对外发布检查清单

## 必须由项目所有者决定

- [x] 项目名称：Meme雷达开源版；作者：DeFi狙击手（X：@bi_9527zx）；
- [x] 选择 AGPL-3.0-only 并加入 `LICENSE`；
- [x] 使用 GitHub 私密漏洞报告入口；
- [ ] 核查 GMGN、GoPlus、DexScreener 等上游服务的使用及商业条款；
- [ ] 明确开源版与专业版承诺，不宣传保证盈利。

## 技术验收

- [x] 开源版与当前自用目录分离；
- [x] 发布副本不包含 API Key、运行状态和日志；
- [x] 保留只读边界，不含钱包、签名、swap 或下单；
- [x] 提供 macOS 与 Windows 启动入口；
- [x] 已完成 macOS 安装和启动测试；
- [x] 已完成 Windows 便携包安装、启动及 GMGN Agent/API 配对测试；
- [x] 完成直接及传递依赖许可证复核；
- [x] 运行 `npm test` 与 `npm run release:audit`；
- [ ] 创建全新的 Git 仓库，首次提交前再次检查暂存内容；
- [ ] 由项目所有者确认后才设置为公开。
