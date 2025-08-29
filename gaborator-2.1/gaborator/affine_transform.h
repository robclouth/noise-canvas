//
// A class for affine transforms (ax + b) of scalar values
//
// Copyright (C) 2020-2021 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_AFFINE_TRANSFORM_H
#define _GABORATOR_AFFINE_TRANSFORM_H

namespace gaborator {

struct affine_transform {
    affine_transform(): a(0), b(0) { }
    affine_transform(double a_, double b_): a(a_), b(b_) { }
    affine_transform(const affine_transform &rhs): a(rhs.a), b(rhs.b) { }
    double operator()(double x) const { return a * x + b; }
    affine_transform inverse() const {
        return affine_transform(1.0 / a, -b / a);
    }
    static affine_transform identity() { return affine_transform(1, 0); }
    double a, b;
};

// Composition: (a * b)(x) = a(b(x))

static inline affine_transform
operator *(const affine_transform &a, const affine_transform &b) {
    return affine_transform(a.a * b.a, a.a * b.b + a.b);
}

// Equality

static inline bool
operator ==(const affine_transform &a, const affine_transform &b) {
    return a.a == b.a && a.b == b.b;
}

} // namespace

#endif
