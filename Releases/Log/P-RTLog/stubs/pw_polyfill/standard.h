// Stub: pw_polyfill/standard.h
// Provides C++ standard library polyfills for older compilers.
// For C++17 and later, this is mostly just including standard headers.
#pragma once

#ifdef __cplusplus

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <type_traits>
#include <utility>

// C++17 provides these natively
#if __cplusplus >= 201703L
#include <string_view>
#endif

#endif  // __cplusplus
