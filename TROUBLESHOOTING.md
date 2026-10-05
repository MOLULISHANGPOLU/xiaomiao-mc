# TROUBLESHOOTING.md —— 报错对照表

> 给 AI 助手：拿报错**原文**在这页搜关键词，按「怎么办」做；同一招试 2 次不行就停下，把本页条目+报错原文发给主人。

## 配置类

| 报错/现象 | 原因 | 怎么办 |
|---|---|---|
| `config.json 里 paths.xxx 还没填` | 问卷结果没填全 | 照提示的键名回填，存盘重启；别拿假路径糊弄 |
| `找不到 config.json` | 程序没在仓库里跑 / 目录层级不对 | 确认 `config.json` 在仓库根目录、脚本在 `1-程序\` 下 |
| `ERR 读不到 server.properties（检查 config.json 的 paths.serverDir）` | 服务端路径错，或服务端还没初始化 | 路径指到**有 server.properties 的那个文件夹**；没有就先按 AGENTS 2.2 建服 |
| RCON 报 `ERR` / 指令没反应 | 服务端没开 RCON | `server.properties` 设 `enable-rcon=true` + `rcon.password=xxx` + `rcon.port=25575`，重启服务器 |
| 游戏里打字小喵不理 | 玩家名不匹配 / 日志路径不对 | `config.json` 的 `players.user` 必须**逐字符**等于进服游戏名；`paths.serverLog` 指向服务端 `logs\latest.log` |
| `语音就绪` 提示不弹 | 纯装饰性提示，无实际影响 | 可忽略；若在意，确认两端都装了新 mewfight jar 且人类玩家已进服 |

## 启动类

| 报错/现象 | 原因 | 怎么办 |
|---|---|---|
| 双击 `启动小喵.cmd` 闪退 / 乱码 | cmd 文件编码或路径含特殊字符 | 保持 GBK 编码；仓库别放带奇怪符号的路径下 |
| `JAVA_HOME is set to an invalid directory` | 系统 JAVA_HOME 是坏值 | 不必改系统：临时给命令指定 `JAVA_HOME=<正确JDK目录>` 再跑（如编译模组时） |
| 端口 8799 已占用 / 两个大脑 | 上次没退干净 | 任务管理器关掉残留 `node.exe`，或跑 `1-程序\大脑\stop-all.ps1` 再重开 |
| `小喵 客户端没进服务器` / 反复掉线 | 登录票据过期（LittleSkin） | 看 `1-程序\底层\launch-mew.log`；重新走一遍启动器登录，票据会自动续期 |
| 防火墙弹窗 | Java/语音首次监听端口 | **点允许**（服务端 25565/tcp，语音模组 24454/udp，监视窗口 127.0.0.1:8799） |
| 战斗面板设置两端不同步 | `MEWFIGHT_SHARED` 没生效 | `setx MEWFIGHT_SHARED "<仓库>\1-程序\底层"` 后**重启游戏**；或统一经 `launch.mjs` 启动 |

## API / 大脑类

| 报错/现象 | 原因 | 怎么办 |
|---|---|---|
| `返回里没有 content` / 空回复 | 模型带 thinking 被 max_tokens 截断 | `voice-ai.json`：`model` 用 `deepseek-chat`；若坚持 `deepseek-flash` 则 `maxTokens` ≥1024 |
| 401 / key 无效 | key 填错或过期 | 重填 `apiKey`；确认 `baseUrl` 与 key 配套（DeepSeek 的 key 配 DeepSeek 地址） |
| 402 / 余额不足 | 账户没钱 | 主人去对应平台充值 |
| 小喵已读不回 / 回复延迟大 | 上游限流或网络 | 等几十秒重试；`--usage` 看最近调用是否 fail |
| 大脑答得太啰嗦/太短 | 人设参数 | 改 `voice-ai.json` 的 `maxReplyChars`（默认 133 字） |

## 语音类（纯文字版可无视）

| 报错/现象 | 原因 | 怎么办 |
|---|---|---|
| `--say` 后没声音 / `TTS 失败 status=1` | 声卡路由或语音工具路径错 | ① `paths.voiceToolDir` 指到 `1-程序\语音工具`；② 装了 VB-Cable 且 `say_to_call` 播到 **CABLE Input**；③ 检查系统里有 CABLE Input 设备 |
| 录不到人说话 / 耳朵没反应 | 监听设备名不对 | `voice-ai.json` 的 `ear.device` 填**播放设备**的准确名字（系统声音设置里可见）；空值=没填 |
| `两个耳朵抢麦克风` | voice-bridge 与大脑同时 looprec | 只留一个耳朵：跑大脑就别跑 `voice-bridge.cjs`，反之亦然 |
| 识别错字（幕府=木斧） | 同音字，正常 | 已内置错字映射表兜底；严重时在游戏里改用打字 |
| 模型加载失败 / sherpa 报错 | `paths.sherpaNode` 或 `paths.sensevoiceModelDir` 错 | 两个路径都要到**文件**级（.node）与**目录**级（含 model.int8.onnx 的文件夹） |
| 语音模型下载慢/失败 | 网络 | 换 `hf-mirror.com` 前缀重下；或从已装 DSH 的机器拷 `speech-to-text\sensevoice\models\sensevoice-onnx\` |

## 编译模组（仅当改了源码要重编译）

| 现象 | 怎么办 |
|---|---|
| 依赖拉不下来（maven 被墙） | 本仓库 gradle 文件已配阿里云镜像，正常应能拉；仍失败时检查网络后重试 |
| `找不到符号 GameProfile.getName()` | authlib 7 起是 Record，用 `name()` / `id()` |
| 找不到 gradle | 用任意 Gradle 9.x：`gradle -p 1-程序\模组源码\mewfight-mod build`，产物在 `build\libs\` |
| 编译好的 jar 要更新 | 覆盖 `交付\用户端\mods\` 与 `交付\小喵端\mods\` 的 `mewfight-1.0.0.jar` |
