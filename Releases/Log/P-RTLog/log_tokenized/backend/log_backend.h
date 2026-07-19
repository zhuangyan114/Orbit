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

// This override header includes the main tokenized logging header and defines
// the P_LOG macro as the tokenized logging macro, without the metadata
// payload.
#pragma once

#include "log_tokenized/p_rtlog_config.h"
#include "log_tokenized/log_tokenized_light.h"

#define P_HANDLE_LOG P_LOG_TOKENIZED_TO_GLOBAL_HANDLER

#define P_LOG_FLAG_BITS P_LOG_TOKENIZED_FLAG_BITS
