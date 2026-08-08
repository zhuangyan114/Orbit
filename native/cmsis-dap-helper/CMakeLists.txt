cmake_minimum_required(VERSION 3.20)

project(ozone_cmsis_dap_helper LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "orbit-cmsis-dap-helper is Windows-only")
endif()

add_executable(orbit-cmsis-dap-helper
  src/main.cpp
  src/json_rpc.cpp
  src/cmsis_dap_hid_transport.cpp
  src/cmsis_dap_winusb_transport.cpp
  src/mock_transport.cpp
  src/cmsis_dap_protocol.cpp
  src/cmsis_dap_target.cpp
  src/cortex_m_debug.cpp
  src/cmsis_dap_source_step.cpp
  src/cmsis_dap_startup_stop.cpp
  src/segger_rtt.cpp
  src/fpb_breakpoint.cpp
  src/trace_control.cpp
)
target_compile_features(orbit-cmsis-dap-helper PRIVATE cxx_std_17)
target_compile_definitions(orbit-cmsis-dap-helper PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)

if(MSVC)
  target_compile_options(orbit-cmsis-dap-helper PRIVATE /W4 /permissive- /EHsc /utf-8)
  set_property(TARGET orbit-cmsis-dap-helper PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
else()
  target_compile_options(orbit-cmsis-dap-helper PRIVATE -Wall -Wextra -Wpedantic)
  if(MINGW)
    target_compile_options(orbit-cmsis-dap-helper PRIVATE -Wno-cast-function-type)
    target_link_options(orbit-cmsis-dap-helper PRIVATE -static -static-libgcc -static-libstdc++)
  endif()
endif()

target_link_libraries(orbit-cmsis-dap-helper PRIVATE hid setupapi winusb)

add_executable(orbit-cmsis-dap-rtt-tests
  src/segger_rtt.cpp
  src/segger_rtt_test.cpp
)
target_compile_features(orbit-cmsis-dap-rtt-tests PRIVATE cxx_std_17)
if(MSVC)
  target_compile_options(orbit-cmsis-dap-rtt-tests PRIVATE /W4 /permissive- /EHsc /utf-8)
  set_property(TARGET orbit-cmsis-dap-rtt-tests PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
else()
  target_compile_options(orbit-cmsis-dap-rtt-tests PRIVATE -Wall -Wextra -Wpedantic)
endif()

set_target_properties(orbit-cmsis-dap-helper PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin"
)

set_target_properties(orbit-cmsis-dap-rtt-tests PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin"
)
