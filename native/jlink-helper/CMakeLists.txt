cmake_minimum_required(VERSION 3.20)

project(ozone_jlink_helper LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "orbit-jlink-helper is Windows-only")
endif()

add_executable(orbit-jlink-helper
  src/main.cpp
  ../cmsis-dap-helper/src/segger_rtt.cpp
)
target_compile_features(orbit-jlink-helper PRIVATE cxx_std_17)
target_compile_definitions(orbit-jlink-helper PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_include_directories(orbit-jlink-helper PRIVATE ../cmsis-dap-helper/src)

add_library(ozone-jlink-mock SHARED test/mock-jlink.cpp test/mock-jlink.def)
target_compile_features(ozone-jlink-mock PRIVATE cxx_std_17)
set_target_properties(ozone-jlink-mock PROPERTIES PREFIX "" OUTPUT_NAME "JLink_x64")

if(MSVC)
  target_compile_options(orbit-jlink-helper PRIVATE /W4 /permissive- /EHsc /utf-8)
  set_property(TARGET orbit-jlink-helper PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
else()
  target_compile_options(orbit-jlink-helper PRIVATE -Wall -Wextra -Wpedantic)
  if(MINGW)
    target_compile_options(orbit-jlink-helper PRIVATE -Wno-cast-function-type)
    target_link_options(orbit-jlink-helper PRIVATE -static -static-libgcc -static-libstdc++)
  endif()
endif()

set_target_properties(orbit-jlink-helper PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin"
)

set_target_properties(ozone-jlink-mock PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/mock"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin/mock"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin/mock"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin/mock"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin/mock"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/mock"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/mock"
)
