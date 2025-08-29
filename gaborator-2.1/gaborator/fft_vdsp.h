//
// Fast Fourier transform using the Apple vDSP framework
//
// Copyright (C) 2013-2023 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_FFT_VDSP_H
#define _GABORATOR_FFT_VDSP_H

#include <assert.h>
#include <memory.h>

#include <iterator>

#include <mach/mach.h>
#include <mach/task.h>
#include <mach/task_info.h>
#include <mach/vm_map.h>

#include <Accelerate/Accelerate.h>

namespace gaborator {

template <class I>
struct fft {
};

template <class I>
struct rfft {
};

static inline int log2_int_exact(int n) {
    // n must be a power of two
    assert(n != 0 && ((n & (n >> 1)) == 0));
    int r = 0;
    for (;;) {
        n >>= 1;
        if (n == 0)
            break;
        r++;
    }
    return r;
}

template <>
struct fft<std::complex<float> *> {
    typedef std::complex<float> *I;
    typedef const std::complex<float> *CONST_I;
    typedef typename std::iterator_traits<I>::value_type C; // complex
    typedef typename C::value_type T; // float/double

    fft(unsigned int n_): n(n_), log2n(log2_int_exact(n)) {
        setup = vDSP_create_fftsetup(log2n, kFFTRadix2);
    }
    ~fft() {
        vDSP_destroy_fftsetup(setup);
    }

    unsigned int size() { return n; }

    void
    transform(CONST_I in, I out) {
        DSPSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zop(setup,
                     &si, 2,
                     &so, 2,
                     log2n, kFFTDirection_Forward);
    }

    void
    itransform(CONST_I in, I out) {
        DSPSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zop(setup,
                     &si, 2,
                     &so, 2,
                     log2n, kFFTDirection_Inverse);
    }

private:
    // Size of the transform
    unsigned int n;
    unsigned int log2n;
    FFTSetup setup;
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

    rfft(unsigned int n_): n(n_), log2n(log2_int_exact(n)) {
        setup = vDSP_create_fftsetup(log2n, kFFTRadix2);
    }
    ~rfft() {
        vDSP_destroy_fftsetup(setup);
    }

    unsigned int size() { return n; }

    void
    transform(CONST_RI in, CI out) {
        if (n == 1) {
            out[0] = in[0];
            return;
        }
        DSPSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zrop(setup,
                      &si, 2,
                      &so, 2,
                      log2n, kFFTDirection_Forward);
        // Undo vDSP scaling
        for (unsigned int i = 0; i < (n >> 1); i++)
            out[i] *= (T)0.5;
        C tmp = out[0];
#if GABORATOR_REAL_FFT_NEGATIVE_FQS
        for (unsigned int i = 1; i < (n >> 1); i++)
            out[n - i] = conj(out[i]);
#endif
        out[0] = C(tmp.real(), 0);
        out[n >> 1] = C(tmp.imag(), 0);
    }

    void
    itransform(CONST_CI in, RI out) {
        if (n == 1) {
            out[0] = in[0].real();
            return;
        }
        C tmp = in[0];
        const_cast<CI>(in)[0] = C(tmp.real(), in[n >> 1].real());
        DSPSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zrop(setup,
                      &si, 2,
                      &so, 2,
                      log2n, kFFTDirection_Inverse);
        const_cast<CI>(in)[0] = tmp;
    }

private:
    // Size of the transform
    unsigned int n;
    unsigned int log2n;
    FFTSetup setup;
};

template <>
struct fft<std::complex<double> *> {
    typedef std::complex<double> *I;
    typedef const std::complex<double> *CONST_I;
    typedef typename std::iterator_traits<I>::value_type C; // complex
    typedef typename C::value_type T; // float/double

    fft(unsigned int n_): n(n_), log2n(log2_int_exact(n)) {
        setup = vDSP_create_fftsetupD(log2n, kFFTRadix2);
    }
    ~fft() {
        vDSP_destroy_fftsetupD(setup);
    }

    unsigned int size() { return n; }

    void
    transform(CONST_I in, I out) {
        DSPDoubleSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPDoubleSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zopD(setup,
                      &si, 2,
                      &so, 2,
                      log2n, kFFTDirection_Forward);
    }

    void
    itransform(CONST_I in, I out) {
        DSPDoubleSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPDoubleSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zopD(setup,
                      &si, 2,
                      &so, 2,
                      log2n, kFFTDirection_Inverse);
    }

private:
    // Size of the transform
    unsigned int n;
    unsigned int log2n;
    FFTSetupD setup;
};

// Real FFT

template <>
struct rfft<std::complex<double> *> {
    typedef std::complex<double> *CI; // Complex iterator
    typedef const std::complex<double> *CONST_CI;
    typedef typename std::iterator_traits<CI>::value_type C; // complex
    typedef typename C::value_type T; // float/double
    typedef T *RI; // Real iterator
    typedef const T *CONST_RI;

    rfft(unsigned int n_): n(n_), log2n(log2_int_exact(n)) {
        setup = vDSP_create_fftsetupD(log2n, kFFTRadix2);
    }
    ~rfft() {
        vDSP_destroy_fftsetupD(setup);
    }

    unsigned int size() { return n; }

    void
    transform(CONST_RI in, CI out) {
        if (n == 1) {
            out[0] = in[0];
            return;
        }
        DSPDoubleSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPDoubleSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zropD(setup,
                       &si, 2,
                       &so, 2,
                       log2n, kFFTDirection_Forward);
        // Undo vDSP scaling
        for (unsigned int i = 0; i < (n >> 1); i++)
            out[i] *= (T)0.5;
        C tmp = out[0];
#if GABORATOR_REAL_FFT_NEGATIVE_FQS
        for (unsigned int i = 1; i < (n >> 1); i++)
            out[n - i] = conj(out[i]);
#endif
        out[0] = C(tmp.real(), 0);
        out[n >> 1] = C(tmp.imag(), 0);
    }

    void
    itransform(CONST_CI in, RI out) {
        if (n == 1) {
            out[0] = in[0].real();
            return;
        }
        C tmp = in[0];
        const_cast<CI>(in)[0] = C(tmp.real(), in[n >> 1].real());
        DSPDoubleSplitComplex si;
        si.realp = (T *) in;
        si.imagp = (T *) in + 1;
        DSPDoubleSplitComplex so;
        so.realp = (T *) out;
        so.imagp = (T *) out + 1;
        vDSP_fft_zropD(setup,
                       &si, 2,
                       &so, 2,
                       log2n, kFFTDirection_Inverse);
        const_cast<CI>(in)[0] = tmp;
    }

private:
    // Size of the transform
    unsigned int n;
    unsigned int log2n;
    FFTSetupD setup;
};

} // Namespace

#endif
