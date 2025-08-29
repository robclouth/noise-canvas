//
// The Gaussian and related functions
//
// Copyright (C) 2015-2024 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_GAUSSIAN_H
#define _GABORATOR_GAUSSIAN_H

#include <assert.h>
#include <math.h>

namespace gaborator {

// Approximate erfc_inv(), the inverse complementary error function.
// The return value is accurate to within 10^-6.

static inline double erfc_inv(double y) {
    if (y > 1)
        return -erfc_inv(2 - y);
    assert(y >= 0 && y <= 1);
    // Make an initial guess and refine it using the secant method.
    double guess = sqrt(-log(y)) - 0.25;
    double x0 = guess - 0.02;
    double x1 = guess + 0.02;
    double x2 = 0;
    // The loop is only a failsafe; in practice, the break will
    // always execute before the loop reaches the maximum count.
    for (int i = 0; i < 10; i++) {
        double d = erfc(x1) - erfc(x0);
        x2 = x1 - (erfc(x1) - y) * (x1 - x0) / d;
        x0 = x1;
        x1 = x2;
        if (fabs(x1 - x0) < 1e-6)
            break;
    }
    return x2;
}

// Gaussian with peak = 1

static inline double norm_gaussian(double sd, double x) {
    return exp(-(x * x) / (2 * sd * sd));
}

// Gaussian with integral = 1

static inline double gaussian(double sd, double x) {
    double a = 1.0 / (sd * sqrt(2.0 * M_PI));
    return a * norm_gaussian(sd, x);
}

// The convolution of a Heaviside step function with a Gaussian of
// standard deviation sd.  Goes smoothly from 0 to 1, with the 0.5
// point at x=0.

static inline
double gaussian_edge(double sd, double x) {
    double erf_arg = x / (sd * M_SQRT2);
    if (erf_arg < -7)
        return 0; // error < 5e-23
    if (erf_arg > 7)
        return 1; // error < 5e-23
    return (erf(erf_arg) + 1) * 0.5;
}

// Translate the time-domain standard deviation of a Gaussian
// (in samples) into the corresponding frequency-domain standard
// deviation (as a fractional frequency), or vice versa.

static inline double sd_t2f(double st_sd) {
    return 1.0 / (2.0 * M_PI * st_sd);
}

static inline double sd_f2t(double ff_sd) {
    return sd_t2f(ff_sd);
}

// Given a Gaussian with standard deviation "sd" and a maximum error
// "max_error", calculate the support needed on each side to keep the
// area below the curve within max_error of the exact value.

static inline
double gaussian_area_support(double sd, double max_error) {
    return sd * M_SQRT2 * erfc_inv(max_error);
}

// Inverse of the above: given a support and maximum error, calculate
// the standard deviation.

static inline
double gaussian_area_support_inv(double support, double max_error) {
    return support / (M_SQRT2 * erfc_inv(max_error));
}

// Given a gaussian with standard deviation "sd" and a maximum error
// "max_error", calculate the support needed on each side for the
// value to fall to a factor of "max_error" of the peak.

static inline
double gaussian_value_support(double sd, double max_error) {
    return sd * M_SQRT2 * sqrt(-log(max_error));
}

// Inverse of the above: given a support and maximum error, calculate
// the standard deviation.

static inline
double gaussian_value_support_inv(double support, double max_error) {
    return support / (M_SQRT2 * sqrt(-log(max_error)));
}

// Choose which criterion to use

#if 1
static inline
double gaussian_support(double support, double max_error) {
    return gaussian_area_support(support, max_error);
}

static inline
double gaussian_support_inv(double support, double max_error) {
    return gaussian_area_support_inv(support, max_error);
}
#else
static inline
double gaussian_support(double support, double max_error) {
    return gaussian_value_support(support, max_error);
}

static inline
double gaussian_support_inv(double support, double max_error) {
    return gaussian_value_support_inv(support, max_error);
}
#endif

} // namespace

#endif
