// Copyright 2021 The Pigweed Authors
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
#pragma once

#include "pw_log/levels.h"
#include "pw_log/options.h"
#include "pw_polyfill/static_assert.h"
#include "tokenizer/config.h"


//PLS refer to line 170 to select your backend,or using your define.




/// @module{pw_log_tokenized}

// The size of the stack-allocated argument encoding buffer to use by default.
// A buffer of this size is allocated and used for the 4-byte token and for
// encoding all arguments. It must be at least large enough for the token (4
// bytes).
//
// This buffer does not need to be large to accommodate a good number of
// tokenized string arguments. Integer arguments are usually encoded smaller
// than their native size (e.g. 1 or 2 bytes for smaller numbers). All floating
// point types are encoded as four bytes. Null-terminated strings are encoded
// 1:1 in size, however, and can quickly fill up this buffer.
#ifndef P_LOG_TOKENIZED_ENCODING_BUFFER_SIZE_BYTES
#define P_LOG_TOKENIZED_ENCODING_BUFFER_SIZE_BYTES \
  P_TOKENIZER_CFG_ENCODING_BUFFER_SIZE_BYTES
#endif  // P_LOG_TOKENIZED_ENCODING_BUFFER_SIZE_BYTES

#define P_LOG_TOKENIZED_FIELD_PREFIX "■"
#define P_LOG_TOKENIZED_KEY_VALUE_SEPARATOR "♦"

// This macro takes the P_LOG format string and optionally transforms it. By
// default, pw_log_tokenized specifies three fields as key-value pairs.
#ifndef P_LOG_TOKENIZED_FORMAT_STRING

#define _P_LOG_TOKENIZED_FIELD(name, contents)                           \
  P_LOG_TOKENIZED_FIELD_PREFIX name P_LOG_TOKENIZED_KEY_VALUE_SEPARATOR \
      contents

/// This macro takes the `pw_log` module name and format string to produce a new
/// string that will be tokenized. Any information can be packed into this
/// string without affecting code size, since tokenization removes it from the
/// binary. By default, `pw_log_tokenized` includes three fields as key-value
/// pair: log module, message, and file path (`__FILE__`).
#define P_LOG_TOKENIZED_FORMAT_STRING(module, message) \
  _P_LOG_TOKENIZED_FIELD("msg", message)               \
  _P_LOG_TOKENIZED_FIELD("module", module)             \
  _P_LOG_TOKENIZED_FIELD("file", __FILE__)

#endif  // P_LOG_TOKENIZED_FORMAT_STRING

// The log level, line number, flag bits, and module token are packed into the
// tokenizer's payload argument, which is typically 32 bits. These macros
// specify the number of bits to use for each field. A field with zero bits is
// excluded.

/// Bits to allocate for the log level. Defaults to `P_LOG_LEVEL_BITS` (3).
#ifndef P_LOG_TOKENIZED_LEVEL_BITS
#define P_LOG_TOKENIZED_LEVEL_BITS P_LOG_LEVEL_BITS
#endif  // P_LOG_TOKENIZED_LEVEL_BITS

/// Bits to allocate for the line number. Defaults to 11 (up to line 2047). If
/// the line number is too large to be represented by this field, line is
/// reported as 0.
///
/// Including the line number can slightly increase code size. Without the line
/// number, the log metadata argument is the same for all logs with the same
/// level and flags. With the line number, each metadata value is unique and
/// must be encoded as a separate word in the binary. Systems with extreme space
/// constraints may exclude line numbers by setting this macro to 0.
///
/// It is possible to include line numbers in tokenized log format strings, but
/// that is discouraged because line numbers change whenever a file is edited.
/// Passing the line number with the metadata is a lightweight way to include
/// it.
#ifndef P_LOG_TOKENIZED_LINE_BITS
#define P_LOG_TOKENIZED_LINE_BITS 11
#endif  // P_LOG_TOKENIZED_LINE_BITS

/// Bits to use for implementation-defined flags. Defaults to 2.
#ifndef P_LOG_TOKENIZED_FLAG_BITS
#define P_LOG_TOKENIZED_FLAG_BITS 2
#endif  // P_LOG_TOKENIZED_FLAG_BITS

/// Bits to use for the tokenized version of `P_LOG_MODULE_NAME`. Defaults to
/// 16, which gives a ~1% probability of a collision with 37 module names.
#ifndef P_LOG_TOKENIZED_MODULE_BITS
#define P_LOG_TOKENIZED_MODULE_BITS 16
#endif  // P_LOG_TOKENIZED_MODULE_BITS

#ifdef __cplusplus
#define P_RTLOG_STATIC_ASSERT(condition, message) static_assert(condition, message)
#else
#define P_RTLOG_STATIC_ASSERT(condition, message) _Static_assert(condition, message)
#endif

P_RTLOG_STATIC_ASSERT((P_LOG_TOKENIZED_LEVEL_BITS + P_LOG_TOKENIZED_LINE_BITS +
                       P_LOG_TOKENIZED_FLAG_BITS + P_LOG_TOKENIZED_MODULE_BITS) == 32,
                      "Log metadata fields must use 32 bits");

// If the level field is present, clamp it to the maximum value.
#if P_LOG_TOKENIZED_LEVEL_BITS == 0
#define _P_LOG_TOKENIZED_LEVEL(value) ((uintptr_t)0)
#else
#define _P_LOG_TOKENIZED_LEVEL(value)                   \
  (value < ((uintptr_t)1 << P_LOG_TOKENIZED_LEVEL_BITS) \
       ? value                                           \
       : ((uintptr_t)1 << P_LOG_TOKENIZED_LEVEL_BITS) - 1)
#endif  // P_LOG_TOKENIZED_LEVEL_BITS

// If the line number field is present, shift it to its position. Set it to zero
// if the line number is too large for P_LOG_TOKENIZED_LINE_BITS.
#if P_LOG_TOKENIZED_LINE_BITS == 0
#define _P_LOG_TOKENIZED_LINE(line) ((uintptr_t)0)
#else
#define _P_LOG_TOKENIZED_LINE(line)                                \
  ((uintptr_t)(line < (1 << P_LOG_TOKENIZED_LINE_BITS) ? line : 0) \
   << P_LOG_TOKENIZED_LEVEL_BITS)
#endif  // P_LOG_TOKENIZED_LINE_BITS

// If the flags field is present, mask it and shift it to its position.
#if P_LOG_TOKENIZED_FLAG_BITS == 0
#define _P_LOG_TOKENIZED_FLAGS(value) ((uintptr_t)0)
#else
#define _P_LOG_TOKENIZED_FLAGS(value)                                       \
  (((uintptr_t)(value) & (((uintptr_t)1 << P_LOG_TOKENIZED_FLAG_BITS) - 1)) \
   << (P_LOG_TOKENIZED_LEVEL_BITS + P_LOG_TOKENIZED_LINE_BITS))
#endif  // P_LOG_TOKENIZED_FLAG_BITS

// If the module field is present, shift it to its position.
#if P_LOG_TOKENIZED_MODULE_BITS == 0
#define _P_LOG_TOKENIZED_MODULE(value) ((uintptr_t)0)
#else
#define _P_LOG_TOKENIZED_MODULE(value)                  \
  ((uintptr_t)(value) << ((P_LOG_TOKENIZED_LEVEL_BITS + \
                           P_LOG_TOKENIZED_LINE_BITS +  \
                           P_LOG_TOKENIZED_FLAG_BITS)))
#endif  // P_LOG_TOKENIZED_MODULE_BITS



#define P_LOG_LEVEL_INFO 0
#define P_LOG_LEVEL_WARN 1
#define P_LOG_LEVEL_ERROR 2




// =============================================================================
// Backend selection (mutually exclusive — define exactly ONE)
// =============================================================================
//
// Usage:
//   In your project settings or compiler flags, define one of:
//     -DUSING_RTT_BACKEND     → SEGGER RTT (J-Link)
//     -DUSING_UART_BACKEND    → UART (future)
//     -DUSING_SWO_BACKEND     → SWO/ITM   (future)
//
// If none is defined, a compile-time error is raised.
// If more than one is defined, a compile-time error is raised.
// =============================================================================
// Here to Select your backend
#if !defined(USING_RTT_BACKEND) && !defined(USING_UART_BACKEND) && !defined(USING_SWO_BACKEND)
#define USING_RTT_BACKEND  // Default backend
#endif

#if defined(USING_RTT_BACKEND) + defined(USING_UART_BACKEND) + defined(USING_SWO_BACKEND) > 1
  #error "Only one log backend can be enabled at a time (USING_RTT_BACKEND / USING_UART_BACKEND / USING_SWO_BACKEND)"
#endif

#if !defined(USING_RTT_BACKEND) && !defined(USING_UART_BACKEND) && !defined(USING_SWO_BACKEND)
  #error "No log backend selected. Define one of: USING_RTT_BACKEND, USING_UART_BACKEND, USING_SWO_BACKEND"
#endif


#ifdef USING_RTT_BACKEND
  
// default options for RTT backend
#define P_RTT_LOG_CHANNEL 0

#endif  // USING_RTT_BACKEND

#ifdef __cplusplus

#include <cstddef>

namespace pw::log_tokenized {

// C++ constant for the encoding buffer size. Use this instead of the macro.
inline constexpr size_t kEncodingBufferSizeBytes =
    P_LOG_TOKENIZED_ENCODING_BUFFER_SIZE_BYTES;

}  // namespace pw::log_tokenized

#endif  // __cplusplus

/// @endmodule
