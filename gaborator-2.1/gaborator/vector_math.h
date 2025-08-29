//
// Vector math operations
//
// Copyright (C) 2016-2021 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_VECTOR_MATH_H
#define _GABORATOR_VECTOR_MATH_H

#include <assert.h>

#if GABORATOR_USE_SSE3_INTRINSICS
#include <pmmintrin.h>
#endif

#include <complex>

// Use __restrict__ where supported
#if defined(__GNUC__) || defined(__clang__)
#define GABORATOR_RESTRICT __restrict__
#else
#define GABORATOR_RESTRICT
#endif

namespace gaborator {

// The _naive versions are used when SSE is not available, and as
// references when testing the SSE versions

// Naive or not, this is faster than the macOS std::complex
// multiplication operator, which checks for infinities even with
// -ffast-math.

template <class T>
std::complex<T> complex_mul_naive(std::complex<T> a,
                                  std::complex<T> b)
{
    return std::complex<T>(a.real() * b.real() - a.imag() * b.imag(),
                           a.real() * b.imag() + a.imag() * b.real());
}

#if GABORATOR_USE_SSE3_INTRINSICS
// Note: this is sometimes slower than the naive code.
static inline
std::complex<double> complex_mul(std::complex<double> a_,
                                 std::complex<double> b_)
{
    __v2df a = _mm_setr_pd(a_.real(), a_.imag());
    __v2df b = _mm_setr_pd(b_.real(), b_.imag());
    __v2df as = (__v2df) _mm_shuffle_pd(a, a, 0x1);
    __v2df t0 = _mm_mul_pd(a, _mm_shuffle_pd(b, b, 0x0));
    __v2df t1 = _mm_mul_pd(as, _mm_shuffle_pd(b, b, 0x3));
    __v2df c = __builtin_ia32_addsubpd(t0, t1); // SSE3
    return std::complex<double>(c[0], c[1]);
}
#else
static inline
std::complex<double> complex_mul(std::complex<double> a_,
                                 std::complex<double> b_)
{
    return complex_mul_naive(a_, b_);
}
#endif

static inline
std::complex<float> complex_mul(std::complex<float> a_,
                                std::complex<float> b_)
{
    return complex_mul_naive(a_, b_);
}

template <class T, class U, class V>
static inline void
elementwise_product_naive(T *GABORATOR_RESTRICT r,
                          U *GABORATOR_RESTRICT a,
                          V *GABORATOR_RESTRICT b,
                          size_t n)
{
    for (size_t i = 0; i < n; i++)
        r[i] = complex_mul(a[i], b[i]);
}

template <class T, class U, class V, class S>
static inline void
elementwise_product_times_scalar_naive(T *GABORATOR_RESTRICT r,
                                       U *GABORATOR_RESTRICT a,
                                       V *GABORATOR_RESTRICT b,
                                       S s,
                                       size_t n)
{
    for (size_t i = 0; i < n; i++)
        r[i] = a[i] * b[i] * s;
}

// I is the input complex data type, O is the output data type
template <class I, class O>
static inline void
complex_magnitude_naive(I *GABORATOR_RESTRICT inv,
                        O *GABORATOR_RESTRICT outv,
                        size_t n)
{
    for (size_t i = 0; i < n; i++)
        outv[i] = std::sqrt(inv[i].real() * inv[i].real() +
                            inv[i].imag() * inv[i].imag());
}

#if GABORATOR_USE_SSE3_INTRINSICS

#include <pmmintrin.h>

// Perform two complex float multiplies in parallel

static inline
__v4sf complex_mul_vec2(__v4sf aa, __v4sf bb) {
    __v4sf aas =_mm_shuffle_ps(aa, aa, 0xb1);
    __v4sf t0 = _mm_mul_ps(aa, _mm_moveldup_ps(bb));
    __v4sf t1 = _mm_mul_ps(aas, _mm_movehdup_ps(bb));
    return __builtin_ia32_addsubps(t0, t1); // SSE3
}

// Calculate the elementwise product of a complex float vector
// and another complex float vector.

static inline void
elementwise_product(std::complex<float> *cv,
                    const std::complex<float> *av,
                    const std::complex<float> *bv,
                    size_t n)
{
    assert((n & 1) == 0);
    n >>= 1;
    __v4sf *c = (__v4sf *) cv;
    const __v4sf *a = (const __v4sf *) av;
    const __v4sf *b = (const __v4sf *) bv;
    while (n--) {
        __v4sf aa = *a++;
        __v4sf bb = *b++;
         *c++ = complex_mul_vec2(aa, bb);
    }
}

// Calculate the elementwise product of a complex float vector
// and real float vector.
//
// The input "a" may be unaligned; the output "c" must be aligned.

static inline void
elementwise_product(std::complex<float> *cv,
                    const std::complex<float> *av,
                    const float *bv,
                    size_t n)
{
    assert((n & 3) == 0);
    n >>= 2;
    __v4sf *c = (__v4sf *) cv;
    const __v4sf *a = (const __v4sf *) av;
    const __v4sf *b = (const __v4sf *) bv;
    while (n--) {
        __v4sf a0 = (__v4sf) _mm_loadu_si128((const __m128i *) a++);
        __v4sf a1 = (__v4sf) _mm_loadu_si128((const __m128i *) a++);
        __v4sf bb = *b++;
         *c++ = _mm_mul_ps(a0, _mm_unpacklo_ps(bb, bb));
         *c++ = _mm_mul_ps(a1, _mm_unpackhi_ps(bb, bb));
    }
}

static inline void
elementwise_product_times_scalar(std::complex<float> *cv,
                                 const std::complex<float> *av,
                                 const std::complex<float> *bv,
                                 std::complex<float> d,
                                 size_t n)
{
    assert((n & 1) == 0);
    n >>= 1;
    const __v4sf *a = (const __v4sf *) av;
    const __v4sf *b = (const __v4sf *) bv;
    const __v4sf dd = (__v4sf) { d.real(), d.imag(), d.real(), d.imag() };
    __v4sf *c = (__v4sf *) cv;
    while (n--) {
        __v4sf aa = *a++;
        __v4sf bb = *b++;
         *c++ = complex_mul_vec2(complex_mul_vec2(aa, bb), dd);
    }
}

// XXX arguments reversed wrt others

static inline void
complex_magnitude(std::complex<float> *inv,
                  float *outv,
                  size_t n)
{
    // Processes four complex values (32 bytes) at a time ,
    // outputting four scalar magnitudes (16 bytes) at a time.
    while ((((uintptr_t) inv) & 0x1F) && n) {
        std::complex<float> v = *inv++;
        *outv++ = std::sqrt(v.real() * v.real() + v.imag() * v.imag());
        n--;
    }
    const __v4sf *in = (const __v4sf *) inv;
    __v4sf *out = (__v4sf *) outv;
    while (n >= 4) {
        __v4sf aa = *in++; // c0re c0im c1re c1im
        __v4sf aa2 = _mm_mul_ps(aa, aa); // c0re^2 c0im^2 c1re^2 c1im^2
        __v4sf bb = *in++; // c2re c2im c3re c3im
        __v4sf bb2 = _mm_mul_ps(bb, bb); // etc
        // Gather the real parts: x0 x2 y0 y2
        // 10 00 10 00 = 0x88
        __v4sf re2 =_mm_shuffle_ps(aa2, bb2, 0x88);
        __v4sf im2 =_mm_shuffle_ps(aa2, bb2, 0xdd);
        __v4sf mag2 = _mm_add_ps(re2, im2);
        __v4sf mag = __builtin_ia32_sqrtps(mag2);
        // Unaligned store
        _mm_storeu_si128((__m128i *)out, (__m128i)mag);
        out++;
        n -= 4;
    }
    inv = (std::complex<float> *) in;
    outv = (float *)out;
    while (n) {
        std::complex<float> v = *inv++;
        *outv++ = std::sqrt(v.real() * v.real() + v.imag() * v.imag());
        n--;
    }
}

// Double-precision version is unoptimized

static inline void
elementwise_product(std::complex<double> *c,
                    const std::complex<double> *a,
                    const std::complex<double> *b,
                    size_t n)
{
    elementwise_product_naive(c, a, b, n);
}

static inline void
elementwise_product(std::complex<double> *c,
                    const std::complex<double> *a,
                    const double *b,
                    size_t n)
{
    elementwise_product_naive(c, a, b, n);
}

template <class T, class U, class V, class S>
static inline void
elementwise_product_times_scalar(T *r,
                                 U *a,
                                 V *b,
                                 S s,
                                 size_t n)
{
    elementwise_product_times_scalar_naive(r, a, b, s, n);
}

template <class O>
static inline void
complex_magnitude(std::complex<double> *inv,
                  O *outv,
                  size_t n)
{
    complex_magnitude_naive(inv, outv, n);
}

#else // ! GABORATOR_USE_SSE3_INTRINSICS

// Forward to the naive implementations.  These are inline functions
// rather than #defines to avoid namespace pollution.

template <class T, class U, class V>
static inline void
elementwise_product(T *r,
                    U *a,
                    V *b,
                    size_t n)
{
    elementwise_product_naive(r, a, b, n);
}

template <class T, class U, class V, class S>
static inline void
elementwise_product_times_scalar(T *r,
                                 U *a,
                                 V *b,
                                 S s,
                                 size_t n)
{
    elementwise_product_times_scalar_naive(r, a, b, s, n);
}

template <class I, class O>
static inline void
complex_magnitude(I *inv,
                  O *outv,
                  size_t n)
{
    complex_magnitude_naive(inv, outv, n);
}

#endif // ! USE_SSE3_INTINSICS

} // namespace

#undef GABORATOR_RESTRICT

#endif
