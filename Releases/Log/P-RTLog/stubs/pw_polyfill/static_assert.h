// Stub: pw_polyfill/static_assert.h
#pragma once

#ifdef __cplusplus
#include <cassert>
#else
#ifndef static_assert
#define static_assert(condition, message) _Static_assert(condition, message)
#endif
#endif
