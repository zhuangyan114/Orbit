// Copyright 2020 The Pigweed Authors
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License. You may obtain a copy of
// the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations under
// the License.

// This header provides internal macros used by the tokenizer module.
#pragma once

#include <stdint.h>

#include "p-macro.h"
#include "tokenizer/config.h"

// The size of the argument types variable determines the number of arguments
// supported in tokenized strings.
#if P_TOKENIZER_CFG_ARG_TYPES_SIZE_BYTES == 4

#include "tokenizer/internal/argument_types_macro_4_byte.h"

// Encoding types in a uint32_t supports 14 arguments with 2 bits per argument.
#define P_TOKENIZER_MAX_SUPPORTED_ARGS 14
#define P_TOKENIZER_TYPE_COUNT_SIZE_BITS 4u
#define P_TOKENIZER_TYPE_COUNT_MASK 0x0Fu

typedef uint32_t pw_tokenizer_ArgTypes;

#elif P_TOKENIZER_CFG_ARG_TYPES_SIZE_BYTES == 8

#include "tokenizer/internal/argument_types_macro_8_byte.h"

// Encoding types in a uint64_t supports 29 arguments with 2 bits per argument.
#define P_TOKENIZER_MAX_SUPPORTED_ARGS 29
#define P_TOKENIZER_TYPE_COUNT_SIZE_BITS 6u
#define P_TOKENIZER_TYPE_COUNT_MASK 0x1Fu  // only 5 bits will be needed

typedef uint64_t pw_tokenizer_ArgTypes;

#else

#error "Unsupported value for P_TOKENIZER_CFG_ARG_TYPES_SIZE_BYTES"

#endif  // P_TOKENIZER_CFG_ARG_TYPES_SIZE_BYTES

// The tokenized string encoding function is a variadic function that works
// similarly to printf. Instead of a format string, however, the argument types
// are packed into a pw_tokenizer_ArgTypes.
//
// The four supported argument types are represented by two-bit argument codes.
// Just four types are required because only printf-compatible arguments are
// supported, and variadic arguments are further converted to a more limited set
// of types.
//
// char* values cannot be printed as pointers with %p. These arguments are
// always encoded as strings. To format a char* as an address, cast it to void*
// or an integer.
#define P_TOKENIZER_ARG_TYPE_INT ((pw_tokenizer_ArgTypes)0)
#define P_TOKENIZER_ARG_TYPE_INT64 ((pw_tokenizer_ArgTypes)1)
#define P_TOKENIZER_ARG_TYPE_DOUBLE ((pw_tokenizer_ArgTypes)2)
#define P_TOKENIZER_ARG_TYPE_STRING ((pw_tokenizer_ArgTypes)3)

// Select the int argument type based on the size of the type. Values smaller
// than int are promoted to int.
#define _P_TOKENIZER_SELECT_INT_TYPE(type)                \
  (sizeof(type) <= sizeof(int) ? P_TOKENIZER_ARG_TYPE_INT \
                               : P_TOKENIZER_ARG_TYPE_INT64)

// The _P_VARARGS_TYPE macro selects the varargs-promoted type at compile time.
// The macro has to be different for C and C++ because C doesn't support
// templates and C++ doesn't support _Generic.
#ifdef __cplusplus

#include <type_traits>

#define _P_VARARGS_TYPE(arg) ::pw::tokenizer::VarargsType<decltype(arg)>()

namespace pw::tokenizer {

// This function selects the matching type enum for supported argument types.
template <typename T>
constexpr pw_tokenizer_ArgTypes VarargsType() {
  using ArgType = std::decay_t<T>;

  if constexpr (std::is_floating_point<ArgType>()) {
    return P_TOKENIZER_ARG_TYPE_DOUBLE;
  } else if constexpr (!std::is_null_pointer<ArgType>() &&
                       std::is_convertible<ArgType, const char*>()) {
    return P_TOKENIZER_ARG_TYPE_STRING;
  } else if constexpr (sizeof(ArgType) == sizeof(int64_t)) {
    return P_TOKENIZER_ARG_TYPE_INT64;
  } else {
    static_assert(sizeof(ArgType) <= sizeof(int));
    return P_TOKENIZER_ARG_TYPE_INT;
  }
}

}  // namespace pw::tokenizer

#else  // C version

// This uses a C11 _Generic to select the matching enum value for each supported
// argument type. _Generic evaluates to the expression matching the type of the
// provided expression at compile time.
// clang-format off
#define _P_VARARGS_TYPE(arg)                                            \
  _Generic((arg),                                                        \
               _Bool:  P_TOKENIZER_ARG_TYPE_INT,                        \
                char:  P_TOKENIZER_ARG_TYPE_INT,                        \
         signed char:  P_TOKENIZER_ARG_TYPE_INT,                        \
       unsigned char:  P_TOKENIZER_ARG_TYPE_INT,                        \
        signed short:  P_TOKENIZER_ARG_TYPE_INT,                        \
      unsigned short:  P_TOKENIZER_ARG_TYPE_INT,                        \
          signed int:  P_TOKENIZER_ARG_TYPE_INT,                        \
        unsigned int:  P_TOKENIZER_ARG_TYPE_INT,                        \
         signed long: _P_TOKENIZER_SELECT_INT_TYPE(signed long),        \
       unsigned long: _P_TOKENIZER_SELECT_INT_TYPE(unsigned long),      \
    signed long long: _P_TOKENIZER_SELECT_INT_TYPE(signed long long),   \
  unsigned long long: _P_TOKENIZER_SELECT_INT_TYPE(unsigned long long), \
               float:  P_TOKENIZER_ARG_TYPE_DOUBLE,                     \
              double:  P_TOKENIZER_ARG_TYPE_DOUBLE,                     \
         long double:  P_TOKENIZER_ARG_TYPE_DOUBLE,                     \
               char*:  P_TOKENIZER_ARG_TYPE_STRING,                     \
         const char*:  P_TOKENIZER_ARG_TYPE_STRING,                     \
             default: _P_TOKENIZER_SELECT_INT_TYPE(void*))
// clang-format on

#endif  // __cplusplus

#define _P_TOKENIZER_TYPES_0() ((pw_tokenizer_ArgTypes)0)
