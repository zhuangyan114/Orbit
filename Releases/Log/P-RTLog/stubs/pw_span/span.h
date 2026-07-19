// Stub: pw_span/span.h
// Provides a minimal span implementation for pw_tokenizer.
#pragma once

#ifdef __cplusplus

#include <cstddef>
#include <type_traits>
#include <array>

namespace pw {

// Minimal span implementation
template <typename T>
class span {
 public:
  using element_type = T;
  using value_type = std::remove_cv_t<T>;
  using size_type = std::size_t;
  using difference_type = std::ptrdiff_t;
  using pointer = T*;
  using const_pointer = const T*;
  using reference = T&;
  using const_reference = const T&;
  using iterator = pointer;
  using const_iterator = const_pointer;

  constexpr span() noexcept : data_(nullptr), size_(0) {}

  constexpr span(pointer ptr, size_type count) : data_(ptr), size_(count) {}

  constexpr span(pointer first, pointer last)
      : data_(first), size_(static_cast<size_type>(last - first)) {}

  template <std::size_t N>
  constexpr span(T (&arr)[N]) noexcept : data_(arr), size_(N) {}

  template <std::size_t N>
  constexpr span(std::array<value_type, N>& arr) noexcept
      : data_(arr.data()), size_(N) {}

  template <std::size_t N>
  constexpr span(const std::array<value_type, N>& arr) noexcept
      : data_(arr.data()), size_(N) {}

  constexpr pointer data() const noexcept { return data_; }
  constexpr size_type size() const noexcept { return size_; }
  constexpr bool empty() const noexcept { return size_ == 0; }

  constexpr reference operator[](size_type idx) const { return data_[idx]; }

  constexpr iterator begin() const noexcept { return data_; }
  constexpr iterator end() const noexcept { return data_ + size_; }

  constexpr span subspan(size_type offset, size_type count = static_cast<size_type>(-1)) const {
    if (count == static_cast<size_type>(-1)) {
      count = size_ - offset;
    }
    return span(data_ + offset, count);
  }

 private:
  pointer data_;
  size_type size_;
};

// Helper function to create span from array
template <typename T, std::size_t N>
constexpr span<T> make_span(T (&arr)[N]) {
  return span<T>(arr);
}

// Helper to convert to byte span
template <typename T>
span<const std::byte> as_bytes(span<T> s) {
  return span<const std::byte>(
      reinterpret_cast<const std::byte*>(s.data()),
      s.size() * sizeof(T));
}

}  // namespace pw

#endif  // __cplusplus
