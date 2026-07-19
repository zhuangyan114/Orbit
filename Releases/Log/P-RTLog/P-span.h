#ifndef P_SPAN_H
#define P_SPAN_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint8_t *data;
  size_t size;
} p_span_t;

static inline p_span_t p_span_make(uint8_t *data, size_t size) {
  p_span_t span = { data, size };
  return span;
}

static inline size_t p_span_size(const p_span_t *span) {
  return span ? span->size : 0;
}

static inline p_span_t p_span_subspan(const p_span_t *span, size_t offset, size_t size) {
  if (!span || offset > span->size) {
    return p_span_make(NULL, 0);
  }
  if (size > span->size - offset) {
    size = span->size - offset;
  }
  return p_span_make(span->data + offset, size);
}

#endif
