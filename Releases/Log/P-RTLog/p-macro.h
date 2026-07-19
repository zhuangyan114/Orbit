#pragma once

// p-macro.h - Lean preprocessor macros for GCC & Clang only
// Derived from pigweed pw_preprocessor (Apache 2.0)
// Supports max 14 tokenized arguments (P_TOKENIZER_MAX_SUPPORTED_ARGS)

// =============================================================================
// Basic utilities (from util.h)
// =============================================================================

#define P_STRINGIFY(...) _P_STRINGIFY(__VA_ARGS__)
#define _P_STRINGIFY(...) #__VA_ARGS__

#define P_ARRAY_SIZE(array) (sizeof(array) / sizeof(*array))

#ifdef __cplusplus
#define P_EXTERN_C extern "C"
#define P_EXTERN_C_START extern "C" {
#define P_EXTERN_C_END }  // extern "C"
#else
#define P_EXTERN_C
#define P_EXTERN_C_START
#define P_EXTERN_C_END
#endif

// =============================================================================
// Compiler attributes (GCC/Clang only, no Apple/MinGW/MSVC branches)
// =============================================================================

#define P_PACKED(declaration) declaration __attribute__((packed))
#define P_USED __attribute__((used))
#define P_KEEP_IN_SECTION(name) __attribute__((section(name), used))
#define P_PLACE_IN_SECTION(name) __attribute__((section(name)))
#define P_PRINTF_FORMAT(format_index, parameter_index) \
  __attribute__((format(printf, format_index, parameter_index)))

// Clang supports no_sanitize; GCC does not have this attribute
#ifdef __clang__
#define P_NO_SANITIZE(check) __attribute__((no_sanitize(check)))
#else
#define P_NO_SANITIZE(check)
#endif

// =============================================================================
// Boolean macros (only P_NOT is used internally by P_HAS_ARGS)
// =============================================================================

#define P_NOT(value) _P_NOT(value)
#define _P_NOT(value) _P_NOT_##value()
#define _P_NOT_0() 1
#define _P_NOT_1() 0

// =============================================================================
// Internal helpers
// =============================================================================

#define _P_EXPAND(...) __VA_ARGS__

#define _P_IF(boolean, true_expr, false_expr) \
  _P_PASTE2(_P_IF_, boolean)(true_expr, false_expr)
#define _P_IF_0(true_expr, false_expr) false_expr
#define _P_IF_1(true_expr, false_expr) true_expr

#define _P_PASTE2(a1, a2) _P_PASTE2_EXPANDED(a1, a2)
#define _P_PASTE2_EXPANDED(a1, a2) _P_PASTE2_IMPL(a1, a2)
#define _P_PASTE2_IMPL(a1, a2) a1##a2

// =============================================================================
// Argument counting (0-15, enough for 14 max tokenizer args)
// =============================================================================

#define P_MACRO_ARG_COUNT(...) \
  _P_MACRO_ARG_COUNT_IMPL(__VA_ARGS__, \
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, P_HAS_ARGS(__VA_ARGS__))

#define _P_MACRO_ARG_COUNT_IMPL( \
    a1, a2, a3, a4, a5, a6, a7, a8, \
    a9, a10, a11, a12, a13, a14, a15, \
    count, ...) count

// --- _P_LAST_ARG_n: extract the last (nth) argument ---

#define _P_LAST_ARG_0()
#define _P_LAST_ARG_1(a1) a1
#define _P_LAST_ARG_2(a1, a2) a2
#define _P_LAST_ARG_3(a1, a2, a3) a3
#define _P_LAST_ARG_4(a1, a2, a3, a4) a4
#define _P_LAST_ARG_5(a1, a2, a3, a4, a5) a5
#define _P_LAST_ARG_6(a1, a2, a3, a4, a5, a6) a6
#define _P_LAST_ARG_7(a1, a2, a3, a4, a5, a6, a7) a7
#define _P_LAST_ARG_8(a1, a2, a3, a4, a5, a6, a7, a8) a8
#define _P_LAST_ARG_9(a1, a2, a3, a4, a5, a6, a7, a8, a9) a9
#define _P_LAST_ARG_10(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) a10
#define _P_LAST_ARG_11(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) a11
#define _P_LAST_ARG_12(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) a12
#define _P_LAST_ARG_13(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13) a13
#define _P_LAST_ARG_14(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14) a14
#define _P_LAST_ARG_15(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15) a15

// --- _P_DROP_LAST_ARG_n: all arguments except the last ---

#define _P_DROP_LAST_ARG_0()
#define _P_DROP_LAST_ARG_1(a1)
#define _P_DROP_LAST_ARG_2(a1, a2) a1
#define _P_DROP_LAST_ARG_3(a1, a2, a3) a1, a2
#define _P_DROP_LAST_ARG_4(a1, a2, a3, a4) a1, a2, a3
#define _P_DROP_LAST_ARG_5(a1, a2, a3, a4, a5) a1, a2, a3, a4
#define _P_DROP_LAST_ARG_6(a1, a2, a3, a4, a5, a6) a1, a2, a3, a4, a5
#define _P_DROP_LAST_ARG_7(a1, a2, a3, a4, a5, a6, a7) a1, a2, a3, a4, a5, a6
#define _P_DROP_LAST_ARG_8(a1, a2, a3, a4, a5, a6, a7, a8) a1, a2, a3, a4, a5, a6, a7
#define _P_DROP_LAST_ARG_9(a1, a2, a3, a4, a5, a6, a7, a8, a9) a1, a2, a3, a4, a5, a6, a7, a8
#define _P_DROP_LAST_ARG_10(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) a1, a2, a3, a4, a5, a6, a7, a8, a9
#define _P_DROP_LAST_ARG_11(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) a1, a2, a3, a4, a5, a6, a7, a8, a9, a10
#define _P_DROP_LAST_ARG_12(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12) a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11
#define _P_DROP_LAST_ARG_13(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13) a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12
#define _P_DROP_LAST_ARG_14(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14) a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13
#define _P_DROP_LAST_ARG_15(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15) a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14

#define P_LAST_ARG(...) \
  _P_PASTE2(_P_LAST_ARG_, P_MACRO_ARG_COUNT(__VA_ARGS__))(__VA_ARGS__)

#define P_DROP_LAST_ARG(...) \
  _P_PASTE2(_P_DROP_LAST_ARG_, P_MACRO_ARG_COUNT(__VA_ARGS__))(__VA_ARGS__)

// =============================================================================
// Argument dispatch macros (from arguments.h)
// =============================================================================

// __VA_OPT__ is supported by GCC 12+ and Clang 9+ — no fallback needed
#define P_EMPTY_ARGS(...) _P_EMPTY_ARGS_##__VA_OPT__(0)
#define _P_EMPTY_ARGS_ 1
#define _P_EMPTY_ARGS_0 0

#define P_HAS_ARGS(...) P_NOT(P_EMPTY_ARGS(__VA_ARGS__))

#define P_DROP_LAST_ARG_IF_EMPTY(...) \
  _P_IF(P_EMPTY_ARGS(P_LAST_ARG(__VA_ARGS__)), P_DROP_LAST_ARG, _P_EXPAND) \
  (__VA_ARGS__)

#define P_COMMA_ARGS(...) \
  _P_IF(P_EMPTY_ARGS(__VA_ARGS__), _P_EXPAND, _P_COMMA_ARGS) \
  (P_DROP_LAST_ARG_IF_EMPTY(__VA_ARGS__))
#define _P_COMMA_ARGS(...) , __VA_ARGS__

#define P_DELEGATE_BY_ARG_COUNT(function, ...) \
  _P_DELEGATE_BY_ARG_COUNT( \
      _P_PASTE2(function, P_FUNCTION_ARG_COUNT(__VA_ARGS__)), \
      P_DROP_LAST_ARG_IF_EMPTY(__VA_ARGS__))
#define _P_DELEGATE_BY_ARG_COUNT(function, ...) function(__VA_ARGS__)

#define P_FUNCTION_ARG_COUNT(...) \
  _P_FUNCTION_ARG_COUNT(P_LAST_ARG(__VA_ARGS__), __VA_ARGS__)
#define _P_FUNCTION_ARG_COUNT(last_arg, ...) \
  _P_PASTE2(_P_FUNCTION_ARG_COUNT_, P_EMPTY_ARGS(last_arg))(__VA_ARGS__)
#define _P_FUNCTION_ARG_COUNT_0 P_MACRO_ARG_COUNT
#define _P_FUNCTION_ARG_COUNT_1(...) \
  P_MACRO_ARG_COUNT(P_DROP_LAST_ARG(__VA_ARGS__))

// =============================================================================
// Token concatenation (0-4 args, only 4 is actually used)
// =============================================================================

#define P_CONCAT(...) \
  _P_CONCAT_IMPL1(P_MACRO_ARG_COUNT(__VA_ARGS__), __VA_ARGS__)
#define _P_CONCAT_IMPL1(count, ...) _P_CONCAT_IMPL2(count, __VA_ARGS__)
#define _P_CONCAT_IMPL2(count, ...) _P_CONCAT_##count(__VA_ARGS__)

#define _P_CONCAT_0()
#define _P_CONCAT_1(a1) a1
#define _P_CONCAT_2(a1, a2) a1##a2
#define _P_CONCAT_3(a1, a2, a3) a1##a2##a3
#define _P_CONCAT_4(a1, a2, a3, a4) a1##a2##a3##a4


