// Copyright 2026 The Pigweed Authors
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

#include <stdint.h>
#include "p_rtlog_config.h"
#include "p-macro.h"
#include "tokenizer/tokenize.h"

/// @module{pw_log_tokenized}

#ifndef P_LOG_TOKENIZED_FORMAT_STRING_WITH_LEVEL
#define P_LOG_TOKENIZED_FORMAT_STRING_WITH_LEVEL(level, module, message) \
  P_LOG_TOKENIZED_FIELD_PREFIX "level" P_LOG_TOKENIZED_KEY_VALUE_SEPARATOR \
      P_STRINGIFY(level)                                                   \
  P_LOG_TOKENIZED_FORMAT_STRING(module, message)
#endif

/// This macro implements `P_LOG` using `pw_tokenizer` without any metadata.
/// Users must implement `pw_log_tokenized_HandleLogWithoutMetadata(const
/// uint8_t* buffer, size_t size)`.
#define P_LOG_TOKENIZED_TO_GLOBAL_HANDLER(level, module, flags, message, ...) \
  do {                                                                         \
    (void)flags;                                                               \
    P_LOG_TOKENIZED_ENCODE_MESSAGE_LIGHT(                                     \
        P_LOG_TOKENIZED_FORMAT_STRING_WITH_LEVEL(level, module, message),     \
        __VA_ARGS__);                                                         \
  } while (0)

/// Encodes a log message into the tokenized format without metadata.
///
/// This macro tokenizes the format string and calls the backend handler
/// `_pw_log_tokenized_EncodeTokenizedLogWithoutMetadata`.
#define P_LOG_TOKENIZED_ENCODE_MESSAGE_LIGHT(format, ...)               \
  do {                                                                   \
    P_TOKENIZE_FORMAT_STRING(                                           \
        P_TOKENIZER_DEFAULT_DOMAIN, UINT32_MAX, format, __VA_ARGS__);   \
    _pw_log_tokenized_EncodeTokenizedLogWithoutMetadata(                 \
        _pw_tokenizer_token,                                             \
        P_TOKENIZER_ARG_TYPES(__VA_ARGS__) P_COMMA_ARGS(__VA_ARGS__)); \
  } while (0)

/// @endmodule

#define P_LOG(message, ...) \
  P_LOG_TOKENIZED_TO_GLOBAL_HANDLER(P_LOG_LEVEL_INFO, "default", 0, message, __VA_ARGS__)

#define P_WARN(message, ...) \
  P_LOG_TOKENIZED_TO_GLOBAL_HANDLER(P_LOG_LEVEL_WARN, "default", 0, message, __VA_ARGS__)

#define P_ERROR(message, ...) \
  P_LOG_TOKENIZED_TO_GLOBAL_HANDLER(P_LOG_LEVEL_ERROR, "default", 0, message, __VA_ARGS__)
/// @cond
P_EXTERN_C_START

void _pw_log_tokenized_EncodeTokenizedLogWithoutMetadata(
    pw_tokenizer_Token token, pw_tokenizer_ArgTypes types, ...);

P_EXTERN_C_END
/// @endcond
