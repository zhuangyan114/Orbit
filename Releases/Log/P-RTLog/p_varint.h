/**
 * @file p_varint.h
 * @brief 轻量级变长整数编码（ZigZag + LEB128），替代 pw_varint 依赖
 *
 * 仅提供 P-RTLog 实际用到的 4 个函数：
 *   - ZigZagEncode32/64：有符号 → 无符号映射
 *   - Encode32/64：无符号 → LEB128 变长字节流
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief ZigZag 编码：将有符号 32 位整数映射为无符号
 * @details 小绝对值的负数映射为小的正数，提高 LEB128 编码密度
 *          映射规则：0→0, -1→1, 1→2, -2→3, 2→4, ...
 */
static inline uint32_t pw_varint_ZigZagEncode32(int32_t value) {
    return ((uint32_t)value << 1) ^ (uint32_t)(value >> 31);
}

/**
 * @brief ZigZag 编码：将有符号 64 位整数映射为无符号
 */
static inline uint64_t pw_varint_ZigZagEncode64(int64_t value) {
    return ((uint64_t)value << 1) ^ (uint64_t)(value >> 63);
}

/**
 * @brief LEB128 变长编码：将无符号 32 位整数编码为字节流
 * @param value      待编码的无符号整数
 * @param out        输出缓冲区
 * @param out_size   输出缓冲区大小
 * @return 写入的字节数；若缓冲区不足则返回 0
 * @note 32 位整数最多编码为 5 字节
 */
static inline size_t pw_varint_Encode32(uint32_t value,
                                        void* out,
                                        size_t out_size) {
    uint8_t* p = (uint8_t*)out;
    size_t i = 0;
    do {
        if (i >= out_size) {
            return 0;
        }
        uint8_t byte = (uint8_t)(value & 0x7Fu);
        value >>= 7;
        if (value != 0u) {
            byte |= 0x80u;  // 设置续传标志位
        }
        p[i++] = byte;
    } while (value != 0u);
    return i;
}

/**
 * @brief LEB128 变长编码：将无符号 64 位整数编码为字节流
 * @param value      待编码的无符号整数
 * @param out        输出缓冲区
 * @param out_size   输出缓冲区大小
 * @return 写入的字节数；若缓冲区不足则返回 0
 * @note 64 位整数最多编码为 10 字节
 */
static inline size_t pw_varint_Encode64(uint64_t value,
                                        void* out,
                                        size_t out_size) {
    uint8_t* p = (uint8_t*)out;
    size_t i = 0;
    do {
        if (i >= out_size) {
            return 0;
        }
        uint8_t byte = (uint8_t)(value & 0x7Fu);
        value >>= 7;
        if (value != 0u) {
            byte |= 0x80u;  // 设置续传标志位
        }
        p[i++] = byte;
    } while (value != 0u);
    return i;
}

#ifdef __cplusplus
}  // extern "C"
#endif
