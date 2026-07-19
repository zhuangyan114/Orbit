/**
 * @file plog_tokenized_light.c
 * @brief 轻量级的plog_tokenized实现（纯C版本）
 * @author 
 * @date 2026-07-03
 */

#include <stdint.h>
#include <string.h>
#include <stdarg.h>
#include "log_tokenized/log_tokenized_light.h"
#include "tokenizer/internal/argument_types.h"
#include "P-span.h"
#include "p_varint.h"
#include "p-macro.h"
#include "light_handler.h"
#include "p_rtlog_config.h"

/* C 语言没有 std::min，手写一个 */
#define P_MIN(a, b) (((a) < (b)) ? (a) : (b))
//绝大部分CC中的pw_tokenizer_Token和pw_tokenizer_ArgTypes之类的类型都是uint32_t类型，所以这里直接使用uint32_t来代替
//至于这是为什么尚不清楚
typedef struct {
    uint8_t data[P_LOG_TOKENIZED_ENCODING_BUFFER_SIZE_BYTES];  // 缓冲区用于存储编码后的日志消息
    size_t size;
} p_encoded_message_t;





//怎么封装这么多层，恼
/// Encodes an `int` with the standard integer encoding: zig-zag + LEB128.
/// This function is only necessary when manually encoding tokenized messages.
static inline size_t pw_tokenizer_EncodeInt(int value,
                                            void* output,
                                            size_t output_size_bytes) {
  return pw_varint_Encode32(
      pw_varint_ZigZagEncode32(value), output, output_size_bytes);
}

/// Encodes an `int64_t` with the standard integer encoding: zig-zag + LEB128.
/// This function is only necessary when manually encoding tokenized messages.
static inline size_t pw_tokenizer_EncodeInt64(int64_t value,
                                              void* output,
                                              size_t output_size_bytes) {
  return pw_varint_Encode64(
      pw_varint_ZigZagEncode64(value), output, output_size_bytes);
}



//照抄完了才发现只是个封装的函数调用，晕。先留着吧。万一以后要用呢
static inline size_t p_encode_int(int value, p_span_t output) {
  // Use the 64-bit function to avoid instantiating both 32-bit and 64-bit.
  return pw_tokenizer_EncodeInt64(value, output.data, output.size);
}

static inline size_t p_encode_int64(int64_t value, p_span_t output) {
  return pw_tokenizer_EncodeInt64(value, output.data, output.size);
}

static inline size_t p_encode_float(float value, p_span_t output) {
  if (output.size < sizeof(value)) {
    return 0;
  }
  memcpy(output.data, &value, sizeof(value));
  return sizeof(value);
}

static inline size_t p_encode_string(const char* string, p_span_t output) {
  // The top bit of the status byte indicates if the string was truncated.
  static const size_t kMaxStringLength = 0x7Fu;

  if (output.size == 0) {  // At least one byte is needed for the status/size.
    return 0;
  }

  if (string == NULL) {
    string = "NULL";
  }

  // Subtract 1 to save room for the status byte.
  const size_t max_bytes = P_MIN(output.size, kMaxStringLength) - 1;

  // Scan the string to find out how many bytes to copy.
  size_t bytes_to_copy = 0;
  uint8_t overflow_bit = 0;

  while (string[bytes_to_copy] != '\0') {
    if (bytes_to_copy == max_bytes) {
      overflow_bit = 0x80;
      break;
    }
    bytes_to_copy += 1;
  }

  output.data[0] = (uint8_t)(bytes_to_copy) | overflow_bit;
  memcpy(output.data + 1, string, bytes_to_copy);

  return bytes_to_copy + 1;  // include the status byte in the total
}

/**
 * @brief 编码日志消息
 * @param types 日志消息的参数类型
 * @param args 可变参数列表
 * @param output 输出缓冲区，用于存储编码后的日志消息
 * @return size_t 编码后的字节数
 * @note 本质上是个序列化的引擎
 */
size_t p_encode_args(uint32_t types,
                  va_list args,
                  p_span_t output) {
  
    
  size_t arg_count = types & P_TOKENIZER_TYPE_COUNT_MASK;
  //这一步的目的是
  //type通过2位来表示参数类型，然后因为是uint32_t,可以储存14个参数类型，以及最末尾的4位表示参数数量，所以右移14个2bit后，剩下的就是参数数量了
  //所以文件末尾你可以看到右移2位，继续取后两位来判断下一个参数类型
  types >>= P_TOKENIZER_TYPE_COUNT_SIZE_BITS;

  size_t encoded_bytes = 0;
  while (arg_count != 0u) {
    // How many bytes were encoded; 0 indicates that there wasn't enough space.
    size_t argument_bytes = 0;
    //这段谷歌原意大概就是区分不同长度的消息类型。
    //0xb11u展开就是0b00000011，表示取types的最后两位，来判断参数类型
    //由于最后两位被规定为参数类型，所以只有四种可能的值，分别对应int、int64、double和string
    switch (types & 0b11u) {
     case 0:  /* int */
        argument_bytes = p_encode_int(va_arg(args, int), output);
        break;
      case 1:  /* int64 */
        argument_bytes = p_encode_int64(va_arg(args, int64_t), output);
        break;
      case 2:  /* double -> float */
      //这和可变参数的屎山有关系，在 C/C++ 中，当参数通过 可变参数（... / va_list） 传递时，会触发 默认参数提升：
      //1. float 类型的参数会被提升为 double 类型。
      //2. char 和 short 类型的参数会被提升为 int 类型。
      //因此，即使你在函数中传递了一个 float 类型的参数，它也会被提升为 double 类型，并且在 va_arg 中你必须使用 double 来获取它。
      //所以谷歌和我都只设计了double，做个转换成float 
        argument_bytes = p_encode_float((float)va_arg(args, double), output);//通常来说不用double的
        break;
      case 3:  /* string */
        argument_bytes = p_encode_string(va_arg(args, const char *), output);
        break;
    }

    // If zero bytes were encoded, the encoding buffer is full.
    if (argument_bytes == 0u) {
      break;
    }
    //开个子视图，
    output = p_span_subspan(&output, argument_bytes,
                            p_span_size(&output) - argument_bytes);
    encoded_bytes += argument_bytes;

    arg_count -= 1;
    types >>= 2;  // each argument type is encoded in two bits
  }

  return encoded_bytes;
}


/**
原文件大概如下：
EncodedMessage(pw_tokenizer_Token token,
                 pw_tokenizer_ArgTypes types,
                 va_list args) {
    std::memcpy(data_, &token, sizeof(token));
    size_ =
        sizeof(token) +
        EncodeArgs(types, args, span<std::byte>(data_).subspan(sizeof(token)));
  }

*/


static void p_encoded_message(
                 p_encoded_message_t *msg,
                 uint32_t token,
                 uint32_t types,
                 va_list args) {

        memcpy(msg->data, &token, sizeof(token));
        // 创建跳过 token 的 span，用于编码参数
        p_span_t args_span = p_span_make(msg->data + sizeof(token),
                                         P_LOG_TOKENIZED_ENCODING_BUFFER_SIZE_BYTES - sizeof(token));
        msg->size = sizeof(token) + p_encode_args(types, args, args_span);
}
//施工中，先实现依赖的各种函数
//可变参数函数，...后面可以填若干参数
void _pw_log_tokenized_EncodeTokenizedLogWithoutMetadata(uint32_t token, uint32_t types, ...) {
  va_list args;//va_list 是一个用于访问可变参数的类型，通常用于实现类似 printf 的函数。
  //这里开始初始化arg,
  va_start(args, types);
  //没有cpp隐式初始化的data和size，所以手动实现一个，反正打完log就放弃了
  p_encoded_message_t encoded_message;
  p_encoded_message(&encoded_message, token, types, args);
  //此时size和data都缓存到encoded_message里了

  va_end(args);

  pw_log_tokenized_HandleLogWithoutMetadata(encoded_message.data, encoded_message.size);
}
