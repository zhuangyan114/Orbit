cmake_minimum_required(VERSION 3.20)
project(orbit_rtos_fixtures LANGUAGES C ASM)
set(CMAKE_C_STANDARD 11)
set(FR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/freertos")
set(SV "${CMAKE_CURRENT_SOURCE_DIR}/vendor/systemview")
set(RTT "${CMAKE_CURRENT_SOURCE_DIR}/vendor/rtt/RTT")
set(CORE "${CMAKE_CURRENT_SOURCE_DIR}/vendor/cmsis")
file(GLOB KERNEL "${FR}/*.c")

# 保留原链接脚本快照及 hash；生成实际构建副本，只移除丢弃标准库的旧条款。
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/vendor/board/STM32H723XG_FLASH.ld" LINKER_TEXT)
string(REGEX REPLACE "/DISCARD/[^}]*}" "" LINKER_TEXT "${LINKER_TEXT}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/fixture.ld" "${LINKER_TEXT}")

function(fixture name api stats bound tickless mode optimization)
  add_executable(${name}
    firmware/main.c firmware/ambiguity-a.c firmware/ambiguity-b.c
    vendor/board/startup_stm32h723xx.s "${CORE}/system_stm32h7xx.c"
    ${KERNEL} "${FR}/portable/GCC/ARM_CM4F/port.c" "${FR}/portable/MemMang/heap_4.c")
  target_include_directories(${name} PRIVATE config "${CORE}" "${FR}/include" "${FR}/portable/GCC/ARM_CM4F")
  target_compile_definitions(${name} PRIVATE STM32H723xx
    FIXTURE_API=${api} FIXTURE_STATS=${stats} FIXTURE_STACK_BOUND=${bound}
    FIXTURE_TICKLESS=${tickless} FIXTURE_MODE=${mode} CMSIS_device_header="stm32h7xx.h")
  if(api EQUAL 1)
    target_sources(${name} PRIVATE "${FR}/CMSIS_RTOS/cmsis_os.c")
    target_include_directories(${name} PRIVATE "${FR}/CMSIS_RTOS")
  elseif(api EQUAL 2)
    target_sources(${name} PRIVATE "${FR}/CMSIS_RTOS_V2/cmsis_os2.c")
    # 应用和包装实现均使用该包装层自带的同一份 API 头，避免两个 cmsis_os2.h 混用。
    target_include_directories(${name} BEFORE PRIVATE "${FR}/CMSIS_RTOS_V2")
  endif()
  if(mode GREATER 0)
    target_sources(${name} PRIVATE "${SV}/SYSVIEW/SEGGER_SYSVIEW.c"
      "${SV}/FreeRTOSV10/SEGGER_SYSVIEW_FreeRTOS.c" "${RTT}/SEGGER_RTT.c")
    target_include_directories(${name} PRIVATE "${SV}/SYSVIEW" "${SV}/SEGGER"
      "${SV}/Config" "${SV}/FreeRTOSV10" "${RTT}")
    target_compile_definitions(${name} PRIVATE RTT_USE_ASM=0)
  endif()
  target_compile_options(${name} PRIVATE -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
    ${optimization} -g3 -gdwarf-4 -ffunction-sections -fdata-sections -Wall -Wextra
    "-ffile-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}=/orbit-fixture"
    "-fdebug-prefix-map=${CMAKE_CURRENT_BINARY_DIR}=/orbit-fixture/build"
    -Werror=implicit-function-declaration)
  target_link_options(${name} PRIVATE -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
    -nostartfiles --specs=nano.specs --specs=nosys.specs
    "-T${CMAKE_CURRENT_BINARY_DIR}/fixture.ld" -Wl,--gc-sections -Wl,--undefined=fixtureConfiguration
    "-Wl,-Map=${CMAKE_CURRENT_BINARY_DIR}/${name}.map")
  target_link_libraries(${name} PRIVATE m)
  set_target_properties(${name} PROPERTIES SUFFIX ".elf")
endfunction()
fixture(native-debug       0 1 1 0 0 -Og)
fixture(cmsis-v1           1 1 1 0 0 -Og)
fixture(cmsis-v2           2 1 1 0 0 -Og)
fixture(native-optimized   0 1 1 0 0 -O2)
fixture(native-no-stats    0 0 1 0 0 -Og)
fixture(native-no-stack-bound 0 1 0 0 0 -Og)
fixture(native-tickless    0 1 1 1 0 -Og)
fixture(trace-continuous   0 1 1 0 1 -Og)
fixture(trace-single-shot  0 1 1 0 2 -Og)
fixture(trace-post-mortem  0 1 1 0 3 -Og)
