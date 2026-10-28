# RMLink 公共 SDK

来自 RMLink `@rmlink/client` 0.2.8，Apache-2.0，许可随目录保留。
本目录是独立开发工作树的固定源码副本，不从服务目录动态加载代码。
SDK处理缓存烧录、AbortSignal取消、终态等待、订阅与录制；前端不重放未知写入。
烧录验证位置由结果 `verification/probe_verified/host_verified` 给出。
默认板端完整镜像比较，额外主机SHA256由公共API选项控制。
