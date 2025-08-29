//
// Fast Fourier transform using PFFFT
//
// Copyright (C) 2017-2023 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_FFT_PFFFT_H
#define _GABORATOR_FFT_PFFFT_H

#include <assert.h>
#include <complex>

#include <iterator>
#include <vector>


#include "pffft.h"

// XXX disable in production
#ifdef __x86_64__
#define GABORATOR_PFFFT_CHECK_ALIGN(p) assert((((uint64_t)(p)) & 0xF) == 0)
#else
#define GABORATOR_PFFFT_CHECK_ALIGN(p) do {} while (0)
#endif

// The largest buffer we will allocate on the stack, in bytes.
// Of the supported platforms, the most limited one is
// OpenBSD, where thread stacks are only 512 kB by default.

#define GABORATOR_MAX_STACK_BUFFER (256 * 1024)

namespace gaborator {

template <class I>
struct fft {
};

template <class I>
struct rfft {
};

// Conditional buffer: if "size" (in bytes) is larger than
// GABORATOR_MAX_STACK_BUFFER, the member p points to a
// buffer of size "size" on the heap, otherwise it is null,
// meaning the caller should use a stack-allocated buffer.

struct cond_buffer {
    cond_buffer(size_t size) {
        if (size > GABORATOR_MAX_STACK_BUFFER) {
            // Allocate raw uninitialized memory
            p = ::operator new(size);
        } else {
            // Tell caller to allocate on stack
            p = 0;
        }
    }
    ~cond_buffer() {
        if (p) {
            // Free as raw uninitialized memory
            ::operator delete(p);
        }
    }
    cond_buffer(const cond_buffer &) = delete;
    cond_buffer &operator=(const gaborator::cond_buffer&) = delete;
    void *p;
};

template <>
struct fft<std::complex<float> *> {
    typedef std::complex<float> *I;
    typedef const std::complex<float> *CONST_I;
    typedef std::iterator_traits<I>::value_type C; // complex
    typedef C::value_type T; // float/double

    fft(unsigned int n_): n(n_) {
        setup = pffft_new_setup(n, PFFFT_COMPLEX);
        assert(setup);
    }
    ~fft() {
        pffft_destroy_setup(setup);
    }
    fft(const fft &) = delete;
    fft &operator=(const fft &) = delete;

    unsigned int size() { return n; }

    void
    transform(CONST_I in, I out) {
        GABORATOR_PFFFT_CHECK_ALIGN(in);
        GABORATOR_PFFFT_CHECK_ALIGN(out);
        cond_buffer work(2 * n * sizeof(T));
        pffft_transform_ordered(setup, (const float *)in, (float *)out,
				(float *)work.p, PFFFT_FORWARD);
    }

    void
    itransform(CONST_I in, I out) {
        GABORATOR_PFFFT_CHECK_ALIGN(in);
        GABORATOR_PFFFT_CHECK_ALIGN(out);
        cond_buffer work(2 * n * sizeof(T));
        pffft_transform_ordered(setup, (const float *)in, (float *)out,
				(float *)work.p, PFFFT_BACKWARD);
    }

private:
    // Size of the transform
    unsigned int n;
    PFFFT_Setup *setup;
};

// Use fftpack for double precision

#define FFTPACK_DOUBLE_PRECISION 1
#include "fftpack.h"
#undef FFTPACK_DOUBLE_PRECISION

template <>
struct fft<std::complex<double> *> {
    typedef std::complex<double> *I;
    typedef const std::complex<double> *CONST_I;
    typedef std::iterator_traits<I>::value_type C; // complex
    typedef C::value_type T; // float/double

    fft(unsigned int n_): n(n_), wsave(4 * n_ + 15) {
        // cffti doesn't like n == 0
        if (n == 0)
            return;
        cffti(n, wsave.data());
    }
    ~fft() {
    }
    fft(const fft &) = delete;
    fft &operator=(const fft &) = delete;

    unsigned int size() { return n; }

    void
    transform(CONST_I in, I out) {
        std::copy(in, in + n, out);
        cfftf(n, (double *) out, wsave.data());
    }

    void
    itransform(CONST_I in, I out) {
        std::copy(in, in + n, out);
        cfftb(n, (double *) out, wsave.data());
    }

private:
    // Size of the transform
    unsigned int n;
    std::vector<double> wsave;
};

// Real FFT

template <>
struct rfft<std::complex<float> *> {
    typedef std::complex<float> *CI; // Complex iterator
    typedef const std::complex<float> *CONST_CI;
    typedef typename std::iterator_traits<CI>::value_type C; // complex
    typedef typename C::value_type T; // float/double
    typedef T *RI; // Real iterator
    typedef const T *CONST_RI;

    rfft(unsigned int n_): n(n_) {
        setup = pffft_new_setup(n, PFFFT_REAL);
        assert(setup);
    }
    ~rfft() {
        pffft_destroy_setup(setup);
    }
    rfft(const rfft &) = delete;
    rfft &operator=(const rfft &) = delete;

    unsigned int size() { return n; }

    void
    transform(CONST_RI in, CI out) {
        GABORATOR_PFFFT_CHECK_ALIGN(in);
        GABORATOR_PFFFT_CHECK_ALIGN(out);
        cond_buffer work(2 * n * sizeof(T));
        pffft_transform_ordered(setup, in, (float *) out,
				(float *)work.p, PFFFT_FORWARD);
        C tmp = out[0];
#if GABORATOR_REAL_FFT_NEGATIVE_FQS
        for (unsigned int i = 1; i < (n >> 1); i++)
            out[n - i] = conj(out[i]);
#endif
        out[0] = C(tmp.real(), 0);
        out[n >> 1] = C(tmp.imag(), 0);
    }

    // Note: this temporarily modifies in[0], in spite of the const
    void
    itransform(CONST_CI in, RI out) {
        GABORATOR_PFFFT_CHECK_ALIGN(in);
        GABORATOR_PFFFT_CHECK_ALIGN(out);
        cond_buffer work(2 * n * sizeof(T));
        C tmp = in[0];
        const_cast<CI>(in)[0] = C(tmp.real(), in[n >> 1].real());
        pffft_transform_ordered(setup, (const float *) in, out,
				(float *)work.p, PFFFT_BACKWARD);
        const_cast<CI>(in)[0] = tmp;
    }

private:
    // Size of the transform
    unsigned int n;
    PFFFT_Setup *setup;
};

// Again use fftpack for double precision

template <>
struct rfft<std::complex<double> *> {
    typedef std::complex<double> *CI;
    typedef const std::complex<double> *CONST_CI;
    typedef std::iterator_traits<CI>::value_type C; // complex
    typedef C::value_type T; // float/double
    typedef T *RI; // Real iterator
    typedef const T *CONST_RI;

    rfft(unsigned int n_): n(n_), wsave(2 * n_ + 15) {
        rffti(n, wsave.data());
#if GABORATOR_REAL_FFT_NEGATIVE_FQS
        abort(); // Not supported for now
#endif
    }
    ~rfft() {
    }
    rfft(const rfft &) = delete;
    rfft &operator=(const rfft &) = delete;

    unsigned int size() { return n; }

    void
    transform(CONST_RI in, CI out) {
        if (n <= 1) {
            if (n == 0)
                return;
            *out = *in;
            return;
        }
        double *dp = (double *) out;
        std::copy(in, in + n, dp + 1);
        rfftf(n, (double *) out + 1, wsave.data());
        dp[0] = dp[1]; // Move DC real part
        dp[1] = 0.0; // Clear DC imag part
        dp[n + 1] = 0.0; // Clear Nyquist imag part
    }

    void
    itransform(CONST_CI in, RI out) {
        if (n <= 1) {
            if (n == 0)
                return;
            *out = (*in).real();
            return;
        }
        double *dp = (double *) (const double *) in;
        dp[1] = dp[0]; // Move DC real part
        rfftb(n, dp + 1, wsave.data());
        std::copy(dp + 1, dp + 1 + n, out);
    }
    // Size of the transform
    unsigned int n;
    std::vector<double> wsave;
};

#undef GABORATOR_PFFFT_CHECK_ALIGN

} // namespace

#endif
