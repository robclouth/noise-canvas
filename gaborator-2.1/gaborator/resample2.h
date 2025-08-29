//
// Fast resampling by powers of two
//
// Copyright (C) 2016-2021, 2024 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

// Uses a two-lobe Lanczos kernel.  Good enough for image data, not
// intended for audio.

#ifndef _GABORATOR_RESAMPLE2_H
#define _GABORATOR_RESAMPLE2_H

#include <assert.h>
#include <inttypes.h>
#include <math.h>
#include <algorithm> // std::copy

#include "gaborator/affine_transform.h"
#include "gaborator/pod_vector.h"

namespace gaborator {

//
// There are two ways to look at this.
//
// In one point of view, there is only one coordinate space, and
// coordinates are floating-point numbers.  The various sub- and
// supersampled views differ in step sizes and the number of
// fractional coordinate bits, but any given coordinates refer to the
// same point in the image at any scale.  Steps are powers of two,
// with integer exponents that may be negative.  A step size > 1
// implies downsampling (antialias lowpass filtering and subsampling),
// and a step size < 1 implies upsampling (aka interpolation).
//
// The coordinates are always integer multiples of the step size.
//
// e.g.,
//   x0 = 33.5, xstep = 0.5
//   x0 = 12, xstep = 4
//
// In the other point of view, we introduce an integer exponent e and
// substitute x0 = i0 * 2^e and xstep = 2^e.  Now instead of floating
// point coordinates, we use integer "indices".  The above example
// now looks like his:
//
//   i0 = 67, e = -1
//   i0 = 3, e = 2
//
// This latter point of view is how the code actually works.
//

// A power-of-two transform, as in y = 2^e x + origin

struct p2_transform {
    p2_transform(int e_, int64_t origin_): e(e_), origin(origin_) { }
    // Convert an affine transform into a p2_transform.
    // The affine transform must be representable as a
    // p2_transform, meaning xf.a must be a power of two,
    // and the origin must be an integer.
    p2_transform(affine_transform xf) {
        int exp;
        double m = frexp(xf.a, &exp);
        assert(m == 0.5);
        e = exp - 1;
        origin = xf.b;
        assert(origin == xf.b); // No fraction
    }
    int e;
    int64_t origin;
};

// Scale a transform by a power of two, around the origin
// of the destination space

static inline affine_transform
zoom_p2_dst(affine_transform xf, int e) {
    return affine_transform(ldexp(xf.a, e), xf.b);
}

// Scale a transform by a power of two, around the origin
// of the source space

static inline affine_transform
zoom_p2_src(affine_transform xf, int e) {
    return affine_transform(ldexp(xf.a, e), ldexp(xf.b, e));
}

// Resample data from "source", generating a view between indices
// i0 and i1 of the scale determined by exponent e, and storing
// i1 - i0 samples starting at *out.
//
// The source must implement an operator() taking the arguments
// (int64_t i0, int64_t i1, T *out) and generating data for the base
// resolution (e=0).
//
// S is the type of the data source
// OI is the output iterator type

template <class S, class OI>
OI resample2_p2xf(const S &source, p2_transform xf,
                  int64_t i0, int64_t i1,
                  bool interpolate, OI out)
{
    typedef typename std::iterator_traits<OI>::value_type T;
    assert(i1 >= i0);
    if (xf.e > 0) {
        // Downsample
        // Calculate super-octave coordinates
        // margin is the support of the resampling kernel (on each side,
        // not counting the center sample)
        int margin = interpolate ? 1 : 0;
        // When margin = 1, we use three samples, at 2i-1, 2i, 2i+1
        // and the corresponding half-open inverval is 2i-1...2i+1+1
        int64_t si0 = 2 * i0 - margin;
        int64_t si1 = 2 * i1 + margin + 1;
        // Get super-octave data
        gaborator::pod_vector<T> super_data(si1 - si0);
        T *p = super_data.data();
        p = resample2_p2xf(source, p2_transform(xf.e - 1, xf.origin),
                           si0, si1, interpolate, p);
        assert(p == super_data.data() + si1 - si0);
        for (int64_t i = i0; i < i1; i++) {
            int64_t si = 2 * i - si0;
            T val;
            if (!interpolate) {
                // Point sampling
                val = super_data[si];
            } else {
                // Triangular kernel
                T v1 = super_data[si - 1];
                T v0 = super_data[si];
                v1 += super_data[si + 1];
                val =
                    v0 * (T)0.5 +
                    v1 * (T)0.25;
#if 0 // Lanczos2 is overkill when downsampling.
            } else {
                // Two-lobe Lanczos kernel, needs margin = 2
                // Always aligned
                T v3 = super_data[si - 3];
                // There is no v2
                T v1 = super_data[si - 1];
                T v0 = super_data[si];
                // There is still no v2
                v1 += super_data[si + 1];
                v3 += super_data[si + 3];
                val =
                    v0 * (T)0.49530706 +
                    v1 * (T)0.28388978 +
                    v3 * (T)-0.03154331;
#endif
            }
            *out++ = val;
        }
    } else if (xf.e < 0) {
        // Upsample
        if (! interpolate) {
            // Return nearest neighbor.  If the pixel lies
            // exactly at the midpoint between the neighbors,
            // return their average.
            int sh = -xf.e;
            int64_t si0 = i0 >> sh;
            int64_t si1 = ((i1 - 1) >> sh) + 1 + 1;
            gaborator::pod_vector<T> source_data(si1 - si0);
            source(xf.origin + si0, xf.origin + si1, source_data.data());
            for (int64_t i = i0; i < i1; i++) {
                int64_t si = (i >> sh) - si0;
                T val;
                int rem = i & ((1 << sh) - 1);
                int half = (1 << sh) >> 1;
                if (rem < half) {
                    val = source_data[si];
                } else if (rem == half) {
                    val = (source_data[si] + source_data[si + 1]) * (T)0.5;
                } else { // rem > half
                    val = source_data[si + 1];
                }
                *out++ = val;
            }
        } else {
            // Interpolate
            // Calculate sub-octave coordinates
            int margin = 2;
            int64_t si0 = (i0 >> 1) - margin;
            int64_t si1 = ((i1 - 1) >> 1) + margin + 1;
            // Get sub-octave data
            gaborator::pod_vector<T> sub_data(si1 - si0);
            T *p = sub_data.data();
            p = resample2_p2xf(source, p2_transform(xf.e + 1, xf.origin),
                               si0, si1, interpolate, p);
            assert(p == sub_data.data() + si1 - si0);
            for (int64_t i = i0; i < i1; i++) {
                int64_t si = (i >> 1) - si0;
                T val;
                if (i & 1) {
                    T v1 = sub_data[si - 1];
                    T v0 = sub_data[si];
                    v0 += sub_data[si + 1];
                    v1 += sub_data[si + 2];
                    val =
                        v0 * (T)0.5625 +
                        v1 * (T)-0.0625;
                } else {
                    val = sub_data[si];
                }
                *out++ = val;
            }
        }
    } else {
        // e == 0
        out = source(xf.origin + i0, xf.origin + i1, out);
    }
    return out;
}

// As above, but taking an affine_transform.

template <class S, class OI>
OI resample2(const S &source, affine_transform axf,
             int64_t i0, int64_t i1,
             bool interpolate, OI out)
{
    p2_transform xf(axf);
    typedef typename std::iterator_traits<OI>::value_type T;
    gaborator::pod_vector<T> data(i1 - i0);
    T *p = data.data();
    p = resample2_p2xf(source, xf, i0, i1, interpolate, p);
    return std::copy(data.data(), data.data() + (i1 - i0), out);
}

// Calculate the range of source indices that will be accessed
// by a call to resample2(source, i0, i1, e) and return it
// through si0_ret and si1_ret.

// XXX this should take an "interpolate" argument so we don't
// return an unnecessarily large support when interpolation is off

static inline void
resample2_support(affine_transform axf, int64_t i0, int64_t i1,
                  int64_t &si0_ret, int64_t &si1_ret)
{
    p2_transform xf(axf);
    int margin = 2;
    if (xf.e > 0) {
        // Note code duplication wrt resample2_p2xf().
        // Also note tail recursion.
        int64_t si0 = i0 * 2 - margin + 1;
        int64_t si1 = i1 * 2 + margin;
        resample2_support(zoom_p2_dst(axf, -1),
                          si0, si1, si0_ret, si1_ret);
    } else if (xf.e < 0) {
        int64_t si0 = (i0 >> 1) - margin;
        int64_t si1 = ((i1 - 1) >> 1) + margin + 1;
        resample2_support(zoom_p2_dst(axf, +1),
                          si0, si1, si0_ret, si1_ret);
    } else {
        si0_ret = xf.origin + i0;
        si1_ret = xf.origin + i1;
    }
}

// Inverse of the above, more or less: calculate the range of
// destination indices that depend on a given range of source indices.

static inline void
resample2_inv_support(affine_transform axf, int64_t si0, int64_t si1,
                      int64_t &i0_ret, int64_t &i1_ret)
{
    p2_transform xf(axf);
    // Conservative
    int margin = 2;
    if (xf.e > 0) {
        int64_t di0, di1;
        resample2_inv_support(zoom_p2_dst(axf, -1),
                              si0, si1, di0, di1);
        i0_ret = di0 >> 1;
        i1_ret = (di1 >> 1) + 1;
    } else if (xf.e < 0) {
        int64_t di0, di1;
        resample2_inv_support(zoom_p2_dst(axf, +1),
                              si0, si1, di0, di1);
        i0_ret = di0 * 2 - margin + 1;
        i1_ret = di1 * 2 + margin;
    } else {
        i0_ret = si0 - xf.origin;
        i1_ret = si1 - xf.origin;
    }
}

// Class wrappers for compatibility with other resamplers.

// Lanczos2 power-of-two resampler

struct lanczos2_pow2_resampler {
    lanczos2_pow2_resampler(affine_transform xf_): xf(xf_) { }
    template <class S, class OI>
    OI operator()(const S &source, int64_t i0, int64_t i1, OI out) const {
        return resample2(source, xf, i0, i1, true, out);
    }
    void support(int64_t i0, int64_t i1, int64_t &si0_ret, int64_t &si1_ret) const {
        return resample2_support(xf, i0, i1, si0_ret, si1_ret);
    }
    void inv_support(int64_t si0, int64_t si1, int64_t &i0_ret, int64_t &i1_ret) {
        return resample2_inv_support(xf, si0, si1, i0_ret, i1_ret);
    }
    affine_transform xf;
};

// Nearest-neighbor power-of-two resampler
// XXX simplify

struct nn_pow2_resampler {
    nn_pow2_resampler(affine_transform xf_): xf(xf_){ }
    template <class S, class OI>
    OI operator()(const S &source, int64_t i0, int64_t i1, OI out) const {
        return resample2(source, xf, i0, i1, false, out);
    }
    void support(int64_t i0, int64_t i1, int64_t &si0_ret, int64_t &si1_ret) const {
        return resample2_support(xf, i0, i1, si0_ret, si1_ret);
    }
    void inv_support(int64_t si0, int64_t si1, int64_t &i0_ret, int64_t &i1_ret) {
        return resample2_inv_support(xf, si0, si1, i0_ret, i1_ret);
    }
    affine_transform xf;
};

} // namespace

#endif
