//
// A vector class without default-initialization, for "plain old data"
//
// Copyright (C) 2016-2023 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_POD_VECTOR_H
#define _GABORATOR_POD_VECTOR_H

#include <stdlib.h> // size_t

#include <algorithm> // std::swap

namespace gaborator {

// A vector for storing Plain Old Data.  This is similar to a
// std::vector, except that it does not zero-initialize elements,
// and that it guarantees that data() returns a non-NULL pointer
// even when the vector contains zero elements.

template <class T>
struct pod_vector {
    typedef T value_type;
    typedef T *iterator;
    pod_vector() {
        b = e = 0;
    }
    explicit pod_vector(size_t size_) {
        allocate(size_);
    }
    ~pod_vector() noexcept {
        _free();
    }
    void swap(pod_vector &x) {
        std::swap(b, x.b);
        std::swap(e, x.e);
    }
    iterator begin() const { return b; }
    iterator end() const { return e; }
    T *data() { return b; }
    const T *data() const { return b; }
    T &operator[](size_t i) { return b[i]; }
    const T &operator[](size_t i) const { return b[i]; }
    size_t size() const { return e - b; }
    void resize(size_t new_size) {
        if (new_size == size())
            return;
        T *n = static_cast<T *>(::operator new(new_size * sizeof(T)));
        size_t ncopy = std::min(size(), new_size);
        std::copy(b, b + ncopy, n);
        _free();
        b = n;
        e = n + new_size;
    }
    pod_vector(const pod_vector &a) {
        allocate(a.size());
        std::copy(a.b, a.e, b);
        //if (size()) fprintf(stderr, "pod_vector cc %d\n", (int)size());
    }
    void clear() {
        _free();
        b = e = 0;
    }
    pod_vector(pod_vector&& x) noexcept:
        b(x.b), e(x.e)
    {
        x.b = x.e = 0;
        //if (size()) fprintf(stderr, "pod_vector mv %d\n", (int)size());
    }
    pod_vector &operator=(const pod_vector &a) {
        if (&a == this)
            return *this;
        _free();
        b = static_cast<T *>(::operator new(a.size() * sizeof(T)));
        e = b + a.size();
        std::copy(a.b, a.e, b);
        //if (size()) fprintf(stderr, "pod_vector =  %d\n", (int)size());
        return *this;
    }
    pod_vector &operator=(pod_vector &&x) noexcept {
        if (&x == this)
            return *this;
        _free();
        b = x.b;
        e = x.e;
        x.b = x.e = 0;
        return *this;
    }
private:
    void allocate(size_t n) {
        // Allocate raw uninitialized memory
        b = static_cast<T *>(::operator new(n * sizeof(T)));
        e = b + n;
    }
    void _free() {
        // Free as raw uninitialized memory
        ::operator delete(b);
    }
private:
    T *b;
    T *e;
};

} // namespace

#endif
