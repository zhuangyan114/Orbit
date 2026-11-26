# Third-Party Notices

Orbit for VS Code (`src/`, `native/`, `dist/`) is licensed under the [MIT License](LICENSE).

Starting with version `1.2.3`, Orbit packages and distributes unmodified third-party binaries and scripts as separate, standalone components. Their respective licenses continue to apply to those components.

## 1. OpenOCD Windows Runtime (`resources/openocd/`, `out/openocd/`)

Orbit invokes `out/openocd/bin/openocd.exe` strictly as a separate, short-lived child process via command-line arguments during optional standalone Flash programming before claiming (or after releasing) the debug probe owner. Orbit does not link against OpenOCD or any GPL/LGPL libraries, and does not copy GPL code into Orbit's MIT-licensed codebase.

- **Upstream build**: OpenOCD `0.12.0+dev-g6fbe9e7` (`openocd-6fbe9e7-i686-w64-mingw32.tar.gz`)
- **Archive SHA-256**: `d4ed61f96aec07fcacac532e27e9f356c03ecc24d7a209fe65c893d3cea6b6ec`
- **Pinned upstream source commit**: <https://github.com/openocd-org/openocd/tree/6fbe9e772476ce55c634cb0e8cd14244588ee9e2>
- **Build recipe, patches, and dependency versions**: <https://github.com/openocd-org/openocd/blob/6fbe9e772476ce55c634cb0e8cd14244588ee9e2/.github/workflows/snapshot.yml>

### Bundled OpenOCD Files and Licenses

- **OpenOCD (`bin/openocd.exe`, `share/openocd/scripts/**`)**: `GPL-2.0-or-later` — see `resources/openocd/COPYING`, `resources/openocd/LICENSES/preferred/GPL-2.0`, and `resources/openocd/LICENSES/license-rules.txt`.
- **libjaylink (`bin/libjaylink-0.dll`)**: `GPL-2.0-or-later` — see `resources/openocd/LICENSES/preferred/GPL-2.0`.
- **libftdi1 (`bin/libftdi1.dll`)**: `LGPL-2.1-only` — <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>.
- **libusb (`bin/libusb-1.0.dll`)**: `LGPL-2.1-or-later` — <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>.
- **HIDAPI (`bin/libhidapi-0.dll`)**: `GPL-3.0-only OR BSD-3-Clause OR Original` — full notices and license texts are included in `out/openocd/share/doc/hidapi/` (`AUTHORS.txt`, `LICENSE.txt`, `LICENSE-bsd.txt`, `LICENSE-gpl3.txt`, `LICENSE-orig.txt`, `README.md`).
- **MinGW-w64 GCC Runtime (`bin/libgcc_s_dw2-1.dll`)**: `GPL-3.0-or-later WITH GCC-exception-3.1`.
- **MinGW-w64 winpthreads (`bin/libwinpthread-1.dll`)**: `MIT AND ZPL-2.1`.

### Written Offer for Corresponding Source Code (GPL-2.0 §3(b) / LGPL-2.1 §6(b))

For at least **three (3) years** from the date of distribution of any Orbit release containing these OpenOCD binaries, any third party may obtain a complete machine-readable copy of the corresponding source code for OpenOCD and its bundled GPL/LGPL libraries (matching commit `6fbe9e772476ce55c634cb0e8cd14244588ee9e2` and its build scripts) by opening a request at <https://github.com/zhuangyan114/Orbit/issues>, at no charge via download or for a fee no greater than the actual cost of physically performing source distribution.

### Disclaimer of Warranty

OpenOCD and its bundled components are distributed WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See `resources/openocd/LICENSES/preferred/GPL-2.0` for full terms.

## 2. Node.js Dependencies and External Tools

- **External user-installed tools** (not bundled in Orbit): SEGGER J-Link Software (`JLink_x64.dll` / `JLink.exe`), RMLink Connector Service, and GNU Arm Embedded Toolchain remain subject to their respective licenses.
