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

// Minimal stub for pw_containers/to_array.h
// This provides the to_array utility used by pw_tokenizer's C++ implementation.

#pragma once

#include <array>
#include <cstddef>
#include <type_traits>
#include <utility>

namespace pw {
namespace containers {

namespace internal {

template <typename T, std::size_t N, std::size_t... I>
constexpr std::array<std::remove_cv_t<T>, N> to_array_impl(
    T (&a)[N], std::index_sequence<I...>) {
  return {{a[I]...}};
}

template <typename T, std::size_t N, std::size_t... I>
constexpr std::array<std::remove_cv_t<T>, N> to_array_impl(
    T (&&a)[N], std::index_sequence<I...>) {
  return {{std::move(a[I])...}};
}

}  // namespace internal

// Converts a C-style array to std::array.
template <typename T, std::size_t N>
constexpr std::array<std::remove_cv_t<T>, N> to_array(T (&a)[N]) {
  return internal::to_array_impl(a, std::make_index_sequence<N>{});
}

template <typename T, std::size_t N>
constexpr std::array<std::remove_cv_t<T>, N> to_array(T (&&a)[N]) {
  return internal::to_array_impl(std::move(a), std::make_index_sequence<N>{});
}

}  // namespace containers
}  // namespace pw
