# OpenOCD Windows 运行时与开源许可声明

Orbit（MIT 许可证）在独立的固件烧录阶段通过独立子进程调用未经修改的上游 OpenOCD Windows 运行时。本目录与打包产物 `out/openocd/` 遵循 GNU GPL v2 及随附组件各自的开源许可协议分发。

## 1. 上游版本与完整性校验

- **组件版本**：OpenOCD `0.12.0+dev-g6fbe9e7`（`i686-w64-mingw32`）
- **仓库归档**：`resources/openocd/openocd-6fbe9e7-i686-w64-mingw32.tar.gz`
- **SHA-256**：`d4ed61f96aec07fcacac532e27e9f356c03ecc24d7a209fe65c893d3cea6b6ec`
- **上游源码固定提交**：[`6fbe9e772476ce55c634cb0e8cd14244588ee9e2`](https://github.com/openocd-org/openocd/tree/6fbe9e772476ce55c634cb0e8cd14244588ee9e2)
- **构建脚本、补丁与依赖版本清单**：[`.github/workflows/snapshot.yml`](https://github.com/openocd-org/openocd/blob/6fbe9e772476ce55c634cb0e8cd14244588ee9e2/.github/workflows/snapshot.yml)
- **上游二进制原始发布地址**：[`openocd-6fbe9e7-i686-w64-mingw32.tar.gz`](https://github.com/openocd-org/openocd/releases/download/latest/openocd-6fbe9e7-i686-w64-mingw32.tar.gz)

`scripts/stage-openocd.js` 在校验上述 SHA-256 后，将所需的未修改运行时文件原样解压至 `out/openocd/`，不对 OpenOCD 源码或二进制做任何修改。

## 2. 独立进程边界（Mere Aggregation）

- Orbit 核心源码（`src/`、`native/`、`dist/`）采用 MIT 许可证，未静态或动态链接 OpenOCD 或其 GPL/LGPL 运行库，也未将 GPL 代码复制、翻译或合入 Orbit。
- Orbit 仅在烧录阶段（建立调试 owner 之前，或重启释放调试 owner 之后）通过操作系统 `spawn` 启动独立的 `openocd.exe` 命令行子进程并等待其退出。二者属于 GNU GPL v2 第 2 条所述的独立程序聚合（mere aggregation），各自保持原有的许可证边界。

## 3. 分发组件与许可证清单

| 路径（`out/openocd/`） | 组件 | 许可证（SPDX） | 随附许可说明 |
| --- | --- | --- | --- |
| `bin/openocd.exe`、`share/openocd/scripts/**` | OpenOCD | `GPL-2.0-or-later` | 见 `resources/openocd/COPYING`、`LICENSES/preferred/GPL-2.0`、`LICENSES/license-rules.txt` |
| `bin/libjaylink-0.dll` | libjaylink | `GPL-2.0-or-later` | 见 `resources/openocd/LICENSES/preferred/GPL-2.0` |
| `bin/libftdi1.dll` | libFTDI | `LGPL-2.1-only` | 见 [GNU LGPL v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) 与下方源码要约 |
| `bin/libusb-1.0.dll` | libusb | `LGPL-2.1-or-later` | 见 [GNU LGPL v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) 与下方源码要约 |
| `bin/libhidapi-0.dll` | HIDAPI | `GPL-3.0-only OR BSD-3-Clause OR Original` | 原始许可文本随附于 `out/openocd/share/doc/hidapi/`（含 `AUTHORS.txt`、`LICENSE.txt`、`LICENSE-bsd.txt`、`LICENSE-gpl3.txt`、`LICENSE-orig.txt`、`README.md`） |
| `bin/libgcc_s_dw2-1.dll` | MinGW-w64 GCC Runtime | `GPL-3.0-or-later WITH GCC-exception-3.1` | MinGW-w64 GCC 运行时库（含 GCC Runtime Library Exception） |
| `bin/libwinpthread-1.dll` | MinGW-w64 winpthreads | `MIT AND ZPL-2.1` | MinGW-w64 pthread 兼容库 |

## 4. 对应源码获取与三年书面要约（Written Offer）

根据 **GNU GPL v2 第 3(b) 条** 与 **GNU LGPL v2.1 第 6(b) 条**：

- 您可以直接通过上述固定提交 [`6fbe9e772476ce55c634cb0e8cd14244588ee9e2`](https://github.com/openocd-org/openocd/tree/6fbe9e772476ce55c634cb0e8cd14244588ee9e2) 与构建工作流 [`.github/workflows/snapshot.yml`](https://github.com/openocd-org/openocd/blob/6fbe9e772476ce55c634cb0e8cd14244588ee9e2/.github/workflows/snapshot.yml) 获取对应源码与构建配置。
- 自包含本 OpenOCD 二进制组件的 Orbit 版本发布之日起至少 **三年（3 years）** 内，任何收到该二进制发行包的第三方均可通过 [Orbit GitHub Issues](https://github.com/zhuangyan114/Orbit/issues) 向项目维护者提出书面申请，获取与所分发二进制版本完全对应的完整机器可读源代码（包括 OpenOCD 源码、构建脚本以及随附的 GPL/LGPL 动态库对应源码）。维护者将免费提供下载途径，或以不超过实际物理介质与邮寄成本的费用提供源码副本。

## 5. 无担保声明（No Warranty）

> BECAUSE THE PROGRAM IS LICENSED FREE OF CHARGE, THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW. EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE PROGRAM IS WITH YOU. SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

完整条款请查阅同目录下的 `COPYING` 与 `LICENSES/preferred/GPL-2.0`。
