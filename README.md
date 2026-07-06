# MedVoice Insight · 医药访谈洞察超智能体

面向 HCP 与患者深度访谈的证据型 AI 研究工作台。它把音视频转录、说话人区分、大纲驱动提取、跨样本综合、分歧识别与报告生成串成一个完整工作流，并让每条洞察都可回溯到受访者原话。

## 直接运行

需要 Node.js 24 或更高版本。依赖已改为公开 npm 包，可在本机、Docker 和云服务器一致运行。

```bash
cd "/Users/nielun/Documents/Codex OneAI/hcp-insight-agent"
"/Users/nielun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" scripts/start.mjs
```

打开 <http://localhost:4174>。应用默认是完全空白状态，不包含任何预置访谈、洞察或报告。未配置密钥时仍可验证页面、文件导入、实时录音、大纲解析和问题识别；AI 转录与分析需要配置密钥。

## 启用真实 AI

推荐直接点击页面右上角的“连接 AI”，输入 API Key 并完成资料处理授权确认。Key 仅保存在当前本机服务的内存中，不写入页面、浏览器存储或磁盘，服务重启后自动清除。

也可以在启动服务前通过环境变量配置：

```bash
export OPENAI_API_KEY="你的密钥"
"/Users/nielun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" scripts/start.mjs
```

可选环境变量：

- `MAP_MODEL`：单访谈并发提取模型，默认 `gpt-5.4-mini`
- `SYNTHESIS_MODEL`：跨样本洞察模型，默认 `gpt-5.5`
- `MAX_CONCURRENCY`：并发分析数，默认 `4`
- `PORT`：本地端口，默认 `4174`
- `PYTHON_BIN`：Word / PDF 大纲解析使用的 Python 路径；Codex 工作区会自动发现
- `AUTH_REQUIRED`：设为 `true` 时启用企业邮箱登录与后台授权
- `ADMIN_EMAIL`：首位管理员邮箱，必须以 `@hisunpharm.com` 结尾
- `ADMIN_PASSWORD`：管理员初始密码，至少 12 位
- `DATA_DIR`：SQLite 用户数据库与临时转录任务目录
- `DATABASE_URL`：生产环境 PostgreSQL 连接串；配置后账号、申请和历史登录记录跨部署保留
- `BREVO_API_KEY`：审批邮件的 Brevo HTTPS API Key
- `MAIL_FROM_EMAIL`：已在邮件服务中验证的发件地址
- `MAIL_FROM_NAME`：邮件显示的发件人名称

真实模式使用 `gpt-4o-transcribe-diarize` 的 `diarized_json` 完成说话人分段，并通过 Responses API 的 Structured Outputs 生成稳定的结构化结果。参考：[说话人分离转录](https://developers.openai.com/api/docs/guides/speech-to-text#speaker-diarization)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[GPT-5.5 指南](https://developers.openai.com/api/docs/guides/latest-model)。

## 当前原型能力

- MP3、WAV、MP4、M4A、TXT、MD、CSV、JSON 单份或批量导入
- 浏览器实时录音，支持中文 / English 实时预览与中英文自动转录
- 实时录音停止后自动同步至资料列表并标记来源，可选择自动转录后直接进入角色区分
- 音视频说话人分离转录；文本笔录直接分析
- 接近或超过 24 MB 的长音视频会在本机过滤元数据、提取音轨并按 10 分钟自动分片后转录，为接口 25 MB 上限预留安全空间
- 大型文件使用媒体解析器读取时长，支持临时错误自动重试、说话人模型不可用时兼容转录，并在列表中保留具体失败分片与原因
- 转录后可执行“区分对话角色”：本地逐行结构化、AI 语义身份复核，并导出保留原话和待复核标记的一问一答 Word
- Word、PDF、TXT、MD 研究大纲上传与主要问题自动识别
- 手机号、身份证号、邮箱的服务端基础脱敏
- 最多 30 份笔录的并发 Map-Reduce 分析
- 大纲逐题对齐、问题 × HCP 矩阵、共识与差异识别
- 研究缺口雷达：统计未覆盖问题并形成补访建议
- 结论置信度、样本覆盖与逐字引文证据链
- 大纲分析矩阵导出为真正的 `.xlsx`
- 洞察报告导出为真正的 `.docx`
- 一键生成可编辑的 `.pptx` 洞察 Report Deck

## 架构

```text
音视频 / 笔录
      │
      ├── 隐私检查与脱敏
      ├── 说话人分离转录
      ▼
单访谈提取 Agent × N（受控并发）
      │  大纲逐题回答 / 驱动 / 障碍 / 原话 / 反例
      ▼
跨样本综合 Agent
      │  共识 / 差异 / 分群 / 未满足需求
      ▼
问题×HCP矩阵 + 缺口雷达 + 洞察证据账本
      │
      └── Excel 矩阵 / Word 报告 / PPT Deck
```

## 测试

```bash
"/Users/nielun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" --test
```

## 企业访问权限

在线模式会启用以下访问流程：

1. 只有 `@hisunpharm.com` 邮箱可以申请试用。
2. 管理员在 `/admin` 中直接添加账号，或审批申请。
3. 系统生成一次性临时密码；用户首次登录必须修改密码。
4. 管理员可停用账号、重置临时密码，并查看最近登录状态。
5. 密码使用 scrypt 加盐哈希，登录会话使用 HttpOnly、SameSite Cookie；数据库不保存明文密码。
6. 配置邮件服务后，管理员批准申请会自动生成临时密码并发送至申请人的公司邮箱。

本机验证示例：

```bash
AUTH_REQUIRED=true \
ADMIN_EMAIL="admin@hisunpharm.com" \
ADMIN_PASSWORD="请替换为至少12位的强密码" \
OPENAI_API_KEY="你的服务端密钥" \
"/Users/nielun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" server.js
```

## GitHub + Render 在线部署

仓库已包含 `Dockerfile` 与 `render.yaml`。当前 Blueprint 默认使用 Render Hobby 的免费 Web Service，并安装 FFmpeg、Word/PDF 解析组件和 Node 依赖。

1. 将本目录推送到一个 **Private GitHub repository**。
2. 在 Render 选择 `New > Blueprint` 并连接该仓库。
3. 为三个 `sync: false` 变量填写秘密值：`OPENAI_API_KEY`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`。
4. 部署完成后访问 Render 提供的 HTTPS 地址；管理员后台地址为 `/admin`。

不要把真实 API Key、管理员密码、SQLite 数据库或访谈文件提交到 GitHub。免费 Web Service 不提供持久磁盘，服务重启或重新部署后，通过后台新增的账号和审批记录可能丢失；环境变量中的管理员账号仍可重新初始化。需要稳定内部试用时，应升级到 Starter 并挂载持久磁盘。

## 上线边界

当前版本具备基础企业邮箱白名单与管理员审批，但正式处理真实 HCP / 患者资料前仍需公司 IT、法务、医学与合规团队确认：云区域与数据驻留、传输至外部 AI 服务的授权、数据保留期限、审计日志、知情同意、离职账号回收、敏感词典、人工复核和模型效果评估。生产环境只应使用服务端密钥，不应让普通用户输入个人 API Key。
