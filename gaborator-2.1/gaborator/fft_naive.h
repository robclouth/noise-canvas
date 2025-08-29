//
// Fast Fourier transform, naive reference implementations
//
// Copyright (C) 1992-2023 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

// Based on the module "fft" used in audsl/test, audsl/mls,
// scope/core, whitesig

#ifndef _GABORATOR_FFT_NAIVE_H
#define _GABORATOR_FFT_NAIVE_H

#include <algorithm>
#include <complex>
#include <iterator>
#include <vector>

namespace gaborator {

// The template argument I is the iterator type used for accessing the
// input and output data.  Typically this is "std::complex<float> *" or
// "std::complex<double> *", but other types such as stride iterators
// can also be used.

template <class I>
struct fft {
    typedef typename std::iterator_traits<I>::value_type C; // complex
    typedef typename C::value_type T; // float/double
    typedef typename std::vector<C> twiddle_vector;

    fft(unsigned int n): n_(n), wtab(n / 2) { init_wtab(); }
    ~fft() { }

    unsigned int size() { return n_; }

    // Transform the contents of the array "a", leaving results in
    // bit-reversed order.
    void
    br_transform(I a) {
        unsigned int i, j, m, n;
        typename twiddle_vector::iterator wp; // twiddle factor pointer
        I p, q;

        // n is the number of points in each subtransform (butterfly group)
        // m is the number of subtransforms (butterfly groups), = n_ / n
        // i is the index of the first point in the current butterfly group
        // j is the number of the butterfly within the group

        for (n = 2, m = n_ / 2; n <= n_; n *= 2 , m /= 2) // each stage
            for (i = 0; i < n_; i += n)  // each butterfly group
                for (j = 0, wp = wtab.begin(), p = a + i, q = a + i + n / 2;
                     j < n / 2;
                     j++, wp += m, p++, q++)    // each butterfly
                {
                    C temp((*q) * (*wp));
                    *q = *p - temp;
                    *p += temp;
                }
    }

    void
    bit_reverse(I a) {
        unsigned int i, j;
        for (i = 0, j = 0; i < n_; i++, j = bitrev_inc(j)) {
            if (i < j)
                std::swap(*(a + i), *(a + j));
        }
    }

    void
    reverse(I a) {
        for (unsigned int i = 1; i < n_ / 2; i++)
            std::swap(*(a + i), *(a + n_ - i));
    }

    void
    transform(const I in, I out) {
        std::copy(in, in + n_, out);
        bit_reverse(out);
        br_transform(out);
    }

    void
    itransform(const I in, I out) {
        std::copy(in, in + n_, out);
        reverse(out);
        bit_reverse(out);
        br_transform(out);
    }

private:
    // Initialize twiddle factor array
    void init_wtab() {
        size_t wt_size = wtab.size();
        for (size_t i = 0; i < wt_size; ++i) {
            double arg = (-2.0 * M_PI / n_) * i;
            wtab[i] = C(cos(arg), sin(arg));
        }
    }

    unsigned int
    bitrev_inc(unsigned int i) {
        unsigned int carry = n_;
        do {
            carry >>= 1;
            unsigned int new_i = i ^ carry;
            carry &= i;
            i = new_i;
        } while(carry);
        return i;
    }

    // Size of the transform
    unsigned int n_;

    // Twiddle factor array (size n / 2)
    twiddle_vector wtab;
};

// Real FFT

template <class CI>
struct rfft {
    typedef typename std::iterator_traits<CI>::value_type C; // complex
    typedef typename C::value_type T; // float/double
    typedef T *RI; // Real iterator
    typedef const T *CONST_RI;

    rfft(unsigned int n): n2(n), cf(n >> 1) {
        twiddle = new C[n];
        for (size_t i = 0; i < n; i++) {
            double a = -2 * M_PI * (double) i / (double) n;
            twiddle[i] = -C((T) 0, (T) 1) * C(cos(a), sin(a));
        }
    }
    ~rfft() {
        delete [] twiddle;
    }

    void
    transform(CONST_RI in, CI out) {
        size_t n = cf.size();
        if (n2 == 1) {
            out[0] = C(in[0], 0);
            return;
        }
        C *a = new C[n];
        for (size_t i = 0; i < n; i++)
            a[i] = C(in[2 * i], in[2 * i + 1]);
        C *b = new C[n];
        cf.transform(a, b);
#if GABORATOR_REAL_FFT_NEGATIVE_FQS
        size_t end = n * 2;
#else
        size_t end = n + 1;
#endif
        for (size_t i = 0; i < end; i++) {
            C t0 = b[i & (n - 1)];
            C t1 = conj(b[-i & (n - 1)]);
            C t2 = t0 + t1;
            C t3 = t0 - t1;
            out[i] = (t2 + t3 * twiddle[i]) * (T) 0.5;
        }
        delete [] b;
        delete [] a;
    }

    void
    itransform(CI in, RI out) {
        if (n2 == 1) {
            out[0] = in[0].real();
            return;
        }
        size_t n = cf.size();
        C *a = new C[n];
        for (size_t i = 0; i < n; i++) {
            // From 0 to n - 1, never n
            C t0 = in[i];
            // From n to 1, never 0
            C t1 = std::conj(in[n - i]);
            C t2 = t0 + t1;
            C t3 = t0 - t1;
            // No scaling by 0.5 here because we only accumulate the
            // positive frequencies.
            a[i] = (t2 + (t3 * conj(twiddle[i])));
        }
        C *b = new C[n];
        cf.itransform(a, b);
        for (size_t i = 0; i < n; i++) {
            out[2 * i] = b[i].real();
            out[2 * i + 1] = b[i].imag();
        }
        delete [] b;
        delete [] a;
    }

    unsigned int n2;
    fft<CI> cf;
    C *twiddle;
};

} // Namespace

#endif
